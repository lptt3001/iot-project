"""Install a private, portable PostgreSQL/TimescaleDB instance without Windows services."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile

import psycopg
from psycopg import sql
from common import ROOT

PG_URL='https://get.enterprisedb.com/postgresql/postgresql-17.11-3-windows-x64-binaries.zip'
TS_URL='https://github.com/timescale/timescaledb/releases/download/2.23.1/timescaledb-postgresql-17-windows-amd64.zip'
CREATE_NO_WINDOW=0x08000000

def run(args,**kwargs):
    return subprocess.run([str(v) for v in args],check=True,creationflags=CREATE_NO_WINDOW,**kwargs)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--stop',action='store_true')
    parser.add_argument('--port',type=int,default=5432)
    args=parser.parse_args()
    if os.name != 'nt': raise SystemExit('Windows only. Use compose.yaml on other platforms.')
    key=hashlib.sha256(str(ROOT).encode()).hexdigest()[:8]
    native=Path(os.environ['LOCALAPPDATA']) / f'PTIT-IoT-Week1-{key}'
    pg=native / 'pgsql'; data=native / 'data'; cache=ROOT / '.runtime'
    if args.stop:
        running=(pg/'bin/pg_ctl.exe').exists() and subprocess.run(
            [str(pg/'bin/pg_ctl.exe'),'-D',str(data),'status'],
            creationflags=CREATE_NO_WINDOW,capture_output=True).returncode == 0
        if running:
            run([pg/'bin/pg_ctl.exe','-D',data,'stop','-m','fast','-w'])
        else: print('Private database is already stopped.')
        return
    native.mkdir(parents=True,exist_ok=True); cache.mkdir(exist_ok=True)
    if not (pg/'bin/postgres.exe').exists():
        archive=cache/'postgres.zip'
        if not archive.exists():
            print('Downloading official PostgreSQL Windows binaries...',flush=True)
            urllib.request.urlretrieve(PG_URL,archive)
        with zipfile.ZipFile(archive) as z:
            z.extractall(native,members=[n for n in z.namelist() if n.startswith(('pgsql/bin/','pgsql/lib/','pgsql/share/'))])
    if not (pg/'lib/timescaledb-2.23.1.dll').exists():
        archive=cache/'timescaledb.zip'
        if not archive.exists():
            print('Downloading official TimescaleDB Windows extension...',flush=True)
            urllib.request.urlretrieve(TS_URL,archive)
        with zipfile.ZipFile(archive) as z:
            for name in z.namelist():
                filename=Path(name).name
                if filename.endswith('.dll'): target=pg/'lib'/filename
                elif filename.endswith(('.sql','.control')): target=pg/'share/extension'/filename
                else: continue
                target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(z.read(name))
    admin_password=(ROOT/'.secrets/db_admin_password').read_text().strip()
    if not (data/'PG_VERSION').exists():
        temp=native/'bootstrap-password.tmp'
        temp.write_text(admin_password+'\n'); temp.chmod(0o600)
        try:
            run([pg/'bin/initdb.exe','-D',data,'-U','iot_admin','--pwfile',temp,
                 '--auth-host=scram-sha-256','--auth-local=scram-sha-256','--encoding=UTF8','--locale=C'])
        finally: temp.unlink(missing_ok=True)
        with (data/'postgresql.conf').open('a') as conf:
            conf.write(f"\nlisten_addresses='127.0.0.1'\nport={args.port}\nshared_preload_libraries='timescaledb'\n"
                       "password_encryption='scram-sha-256'\nshared_buffers='128MB'\nmax_connections=30\n"
                       "timescaledb.max_background_workers=4\nmax_worker_processes=8\ntimescaledb.telemetry_level='off'\ntimezone='UTC'\n")
    # A PID file survives a crash or an interrupted Windows session. Ask pg_ctl
    # whether its server actually exists rather than treating the file as health.
    status=subprocess.run([str(pg/'bin/pg_ctl.exe'),'-D',str(data),'status'],
                          creationflags=CREATE_NO_WINDOW,capture_output=True)
    if status.returncode != 0:
        run([pg/'bin/pg_ctl.exe','-D',data,'-l',native/'postgres.log','start','-w','-t','30'])
    config=dict(host='127.0.0.1',port=args.port,dbname='postgres',user='iot_admin',password=admin_password,autocommit=True,connect_timeout=5)
    with psycopg.connect(**config) as health:
        health.execute('SELECT 1')
    marker=native/'schema-ready.json'
    if not marker.exists():
        with psycopg.connect(**config) as db:
            for role,secret in [('iot_app','db_app_password'),('iot_ingest','db_ingest_password')]:
                exists=db.execute('SELECT 1 FROM pg_roles WHERE rolname=%s',(role,)).fetchone()
                if not exists:
                    db.execute(sql.SQL('CREATE ROLE {} LOGIN PASSWORD {}').format(sql.Identifier(role),sql.Literal((ROOT/'.secrets'/secret).read_text().strip())))
            if not db.execute("SELECT 1 FROM pg_database WHERE datname='iot'").fetchone(): db.execute('CREATE DATABASE iot')
            db.execute('REVOKE ALL ON DATABASE iot FROM PUBLIC')
            db.execute('GRANT CONNECT ON DATABASE iot TO iot_app,iot_ingest')
        config['dbname']='iot'
        with psycopg.connect(**config) as db:
            existing=db.execute("SELECT 1 FROM pg_namespace WHERE nspname='iot'").fetchone()
            if existing:
                raise SystemExit('Partial schema exists. Inspect the database and complete remaining SQL scripts; do not reset existing data.')
            db.execute('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
            for name in ('001_schema.sql','002_timescale.sql','003_seed.sql','004_grants.sql'):
                print('Applying',name,flush=True)
                db.execute((ROOT/'database/init'/name).read_text(encoding='utf-8'),prepare=False)
            version=db.execute("SELECT extversion FROM pg_extension WHERE extname='timescaledb'").fetchone()[0]
        marker.write_text(json.dumps({'schema':1,'timescaledb':version,'port':args.port},indent=2))
    details={'runtime_path':str(native),'data_path':str(data),'host':'127.0.0.1','port':args.port,'postgresql':'17.11','timescaledb':'2.23.1'}
    (cache/'native-database.json').write_text(json.dumps(details,indent=2)+'\n')
    print(f'Private PostgreSQL + TimescaleDB ready on 127.0.0.1:{args.port}. Data: {data}')

if __name__=='__main__': main()
