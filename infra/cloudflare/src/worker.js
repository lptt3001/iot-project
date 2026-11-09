import { DashboardQueryError, dashboardData, historyData, imageData, csvData } from "./dashboard-data.js";
import {
  DashboardAlertError, alertSummary, dashboardAlerts, acknowledgeAlert,
  dashboardNotifications, markNotificationsRead,
} from "./dashboard-alerts.js";
import {
  DashboardAuthError, loginDashboard, requireDashboardSession, logoutDashboard, pruneDashboardSessions,
  registerDashboard, listDashboardRegistrations, approveDashboardRegistration,
} from "./dashboard-auth.js";
import {
  CameraRequestError, createCameraRequest, getCameraRequest, nextCameraRequest,
  failCameraRequest, pruneCameraRequests,
} from "./camera-requests.js";
import {
  TELEGRAM_RETRY_CRON, pruneTelegramAlerts,
} from "./telegram-alerts.js";
import { LedControlError, ledStatus, setLed, ledCommand, confirmLed } from "./led-control.js";
import { setImageTrashed, cameraImageInsert, uploadedImageInsert } from "./image-library.js";
import { StationStartupError, recordStationStartup, pruneStationStartups } from "./station-startups.js";
import { scheduleMorningCapture, automationStatus, analysisCapability, analysisPage, runAutomaticAnalysis } from './automation.js';
import {PhotoAnalysisError,claimPhotoAnalysis,completePhotoAnalysis,failPhotoAnalysis} from './photo-analysis.js';
import {evaluatePlantHealth,plantHealthStatus} from './plant-health.js';
import {ObservationRuleError,observationConfig,updateObservationRule,setObservationCrop} from './observation-alerts.js';
import {
  TelegramRecipientError, pairingStatus,createPairing,pollPairing,confirmPairing,cancelPairing,
  listRecipients,updateRecipient,hasTelegramRecipients,enqueueDeliveries,flushDeliveries,pollConnections,
  enqueueRecipientTest,enqueueDemoResultTest,deliveryReceipt,pruneDeliveries,
} from './telegram-recipients.js';

