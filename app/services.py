from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import random
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
from jsonschema import ValidationError

from app import alerts
from app.db import ROOT, FARM, connect, config
from app.imaging import MEDIA, camera_frame, save_capture, synthetic_detect
from scripts.common import passwords, tls_context, payload, validate_message
from PIL import Image

log = logging.getLogger('garden')
MQTT_HOST = os.getenv('MQTT_HOST', 'localhost')
MQTT_PORT = int(os.getenv('MQTT_PORT', '8883'))


def ingest(db, topic, data):
    validate_message(topic, data)
    device = db.execute('SELECT enabled FROM iot.devices WHERE id=%s AND farm_id=%s',
                        (data['device_id'], data['farm_id'])).fetchone()
    if not device or not device['enabled']:
        raise ValueError('Unknown, disabled or mismatched device')
    m = data['measurements']
    inserted = db.execute('''INSERT INTO iot.sensor_readings
        (observed_at,device_id,farm_id,message_id,temperature_c,air_humidity_pct,soil_moisture_pct,battery_v,rssi_dbm,
         soil_raw,light_do,rain_do,source)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (device_id,observed_at,message_id) DO NOTHING''',
        (data['observed_at'], data['device_id'], data['farm_id'], data['message_id'],
         m.get('temperature_c'), m.get('air_humidity_pct'), m.get('soil_moisture_pct'), data.get('battery_v'), data.get('rssi_dbm'),
         m.get('soil_raw'),m.get('light_do'),m.get('rain_do'),data.get('source','mqtt'))).rowcount
    db.execute('UPDATE iot.devices SET last_seen_at=now() WHERE id=%s', (data['device_id'],))
    if inserted:
        alerts.evaluate(db, data['farm_id'], data['device_id'])
    return inserted


