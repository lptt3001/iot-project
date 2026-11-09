export class LedControlError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function ledStatus(db) {
  const row = await db.prepare('SELECT * FROM led_control WHERE id = 1').first();
  const online = row.confirmed_at !== null && row.confirmed_at > Date.now() - 45_000;
  return {
    pin: 12, desired_on: Boolean(row.desired_on), revision: row.revision,
    applied_on: row.applied_on === null ? null : Boolean(row.applied_on),
    confirmed_at: row.confirmed_at, online,
    pending: row.revision !== row.applied_revision || row.desired_on !== row.applied_on,
  };
}

export async function setLed(db, body) {
  if (!body || typeof body.on !== 'boolean' || !Number.isInteger(body.revision) ||
      body.revision < 0 || body.revision >= 2147483647) {
    throw new LedControlError(422, 'Lệnh đèn không hợp lệ.');
  }
  const result = await db.prepare(`UPDATE led_control SET desired_on = ?,
    revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ? RETURNING revision`)
    .bind(Number(body.on), Date.now(), body.revision).all();
  if (!result.results.length) {
    throw new LedControlError(409, 'Trạng thái đèn đã thay đổi. Hãy kiểm tra lại rồi chọn bật hoặc tắt.');
  }
  return ledStatus(db);
}

// Numeric on/off and stable field order keep the firmware response small and easy to validate.
export async function ledCommand(db) {
  const row = await db.prepare('SELECT revision, desired_on FROM led_control WHERE id = 1').first();
  return { revision: row.revision, on: row.desired_on };
}

export async function confirmLed(db, body) {
  if (!body || !Number.isInteger(body.revision) || body.revision < 0 || body.revision > 2147483647 ||
      (body.on !== 0 && body.on !== 1)) {
    throw new LedControlError(422, 'Xác nhận đèn không hợp lệ.');
  }
  const now = Date.now();
  const result = await db.prepare(`UPDATE led_control SET applied_on = ?, applied_revision = ?, confirmed_at = ?
    WHERE id = 1 AND revision = ? AND desired_on = ? RETURNING id`)
    .bind(body.on, body.revision, now, body.revision, body.on).all();
  if (!result.results.length) throw new LedControlError(409, 'Lệnh đèn đã thay đổi.');
  return { ok: true };
}
