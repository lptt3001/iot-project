const operators = new Set(["gt", "gte", "lt", "lte"]);
const metricRange = {
  temperature_c: [-40, 125],
  air_humidity_pct: [0, 100],
};

export class DashboardAlertError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function alertRow(row) {
  return {
    id: row.id,
    device_id: "station-001",
    rule_id: row.rule_id,
    title: row.title,
    severity: "warning",
    message: row.message,
    kind: row.kind ?? 'environment',
    details: row.details ? JSON.parse(row.details) : null,
    triggered_at: row.triggered_at,
    acknowledged_at: row.acknowledged_at,
  };
}

export async function alertSummary(db) {
  const [counts, recent] = await db.batch([
    db.prepare(`SELECT
      (SELECT count(*) FROM (SELECT triggered_at FROM garden_alerts
        WHERE acknowledged_at IS NULL ORDER BY triggered_at DESC LIMIT 101)) AS open_alerts,
      (SELECT count(*) FROM (SELECT triggered_at FROM garden_alerts
        WHERE read_at IS NULL ORDER BY triggered_at DESC LIMIT 100)) AS unread`),
    db.prepare("SELECT * FROM garden_alerts ORDER BY triggered_at DESC, id DESC LIMIT 5"),
  ]);
  const { open_alerts, unread } = counts.results[0];
  return {
    open_alerts: Math.min(100, open_alerts),
    open_alerts_truncated: open_alerts > 100,
    unread,
    alerts: recent.results.map(alertRow),
  };
}

export async function dashboardAlerts(db, params) {
  const filters = { all: "1", open: "acknowledged_at IS NULL", ack: "acknowledged_at IS NOT NULL" };
  const state = params.get("state") ?? "all";
  const limit = Number(params.get("limit") ?? "30");
  const offset = Number(params.get("offset") ?? "0");
  if (!Object.hasOwn(filters, state) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(offset) || offset < 0) {
    throw new DashboardAlertError(422, "Tham số lọc cảnh báo không hợp lệ.");
  }
  const filter = filters[state];
  const [rows, count] = await db.batch([
    db.prepare(`SELECT * FROM garden_alerts WHERE ${filter}
      ORDER BY triggered_at DESC, id DESC LIMIT ? OFFSET ?`).bind(limit, offset),
    db.prepare(`SELECT count(*) AS total FROM garden_alerts WHERE ${filter}`),
  ]);
  return { rows: rows.results.map(alertRow), total: count.results[0].total };
}

export async function acknowledgeAlert(db, id) {
  const now = Date.now();
  const rows = await db.batch(['cloud_alerts','plant_health_alerts'].map(table=>db.prepare(`UPDATE ${table}
    SET acknowledged_at = coalesce(acknowledged_at, ?), read_at = coalesce(read_at, ?)
    WHERE id = ? RETURNING id`).bind(now, now, id)));
  if (!rows.some(row=>row.results.length)) throw new DashboardAlertError(404, "Không tìm thấy cảnh báo.");
  return { ok: true };
}

export async function dashboardNotifications(db) {
  const result = await db.prepare(`SELECT id, id AS alert_id, triggered_at AS created_at, read_at,
      message, 'warning' AS severity FROM garden_alerts ORDER BY triggered_at DESC, id DESC LIMIT 100`).all();
  return result.results;
}

export async function markNotificationsRead(db) {
  const now=Date.now();
  await db.batch(['cloud_alerts','plant_health_alerts'].map(table=>db.prepare(`UPDATE ${table} SET read_at=? WHERE read_at IS NULL`).bind(now)));
  return { ok: true };
}

export async function dashboardRules(db) {
  const result = await db.prepare("SELECT * FROM cloud_alert_rules ORDER BY metric, name").all();
  return result.results.map(rule => ({ ...rule, enabled: Boolean(rule.enabled) }));
}

export async function updateDashboardRule(db, id, body) {
  const fields = ["name", "metric", "operator", "threshold", "window_minutes", "cooldown_minutes", "enabled"];
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== fields.length || !fields.every(key => Object.hasOwn(body, key))) {
    throw new DashboardAlertError(422, "Dữ liệu thiết lập ngưỡng không hợp lệ.");
  }
  const { name, metric, operator, threshold, window_minutes, cooldown_minutes, enabled } = body;
  if (typeof name !== "string" || !name.trim() || name.length > 100 || !operators.has(operator) ||
      typeof metric !== "string" || !Object.hasOwn(metricRange, metric) || !Number.isFinite(threshold) ||
      !Number.isInteger(window_minutes) || window_minutes < 1 || window_minutes > 15 ||
      !Number.isInteger(cooldown_minutes) || cooldown_minutes < 1 || cooldown_minutes > 1440 ||
      typeof enabled !== "boolean") {
    throw new DashboardAlertError(422, "Dữ liệu thiết lập ngưỡng không hợp lệ.");
  }
  const [min, max] = metricRange[metric];
  if (threshold < min || threshold > max) {
    throw new DashboardAlertError(422, "Ngưỡng nằm ngoài khoảng đo của cảm biến.");
  }
  const row = await db.prepare(`UPDATE cloud_alert_rules
    SET name = ?, operator = ?, threshold = ?, window_minutes = ?, cooldown_minutes = ?, enabled = ?
    WHERE id = ? AND metric = ? RETURNING id`)
    .bind(name.trim(), operator, threshold, window_minutes, cooldown_minutes, Number(enabled), id, metric).first();
  if (!row) throw new DashboardAlertError(404, "Không tìm thấy luật cảnh báo phù hợp.");
  return { ok: true };
}
