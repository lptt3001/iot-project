CREATE TABLE IF NOT EXISTS cloud_alert_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    metric TEXT NOT NULL UNIQUE CHECK (metric IN ('temperature_c', 'air_humidity_pct')),
    operator TEXT NOT NULL CHECK (operator IN ('gt', 'gte', 'lt', 'lte')),
    threshold REAL NOT NULL CHECK (threshold BETWEEN -40 AND 125),
    window_minutes INTEGER NOT NULL CHECK (window_minutes BETWEEN 1 AND 15),
    cooldown_minutes INTEGER NOT NULL CHECK (cooldown_minutes BETWEEN 1 AND 1440),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
) STRICT;

INSERT INTO cloud_alert_rules (id, name, metric, operator, threshold, window_minutes, cooldown_minutes, enabled)
VALUES ('temperature', 'Nhiệt độ cao', 'temperature_c', 'gte', 35, 1, 5, 1),
       ('humidity', 'Độ ẩm không khí cao', 'air_humidity_pct', 'gte', 85, 1, 5, 1)
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS cloud_alerts (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL REFERENCES cloud_alert_rules(id),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    triggered_at INTEGER NOT NULL,
    acknowledged_at INTEGER,
    read_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS cloud_alerts_time ON cloud_alerts(triggered_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS cloud_alerts_rule_time ON cloud_alerts(rule_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS cloud_alerts_open ON cloud_alerts(triggered_at DESC) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS cloud_alerts_unread ON cloud_alerts(triggered_at DESC) WHERE read_at IS NULL;

-- The new measurement and its alerts commit together. Duplicate telemetry never fires this trigger.
CREATE TRIGGER IF NOT EXISTS cloud_alert_on_telemetry
AFTER INSERT ON telemetry
WHEN NEW.observed_at BETWEEN NEW.received_at - 120000 AND NEW.received_at
BEGIN
    INSERT INTO cloud_alerts (id, rule_id, title, message, triggered_at)
    WITH eligible AS MATERIALIZED (
        SELECT rule.*
        FROM cloud_alert_rules AS rule
        WHERE rule.enabled = 1 AND NOT EXISTS (
            SELECT 1 FROM cloud_alerts AS alert
            WHERE alert.rule_id = rule.id
              AND alert.triggered_at > NEW.received_at - rule.cooldown_minutes * 60000
        )
    ), evaluated AS MATERIALIZED (
        SELECT eligible.*, (
            SELECT avg(json_extract(sample.measurements, '$.' || eligible.metric))
            FROM telemetry AS sample
            WHERE sample.observed_at BETWEEN NEW.received_at - eligible.window_minutes * 60000 AND NEW.received_at
        ) AS mean
        FROM eligible
    )
    SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2)
                 || '-8' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
           id, name,
           printf('Trạm station-001 đo trung bình %.1f %s. Ngưỡng %.15g %s.', mean,
                  CASE metric WHEN 'temperature_c' THEN '°C' ELSE '%' END, threshold,
                  CASE metric WHEN 'temperature_c' THEN '°C' ELSE '%' END),
           NEW.received_at
    FROM evaluated
    WHERE CASE operator
        WHEN 'gt' THEN mean > threshold
        WHEN 'gte' THEN mean >= threshold
        WHEN 'lt' THEN mean < threshold
        WHEN 'lte' THEN mean <= threshold
    END;
END;
