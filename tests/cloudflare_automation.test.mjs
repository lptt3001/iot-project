import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {scheduleMorningCapture,runAutomaticAnalysis,flushPestNotifications,analysisCapability,validateResult} from '../infra/cloudflare/src/automation.js';
import {cameraImageInsert} from '../infra/cloudflare/src/image-library.js';
import {imageData} from '../infra/cloudflare/src/dashboard-data.js';
import {Knowledge} from '../infra/cloudflare/src/plant-health.js';
import {enqueueDeliveries,flushDeliveries} from '../infra/cloudflare/src/telegram-recipients.js';
const settings={token:'123:unit-test-only',chatId:'456'};
const jpeg=Uint8Array.of(255,216,255,217);
function fixture(){
 const sql=new DatabaseSync(':memory:');
 for(const name of ['schema.sql','camera-requests.sql','automation.sql','plant-health.sql','alerts.sql','telegram.sql','telegram-pairing.sql','station-startups.sql','telegram-recipients.sql','observation-alerts.sql'])sql.exec(readFileSync(new URL('../infra/cloudflare/'+name,import.meta.url),'utf8'));
 function prepare(query,values=[]){return {
  bind:(...args)=>prepare(query,args),
  first:async column=>{const row=sql.prepare(query).get(...values);return column?row?.[column]??null:row??null;},
  all:async()=>({results:sql.prepare(query).all(...values)}),
  run:async()=>({meta:{changes:Number(sql.prepare(query).run(...values).changes)}}),
  _run:()=>{const stmt=sql.prepare(query);return stmt.columns().length?{results:stmt.all(...values),meta:{changes:sql.prepare('SELECT changes() AS n').get().n}}:{results:[],meta:{changes:Number(stmt.run(...values).changes)}};},
 };}
 const db={prepare,batch:async statements=>{sql.exec('BEGIN');try{const rows=statements.map(s=>s._run());sql.exec('COMMIT');return rows;}catch(error){sql.exec('ROLLBACK');throw error;}}};
 return {sql,db,env:{DB:db,BROWSER:{},APP_ORIGIN:'https://garden.test'},seed(id=crypto.randomUUID(),source='hardware'){
  sql.prepare('INSERT INTO images(image_id,received_at,jpeg,source) VALUES(?,?,?,?)').run(id,Date.now()-1000,jpeg,source);return id;
 }};
}
const identified={pest_code:'Conogethes_punctiferalis',identification_status:'identified',confidence:.81,x_min:.1,y_min:.2,x_max:.3,y_max:.4};
const unknown={...identified,pest_code:'unknown',identification_status:'unknown',confidence:.6};
const result=(detections=[])=>({width:640,height:480,model_version:'test-p2',detections});