const STATION = "station-001";
const DEVICE_PATH = `/device/v1/${STATION}`;
const DEVICE_CAMERA_PATH = `${DEVICE_PATH}/camera`;
const CAMERA_REQUESTS_PATH = "/api/camera/requests";
const MAX_JSON = 16 * 1024;
const MAX_JPEG = 512 * 1024;
const HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/;
const FIELDS = {
  temperature_c: [-40, 125],
  air_humidity_pct: [0, 100],
  soil_moisture_pct: [0, 100],
  soil_raw: [0, 4095, true],
  light_do: [0, 1, true],
  rain_do: [0, 1, true],
};
const ALLOWED_KEYS = new Set([
  "schema_version", "device_id", "farm_id", "message_id", "observed_at", "measurements",
  "battery_v", "rssi_dbm", "source",
]);
const HEADERS = {
  "Cache-Control": "no-store",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const DASHBOARD_ASSETS = new Map([
  ["/", "/index.html"],
  ["/static/app.js", "/app.js"],
  ["/static/accounts.css", "/accounts.css"],
  ["/static/ai-inference.js", "/ai-inference.js"],
  ["/static/plant-knowledge.js", "/plant-knowledge.js"],
  ["/static/plant-health.css", "/plant-health.css"],
]);
const AI_ASSET = /^\/static\/(ai\/(?:[a-zA-Z0-9][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:js|mjs|wasm|onnx|json|jpg|txt))$/;
const VERSIONED_AI_ASSET = /^\/ai\/(?:ort-\d+\.\d+\.\d+\/|model-[a-f0-9]{12}\.onnx$)/;
const LOGIN_ASSETS = new Map([
  ["/login", "/login.html"],
  ["/static/login.js", "/login.js"],
  ["/static/style.css", "/style.css"],
]);
const DASHBOARD_GETS = new Set([
  "/api/latest", "/api/dashboard", "/api/history", "/api/images", "/api/export.csv",
  "/api/alerts", "/api/notifications", "/api/rules",
  "/api/telegram/status",
  "/api/telegram/pairing",
  "/api/telegram/recipients",
  "/api/automation",
  "/api/plant-health",
]);
const AUTH_POSTS = new Set(["/api/login", "/api/logout", "/api/register"]);
const REGISTRATIONS_PATH = "/api/admin/registrations";
const trimImages = `DELETE FROM images WHERE image_id IN (
  SELECT image_id FROM (SELECT image_id FROM images WHERE deleted_at IS NULL
    ORDER BY received_at DESC, image_id DESC LIMIT 512 OFFSET 100)
  UNION ALL
  SELECT image_id FROM (SELECT image_id FROM images WHERE deleted_at IS NOT NULL
    ORDER BY deleted_at DESC, image_id DESC LIMIT 512 OFFSET 100)
)`;

class RequestError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const json = (data, status = 200, headers = {}) =>
  Response.json(data, { status, headers: { ...HEADERS, ...headers } });

async function authenticateDevice(request, secret) {
  if (!secret) throw new RequestError(503, "Service credentials are missing.");
  const authorization = request.headers.get("Authorization") || "";
  const prefix = "Bearer ";
  if (authorization.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase() &&
      authorization.length <= 1024) {
    const encoder = new TextEncoder();
    const [supplied, expected] = await Promise.all([
      crypto.subtle.digest("SHA-256", encoder.encode(authorization.slice(prefix.length))),
      crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    ]);
    const left = new Uint8Array(supplied), right = new Uint8Array(expected);
    let difference = 0;
    for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
    if (difference === 0) return;
  }
  throw new RequestError(401, "Authentication required.", {
    "WWW-Authenticate": "Bearer",
  });
}

async function readBody(request, type, limit) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== type) {
    throw new RequestError(415, `Expected ${type}.`);
  }
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (declaredLength > limit) throw new RequestError(413, "Request body is too large.");
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const data = new Uint8Array(limit);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return data.subarray(0, size);
      if (size + value.length > limit) {
        await reader.cancel();
        throw new RequestError(413, "Request body is too large.");
      }
      data.set(value, size);
      size += value.length;
    }
  } finally {
    reader.releaseLock();
  }
}

function validNumber(value, [min, max, integer = false]) {
  return Number.isFinite(value) && value >= min && value <= max &&
    (!integer || Number.isInteger(value));
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseTelemetry(raw, now) {
  let data;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new RequestError(422, "Invalid JSON.");
  }
  const invalid = () => new RequestError(422, "Invalid telemetry or timestamp.");
  if (!object(data) || data.device_id !== STATION || data.farm_id !== "farm-demo" ||
      data.schema_version !== 1 || typeof data.message_id !== "string" ||
      !UUID.test(data.message_id) || Object.keys(data).some(key => !ALLOWED_KEYS.has(key)) ||
      typeof data.observed_at !== "string" || !UTC.test(data.observed_at) || !object(data.measurements)) {
    throw invalid();
  }
  const observed = Date.parse(data.observed_at);
  const measurements = Object.entries(data.measurements);
  if (!Number.isFinite(observed) || observed < now - HISTORY_MS || observed > now + 300000 ||
      new Date(observed).toISOString().slice(0, 19) !== data.observed_at.slice(0, 19) ||
      measurements.length === 0 ||
      measurements.some(([key, value]) => !Object.hasOwn(FIELDS, key) || !validNumber(value, FIELDS[key])) ||
      (Object.hasOwn(data, "battery_v") && !validNumber(data.battery_v, [0, 30])) ||
      (Object.hasOwn(data, "rssi_dbm") && !validNumber(data.rssi_dbm, [-127, 0, true]))) {
    throw invalid();
  }
  return { ...data, observed };
}

