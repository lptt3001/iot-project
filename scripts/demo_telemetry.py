"""Publish synthetic telemetry through verified TLS, optionally insert received data into DB."""
import argparse
import json
import threading

from common import ROOT, TOPIC, client, payload, validate_message

INSERT = '''INSERT INTO iot.sensor_readings
 (observed_at,device_id,farm_id,message_id,temperature_c,air_humidity_pct,soil_moisture_pct,battery_v,rssi_dbm)
 VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
 ON CONFLICT (device_id,observed_at,message_id) DO NOTHING'''

def insert_received(data, host='localhost', port=5432):
    import psycopg
    m = data['measurements']
    with psycopg.connect(host=host,port=port,dbname='iot',user='iot_ingest',
                        password=(ROOT / '.secrets/db_ingest_password').read_text().strip(),connect_timeout=5) as db:
        device = db.execute('SELECT enabled FROM iot.devices WHERE id=%s AND farm_id=%s',
                            (data['device_id'],data['farm_id'])).fetchone()
        if not device or not device[0]:
            raise ValueError('Unknown, disabled or mismatched device')
        row = db.execute(INSERT,(data['observed_at'],data['device_id'],data['farm_id'],data['message_id'],
            m.get('temperature_c'),m.get('air_humidity_pct'),m.get('soil_moisture_pct'),
            data.get('battery_v'),data.get('rssi_dbm')))
        db.execute('UPDATE iot.devices SET last_seen_at=now() WHERE id=%s',(data['device_id'],))
        return row.rowcount

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host',default='localhost')
    parser.add_argument('--port',type=int,default=8883)
    parser.add_argument('--database',action='store_true',help='Insert actual received payload into TimescaleDB')
    parser.add_argument('--db-port',type=int,default=5432)
    args = parser.parse_args()
    subscribed, received = threading.Event(), threading.Event()
    captured = []
    message = payload()
    sub, pub = client('backend-ingestor'), client('station-001')
    def on_connect(c,u,f,r,p):
        if not r.is_failure:
            c.subscribe(TOPIC,qos=1)
    def on_subscribe(c,u,mid,reasons,p):
        if reasons and not reasons[0].is_failure:
            subscribed.set()
    def on_message(c,u,m):
        value = json.loads(m.payload)
        if value.get('message_id') == message['message_id']:
            captured.append(validate_message(m.topic,value))
            received.set()
    sub.on_connect,sub.on_subscribe,sub.on_message = on_connect,on_subscribe,on_message
    try:
        sub.connect(args.host,args.port); sub.loop_start()
        if not subscribed.wait(8):
            raise RuntimeError('Subscribe failed or timed out')
        pub.connect(args.host,args.port); pub.loop_start()
        ack = pub.publish(TOPIC,json.dumps(message),qos=1,retain=False)
        ack.wait_for_publish(timeout=8)
        if not received.wait(8):
            raise RuntimeError('No matching telemetry received')
        print(json.dumps({'mqtt':'PASS','topic':TOPIC,'message':captured[0]},ensure_ascii=False,indent=2))
        if args.database:
            first = insert_received(captured[0],port=args.db_port)
            duplicate = insert_received(captured[0],port=args.db_port)
            # The continuous application may have committed the same MQTT sample
            # before this standalone verifier. Both receivers must remain idempotent.
            if first not in (0,1) or duplicate != 0:
                raise RuntimeError(f'Unexpected insert/dedup result: {first}, {duplicate}')
            print('Database: PASS, received telemetry inserted once; QoS duplicate ignored.')
    finally:
        for obj in (pub,sub):
            obj.disconnect(); obj.loop_stop()

if __name__ == '__main__':
    main()
