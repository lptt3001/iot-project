from __future__ import annotations

import asyncio
import csv
import hashlib
import hmac
import io
import logging
import os
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Query, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from psycopg.types.json import Jsonb
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.db import ROOT, FARM, connect, migrate, config
from app.imaging import MEDIA, camera_frame, save_capture, decode_upload
from app.services import Services
from app.camera_api import router as camera_router
from app.device_api import router as device_router

log = logging.getLogger('garden')
services = Services()
USER_ID = '00000000-0000-4000-8000-000000000001'
SESSION_KEY = b''


@asynccontextmanager
async def lifespan(app):
    global SESSION_KEY
    migrate()
    keyfile = ROOT / '.secrets/session.key'
    if not keyfile.exists():
        keyfile.write_bytes(secrets.token_bytes(32))
    SESSION_KEY = keyfile.read_bytes()
    with connect() as db:
        db.execute("UPDATE iot.inference_runs SET status='queued' WHERE status='running'")
    services.start()
    yield
    await asyncio.to_thread(services.close)


app = FastAPI(title='PTIT Garden — mô phỏng IoT', version='1.0.0', lifespan=lifespan)
app.include_router(camera_router)
app.include_router(device_router)
allowed_hosts = ['127.0.0.1', 'localhost', 'testserver']
if public_host := os.getenv('GARDEN_PUBLIC_HOST'):
    allowed_hosts.append(public_host)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)


def signed_session():
    value = f'{USER_ID}.{int(time.time())+86400}.{secrets.token_hex(8)}'
    return value + '.' + hmac.new(SESSION_KEY, value.encode(), hashlib.sha256).hexdigest()


def valid_session(token):
    try:
        value, signature = token.rsplit('.', 1)
        user, expires, nonce = value.split('.')
        return (bool(SESSION_KEY) and user == USER_ID and int(expires)>time.time()
                and hmac.compare_digest(signature, hmac.new(SESSION_KEY, value.encode(), hashlib.sha256).hexdigest()))
    except (ValueError, AttributeError):
        return False


def same_origin(headers):
    origin = headers.get('origin')
    return not origin or origin in (f"http://{headers.get('host')}", f"https://{headers.get('host')}")


@app.middleware('http')
async def security(request: Request, call_next):
    # Device routes authenticate with a station token instead of a browser session.
    if not request.url.path.startswith('/device/v1/') and request.method not in ('GET','HEAD','OPTIONS'):
        if not same_origin(request.headers) or request.headers.get('x-garden-request') != '1':
            return JSONResponse({'detail':'Yêu cầu không cùng nguồn.'}, status_code=403)
    protected = request.url.path.startswith(('/api/', '/media/')) and request.url.path not in ('/api/session','/api/health')
    if protected and not valid_session(request.cookies.get('garden_session')):
        return JSONResponse({'detail':'Cần mở phiên mô phỏng.'}, status_code=401)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'same-origin'
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.exception_handler(Exception)
async def unexpected_error(request, exc):
    log.error('Request failed: %s', request.url.path, exc_info=exc)
    return JSONResponse({'detail':'Dịch vụ đang bận hoặc mất kết nối. Vui lòng thử lại.'}, status_code=503)


@app.post('/api/session')
def login(response: Response):
    # Intentionally local demo access, not a public multi-user login system.
    with connect() as db:
        member = db.execute('SELECT role FROM iot.farm_members WHERE user_id=%s AND farm_id=%s', (USER_ID,FARM)).fetchone()
        if not member:
            raise HTTPException(403, 'Tài khoản demo không có quyền vào vườn.')
    response.set_cookie('garden_session', signed_session(), httponly=True, samesite='strict',
                        secure=bool(os.getenv('GARDEN_PUBLIC_HOST')), max_age=86400)
    return {'name':'Người vận hành demo','farm_id':FARM,'mode':'local-simulation'}


@app.delete('/api/session')
def logout(response: Response):
    response.delete_cookie('garden_session')
    return {'ok':True}


@app.get('/api/health')
def health():
    try:
        with connect() as db:
            db.execute('SELECT 1')
        state = services.health()
        value = {'application':'ptit-garden','database':True,'ok':state['mqtt'] and all(state['workers'].values()), **state}
        return JSONResponse(value,status_code=200 if value['ok'] else 503)
    except Exception:
        return JSONResponse({'application':'ptit-garden','database':False,'ok':False}, status_code=503)