test('automatic camera analysis sends additional species and opted-in unknown alerts to every recipient exactly once',async()=>{
 for(const [code,count] of [['Plutella_xylostella',2],['unknown',3]]){
  const f=fixture();try{
   const thresholds=Object.fromEntries(Object.keys(Knowledge.pestAlertSpecies).map(c=>[c,c===code?count:null]));
   f.sql.prepare("UPDATE observation_rules SET parameters=? WHERE crop_id='guava' AND id='pest_image'").run(JSON.stringify({species_thresholds:thresholds}));
   for(const [id,chat] of [['a','111111111'],['b','222222222']])f.sql.prepare('INSERT INTO telegram_recipients(id,chat_id,owner_username,display_name,connected_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,chat,'garden',id,Date.now()-10000,Date.now()-10000);
   f.env.TELEGRAM_BOT_TOKEN='123456:abcdefghijklmnopqrstuvwxyz123456789';
   f.seed();const detections=Array.from({length:count},()=>({...identified,pest_code:code,identification_status:code==='unknown'?'unknown':'identified'}));
   await runAutomaticAnalysis(f.env,null,async()=>result(detections));
   const alert=f.sql.prepare('SELECT * FROM plant_health_alerts').get();assert.ok(alert);
   assert.equal(JSON.parse(alert.details).matched_species[0].code,code);
   assert.match(alert.message,new RegExp(Knowledge.pestAlertSpecies[code]));
   await enqueueDeliveries(f.db);await enqueueDeliveries(f.db);
   assert.equal(f.sql.prepare("SELECT count(*) AS n FROM telegram_deliveries WHERE kind='health'").get().n,2);
   const sent=[];const sender=async(url,options)=>{
    if(new URL(url).pathname.endsWith('/getMe'))return Response.json({ok:true,result:{id:777,is_bot:true,username:'test_bot'}});
    const body=JSON.parse(options.body);sent.push(body.chat_id);
    return Response.json({ok:true,result:{message_id:sent.length,chat:{id:Number(body.chat_id)},from:{id:777}}});
   };
   await flushDeliveries(f.env,sender);await enqueueDeliveries(f.db);await flushDeliveries(f.env,sender);
   assert.deepEqual(sent.sort(),['111111111','222222222']);
  }finally{f.sql.close();}
 }
});

test('07:00 Vietnam schedule is durable, once daily, handles delayed cron, and never fires at 07:00 UTC',async()=>{
 const f=fixture();try{
  assert.equal(await scheduleMorningCapture(f.db,Date.parse('2026-11-09T23:59:59Z')),false);
  const morning=Date.parse('2026-11-10T00:00:00Z');
  const calls=await Promise.all([scheduleMorningCapture(f.db,morning),scheduleMorningCapture(f.db,morning)]);
  assert.equal(calls.filter(Boolean).length,1);
  assert.equal(await scheduleMorningCapture(f.db,morning+300000),false);
  assert.equal(await scheduleMorningCapture(f.db,morning+7*3600000),false);
  const request=f.sql.prepare('SELECT * FROM camera_requests').get();
  assert.equal(request.requested_by,null);assert.equal(request.expires_at,morning+90000);
  await cameraImageInsert(f.db,request.id,morning+10000,jpeg).run();
  const photo=(await imageData(f.db,new URLSearchParams(),request.id)).rows[0];
  assert.equal(photo.capture_origin,'automatic');assert.equal(photo.scheduled_day,'2026-11-10');
  f.sql.exec("UPDATE camera_requests SET status='succeeded'");
  assert.equal(await scheduleMorningCapture(f.db,morning+86400000+300000),true);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM daily_captures').get().n,2);
 }finally{f.sql.close();}
});

test('busy manual command is preserved; schedule can retry at 07:05 without issuing two commands',async()=>{
 const f=fixture();try{
  const now=Date.parse('2026-11-10T00:00:00Z');
  f.sql.prepare("INSERT INTO camera_requests VALUES(?,?,?,'queued',NULL,'garden')").run(crypto.randomUUID(),now-1000,now+10000);
  assert.equal(await scheduleMorningCapture(f.db,now),false);
  assert.equal(await scheduleMorningCapture(f.db,now+300000),true);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM camera_requests WHERE status='queued'").get().n,1);
 }finally{f.sql.close();}
});

test('only new hardware photos queue automatically; no migration flood, duplicate or upload jobs',()=>{
 const f=fixture();try{
  f.seed(undefined,'upload');const id=f.seed();
  f.sql.exec(readFileSync(new URL('../infra/cloudflare/automation.sql',import.meta.url),'utf8'));
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM image_analysis').get().n,1);
  assert.equal(f.sql.prepare('SELECT image_id FROM image_analysis').get().image_id,id);
 }finally{f.sql.close();}
});

test('concurrent cron claims only one job; capability only exists while that job is running',async()=>{
 const f=fixture();try{
  const id=f.seed();let calls=0,finish;
  const gate=new Promise(resolve=>finish=resolve);
  const first=runAutomaticAnalysis(f.env,settings,async(env,job)=>{
   calls++;assert.equal(job.image_id,id);
   const request=new Request('https://garden.test',{headers:{Cookie:`__Host-ptit_ai=${id}.${job.lease_token}`}});
   assert.equal(await analysisCapability(request,f.db),id);
   await gate;return result([identified]);
  });
  // Let the first caller acquire its lock and enter the injected inference.
  while(!calls)await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await runAutomaticAnalysis(f.env,settings,()=>assert.fail('must not infer'))).skipped,'busy');
  finish();assert.equal((await first).status,'succeeded');assert.equal(calls,1);
  const job=f.sql.prepare('SELECT * FROM image_analysis').get();assert.equal(job.lease_token,null);
  assert.equal((await runAutomaticAnalysis(f.env,settings,()=>assert.fail('completed job'))).skipped,'empty');
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM pest_notifications').get().n,1);
 }finally{f.sql.close();}
});

