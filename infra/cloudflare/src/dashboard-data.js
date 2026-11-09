const STATION = "station-001";
const MINUTE_MS = 60000;
const RECENT_READING_LIMIT = 100;

export class DashboardQueryError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function integerParam(params, name, fallback, min, max) {
  const input = params.get(name);
  if (input === null) return fallback;
  const value = Number(input);
  if (!/^\d+$/.test(input) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new DashboardQueryError(`Giá trị ${name} không hợp lệ.`);
  }
  return value;
}

function includesStation(params) {
  const device = params.get("device");
  const source = params.get("source");
  if (source && !["all", "hardware", "simulation"].includes(source)) {
    throw new DashboardQueryError("Nguồn số đo không hợp lệ.");
  }
  return (!device || device === STATION) && source !== "simulation";
}

function timestamp(value) {
  return value == null ? null : new Date(value).toISOString();
}

function measurements(reading) {
  const fields = reading ? JSON.parse(reading.measurements) : {};
  return {
    temperature_c: fields.temperature_c ?? null,
    air_humidity_pct: fields.air_humidity_pct ?? null,
    soil_moisture_pct: fields.soil_moisture_pct ?? null,
    soil_raw: fields.soil_raw ?? null,
    light_do: fields.light_do ?? null,
    rain_do: fields.rain_do ?? null,
    battery_v: reading?.battery_v ?? null,
    rssi_dbm: reading?.rssi_dbm ?? null,
  };
}

export async function dashboardData(db, alerts = {}) {
  const now = Date.now();
  const [reading, totals, alertSummary] = await Promise.all([
    db.prepare(`SELECT observed_at, received_at, measurements, battery_v, rssi_dbm
      FROM telemetry ORDER BY observed_at DESC, received_at DESC LIMIT 1`).first(),
    db.prepare(`SELECT
      (SELECT count(*) FROM (SELECT 1 FROM telemetry ORDER BY observed_at DESC LIMIT ?)) AS readings,
      (SELECT count(*) FROM images WHERE deleted_at IS NULL) AS images`).bind(RECENT_READING_LIMIT + 1).first(),
    alerts,
  ]);

  return {
    farm: { id: "farm-demo", name: "Vườn thử nghiệm PTIT" },
    devices: [{
      id: STATION,
      name: "Trạm 01",
      hardware_model: "ESP32-CAM",
      enabled: true,
      latitude: null,
      longitude: null,
      source: "hardware",
      observed_at: timestamp(reading?.observed_at),
      last_seen_at: timestamp(reading?.received_at),
      online: !!reading && reading.received_at >= now - 45000,
      ...measurements(reading),
    }],
    totals: {
      readings: Math.min(totals.readings, RECENT_READING_LIMIT),
      readings_capped: totals.readings > RECENT_READING_LIMIT,
      images: totals.images,
      open_alerts: alertSummary.open_alerts ?? 0,
      open_alerts_truncated: alertSummary.open_alerts_truncated ?? false,
      unread: alertSummary.unread ?? 0,
    },
    alerts: alertSummary.alerts ?? [],
    simulation: { running: false, external_devices: [STATION] },
    system: { cloud: true, database: true },
    server_time: now / 1000,
  };
}

async function samplesInWindow(db, params, defaultHours) {
  const hours = integerParam(params, "hours", defaultHours, 1, 168);
  const bucketMinutes = hours <= 6 ? 1 : hours <= 48 ? 15 : 60;
  if (!includesStation(params)) return { samples: [], bucketMinutes };

  const now = Date.now();
  const start = now - hours * 60 * MINUTE_MS;
  const bucketMs = bucketMinutes * MINUTE_MS;
  const firstBucket = Math.floor(start / bucketMs) * bucketMs;
  const lastBucket = Math.floor(now / bucketMs) * bucketMs;
  // One indexed lookup per bucket keeps even seven-day charts suitable for frequent polling.
  const result = await db.prepare(`WITH RECURSIVE buckets(bucket_start) AS (
      VALUES (?1)
      UNION ALL SELECT bucket_start + ?2 FROM buckets WHERE bucket_start < ?3
    )
    SELECT sample.observed_at, sample.measurements, sample.battery_v, sample.rssi_dbm
    FROM buckets JOIN telemetry AS sample ON sample.message_id = (
      SELECT message_id FROM telemetry
      WHERE observed_at >= max(bucket_start, ?4)
        AND observed_at < min(bucket_start + ?2, ?5)
      ORDER BY observed_at DESC, received_at DESC LIMIT 1
    ) ORDER BY bucket_start`).bind(firstBucket, bucketMs, lastBucket, start, now + 1).all();
  return { samples: result.results, bucketMinutes };
}

