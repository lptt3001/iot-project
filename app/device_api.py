"""HTTPS ingress for remote stations, separate from browser and USB access."""
import hmac
import json
import os
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from jsonschema import ValidationError
from starlette.concurrency import run_in_threadpool

from app.camera_api import check_device, store_hardware_image
from app.db import FARM, ROOT, connect
from app.imaging import decode_upload
from app.services import ingest

router = APIRouter(prefix='/device/v1')
TOKEN_FILE = ROOT / '.secrets/device-http.json'


def authenticate(device_id: str, request: Request):
    if os.getenv('GARDEN_DEVICE_HTTP_ENABLED') != '1':
        raise HTTPException(404, 'Device ingress is disabled.')
    if not TOKEN_FILE.exists():
        raise HTTPException(503, 'Device ingress is not configured.')
    token = json.loads(TOKEN_FILE.read_text(encoding='utf-8')).get(device_id)
    scheme, _, provided = request.headers.get('authorization', '').partition(' ')
    if not isinstance(token, str) or not token or scheme.lower() != 'bearer' or not hmac.compare_digest(
        provided.encode(), token.encode()
    ):
        raise HTTPException(401, 'Invalid device token.', headers={'WWW-Authenticate': 'Bearer'})


async def read_body(request, media_type, limit):
    if request.headers.get('content-type', '').split(';', 1)[0].strip().lower() != media_type:
        raise HTTPException(415, f'Expected {media_type}.')
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > limit:
            raise HTTPException(413, 'Request body is too large.')
        data.extend(chunk)
    return data


def store_telemetry(device_id, data):
    if not isinstance(data, dict) or data.get('device_id') != device_id or data.get('farm_id') != FARM:
        raise HTTPException(422, 'Payload must match the authenticated station and farm.')
    data['source'] = 'hardware'
    topic = f'iot/v1/farms/{FARM}/devices/{device_id}/telemetry'
    with connect() as db:
        check_device(db, device_id)
        db.execute('''UPDATE iot.app_settings SET value = value || jsonb_build_object(
            'running', false, 'external_devices',
            COALESCE(value->'external_devices', '[]'::jsonb) || jsonb_build_array(%s::text))
            WHERE key='simulation' AND NOT (COALESCE(value->'external_devices', '[]'::jsonb) ? %s)''',
            (device_id, device_id))
        try:
            inserted = ingest(db, topic, data)
        except (ValidationError, ValueError, OverflowError) as exc:
            raise HTTPException(422, 'Invalid telemetry or timestamp.') from exc
        db.execute('''INSERT INTO iot.device_status(device_id,online) VALUES (%s,true)
            ON CONFLICT(device_id) DO UPDATE SET online=true,updated_at=now()''', (device_id,))
    return {'message_id': data['message_id'], 'duplicate': not bool(inserted)}


@router.post('/{device_id}/telemetry', dependencies=[Depends(authenticate)])
async def telemetry(device_id: str, request: Request):
    raw = await read_body(request, 'application/json', 16 * 1024)
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError) as exc:
        raise HTTPException(422, 'Invalid JSON.') from exc
    return await run_in_threadpool(store_telemetry, device_id, data)


@router.put('/{device_id}/images/{capture_id}', status_code=201, dependencies=[Depends(authenticate)])
async def upload_image(device_id: str, capture_id: UUID, request: Request):
    raw = await read_body(request, 'image/jpeg', 2 * 1024 * 1024)
    try:
        image = await run_in_threadpool(decode_upload, raw, ('JPEG',))
    except ValueError as exc:
        raise HTTPException(422, 'Invalid JPEG.') from exc
    return await run_in_threadpool(store_hardware_image, capture_id, device_id, image)
