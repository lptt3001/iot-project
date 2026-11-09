CREATE TABLE IF NOT EXISTS telegram_connection (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  chat_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  connected_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS telegram_pairing (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  request_id TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL,
  bot_username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  poll_after INTEGER NOT NULL DEFAULT 0,
  candidate_chat_id TEXT,
  candidate_name TEXT,
  matched_at INTEGER,
  consumed_at INTEGER,
  cancelled_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS telegram_update_cursor (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  next_offset INTEGER NOT NULL
) STRICT;
