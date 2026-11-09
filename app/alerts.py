"""Transactional demo thresholds, window averaging and per-device cooldown."""
from psycopg import sql

COMPARISONS = {'gt': lambda a,b: a>b, 'gte': lambda a,b: a>=b,
               'lt': lambda a,b: a<b, 'lte': lambda a,b: a<=b}
UNITS = {'temperature_c': '°C', 'air_humidity_pct': '%', 'soil_moisture_pct': '%', 'pest_count': 'đối tượng'}


def evaluate(db, farm, device, pest_count=None):
    # Locks span the insert + evaluation transaction so simultaneous workers cannot duplicate alerts.
    db.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', (f'{farm}/{device}/alerts',))
    rules = db.execute('SELECT * FROM iot.alert_rules WHERE farm_id=%s AND enabled', (farm,)).fetchall()
    created = []
    for rule in rules:
        metric = rule['metric']
        if metric == 'pest_count':
            if pest_count is None:
                continue
            value = pest_count
        else:
            if pest_count is not None:
                continue
            value = db.execute(sql.SQL('''SELECT avg({}) AS value FROM iot.sensor_readings
                WHERE farm_id=%s AND device_id=%s AND observed_at BETWEEN
                now() - %s * interval '1 minute' AND now()
                AND (source='hardware' OR NOT EXISTS (SELECT 1 FROM iot.app_settings
                    WHERE key='simulation' AND value->'external_devices' ? %s))''').format(sql.Identifier(metric)),
                (farm, device, rule['window_minutes'], device)).fetchone()['value']
        if value is None or not COMPARISONS[rule['operator']](value, rule['threshold']):
            continue
        recent = db.execute('''SELECT 1 FROM iot.alerts WHERE rule_id=%s AND device_id=%s
            AND triggered_at > now() - %s * interval '1 minute' LIMIT 1''',
            (rule['id'], device, rule['cooldown_minutes'])).fetchone()
        if recent:
            continue
        message = f"{rule['name']}: {value:.1f} {UNITS[metric]} tại {device}. Ngưỡng mô phỏng: {rule['threshold']:g}."
        row = db.execute('''INSERT INTO iot.alerts(farm_id,device_id,rule_id,severity,message)
            VALUES (%s,%s,%s,%s,%s) RETURNING id''',
            (farm, device, rule['id'], 'critical' if metric == 'pest_count' else 'warning', message)).fetchone()
        db.execute('INSERT INTO iot.local_notifications(alert_id) VALUES (%s)', (row['id'],))
        created.append(str(row['id']))
    return created
