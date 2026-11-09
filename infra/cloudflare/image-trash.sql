ALTER TABLE images ADD COLUMN deleted_at INTEGER;
CREATE INDEX IF NOT EXISTS images_active_received ON images(received_at DESC, image_id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS images_trash_deleted ON images(deleted_at DESC, image_id DESC) WHERE deleted_at IS NOT NULL;
