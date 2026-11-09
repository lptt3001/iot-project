const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_ATTEMPTS=5, LEASE_MS=90_000;

export class StationStartupError extends Error {
  constructor(message){super(message);this.status=422;}
}

export async function recordStationStartup(db, settings, body, now=Date.now()) {
  if(typeof body?.boot_id!=='string'||!UUID.test(body.boot_id)||Object.keys(body).some(key=>key!=='boot_id')){
    throw new StationStartupError('Mã khởi động trạm không hợp lệ.');
  }
  const id=body.boot_id.toLowerCase();
  const result=await db.prepare(`INSERT INTO station_startups (id,received_at,chat_id,next_attempt_at)
    VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(id,now,settings?.chatId??null,now).run();
  return {boot_id:id,duplicate:result.meta.changes===0,telegram_configured:Boolean(settings)};
}

export async function flushStationStartups(db, settings, send=fetch) {
  if(!settings)return;
  const now=Date.now(),lease=crypto.randomUUID();
  await db.prepare(`UPDATE station_startups SET failed_at=?,lease_token=NULL
    WHERE sent_at IS NULL AND failed_at IS NULL AND attempts>=? AND next_attempt_at<=?`)
    .bind(now,MAX_ATTEMPTS,now).run();
  const row=await db.prepare(`UPDATE station_startups
    SET attempts=attempts+1,lease_token=?,next_attempt_at=?
    WHERE id=(SELECT id FROM station_startups WHERE chat_id=? AND sent_at IS NULL AND failed_at IS NULL
      AND attempts<? AND next_attempt_at<=? ORDER BY received_at,id LIMIT 1)
    RETURNING id,received_at,attempts`).bind(lease,now+LEASE_MS,settings.chatId,MAX_ATTEMPTS,now).first();
  if(!row)return;
  const local=new Date(row.received_at+7*3600000).toISOString().slice(0,19).replace('T',' ');
  const text=`🟢 PTIT Garden · Trạm khởi động\nTrạm station-001 đã khởi động và kết nối Cloudflare.\nNhận lúc ${local} (UTC+7).`;
  let ok=false,permanent=false,retryMs=0;
  try{
    const response=await send(`https://api.telegram.org/bot${settings.token}/sendMessage`,{
      method:'POST',headers:{'Content-Type':'application/json'},redirect:'manual',signal:AbortSignal.timeout(20000),
      body:JSON.stringify({chat_id:settings.chatId,text,disable_web_page_preview:true}),
    });
    const body=await response.json().catch(()=>null);
    ok=response.ok&&body?.ok===true;
    const code=Number(body?.error_code)||response.status;
    permanent=!ok&&code>=300&&code<500&&code!==408&&code!==429;
    const seconds=Number(body?.parameters?.retry_after);
    if(code===429&&Number.isFinite(seconds)&&seconds>0)retryMs=Math.min(seconds,86400)*1000;
  }catch{/* A timeout may have reached Telegram; retries cannot guarantee exactly-once delivery. */}
  const finished=Date.now();
  if(ok){
    await db.prepare('UPDATE station_startups SET sent_at=?,lease_token=NULL WHERE id=? AND lease_token=?')
      .bind(finished,row.id,lease).run();
  }else{
    await db.prepare(`UPDATE station_startups SET failed_at=CASE WHEN ? OR attempts>=? THEN ? ELSE NULL END,
      next_attempt_at=?,lease_token=NULL WHERE id=? AND lease_token=?`)
      .bind(Number(permanent),MAX_ATTEMPTS,finished,finished+Math.max(retryMs,60000*2**(row.attempts-1)),row.id,lease).run();
  }
}

export function pruneStationStartups(db,now){
  return db.prepare('DELETE FROM station_startups WHERE received_at<?').bind(now-7*86400000).run();
}