async function receiveTelemetry(request, env, ctx) {
  const db = env.DB;
  const raw = await readBody(request, "application/json", MAX_JSON);
  const now = Date.now();
  const data = parseTelemetry(raw, now);
  const insert = db.prepare(`INSERT INTO telemetry
    (message_id, observed_at, received_at, measurements, battery_v, rssi_dbm)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`)
    .bind(data.message_id.toLowerCase(), data.observed, now, JSON.stringify(data.measurements),
      data.battery_v ?? null, data.rssi_dbm ?? null);
  const result=await insert.run();
  if(result.meta.changes>0&&await hasTelegramRecipients(env))ctx.waitUntil(enqueueDeliveries(db,now)
    .then(()=>flushDeliveries(env,fetch,{limit:5})).catch(error=>console.error('Telegram delivery failed',error?.name)));
  return json({ message_id: data.message_id, duplicate: result.meta.changes === 0 });
}

function looksLikeJpeg(bytes) {
  return bytes.length >= 6 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

async function receiveImage(request, db, id) {
  const bytes = await readBody(request, "image/jpeg", MAX_JPEG);
  if (!looksLikeJpeg(bytes)) throw new RequestError(422, "Invalid JPEG markers.");
  await db.batch([
    cameraImageInsert(db, id, Date.now(), bytes),
    db.prepare(trimImages),
  ]);
  return json({ id, source: "hardware" }, 201);
}

async function receiveDashboardImage(request, db, username) {
  const bytes = await readBody(request, "image/jpeg", MAX_JPEG);
  if (!looksLikeJpeg(bytes)) throw new RequestError(422, "Ảnh JPEG không hợp lệ.");
  const id = crypto.randomUUID();
  await db.batch([
    uploadedImageInsert(db, id, Date.now(), bytes, username),
    db.prepare(trimImages),
  ]);
  return json({ id, source: "upload" }, 201);
}

async function latest(db) {
  const [reading, image] = await Promise.all([
    db.prepare(`SELECT message_id, observed_at, received_at, measurements, battery_v, rssi_dbm
      FROM telemetry ORDER BY observed_at DESC, received_at DESC LIMIT 1`).first(),
    db.prepare("SELECT image_id AS id, received_at FROM images WHERE deleted_at IS NULL ORDER BY received_at DESC, image_id DESC LIMIT 1").first(),
  ]);
  return {
    device_id: STATION,
    telemetry: reading ? { ...reading, measurements: JSON.parse(reading.measurements) } : null,
    image,
  };
}

async function dashboardAsset(env, path, url) {
  const asset = await env.ASSETS.fetch(new URL(path, url));
  if (!asset.ok) throw new RequestError(asset.status === 404 ? 404 : 503,
    asset.status === 404 ? "Không tìm thấy tài nguyên." : "Giao diện tạm thời chưa sẵn sàng.");
  const headers = new Headers(asset.headers);
  for (const [key, value] of Object.entries(HEADERS)) headers.set(key, value);
  const revision = env.CF_VERSION_METADATA?.id;
  if (!path.endsWith(".html")) {
    if ((revision && url.searchParams.get("v") === revision) || VERSIONED_AI_ASSET.test(path)) {
      headers.set("Cache-Control", "private, max-age=86400, immutable");
    }
    return new Response(asset.body, { headers });
  }

  headers.delete("content-length");
  headers.delete("etag");
  const workers = path === "/index.html" ? " worker-src 'self';" : "";
  headers.set("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self';${workers} frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
  const page = new Response(asset.body, { headers });
  const rewriter = new HTMLRewriter();
  if (path === "/index.html") {
    rewriter.on("html", { element(element) { element.setAttribute("data-mode", "cloud"); } });
  }
  if (revision) {
    const versioned = attribute => ({
      element(element) {
        const assetPath = element.getAttribute(attribute);
        element.setAttribute(attribute, `${assetPath}?v=${encodeURIComponent(revision)}`);
      },
    });
    rewriter.on('link[href^="/static/"]', versioned("href"));
    rewriter.on('script[src^="/static/"]', versioned("src"));
  }
  return rewriter.transform(page);
}

function verifyDashboardWrite(request, url) {
  const origin = request.headers.get("Origin");
  if ((origin && origin !== url.origin) || request.headers.get("X-Garden-Request") !== "1") {
    throw new RequestError(403, "Yêu cầu không cùng nguồn.");
  }
}

async function readSmallJson(request) {
  const data = await readBody(request, "application/json", 4096);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    throw new RequestError(422, "Nội dung JSON không hợp lệ.");
  }
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  if (url.protocol === "http:" && url.hostname.endsWith(".workers.dev")) {
    url.protocol = "https:";
    return Response.redirect(url, 308);
  }
  const { pathname } = url;
  if (request.method === 'GET' && (pathname.startsWith('/internal/ai/') || AI_ASSET.test(pathname) || pathname === '/static/ai-inference.js' || pathname.startsWith('/media/'))) {
    const jobId = await analysisCapability(request,env.DB);
    if (jobId) {
      if (pathname === '/internal/ai/'+jobId) return analysisPage(jobId);
      if (pathname === '/media/'+jobId) {
        const bytes=await env.DB.prepare('SELECT jpeg FROM images WHERE image_id=? AND deleted_at IS NULL').bind(jobId).first('jpeg');
        if(bytes)return new Response(Uint8Array.from(bytes),{headers:{...HEADERS,'Content-Type':'image/jpeg'}});
      }
      const asset=AI_ASSET.exec(pathname);
      if(asset || pathname === '/static/ai-inference.js')return dashboardAsset(env,asset?'/'+asset[1]:'/ai-inference.js',url);
    }
    if(pathname.startsWith('/internal/ai/'))throw new RequestError(404,'Route not found.');
  }
  if (pathname.startsWith("/device/")) {
    if (pathname === `${DEVICE_PATH}/led`) {
      if (!["GET", "POST"].includes(request.method)) throw new RequestError(405, "Method not allowed.", { Allow: "GET, POST" });
      await authenticateDevice(request, env.DEVICE_TOKEN);
      return json(request.method === "GET" ? await ledCommand(env.DB)
        : await confirmLed(env.DB, await readSmallJson(request)));
    }
    const imagePrefix = `${DEVICE_PATH}/images/`;
    const imageId = pathname.startsWith(imagePrefix) ? pathname.slice(imagePrefix.length) : null;
    const telemetry = pathname === `${DEVICE_PATH}/telemetry`;
    const startup = pathname === `${DEVICE_PATH}/startup`;
    const cameraNext = pathname === `${DEVICE_CAMERA_PATH}/next`;
    const failureId = pathname.startsWith(`${DEVICE_CAMERA_PATH}/`) && pathname.endsWith("/fail")
      ? pathname.slice(DEVICE_CAMERA_PATH.length + 1, -"/fail".length) : null;
    const cameraFailure = failureId && UUID.test(failureId);
    if (!telemetry && !startup && !cameraNext && !cameraFailure && (!imageId || !UUID.test(imageId))) {
      throw new RequestError(404, "Device route not found.");
    }
    const method = cameraNext ? "GET" : telemetry || startup || cameraFailure ? "POST" : "PUT";
    if (request.method !== method) throw new RequestError(405, "Method not allowed.", { Allow: method });
    await authenticateDevice(request, env.DEVICE_TOKEN);
    if(startup){
      const configured=await hasTelegramRecipients(env);
      const result=await recordStationStartup(env.DB,null,await readSmallJson(request));
      if(configured)ctx.waitUntil(enqueueDeliveries(env.DB).then(()=>flushDeliveries(env,fetch,{limit:5})).catch(error=>console.error('Startup delivery failed',error?.name)));
      return json({...result,telegram_configured:configured});
    }
    if (cameraNext) {
      const capture = await nextCameraRequest(env.DB);
      return capture ? json(capture) : new Response(null, { status: 204, headers: HEADERS });
    }
    if (cameraFailure) {
      return json(await failCameraRequest(env.DB, failureId.toLowerCase(), await readSmallJson(request)));
    }
    return telemetry ? receiveTelemetry(request, env, ctx) : receiveImage(request, env.DB, imageId.toLowerCase());
  }

  const loginAsset = LOGIN_ASSETS.get(pathname);
  if (loginAsset) {
    if (request.method !== "GET") throw new RequestError(405, "Method not allowed.", { Allow: "GET" });
    return dashboardAsset(env, loginAsset, url);
  }
  if (AUTH_POSTS.has(pathname)) {
    if (request.method !== "POST") throw new RequestError(405, "Method not allowed.", { Allow: "POST" });
    verifyDashboardWrite(request, url);
    if (pathname === "/api/register") {
      return json(await registerDashboard(request, env, await readSmallJson(request)), 201);
    }
    const cookie = pathname === "/api/login"
      ? await loginDashboard(request, env, await readSmallJson(request))
      : await logoutDashboard(request, env);
    return json({ ok: true }, 200, { "Set-Cookie": cookie });
  }

  const mediaId = pathname.startsWith("/media/") ? pathname.slice("/media/".length) : null;
  const hasMedia = mediaId && UUID.test(mediaId);
  const aiAsset = AI_ASSET.exec(pathname);
  const assetPath = DASHBOARD_ASSETS.get(pathname) ?? (aiAsset && `/${aiAsset[1]}`);
  const ack = /^\/api\/alerts\/([a-zA-Z0-9-]+)\/ack$/.exec(pathname);
  const rule = /^\/api\/rules\/([a-zA-Z0-9_-]+)$/.exec(pathname);
  const approve = /^\/api\/admin\/registrations\/([a-zA-Z0-9_.-]+)\/approve$/.exec(pathname);
  const listRegistrations = pathname === REGISTRATIONS_PATH;
  const createCapture = pathname === CAMERA_REQUESTS_PATH;
  const uploadImage = pathname === "/api/images/upload";
  const photoAnalysis=/^\/api\/images\/([a-f0-9-]{36})\/analysis\/(claim|complete|fail)$/i.exec(pathname);
  const pairingCollection = pathname === "/api/telegram/pairing";
  const recipientCollection=pathname==='/api/telegram/recipients';
  const recipientAction=/^\/api\/telegram\/recipients\/([a-f0-9]{32})(\/(?:test|demo-test))?$/i.exec(pathname);
  const pairingMutation = /^\/api\/telegram\/pairing\/([a-f0-9-]{36})\/(poll|confirm|cancel)$/i.exec(pathname);
  const pairingAction = pairingMutation && UUID.test(pairingMutation[1]);
  if (pairingCollection && !["GET", "POST"].includes(request.method)) {
    throw new RequestError(405, "Method not allowed.", {Allow:"GET, POST"});
  }
  const imageMutation = /^\/api\/images\/([a-f0-9-]{36})(\/restore)?$/i.exec(pathname);
  const imageAction = imageMutation && UUID.test(imageMutation[1]);
  const trashView = pathname === "/api/images" && url.searchParams.get("trashed") === "1";
  const captureId = pathname.startsWith(`${CAMERA_REQUESTS_PATH}/`)
    ? pathname.slice(CAMERA_REQUESTS_PATH.length + 1) : null;
  const captureStatus = captureId && UUID.test(captureId);
  const readNotifications = pathname === "/api/notifications/read";
  const led = pathname === "/api/led";
  if (led && !["GET", "PUT"].includes(request.method)) {
    throw new RequestError(405, "Method not allowed.", { Allow: "GET, PUT" });
  }
  const method = photoAnalysis?'POST':recipientAction?(recipientAction[2]?'POST':'PUT'):pairingAction || (pairingCollection && request.method === "POST") ? "POST" : imageAction ? (imageMutation[2] ? "POST" : "DELETE") : led && request.method === "PUT" ? "PUT" : ack || readNotifications || approve || createCapture || uploadImage ? "POST" : rule ? "PUT" : "GET";
  if (!imageAction && !led && !hasMedia && !assetPath && !listRegistrations && !captureStatus && !DASHBOARD_GETS.has(pathname) && method === "GET") {
    throw new RequestError(404, "Route not found.");
  }
  if (request.method !== method) throw new RequestError(405, "Method not allowed.", { Allow: method });
  let account;
  try {
    account = await requireDashboardSession(request, env);
  } catch (error) {
    if (pathname === "/" && error instanceof DashboardAuthError && error.status === 401) {
      return new Response(null, { status: 302, headers: { ...HEADERS, Location: "/login" } });
    }
    throw error;
  }
  const telegramSelfService=pairingCollection||pairingAction||recipientCollection||recipientAction;
  if ((method !== "GET" || pairingCollection || trashView || listRegistrations || captureStatus || pathname === "/api/rules" || pathname === "/api/telegram/status") && account.role !== "admin"&&!telegramSelfService) {
    throw new RequestError(403, "Thao tác này chỉ dành cho quản trị viên.");
  }
  if (listRegistrations) return json({ registrations: await listDashboardRegistrations(env) });
  if (captureStatus) return json(await getCameraRequest(env.DB, captureId.toLowerCase()));
  if (method !== "GET") {
    verifyDashboardWrite(request, url);
    if(photoAnalysis){
      const [,,operation]=photoAnalysis,id=photoAnalysis[1].toLowerCase();
      if(operation==='claim')return json(await claimPhotoAnalysis(env,id,Date.now(),url.searchParams.get('reanalyze')==='1'));
      const bytes=await readBody(request,'application/json',256*1024);let body;
      try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new RequestError(422,'JSON kết quả không hợp lệ.');}
      const result=operation==='complete'?await completePhotoAnalysis(env,id,body,account):await failPhotoAnalysis(env,id,body);
      if(operation==='complete'&&await hasTelegramRecipients(env))ctx.waitUntil(enqueueDeliveries(env.DB).then(()=>flushDeliveries(env,fetch,{limit:5})).catch(error=>console.error('Saved AI notification failed',error?.name)));
      return json(result);
    }
    if(recipientAction){
      const id=recipientAction[1].toLowerCase(),body=await readSmallJson(request);
      if(!recipientAction[2])return json(await updateRecipient(env,id,body,account));
      const queued=await (recipientAction[2]==='/demo-test'?enqueueDemoResultTest:enqueueRecipientTest)(env,id,body,account);
      await flushDeliveries(env,fetch,{limit:1,recipientId:id});
      return json({...queued,receipt:await deliveryReceipt(env,queued.event_key,id,account)});
    }
    if (pairingCollection) return json(await createPairing(env,account), 201);
    if (pairingAction) {
      const id = pairingMutation[1].toLowerCase(), action = pairingMutation[2].toLowerCase();
      if(action==='confirm'){
        const result=await confirmPairing(env,id,account);
        ctx.waitUntil(flushDeliveries(env,fetch,{limit:5}).catch(error=>console.error('Telegram connection notice failed',error?.name)));
        return json(result);
      }
      return json(action==='poll'?await pollPairing(env,id,account):await cancelPairing(env,id,account));
    }
    if (imageAction) {
      const result = await setImageTrashed(env.DB, imageMutation[1].toLowerCase(), !imageMutation[2]);
      if (!result) throw new RequestError(404, "Ảnh không còn trong thư viện.");
      return json(result);
    }
    if (uploadImage) return receiveDashboardImage(request, env.DB, account.username);
    if (led) return json(await setLed(env.DB, await readSmallJson(request)), 202);
    if (createCapture) {
      const requestId = request.headers.get("X-Garden-Capture-ID");
      if (requestId !== null && !UUID.test(requestId)) {
        throw new RequestError(400, "Mã yêu cầu chụp không hợp lệ.");
      }
      return json(await createCameraRequest(env.DB, requestId?.toLowerCase(), account.username), 202);
    }
    if (approve) return json(await approveDashboardRegistration(env, approve[1]));
    if (ack) return json(await acknowledgeAlert(env.DB, ack[1]));
    if (rule) return json(await (rule[1]==='profile'?setObservationCrop(env.DB,await readSmallJson(request)):updateObservationRule(env.DB,rule[1],await readSmallJson(request))));
    return json(await markNotificationsRead(env.DB));
  }
  if (assetPath) return dashboardAsset(env, assetPath, url);
  if (led) return json(await ledStatus(env.DB));
  if (hasMedia) {
    const allowTrash = account.role === "admin" && url.searchParams.get("trashed") === "1";
    const jpeg = await env.DB.prepare(`SELECT jpeg FROM images WHERE image_id = ?${allowTrash ? "" : " AND deleted_at IS NULL"}`)
      .bind(mediaId.toLowerCase()).first("jpeg");
    if (!jpeg) throw new RequestError(404, "Image not found.");
    return new Response(Uint8Array.from(jpeg), {
      headers: { ...HEADERS, "Content-Type": "image/jpeg" },
    });
  }
  const db = env.DB;
  switch (pathname) {
    case '/api/plant-health': return json(await plantHealthStatus(env.DB));
    case '/api/automation': return json(await automationStatus(env));
    case '/api/telegram/recipients': return json(await listRecipients(env,account,url.searchParams.get('check')==='1'));
    case "/api/telegram/pairing": return json(await pairingStatus(env,account));
    case "/api/telegram/status": return json(await listRecipients(env,account,url.searchParams.get('check')==='1'));
    case "/api/dashboard": {
      const dashboard = await dashboardData(db, alertSummary(db));
      if (account.role === "admin") dashboard.system.telegram_configured = await hasTelegramRecipients(env);
      return json({...dashboard, account});
    }
    case "/api/history": return json(await historyData(db, url.searchParams));
    case "/api/images": {
      const id = url.searchParams.get("id");
      if (id !== null && !UUID.test(id)) throw new RequestError(400, "Mã ảnh không hợp lệ.");
      return json(await imageData(db, url.searchParams, id?.toLowerCase()));
    }
    case "/api/export.csv": return csvData(db, url.searchParams);
    case "/api/alerts": return json(await dashboardAlerts(db, url.searchParams));
    case "/api/notifications": return json(await dashboardNotifications(db));
    case "/api/rules": return json(await observationConfig(db));
    default: return json(await latest(db));
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      if (error instanceof RequestError) return json({ detail: error.message }, error.status, error.headers);
      if (error instanceof DashboardAuthError) return json({ detail: error.message }, error.status, error.headers);
      if (error instanceof PhotoAnalysisError || error instanceof ObservationRuleError || error instanceof DashboardQueryError || error instanceof DashboardAlertError || error instanceof CameraRequestError || error instanceof LedControlError || error instanceof TelegramRecipientError || error instanceof StationStartupError) {
        return json({ detail: error.message }, error.status);
      }
      console.error("Cloudflare station request failed", error?.name);
      return json({ detail: "Service unavailable." }, 503);
    }
  },
  async scheduled(controller, env) {
    await scheduleMorningCapture(env.DB,controller.scheduledTime);
    if (controller.cron === TELEGRAM_RETRY_CRON) {
      await pollConnections(env).catch(error=>console.error('Telegram connection polling failed',error?.name));
      await evaluatePlantHealth(env.DB,null);
      await runAutomaticAnalysis(env,null);
      await enqueueDeliveries(env.DB);
      await flushDeliveries(env);
      return;
    }
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM telemetry WHERE message_id IN (
        SELECT message_id FROM telemetry WHERE observed_at < ? ORDER BY observed_at LIMIT 2048
      )`).bind(controller.scheduledTime - HISTORY_MS),
      env.DB.prepare(trimImages),
    ]);
    await pruneDashboardSessions(env.DB, controller.scheduledTime);
    await pruneCameraRequests(env.DB, controller.scheduledTime);
    await pruneTelegramAlerts(env.DB, controller.scheduledTime);
    await pruneStationStartups(env.DB,controller.scheduledTime);
    await pruneDeliveries(env,controller.scheduledTime);
    await env.DB.prepare('DELETE FROM daily_captures WHERE created_at<?').bind(controller.scheduledTime-HISTORY_MS).run();
  },
};
