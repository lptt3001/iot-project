"""Exercise real API/database with a generated test JPEG, then remove the fixture."""
import io
from pathlib import Path
import subprocess
import sys
import uuid
import httpx
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from app.db import connect


def main():
    ident=None
    with httpx.Client(base_url='http://127.0.0.1:8000',headers={'X-Garden-Request':'1'},timeout=20) as h:
        h.post('/api/session').raise_for_status()
        try:
            with httpx.Client(base_url='http://127.0.0.1:8000') as unauth:
                assert unauth.get('/api/camera/requests/'+str(uuid.uuid4())).status_code==401
            h.post('/api/camera/heartbeat',json={'ready':False}).raise_for_status()
            assert h.post('/api/camera/requests',json={}).status_code==409
            h.post('/api/camera/heartbeat',json={'ready':True}).raise_for_status()
            command=h.post('/api/camera/requests',json={'test_mode':True})
            command.raise_for_status(); ident=command.json()['id']
            assert h.post('/api/camera/requests',json={}).status_code==409
            claimed=h.post('/api/camera/claim',json={}).json()
            assert claimed['id']==ident and claimed['test_mode']
            assert h.post('/api/camera/claim',json={}).json() is None
            parameters={'capture_id':ident,'device_id':'station-001'}
            assert h.post('/api/camera/serial-upload',params=parameters,files={'file':('bad.jpg',b'bad','image/jpeg')}).status_code==400
            buf=io.BytesIO(); Image.new('RGB',(100,80),'green').save(buf,format='JPEG')
            for _ in range(2):
                response=h.post('/api/camera/serial-upload',params=parameters,files={'file':('fixture.jpg',buf.getvalue(),'image/jpeg')})
                response.raise_for_status(); assert response.json()['id']==ident
            status=h.get('/api/camera/requests/'+ident).json()
            assert status['status']=='succeeded' and status['image_id']==ident
            assert h.get('/media/'+ident+'.png').status_code==200
            with connect() as db:
                assert db.execute('SELECT count(*) AS n FROM iot.image_captures WHERE id=%s',(ident,)).fetchone()['n']==1
            print('PASS: authenticated command/claim, JPEG validation, actual DB/media persistence, duplicate retry.')
        finally:
            h.post('/api/camera/heartbeat',json={'ready':False}).raise_for_status()
            if ident:
                with connect() as db:
                    db.execute('DELETE FROM iot.camera_requests WHERE id=%s',(ident,))
                    db.execute('DELETE FROM iot.inference_runs WHERE image_id=%s',(ident,))
                    db.execute('DELETE FROM iot.image_captures WHERE id=%s',(ident,))
                code="import sys,uuid; from app.imaging import MEDIA; (MEDIA/(str(uuid.UUID(sys.argv[1]))+'.png')).unlink(missing_ok=True)"
                subprocess.run(['docker','compose','exec','-T','app','python','-c',code,ident],cwd=ROOT,check=True)
                print('Generated image fixture removed; it is not a real camera photograph.')


if __name__=='__main__': main()
