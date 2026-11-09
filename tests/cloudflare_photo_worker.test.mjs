import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
import worker from '../infra/cloudflare/src/worker.js';

// Cloudflare exposes this SubtleCrypto extension; Node uses the native equivalent.
crypto.subtle.timingSafeEqual??=(left,right)=>timingSafeEqual(Buffer.from(left),Buffer.from(right));

function fixture(){
 const sql=new DatabaseSync(':memory:');
 for(const name of ['schema.sql','camera-requests.sql','auth.sql','register.sql','telegram-pairing.sql','station-startups.sql','automation.sql','alerts.sql','telegram.sql','plant-health.sql','telegram-recipients.sql','observation-alerts.sql']){
  sql.exec(readFileSync(new URL('../infra/cloudflare/'+name,import.meta.url),'utf8'));
 }
 function prepare(query,values=[]){return {
  bind:(...args)=>prepare(query,args),
  first:async column=>{const row=sql.prepare(query).get(...values);return column?row?.[column]??null:row??null;},
  all:async()=>({results:sql.prepare(query).all(...values)}),
  run:async()=>({meta:{changes:Number(sql.prepare(query).run(...values).changes)}}),
  _run:()=>{
   const stmt=sql.prepare(query);
   if(stmt.columns().length){const results=stmt.all(...values);return {results,meta:{changes:sql.prepare('SELECT changes() AS n').get().n}};}
   return {results:[],meta:{changes:Number(stmt.run(...values).changes)}};
  },
 };}
 const db={prepare,batch:async statements=>{
  sql.exec('BEGIN');try{const results=statements.map(s=>s._run());sql.exec('COMMIT');return results;}
  catch(error){sql.exec('ROLLBACK');throw error;}
 }};
 const env={DB:db,DEVICE_TOKEN:'local-device-token',DASHBOARD_PASSWORD:'local-dashboard-password',DASHBOARD_LOGIN_LIMIT:{limit:async()=>({success:true})}};
 const request=(path,options={})=>worker.fetch(new Request('https://garden.test'+path,options),env,{waitUntil:()=>{throw Error('Unconfigured Telegram must not send');}});
 return {sql,env,request};
}
const jpeg=Uint8Array.of(255,216,255,0,255,217);
const device={Authorization:'Bearer local-device-token'};
async function login(f){
 const response=await f.request('/api/login',{method:'POST',headers:{'X-Garden-Request':'1','Content-Type':'application/json'},body:JSON.stringify({username:'garden',password:f.env.DASHBOARD_PASSWORD})});
 assert.equal(response.status,200,await response.clone().text());
 return {Cookie:response.headers.get('Set-Cookie').split(';')[0],'X-Garden-Request':'1'};
}

test('Worker derives photo actors from the session, distinguishes automatic captures, and protects upload/capture permissions',async()=>{
 const f=fixture();try{
  const headers=await login(f);
  const result=await f.request('/api/images/upload',{method:'POST',headers:{...headers,'Content-Type':'image/jpeg','X-Actor-Username':'spoofed'},body:jpeg});
  assert.equal(result.status,201);const uploaded=await result.json();
  let row=(await (await f.request('/api/images?id='+uploaded.id,{headers})).json()).rows[0];
  assert.equal(row.capture_origin,'upload');assert.equal(row.actor_username,'garden');
  await f.request('/device/v1/station-001/camera/next',{headers:device});
  const id=crypto.randomUUID();
  const capture=await f.request('/api/camera/requests',{method:'POST',headers:{...headers,'X-Garden-Capture-ID':id,'X-Actor-Username':'spoofed'}});
  assert.equal(capture.status,202,await capture.clone().text());
  await f.request('/device/v1/station-001/camera/next',{headers:device});
  const send=photo=>f.request('/device/v1/station-001/images/'+photo,{method:'PUT',headers:{...device,'Content-Type':'image/jpeg'},body:jpeg});
  assert.equal((await send(id)).status,201);
  row=(await (await f.request('/api/images?id='+id,{headers})).json()).rows[0];
  assert.equal(row.capture_origin,'manual');assert.equal(row.actor_username,'garden');
  const automatic=crypto.randomUUID();assert.equal((await send(automatic)).status,201);
  row=(await (await f.request('/api/images?id='+automatic,{headers})).json()).rows[0];
  assert.equal(row.capture_origin,'automatic');assert.equal(row.actor_username,null);
  const token='a'.repeat(64);
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`ptit-garden/session:${token}:${f.env.DASHBOARD_PASSWORD}`))).toString('hex');
  f.sql.prepare('INSERT INTO dashboard_accounts VALUES(?,?,?,?)').run('member','unused',Date.now(),Date.now());
  f.sql.prepare('INSERT INTO dashboard_member_sessions VALUES(?,?,?)').run(hash,Date.now()+60000,'member');
  const member={Cookie:'__Host-ptit_session='+token,'X-Garden-Request':'1'};
  assert.equal((await f.request('/api/images',{headers:member})).status,200);
  assert.equal((await f.request('/api/images/upload',{method:'POST',headers:{...member,'Content-Type':'image/jpeg'},body:jpeg})).status,403);
  assert.equal((await f.request('/api/camera/requests',{method:'POST',headers:member})).status,403);
  assert.equal((await f.request(`/api/images/${automatic}/analysis/claim`,{method:'POST',headers:member})).status,403);
 }finally{f.sql.close();}
});

