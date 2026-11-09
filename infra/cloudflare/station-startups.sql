CREATE TABLE IF NOT EXISTS station_startups (
    id TEXT PRIMARY KEY,
    received_at INTEGER NOT NULL,
    chat_id TEXT,
    next_attempt_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    sent_at INTEGER,
    failed_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS station_startups_ready
    ON station_startups(chat_id, next_attempt_at, received_at)
    WHERE sent_at IS NULL AND failed_at IS NULL;
