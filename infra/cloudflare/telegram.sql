CREATE TABLE IF NOT EXISTS telegram_alert_outbox (
    alert_id TEXT NOT NULL REFERENCES cloud_alerts(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    sent_at INTEGER,
    failed_at INTEGER,
    PRIMARY KEY (alert_id, chat_id)
) STRICT;

CREATE INDEX IF NOT EXISTS telegram_alert_outbox_ready
    ON telegram_alert_outbox(chat_id, next_attempt_at, created_at)
    WHERE sent_at IS NULL AND failed_at IS NULL;

CREATE INDEX IF NOT EXISTS telegram_alert_outbox_created
    ON telegram_alert_outbox(created_at);