test('Worker persists browser AI only through authenticated admin leases and bounded same-origin JSON',async()=>{
 const f=fixture();try{
  const headers=await login(f),id=crypto.randomUUID();
  f.env.APP_ORIGIN='https://garden.test';f.env.ASSETS={fetch:async()=>Response.json({model_version:'current-p2'})};
  const image=Uint8Array.from([255,216,255,192,0,17,8,1,224,2,128,3,1,17,0,2,17,0,3,17,0,255,217]);
  await f.request('/device/v1/station-001/images/'+id,{method:'PUT',headers:{...device,'Content-Type':'image/jpeg'},body:image});
  const path=`/api/images/${id}/analysis/`;
  assert.equal((await f.request(path+'claim',{method:'POST'})).status,401);
  assert.equal((await f.request(path+'claim',{method:'POST',headers:{...headers,Origin:'https://untrusted.test'}})).status,403);
  const response=await f.request(path+'claim',{method:'POST',headers});assert.equal(response.status,200,await response.clone().text());
  const claim=await response.json();
  const saved=await f.request(path+'complete',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({lease_token:claim.lease_token,result:{width:640,height:480,model_version:'current-p2',detections:[]}})});
  assert.equal(saved.status,200,await saved.clone().text());assert.equal((await saved.json()).saved,true);
  const gallery=await (await f.request('/api/images?id='+id,{headers})).json();assert.equal(gallery.rows[0].status,'succeeded');
 }finally{f.sql.close();}
});

test('startup route authenticates the device, validates events and deduplicates the same boot without Telegram configuration',async()=>{
 const f=fixture();try{
  const path='/device/v1/station-001/startup',id=crypto.randomUUID();
  const send=(body,headers={...device,'Content-Type':'application/json'})=>f.request(path,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await send({boot_id:id},{'Content-Type':'application/json'})).status,401);
  assert.equal((await f.request(path,{headers:device})).status,405);
  assert.equal((await send({boot_id:'invalid'})).status,422);
  const response=await send({boot_id:id});assert.equal(response.status,200);
  assert.equal((await response.json()).duplicate,false);
  assert.equal((await (await send({boot_id:id.toUpperCase()})).json()).duplicate,true);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM station_startups').get().n,1);
 }finally{f.sql.close();}
});

