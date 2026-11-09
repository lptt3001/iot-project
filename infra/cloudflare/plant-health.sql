CREATE TABLE IF NOT EXISTS plant_health_alerts (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('climate','pest')),
  disease_id TEXT,
  stage TEXT,
  image_id TEXT REFERENCES images(image_id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  details TEXT NOT NULL CHECK(json_valid(details)),
  triggered_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  read_at INTEGER,
  chat_id TEXT,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  sent_at INTEGER,
  failed_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS plant_health_alerts_time ON plant_health_alerts(triggered_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS plant_health_alerts_cooldown ON plant_health_alerts(disease_id,stage,triggered_at DESC);
CREATE INDEX IF NOT EXISTS plant_health_alerts_ready ON plant_health_alerts(next_attempt_at)
  WHERE kind='climate' AND sent_at IS NULL AND failed_at IS NULL AND chat_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS plant_health_status (
  id INTEGER PRIMARY KEY CHECK(id=1),
  evaluated_at INTEGER NOT NULL,
  report TEXT NOT NULL CHECK(json_valid(report))
) STRICT;

CREATE VIEW IF NOT EXISTS garden_alerts AS
  SELECT id,rule_id,title,message,triggered_at,acknowledged_at,read_at,'environment' AS kind,NULL AS details
    FROM cloud_alerts
  UNION ALL
  SELECT id,coalesce(disease_id,'pest') AS rule_id,title,message,triggered_at,acknowledged_at,read_at,kind,details
    FROM plant_health_alerts;
