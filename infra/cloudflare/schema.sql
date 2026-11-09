CREATE TABLE IF NOT EXISTS telemetry (
  message_id TEXT PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  measurements TEXT NOT NULL CHECK (json_valid(measurements)),
  battery_v REAL,
  rssi_dbm INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS telemetry_observed
  ON telemetry(observed_at DESC, received_at DESC);

CREATE TABLE IF NOT EXISTS images (
  image_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  jpeg BLOB NOT NULL CHECK (length(jpeg) BETWEEN 4 AND 524288),
  source TEXT NOT NULL DEFAULT 'hardware' CHECK (source IN ('hardware', 'upload')),
  deleted_at INTEGER,
  capture_origin TEXT NOT NULL DEFAULT 'unknown' CHECK (capture_origin IN ('automatic','manual','upload','unknown')),
  actor_username TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS images_received
  ON images(received_at DESC, image_id DESC);
CREATE INDEX IF NOT EXISTS images_active_received ON images(received_at DESC, image_id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS images_trash_deleted ON images(deleted_at DESC, image_id DESC) WHERE deleted_at IS NOT NULL;
