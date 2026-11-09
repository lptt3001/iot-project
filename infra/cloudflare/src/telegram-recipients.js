import {telegramBotToken} from './telegram-alerts.js';
import {Knowledge} from './plant-health.js';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ADMIN={username:'garden',role:'admin'},TTL=600000,DAY=86400000;
const mask=id=>'…'+String(id).slice(-4);
export class TelegramRecipientError extends Error{constructor(status,message){super(message);this.status=status;}}
async function telegram(env,method,fields,send=fetch){
  const token=telegramBotToken(env);if(!token)throw new TelegramRecipientError(503,'Bot Telegram chưa được cấu hình.');
  let response,body;
  try{response=await send(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(fields),redirect:'manual',signal:AbortSignal.timeout(10000)});body=await response.json();}
  catch{throw new TelegramRecipientError(503,'Chưa kết nối được Telegram.');}
  if(!response.ok||body?.ok!==true){const error=new TelegramRecipientError(503,`Telegram chưa xử lý được yêu cầu (mã ${Number(body?.error_code)||response.status}).`);
    error.code=Number(body?.error_code)||response.status;error.retryAfter=Number(body?.parameters?.retry_after)||0;throw error;}
  return body.result;
}
async function botIdentity(env,send){
  const bot=await telegram(env,'getMe',{},send);
  if(!bot?.is_bot||!Number.isSafeInteger(bot.id)||!/^[a-zA-Z0-9_]{5,32}$/.test(bot.username??''))throw new TelegramRecipientError(503,'Telegram chưa trả về định danh bot hợp lệ.');
  await env.DB.prepare(`INSERT INTO telegram_bot_identity VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,verified_at=excluded.verified_at`)
    .bind(bot.username,Date.now()).run();return bot;
}
export async function hasTelegramRecipients(env){
  if(!telegramBotToken(env))return false;
  return Boolean(await env.DB.prepare("SELECT 1 AS present FROM telegram_recipients WHERE enabled=1 AND delivery_state!='blocked' LIMIT 1").first());
}
function recipientRow(row){return {id:row.id,owner_username:row.owner_username,name:row.display_name,chat:mask(row.chat_id),
  connected_at:row.connected_at,enabled:Boolean(row.enabled),state:!row.enabled?'paused':row.delivery_state,
  status:!row.enabled?'Đã tạm dừng':({pending:'Đã liên kết · Chờ xác nhận gửi',ready:'Đã gửi thành công',blocked:'Bot bị chặn / Không gửi được',error:'Gửi gặp lỗi'})[row.delivery_state],
  last_sent_at:row.last_sent_at,last_error_code:row.last_error_code,last_error_at:row.last_error_at};}