test('plant-health guide requires login; cron evaluates real stored readings and exposes advice through dashboard alerts',async()=>{
 const f=fixture();try{
  assert.equal((await f.request('/api/plant-health')).status,401);
  const headers=await login(f),now=Date.now();
  f.sql.exec('DROP TRIGGER IF EXISTS cloud_alert_on_telemetry; UPDATE observation_profile SET activated_at=0');
  const insert=f.sql.prepare('INSERT INTO telemetry(message_id,observed_at,received_at,measurements) VALUES(?,?,?,?)');
  for(let i=0;i<=61;i++)insert.run(crypto.randomUUID(),now-i*60000,now-i*60000,JSON.stringify({temperature_c:27,air_humidity_pct:86,rain_do:1}));
  await worker.scheduled({cron:'*/5 * * * *',scheduledTime:now},f.env);
  const report=await (await f.request('/api/plant-health',{headers})).json();assert.equal(report.rules.find(r=>r.id==='humid_environment').stage,'warning');
  const response=await f.request('/api/dashboard',{headers});assert.equal(response.status,200);
  const dashboard=await response.json();assert.equal(dashboard.totals.open_alerts,1);assert.equal(dashboard.alerts[0].kind,'climate');
  const alerts=await (await f.request('/api/alerts',{headers})).json();assert.match(alerts.rows[0].message,/thán thư/);
 }finally{f.sql.close();}
});

test('Telegram recipient self-service is scoped to each authenticated member; administrative sensor controls stay protected',async()=>{
 const f=fixture();try{
  const admin=await login(f),id='a'.repeat(32),other='b'.repeat(32),now=Date.now();
  f.sql.prepare('INSERT INTO telegram_recipients(id,chat_id,owner_username,display_name,connected_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,'111111111','member','Own Telegram',now,now);
  f.sql.prepare('INSERT INTO telegram_recipients(id,chat_id,owner_username,display_name,connected_at,updated_at) VALUES(?,?,?,?,?,?)').run(other,'222222222','garden','Other Telegram',now,now);
  const token='c'.repeat(64),hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`ptit-garden/session:${token}:${f.env.DASHBOARD_PASSWORD}`))).toString('hex');
  f.sql.prepare('INSERT INTO dashboard_accounts VALUES(?,?,?,?)').run('member','unused',now,now);
  f.sql.prepare('INSERT INTO dashboard_member_sessions VALUES(?,?,?)').run(hash,now+60000,'member');
  const member={Cookie:'__Host-ptit_session='+token,'X-Garden-Request':'1','Content-Type':'application/json'};
  assert.equal((await f.request('/api/telegram/recipients')).status,401);
  let response=await f.request('/api/telegram/recipients',{headers:member});assert.equal(response.status,200);const list=await response.json();assert.equal(list.recipients.length,1);assert.equal(list.recipients[0].name,'Own Telegram');
  response=await f.request('/api/telegram/recipients',{headers:admin});assert.equal((await response.json()).recipients.length,2);
  assert.equal((await f.request('/api/telegram/recipients/'+other,{method:'PUT',headers:member,body:JSON.stringify({enabled:false})})).status,404);
  assert.equal((await f.request('/api/telegram/recipients/'+id,{method:'PUT',headers:member,body:JSON.stringify({enabled:false})})).status,200);
  assert.equal((await f.request('/api/telegram/pairing',{headers:member})).status,200);
  assert.equal((await f.request('/api/rules',{headers:member})).status,403);
  assert.equal((await f.request('/api/telegram/status',{headers:member})).status,403);
 }finally{f.sql.close();}
});

test('sensor-specific settings replace generic T/RH forms and validate profile revisions and soil calibration through the Worker',async()=>{
 const f=fixture();try{
  const headers={...await login(f),'Content-Type':'application/json'};
  const get=await f.request('/api/rules',{headers});assert.equal(get.status,200);const config=await get.json();
  assert.equal(config.crops.length,4);assert.deepEqual(config.rules.map(r=>r.id),['soil_wet','humid_environment','pest_image']);
  assert.equal((await f.request('/api/rules/temperature',{method:'PUT',headers,body:'{}'})).status,404);
  const soil=config.rules[0];
  assert.equal((await f.request('/api/rules/soil_wet',{method:'PUT',headers,body:JSON.stringify({crop_id:'guava',revision:soil.revision,enabled:true,parameters:{...soil.parameters,dry_raw:4095,wet_raw:2000}})})).status,422);
  const pest=config.rules.find(r=>r.id==='pest_image');
  const parameters={species_thresholds:{...pest.parameters.species_thresholds,Plutella_xylostella:3,Conogethes_punctiferalis:null,unknown:5}};
  const putPest=(revision=pest.revision,p=parameters)=>f.request('/api/rules/pest_image',{method:'PUT',headers,body:JSON.stringify({crop_id:'guava',revision,enabled:true,parameters:p})});
  const saved=await putPest();assert.equal(saved.status,200);
  assert.deepEqual((await saved.json()).rules.find(r=>r.id==='pest_image').parameters,parameters);
  assert.equal((await putPest()).status,409);
  assert.equal((await putPest(pest.revision+1,{species_thresholds:{...parameters.species_thresholds,unknown:-1}})).status,422);
  const select=revision=>f.request('/api/rules/profile',{method:'PUT',headers,body:JSON.stringify({crop_id:'durian',revision})});
  assert.equal((await select(config.profile_revision)).status,200);assert.equal((await select(config.profile_revision)).status,409);
  const status=await (await f.request('/api/plant-health',{headers})).json();assert.equal(status.crop_id,'durian');assert.equal(status.rules[0].stage,'needs_calibration');
 }finally{f.sql.close();}
});

