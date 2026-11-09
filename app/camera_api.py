"""Local UI/USB gateway commands; all routes use the application's session middleware."""
import asyncio
import uuid
import time

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from app.db import connect, FARM
from app.imaging import decode_upload, save_capture
from psycopg.types.json import Jsonb

router = APIRouter(prefix='/api/camera')


class CameraCommand(BaseModel):
    device_id: str = 'station-001'
    test_mode: bool = False


class GatewayState(BaseModel):
    device_id: str = 'station-001'
    ready: bool = False


@router.post('/heartbeat')
def heartbeat(body: GatewayState):
    with connect() as db:
        check_device(db,body.device_id)
        db.execute('INSERT INTO iot.app_settings(key,value) VALUES (%s,%s) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            ('camera:'+body.device_id,Jsonb({'ready':body.ready,'at':time.time()})))
    return {'ok':True}


def check_device(db, device):
    if not db.execute('SELECT id FROM iot.devices WHERE id=%s AND farm_id=%s AND enabled',(device,FARM)).fetchone():
        raise HTTPException(404,'Không tìm thấy trạm đang bật.')


@router.post('/requests',status_code=201)
def request_photo(body: CameraCommand):
    with connect() as db:
        check_device(db,body.device_id)
        gateway=db.execute('SELECT value FROM iot.app_settings WHERE key=%s',('camera:'+body.device_id,)).fetchone()
        if not gateway or not gateway['value']['ready'] or time.time()-gateway['value']['at']>30:
            raise HTTPException(409,'Camera USB chưa sẵn sàng. Cần nạp firmware camera và chạy lại gateway COM5.')
        db.execute("UPDATE iot.camera_requests SET status='failed',error='Hết thời gian chờ mạch.',completed_at=now() WHERE status IN ('queued','sent') AND created_at<now()-interval '2 minutes'")
        db.execute('SELECT pg_advisory_xact_lock(hashtext(%s))',('camera:'+body.device_id,))
        if db.execute("SELECT id FROM iot.camera_requests WHERE device_id=%s AND status IN ('queued','sent')",(body.device_id,)).fetchone():
            raise HTTPException(409,'Trạm đang xử lý một yêu cầu chụp.')
        request_id=uuid.uuid4()
        db.execute('INSERT INTO iot.camera_requests(id,device_id,test_mode) VALUES (%s,%s,%s)',(request_id,body.device_id,body.test_mode))
    return {'id':str(request_id),'status':'queued'}


@router.get('/requests/{request_id}')
def camera_status(request_id: uuid.UUID):
    with connect() as db:
        db.execute("UPDATE iot.camera_requests SET status='failed',error='Hết thời gian chờ mạch.',completed_at=now() WHERE id=%s AND status IN ('queued','sent') AND created_at<now()-interval '2 minutes'",(request_id,))
        row=db.execute('SELECT r.* FROM iot.camera_requests r JOIN iot.devices d ON d.id=r.device_id WHERE r.id=%s AND d.farm_id=%s',(request_id,FARM)).fetchone()
    if not row:
        raise HTTPException(404,'Không tìm thấy yêu cầu.')
    return row


@router.post('/claim')
def claim(body: CameraCommand):
    with connect() as db:
        check_device(db,body.device_id)
        row=db.execute("SELECT * FROM iot.camera_requests WHERE device_id=%s AND status='queued' AND created_at>now()-interval '2 minutes' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",(body.device_id,)).fetchone()
        if row:
            db.execute("UPDATE iot.camera_requests SET status='sent' WHERE id=%s",(row['id'],))
    return row


class Failure(BaseModel):
    error: str


@router.post('/requests/{request_id}/fail')
def fail(request_id: uuid.UUID, body: Failure):
    with connect() as db:
        if not db.execute('SELECT r.id FROM iot.camera_requests r JOIN iot.devices d ON d.id=r.device_id WHERE r.id=%s AND d.farm_id=%s',(request_id,FARM)).fetchone():
            raise HTTPException(404,'Không tìm thấy yêu cầu.')
        db.execute("UPDATE iot.camera_requests SET status='failed',error=%s,completed_at=now() WHERE id=%s AND status IN ('queued','sent')",(body.error[:500],request_id))
    return {'ok':True}


@router.post('/serial-upload',status_code=201)
async def serial_upload(capture_id: uuid.UUID, device_id: str='station-001', file: UploadFile=File(...)):
    data=await file.read(2*1024*1024+1)
    await file.close()
    if len(data)>2*1024*1024:
        raise HTTPException(413,'Ảnh Serial tối đa 2 MB.')
    try:
        image=await asyncio.to_thread(decode_upload,data)
    except ValueError as exc:
        raise HTTPException(400,str(exc)) from exc
    return await asyncio.to_thread(store_hardware_image, capture_id, device_id, image)


def store_hardware_image(capture_id, device_id, image):
    with connect() as db:
        check_device(db,device_id)
        db.execute('SELECT pg_advisory_xact_lock(hashtext(%s))',(str(capture_id),))
        existing=db.execute('SELECT id,device_id FROM iot.image_captures WHERE id=%s AND farm_id=%s',(capture_id,FARM)).fetchone()
        if existing and existing['device_id']!=device_id:
            raise HTTPException(409,'Mã ảnh đã thuộc trạm khác.')
        request=db.execute('SELECT device_id FROM iot.camera_requests WHERE id=%s',(capture_id,)).fetchone()
        if request and request['device_id']!=device_id:
            raise HTTPException(409,'Mã yêu cầu thuộc trạm khác.')
        if not existing:
            save_capture(device_id,image,'hardware',None,str(capture_id))
        db.execute("UPDATE iot.camera_requests SET status='succeeded',image_id=%s,completed_at=now() WHERE id=%s AND device_id=%s",(capture_id,capture_id,device_id))
    return {'id':str(capture_id),'source':'hardware'}
