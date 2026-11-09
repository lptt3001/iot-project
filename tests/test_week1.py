from __future__ import annotations
import copy
from datetime import datetime, timedelta, timezone
import json
import os
import socket
import ssl
import threading
import unittest
import uuid

import psycopg
from jsonschema.exceptions import ValidationError

from common import ROOT, TOPIC, client, payload, tls_context, validate_message
from demo_telemetry import INSERT

HOST = os.environ.get('IOT_TEST_HOST','localhost')
MQTT_PORT = int(os.environ.get('IOT_TEST_MQTT_PORT','8883'))
DB_PORT = int(os.environ.get('IOT_TEST_DB_PORT','5432'))

def connect_db(user='iot_admin', *, autocommit=False):
    secret = {'iot_admin':'db_admin_password','iot_ingest':'db_ingest_password','iot_app':'db_app_password'}[user]
    return psycopg.connect(host=HOST,port=DB_PORT,dbname='iot',user=user,
        password=(ROOT / '.secrets' / secret).read_text().strip(),
        connect_timeout=5,autocommit=autocommit)

class ContractTests(unittest.TestCase):
    def test_valid_fresh_payload(self):
        validate_message(TOPIC,payload())

    def test_invalid_humidity_rejected(self):
        data = payload(); data['measurements']['air_humidity_pct'] = 101
        with self.assertRaises(ValidationError): validate_message(TOPIC,data)

    def test_missing_sensors_rejected(self):
        data = payload(); data['measurements'] = {}
        with self.assertRaises(ValidationError): validate_message(TOPIC,data)

    def test_unknown_fields_rejected(self):
        data = payload(); data['password'] = 'unexpected'
        with self.assertRaises(ValidationError): validate_message(TOPIC,data)

    def test_forged_topic_rejected(self):
        with self.assertRaises(ValueError): validate_message(TOPIC.replace('station-001','station-002'),payload())

    def test_future_and_expired_timestamps_rejected(self):
        for delta in (timedelta(minutes=6),timedelta(days=-8)):
            data=payload(); data['observed_at']=(datetime.now(timezone.utc)+delta).isoformat().replace('+00:00','Z')
            with self.assertRaises(ValueError): validate_message(TOPIC,data)
        for invalid in ('not-a-dateZ','2026-99-26T00:00:00Z','2026-10-26Z'):
            data=payload(); data['observed_at']=invalid
            with self.assertRaises(ValidationError): validate_message(TOPIC,data)

    def test_invalid_uuid_rejected(self):
        data=payload(); data['message_id']='not-a-uuid'
        with self.assertRaises(ValidationError): validate_message(TOPIC,data)

    def test_nan_rejected(self):
        data=payload(); data['measurements']['temperature_c']=float('nan')
        with self.assertRaises(ValueError): validate_message(TOPIC,data)

