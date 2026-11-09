import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {claimPhotoAnalysis,completePhotoAnalysis,failPhotoAnalysis,jpegDimensions} from '../infra/cloudflare/src/photo-analysis.js';
import {analysisFailure,runAutomaticAnalysis,persistAnalysisResult} from '../infra/cloudflare/src/automation.js';
import {enqueueDeliveries,flushDeliveries} from '../infra/cloudflare/src/telegram-recipients.js';
import {imageData} from '../infra/cloudflare/src/dashboard-data.js';
const admin={username:'garden',role:'admin'};
// Syntactic SOF header, enough for server metadata validation; inference uses real JPEGs in browser QA.
const jpeg=Uint8Array.from([255,216,255,192,0,17,8,1,224,2,128,3,1,17,0,2,17,0,3,17,0,255,217]);
const insect={pest_code:'unknown',identification_status:'unknown',confidence:.075,x_min:.1,y_min:.2,x_max:.3,y_max:.4};
const result=(extra={})=>({width:640,height:480,model_version:'current-p2',detections:[insect],total_count:999,...extra});
function fixture(){
 const sql=new DatabaseSync(':memory:');
 for(const name of ['schema.sql','alerts.sql','telegram.sql','telegram-pairing.sql','camera-requests.sql','automation.sql','station-startups.sql','plant-health.sql','telegram-recipients.sql','observation-alerts.sql'])sql.exec(readFileSync(new URL('../infra/cloudflare/'+name,import.meta.url),'utf8'));
 function prepare(query,values=[]){return {bind:(...args)=>prepare(query,args),first:async col=>{const row=sql.prepare(query).get(...values);return col?row?.[col]??null:row??null;},all:async()=>({results:sql.prepare(query).all(...values)}),run:async()=>({meta:{changes:Number(sql.prepare(query).run(...values).changes)}}),_run:()=>{const s=sql.prepare(query);return s.columns().length?{results:s.all(...values),meta:{changes:sql.prepare('SELECT changes() AS n').get().n}}:{results:[],meta:{changes:Number(s.run(...values).changes)}};}};}
 const db={prepare,batch:async statements=>{sql.exec('BEGIN');try{const r=statements.map(s=>s._run());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const env={DB:db,APP_ORIGIN:'https://garden.test',BROWSER:{},ASSETS:{fetch:async()=>Response.json({model_version:'current-p2'})}};
 return {sql,env,db,seed(source='hardware'){const id=crypto.randomUUID();sql.prepare('INSERT INTO images(image_id,received_at,jpeg,source) VALUES(?,?,?,?)').run(id,Date.now(),jpeg,source);return id;}};
}
test('JPEG metadata is read from SOF rather than trusting client dimensions',()=>{
 assert.deepEqual(jpegDimensions(jpeg),{width:640,height:480});
 assert.equal(jpegDimensions(Uint8Array.of(255,216,255,217)),null);
 assert.equal(jpegDimensions(Uint8Array.of(0,0)),null);
});
test('browser recovery persists real-image boxes and derived counts; repeated save/claim cannot replay',async()=>{
 const f=fixture();try{
  const id=f.seed();f.sql.prepare("UPDATE image_analysis SET status='failed',attempts=3 WHERE image_id=?").run(id);
  const claim=await claimPhotoAnalysis(f.env,id);assert.ok(claim.lease_token);
  await assert.rejects(claimPhotoAnalysis(f.env,id),{status:409});
  const saved=await completePhotoAnalysis(f.env,id,{lease_token:claim.lease_token,result:result({secret:'must-not-persist'})},admin);
  assert.equal(saved.result.total_count,1);assert.equal(saved.result.unknown_count,1);assert.equal(saved.result.secret,undefined);
  assert.equal(saved.result.processing_source,'browser');assert.equal(saved.result.processed_by,'garden');
  const gallery=await imageData(f.db,new URLSearchParams('limit=12'));
  assert.equal(gallery.rows[0].status,'succeeded');assert.deepEqual(gallery.rows[0].analysis.detections,[insect]);
  await assert.rejects(completePhotoAnalysis(f.env,id,{lease_token:claim.lease_token,result:result()},admin),{status:409});
  assert.equal((await claimPhotoAnalysis(f.env,id)).already_completed,true);
  const again=await claimPhotoAnalysis(f.env,id,Date.now(),true);assert.ok(again.lease_token);
  await completePhotoAnalysis(f.env,id,{lease_token:again.lease_token,result:result()},admin);
  assert.equal((await claimPhotoAnalysis(f.env,id)).already_completed,true);
 }finally{f.sql.close();}
});
test('foreign/expired lease, wrong model, forged dimensions and weak named species are rejected',async()=>{
 const f=fixture();try{
  const id=f.seed(),other=f.seed(),claim=await claimPhotoAnalysis(f.env,id);
  await assert.rejects(completePhotoAnalysis(f.env,other,{lease_token:claim.lease_token,result:result()},admin),{status:409});
  for(const change of [{model_version:'old-p2'},{width:1280},{detections:[{...insect,pest_code:'Plutella_xylostella',identification_status:'identified',confidence:.6}]}])
   await assert.rejects(completePhotoAnalysis(f.env,id,{lease_token:claim.lease_token,result:result(change)},admin),{status:422});
  f.sql.prepare('UPDATE image_analysis SET next_attempt_at=0 WHERE image_id=?').run(id);
  await assert.rejects(completePhotoAnalysis(f.env,id,{lease_token:claim.lease_token,result:result()},admin),{status:409});
 }finally{f.sql.close();}
});
test('deleted photos and cancelled leases cannot store results or generate alerts',async()=>{
 const f=fixture();try{
  const id=f.seed(),claim=await claimPhotoAnalysis(f.env,id);
  await failPhotoAnalysis(f.env,id,{lease_token:'wrong'});
  assert.equal(f.sql.prepare('SELECT status FROM image_analysis WHERE image_id=?').get(id).status,'running');
  f.sql.prepare('UPDATE images SET deleted_at=? WHERE image_id=?').run(Date.now(),id);
  await assert.rejects(completePhotoAnalysis(f.env,id,{lease_token:claim.lease_token,result:result()},admin),{status:409});
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM plant_health_alerts').get().n,0);
 }finally{f.sql.close();}
});
test('a saved camera insect result reaches every active Telegram recipient exactly once',async()=>{
 const f=fixture();try{
  f.sql.prepare("UPDATE observation_rules SET parameters=? WHERE crop_id='guava' AND id='pest_image'").run(JSON.stringify({species_thresholds:{unknown:1}}));
  for(const [id,chat] of [['a','111111111'],['b','222222222']])f.sql.prepare('INSERT INTO telegram_recipients(id,chat_id,owner_username,display_name,connected_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,chat,'garden',id,Date.now()-10000,Date.now()-10000);
  f.env.TELEGRAM_BOT_TOKEN='123456:abcdefghijklmnopqrstuvwxyz123456789';const id=f.seed(),claim=await claimPhotoAnalysis(f.env,id);
  await completePhotoAnalysis(f.env,id,{lease_token:claim.lease_token,result:result()},admin);
  await enqueueDeliveries(f.db);await enqueueDeliveries(f.db);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM telegram_deliveries WHERE kind='health'").get().n,2);
  const sent=[];const send=async(url,options)=>{
   if(url.endsWith('/getMe'))return Response.json({ok:true,result:{id:777,is_bot:true,username:'test_bot'}});
   const body=JSON.parse(options.body);sent.push(body.chat_id);
   return Response.json({ok:true,result:{message_id:sent.length,chat:{id:Number(body.chat_id)},from:{id:777}}});
  };
  await flushDeliveries(f.env,send);await enqueueDeliveries(f.db);await flushDeliveries(f.env,send);assert.equal(sent.length,2);
 }finally{f.sql.close();}
});
test('historical photos persist overlays without bypassing a newer alert setting',async()=>{
 const f=fixture();try{
  const id=f.seed();f.sql.prepare("UPDATE observation_rules SET parameters=?,updated_at=? WHERE crop_id='guava' AND id='pest_image'").run(JSON.stringify({species_thresholds:{unknown:1}}),Date.now()+1000);
  const claim=await claimPhotoAnalysis(f.env,id);await completePhotoAnalysis(f.env,id,{lease_token:claim.lease_token,result:result()},admin);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM plant_health_alerts').get().n,0);
  assert.equal(f.sql.prepare('SELECT status FROM image_analysis WHERE image_id=?').get(id).status,'succeeded');
 }finally{f.sql.close();}
});
test('Cloudflare limits retain the queued image and use backoff without exhausting inference attempts',async()=>{
 const f=fixture();try{
  const id=f.seed();await runAutomaticAnalysis(f.env,null,async()=>{throw Error('Unable to create new browser: code: 429: message: Rate limit exceeded');});
  const row=f.sql.prepare('SELECT * FROM image_analysis WHERE image_id=?').get(id);
  assert.equal(row.status,'queued');assert.equal(row.attempts,0);assert.ok(row.next_attempt_at>Date.now());
  assert.match(row.error_message,/giới hạn/);
  const now=Date.UTC(2026,10,9,15);assert.equal(analysisFailure(Error('Browser time limit exceeded for today'),now).retry,Date.UTC(2026,10,10,0,1));
 }finally{f.sql.close();}
});
test('an obsolete cloud write cannot overwrite a successful browser result',async()=>{
 const f=fixture();try{
  const id=f.seed(),claim=await claimPhotoAnalysis(f.env,id);await completePhotoAnalysis(f.env,id,{lease_token:claim.lease_token,result:result()},admin);
  await assert.rejects(persistAnalysisResult(f.env,{image_id:id,lease_token:'old-cloud',received_at:Date.now()},result()));
  assert.equal(JSON.parse(f.sql.prepare('SELECT result FROM image_analysis WHERE image_id=?').get(id).result).processing_source,'browser');
 }finally{f.sql.close();}
});
