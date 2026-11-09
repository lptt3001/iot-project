const DAY=86400000, OFFSET=7*3600000, LEASE=240000;
import {Knowledge,pestHealthAlertInsert} from './plant-health.js';
export const AUTOMATION_CRON='*/5 * * * *';
const SPECIES={
  Cnaphalocrocis_medinalis:'Sâu cuốn lá lúa (ngài)',
  Plutella_xylostella:'Sâu tơ (ngài)',
  Ostrinia_furnacalis:'Sâu đục thân ngô (ngài)',
  Scotinophara_coarctata:'Bọ xít đen',
  Conogethes_punctiferalis:'Sâu đục quả (ngài)',
  Diaphania_indica:'Sâu xanh hại dưa (ngài)',
};

// UTC midnight is 07:00 in Vietnam. The five-minute cron also covers a delayed trigger.
// One durable row per day prevents duplicate commands when two cron events overlap.
export async function scheduleMorningCapture(db,now=Date.now()) {
  const local=new Date(now+OFFSET),minute=local.getUTCHours()*60+local.getUTCMinutes();
  if(minute<420||minute>=435)return false;
  const day=local.toISOString().slice(0,10),id=crypto.randomUUID();
  const [,saved]=await db.batch([
    db.prepare(`UPDATE camera_requests SET status='failed',error_code=CASE WHEN status='queued' THEN 'offline' ELSE 'timeout' END
      WHERE status IN ('queued','sent') AND expires_at<=?`).bind(now),
    db.prepare(`INSERT INTO daily_captures(day,request_id,created_at)
      SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM camera_requests WHERE status IN ('queued','sent'))
      ON CONFLICT(day) DO NOTHING`).bind(day,id,now),
    db.prepare(`INSERT INTO camera_requests(id,created_at,expires_at,status,requested_by)
      SELECT request_id,created_at,created_at+90000,'queued',NULL FROM daily_captures WHERE day=? AND request_id=?
      ON CONFLICT DO NOTHING`).bind(day,id),
  ]);
  return saved.meta.changes>0;
}

export async function automationStatus(env) {
  const db=env.DB;
  const [daily,queue,last]=await Promise.all([
    db.prepare(`SELECT d.day,c.status,c.error_code FROM daily_captures d JOIN camera_requests c ON c.id=d.request_id
      ORDER BY d.day DESC LIMIT 1`).first(),
    db.prepare(`SELECT count(*) AS pending FROM image_analysis a JOIN images i USING(image_id)
      WHERE i.deleted_at IS NULL AND a.status IN ('queued','running')`).first(),
    db.prepare(`SELECT a.image_id,a.status,a.error_message,a.completed_at FROM image_analysis a JOIN images i USING(image_id)
      WHERE i.deleted_at IS NULL ORDER BY a.created_at DESC LIMIT 1`).first(),
  ]);
  return {capture_time:'07:00',timezone:'Asia/Ho_Chi_Minh',cloud_ai:Boolean(env.BROWSER),daily,
    pending:queue.pending,last,notice:'Trạm cần bật và có Wi-Fi lúc 07:00. Cảm biến báo mưa sẽ tạm dừng chụp. Ảnh camera mới được phân tích tự động; chỉ gửi Telegram khi gợi ý được loài sâu hại.'};
}

// Short-lived capability: grants read access only to this job's image and AI assets.
// It cannot read the dashboard, other photos, user accounts, or mutate results.
export async function analysisCapability(request,db,now=Date.now()) {
  const value=/(?:^|;\s*)__Host-ptit_ai=([a-f0-9-]{36})\.([a-f0-9-]{36})(?:;|$)/i.exec(request.headers.get('Cookie')||'');
  if(!value)return null;
  return db.prepare(`SELECT a.image_id FROM image_analysis a JOIN images i USING(image_id)
    WHERE a.image_id=? AND a.lease_token=? AND a.status='running' AND a.next_attempt_at>? AND i.deleted_at IS NULL`)
    .bind(value[1],value[2],now).first('image_id');
}

