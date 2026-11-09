import { telegramBotToken, telegramSettings } from './telegram-alerts.js';

const TTL = 5 * 60_000;
const COOLDOWN = 30_000;
const MAX_GUESSES = 10;
const encoder = new TextEncoder();

export class TelegramPairingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function resolveTelegramSettings(env) {
  const connection = await env.DB.prepare('SELECT chat_id FROM telegram_connection WHERE id = 1').first();
  return telegramSettings(env, connection?.chat_id);
}

async function api(token, method, fields, send) {
  let response, body;
  try {
    response = await send(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(fields),
      redirect: 'manual', signal: AbortSignal.timeout(10000),
    });
    body = await response.json();
  } catch {
    throw new TelegramPairingError(503, 'Chưa kết nối được Telegram. Hãy thử lại.');
  }
  if (!response.ok || body?.ok !== true) {
    const code = body?.error_code ?? response.status;
    if (code === 409) throw new TelegramPairingError(409, 'Bot đang được một công cụ khác nhận tin. Hãy dừng công cụ đó rồi thử lại.');
    if (code === 401 || code === 404) throw new TelegramPairingError(503, 'Cấu hình bot Telegram cần được kiểm tra lại.');
    throw new TelegramPairingError(503, 'Telegram chưa xử lý được yêu cầu. Hãy thử lại.');
  }
  return body.result;
}

function tokenFor(env) {
  const token = telegramBotToken(env);
  if (!token) throw new TelegramPairingError(503, 'Hệ thống chưa cấu hình bot Telegram.');
  return token;
}

function newCode() {
  const buffer = new Uint32Array(1);
  do { crypto.getRandomValues(buffer); } while (buffer[0] >= 4_294_000_000);
  return String(buffer[0] % 1_000_000).padStart(6, '0');
}
async function hmacKey(token) {
  return crypto.subtle.importKey('raw', encoder.encode(token), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']);
}
async function hashCode(token, id, code) {
  const hash = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(token), encoder.encode(`${id}:${code}`)));
  return [...hash].map(n=>n.toString(16).padStart(2,'0')).join('');
}
async function matches(token, row, code) {
  const hash = Uint8Array.from(row.code_hash.match(/.{2}/g), n=>parseInt(n,16));
  return crypto.subtle.verify('HMAC', await hmacKey(token), hash, encoder.encode(`${row.request_id}:${code}`));
}
function maskChat(id) { return id ? `…${String(id).slice(-4)}` : null; }
function publicPair(row, now = Date.now()) {
  if (!row) return null;
  const status = row.consumed_at ? 'connected' : row.cancelled_at ? 'cancelled' : row.expires_at <= now ? 'expired'
    : row.candidate_chat_id ? 'confirmation' : 'pending';
  return {id:row.request_id, status, expires_at:row.expires_at, bot_username:row.bot_username,
    candidate_name:status === 'confirmation' ? row.candidate_name : null,
    candidate_chat:status === 'confirmation' ? maskChat(row.candidate_chat_id) : null};
}

export async function pairingStatus(env) {
  const [connection, row] = await env.DB.batch([
    env.DB.prepare('SELECT chat_id, display_name, connected_at FROM telegram_connection WHERE id = 1'),
    env.DB.prepare('SELECT * FROM telegram_pairing WHERE id = 1'),
  ]);
  const active = connection.results[0];
  const settings = telegramSettings(env, active?.chat_id);
  return {bot_configured:Boolean(telegramBotToken(env)), connected:Boolean(settings),
    connection:settings ? {name:active?.display_name ?? 'Chat Telegram hiện tại',
      chat:maskChat(settings.chatId), connected_at:active?.connected_at ?? null} : null,
    pairing:publicPair(row.results[0])};
}

export async function createPairing(env, send = fetch) {
  const token = tokenFor(env), started = Date.now();
  const previous = await env.DB.prepare('SELECT created_at FROM telegram_pairing WHERE id = 1').first();
  if (previous && previous.created_at > started - COOLDOWN) {
    throw new TelegramPairingError(429, 'Bạn có thể lấy mã mới sau 30 giây.');
  }
  const bot = await api(token, 'getMe', {}, send);
  if (!bot?.is_bot || !/^[a-zA-Z0-9_]{5,32}$/.test(bot.username ?? '')) {
    throw new TelegramPairingError(503, 'Chưa xác định được bot Telegram.');
  }
  const now = Date.now(), id = crypto.randomUUID(), code = newCode();
  const hash = await hashCode(token, id, code);
  const row = await env.DB.prepare(`INSERT INTO telegram_pairing
    (id,request_id,code_hash,bot_username,created_at,expires_at) VALUES(1,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET request_id=excluded.request_id,code_hash=excluded.code_hash,
      bot_username=excluded.bot_username,created_at=excluded.created_at,expires_at=excluded.expires_at,
      attempts=0,poll_after=0,candidate_chat_id=NULL,candidate_name=NULL,matched_at=NULL,consumed_at=NULL,cancelled_at=NULL
    WHERE telegram_pairing.created_at <= ? RETURNING *`)
    .bind(id,hash,bot.username,now,now+TTL,now-COOLDOWN).first();
  if (!row) throw new TelegramPairingError(429, 'Mã vừa được tạo ở phiên khác. Vui lòng tải lại trạng thái.');
  return {...publicPair(row,now), code, command:`/start ${code}`, bot_url:`https://t.me/${bot.username}?start=${code}`};
}