export async function historyData(db, params) {
  const { samples, bucketMinutes } = await samplesInWindow(db, params, 1);
  return {
    bucket_minutes: bucketMinutes,
    rows: samples.map(sample => ({
      time: timestamp(sample.observed_at), device_id: STATION, samples: 1, ...measurements(sample),
    })),
  };
}

export async function imageData(db, params, id) {
  const offset = integerParam(params, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integerParam(params, "limit", 12, 1, 48);
  if (!includesStation(params)) return { rows: [], total: 0 };
  const trashed = params.get("trashed") ?? "0";
  if (!["0", "1"].includes(trashed)) throw new DashboardQueryError("Tham số thùng rác không hợp lệ.");
  const filter = trashed === "1" ? "deleted_at IS NOT NULL" : "deleted_at IS NULL";
  const order = trashed === "1" ? "deleted_at DESC, image_id DESC" : "received_at DESC, image_id DESC";

  const columns = `image_id, received_at, source, deleted_at, capture_origin, actor_username,
    (SELECT day FROM daily_captures WHERE request_id=images.image_id) AS scheduled_day,
    (SELECT status FROM image_analysis WHERE image_id=images.image_id) AS ai_status,
    (SELECT result FROM image_analysis WHERE image_id=images.image_id) AS ai_result,
    (SELECT error_message FROM image_analysis WHERE image_id=images.image_id) AS ai_error`;
  const [page, count] = id ? [await db.prepare(`SELECT ${columns} FROM images
    WHERE image_id = ? AND ${filter} LIMIT ? OFFSET ?`).bind(id, limit, offset).all(), null] : await Promise.all([
    db.prepare(`SELECT ${columns} FROM images WHERE ${filter}
      ORDER BY ${order} LIMIT ? OFFSET ?`).bind(limit, offset).all(),
    db.prepare(`SELECT count(*) AS total FROM images WHERE ${filter}`).first(),
  ]);
  return {
    total: count?.total ?? page.results.length,
    rows: page.results.map(row => ({
      id: row.image_id,
      device_id: STATION,
      captured_at: timestamp(row.received_at),
      source: row.source,
      capture_origin: row.capture_origin,
      actor_username: row.actor_username,
      scheduled_day: row.scheduled_day,
      deleted_at: timestamp(row.deleted_at),
      status: row.ai_status ?? "pending",
      detections: row.ai_result ? JSON.parse(row.ai_result).detections : [],
      pest_count: row.ai_result ? JSON.parse(row.ai_result).total_count : null,
      model_version: row.ai_result ? JSON.parse(row.ai_result).model_version : null,
      analysis: row.ai_result ? JSON.parse(row.ai_result) : null,
      error_message: row.ai_error,
    })),
  };
}

export async function csvData(db, params) {
  const { samples, bucketMinutes } = await samplesInWindow(db, params, 24);
  const rows = ["observed_at,device_id,temperature_c,air_humidity_pct,soil_moisture_pct,battery_v,rssi_dbm,soil_raw,light_do,rain_do,source,bucket_minutes"];
  for (const sample of samples.reverse()) {
    const fields = measurements(sample);
    rows.push([
      timestamp(sample.observed_at), STATION, fields.temperature_c, fields.air_humidity_pct,
      fields.soil_moisture_pct, fields.battery_v, fields.rssi_dbm, fields.soil_raw,
      fields.light_do, fields.rain_do, "hardware", bucketMinutes,
    ].join(","));
  }
  return new Response(`\uFEFF${rows.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ptit-garden-samples.csv"',
      "Cache-Control": "no-store",
    },
  });
}
