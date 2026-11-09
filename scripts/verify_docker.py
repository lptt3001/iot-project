"""Check the real Compose stack and persistence across container recreation."""
from datetime import datetime, timezone
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import subprocess
import time

import httpx

ROOT = Path(__file__).resolve().parents[1]
URL = 'http://127.0.0.1:8000'


def compose(*args):
    return subprocess.run(['docker', 'compose', *args], cwd=ROOT, check=True,
                          capture_output=True, text=True, encoding='utf-8').stdout


@contextmanager
def session():
    with httpx.Client(base_url=URL, headers={'X-Garden-Request': '1'}, timeout=20) as client:
        client.post('/api/session').raise_for_status()
        yield client


def main():
    compose('ps', '--format', 'json')
    with session() as client:
        health = client.get('/api/health')
        health.raise_for_status()
        capture = client.post('/api/captures', json={'device_id': 'station-001', 'count': 7})
        capture.raise_for_status()
        image_id = capture.json()['id']
        deadline = time.monotonic() + 30
        while True:
            rows = client.get('/api/images?limit=48').json()['rows']
            row = next((r for r in rows if r['id'] == image_id and r['status'] == 'succeeded'), None)
            if row:
                assert row['pest_count'] == 7
                break
            if time.monotonic() >= deadline:
                raise AssertionError('Camera worker did not finish')
            time.sleep(.5)
        media_path = f'/media/{image_id}.png'
        media = client.get(media_path)
        media.raise_for_status()
        checksum = hashlib.sha256(media.content).hexdigest()
        before = client.get('/api/dashboard').json()
    # No -v: recreate containers while retaining their named volumes.
    print('Recreating Compose containers to verify stored data and images...', flush=True)
    compose('down', '--timeout', '45')
    compose('up', '-d', '--wait', '--wait-timeout', '180')
    with session() as client:
        client.get('/api/health').raise_for_status()
        after = client.get('/api/dashboard').json()
        assert after['simulation'] == before['simulation']
        assert after['totals']['readings'] >= before['totals']['readings']
        assert after['totals']['images'] >= before['totals']['images']
        media = client.get(media_path)
        media.raise_for_status()
        assert hashlib.sha256(media.content).hexdigest() == checksum
        final_health = client.get('/api/health').json()
    report = {
        'executed_at_utc': datetime.now(timezone.utc).isoformat(),
        'success': True,
        'camera_count_and_processing': True,
        'container_recreation_preserves_settings': True,
        'container_recreation_preserves_telemetry': True,
        'container_recreation_preserves_image_bytes': True,
        'health': final_health,
        'services': [json.loads(line) for line in compose('ps', '--format', 'json').splitlines() if line.strip()],
    }
    target = ROOT / 'output/verification/docker-verification.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('PASS: Docker services, camera, and persistence across container recreation.')


if __name__ == '__main__':
    main()
