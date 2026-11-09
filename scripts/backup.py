"""Back up a consistent native DB snapshot, referenced camera images and pending MQTT inbox."""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import uuid
import zipfile

import psycopg
from psycopg import sql

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from app.db import connect
from app.imaging import MEDIA

TABLES=('app_users','farm_members','devices','sensor_readings','image_captures','inference_runs',
        'pest_detections','alert_rules','alerts','local_notifications','app_settings')


def native():
    info=json.loads((ROOT/'.runtime/native-database.json').read_text())
    return Path(info['runtime_path'])/'pgsql/bin',info


def command(executable,args):
    pg,info=native()
    env=os.environ.copy()
    env['PGPASSWORD']=(ROOT/'.secrets/db_admin_password').read_text().strip()
    result=subprocess.run([str(pg/f'{executable}.exe'),'-h',info['host'],'-p',str(info['port']),'-U','iot_admin',*args],
        env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',creationflags=0x08000000)
    if result.returncode:
        raise RuntimeError(result.stderr[-2500:])


def counts(db):
    return {name:db.execute(sql.SQL('SELECT count(*) AS n FROM iot.{}').format(sql.Identifier(name))).fetchone()['n'] for name in TABLES}


def backup():
    destination=ROOT/'output/backups'
    destination.mkdir(parents=True,exist_ok=True)
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    archive=destination/f'garden-{stamp}-{uuid.uuid4().hex[:6]}.zip'
    partial=archive.with_suffix('.zip.partial')
    with tempfile.TemporaryDirectory(prefix='garden-backup-') as temp:
        temp=Path(temp)
        dump=temp/'database.dump'
        with connect(admin=True) as db:
            db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            snapshot=db.execute('SELECT pg_export_snapshot() AS id').fetchone()['id']
            manifest={'format':1,'created_at_utc':stamp,'counts':counts(db),
                'postgresql':db.execute('SHOW server_version').fetchone()['server_version'],
                'timescaledb':db.execute("SELECT extversion FROM pg_extension WHERE extname='timescaledb'").fetchone()['extversion']}
            images=db.execute('SELECT object_key,sha256 FROM iot.image_captures').fetchall()
            command('pg_dump',['-d',os.getenv('DB_NAME','iot'),'-Fc','--snapshot='+snapshot,'-f',str(dump)])
        manifest['database_sha256']=hashlib.sha256(dump.read_bytes()).hexdigest()
        manifest['images']={r['object_key']:r['sha256'] for r in images}
        with zipfile.ZipFile(partial,'w',compression=zipfile.ZIP_DEFLATED) as z:
            z.write(dump,'database.dump')
            for row in images:
                image=MEDIA/row['object_key']
                if not image.is_file() or hashlib.sha256(image.read_bytes()).hexdigest()!=row['sha256']:
                    raise RuntimeError(f"Missing or corrupted image: {row['object_key']}")
                z.write(image,'media/'+row['object_key'])
            spool=ROOT/'.runtime/ingest.sqlite3'
            if spool.exists():
                with closing(sqlite3.connect(spool)) as source, closing(sqlite3.connect(temp/'ingest.sqlite3')) as target:
                    with target:
                        source.backup(target)
                z.write(temp/'ingest.sqlite3','ingest.sqlite3')
            z.writestr('manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2))
    partial.replace(archive)
    print(f'Backup saved: {archive}')
    return archive


def restore(archive,database):
    # Deliberately require a new named database: existing production data is never overwritten.
    if not re.fullmatch(r'iot_restore_[a-z0-9_]{1,40}',database):
        raise ValueError('Restore target must be a NEW database named iot_restore_<name>.')
    _,info=native()
    settings=dict(host=info['host'],port=info['port'],user='iot_admin',
        password=(ROOT/'.secrets/db_admin_password').read_text().strip(),dbname='postgres',autocommit=True)
    with psycopg.connect(**settings) as db:
        if db.execute('SELECT 1 FROM pg_database WHERE datname=%s',(database,)).fetchone():
            raise ValueError('Target database exists. Choose a new name; no existing data was changed.')
    with zipfile.ZipFile(archive) as z, tempfile.TemporaryDirectory(prefix='garden-restore-') as temp:
        manifest=json.loads(z.read('manifest.json'))
        data=z.read('database.dump')
        if hashlib.sha256(data).hexdigest()!=manifest['database_sha256']:
            raise ValueError('Backup checksum mismatch.')
        # Validate media before creating any database or writing recovered files.
        for name,digest in manifest['images'].items():
            if not re.fullmatch(r'[a-f0-9-]{36}\.png',name) or hashlib.sha256(z.read('media/'+name)).hexdigest()!=digest:
                raise ValueError('Invalid media entry or checksum mismatch.')
        dump=Path(temp)/'database.dump'
        dump.write_bytes(data)
        with psycopg.connect(**settings) as db:
            db.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(database)))
        settings['dbname']=database
        try:
            with psycopg.connect(**settings) as db:
                db.execute('CREATE EXTENSION IF NOT EXISTS timescaledb')
                db.execute('SELECT timescaledb_pre_restore()')
            command('pg_restore',['-d',database,'--exit-on-error',str(dump)])
        finally:
            with psycopg.connect(**settings) as db:
                db.execute('SELECT timescaledb_post_restore()')
        from psycopg.rows import dict_row
        with psycopg.connect(**settings,row_factory=dict_row) as db:
            actual=counts(db)
            if actual!=manifest['counts']:
                raise RuntimeError('Restored row counts do not match the consistent backup snapshot.')
        restored=ROOT/'.runtime/restored'/database
        (restored/'media').mkdir(parents=True,exist_ok=True)
        for name in manifest['images']:
            (restored/'media'/name).write_bytes(z.read('media/'+name))
        if 'ingest.sqlite3' in z.namelist():
            (restored/'ingest.sqlite3').write_bytes(z.read('ingest.sqlite3'))
    evidence={'database':database,'counts_match':True,'images_verified':len(manifest['images']),
              'checked_at_utc':datetime.now(timezone.utc).isoformat(),'archive':str(archive.resolve()),
              'media_path':str(restored/'media')}
    report=ROOT/'output/verification/restore-verification.json'
    report.parent.mkdir(parents=True,exist_ok=True)
    report.write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(evidence,ensure_ascii=False,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--restore',type=Path)
    parser.add_argument('--database')
    args=parser.parse_args()
    if args.restore:
        if not args.database:
            parser.error('--restore requires --database iot_restore_<new_name>')
        restore(args.restore,args.database)
    else:
        backup()
