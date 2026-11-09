-- Existing databases only: check PRAGMA table_info before applying each ALTER.
ALTER TABLE images ADD COLUMN capture_origin TEXT NOT NULL DEFAULT 'unknown'
    CHECK (capture_origin IN ('automatic','manual','upload','unknown'));
ALTER TABLE images ADD COLUMN actor_username TEXT;
ALTER TABLE camera_requests ADD COLUMN requested_by TEXT;

-- Older rows never recorded an account; do not invent a photographer.
UPDATE images SET capture_origin = 'upload' WHERE source = 'upload' AND capture_origin = 'unknown';
UPDATE images SET capture_origin = 'manual'
WHERE source = 'hardware' AND capture_origin = 'unknown'
    AND EXISTS (SELECT 1 FROM camera_requests WHERE id = images.image_id);
