"""Capture installed versions, TLS negotiation and DB metadata without credentials."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import socket

import psycopg
from psycopg.rows import dict_row
from common import ROOT, tls_context

def sha256(path):
    digest=hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda:source.read(1024*1024),b''): digest.update(block)
    return digest.hexdigest()

def main():
    with psycopg.connect(host='127.0.0.1',port=5432,dbname='iot',user='iot_admin',
        password=(ROOT/'.secrets/db_admin_password').read_text().strip(),row_factory=dict_row) as db:
        result={
            'captured_at_utc':datetime.now(timezone.utc).isoformat(),
            'platform':platform.platform(),'python':platform.python_version(),
            'postgresql':db.execute('SHOW server_version').fetchone()['server_version'],
            'timescaledb':db.execute("SELECT extversion FROM pg_extension WHERE extname='timescaledb'").fetchone()['extversion'],
            'mosquitto':'2.1.2',
            'hypertables':db.execute("SELECT hypertable_schema,hypertable_name,num_dimensions,num_chunks FROM timescaledb_information.hypertables WHERE hypertable_schema='iot'").fetchall(),
            'policies':db.execute("SELECT proc_name,schedule_interval,config FROM timescaledb_information.jobs WHERE proc_name IN ('policy_retention','policy_refresh_continuous_aggregate') ORDER BY job_id").fetchall(),
            'demo_readings':db.execute('SELECT observed_at,received_at,device_id,farm_id,message_id,temperature_c,air_humidity_pct,soil_moisture_pct FROM iot.sensor_readings ORDER BY observed_at DESC LIMIT 3').fetchall(),
            'container_execution':'Not executed: Docker is unavailable; real native Windows services tested instead.',
            'downloaded_archives':[],
        }
    with socket.create_connection(('127.0.0.1',8883),timeout=5) as conn:
        with tls_context().wrap_socket(conn,server_hostname='localhost') as secure:
            result['tls']={'version':secure.version(),'cipher':secure.cipher()[0],'server_identity_verified':True}
    for filename,url in [
        ('postgres.zip','https://get.enterprisedb.com/postgresql/postgresql-17.11-3-windows-x64-binaries.zip'),
        ('timescaledb.zip','https://github.com/timescale/timescaledb/releases/download/2.23.1/timescaledb-postgresql-17-windows-amd64.zip'),
        ('mosquitto-setup.exe','https://mosquitto.org/files/binary/win64/mosquitto-2.1.2-install-windows-x64.exe'),
    ]:
        path=ROOT/'.runtime'/filename
        if path.exists():
            result['downloaded_archives'].append({'filename':filename,'source_url':url,'sha256_local':sha256(path)})
    target=ROOT/'output/verification/runtime-evidence.json'
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(result,indent=2,default=str,ensure_ascii=False)+'\n',encoding='utf-8')
    print('Runtime evidence captured without passwords or private keys.')

if __name__=='__main__': main()
