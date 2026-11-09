"""Synthetic camera + explicitly labelled fixture detector. No real pest model is claimed."""
from __future__ import annotations

import hashlib
import io
import os
import random
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, UnidentifiedImageError

from app.db import ROOT, FARM, connect

MEDIA = Path(os.getenv('MEDIA_DIR', str(ROOT / '.runtime/media')))
MODEL = 'synthetic-color-components-v1'
PALETTE = {'sau-to': (120, 210, 65), 'ray-nau': (182, 94, 48), 'bo-tri': (115, 70, 178)}
Image.MAX_IMAGE_PIXELS = 16_000_000


def camera_frame(count, seed=None):
    rng = random.Random(seed)
    img = Image.new('RGB', (960, 600), '#e5dba9')
    draw = ImageDraw.Draw(img)
    for x in range(0, 960, 48):
        draw.line((x, 0, x, 600), fill='#d6ca94')
    for y in range(0, 600, 48):
        draw.line((0, y, 960, y), fill='#d6ca94')
    draw.rectangle((18, 18, 942, 66), fill='#263f32')
    draw.text((34, 34), 'PTIT  /  SIMULATED TRAP CAMERA  /  NOT A FIELD PHOTO', fill='white')
    cells = rng.sample([(x, y) for x in range(90, 900, 130) for y in range(135, 550, 105)], count)
    for x, y in cells:
        species = rng.choice(list(PALETTE))
        color = PALETTE[species]
        if species == 'sau-to':
            draw.rounded_rectangle((x-30, y-10, x+30, y+10), radius=10, fill=color)
        else:
            draw.ellipse((x-18, y-27, x+18, y+27), fill=color)
        for d in (-1, 1):
            for dy in (-12, 0, 12):
                draw.line((x+d*10, y+dy, x+d*33, y+dy+8), fill=color, width=3)
    return img


def synthetic_detect(img):
    # Detect pixels from the synthetic palette, then connected components. No random boxes.
    arr = np.asarray(img.convert('RGB'))
    detections = []
    for species, color in PALETTE.items():
        mask = np.max(np.abs(arr.astype(np.int16) - np.array(color)), axis=2) < 12
        seen = np.zeros(mask.shape, dtype=bool)
        for y, x in np.argwhere(mask):
            if seen[y, x]:
                continue
            stack, points = [(int(x), int(y))], []
            seen[y, x] = True
            while stack:
                px, py = stack.pop()
                points.append((px, py))
                for nx, ny in ((px-1, py), (px+1, py), (px, py-1), (px, py+1)):
                    if 0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1] and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((nx, ny))
            if len(points) < 100:
                continue
            xs, ys = zip(*points)
            detections.append(dict(pest_code=species, confidence=1.0,
                x_min=min(xs)/img.width, y_min=min(ys)/img.height,
                x_max=(max(xs)+1)/img.width, y_max=(max(ys)+1)/img.height))
    return detections


def save_capture(device, image, source='simulation', count=None, capture_id=None):
    MEDIA.mkdir(parents=True, exist_ok=True)
    image = image.convert('RGB')
    image.thumbnail((1600, 1200))
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    data = buffer.getvalue()
    image_id = uuid.UUID(capture_id) if capture_id else uuid.uuid4()
    key = f'{image_id}.png'
    path = MEDIA / key
    path.write_bytes(data)
    try:
        with connect() as db:
            if not db.execute('SELECT id FROM iot.devices WHERE id=%s AND farm_id=%s AND enabled', (device, FARM)).fetchone():
                raise ValueError('Trạm không tồn tại hoặc đã tắt.')
            db.execute('''INSERT INTO iot.image_captures
                (id,device_id,farm_id,captured_at,object_key,sha256,width_px,height_px,source,simulation_count)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (image_id, device, FARM, datetime.now(timezone.utc), key, hashlib.sha256(data).hexdigest(),
                 image.width, image.height, source, count))
            # Real uploads are stored, but deliberately not passed to a fabricated pest model.
            status = 'queued' if source == 'simulation' else 'failed'
            error = None if source == 'simulation' else 'Chưa cài model sâu bệnh thực tế. Ảnh đã lưu; không tạo kết quả nhận diện giả.'
            db.execute('''INSERT INTO iot.inference_runs(image_id,model_version,status,error_message,completed_at)
                VALUES (%s,%s,%s,%s,%s)''',
                (image_id, MODEL if source == 'simulation' else 'real-model-not-configured', status, error,
                 None if source == 'simulation' else datetime.now(timezone.utc)))
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return str(image_id)


def decode_upload(data, formats=('JPEG', 'PNG', 'WEBP')):
    try:
        img = Image.open(io.BytesIO(data))
        if img.format not in formats:
            raise ValueError('Định dạng ảnh hỗ trợ: ' + ', '.join(formats) + '.')
        img.load()
        return img
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError('Ảnh không hợp lệ hoặc quá lớn.') from exc
