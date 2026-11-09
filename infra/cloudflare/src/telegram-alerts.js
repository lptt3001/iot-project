export const TELEGRAM_RETRY_CRON = "*/5 * * * *";

const MAX_ATTEMPTS = 5;
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 7 * RETRY_WINDOW_MS;
const LEASE_MS = 90_000;

export function telegramBotToken(env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  return /^\d{5,20}:[a-zA-Z0-9_-]{25,100}$/.test(token ?? "") ? token : null;
}

export function telegramSettings(env, chatOverride) {
  const token = telegramBotToken(env);
  const chatId = (chatOverride ?? env.TELEGRAM_CHAT_ID)?.trim();
  if (!token ||
      !/^-?[1-9]\d{0,15}$/.test(chatId ?? "")) return null;
  return {token, chatId};
}

async function inspectTelegram(settings, method, fields) {
  const started = Date.now();
  try {
    const response = await fetch(`https://api.telegram.org/bot${settings.token}/${method}`, {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify(fields), redirect: "manual", signal: AbortSignal.timeout(20000),
    });
    const body = await response.json().catch(() => null);
    return {ok: response.ok && body?.ok === true, http_status: response.status,
      error_code: Number.isInteger(body?.error_code) ? body.error_code : null,
      elapsed_ms: Date.now() - started};
  } catch (error) {
    return {ok: false, reason: ["TimeoutError", "AbortError"].includes(error?.name) ? "timeout" : "network",
      error_name: String(error?.name ?? "Error").slice(0, 40),
      detail: String(error?.message ?? "").replaceAll(settings.token, "[redacted]")
        .replaceAll(settings.chatId, "[redacted]").replace(/https?:\/\/\S+/g, "[url]").slice(0, 240),
      elapsed_ms: Date.now() - started};
  }
}

export async function telegramDeliveryStatus(db, settings, check = false) {
  const summary = await db.prepare(`SELECT count(*) AS total,
    sum(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,
    sum(CASE WHEN sent_at IS NULL AND failed_at IS NULL THEN 1 ELSE 0 END) AS pending,
    sum(CASE WHEN failed_at IS NOT NULL THEN 1 ELSE 0 END) AS failed
    FROM telegram_alert_outbox`).first();
  const latest = await db.prepare(`SELECT alert_id, attempts, created_at, sent_at, failed_at, next_attempt_at
    FROM telegram_alert_outbox ORDER BY created_at DESC LIMIT 5`).all();
  const result = {configured: Boolean(settings), summary, latest: latest.results};
  // Read-only checks: never send a message or expose the token/chat identifier.
  if (check && settings) {
    result.bot = await inspectTelegram(settings, "getMe", {});
    if (result.bot.ok) result.chat = await inspectTelegram(settings, "getChat", {chat_id: settings.chatId});
  }
  return result;
}

export function enqueueTelegramAlerts(db, chatId, now) {
  // This statement follows the telemetry INSERT in the same transaction.
  // changes() is zero if that INSERT ignored a duplicate message_id.
  return db.prepare(`INSERT INTO telegram_alert_outbox (alert_id, chat_id, created_at, next_attempt_at)
    SELECT id, ?, triggered_at, ? FROM cloud_alerts
    WHERE triggered_at = ? AND changes() > 0
    ON CONFLICT(alert_id, chat_id) DO NOTHING`).bind(chatId, now, now);
}

function messageFor(alerts) {
  const entries = alerts.map(alert => {
    const local = new Date(alert.triggered_at + 7 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
    return `${alert.title}\n${alert.message}\n${local} (UTC+7)`;
  });
  return ["⚠️ PTIT Garden · Cảnh báo", ...entries].join("\n\n");
}

async function sendTelegram(settings, alerts, send) {
  try {
    const response = await send(`https://api.telegram.org/bot${settings.token}/sendMessage`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        chat_id: settings.chatId,
        text: messageFor(alerts),
        link_preview_options: {is_disabled: true},
      }),
      // Workers accepts follow/manual, not redirect:"error". Never forward bot credentials.
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.ok === true) return {ok: true};
    const code = Number.isInteger(payload?.error_code) ? payload.error_code : response.status;
    const seconds = Number(payload?.parameters?.retry_after ?? response.headers.get("Retry-After"));
    return {
      ok: false,
      permanent: (response.status >= 300 && response.status < 400) ||
        (code >= 400 && code < 500 && code !== 408 && code !== 429),
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, RETRY_WINDOW_MS) : 0,
    };
  } catch {
    return {ok: false, permanent: false, retryAfterMs: 0};
  }
}

export async function flushTelegramAlerts(db, settings, send = fetch) {
  const now = Date.now();
  const lease = crypto.randomUUID();
  const [claim, rows] = await db.batch([
    db.prepare(`UPDATE telegram_alert_outbox
      SET lease_token = ?, next_attempt_at = ?, attempts = attempts + 1
      WHERE chat_id = ? AND alert_id IN (
        SELECT alert_id FROM telegram_alert_outbox
        WHERE chat_id = ? AND sent_at IS NULL AND failed_at IS NULL
          AND next_attempt_at <= ? AND created_at >= ? AND attempts < ?
        ORDER BY next_attempt_at, created_at, alert_id LIMIT 5
      )`).bind(lease, now + LEASE_MS, settings.chatId, settings.chatId, now, now - RETRY_WINDOW_MS, MAX_ATTEMPTS),
    db.prepare(`SELECT alert.title, alert.message, alert.triggered_at, outbox.attempts
      FROM telegram_alert_outbox AS outbox JOIN cloud_alerts AS alert ON alert.id = outbox.alert_id
      WHERE outbox.chat_id = ? AND outbox.lease_token = ?
      ORDER BY alert.triggered_at, alert.id`).bind(settings.chatId, lease),
  ]);
  if (!claim.meta.changes) return;

  const outcome = await sendTelegram(settings, rows.results, send);
  const finishedAt = Date.now();
  if (outcome.ok) {
    await db.prepare(`UPDATE telegram_alert_outbox SET sent_at = ?, lease_token = NULL
      WHERE chat_id = ? AND lease_token = ?`).bind(finishedAt, settings.chatId, lease).run();
    return;
  }
  const attempts = Math.max(...rows.results.map(row => row.attempts));
  const retryMs = Math.max(outcome.retryAfterMs, 60_000 * 2 ** (attempts - 1));
  await db.prepare(`UPDATE telegram_alert_outbox
    SET failed_at = CASE WHEN ? OR attempts >= ? THEN ? ELSE NULL END,
        next_attempt_at = ?, lease_token = NULL
    WHERE chat_id = ? AND lease_token = ?`)
    .bind(Number(outcome.permanent), MAX_ATTEMPTS, finishedAt, finishedAt + retryMs, settings.chatId, lease).run();
}

export function pruneTelegramAlerts(db, now) {
  return db.prepare("DELETE FROM telegram_alert_outbox WHERE created_at < ?").bind(now - RETENTION_MS).run();
}