class MqttTests(unittest.TestCase):
    def setUp(self): self.clients=[]

    def tearDown(self):
        for obj in self.clients:
            obj.disconnect(); obj.loop_stop()

    def open(self,username='station-001',**kwargs):
        obj=client(username,**kwargs); self.clients.append(obj)
        connected=threading.Event(); reasons=[]
        def on_connect(c,u,f,r,p): reasons.append(r); connected.set()
        obj.on_connect=on_connect
        obj.connect(HOST,MQTT_PORT); obj.loop_start()
        self.assertTrue(connected.wait(6),'CONNACK timeout')
        return obj,reasons[0]

    def subscribe(self,obj,topic):
        event=threading.Event(); reasons=[]
        def on_subscribe(c,u,mid,r,p): reasons.extend(r); event.set()
        obj.on_subscribe=on_subscribe
        obj.subscribe(topic,qos=1)
        self.assertTrue(event.wait(6),'SUBACK timeout')
        return reasons

    def publish(self,obj,topic,value):
        event=threading.Event(); reasons=[]
        def on_publish(c,u,mid,r,p): reasons.append(r); event.set()
        obj.on_publish=on_publish
        obj.publish(topic,json.dumps(value),qos=1,retain=False)
        self.assertTrue(event.wait(6),'PUBACK timeout')
        return reasons[0]

    def test_trusted_tls_and_auth_succeed(self):
        obj,reason=self.open(); self.assertFalse(reason.is_failure)

    def test_anonymous_rejected(self):
        obj,reason=self.open(anonymous=True); self.assertTrue(reason.is_failure)

    def test_wrong_password_rejected(self):
        obj,reason=self.open(password='incorrect-on-purpose'); self.assertTrue(reason.is_failure)

    def test_untrusted_ca_rejected(self):
        with socket.create_connection((HOST,MQTT_PORT),timeout=5) as conn:
            with self.assertRaises(ssl.SSLCertVerificationError):
                ssl.create_default_context().wrap_socket(conn,server_hostname=HOST)

    def test_wrong_server_hostname_rejected(self):
        with socket.create_connection((HOST,MQTT_PORT),timeout=5) as conn:
            with self.assertRaises(ssl.SSLCertVerificationError):
                tls_context().wrap_socket(conn,server_hostname='forged-server.invalid')

    def test_tls12_supported(self):
        ctx=tls_context(); ctx.maximum_version=ssl.TLSVersion.TLSv1_2
        with socket.create_connection((HOST,MQTT_PORT),timeout=5) as conn:
            with ctx.wrap_socket(conn,server_hostname=HOST) as secure:
                self.assertEqual(secure.version(),'TLSv1.2')

    def test_qos1_telemetry_roundtrip(self):
        sub,reason=self.open('backend-ingestor'); self.assertFalse(reason.is_failure)
        self.assertFalse(self.subscribe(sub,TOPIC)[0].is_failure)
        received=threading.Event(); message=payload(); captured=[]
        def on_message(c,u,m):
            value=json.loads(m.payload)
            if value.get('message_id')==message['message_id']:
                captured.append(validate_message(m.topic,value)); received.set()
        sub.on_message=on_message
        pub,reason=self.open(); self.assertFalse(reason.is_failure)
        self.assertFalse(self.publish(pub,TOPIC,message).is_failure)
        self.assertTrue(received.wait(6),'Telemetry did not reach backend')
        self.assertEqual(captured[0],message)

    def test_cross_device_publish_denied(self):
        pub,reason=self.open()
        reason=self.publish(pub,TOPIC.replace('station-001','station-002'),payload())
        self.assertTrue(reason.is_failure)

    def test_cross_farm_publish_denied(self):
        pub,reason=self.open()
        self.assertTrue(self.publish(pub,TOPIC.replace('farm-demo','farm-other'),payload()).is_failure)

    def test_device_cannot_read_telemetry(self):
        sub,reason=self.open()
        # Mosquitto file ACL may accept SUBSCRIBE and filter delivery at read time.
        # Prove lack of delivery while a permitted control subscriber gets the same packet.
        self.subscribe(sub,TOPIC)
        forbidden=threading.Event(); permitted=threading.Event(); message=payload()
        def callback(event):
            def on_message(c,u,m):
                if json.loads(m.payload).get('message_id')==message['message_id']: event.set()
            return on_message
        sub.on_message=callback(forbidden)
        control,reason=self.open('backend-ingestor')
        control.on_message=callback(permitted)
        self.assertFalse(self.subscribe(control,TOPIC)[0].is_failure)
        self.assertFalse(self.publish(sub,TOPIC,message).is_failure)
        self.assertTrue(permitted.wait(6),'Control subscriber did not receive test message')
        self.assertFalse(forbidden.wait(1.5),'Device account received unauthorized telemetry')

    def test_backend_cannot_publish(self):
        pub,reason=self.open('backend-ingestor')
        self.assertTrue(self.publish(pub,TOPIC,payload()).is_failure)