def devices(db, external_devices):
    return db.execute('''SELECT d.id,d.name,d.enabled,d.hardware_model,d.latitude,d.longitude,d.last_seen_at,
        r.temperature_c,r.air_humidity_pct,r.soil_moisture_pct,r.battery_v,r.rssi_dbm,r.observed_at,
        r.soil_raw,r.light_do,r.rain_do,r.source,
        COALESCE(d.enabled AND CASE WHEN d.id=ANY(%s::text[])
            THEN r.received_at>now()-interval '20 seconds'
            ELSE d.last_seen_at>now()-interval '20 seconds' AND COALESCE(s.online,true) END,false) AS online
        FROM iot.devices d LEFT JOIN iot.device_status s ON s.device_id=d.id
        LEFT JOIN LATERAL (SELECT * FROM iot.sensor_readings r WHERE r.device_id=d.id AND r.farm_id=d.farm_id
            AND (NOT (d.id=ANY(%s::text[])) OR r.source='hardware')
            ORDER BY r.observed_at DESC LIMIT 1) r ON true WHERE d.farm_id=%s ORDER BY d.id''',
        (external_devices, external_devices, FARM)).fetchall()


def snapshot():
    with connect() as db:
        farm = db.execute('SELECT id,name FROM iot.farms WHERE id=%s', (FARM,)).fetchone()
        totals = db.execute('''SELECT
            (SELECT count(*) FROM iot.sensor_readings WHERE farm_id=%s) AS readings,
            (SELECT count(*) FROM iot.alerts WHERE farm_id=%s AND acknowledged_at IS NULL) AS open_alerts,
            (SELECT count(*) FROM iot.image_captures WHERE farm_id=%s) AS images,
            (SELECT count(*) FROM iot.local_notifications n JOIN iot.alerts a ON a.id=n.alert_id
             WHERE a.farm_id=%s AND n.read_at IS NULL) AS unread''', (FARM,)*4).fetchone()
        recent_alerts = db.execute('SELECT * FROM iot.alerts WHERE farm_id=%s ORDER BY triggered_at DESC LIMIT 5', (FARM,)).fetchall()
        settings = config()
        return {'farm':farm, 'devices':devices(db, settings.get('external_devices', [])), 'totals':totals, 'alerts':recent_alerts,
                'simulation':settings, 'system':services.health(), 'server_time':time.time()}


@app.get('/api/dashboard')
def dashboard():
    return snapshot()


@app.websocket('/ws')
async def websocket(ws: WebSocket):
    if not same_origin(ws.headers) or not valid_session(ws.cookies.get('garden_session')):
        await ws.close(code=1008)
        return
    await ws.accept()
    try:
        while valid_session(ws.cookies.get('garden_session')):
            try:
                data = await asyncio.to_thread(snapshot)
                await ws.send_json(jsonable_encoder({'type':'snapshot','data':data}))
            except Exception:
                await ws.send_json({'type':'error','message':'Đang kết nối lại cơ sở dữ liệu.'})
            await asyncio.sleep(2)
        await ws.close(code=1008)
    except (WebSocketDisconnect, RuntimeError):
        pass


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


class Simulation(StrictModel):
    running: bool = True
    scenario: Literal['normal','hot-dry','humid','pests'] = 'normal'
    interval_seconds: int = Field(5, ge=2, le=15)
    camera_seconds: int = Field(45, ge=10, le=600)
    offline_devices: list[Literal['station-001','station-002']] = Field(default_factory=list, max_length=2)
    external_devices: list[Literal['station-001','station-002']] = Field(default_factory=list, max_length=2)


@app.put('/api/simulation')
def simulation(body: Simulation):
    with connect() as db:
        db.execute('UPDATE iot.app_settings SET value=%s WHERE key=%s', (Jsonb(body.model_dump()),'simulation'))
    services.sim_wake.set()
    return body