test('known pest result persists with boxes and one alert; replay cannot send twice',async()=>{
 const f=fixture();try{
  const id=f.seed();await runAutomaticAnalysis(f.env,settings,async()=>result([identified,unknown]));
  const row=(await imageData(f.db,new URLSearchParams(),id)).rows[0];
  assert.equal(row.status,'succeeded');assert.equal(row.pest_count,2);assert.equal(row.analysis.identified_count,1);
  const web=f.sql.prepare("SELECT image_id,message,details FROM plant_health_alerts WHERE kind='pest'").get();
  assert.equal(web.image_id,id);assert.equal(JSON.parse(web.details).advice[0].code,'Conogethes_punctiferalis');
  assert.match(web.message,/thối quả thứ cấp/);
  const outbox=f.sql.prepare('SELECT * FROM pest_notifications').get();assert.match(outbox.text,/Sâu đục quả/);assert.match(outbox.text,/không khẳng định/);
  let sends=0;const send=async(url,options)=>{sends++;assert.equal(JSON.parse(options.body).chat_id,settings.chatId);return Response.json({ok:true});};
  await Promise.all([flushPestNotifications(f.db,settings,send),flushPestNotifications(f.db,settings,send)]);
  await flushPestNotifications(f.db,settings,send);assert.equal(sends,1);
 }finally{f.sql.close();}
});

test('zero detections, unknown-only, unpaired Telegram and trashed photos do not notify',async()=>{
 for(const [detections,recipient] of [[[],settings],[[unknown],settings],[[identified],null]]){
  const f=fixture();try{f.seed();await runAutomaticAnalysis(f.env,recipient,async()=>result(detections));assert.equal(f.sql.prepare('SELECT count(*) AS n FROM pest_notifications').get().n,0);}finally{f.sql.close();}
 }
 const f=fixture();try{
  const id=f.seed();await runAutomaticAnalysis(f.env,settings,async()=>{f.sql.prepare('UPDATE images SET deleted_at=? WHERE image_id=?').run(Date.now(),id);return result([identified]);});
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM pest_notifications').get().n,0);
 }finally{f.sql.close();}
});

test('inference failures retry at most three times and never mark an error as zero pests',async()=>{
 const f=fixture();try{
  f.seed();for(let i=0;i<3;i++){
   f.sql.exec('UPDATE image_analysis SET next_attempt_at=0');
   assert.equal((await runAutomaticAnalysis(f.env,settings,async()=>{throw Error('unit-test failure');})).status,'retry');
  }
  const row=f.sql.prepare('SELECT * FROM image_analysis').get();assert.equal(row.status,'failed');assert.equal(row.result,null);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM pest_notifications').get().n,0);
  assert.equal((await runAutomaticAnalysis(f.env,settings,()=>assert.fail('retry exhaustion'))).skipped,'empty');
 }finally{f.sql.close();}
});

test('Telegram transient/429 errors retry, permanent errors stop, and deleted images cancel delivery',async()=>{
 const f=fixture();try{
  const id=f.seed();await runAutomaticAnalysis(f.env,settings,async()=>result([identified]));
  await flushPestNotifications(f.db,settings,async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:600}},{status:429}));
  let row=f.sql.prepare('SELECT * FROM pest_notifications').get();assert.equal(row.failed_at,null);assert.ok(row.next_attempt_at>Date.now()+590000);
  f.sql.exec('UPDATE pest_notifications SET next_attempt_at=0');
  await flushPestNotifications(f.db,settings,async()=>Response.json({ok:false,error_code:403},{status:403}));
  row=f.sql.prepare('SELECT * FROM pest_notifications').get();assert.ok(row.failed_at);assert.equal(row.sent_at,null);
  f.sql.exec('UPDATE pest_notifications SET next_attempt_at=0,failed_at=NULL');f.sql.prepare('UPDATE images SET deleted_at=1 WHERE image_id=?').run(id);
  await flushPestNotifications(f.db,settings,()=>assert.fail('trashed photo must not notify'));
 }finally{f.sql.close();}
});

test('malformed results and low-confidence species cannot create pest alerts',()=>{
 const sensitive=validateResult(result([{...unknown,confidence:.075}]));
 assert.equal(sensitive.unknown_count,1,'sensitive generic insect detections remain valid without inventing a species');
 assert.equal(sensitive.identified_count,0);
 assert.throws(()=>validateResult(result([{...identified,pest_code:'made-up'}])));
 assert.throws(()=>validateResult(result([{...identified,confidence:.499}])));
 assert.equal(validateResult(result([{...identified,confidence:.5}])).identified_count,1);
 assert.throws(()=>validateResult(result([{...identified,x_max:NaN}])));
 assert.throws(()=>validateResult(result([{...identified,identification_status:'unknown'}])));
});
