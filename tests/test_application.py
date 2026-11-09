"""Integration checks against the actual running stack, not mocked API responses."""
from __future__ import annotations

import copy
import io
import json
from pathlib import Path
import sys
import time
import unittest
import uuid

import httpx
from PIL import Image
from websockets.sync.client import connect as ws_connect

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT / 'scripts'))
from app.db import connect
from app.imaging import camera_frame, synthetic_detect
from app.alerts import evaluate
from common import client, payload, TOPIC

URL='http://127.0.0.1:8000'


def eventually(callback, timeout=20):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        result=callback()
        if result:
            return result
        time.sleep(.3)
    raise AssertionError('Timed out waiting for actual stack state')


class ApplicationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http=httpx.Client(base_url=URL,headers={'X-Garden-Request':'1'},timeout=20)
        cls.http.post('/api/session').raise_for_status()

    @classmethod
    def tearDownClass(cls):
        cls.http.close()

    def test_access_control_and_origin(self):
        with httpx.Client(base_url=URL) as unauth:
            self.assertEqual(unauth.get('/api/dashboard').status_code,401)
            self.assertEqual(unauth.post('/api/session').status_code,403)
            self.assertEqual(unauth.post('/api/session',headers={'X-Garden-Request':'1','Origin':'https://attacker.invalid'}).status_code,403)
            self.assertEqual(unauth.get('/',headers={'Host':'attacker.invalid'}).status_code,400)
        self.assertEqual(self.http.get('/api/dashboard').status_code,200)
        self.assertEqual(self.http.get(f'/media/{uuid.uuid4()}.png').status_code,404)

    def test_api_validation_and_farm_scope(self):
        self.assertEqual(self.http.get('/api/history?hours=0').status_code,422)
        self.assertEqual(self.http.get('/api/images?limit=999').status_code,422)
        self.assertEqual(self.http.post('/api/captures',json={'count':999}).status_code,422)
        self.assertEqual(self.http.put('/api/simulation',json={'scenario':'invalid'}).status_code,422)
        data=self.http.get('/api/dashboard').json()
        self.assertEqual(data['farm']['id'],'farm-demo')
        self.assertEqual({r['id'] for r in data['devices']},{'station-001','station-002'})
        self.assertEqual(self.http.get('/api/history?device=unknown').json()['rows'],[])
        self.assertEqual(self.http.post('/api/alerts/'+str(uuid.uuid4())+'/ack').status_code,404)

    def test_camera_actual_boxes_counts_and_pest_alert(self):
        for n in (0,1,2,9,20):
            image=camera_frame(n,seed=42)
            detections=synthetic_detect(image)
            self.assertEqual(len(detections),n)
            for box in detections:
                self.assertTrue(0 <= box['x_min'] < box['x_max'] <= 1)
                self.assertTrue(0 <= box['y_min'] < box['y_max'] <= 1)
        start=self.http.get('/api/alerts?limit=100').json()['total']
        image_id=self.http.post('/api/captures',json={'device_id':'station-001','count':9}).json()['id']
        def completed():
            rows=self.http.get('/api/images?limit=48').json()['rows']
            return next((r for r in rows if r['id']==image_id and r['status']=='succeeded'),None)
        result=eventually(completed)
        self.assertEqual(result['pest_count'],9)
        self.assertEqual(len(result['detections']),9)
        self.assertEqual(result['source'],'simulation')
        image=self.http.get(f'/media/{image_id}.png')
        self.assertEqual(image.status_code,200)
        self.assertEqual(Image.open(io.BytesIO(image.content)).size,(960,600))
        alerts=self.http.get('/api/alerts?limit=100').json()
        pest_alerts=[a for a in alerts['rows'] if 'Mật độ sâu' in a['message'] and a['device_id']=='station-001']
        self.assertTrue(pest_alerts)
        # A second photo inside the cooldown must not create another same-device alert.
        count_before=len(pest_alerts)
        second=self.http.post('/api/captures',json={'device_id':'station-001','count':9}).json()['id']
        eventually(lambda:any(r['id']==second and r['status']=='succeeded' for r in self.http.get('/api/images?limit=48').json()['rows']))
        after=self.http.get('/api/alerts?limit=100').json()['rows']
        self.assertEqual(sum('Mật độ sâu' in a['message'] and a['device_id']=='station-001' for a in after),count_before)

    def test_csv_is_readable_and_scoped(self):
        result=self.http.get('/api/export.csv?hours=168&device=station-001')
        self.assertEqual(result.status_code,200)
        self.assertIn('observed_at,device_id,temperature_c',result.text)
        self.assertNotIn('station-002',result.text)
        self.assertIn('attachment',result.headers['content-disposition'])

    def test_mqtt_roundtrip_dedup_and_invalid_quarantine(self):
        data=payload()
        pub=client('station-001')
        pub.connect('localhost',8883)
        pub.loop_start()
        try:
            for _ in range(2):
                pub.publish(TOPIC,json.dumps(data),qos=1).wait_for_publish(timeout=8)
            def committed():
                with connect() as db:
                    return db.execute('SELECT count(*) AS n FROM iot.sensor_readings WHERE message_id=%s',(data['message_id'],)).fetchone()['n']
            self.assertEqual(eventually(committed),1)
            # Two duplicate envelopes can drain at different times; ensure they stay one row.
            time.sleep(.5)
            self.assertEqual(committed(),1)
            with connect() as db:
                before=db.execute('SELECT count(*) AS n FROM iot.ingest_rejections').fetchone()['n']
            pub.publish(TOPIC,'{"invalid":true}',qos=1).wait_for_publish(timeout=8)
            def rejected():
                with connect() as db:
                    return db.execute('SELECT count(*) AS n FROM iot.ingest_rejections').fetchone()['n']>before
            eventually(rejected)
        finally:
            pub.disconnect();pub.loop_stop()

    def test_notification_acknowledgement(self):
        rows=self.http.get('/api/alerts?limit=100').json()['rows']
        if not rows:
            self.skipTest('No alert generated yet')
        alert=rows[0]
        self.assertEqual(self.http.post(f"/api/alerts/{alert['id']}/ack").status_code,200)
        acknowledged=self.http.get('/api/alerts?state=ack&limit=100').json()['rows']
        self.assertTrue(any(a['id']==alert['id'] and a['acknowledged_at'] for a in acknowledged))
        self.http.post('/api/notifications/read').raise_for_status()
        self.assertTrue(all(n['read_at'] for n in self.http.get('/api/notifications').json()))

    def test_simulation_offline_pause_resume_and_thresholds(self):
        original=self.http.get('/api/dashboard').json()['simulation']
        changed={**copy.deepcopy(original),'running':True,'scenario':'hot-dry','offline_devices':['station-002'],'interval_seconds':2}
        try:
            self.http.put('/api/simulation',json=changed).raise_for_status()
            def hot_and_offline():
                ds={d['id']:d for d in self.http.get('/api/dashboard').json()['devices']}
                return ds['station-001']['online'] and ds['station-001']['temperature_c']>35 and not ds['station-002']['online']
            eventually(hot_and_offline)
            self.http.put('/api/simulation',json={**changed,'running':False}).raise_for_status()
            eventually(lambda:all(not d['online'] for d in self.http.get('/api/dashboard').json()['devices']))
            self.assertEqual(self.http.get('/api/dashboard').json()['simulation']['running'],False)
        finally:
            self.http.put('/api/simulation',json=original).raise_for_status()
        eventually(lambda:all(d['online'] for d in self.http.get('/api/dashboard').json()['devices']))

    def test_upload_stores_without_fake_real_inference(self):
        data=io.BytesIO()
        Image.new('RGB',(200,100),'red').save(data,format='JPEG')
        response=self.http.post('/api/images/upload',files={'file':('test.jpg',data.getvalue(),'image/jpeg')})
        self.assertEqual(response.status_code,201)
        row=next(r for r in self.http.get('/api/images?limit=48').json()['rows'] if r['id']==response.json()['id'])
        self.assertEqual(row['source'],'upload')
        self.assertEqual(row['model_version'],'real-model-not-configured')
        self.assertEqual(row['detections'],[])
        self.assertEqual(self.http.post('/api/images/upload',files={'file':('test.jpg',b'not an image','image/jpeg')}).status_code,400)

    def test_websocket_live_snapshot_and_auth(self):
        cookie='garden_session='+self.http.cookies.get('garden_session')
        with ws_connect('ws://127.0.0.1:8000/ws',origin=URL,additional_headers={'Cookie':cookie},open_timeout=8) as ws:
            data=json.loads(ws.recv(timeout=8))
            self.assertEqual(data['type'],'snapshot')
            self.assertEqual(data['data']['farm']['id'],'farm-demo')
        with self.assertRaises(Exception):
            with ws_connect('ws://127.0.0.1:8000/ws',origin='https://attacker.invalid',additional_headers={'Cookie':cookie},open_timeout=8):
                pass

    def test_transactional_threshold_and_per_device_cooldown(self):
        db=connect()
        try:
            rule=db.execute('''INSERT INTO iot.alert_rules
                (farm_id,name,metric,operator,threshold,window_minutes,cooldown_minutes,enabled)
                VALUES ('farm-demo','Integration-only threshold','temperature_c','gte',-40,60,5,true)
                RETURNING id''').fetchone()['id']
            for device in ('station-001','station-002'):
                evaluate(db,'farm-demo',device)
                evaluate(db,'farm-demo',device)
            rows=db.execute('SELECT id,device_id FROM iot.alerts WHERE rule_id=%s',(rule,)).fetchall()
            self.assertEqual({r['device_id'] for r in rows},{'station-001','station-002'})
            self.assertEqual(len(rows),2)
            for row in rows:
                self.assertIsNotNone(db.execute('SELECT id FROM iot.local_notifications WHERE alert_id=%s',(row['id'],)).fetchone())
        finally:
            db.rollback()
            db.close()


if __name__=='__main__':
    unittest.main(verbosity=2)
