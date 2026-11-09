const REQUEST_TTL_MS = 90_000;
const PRESENCE_TTL_MS = 45_000;
const PRESENCE_WRITE_INTERVAL_MS = 20_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEVICE_ERRORS = new Set(["rain", "camera", "upload"]);
const ERROR_MESSAGES = {
  offline: "Camera chưa nhận được lệnh. Kiểm tra nguồn, Wi-Fi và firmware hỗ trợ chụp từ web.",
  timeout: "Camera đã nhận lệnh nhưng chưa gửi ảnh trong thời gian chờ.",
  rain: "Camera tạm dừng chụp vì cảm biến đang báo mưa.",
  camera: "ESP32-CAM không chụp được ảnh. Kiểm tra camera trên mạch.",
  upload: "ESP32-CAM chưa gửi được ảnh lên hệ thống. Hãy thử lại.",
};

export class CameraRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function expireOpenRequests(db, now) {
  return db.prepare(`UPDATE camera_requests SET status = 'failed',
    error_code = CASE WHEN status = 'queued' THEN 'offline' ELSE 'timeout' END
    WHERE status IN ('queued', 'sent') AND expires_at <= ?`).bind(now);
}

function cameraRequestById(db, id) {
  return db.prepare("SELECT id, status, expires_at, error_code FROM camera_requests WHERE id = ?").bind(id);
}

export async function createCameraRequest(db, id = crypto.randomUUID(), requestedBy = null) {
  const now = Date.now();
  const presenceCutoff = now - PRESENCE_TTL_MS;
  const [, , requested, camera] = await db.batch([
    expireOpenRequests(db, now),
    db.prepare(`INSERT INTO camera_requests (id, created_at, expires_at, status, requested_by)
      SELECT ?1, ?2, ?3, 'queued', ?5 WHERE EXISTS (
        SELECT 1 FROM camera_poll_presence WHERE id = 1 AND polled_at > ?4
      )
      AND NOT EXISTS (SELECT 1 FROM images WHERE image_id = ?1)
      ON CONFLICT DO NOTHING`)
      .bind(id, now, now + REQUEST_TTL_MS, presenceCutoff, requestedBy),
    cameraRequestById(db, id),
    db.prepare(`SELECT
      EXISTS (SELECT 1 FROM camera_poll_presence WHERE id = 1 AND polled_at > ?) AS present,
      EXISTS (SELECT 1 FROM images WHERE image_id = ?) AS image_exists`).bind(presenceCutoff, id),
  ]);
  if (requested.results[0]) return formatCameraRequest(requested.results[0], now);
  const { present, image_exists } = camera.results[0];
  if (image_exists) {
    throw new CameraRequestError(409, "Mã yêu cầu chụp đã được sử dụng. Hãy gửi yêu cầu mới.");
  }
  if (!present) {
    throw new CameraRequestError(409,
      "Camera chưa kết nối để nhận lệnh. Kiểm tra nguồn, Wi-Fi và firmware hỗ trợ chụp từ web.");
  }
  throw new CameraRequestError(409, "Trạm đang xử lý một yêu cầu chụp.");
}

function formatCameraRequest(row, now) {
  let { status, error_code } = row;
  if ((status === "queued" || status === "sent") && row.expires_at <= now) {
    error_code = status === "queued" ? "offline" : "timeout";
    status = "failed";
  }
  return {
    id: row.id,
    status,
    expires_at: row.expires_at,
    image_id: status === "succeeded" ? row.id : null,
    error: error_code ? ERROR_MESSAGES[error_code] : null,
    error_code,
  };
}

export async function getCameraRequest(db, id) {
  const row = await cameraRequestById(db, id).first();
  if (!row) throw new CameraRequestError(404, "Không tìm thấy yêu cầu chụp.");
  return formatCameraRequest(row, Date.now());
}

export async function nextCameraRequest(db) {
  const now = Date.now();
  const [, command] = await db.batch([
    db.prepare(`INSERT INTO camera_poll_presence (id, polled_at) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET polled_at = excluded.polled_at
      WHERE polled_at <= ?`).bind(now, now - PRESENCE_WRITE_INTERVAL_MS),
    db.prepare(`UPDATE camera_requests SET status = 'sent'
      WHERE status IN ('queued', 'sent') AND expires_at > ? RETURNING id`).bind(now),
  ]);
  return command.results[0] ?? null;
}

export async function failCameraRequest(db, id, body) {
  const error = body?.error;
  if (!DEVICE_ERRORS.has(error)) throw new CameraRequestError(422, "Mã lỗi camera không hợp lệ.");
  const [, request] = await db.batch([
    db.prepare(`UPDATE camera_requests SET status = 'failed', error_code = ?
      WHERE id = ? AND status = 'sent' AND expires_at > ?`).bind(error, id, Date.now()),
    db.prepare("SELECT 1 FROM camera_requests WHERE id = ?").bind(id),
  ]);
  if (!request.results.length) throw new CameraRequestError(404, "Không tìm thấy yêu cầu chụp.");
  return { ok: true };
}

export async function pruneCameraRequests(db, now = Date.now()) {
  await db.batch([
    expireOpenRequests(db, now),
    db.prepare(`DELETE FROM camera_requests WHERE id IN (
      SELECT id FROM camera_requests WHERE created_at < ? ORDER BY created_at LIMIT 512
    )`).bind(now - RETENTION_MS),
  ]);
}
