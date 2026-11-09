const COOKIE_NAME = "__Host-ptit_session";
const COOKIE_FLAGS = "Path=/; HttpOnly; Secure; SameSite=Lax";
const SESSION_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 60;
const LOGIN_LIMIT = 8;
const TOKEN_FORMAT = /^[a-f0-9]{64}$/;
const ADMIN_USERNAME = "garden";
const USERNAME_FORMAT = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const PASSWORD_VERIFIER_FORMAT = /^v1\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
const PBKDF2_V1_ITERATIONS = 30_000;
const encoder = new TextEncoder();

export class DashboardAuthError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function dashboardPassword(env) {
  if (typeof env.DASHBOARD_PASSWORD !== "string" || !env.DASHBOARD_PASSWORD) {
    throw new DashboardAuthError(503, "Tạm thời chưa thể đăng nhập.");
  }
  return env.DASHBOARD_PASSWORD;
}

function digest(text) {
  return crypto.subtle.digest("SHA-256", encoder.encode(text));
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value) {
  return Uint8Array.from(value.match(/../g), byte => Number.parseInt(byte, 16));
}

function normalizedUsername(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function passwordHash(env, password, salt) {
  const pepper = env.DASHBOARD_ACCOUNT_PEPPER;
  if (typeof pepper !== "string" || pepper.length < 32) {
    throw new DashboardAuthError(503, "Tạm thời chưa thể xác thực tài khoản.");
  }
  const pepperKey = await crypto.subtle.importKey("raw", encoder.encode(pepper), {
    name: "HMAC", hash: "SHA-256",
  }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", pepperKey, encoder.encode(password));
  const key = await crypto.subtle.importKey("raw", secret, "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({
    name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_V1_ITERATIONS,
  }, key, 256);
}

function sessionToken(request) {
  const entries = (request.headers.get("Cookie") || "").split(";").map(part => part.trim());
  const prefix = `${COOKIE_NAME}=`;
  const matches = entries.filter(part => part.startsWith(prefix));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(prefix.length);
  return TOKEN_FORMAT.test(token) ? token : null;
}

async function sessionHash(token, password) {
  // Including the password in the hash invalidates existing sessions when it changes.
  return hex(await digest(`ptit-garden/session:${token}:${password}`));
}

function sessionCookie(value, maxAge) {
  return `${COOKIE_NAME}=${value}; ${COOKIE_FLAGS}; Max-Age=${maxAge}`;
}

async function checkAuthLimit(request, env, password, action) {
  const client = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = hex(await digest(`ptit-garden/${action}:${client}:${password}`));
  let allowed;
  if (env.DASHBOARD_LOGIN_LIMIT) {
    try {
      allowed = (await env.DASHBOARD_LOGIN_LIMIT.limit({ key })).success;
    } catch {
      // D1 also enforces the limit if the edge binding is temporarily unavailable.
    }
  }
  if (allowed === undefined) {
    const now = Date.now();
    const counter = await env.DB.prepare(`
      INSERT INTO dashboard_login_attempts (client_hash, attempts, expires_at)
      VALUES (?1, 1, ?2)
      ON CONFLICT(client_hash) DO UPDATE SET
        attempts = CASE WHEN expires_at <= ?3 THEN 1 ELSE attempts + 1 END,
        expires_at = CASE WHEN expires_at <= ?3 THEN excluded.expires_at ELSE expires_at END
      WHERE expires_at <= ?3 OR attempts < ?4
      RETURNING attempts
    `).bind(key, now + LOGIN_WINDOW_SECONDS * 1000, now, LOGIN_LIMIT).first();
    allowed = counter !== null;
  }
  if (!allowed) {
    const label = action === "register" ? "đăng ký" : "đăng nhập";
    throw new DashboardAuthError(429, `Bạn đã thử ${label} quá nhiều lần. Hãy đợi một phút rồi thử lại.`, {
      "Retry-After": String(LOGIN_WINDOW_SECONDS),
    });
  }
}

export async function registerDashboard(request, env, body) {
  await checkAuthLimit(request, env, dashboardPassword(env), "register");
  const username = normalizedUsername(body?.username);
  const password = body?.password;
  if (!USERNAME_FORMAT.test(username)) {
    throw new DashboardAuthError(422, "Tên đăng nhập phải dài 3–32 ký tự, bắt đầu bằng chữ cái hoặc số và chỉ dùng chữ không dấu, số, dấu chấm, gạch dưới hoặc gạch ngang.");
  }
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw new DashboardAuthError(422, "Mật khẩu phải dài 12–128 ký tự.");
  }
  const duplicate = () => new DashboardAuthError(409, "Tên đăng nhập này đã được sử dụng.");
  if (username === ADMIN_USERNAME) throw duplicate();

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await passwordHash(env, password, salt);
  const verifier = `v1$${hex(salt)}$${hex(hash)}`;
  const account = await env.DB.prepare(`
    INSERT INTO dashboard_accounts (username, password_verifier, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(username) DO NOTHING
    RETURNING username
  `).bind(username, verifier, Date.now()).first();
  if (!account) throw duplicate();
  return { username, status: "pending" };
}

