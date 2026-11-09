CREATE TABLE IF NOT EXISTS dashboard_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS dashboard_sessions_expiry ON dashboard_sessions (expires_at);

CREATE TABLE IF NOT EXISTS dashboard_login_attempts (
  client_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS dashboard_login_attempts_expiry ON dashboard_login_attempts (expires_at);