export async function pollPairing(env, id, send = fetch) {
  const token = tokenFor(env), now = Date.now();
  const row = await env.DB.prepare(`UPDATE telegram_pairing SET poll_after=?
    WHERE request_id=? AND expires_at>? AND consumed_at IS NULL AND cancelled_at IS NULL
      AND candidate_chat_id IS NULL AND attempts<? AND poll_after<=? RETURNING *`)
    .bind(now+15000,id,now,MAX_GUESSES,now).first();
  if (!row) {
    const current = await env.DB.prepare('SELECT * FROM telegram_pairing WHERE request_id=?').bind(id).first();
    if (!current) throw new TelegramPairingError(404, 'Mã đã được thay thế. Hãy lấy mã mới.');
    return publicPair(current);
  }
  try {
    const cursor = await env.DB.prepare('SELECT next_offset FROM telegram_update_cursor WHERE id=1').first();
    const updates = await api(token,'getUpdates',{offset:cursor?.next_offset??0,limit:100,timeout:0,allowed_updates:['message']},send);
    if (!Array.isArray(updates)) throw new TelegramPairingError(503,'Telegram trả về dữ liệu chưa hợp lệ.');
    let nextOffset = cursor?.next_offset??0, candidate=null, attempts=row.attempts;
    for (const update of updates) {
      if (!Number.isSafeInteger(update?.update_id) || update.update_id<nextOffset) continue;
      nextOffset=update.update_id+1;
      const message=update.message, chat=message?.chat;
      if (!message || chat?.type!=='private' || !Number.isSafeInteger(chat.id) || chat.id<=0 ||
        message.from?.id!==chat.id || !Number.isFinite(message.date) || message.date*1000<row.created_at-1000 ||
        message.date*1000>now+60000 || typeof message.text!=='string') continue;
      const command=/^\/start(?:@([a-zA-Z0-9_]+))?\s+(\d{6})$/.exec(message.text.trim());
      if (!command || (command[1]&&command[1].toLowerCase()!==row.bot_username.toLowerCase())) continue;
      if (await matches(token,row,command[2])) {
        const name=[chat.first_name,chat.last_name].filter(n=>typeof n==='string').join(' ').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,100);
        const username=/^[a-zA-Z0-9_]{5,32}$/.test(chat.username??'')?`@${chat.username}`:'';
        candidate={id:String(chat.id),name:[name,username].filter(Boolean).join(' · ')||'Chat Telegram'};
        break;
      }
      if (++attempts>=MAX_GUESSES) break;
    }
    const finished=Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO telegram_update_cursor(id,next_offset) VALUES(1,?)
        ON CONFLICT(id) DO UPDATE SET next_offset=max(next_offset,excluded.next_offset)`).bind(nextOffset),
      env.DB.prepare(`UPDATE telegram_pairing SET attempts=?,poll_after=?,candidate_chat_id=?,candidate_name=?,
        matched_at=?,cancelled_at=CASE WHEN ?>=? THEN ? ELSE NULL END
        WHERE request_id=? AND consumed_at IS NULL AND cancelled_at IS NULL AND expires_at>?
          AND candidate_chat_id IS NULL`)
        .bind(attempts,finished+3000,candidate?.id??null,candidate?.name??null,candidate?finished:null,
          attempts,MAX_GUESSES,finished,id,finished),
    ]);
    return publicPair(await env.DB.prepare('SELECT * FROM telegram_pairing WHERE request_id=?').bind(id).first());
  } catch (error) {
    await env.DB.prepare('UPDATE telegram_pairing SET poll_after=? WHERE request_id=? AND consumed_at IS NULL')
      .bind(Date.now()+5000,id).run();
    throw error;
  }
}

export async function confirmPairing(env,id) {
  const now=Date.now();
  const [accepted] = await env.DB.batch([
    env.DB.prepare(`UPDATE telegram_pairing SET consumed_at=? WHERE request_id=? AND expires_at>?
      AND consumed_at IS NULL AND cancelled_at IS NULL AND candidate_chat_id IS NOT NULL
      RETURNING request_id`).bind(now,id,now),
    env.DB.prepare(`INSERT INTO telegram_connection(id,chat_id,display_name,connected_at)
      SELECT 1,candidate_chat_id,candidate_name,? FROM telegram_pairing
      WHERE request_id=? AND consumed_at=? AND changes()>0
      ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id,display_name=excluded.display_name,connected_at=excluded.connected_at`)
      .bind(now,id,now),
  ]);
  if (!accepted.results.length) throw new TelegramPairingError(409,'Chưa thể xác nhận. Mã có thể đã hết hạn hoặc chưa nhận được tin nhắn.');
  return pairingStatus(env);
}

export async function cancelPairing(env,id) {
  await env.DB.prepare('UPDATE telegram_pairing SET cancelled_at=? WHERE request_id=? AND consumed_at IS NULL')
    .bind(Date.now(),id).run();
  return pairingStatus(env);
}
