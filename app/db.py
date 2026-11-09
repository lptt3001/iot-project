from __future__ import annotations

import os
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[1]
FARM = 'farm-demo'


def connect(admin=False):
    role = 'admin' if admin else 'app'
    return psycopg.connect(
        host=os.getenv('DB_HOST', '127.0.0.1'), port=int(os.getenv('DB_PORT', '5432')),
        dbname=os.getenv('DB_NAME', 'iot'), user=f'iot_{role}',
        password=(ROOT / f'.secrets/db_{role}_password').read_text().strip(),
        row_factory=dict_row, connect_timeout=5,
        options='-c timezone=UTC -c statement_timeout=15000',
    )


def migrate():
    with connect(admin=True) as db:
        db.execute('SELECT pg_advisory_xact_lock(7261026)')
        db.execute('CREATE TABLE IF NOT EXISTS iot.app_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())')
        for path in sorted((ROOT / 'database/migrations').glob('*.sql')):
            if not db.execute('SELECT 1 FROM iot.app_migrations WHERE name=%s', (path.name,)).fetchone():
                db.execute(path.read_text(encoding='utf-8'), prepare=False)
                db.execute('INSERT INTO iot.app_migrations(name) VALUES (%s)', (path.name,))


def config():
    with connect() as db:
        return db.execute('SELECT value FROM iot.app_settings WHERE key=%s', ('simulation',)).fetchone()['value']
