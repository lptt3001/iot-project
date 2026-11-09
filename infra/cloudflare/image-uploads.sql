ALTER TABLE images ADD COLUMN source TEXT NOT NULL DEFAULT 'hardware'
  CHECK (source IN ('hardware', 'upload'));
