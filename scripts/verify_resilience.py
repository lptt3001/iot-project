"""Exercise a real DB outage and full Windows stack restart, preserving demo settings."""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time

import httpx

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from app.db import connect
from scripts.common import client, payload, TOPIC


def run(args):
    env=os.environ.copy()
    env['PYTHONUTF8']='1'
    # Daemon children can inherit anonymous pipe handles on Windows. A file
    # prevents communicate() from waiting for a running server to close a pipe.
    with tempfile.TemporaryFile(mode='w+b') as output:
        result=subprocess.run(args,cwd=ROOT,env=env,stdout=output,stderr=subprocess.STDOUT,
            creationflags=0x08000000,timeout=100)
        if result.returncode:
            output.seek(0)
            raise RuntimeError(output.read().decode('utf-8',errors='replace')[-3000:])


def eventually(callback,timeout=30):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        if callback():
            return
        time.sleep(.3)
    raise RuntimeError('Timed out waiting for recovery')


def main():
    evidence={'executed_at_utc':datetime.now(timezone.utc).isoformat()}
    with httpx.Client(base_url='http://127.0.0.1:8000',headers={'X-Garden-Request':'1'},timeout=20) as http:
        http.post('/api/session').raise_for_status()
        original=http.get('/api/dashboard').json()['simulation']
        http.put('/api/simulation',json={**original,'running':False}).raise_for_status()
        time.sleep(1)
        data=payload()
        pub=client('station-001')
        try:
            run([sys.executable,'scripts/setup_database_windows.py','--stop'])
            pub.connect('127.0.0.1',8883)
            pub.loop_start()
            pub.publish(TOPIC,json.dumps(data),qos=1).wait_for_publish(timeout=8)
            def buffered():
                with closing(sqlite3.connect(ROOT/'.runtime/ingest.sqlite3')) as db:
                    return db.execute('SELECT count(*) FROM inbox WHERE instr(CAST(payload AS TEXT),?)>0',(data['message_id'],)).fetchone()[0]>0
            eventually(buffered)
            evidence['mqtt_during_database_outage']='persisted_in_local_inbox'
        finally:
            pub.disconnect()
            pub.loop_stop()
            run([sys.executable,'scripts/setup_database_windows.py'])
        def committed():
            with connect() as db:
                return db.execute('SELECT count(*) AS n FROM iot.sensor_readings WHERE message_id=%s',(data['message_id'],)).fetchone()['n']==1
        eventually(committed)
        evidence['buffered_sample_recovered_once']=True
        http.put('/api/simulation',json=original).raise_for_status()
        before=http.get('/api/dashboard').json()
        image=http.get('/api/images?limit=1').json()['rows'][0]['id']
        run(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/stop_app.ps1'])
        run(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/start_app.ps1','-NoBrowser'])
        after=http.get('/api/dashboard').json()
        if after['simulation']!=before['simulation']:
            raise RuntimeError('Simulation configuration changed after restart')
        if after['totals']['readings']<before['totals']['readings']:
            raise RuntimeError('Saved telemetry was lost')
        http.get(f'/media/{image}.png').raise_for_status()
        evidence['full_stack_restart_preserves_settings']=True
        evidence['full_stack_restart_preserves_telemetry_and_images']=True
        evidence['healthy_after_restart']=http.get('/api/health').json()['ok']
    target=ROOT/'output/verification/resilience-verification.json'
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(evidence,indent=2),encoding='utf-8')
    print(json.dumps(evidence,indent=2))


if __name__=='__main__':
    main()
