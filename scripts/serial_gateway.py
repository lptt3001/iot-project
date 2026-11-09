"""Read ESP32 serial logs and relay actual samples through the existing MQTT TLS path."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
import logging
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import uuid

import httpx
import serial

from common import ROOT, client, validate_message
from serial_camera import CameraBridge

log = logging.getLogger('serial-gateway')
SAMPLE = re.compile(
    r'T=(?P<t>[^ ]+)\s*C\s*\|\s*RH=(?P<h>[^ ]+)\s*%\s*\|\s*'
    r'light=(?P<light>[01])\s*\|\s*rain=(?P<rain>[01])\s*\|\s*soil=(?P<soil>\d+)'
)


def parse_sample(line):
    """Ignore log chatter; never convert an invalid sensor reading into zero."""
    match = SAMPLE.search(line)
    if not match:
        return None
    measurements = dict(soil_raw=int(match['soil']), light_do=int(match['light']), rain_do=int(match['rain']))
    if not 0 <= measurements['soil_raw'] <= 4095:
        return None
    for key, raw, low, high in (
        ('temperature_c', match['t'], -40, 125), ('air_humidity_pct', match['h'], 0, 100)
    ):
        try:
            value = float(raw)
            if math.isfinite(value) and low <= value <= high:
                measurements[key] = value
        except ValueError:
            pass
    return measurements


def reserve_station(device, api_url):
    with httpx.Client(base_url=api_url, headers={'X-Garden-Request':'1'}, timeout=15) as http:
        http.post('/api/session').raise_for_status()
        settings = http.get('/api/dashboard')
        settings.raise_for_status()
        settings = settings.json()['simulation']
        settings['running'] = False
        settings['external_devices'] = sorted(set(settings.get('external_devices', [])) | {device})
        http.put('/api/simulation', json=settings).raise_for_status()
    # Give an already-started simulator iteration time to drain before real samples.
    time.sleep(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', default='COM5')
    parser.add_argument('--baud', type=int, default=115200)
    parser.add_argument('--device', choices=['station-001','station-002'], default='station-001')
    parser.add_argument('--api', default='http://127.0.0.1:8000')
    parser.add_argument('--stop', action='store_true')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
    # Filenames are independent of user-provided path separators.
    label = re.sub(r'[^A-Za-z0-9_-]', '_', args.port)
    runtime = ROOT / '.runtime'
    runtime.mkdir(exist_ok=True)
    pidfile, stopfile = runtime/f'serial-{label}.pid', runtime/f'serial-{label}.stop'
    if args.stop:
        if pidfile.exists():
            stopfile.write_text(pidfile.read_text().strip(), encoding='utf-8')
            print('Stop requested; the station remains in hardware mode.')
        return
    stopfile.unlink(missing_ok=True)
    port = serial.Serial(port=None, baudrate=args.baud, timeout=.3, write_timeout=1)
    port.dtr = False
    port.rts = False
    port.port = args.port
    try:
        port.open()
    except serial.SerialException as exc:
        raise SystemExit(f'Cannot open {args.port}: {exc}. Close Arduino Serial Monitor and retry.')
    mqtt = None
    spool = None
    camera = None
    try:
        reserve_station(args.device, args.api)
        camera=CameraBridge(ROOT,args.api,args.device)
        pidfile.write_text(str(os.getpid()), encoding='utf-8')
        spool = sqlite3.connect(runtime/f'serial-{label}.sqlite3')
        spool.execute('PRAGMA journal_mode=WAL')
        spool.execute('CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, body TEXT NOT NULL, created REAL NOT NULL)')
        mqtt = client(args.device)
        topic = f'iot/v1/farms/farm-demo/devices/{args.device}/telemetry'
        status_topic = f'iot/v1/farms/farm-demo/devices/{args.device}/status'
        mqtt.will_set(status_topic, '{"online":false}', qos=1, retain=True)
        mqtt.reconnect_delay_set(1, 15)
        mqtt.max_queued_messages_set(100)
        mqtt.connect_async('localhost', 8883, keepalive=20)
        mqtt.loop_start()
        log.info('Reading %s at %s baud -> %s; simulation paused.', args.port,args.baud,args.device)
        last_sample = 0
        last_status = 0
        next_open = 0
        buffer = b''
        while True:
            try:
                if stopfile.exists() and stopfile.read_text().strip() == str(os.getpid()):
                    break
            except OSError:
                pass
            if not port.is_open and time.monotonic() >= next_open:
                try:
                    port.open()
                    buffer = b''
                    log.info('Serial reconnected: %s',args.port)
                except serial.SerialException:
                    next_open = time.monotonic()+3
            if port.is_open:
                try:
                    buffer += port.read(max(1,min(port.in_waiting,8192)))
                    if len(buffer)>65536:
                        buffer = buffer[-8192:]
                    while b'\n' in buffer:
                        raw, buffer = buffer.split(b'\n',1)
                        line=raw.decode('utf-8',errors='replace').strip()
                        try:
                            if camera.line(line):
                                continue
                        except (ValueError,httpx.HTTPError) as exc:
                            log.warning('Camera protocol: %s',exc)
                            continue
                        values = parse_sample(line)
                        if values is None:
                            continue
                        # Firmware logs have no measurement timestamp: use host receipt UTC.
                        message = dict(schema_version=1,message_id=str(uuid.uuid4()),device_id=args.device,
                            farm_id='farm-demo',observed_at=datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
                            source='hardware',measurements=values)
                        validate_message(topic,message)
                        with spool:
                            spool.execute('INSERT INTO pending VALUES (?,?,?)',
                                (message['message_id'],json.dumps(message),time.time()))
                        last_sample = time.monotonic()
                        log.info('Actual sample: %s',json.dumps(values))
                except (serial.SerialException,OSError) as exc:
                    log.warning('Serial disconnected: %s',exc)
                    port.close()
                    next_open = time.monotonic()+3
            else:
                time.sleep(.2)
            try:
                camera.tick(port)
            except (serial.SerialException,OSError) as exc:
                log.warning('Camera serial retry: %s',exc)
            if mqtt.is_connected():
                if time.monotonic()-last_status>=5:
                    online = bool(last_sample and time.monotonic()-last_sample<20)
                    mqtt.publish(status_topic,json.dumps({'online':online}),qos=1,retain=True)
                    last_status = time.monotonic()
                row = spool.execute('SELECT id,body FROM pending ORDER BY created LIMIT 1').fetchone()
                if row:
                    try:
                        published = mqtt.publish(topic,row[1],qos=1)
                        published.wait_for_publish(timeout=5)
                        if published.is_published():
                            with spool:
                                spool.execute('DELETE FROM pending WHERE id=?',(row[0],))
                            log.info('MQTT acknowledged sample %s',row[0])
                    except (RuntimeError,ValueError):
                        pass
    except KeyboardInterrupt:
        pass
    finally:
        port.close()
        if camera:
            camera.close()
        if mqtt:
            if mqtt.is_connected():
                try:
                    mqtt.publish(status_topic,'{"online":false}',qos=1,retain=True).wait_for_publish(timeout=3)
                except (RuntimeError,ValueError):
                    pass
            mqtt.disconnect()
            mqtt.loop_stop()
        if spool:
            spool.close()
        if pidfile.exists() and pidfile.read_text().strip()==str(os.getpid()):
            pidfile.unlink(missing_ok=True)
        log.info('Serial gateway stopped; simulation was not resumed.')


if __name__ == '__main__':
    main()
