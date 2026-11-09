from __future__ import annotations
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import ssl
import uuid

from jsonschema import Draft202012Validator, FormatChecker
import paho.mqtt.client as mqtt

ROOT = Path(__file__).resolve().parents[1]
TOPIC = 'iot/v1/farms/farm-demo/devices/station-001/telemetry'
SCHEMA = json.loads((ROOT / 'contracts/telemetry.schema.json').read_text())
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())

def passwords():
    return json.loads((ROOT / '.secrets/credentials.json').read_text())

def tls_context():
    ctx = ssl.create_default_context(cafile=str(ROOT / '.secrets/certs/ca.crt'))
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx

def client(username, password=None, *, anonymous=False):
    obj = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                      client_id=f'ptit-{uuid.uuid4().hex[:16]}',protocol=mqtt.MQTTv5)
    if not anonymous:
        obj.username_pw_set(username, passwords()[username] if password is None else password)
    obj.tls_set_context(tls_context())
    return obj

def payload():
    return {
        'schema_version': 1, 'message_id': str(uuid.uuid4()),
        'device_id': 'station-001', 'farm_id': 'farm-demo',
        'observed_at': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z'),
        'measurements': {'temperature_c':29.5,'air_humidity_pct':76.2,'soil_moisture_pct':58},
        'battery_v':3.9,'rssi_dbm':-62,
    }

def validate_message(topic, data, *, now=None):
    VALIDATOR.validate(data)
    expected = f"iot/v1/farms/{data['farm_id']}/devices/{data['device_id']}/telemetry"
    if topic != expected:
        raise ValueError('Topic does not match payload farm_id/device_id')
    values = [*data['measurements'].values(), *[data[k] for k in ('battery_v','rssi_dbm') if k in data]]
    if not all(math.isfinite(value) for value in values):
        raise ValueError('Non-finite number')
    observed = datetime.fromisoformat(data['observed_at'].replace('Z','+00:00'))
    current = now or datetime.now(timezone.utc)
    if not current-timedelta(days=7) <= observed <= current+timedelta(minutes=5):
        raise ValueError('observed_at must be between now-7d and now+5min')
    return data
