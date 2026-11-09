CREATE TABLE IF NOT EXISTS dashboard_accounts (
  username TEXT PRIMARY KEY,
  password_verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  approved_at INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS dashboard_accounts_pending
  ON dashboard_accounts (created_at, username) WHERE approved_at IS NULL;

CREATE TABLE IF NOT EXISTS dashboard_member_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  username TEXT NOT NULL REFERENCES dashboard_accounts (username) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS dashboard_member_sessions_expiry ON dashboard_member_sessions (expires_at);
CREATE INDEX IF NOT EXISTS dashboard_member_sessions_username ON dashboard_member_sessions (username);