class Services:
    def __init__(self):
        self.stop = threading.Event()
        self.subscribed = threading.Event()
        self.threads = []
        self.clients = {}
        self.subscriber = None
        self.last_error = None
        self.received = 0
        self.sim_wake = threading.Event()
        self.spool_path = ROOT / '.runtime/ingest.sqlite3'

    @contextmanager
    def spool(self):
        connection = sqlite3.connect(self.spool_path, timeout=10)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def start(self):
        self.spool_path.parent.mkdir(parents=True, exist_ok=True)
        with self.spool() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, topic TEXT, payload BLOB, received REAL)')
        sub = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
            client_id='ptit-continuous-ingestor-v1', clean_session=False, protocol=mqtt.MQTTv311, manual_ack=True)
        sub.username_pw_set('backend-ingestor', passwords()['backend-ingestor'])
        sub.tls_set_context(tls_context())
        sub.reconnect_delay_set(1, 10)
        def on_connect(c, u, f, reason, props):
            if not reason.is_failure:
                c.subscribe([('iot/v1/farms/+/devices/+/telemetry', 1), ('iot/v1/farms/+/devices/+/status', 1)])
        def on_subscribe(c, u, mid, reasons, props):
            if all(not r.is_failure for r in reasons):
                self.subscribed.set()
        def on_disconnect(c, u, flags, reason, props):
            self.subscribed.clear()
        def on_message(c, u, msg):
            try:
                digest = hashlib.sha256(msg.topic.encode() + b'\0' + msg.payload).hexdigest()
                with self.spool() as db:
                    db.execute('INSERT OR IGNORE INTO inbox VALUES (?,?,?,?)',
                               (digest, msg.topic, msg.payload, time.time()))
                # ACK only after a durable local commit; DB retries survive app restarts.
                c.ack(msg.mid, msg.qos)
            except Exception:
                log.exception('Cannot persist MQTT message; acknowledgement withheld')
                self.last_error = 'Không lưu được hàng đợi MQTT.'
        sub.on_connect, sub.on_subscribe, sub.on_disconnect = on_connect, on_subscribe, on_disconnect
        sub.on_message = on_message
        sub.connect_async(MQTT_HOST, MQTT_PORT, keepalive=20)
        sub.loop_start()
        self.subscriber = sub
        for device in ('station-001', 'station-002'):
            c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f'ptit-simulator-{device}', protocol=mqtt.MQTTv5)
            c.username_pw_set(device, passwords()[device])
            c.tls_set_context(tls_context())
            c.max_queued_messages_set(200)
            c.reconnect_delay_set(1, 10)
            c.will_set(f'iot/v1/farms/{FARM}/devices/{device}/status', json.dumps({'online': False}), qos=1, retain=True)
            c.connect_async(MQTT_HOST, MQTT_PORT, keepalive=20)
            c.loop_start()
            self.clients[device] = c
        for target in (self.consume, self.simulate, self.infer):
            thread = threading.Thread(target=target, daemon=True, name=target.__name__)
            thread.start()
            self.threads.append(thread)

    def close(self):
        self.stop.set()
        self.sim_wake.set()
        for c in self.clients.values():
            c.disconnect()
            c.loop_stop()
        if self.subscriber:
            self.subscriber.disconnect()
            self.subscriber.loop_stop()
        for t in self.threads:
            t.join(timeout=20)

    def consume(self):
        while not self.stop.is_set():
            try:
                with self.spool() as spool:
                    row = spool.execute('SELECT id,topic,payload FROM inbox ORDER BY received LIMIT 1').fetchone()
                if not row:
                    self.stop.wait(.2)
                    continue
                key, topic, raw = row
                try:
                    if len(raw) > 16384:
                        raise ValueError('MQTT message too large')
                    data = json.loads(raw)
                    with connect() as db:
                        if topic.endswith('/telemetry'):
                            ingest(db, topic, data)
                        else:
                            parts = topic.split('/')
                            if len(parts) != 7 or not isinstance(data, dict) or type(data.get('online')) is not bool:
                                raise ValueError('Invalid status message')
                            device, farm = parts[5], parts[3]
                            if not db.execute('SELECT id FROM iot.devices WHERE id=%s AND farm_id=%s AND enabled', (device, farm)).fetchone():
                                raise ValueError('Unknown status device')
                            db.execute('''INSERT INTO iot.device_status(device_id,online) VALUES (%s,%s)
                                ON CONFLICT(device_id) DO UPDATE SET online=excluded.online,updated_at=now()''', (device, data['online']))
                except (ValueError, TypeError, KeyError, ValidationError, UnicodeDecodeError) as exc:
                    with connect() as db:
                        db.execute('INSERT INTO iot.ingest_rejections(topic,reason) VALUES (%s,%s)', (topic, str(exc)[:1000]))
                with self.spool() as spool:
                    spool.execute('DELETE FROM inbox WHERE id=?', (key,))
                self.received += 1
                self.last_error = None
            except Exception:
                self.last_error = 'Đang thử lại kết nối cơ sở dữ liệu; dữ liệu giữ trong hàng đợi.'
                log.exception('Ingest retry')
                self.stop.wait(3)

    def simulate(self):
        last_photo = 0
        while not self.stop.is_set():
            delay = 5
            try:
                settings = config()
                delay = settings['interval_seconds']
                if not self.subscribed.wait(1):
                    continue
                with connect() as db:
                    enabled = {r['id'] for r in db.execute('SELECT id FROM iot.devices WHERE farm_id=%s AND enabled', (FARM,)).fetchall()}
                for index, (device, c) in enumerate(self.clients.items()):
                    if device in settings.get('external_devices', []):
                        continue
                    online = settings['running'] and device not in settings['offline_devices'] and device in enabled
                    if not c.is_connected():
                        continue
                    c.publish(f'iot/v1/farms/{FARM}/devices/{device}/status', json.dumps({'online': online}), qos=1, retain=True)
                    if not online:
                        continue
                    message = payload()
                    message['source'] = 'simulation'
                    message['device_id'] = device
                    wave = math.sin(time.time()/40 + index)
                    baseline = {'normal': (28,72,58), 'hot-dry': (39,49,17), 'humid': (29,94,78), 'pests': (30,81,65)}[settings['scenario']]
                    message['measurements'] = {name: round(base+wave*1.5+random.uniform(-.4,.4), 1)
                        for name, base in zip(('temperature_c','air_humidity_pct','soil_moisture_pct'), baseline)}
                    message['battery_v'] = round(3.9 + .1*wave, 2)
                    message['rssi_dbm'] = -58 - index*8
                    c.publish(f'iot/v1/farms/{FARM}/devices/{device}/telemetry', json.dumps(message), qos=1)
                    if time.monotonic()-last_photo >= settings['camera_seconds']:
                        count = 9 if settings['scenario']=='pests' else 2
                        save_capture(device, camera_frame(count), count=count)
                if time.monotonic()-last_photo >= settings['camera_seconds']:
                    last_photo = time.monotonic()
            except Exception:
                log.exception('Simulation retry')
            self.sim_wake.wait(delay)
            self.sim_wake.clear()

    def infer(self):
        # One worker per process. Launcher deliberately runs a single uvicorn worker.
        while not self.stop.is_set():
            run_id = None
            try:
                with connect() as db:
                    run = db.execute('''SELECT r.id,r.image_id,c.object_key,c.farm_id,c.device_id
                        FROM iot.inference_runs r JOIN iot.image_captures c ON c.id=r.image_id
                        WHERE r.status='queued' ORDER BY r.created_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED''').fetchone()
                    if not run:
                        self.stop.wait(.5)
                        continue
                    run_id = run['id']
                    db.execute("UPDATE iot.inference_runs SET status='running',attempts=attempts+1 WHERE id=%s", (run_id,))
                with Image.open(MEDIA / run['object_key']) as img:
                    detections = synthetic_detect(img)
                with connect() as db:
                    for detection in detections:
                        db.execute('''INSERT INTO iot.pest_detections(inference_id,pest_code,confidence,x_min,y_min,x_max,y_max)
                            VALUES (%s,%s,%s,%s,%s,%s,%s)''', (run_id, *detection.values()))
                    db.execute("UPDATE iot.inference_runs SET status='succeeded',completed_at=now(),error_message=NULL WHERE id=%s", (run_id,))
                    alerts.evaluate(db, run['farm_id'], run['device_id'], pest_count=len(detections))
            except Exception as exc:
                log.exception('Image processing failed')
                if run_id:
                    try:
                        with connect() as db:
                            db.execute('''UPDATE iot.inference_runs SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,
                                error_message=%s,completed_at=now() WHERE id=%s''', (str(exc)[:500], run_id))
                    except Exception:
                        log.exception('Unable to update image job')
                self.stop.wait(3)

    def health(self):
        with self.spool() as db:
            pending = db.execute('SELECT count(*) FROM inbox').fetchone()[0]
        return dict(mqtt=self.subscribed.is_set(), buffered=pending, processed=self.received,
                    last_error=self.last_error, workers={t.name: t.is_alive() for t in self.threads})
