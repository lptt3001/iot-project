CREATE TABLE IF NOT EXISTS camera_requests (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'succeeded')),
    error_code TEXT CHECK (error_code IN ('offline', 'timeout', 'rain', 'camera', 'upload')),
    requested_by TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS camera_requests_one_open
    ON camera_requests ((1)) WHERE status IN ('queued', 'sent');
CREATE INDEX IF NOT EXISTS camera_requests_created ON camera_requests (created_at);

CREATE TABLE IF NOT EXISTS camera_poll_presence (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    polled_at INTEGER NOT NULL
) STRICT;

-- An image and the successful command it completes commit in the same transaction.
CREATE TRIGGER IF NOT EXISTS camera_request_on_image
AFTER INSERT ON images
BEGIN
    UPDATE camera_requests
    SET status = 'succeeded'
    WHERE id = NEW.image_id AND status = 'sent' AND expires_at > NEW.received_at;
END;