test('cloud AI capability is scoped to its job image and AI assets; it cannot read accounts, dashboard or another image',async()=>{
 const f=fixture();try{
  const id=crypto.randomUUID(),other=crypto.randomUUID(),token=crypto.randomUUID();
  for(const image of [id,other])f.sql.prepare('INSERT INTO images(image_id,received_at,jpeg) VALUES(?,?,?)').run(image,Date.now(),jpeg);
  f.sql.prepare("UPDATE image_analysis SET status='running',lease_token=?,next_attempt_at=? WHERE image_id=?").run(token,Date.now()+60000,id);
  const headers={Cookie:`__Host-ptit_ai=${id}.${token}`};
  assert.equal((await f.request('/internal/ai/'+id,{headers})).status,200);
  assert.equal((await f.request('/media/'+id,{headers})).status,200);
  for(const path of ['/media/'+other,'/api/dashboard','/api/admin/registrations','/api/images','/api/automation'])assert.equal((await f.request(path,{headers})).status,401);
  assert.equal((await f.request('/internal/ai/'+other,{headers})).status,404);
  assert.equal((await f.request('/internal/ai/'+id)).status,404);
  assert.equal((await f.request('/api/camera/requests',{method:'POST',headers:{...headers,'X-Garden-Request':'1'}})).status,401);
  f.sql.prepare('UPDATE image_analysis SET next_attempt_at=0 WHERE image_id=?').run(id);
  assert.equal((await f.request('/media/'+id,{headers})).status,401);
 }finally{f.sql.close();}
});

test('existing-photo migration preserves JPEG/trash state and never invents an account for historical captures',()=>{
 const sql=new DatabaseSync(':memory:');try{
  sql.exec("CREATE TABLE images(image_id TEXT PRIMARY KEY,received_at INTEGER,jpeg BLOB,source TEXT,deleted_at INTEGER); CREATE TABLE camera_requests(id TEXT PRIMARY KEY);");
  const insert=sql.prepare('INSERT INTO images VALUES(?,?,?,?,?)');
  insert.run('manual',1,jpeg,'hardware',null);insert.run('automatic-or-legacy',2,jpeg,'hardware',123);insert.run('upload',3,jpeg,'upload',null);
  sql.prepare('INSERT INTO camera_requests VALUES(?)').run('manual');
  sql.exec(readFileSync(new URL('../infra/cloudflare/image-provenance.sql',import.meta.url),'utf8'));
  const rows=sql.prepare('SELECT * FROM images ORDER BY image_id').all();
  assert.equal(rows.length,3);assert.ok(rows.every(r=>r.actor_username===null));assert.ok(rows.every(r=>Buffer.from(r.jpeg).equals(Buffer.from(jpeg))));
  assert.equal(rows.find(r=>r.image_id==='manual').capture_origin,'manual');
  assert.equal(rows.find(r=>r.image_id==='automatic-or-legacy').capture_origin,'unknown');
  assert.equal(rows.find(r=>r.image_id==='automatic-or-legacy').deleted_at,123);
  assert.equal(rows.find(r=>r.image_id==='upload').capture_origin,'upload');
 }finally{sql.close();}
});