export async function listDashboardRegistrations(env) {
  const { results } = await env.DB.prepare(`
    SELECT username, created_at FROM dashboard_accounts
    WHERE approved_at IS NULL ORDER BY created_at, username LIMIT 100
  `).all();
  return results;
}

export async function approveDashboardRegistration(env, username) {
  const account = await env.DB.prepare(`
    UPDATE dashboard_accounts SET approved_at = COALESCE(approved_at, ?)
    WHERE username = ? RETURNING username
  `).bind(Date.now(), username).first();
  if (!account) throw new DashboardAuthError(404, "Không tìm thấy yêu cầu đăng ký.");
  return { username: account.username, status: "approved" };
}

async function verifyCredentials(env, body, adminPassword) {
  const username = normalizedUsername(body?.username);
  const suppliedPassword = body?.password;
  const invalid = () => new DashboardAuthError(401, "Tên đăng nhập hoặc mật khẩu không đúng.");
  if (!USERNAME_FORMAT.test(username) || typeof suppliedPassword !== "string" || suppliedPassword.length > 1024) {
    throw invalid();
  }
  if (username === ADMIN_USERNAME) {
    const [supplied, expected] = await Promise.all([digest(suppliedPassword), digest(adminPassword)]);
    if (!crypto.subtle.timingSafeEqual(supplied, expected)) throw invalid();
    return { username, role: "admin" };
  }

  if (suppliedPassword.length < 12 || suppliedPassword.length > 128) throw invalid();
  const account = await env.DB.prepare(`
    SELECT password_verifier, approved_at FROM dashboard_accounts WHERE username = ?
  `).bind(username).first();
  const verifier = account && PASSWORD_VERIFIER_FORMAT.exec(account.password_verifier);
  if (!verifier) throw invalid();
  const hash = await passwordHash(env, suppliedPassword, fromHex(verifier[1]));
  if (!crypto.subtle.timingSafeEqual(hash, fromHex(verifier[2]))) throw invalid();
  if (account.approved_at === null) {
    throw new DashboardAuthError(403, "Tài khoản đang chờ quản trị viên duyệt. Vui lòng thử lại sau.");
  }
  return { username, role: "member" };
}

function deleteSession(db, tokenHash) {
  return [
    db.prepare("DELETE FROM dashboard_sessions WHERE token_hash = ?").bind(tokenHash),
    db.prepare("DELETE FROM dashboard_member_sessions WHERE token_hash = ?").bind(tokenHash),
  ];
}

export async function loginDashboard(request, env, body) {
  const password = dashboardPassword(env);
  await checkAuthLimit(request, env, password, "login");
  const { username, role } = await verifyCredentials(env, body, password);

  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sessionHash(token, password);
  const expiresAt = Date.now() + SESSION_SECONDS * 1000;
  const insert = role === "admin"
    ? env.DB.prepare("INSERT INTO dashboard_sessions (token_hash, expires_at) VALUES (?, ?)").bind(tokenHash, expiresAt)
    : env.DB.prepare("INSERT INTO dashboard_member_sessions (token_hash, expires_at, username) VALUES (?, ?, ?)")
      .bind(tokenHash, expiresAt, username);
  const oldToken = sessionToken(request);
  if (oldToken) {
    const oldHash = await sessionHash(oldToken, password);
    await env.DB.batch([insert, ...deleteSession(env.DB, oldHash)]);
  } else {
    await insert.run();
  }
  return sessionCookie(token, SESSION_SECONDS);
}

export async function requireDashboardSession(request, env) {
  const token = sessionToken(request);
  if (token) {
    const tokenHash = await sessionHash(token, dashboardPassword(env));
    const account = await env.DB.prepare(`
      SELECT ?3 AS username, 'admin' AS role FROM dashboard_sessions
      WHERE token_hash = ?1 AND expires_at > ?2
      UNION ALL
      SELECT account.username, 'member' AS role FROM dashboard_member_sessions AS session
      JOIN dashboard_accounts AS account ON account.username = session.username
      WHERE session.token_hash = ?1 AND session.expires_at > ?2 AND account.approved_at IS NOT NULL
    `).bind(tokenHash, Date.now(), ADMIN_USERNAME).first();
    if (account) return account;
  }
  throw new DashboardAuthError(401, "Phiên đăng nhập đã hết. Vui lòng đăng nhập lại.");
}

export async function logoutDashboard(request, env) {
  const token = sessionToken(request);
  if (token && env.DASHBOARD_PASSWORD) {
    const tokenHash = await sessionHash(token, env.DASHBOARD_PASSWORD);
    await env.DB.batch(deleteSession(env.DB, tokenHash));
  }
  return sessionCookie("", 0);
}

export async function pruneDashboardSessions(db, now = Date.now()) {
  await db.batch([
    db.prepare(`DELETE FROM dashboard_sessions WHERE token_hash IN (
      SELECT token_hash FROM dashboard_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 512
    )`).bind(now),
    db.prepare(`DELETE FROM dashboard_member_sessions WHERE token_hash IN (
      SELECT token_hash FROM dashboard_member_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 512
    )`).bind(now),
    db.prepare(`DELETE FROM dashboard_login_attempts WHERE client_hash IN (
      SELECT client_hash FROM dashboard_login_attempts WHERE expires_at <= ? ORDER BY expires_at LIMIT 512
    )`).bind(now),
  ]);
}
