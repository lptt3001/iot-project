CREATE TABLE IF NOT EXISTS led_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  desired_on INTEGER NOT NULL DEFAULT 0 CHECK (desired_on IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 2147483647),
  applied_on INTEGER CHECK (applied_on IN (0, 1)),
  applied_revision INTEGER,
  updated_at INTEGER,
  confirmed_at INTEGER
);
INSERT OR IGNORE INTO led_control (id) VALUES (1);
