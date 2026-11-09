-- Additive migration: preserves photos, accounts and existing environment alerts.
CREATE TABLE IF NOT EXISTS daily_captures (
  day TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS image_analysis (
  image_id TEXT PRIMARY KEY REFERENCES images(image_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  result TEXT CHECK(result IS NULL OR json_valid(result)),
  error_message TEXT,
  completed_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS image_analysis_ready ON image_analysis(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS automation_lock (
  id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS pest_notifications (
  image_id TEXT PRIMARY KEY REFERENCES images(image_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  text TEXT NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  sent_at INTEGER,
  failed_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS pest_notifications_ready ON pest_notifications(next_attempt_at)
  WHERE sent_at IS NULL AND failed_at IS NULL;

-- Only newly received hardware photos enter the automatic queue. No historical flood.
CREATE TRIGGER IF NOT EXISTS image_analysis_on_camera_image AFTER INSERT ON images
WHEN NEW.source='hardware'
BEGIN
  INSERT OR IGNORE INTO image_analysis(image_id,created_at,next_attempt_at)
    VALUES(NEW.image_id,NEW.received_at,NEW.received_at);
END;