class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.db=connect_db()
        self.observed=datetime.now(timezone.utc)-timedelta(minutes=1)
        self.msg=uuid.uuid4()

    def tearDown(self):
        self.db.rollback(); self.db.close()

    def insert(self,**overrides):
        values=dict(observed_at=self.observed,device_id='station-001',farm_id='farm-demo',
                    message_id=self.msg,temperature_c=29.5,air_humidity_pct=76.2,soil_moisture_pct=58,battery_v=3.9,rssi_dbm=-62)
        values.update(overrides)
        return self.db.execute(INSERT,tuple(values.values())).rowcount

    def test_extension_and_hypertable_exist(self):
        version=self.db.execute("SELECT extversion FROM pg_extension WHERE extname='timescaledb'").fetchone()
        self.assertIsNotNone(version)
        self.assertEqual(self.db.execute("SELECT count(*) FROM timescaledb_information.hypertables WHERE hypertable_schema='iot' AND hypertable_name='sensor_readings'").fetchone()[0],1)

    def test_qos_duplicate_is_idempotent(self):
        self.assertEqual(self.insert(),1); self.assertEqual(self.insert(),0)

    def test_sensor_range_enforced(self):
        with self.assertRaises(psycopg.errors.CheckViolation): self.insert(air_humidity_pct=101)

    def test_wrong_farm_device_pair_rejected(self):
        with self.assertRaises(psycopg.errors.ForeignKeyViolation): self.insert(farm_id='farm-other')

    def test_unknown_device_rejected(self):
        with self.assertRaises(psycopg.errors.ForeignKeyViolation): self.insert(device_id='station-unknown')

    def test_missing_measurements_rejected(self):
        with self.assertRaises(psycopg.errors.CheckViolation): self.insert(temperature_c=None,air_humidity_pct=None,soil_moisture_pct=None)

    def test_future_timestamp_rejected(self):
        with self.assertRaises(psycopg.errors.CheckViolation): self.insert(observed_at=datetime.now(timezone.utc)+timedelta(hours=1))

    def test_nonfinite_measurement_rejected(self):
        with self.assertRaises(psycopg.errors.CheckViolation): self.insert(temperature_c=float('nan'))

    def test_cross_farm_plot_rejected(self):
        with self.assertRaises(psycopg.errors.ForeignKeyViolation):
            self.db.execute("INSERT INTO iot.devices(id,farm_id,plot_id,name,mqtt_username) VALUES ('invalid-station','farm-other','00000000-0000-4000-8000-000000000010','invalid','invalid-station')")

    def test_background_policies_exist(self):
        jobs=self.db.execute("SELECT proc_name FROM timescaledb_information.jobs WHERE proc_name IN ('policy_retention','policy_refresh_continuous_aggregate')").fetchall()
        self.assertEqual(sum(j[0]=='policy_retention' for j in jobs),2)
        self.assertEqual(sum(j[0]=='policy_refresh_continuous_aggregate' for j in jobs),1)

    def test_ingest_role_limited(self):
        with connect_db('iot_ingest') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM iot.devices').fetchone()[0],2)
            self.assertEqual(db.execute("SELECT has_table_privilege(current_user,'iot.sensor_readings','INSERT')").fetchone()[0],True)
            self.assertEqual(db.execute("SELECT has_table_privilege(current_user,'iot.sensor_readings','DELETE')").fetchone()[0],False)
            with self.assertRaises(psycopg.errors.InsufficientPrivilege): db.execute('SELECT * FROM iot.app_users')

    def test_app_role_not_superuser(self):
        with connect_db('iot_app') as db:
            self.assertFalse(db.execute('SELECT rolsuper FROM pg_roles WHERE rolname=current_user').fetchone()[0])
            self.assertFalse(db.execute("SELECT has_schema_privilege(current_user,'iot','CREATE')").fetchone()[0])
            self.assertEqual(db.execute('SELECT count(*) FROM iot.farms').fetchone()[0],2)

class AggregateTests(unittest.TestCase):
    def test_hourly_aggregate_real_values(self):
        # Commit synthetic fixtures so the real continuous aggregate can refresh.
        # Always remove fixtures and refresh again, including on assertion failure.
        start=datetime.now(timezone.utc).replace(minute=0,second=0,microsecond=0)-timedelta(hours=3)
        end=start+timedelta(hours=1)
        ids=[uuid.uuid4(),uuid.uuid4()]
        with connect_db(autocommit=True) as db:
            try:
                for i,temp in enumerate((20,30)):
                    db.execute(INSERT,(start+timedelta(minutes=i+1),'station-002','farm-demo',ids[i],temp,70,50,3.9,-60))
                db.execute('CALL refresh_continuous_aggregate(%s,%s::timestamptz,%s::timestamptz)',('iot.telemetry_hourly',start,end))
                row=db.execute('SELECT sample_count,avg_temperature_c FROM iot.telemetry_hourly WHERE device_id=%s AND bucket=%s',('station-002',start)).fetchone()
                self.assertEqual(row[0],2); self.assertAlmostEqual(row[1],25)
            finally:
                db.execute('DELETE FROM iot.sensor_readings WHERE device_id=%s AND observed_at >= %s AND observed_at < %s AND message_id=ANY(%s)',('station-002',start,end,ids))
                db.execute('CALL refresh_continuous_aggregate(%s,%s::timestamptz,%s::timestamptz)',('iot.telemetry_hourly',start,end))
