export function cameraImageInsert(db, id, receivedAt, jpeg) {
  // Snapshot attribution before camera request retention can remove its record.
  return db.prepare(`INSERT INTO images
    (image_id, received_at, jpeg, capture_origin, actor_username)
    VALUES (?1, ?2, ?3,
      CASE WHEN EXISTS (SELECT 1 FROM camera_requests WHERE id = ?1)
          AND NOT EXISTS (SELECT 1 FROM daily_captures WHERE request_id = ?1)
        THEN 'manual' ELSE 'automatic' END,
      (SELECT requested_by FROM camera_requests WHERE id = ?1))
    ON CONFLICT(image_id) DO NOTHING`).bind(id, receivedAt, jpeg);
}

export function uploadedImageInsert(db, id, receivedAt, jpeg, username) {
  return db.prepare(`INSERT INTO images
    (image_id, received_at, jpeg, source, capture_origin, actor_username)
    VALUES (?, ?, ?, 'upload', 'upload', ?)`).bind(id, receivedAt, jpeg, username);
}

export async function setImageTrashed(db, id, trashed) {
  const row = await db.prepare(trashed
    ? "UPDATE images SET deleted_at = coalesce(deleted_at, ?) WHERE image_id = ? RETURNING image_id"
    : "UPDATE images SET deleted_at = NULL WHERE image_id = ? RETURNING image_id")
    .bind(...(trashed ? [Date.now(), id] : [id])).first();
  return row ? {id: row.image_id, trashed} : null;
}