export function analysisPage(id) {
  // id has already been checked against the UUID route and active capability.
  return new Response(`<!doctype html><meta charset="utf-8"><title>PTIT AI processing</title><script>
    window.analysisState={status:'running'};
    const worker=new Worker('/static/ai-inference.js');
    const deadline=setTimeout(()=>{worker.terminate();window.analysisState={status:'error',message:'AI timeout'}},180000);
    worker.onmessage=({data})=>{if(data.type==='result'||data.type==='error'){
      clearTimeout(deadline);window.analysisState={status:data.type,...data};worker.terminate();}};
    worker.onerror=()=>{clearTimeout(deadline);window.analysisState={status:'error',message:'AI worker error'};worker.terminate()};
    worker.postMessage({id:1,imageUrl:'/media/${id}'});
    </script>`,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
      'Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; worker-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"}});
}

export async function inferInCloud(env,job) {
  const {default:puppeteer}=await import('@cloudflare/puppeteer');
  const origin=new URL(env.APP_ORIGIN);
  const browser=await puppeteer.launch(env.BROWSER,{keep_alive:60000});
  try{
    const page=await browser.newPage();
    await page.setCookie({name:'__Host-ptit_ai',value:job.image_id+'.'+job.lease_token,
      domain:origin.hostname,path:'/',secure:true,httpOnly:true,sameSite:'Strict',expires:Math.floor(job.next_attempt_at/1000)});
    await page.goto(new URL('/internal/ai/'+job.image_id,origin).href,{waitUntil:'load',timeout:30000});
    await page.waitForFunction(()=>window.analysisState?.status!=='running',{timeout:190000,polling:1000});
    const result=await page.evaluate(()=>window.analysisState);
    if(result?.status!=='result')throw Error('Cloud AI could not process the image');
    return result;
  }finally{await browser.close();}
}

export function validateResult(result) {
  if(!result||!Number.isSafeInteger(result.width)||!Number.isSafeInteger(result.height)||result.width<1||result.height<1||
    typeof result.model_version!=='string'||result.model_version.length>120||!Array.isArray(result.detections)||result.detections.length>300)throw Error('Invalid AI result');
  for(const d of result.detections){
    if(!d||!(d.pest_code==='unknown'||Object.hasOwn(SPECIES,d.pest_code))||
      !['unknown','identified'].includes(d.identification_status)||
      (d.identification_status==='identified')!==(d.pest_code!=='unknown')||
      !['confidence','x_min','y_min','x_max','y_max'].every(k=>Number.isFinite(d[k])&&d[k]>=0&&d[k]<=1)||
      d.x_min>=d.x_max||d.y_min>=d.y_max||d.pest_code!=='unknown'&&d.confidence<.7)throw Error('Invalid AI detection');
  }
  return {...result,total_count:result.detections.length,
    identified_count:result.detections.filter(d=>d.pest_code!=='unknown').length,
    unknown_count:result.detections.filter(d=>d.pest_code==='unknown').length};
}

export function pestMessage(result,receivedAt,origin) {
  const counts={};for(const d of result.detections)if(d.pest_code!=='unknown')counts[d.pest_code]=(counts[d.pest_code]||0)+1;
  const local=new Date(receivedAt+OFFSET).toISOString().slice(0,19).replace('T',' ');
  return `🐛 PTIT Garden · Phát hiện nghi sâu hại\nTrạm station-001 · Ảnh nhận ${local} (UTC+7)\n`+
    Object.entries(counts).map(([code,n])=>`${SPECIES[code]}: ${n}`).join('\n')+
    (result.unknown_count?`\nCôn trùng chưa xác định: ${result.unknown_count}`:'')+
    `\n\n${Knowledge.pestAdviceText(result.detections).slice(0,2600)}`+
    (counts.Conogethes_punctiferalis?`\nNguồn về thối thứ cấp sau vết đục: ${Knowledge.pests.Conogethes_punctiferalis.related_url}`:'')+
    `\nAI chỉ gợi ý loài, cần kiểm tra thực tế; không khẳng định cây bị bệnh.\nXem ảnh và nguồn tham khảo: ${origin}/#images`;
}

export async function runAutomaticAnalysis(env,settings,infer=inferInCloud,now=Date.now()) {
  if(!env.BROWSER||!env.APP_ORIGIN)return {skipped:'unconfigured'};
  const db=env.DB,token=crypto.randomUUID();
  const lock=await db.prepare(`INSERT INTO automation_lock(id,token,expires_at) VALUES(1,?,?)
    ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE expires_at<=?
    RETURNING token`).bind(token,now+LEASE,now).first();
  if(!lock)return {skipped:'busy'};
  let job;
  try{
    await db.prepare(`UPDATE image_analysis SET status='failed',lease_token=NULL,error_message='Phân tích tự động chưa thành công sau 3 lần thử.'
      WHERE status IN ('queued','running') AND attempts>=3 AND next_attempt_at<=?`).bind(now).run();
    job=await db.prepare(`UPDATE image_analysis SET status='running',attempts=attempts+1,lease_token=?,next_attempt_at=?
      WHERE image_id=(SELECT a.image_id FROM image_analysis a JOIN images i USING(image_id)
        WHERE a.status IN ('queued','running') AND a.attempts<3 AND a.next_attempt_at<=? AND i.deleted_at IS NULL
        ORDER BY a.created_at LIMIT 1) RETURNING image_id,lease_token,next_attempt_at,
          (SELECT received_at FROM images WHERE images.image_id=image_analysis.image_id) AS received_at`)
      .bind(token,now+LEASE,now).first();
    if(!job)return {skipped:'empty'};
    const result=validateResult(await infer(env,job)),finished=Date.now();
    const message=pestMessage(result,job.received_at,env.APP_ORIGIN);
    // Persist the result and its alert together. Deleted photos never produce a new alert.
    await db.batch([
      pestHealthAlertInsert(db,job,result,message,finished),
      db.prepare(`INSERT INTO pest_notifications(image_id,created_at,chat_id,text,next_attempt_at)
        SELECT a.image_id,?, ?, ?, ? FROM image_analysis a JOIN images i USING(image_id)
        WHERE a.image_id=? AND a.status='running' AND a.lease_token=? AND i.deleted_at IS NULL AND ?>0 AND ? IS NOT NULL
        ON CONFLICT(image_id) DO NOTHING`).bind(finished,settings?.chatId??null,
          message,finished,job.image_id,token,result.identified_count,settings?.chatId??null),
      db.prepare(`UPDATE image_analysis SET status='succeeded',result=?,completed_at=?,error_message=NULL,lease_token=NULL
        WHERE image_id=? AND lease_token=?`).bind(JSON.stringify(result),finished,job.image_id,token),
    ]);
    return {image_id:job.image_id,status:'succeeded',total:result.total_count,identified:result.identified_count};
  }catch(error){
    if(job)await db.prepare(`UPDATE image_analysis SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
      lease_token=NULL,error_message='Chưa phân tích tự động được ảnh. Hệ thống sẽ thử lại hoặc bạn có thể phân tích trên web.',next_attempt_at=?
      WHERE image_id=? AND lease_token=?`).bind(Date.now()+300000,job.image_id,token).run();
    console.error('Automatic AI failed',error?.message?.slice(0,160));
    return {image_id:job?.image_id,status:'retry'};
  }finally{
    await db.prepare('DELETE FROM automation_lock WHERE id=1 AND token=?').bind(token).run();
  }
}

export async function flushPestNotifications(db,settings,send=fetch) {
  if(!settings)return;
  const now=Date.now(),token=crypto.randomUUID();
  await db.prepare(`UPDATE pest_notifications SET failed_at=?,lease_token=NULL
    WHERE sent_at IS NULL AND failed_at IS NULL AND attempts>=5 AND next_attempt_at<=?`).bind(now,now).run();
  const row=await db.prepare(`UPDATE pest_notifications SET attempts=attempts+1,lease_token=?,next_attempt_at=?
    WHERE image_id=(SELECT n.image_id FROM pest_notifications n JOIN images i USING(image_id)
      WHERE n.chat_id=? AND n.sent_at IS NULL AND n.failed_at IS NULL AND n.attempts<5 AND n.next_attempt_at<=?
      AND i.deleted_at IS NULL ORDER BY n.created_at LIMIT 1) RETURNING image_id,text,attempts`)
    .bind(token,now+90000,settings.chatId,now).first();
  if(!row)return;
  let ok=false,permanent=false,delay=60000*2**(row.attempts-1);
  try{
    const response=await send(`https://api.telegram.org/bot${settings.token}/sendMessage`,{
      method:'POST',headers:{'Content-Type':'application/json'},redirect:'manual',signal:AbortSignal.timeout(20000),
      body:JSON.stringify({chat_id:settings.chatId,text:row.text,disable_web_page_preview:true})});
    const body=await response.json().catch(()=>null);ok=response.ok&&body?.ok===true;
    const code=Number(body?.error_code)||response.status;
    permanent=!ok&&code>=300&&code<500&&code!==408&&code!==429;
    if(code===429&&Number.isFinite(body?.parameters?.retry_after))delay=Math.max(delay,Math.min(86400,body.parameters.retry_after)*1000);
  }catch{/* Retry with a lease. Telegram cannot guarantee exactly-once after a transport timeout. */}
  const finished=Date.now();
  await db.prepare(`UPDATE pest_notifications SET sent_at=CASE WHEN ? THEN ? ELSE NULL END,
    failed_at=CASE WHEN ? OR (NOT ? AND attempts>=5) THEN ? ELSE NULL END,next_attempt_at=?,lease_token=NULL
    WHERE image_id=? AND lease_token=?`)
    .bind(Number(ok),finished,Number(permanent),Number(ok),finished,finished+delay,row.image_id,token).run();
}