export async function listRecipients(env,account=ADMIN,check=false,send=fetch){
  let bot=await env.DB.prepare('SELECT username,verified_at FROM telegram_bot_identity WHERE id=1').first();
  if(check){const verified=await botIdentity(env,send);bot={username:verified.username,verified_at:Date.now()};}
  const rows=await env.DB.prepare(`SELECT * FROM telegram_recipients ${account.role==='admin'?'':'WHERE owner_username=?'} ORDER BY connected_at DESC LIMIT 100`)
    .bind(...(account.role==='admin'?[]:[account.username])).all();
  return {bot_configured:Boolean(telegramBotToken(env)),bot_username:bot?.username??null,bot_verified_at:bot?.verified_at??null,
    scope:account.role==='admin'?'all':'own',recipients:rows.results.map(recipientRow)};
}
async function ownedRecipient(env,id,account){
  const row=await env.DB.prepare('SELECT * FROM telegram_recipients WHERE id=? AND (?=1 OR owner_username=?)')
    .bind(id,Number(account.role==='admin'),account.username).first();
  if(!row)throw new TelegramRecipientError(404,'Không tìm thấy kết nối Telegram của bạn.');return row;
}
export async function updateRecipient(env,id,body,account=ADMIN){
  if(!body||Object.keys(body).join()!=='enabled'||typeof body.enabled!=='boolean')throw new TelegramRecipientError(422,'Trạng thái nhận cảnh báo không hợp lệ.');
  await ownedRecipient(env,id,account);
  await env.DB.prepare("UPDATE telegram_recipients SET enabled=?,updated_at=?,delivery_state=CASE WHEN ?=1 THEN 'pending' ELSE delivery_state END WHERE id=?")
    .bind(Number(body.enabled),Date.now(),Number(body.enabled),id).run();
  // Disabling cancels queued deliveries; enabling never replays old alerts.
  await env.DB.prepare('UPDATE telegram_deliveries SET failed_at=?,lease_token=NULL WHERE recipient_id=? AND sent_at IS NULL AND failed_at IS NULL').bind(Date.now(),id).run();
  return listRecipients(env,account);
}
async function hmac(token,id,code){const enc=new TextEncoder(),key=await crypto.subtle.importKey('raw',enc.encode(token),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(id+':'+code)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
function publicPair(row){if(!row)return null;const now=Date.now(),status=row.consumed_at?'connected':row.cancelled_at?'cancelled':row.expires_at<=now?'expired':row.candidate_chat_id?'confirmation':'pending';
  return {id:row.request_id,status,expires_at:row.expires_at,bot_username:row.bot_username,
    candidate_name:status==='confirmation'?row.candidate_name:null,candidate_chat:status==='confirmation'?mask(row.candidate_chat_id):null};}
export async function pairingStatus(env,account=ADMIN){
  const list=await listRecipients(env,account),row=await env.DB.prepare('SELECT * FROM telegram_pairings WHERE owner_username=? ORDER BY created_at DESC LIMIT 1').bind(account.username).first();
  return {...list,connected:list.recipients.some(r=>r.enabled),pairing:publicPair(row)};
}
export async function createPairing(env,account=ADMIN,send=fetch){
  const now=Date.now(),previous=await env.DB.prepare('SELECT created_at FROM telegram_pairings WHERE owner_username=? ORDER BY created_at DESC LIMIT 1').bind(account.username).first();
  if(previous&&previous.created_at>now-30000)throw new TelegramRecipientError(429,'Bạn có thể lấy kết nối mới sau 30 giây.');
  const bot=await botIdentity(env,send),id=crypto.randomUUID(),bytes=new Uint32Array(1);crypto.getRandomValues(bytes);
  const code=String(bytes[0]%1000000).padStart(6,'0'),hash=await hmac(telegramBotToken(env),id,code);
  await env.DB.batch([
    env.DB.prepare('UPDATE telegram_pairings SET cancelled_at=? WHERE owner_username=? AND consumed_at IS NULL AND cancelled_at IS NULL').bind(now,account.username),
    env.DB.prepare('INSERT INTO telegram_pairings(request_id,owner_username,code_hash,bot_username,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind(id,account.username,hash,bot.username,now,now+TTL),
  ]);
  const payload=id.replaceAll('-','')+'_'+code;
  return {id,status:'pending',expires_at:now+TTL,bot_username:bot.username,code,command:'/start '+payload,bot_url:`https://t.me/${bot.username}?start=${payload}`};
}
async function ownedPair(env,id,account){const row=await env.DB.prepare('SELECT * FROM telegram_pairings WHERE request_id=? AND owner_username=?').bind(id,account.username).first();
  if(!row)throw new TelegramRecipientError(404,'Không tìm thấy yêu cầu kết nối của tài khoản này.');return row;}
export async function pollConnections(env,send=fetch){
  if(!telegramBotToken(env))return;
  const now=Date.now(),token=crypto.randomUUID();
  const pending=await env.DB.prepare('SELECT 1 AS present FROM telegram_pairings WHERE expires_at>? AND consumed_at IS NULL AND cancelled_at IS NULL AND candidate_chat_id IS NULL LIMIT 1').bind(now).first();
  if(!pending)return;
  const lock=await env.DB.prepare(`INSERT INTO telegram_poll_lock VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE expires_at<=? RETURNING token`).bind(token,now+15000,now).first();
  if(!lock)return;
  try{
    const cursor=await env.DB.prepare('SELECT next_offset FROM telegram_update_cursor WHERE id=1').first(),offset=cursor?.next_offset??0;
    const updates=await telegram(env,'getUpdates',{offset,limit:100,timeout:0,allowed_updates:['message']},send);
    if(!Array.isArray(updates))throw new TelegramRecipientError(503,'Telegram trả về dữ liệu chưa hợp lệ.');
    let next=offset;
    for(const update of updates){
      if(!Number.isSafeInteger(update?.update_id)||update.update_id<next)continue;next=update.update_id+1;
      const m=update.message,c=m?.chat;
      if(c?.type!=='private'||!Number.isSafeInteger(c.id)||c.id<=0||m.from?.id!==c.id||typeof m.text!=='string')continue;
      const match=/^\/start(?:@([a-zA-Z0-9_]+))?\s+([a-f0-9]{32})_(\d{6})$/i.exec(m.text.trim());if(!match)continue;
      const hex=match[2].toLowerCase(),id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
      const pair=await env.DB.prepare('SELECT * FROM telegram_pairings WHERE request_id=? AND expires_at>? AND consumed_at IS NULL AND cancelled_at IS NULL AND candidate_chat_id IS NULL AND attempts<10').bind(id,now).first();
      if(!pair||!Number.isFinite(m.date)||m.date*1000<pair.created_at-1000||m.date*1000>now+60000||match[1]&&match[1].toLowerCase()!==pair.bot_username.toLowerCase())continue;
      if(await hmac(telegramBotToken(env),id,match[3])!==pair.code_hash){await env.DB.prepare('UPDATE telegram_pairings SET attempts=attempts+1,cancelled_at=CASE WHEN attempts>=9 THEN ? ELSE NULL END WHERE request_id=?').bind(now,id).run();continue;}
      const name=[c.first_name,c.last_name].filter(n=>typeof n==='string').join(' ').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,100);
      const username=/^[a-zA-Z0-9_]{5,32}$/.test(c.username??'')?'@'+c.username:'';
      await env.DB.prepare('UPDATE telegram_pairings SET candidate_chat_id=?,candidate_name=?,matched_at=? WHERE request_id=? AND consumed_at IS NULL AND cancelled_at IS NULL AND candidate_chat_id IS NULL')
        .bind(String(c.id),[name,username].filter(Boolean).join(' · ')||'Người dùng Telegram',now,id).run();
    }
    await env.DB.prepare('INSERT INTO telegram_update_cursor VALUES(1,?) ON CONFLICT(id) DO UPDATE SET next_offset=max(next_offset,excluded.next_offset)').bind(next).run();
  }catch(error){await env.DB.prepare('UPDATE telegram_poll_lock SET expires_at=? WHERE token=?').bind(Date.now()+5000,token).run();throw error;}
}
export async function pollPairing(env,id,account=ADMIN,send=fetch){await ownedPair(env,id,account);await pollConnections(env,send);return publicPair(await ownedPair(env,id,account));}
export async function confirmPairing(env,id,account=ADMIN){
  const pair=await ownedPair(env,id,account),now=Date.now();
  if(pair.consumed_at||pair.cancelled_at||pair.expires_at<=now||!pair.candidate_chat_id)throw new TelegramRecipientError(409,'Yêu cầu chưa thể xác nhận hoặc đã hết hạn.');
  const existing=await env.DB.prepare('SELECT owner_username FROM telegram_recipients WHERE chat_id=?').bind(pair.candidate_chat_id).first();
  if(existing&&existing.owner_username!==account.username&&account.role!=='admin')throw new TelegramRecipientError(409,'Chat này đã liên kết với tài khoản web khác.');
  if(account.role!=='admin'&&await env.DB.prepare('SELECT 1 AS present FROM telegram_recipients WHERE owner_username=? AND chat_id!=?').bind(account.username,pair.candidate_chat_id).first())throw new TelegramRecipientError(409,'Tài khoản này đã có một chat Telegram. Liên hệ quản trị viên nếu cần đổi.');
  const recipientId=crypto.randomUUID().replaceAll('-','');
  const [accepted]=await env.DB.batch([
    env.DB.prepare('UPDATE telegram_pairings SET consumed_at=? WHERE request_id=? AND consumed_at IS NULL AND cancelled_at IS NULL AND expires_at>? RETURNING request_id').bind(now,id,now),
    env.DB.prepare(`INSERT INTO telegram_recipients(id,chat_id,owner_username,display_name,connected_at,updated_at)
      SELECT ?,candidate_chat_id,owner_username,candidate_name,?,? FROM telegram_pairings WHERE request_id=? AND consumed_at=? AND changes()>0
      ON CONFLICT(chat_id) DO UPDATE SET display_name=excluded.display_name,enabled=1,delivery_state='pending',updated_at=excluded.updated_at
      WHERE telegram_recipients.owner_username=excluded.owner_username OR ?=1`)
      .bind(recipientId,now,now,id,now,Number(account.role==='admin')),
    env.DB.prepare(`INSERT INTO telegram_deliveries(event_key,recipient_id,kind,text,created_at,next_attempt_at)
      SELECT ?,r.id,'connection',?,?,? FROM telegram_recipients r JOIN telegram_pairings p ON r.chat_id=p.candidate_chat_id
      WHERE p.request_id=? AND p.consumed_at=? AND changes()>0 ON CONFLICT DO NOTHING`)
      .bind('connection:'+id,'✅ PTIT Garden · Đã nhận kết nối\nBạn đã kết nối thành công với hệ thống cảnh báo của vườn. Bot sẽ gửi cảnh báo sâu hại, nguy cơ bệnh và môi trường. Bạn có thể tạm dừng nhận trong mục Telegram trên web.',now,now,id,now),
  ]);
  if(!accepted.results.length)throw new TelegramRecipientError(409,'Yêu cầu này vừa được xử lý.');
  const owner=await env.DB.prepare('SELECT owner_username FROM telegram_recipients WHERE chat_id=?').bind(pair.candidate_chat_id).first();
  if(!owner||account.role!=='admin'&&owner.owner_username!==account.username)throw new TelegramRecipientError(409,'Chat này đã được liên kết ở tài khoản khác.');
  return pairingStatus(env,account);
}
export async function cancelPairing(env,id,account=ADMIN){await ownedPair(env,id,account);await env.DB.prepare('UPDATE telegram_pairings SET cancelled_at=? WHERE request_id=? AND consumed_at IS NULL').bind(Date.now(),id).run();return pairingStatus(env,account);}

export async function enqueueDeliveries(db,now=Date.now()){
  // Snapshot eligible recipients at event time. Newly connected/reenabled users never receive old alerts.
  const eligible="r.enabled=1 AND r.delivery_state!='blocked' AND r.updated_at<=e.event_at";
  const prefix='🌿 PTIT Garden · ';
  await db.batch([
    db.prepare(`INSERT INTO telegram_deliveries(event_key,recipient_id,kind,text,created_at,next_attempt_at)
      SELECT 'env:'||e.id,r.id,'environment',?||e.title||char(10)||e.message,e.event_at,? FROM
        (SELECT id,title,message,triggered_at AS event_at FROM cloud_alerts WHERE triggered_at BETWEEN ? AND ?) e
      CROSS JOIN telegram_recipients r WHERE ${eligible} ON CONFLICT DO NOTHING`).bind(prefix,now,now-DAY,now),
    db.prepare(`INSERT INTO telegram_deliveries(event_key,recipient_id,kind,text,created_at,next_attempt_at)
      SELECT 'health:'||e.id,r.id,'health',?||e.title||char(10)||e.message,e.event_at,? FROM
        (SELECT id,title,message,triggered_at AS event_at FROM plant_health_alerts a WHERE triggered_at BETWEEN ? AND ?
          AND (kind!='pest' OR image_id IS NOT NULL AND EXISTS(SELECT 1 FROM images i WHERE i.image_id=a.image_id AND i.deleted_at IS NULL))) e
      CROSS JOIN telegram_recipients r WHERE ${eligible} ON CONFLICT DO NOTHING`).bind(prefix,now,now-DAY,now),
    db.prepare(`INSERT INTO telegram_deliveries(event_key,recipient_id,kind,text,created_at,next_attempt_at)
      SELECT 'startup:'||e.id,r.id,'startup','🟢 PTIT Garden · Trạm khởi động'||char(10)||'Trạm station-001 đã khởi động và kết nối Cloudflare.',e.event_at,? FROM
        (SELECT id,received_at AS event_at FROM station_startups WHERE received_at BETWEEN ? AND ?) e
      CROSS JOIN telegram_recipients r WHERE ${eligible} ON CONFLICT DO NOTHING`).bind(now,now-DAY,now),
  ]);
}
async function enqueueTestMessage(env,id,requestId,text,account){
  const row=await ownedRecipient(env,id,account);
  if(!row.enabled)throw new TelegramRecipientError(409,'Kết nối đang tạm dừng. Hãy bật nhận trước.');
  if(row.delivery_state==='blocked')throw new TelegramRecipientError(409,'Hãy mở bot, bấm Start rồi bật nhận lại trước khi thử gửi.');
  const key='test:'+requestId.toLowerCase();
  const existing=await env.DB.prepare('SELECT 1 AS present FROM telegram_deliveries WHERE event_key=? AND recipient_id=?').bind(key,id).first();
  if(existing)return {event_key:key,recipient_id:id};
  const recent=await env.DB.prepare("SELECT created_at FROM telegram_deliveries WHERE recipient_id=? AND kind='test' ORDER BY created_at DESC LIMIT 1").bind(id).first();
  if(recent&&recent.created_at>Date.now()-30000)throw new TelegramRecipientError(429,'Chờ 30 giây trước khi gửi thử lại.');
  const now=Date.now();
  await env.DB.prepare(`INSERT INTO telegram_deliveries(event_key,recipient_id,kind,text,created_at,next_attempt_at)
    VALUES(?,?,'test',?,?,?) ON CONFLICT DO NOTHING`).bind(key,id,text,now,now).run();return {event_key:key,recipient_id:id};
}
export async function enqueueRecipientTest(env,id,body,account=ADMIN){
  if(!UUID.test(body?.request_id??'')||Object.keys(body).join()!=='request_id')throw new TelegramRecipientError(422,'Mã tin thử không hợp lệ.');
  return enqueueTestMessage(env,id,body.request_id,'🧪 CẢNH BÁO THỬ · PTIT Garden\nĐây là tin thử do bạn yêu cầu.\nTình huống giả định: AI gợi ý có ngài đục quả trong ảnh bẫy. Vết đục của sâu non có thể gây thối quả thứ cấp. Kiểm tra lỗ đục, phân sâu và vùng thối trên quả.\nĐây không phải thông báo phát hiện sâu/bệnh thực tế.',account);
}
export async function enqueueDemoResultTest(env,id,body,account=ADMIN){
  const samples={cn_01:'Bẫy có ngài cuốn lá',pl_01:'Bẫy có ngài sâu tơ',os_01:'Bẫy có ngài đục thân ngô'};
  if(!body||Object.keys(body).length!==4||!['request_id','sample_id','model_version','counts'].every(k=>Object.hasOwn(body,k))||
    !UUID.test(body.request_id??'')||!Object.hasOwn(samples,body.sample_id)||!/^[a-zA-Z0-9_.-]{1,120}$/.test(body.model_version??'')||
    !body.counts||typeof body.counts!=='object'||Array.isArray(body.counts)||Object.keys(body.counts).length>7||
    Object.entries(body.counts).some(([code,n])=>!(code==='unknown'||Object.hasOwn(Knowledge.pests,code))||!Number.isSafeInteger(n)||n<0||n>300)){
    throw new TelegramRecipientError(422,'Kết quả ảnh mẫu không hợp lệ. Hãy phân tích lại ảnh mẫu.');
  }
  const total=Object.values(body.counts).reduce((s,n)=>s+n,0),unknown=body.counts.unknown??0;
  if(total>300)throw new TelegramRecipientError(422,'Số đếm ảnh mẫu vượt giới hạn.');
  const known=Object.entries(body.counts).filter(([code,n])=>code!=='unknown'&&n>0);
  const text=`🧪 CẢNH BÁO THỬ TỪ ẢNH MẪU · PTIT Garden\nẢnh mẫu RicePest-30: ${samples[body.sample_id]}\n`+
    `Kết quả trình duyệt: tổng ${total} côn trùng; gợi ý được loài ${total-unknown}; chưa xác định ${unknown}.\n`+
    known.map(([code,n])=>`${Knowledge.pests[code].name}: ${n} · Ký chủ: ${Knowledge.pests[code].hosts}`).join('\n')+
    (known.some(([code])=>Knowledge.pests[code].fruit)?'\nNguy cơ tham khảo: vết đục của sâu non có thể gây thối quả thứ cấp; cần xác nhận loài và kiểm tra quả.':'\nChưa có căn cứ suy ra bệnh cây ăn quả từ các loài trong kết quả này.')+
    `\n${unknown} đối tượng chưa xác định không được tự coi là sâu hại.\nModel: ${body.model_version}\n`+
    'ĐÂY LÀ TIN THỬ từ kết quả ảnh mẫu trên trình duyệt, không phải cảnh báo phát hiện sâu/bệnh tại vườn.';
  return enqueueTestMessage(env,id,body.request_id,text,account);
}
export async function deliveryReceipt(env,key,id,account=ADMIN){await ownedRecipient(env,id,account);const row=await env.DB.prepare('SELECT attempts,sent_at,failed_at,error_code,message_id,bot_username FROM telegram_deliveries WHERE event_key=? AND recipient_id=?').bind(key,id).first();return row??null;}

export async function flushDeliveries(env,send=fetch,{limit=20,recipientId=null}={}){
  if(!telegramBotToken(env))return;
  const db=env.DB,now=Date.now();
  await db.prepare('UPDATE telegram_deliveries SET lease_token=NULL WHERE next_attempt_at<=? AND lease_token IS NOT NULL').bind(now).run();
  await db.prepare('UPDATE telegram_deliveries SET failed_at=?,lease_token=NULL WHERE sent_at IS NULL AND failed_at IS NULL AND (attempts>=5 OR created_at<?) AND next_attempt_at<=?').bind(now,now-DAY,now).run();
  let bot;
  for(let offset=0;offset<limit;offset+=5){
    const jobs=[];
    for(let n=0;n<Math.min(5,limit-offset);n++){
      const lease=crypto.randomUUID();
      const job=await db.prepare(`UPDATE telegram_deliveries SET attempts=attempts+1,lease_token=?,next_attempt_at=?
        WHERE (event_key,recipient_id)=(SELECT d.event_key,d.recipient_id FROM telegram_deliveries d JOIN telegram_recipients r ON r.id=d.recipient_id
          WHERE d.sent_at IS NULL AND d.failed_at IS NULL AND d.attempts<5 AND d.next_attempt_at<=? AND r.enabled=1 AND r.delivery_state!='blocked'
          AND (? IS NULL OR r.id=?) AND NOT EXISTS(SELECT 1 FROM telegram_deliveries busy WHERE busy.recipient_id=d.recipient_id AND busy.lease_token IS NOT NULL)
          AND (d.kind!='health' OR EXISTS(SELECT 1 FROM plant_health_alerts a WHERE d.event_key='health:'||a.id
            AND (a.kind!='pest' OR EXISTS(SELECT 1 FROM images i WHERE i.image_id=a.image_id AND i.deleted_at IS NULL))))
          ORDER BY CASE d.kind WHEN 'connection' THEN 0 WHEN 'test' THEN 1 ELSE 2 END,d.created_at LIMIT 1)
        RETURNING event_key,recipient_id,text,attempts`).bind(lease,Date.now()+90000,Date.now(),recipientId,recipientId).first();
      if(job)jobs.push({...job,lease});
    }
    if(!jobs.length)break;
    await Promise.all(jobs.map(async job=>{
      let success=false,code=0,permanent=false,messageId=null,delay=60000*2**(job.attempts-1),username=null;
      try{
        bot??=botIdentity(env,send);const identity=await bot;username=identity.username;
        const recipient=await db.prepare('SELECT chat_id FROM telegram_recipients WHERE id=? AND enabled=1').bind(job.recipient_id).first();
        if(!recipient)throw new TelegramRecipientError(409,'Recipient paused');
        const result=await telegram(env,'sendMessage',{chat_id:recipient.chat_id,text:job.text.slice(0,4000),link_preview_options:{is_disabled:true}},send);
        if(!Number.isSafeInteger(result?.message_id)||result.message_id<=0||String(result.chat?.id)!==recipient.chat_id||result.from?.id!==identity.id)throw new TelegramRecipientError(503,'Telegram chưa trả về biên nhận hợp lệ.');
        messageId=result.message_id;success=true;
      }catch(error){code=Number(error.code)||0;permanent=code>=300&&code<500&&code!==408&&code!==429;
        delay=Math.max(delay,Math.min(error.retryAfter||0,86400)*1000);}
      const finished=Date.now();
      await db.batch([
        db.prepare(`UPDATE telegram_deliveries SET sent_at=CASE WHEN ? THEN ? ELSE NULL END,failed_at=CASE WHEN ? OR (NOT ? AND attempts>=5) THEN ? ELSE NULL END,
          message_id=?,bot_username=?,error_code=?,next_attempt_at=?,lease_token=NULL WHERE event_key=? AND recipient_id=? AND lease_token=?`)
          .bind(Number(success),finished,Number(permanent),Number(success),finished,messageId,username,code||null,finished+delay,job.event_key,job.recipient_id,job.lease),
        db.prepare(`UPDATE telegram_recipients SET delivery_state=?,last_sent_at=CASE WHEN ? THEN ? ELSE last_sent_at END,
          last_error_code=?,last_error_at=CASE WHEN ? THEN NULL ELSE ? END WHERE id=?`)
          .bind(success?'ready':code===403?'blocked':'error',Number(success),finished,code||null,Number(success),finished,job.recipient_id),
      ]);
    }));
  }
}
export async function pruneDeliveries(env,now){await env.DB.batch([
  env.DB.prepare('DELETE FROM telegram_deliveries WHERE created_at<? AND (sent_at IS NOT NULL OR failed_at IS NOT NULL)').bind(now-7*DAY),
  env.DB.prepare('DELETE FROM telegram_pairings WHERE created_at<?').bind(now-DAY),
]);}