class DeviceEdit(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    enabled: bool
    latitude: float = Field(ge=-90,le=90)
    longitude: float = Field(ge=-180,le=180)


@app.put('/api/devices/{device_id}')
def edit_device(device_id: str, body: DeviceEdit):
    with connect() as db:
        row = db.execute('''UPDATE iot.devices SET name=%s,enabled=%s,latitude=%s,longitude=%s
            WHERE id=%s AND farm_id=%s RETURNING id''',
            (body.name,body.enabled,body.latitude,body.longitude,device_id,FARM)).fetchone()
        if not row:
            raise HTTPException(404,'Không tìm thấy trạm.')
    services.sim_wake.set()
    return {'ok':True}


@app.get('/api/history')
def history(hours: int = Query(1,ge=1,le=168), device: str | None = None,
            source: Literal['all','hardware','simulation'] | None = None):
    bucket = 1 if hours<=6 else 15 if hours<=48 else 60
    settings = config()
    source = source or ('hardware' if settings.get('external_devices') and not settings['running'] else 'all')
    with connect() as db:
        rows = db.execute('''SELECT time_bucket(%s * interval '1 minute',observed_at) AS time,device_id,
            avg(temperature_c) AS temperature_c,avg(air_humidity_pct) AS air_humidity_pct,
            avg(soil_moisture_pct) AS soil_moisture_pct,count(*) AS samples
            FROM iot.sensor_readings WHERE farm_id=%s AND observed_at>=now()-%s*interval '1 hour'
            AND (%s::text IS NULL OR device_id=%s) AND (%s='all' OR source=%s)
            GROUP BY time,device_id ORDER BY time''',
            (bucket,FARM,hours,device,device,source,source)).fetchall()
        return {'rows':rows,'bucket_minutes':bucket}


@app.get('/api/export.csv')
def export_csv(hours: int = Query(24,ge=1,le=168), device: str | None = None,
               source: Literal['all','hardware','simulation'] | None = None):
    settings = config()
    source = source or ('hardware' if settings.get('external_devices') and not settings['running'] else 'all')
    with connect() as db:
        rows = db.execute('''SELECT observed_at,device_id,temperature_c,air_humidity_pct,soil_moisture_pct,battery_v,rssi_dbm,
            soil_raw,light_do,rain_do,source
            FROM iot.sensor_readings WHERE farm_id=%s AND observed_at>=now()-%s*interval '1 hour'
            AND (%s::text IS NULL OR device_id=%s) AND (%s='all' OR source=%s)
            ORDER BY observed_at DESC LIMIT 50000''', (FARM,hours,device,device,source,source)).fetchall()
    buffer = io.StringIO()
    columns = ['observed_at','device_id','temperature_c','air_humidity_pct','soil_moisture_pct','battery_v','rssi_dbm',
               'soil_raw','light_do','rain_do','source']
    writer = csv.DictWriter(buffer, fieldnames=columns)
    writer.writeheader()
    writer.writerows(rows)
    return Response('\ufeff'+buffer.getvalue(), media_type='text/csv; charset=utf-8',
                    headers={'Content-Disposition':'attachment; filename="garden-telemetry.csv"'})


@app.get('/api/alerts')
def list_alerts(offset: int=Query(0,ge=0), limit: int=Query(30,ge=1,le=100), state: Literal['all','open','ack']='all'):
    clause = {'all':'true','open':'acknowledged_at IS NULL','ack':'acknowledged_at IS NOT NULL'}[state]
    with connect() as db:
        rows = db.execute(f'SELECT * FROM iot.alerts WHERE farm_id=%s AND {clause} ORDER BY triggered_at DESC LIMIT %s OFFSET %s', (FARM,limit,offset)).fetchall()
        total = db.execute(f'SELECT count(*) AS n FROM iot.alerts WHERE farm_id=%s AND {clause}', (FARM,)).fetchone()['n']
    return {'rows':rows,'total':total}


@app.post('/api/alerts/{alert_id}/ack')
def acknowledge(alert_id: uuid.UUID):
    with connect() as db:
        row = db.execute('UPDATE iot.alerts SET acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=%s AND farm_id=%s RETURNING id', (alert_id,FARM)).fetchone()
        if not row:
            raise HTTPException(404,'Không tìm thấy cảnh báo.')
        db.execute('UPDATE iot.local_notifications SET read_at=COALESCE(read_at,now()) WHERE alert_id=%s', (alert_id,))
    return {'ok':True}


@app.get('/api/notifications')
def notifications():
    with connect() as db:
        return db.execute('''SELECT n.id,n.read_at,n.created_at,a.message,a.severity,a.id AS alert_id
            FROM iot.local_notifications n JOIN iot.alerts a ON a.id=n.alert_id
            WHERE a.farm_id=%s ORDER BY n.created_at DESC LIMIT 100''',(FARM,)).fetchall()


@app.post('/api/notifications/read')
def read_notifications():
    with connect() as db:
        db.execute('''UPDATE iot.local_notifications n SET read_at=now() FROM iot.alerts a
            WHERE a.id=n.alert_id AND a.farm_id=%s AND n.read_at IS NULL''',(FARM,))
    return {'ok':True}


class Rule(StrictModel):
    name: str = Field(min_length=1,max_length=100)
    metric: Literal['temperature_c','air_humidity_pct','soil_moisture_pct','pest_count']
    operator: Literal['gt','gte','lt','lte']
    threshold: float = Field(ge=-40,le=125)
    window_minutes: int = Field(ge=1,le=1440)
    cooldown_minutes: int = Field(ge=1,le=1440)
    enabled: bool


@app.get('/api/rules')
def rules():
    with connect() as db:
        return db.execute('SELECT * FROM iot.alert_rules WHERE farm_id=%s ORDER BY metric,name',(FARM,)).fetchall()


@app.put('/api/rules/{rule_id}')
def edit_rule(rule_id: uuid.UUID, body: Rule):
    with connect() as db:
        row = db.execute('''UPDATE iot.alert_rules SET name=%s,metric=%s,operator=%s,threshold=%s,
            window_minutes=%s,cooldown_minutes=%s,enabled=%s WHERE id=%s AND farm_id=%s RETURNING id''',
            (*body.model_dump().values(),rule_id,FARM)).fetchone()
        if not row:
            raise HTTPException(404,'Không tìm thấy luật.')
    return {'ok':True}


class Capture(StrictModel):
    device_id: Literal['station-001','station-002'] = 'station-001'
    count: int = Field(2,ge=0,le=20)


@app.post('/api/captures',status_code=201)
def capture(body: Capture):
    try:
        image_id = save_capture(body.device_id,camera_frame(body.count),count=body.count)
        return {'id':image_id}
    except ValueError as exc:
        raise HTTPException(400,str(exc)) from exc


@app.post('/api/images/upload',status_code=201)
async def upload(device_id: Literal['station-001','station-002']='station-001', file: UploadFile=File(...)):
    data = await file.read(8*1024*1024+1)
    await file.close()
    if len(data)>8*1024*1024:
        raise HTTPException(413,'Ảnh tối đa 8 MB.')
    try:
        img = await asyncio.to_thread(decode_upload,data)
        image_id = await asyncio.to_thread(save_capture,device_id,img,'upload')
        return {'id':image_id,'message':'Đã lưu ảnh. Chưa cài model thật để phân loại sâu bệnh.'}
    except ValueError as exc:
        raise HTTPException(400,str(exc)) from exc


@app.get('/api/images')
def images(offset: int=Query(0,ge=0), limit: int=Query(12,ge=1,le=48), device: str | None=None):
    with connect() as db:
        rows = db.execute('''SELECT c.*,r.id AS inference_id,r.status,r.model_version,r.error_message,
            (SELECT count(*) FROM iot.pest_detections p WHERE p.inference_id=r.id) AS pest_count
            FROM iot.image_captures c LEFT JOIN iot.inference_runs r ON r.image_id=c.id
            WHERE c.farm_id=%s AND (%s::text IS NULL OR c.device_id=%s)
            ORDER BY c.captured_at DESC LIMIT %s OFFSET %s''',(FARM,device,device,limit,offset)).fetchall()
        for row in rows:
            row['detections'] = db.execute('SELECT pest_code,confidence,x_min,y_min,x_max,y_max FROM iot.pest_detections WHERE inference_id=%s',(row['inference_id'],)).fetchall()
        total = db.execute('SELECT count(*) AS n FROM iot.image_captures WHERE farm_id=%s AND (%s::text IS NULL OR device_id=%s)',(FARM,device,device)).fetchone()['n']
    return {'rows':rows,'total':total}


@app.get('/media/{image_id}.png')
def image_file(image_id: uuid.UUID):
    with connect() as db:
        row = db.execute('SELECT object_key FROM iot.image_captures WHERE id=%s AND farm_id=%s',(image_id,FARM)).fetchone()
    if not row or not (MEDIA / row['object_key']).is_file():
        raise HTTPException(404,'Không tìm thấy ảnh.')
    return FileResponse(MEDIA / row['object_key'], media_type='image/png')


app.mount('/static',StaticFiles(directory=ROOT / 'app/static'),name='static')


@app.get('/')
def index():
    return FileResponse(ROOT / 'app/static/index.html')
