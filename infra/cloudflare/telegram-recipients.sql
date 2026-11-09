CREATE TABLE IF NOT EXISTS telegram_recipients (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL UNIQUE,
  owner_username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_state IN ('pending','ready','blocked','error')),
  last_sent_at INTEGER,
  last_error_code INTEGER,
  last_error_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS telegram_recipients_owner ON telegram_recipients(owner_username,connected_at DESC);
INSERT INTO telegram_recipients(id,chat_id,owner_username,display_name,connected_at,updated_at)
  SELECT lower(hex(randomblob(16))),chat_id,'garden',display_name,connected_at,connected_at FROM telegram_connection
  WHERE id=1 ON CONFLICT(chat_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS telegram_pairings (
  request_id TEXT PRIMARY KEY,
  owner_username TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  bot_username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  candidate_chat_id TEXT,
  candidate_name TEXT,
  matched_at INTEGER,
  consumed_at INTEGER,
  cancelled_at INTEGER
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS telegram_pairings_one_open ON telegram_pairings(owner_username)
  WHERE consumed_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS telegram_pairings_owner ON telegram_pairings(owner_username,created_at DESC);
CREATE TABLE IF NOT EXISTS telegram_poll_lock(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS telegram_bot_identity(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,verified_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS telegram_deliveries (
  event_key TEXT NOT NULL,
  recipient_id TEXT NOT NULL REFERENCES telegram_recipients(id),
  kind TEXT NOT NULL CHECK(kind IN ('environment','health','startup','connection','test')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  sent_at INTEGER,
  failed_at INTEGER,
  error_code INTEGER,
  message_id INTEGER,
  bot_username TEXT,
  PRIMARY KEY(event_key,recipient_id)
) STRICT;
CREATE INDEX IF NOT EXISTS telegram_deliveries_ready ON telegram_deliveries(next_attempt_at,created_at)
  WHERE sent_at IS NULL AND failed_at IS NULL;

-- Preserve old outcomes. Migration never replays alerts already sent or terminally failed.
INSERT INTO telegram_deliveries(event_key,recipient_id,kind,text,created_at,next_attempt_at,attempts,sent_at,failed_at)
  SELECT 'env:'||o.alert_id,r.id,'environment',a.title||char(10)||a.message,o.created_at,o.next_attempt_at,o.attempts,o.sent_at,o.failed_at
  FROM telegram_alert_outbox o JOIN cloud_alerts a ON a.id=o.alert_id JOIN telegram_recipients r ON r.chat_id=o.chat_id
  WHERE 1 ON CONFLICT DO NOTHING;
INSERT INTO telegram_deliveries(event_key,recipient_id,kind,text,created_at,next_attempt_at,attempts,sent_at,failed_at)
  SELECT 'health:'||a.id,r.id,'health',a.title||char(10)||a.message,a.triggered_at,a.next_attempt_at,a.attempts,a.sent_at,a.failed_at
  FROM plant_health_alerts a JOIN telegram_recipients r ON r.chat_id=a.chat_id WHERE a.kind='climate'
  ON CONFLICT DO NOTHING;
INSERT INTO telegram_deliveries(event_key,recipient_id,kind,text,created_at,next_attempt_at,attempts,sent_at,failed_at)
  SELECT 'health:'||a.id,r.id,'health',o.text,o.created_at,o.next_attempt_at,o.attempts,o.sent_at,o.failed_at
  FROM pest_notifications o JOIN plant_health_alerts a ON a.image_id=o.image_id AND a.kind='pest'
  JOIN telegram_recipients r ON r.chat_id=o.chat_id WHERE 1 ON CONFLICT DO NOTHING;
INSERT INTO telegram_deliveries(event_key,recipient_id,kind,text,created_at,next_attempt_at,attempts,sent_at,failed_at)
  SELECT 'startup:'||o.id,r.id,'startup','Trạm station-001 đã khởi động và kết nối Cloudflare.',o.received_at,o.next_attempt_at,o.attempts,o.sent_at,o.failed_at
  FROM station_startups o JOIN telegram_recipients r ON r.chat_id=o.chat_id WHERE 1 ON CONFLICT DO NOTHING;
