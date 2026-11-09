import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {defaultConfig,observationConfig,updateObservationRule,setObservationCrop,validateRuleParameters,
 calibrationValid,wetIndex,evaluateConditions,evaluatePlantHealth,plantHealthStatus} from '../infra/cloudflare/src/observation-alerts.js';
import {pestHealthAlertInsert,Knowledge} from '../infra/cloudflare/src/plant-health.js';
import {enqueueDeliveries,flushDeliveries} from '../infra/cloudflare/src/telegram-recipients.js';
import {dashboardAlerts,alertSummary,acknowledgeAlert,markNotificationsRead,dashboardNotifications} from '../infra/cloudflare/src/dashboard-alerts.js';
const now=Date.now(),validSoil={dry_raw:3500,wet_raw:1500,wet_index:85,hold_minutes:120,cooldown_minutes:360};
const series=(minutes,m={temperature_c:27,air_humidity_pct:86},end=now)=>Array.from({length:minutes+1},(_,i)=>({observed_at:end-i*60000,measurements:{...m}}));
const rule=(rows,id='humid_environment',cfg=defaultConfig(),at=now)=>evaluateConditions(rows,at,cfg).rules.find(r=>r.id===id);
function fixture(beforeMigration){
 const sql=new DatabaseSync(':memory:');
 for(const file of ['schema.sql','alerts.sql','telegram.sql','telegram-pairing.sql','camera-requests.sql','automation.sql','station-startups.sql','plant-health.sql','telegram-recipients.sql'])sql.exec(readFileSync(new URL('../infra/cloudflare/'+file,import.meta.url),'utf8'));
 beforeMigration?.(sql);sql.exec(readFileSync(new URL('../infra/cloudflare/observation-alerts.sql',import.meta.url),'utf8'));
 // Historical fixtures model a profile already active before the sample window.
 sql.exec('UPDATE observation_profile SET activated_at=0');
 function prepare(query,values=[]){return {bind:(...args)=>prepare(query,args),first:async column=>{const row=sql.prepare(query).get(...values);return column?row?.[column]??null:row??null;},
  all:async()=>({results:sql.prepare(query).all(...values)}),run:async()=>({meta:{changes:Number(sql.prepare(query).run(...values).changes)}}),
  _run:()=>{const statement=sql.prepare(query);return statement.columns().length?{results:statement.all(...values),meta:{changes:sql.prepare('SELECT changes() AS n').get().n}}:{results:[],meta:{changes:Number(statement.run(...values).changes)}};}};}
 const db={prepare,batch:async statements=>{sql.exec('BEGIN');try{const rows=statements.map(s=>s._run());sql.exec('COMMIT');return rows;}catch(error){sql.exec('ROLLBACK');throw error;}}};
 const seed=rows=>{for(const row of rows)sql.prepare('INSERT INTO telemetry(message_id,observed_at,received_at,measurements) VALUES(?,?,?,?)').run(crypto.randomUUID(),row.observed_at,row.received_at??row.observed_at,JSON.stringify(row.measurements));};
 return {sql,db,seed,env:{DB:db,TELEGRAM_BOT_TOKEN:'123456:abcdefghijklmnopqrstuvwxyz123456789'}};
}
async function saveRule(f,id,parameters,enabled=true){const config=await observationConfig(f.db),r=config.rules.find(r=>r.id===id);const saved=await updateObservationRule(f.db,id,{crop_id:r.crop_id,revision:r.revision,parameters,enabled});
 // Duration tests below use historical measurements with a pre-existing calibration/rule.
 f.sql.prepare('UPDATE observation_rules SET updated_at=0 WHERE crop_id=? AND id=?').run(r.crop_id,id);return saved;}

test('four independent crop profiles keep distinct climate defaults and exactly three sensor alert categories',async()=>{
 const f=fixture();try{
  const config=await observationConfig(f.db);assert.deepEqual(config.crops.map(c=>c.name),['Ổi','Lựu','Sầu riêng','Lê']);assert.equal(config.rules.length,3);
  assert.equal(config.rules[0].parameters.dry_raw,null);assert.equal(config.rules[1].parameters.humidity_min,85);
  const changed=await setObservationCrop(f.db,{crop_id:'pear',revision:config.profile_revision});assert.equal(changed.rules[1].parameters.temperature_min,15);
  assert.equal(changed.rules[1].parameters.hold_minutes,120);assert.equal(changed.rules[0].parameters.dry_raw,null);
  assert.equal(rule(series(120),'humid_environment',defaultConfig('pear')).stage,'not_matching');
  assert.equal(rule(series(120,{temperature_c:20,air_humidity_pct:86}),'humid_environment',defaultConfig('pear')).stage,'warning');
 }finally{f.sql.close();}
});

test('soil index requires two valid reference soils, supports either ADC direction and never means volumetric water percent',()=>{
 assert.equal(calibrationValid(validSoil),true);assert.equal(wetIndex(1700,validSoil),90);
 assert.equal(wetIndex(2800,{...validSoil,dry_raw:1000,wet_raw:3000}),90);
 for(const p of [{...validSoil,wet_raw:null},{...validSoil,wet_raw:3490},{...validSoil,dry_raw:4095},{...validSoil,wet_raw:0}]){
  assert.equal(calibrationValid(p),false);assert.throws(()=>validateRuleParameters('soil_wet',p),{status:422});
 }
 assert.equal(wetIndex(1700,{...validSoil,wet_raw:null}),null);
 assert.equal(rule(series(120,{soil_raw:1700}),'soil_wet').stage,'needs_calibration');
});

test('soil and air evaluate independently; rain is context and absence is never replaced by a fake reading',()=>{
 const cfg=defaultConfig();cfg.rules[0].parameters=validSoil;
 const rootOnly=series(120,{soil_raw:1700,rain_do:0});assert.equal(rule(rootOnly,'soil_wet',cfg).stage,'warning');assert.equal(rule(rootOnly,'humid_environment',cfg).stage,'no_data');
 const dryWeather=series(120,{soil_raw:1700,rain_do:1});assert.equal(rule(dryWeather,'soil_wet',cfg).stage,'warning');
 assert.equal(rule(series(60),'humid_environment',cfg).stage,'warning');assert.equal(rule(series(60),'soil_wet',cfg).stage,'no_data');
 assert.equal(rule(series(120,{soil_raw:4095}),'soil_wet',cfg).stage,'no_data');
 cfg.rules[0].enabled=false;assert.equal(rule(rootOnly,'soil_wet',cfg).stage,'disabled');
});

test('joint air thresholds and durations are enforced, with conservative DHT11 input validity and no missing-period bridging',()=>{
 assert.equal(rule(series(59)).stage,'tracking');assert.equal(rule(series(60)).stage,'warning');
 for(const temperature_c of [25,30])assert.equal(rule(series(60,{temperature_c,air_humidity_pct:85})).stage,'warning');
 assert.equal(rule(series(60,{temperature_c:35,air_humidity_pct:86})).stage,'not_matching');
 assert.equal(rule(series(60,{temperature_c:27,air_humidity_pct:96})).stage,'no_data');
 const missing=series(90);missing[5].measurements.air_humidity_pct=null;assert.equal(rule(missing).observed_minutes,4);
 const gap=series(90).filter((_,i)=>i<5||i>10);assert.equal(rule(gap).observed_minutes,4);
 const alternating=series(90).map((r,i)=>({...r,measurements:i%2?{temperature_c:27,air_humidity_pct:60}:{temperature_c:35,air_humidity_pct:86}}));assert.equal(rule(alternating).stage,'not_matching');
 assert.equal(rule(series(60),undefined,undefined,now+120001).stage,'no_data');
 assert.equal(rule([{observed_at:now+1,measurements:{temperature_c:27,air_humidity_pct:86}}]).stage,'no_data');
});

test('profile settings are isolated, validated and revision checked; cached old conclusions disappear after edits',async()=>{
 const f=fixture();try{
  f.seed(series(60));await evaluatePlantHealth(f.db,null,now);assert.equal((await plantHealthStatus(f.db,now)).rules[1].stage,'warning');
  const old=await observationConfig(f.db);await saveRule(f,'soil_wet',validSoil);
  const root=old.rules[0];await assert.rejects(updateObservationRule(f.db,'soil_wet',{crop_id:'guava',revision:root.revision,enabled:true,parameters:validSoil}),{status:409});
  await setObservationCrop(f.db,{crop_id:'durian',revision:old.profile_revision});
  const active=await observationConfig(f.db);assert.equal(active.rules[0].parameters.dry_raw,null);
  assert.equal((await plantHealthStatus(f.db,now)).crop_id,'durian');assert.equal((await plantHealthStatus(f.db,now)).fresh,false);
  await assert.rejects(updateObservationRule(f.db,'temperature',{}),{status:404});
  assert.throws(()=>validateRuleParameters('humid_environment',{temperature_min:30,temperature_max:25,humidity_min:85,hold_minutes:60,cooldown_minutes:360}),{status:422});
  assert.throws(()=>validateRuleParameters('pest_image',{min_identified:0}),{status:422});
 }finally{f.sql.close();}
});

test('D1 risk alerts are deduplicated under concurrent cron, use configured cooldown and exclude old telemetry uploads',async()=>{
 const f=fixture();try{
  f.seed(series(60));await Promise.all([evaluatePlantHealth(f.db,null,now),evaluatePlantHealth(f.db,null,now)]);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM plant_health_alerts').get().n,1);
  await evaluatePlantHealth(f.db,null,now+60000);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM plant_health_alerts').get().n,1);
  const message=f.sql.prepare('SELECT message,details FROM plant_health_alerts').get();assert.match(message.message,/DHT11/);assert.match(message.message,/chưa phải ngưỡng xác nhận/);assert.equal(JSON.parse(message.details).crop_id,'guava');
  const later=now+6*3600000+60000;f.seed(series(60,undefined,later));await evaluatePlantHealth(f.db,null,later);assert.equal(f.sql.prepare('SELECT count(*) AS n FROM plant_health_alerts').get().n,2);
  assert.equal((await plantHealthStatus(f.db,later+180000)).fresh,false);
  f.sql.exec('DELETE FROM telemetry;DELETE FROM plant_health_alerts');f.seed(series(120).map(r=>({...r,received_at:r.observed_at+3600000})));await evaluatePlantHealth(f.db,null,now);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM plant_health_alerts').get().n,0);
 }finally{f.sql.close();}
});

test('a changed rule/profile never counts pre-change observations toward its holding period',async()=>{
 const cfg=defaultConfig();cfg.rules[1].effective_at=now-10*60000;
 assert.equal(rule(series(120),'humid_environment',cfg).observed_minutes,10);
 assert.equal(rule(series(120),'humid_environment',cfg).stage,'tracking');
 const f=fixture();try{
  f.seed(series(60));await evaluatePlantHealth(f.db,null,now);assert.equal((await plantHealthStatus(f.db,now)).rules[1].stage,'warning');
  const current=await observationConfig(f.db),r=current.rules[1],started=Date.now();
  await updateObservationRule(f.db,r.id,{crop_id:r.crop_id,revision:r.revision,enabled:true,parameters:r.parameters});
  const next=await observationConfig(f.db);assert.ok(next.rules[1].effective_at>=started);
  const report=await evaluatePlantHealth(f.db,null,Date.now());assert.notEqual(report.rules[1].stage,'warning');assert.equal(report.rules[1].observed_minutes,0);
 }finally{f.sql.close();}
});

test('soil warning persists its measured ADC/calibrated index and configured runtime condition',async()=>{
 const f=fixture();try{
  await saveRule(f,'soil_wet',validSoil);f.seed(series(120,{soil_raw:1700,rain_do:0}));await evaluatePlantHealth(f.db,null,now);
  const row=f.sql.prepare('SELECT * FROM plant_health_alerts').get();assert.equal(row.disease_id,'soil_wet');assert.match(row.message,/ADC 1700/);assert.match(row.message,/90.0%/);assert.match(row.message,/120 phút/);
  assert.equal(JSON.parse(row.details).rule_id,'soil_wet');
 }finally{f.sql.close();}
});

test('disabling a rule cancels unsent messages and preserves both old alert history and acknowledgement',async()=>{
 const f=fixture();try{
  f.sql.prepare("INSERT INTO telegram_recipients(id,chat_id,owner_username,display_name,connected_at,updated_at) VALUES('a','111111111','garden','User',?,?)").run(now-3600000,now-3600000);
  f.seed(series(60));await evaluatePlantHealth(f.db,null,now);await enqueueDeliveries(f.db,now+1);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM telegram_deliveries').get().n,1);
  const cfg=await observationConfig(f.db);await saveRule(f,'humid_environment',cfg.rules[1].parameters,false);
  assert.ok(f.sql.prepare('SELECT failed_at FROM telegram_deliveries').get().failed_at);
  const id=f.sql.prepare('SELECT id FROM plant_health_alerts').get().id;
  f.sql.prepare("INSERT INTO cloud_alerts(id,rule_id,title,message,triggered_at) VALUES('legacy','humidity','Old','Historical record',?)").run(now);
  assert.equal((await alertSummary(f.db)).open_alerts,2);await acknowledgeAlert(f.db,id);
  const open=await dashboardAlerts(f.db,new URLSearchParams('state=open'));assert.equal(open.total,1);assert.equal(open.rows[0].id,'legacy');
  await markNotificationsRead(f.db);assert.ok((await dashboardNotifications(f.db)).every(r=>r.read_at));
 }finally{f.sql.close();}
});

test('realistic risk event fans out through the verified multi-recipient Telegram sender',async()=>{
 const f=fixture();try{
  f.sql.prepare("INSERT INTO telegram_recipients(id,chat_id,owner_username,display_name,connected_at,updated_at) VALUES('a','111111111','garden','User',?,?)").run(now-3600000,now-3600000);
  f.seed(series(60));await evaluatePlantHealth(f.db,null,now);await enqueueDeliveries(f.db,now);
  let sends=0;const send=async(url,options)=>{const method=new URL(url).pathname.split('/').at(-1);
    if(method==='getMe')return Response.json({ok:true,result:{id:777,is_bot:true,username:'Ptit_Test_Bot'}});
    sends++;assert.match(JSON.parse(options.body).text,/Ổi/);assert.match(JSON.parse(options.body).text,/DHT11/);
    return Response.json({ok:true,result:{message_id:19,chat:{id:111111111},from:{id:777}}});};
  await Promise.all([flushDeliveries(f.env,send),flushDeliveries(f.env,send)]);assert.equal(sends,1);
  assert.equal(f.sql.prepare('SELECT message_id FROM telegram_deliveries').get().message_id,19);
 }finally{f.sql.close();}
});

test('camera crop attribution is snapshotted; additional identified species create a deduplicated insect alert',async()=>{
 const f=fixture();try{
  const id=crypto.randomUUID(),lease=crypto.randomUUID();
  f.sql.prepare('INSERT INTO images(image_id,received_at,jpeg) VALUES(?,?,?)').run(id,now,Uint8Array.of(255,216,255,217));
  f.sql.prepare("UPDATE image_analysis SET status='running',lease_token=? WHERE image_id=?").run(lease,id);
  await setObservationCrop(f.db,{crop_id:'durian',revision:1});
  assert.equal(f.sql.prepare('SELECT crop_id FROM image_crop_context').get().crop_id,'guava');
  const result=code=>({detections:[{pest_code:code,identification_status:'identified'}],identified_count:1});
  await pestHealthAlertInsert(f.db,{image_id:id,lease_token:lease},result('Plutella_xylostella'),'cabbage moth detection',now).run();assert.equal(f.sql.prepare('SELECT count(*) AS n FROM plant_health_alerts').get().n,1);
  await pestHealthAlertInsert(f.db,{image_id:id,lease_token:lease},result('Conogethes_punctiferalis'),'fruit-borer evidence',now).run();
  const row=f.sql.prepare('SELECT * FROM plant_health_alerts').get();assert.match(row.title,/Ổi/);assert.equal(JSON.parse(row.details).qualifying_count,1);
  assert.equal(JSON.parse(row.details).crop_id,'guava');
  assert.match(row.message,/Ngài sâu tơ/);assert.doesNotMatch(row.title,/Ngài đục quả/);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM plant_health_alerts').get().n,1);
 }finally{f.sql.close();}
});

const pestParameters=selected=>({species_thresholds:Object.fromEntries(Object.keys(Knowledge.pestAlertSpecies).map(code=>[code,selected[code]??null]))});
function pestPhoto(f,detections,{deleted=false,leaseValid=true,source='hardware',receivedAt=Date.now()+1}={}){
 const id=crypto.randomUUID(),lease=crypto.randomUUID();
 f.sql.prepare('INSERT INTO images(image_id,received_at,jpeg,source) VALUES(?,?,?,?)').run(id,receivedAt,Uint8Array.of(255,216,255,217),source);
 if(deleted)f.sql.prepare('UPDATE images SET deleted_at=? WHERE image_id=?').run(now,id);
 f.sql.prepare("UPDATE image_analysis SET status='running',lease_token=? WHERE image_id=?").run(lease,id);
 return pestHealthAlertInsert(f.db,{image_id:id,lease_token:leaseValid?lease:'expired'},
  {detections,identified_count:detections.filter(d=>d.identification_status==='identified').length},'Camera insect result',now);
}
const insect=(pest_code,n=1)=>Array.from({length:n},()=>({pest_code,identification_status:pest_code==='unknown'?'unknown':'identified'}));

test('all six model species alert by default; legacy fruit-borer threshold is retained and unknown is opt-in',async()=>{
 const f=fixture();try{
  const config=await observationConfig(f.db),p=config.rules.find(r=>r.id==='pest_image').parameters;
  assert.equal(Object.values(p.species_thresholds).filter(n=>n===1).length,6);assert.equal(p.species_thresholds.unknown,null);
  for(const code of Object.keys(Knowledge.pests))await pestPhoto(f,insect(code)).run();
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM plant_health_alerts').get().n,6);
  await pestPhoto(f,insect('unknown',20)).run();assert.equal(f.sql.prepare('SELECT count(*) AS n FROM plant_health_alerts').get().n,6);
  await saveRule(f,'pest_image',{min_identified:4});
  const updated=(await observationConfig(f.db)).rules.find(r=>r.id==='pest_image').parameters.species_thresholds;
  assert.equal(updated.Conogethes_punctiferalis,4);assert.equal(updated.Plutella_xylostella,1);
 }finally{f.sql.close();}
});

test('per-species thresholds are independent, disabled species do not count, and one photo creates at most one alert',async()=>{
 const f=fixture();try{
  await saveRule(f,'pest_image',pestParameters({Plutella_xylostella:3,Cnaphalocrocis_medinalis:2}));
  await pestPhoto(f,[...insect('Plutella_xylostella',2),...insect('Cnaphalocrocis_medinalis'),...insect('Conogethes_punctiferalis',8)]).run();
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM plant_health_alerts').get().n,0,'counts cannot be pooled across species');
  const insert=pestPhoto(f,[...insect('Plutella_xylostella',3),...insect('Cnaphalocrocis_medinalis',2)]);
  await insert.run();await insert.run();
  const rows=f.sql.prepare('SELECT * FROM plant_health_alerts').all();assert.equal(rows.length,1);
  const details=JSON.parse(rows[0].details);assert.equal(details.qualifying_count,5);assert.equal(details.matched_species.length,2);
  assert.deepEqual(details.matched_species.map(s=>[s.code,s.count,s.threshold]).sort(),[['Cnaphalocrocis_medinalis',2,2],['Plutella_xylostella',3,3]]);
  assert.match(rows[0].message,/Ngài sâu tơ \(3\/3 con\)/);
  assert.equal((await dashboardAlerts(f.db,new URLSearchParams())).total,1);
 }finally{f.sql.close();}
});

test('unknown insects only alert when selected and reaching their separate threshold',async()=>{
 const f=fixture();try{
  await saveRule(f,'pest_image',pestParameters({unknown:5}));
  await pestPhoto(f,insect('unknown',4)).run();await pestPhoto(f,insect('Conogethes_punctiferalis',9)).run();
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM plant_health_alerts').get().n,0);
  await pestPhoto(f,insect('unknown',5)).run();
  const row=f.sql.prepare('SELECT * FROM plant_health_alerts').get();assert.match(row.message,/Côn trùng chưa xác định \(5\/5 con\)/);
  assert.equal(JSON.parse(row.details).identified_count,0);
 }finally{f.sql.close();}
});

test('species settings are validated, stored per crop, and changes cancel queued notifications',async()=>{
 const f=fixture();try{
  for(const p of [pestParameters({}),pestParameters({unknown:0}),pestParameters({unknown:301}),pestParameters({unknown:1.5}),pestParameters({unknown:'2'}),
   {species_thresholds:{unknown:2}},{species_thresholds:{...pestParameters({unknown:2}).species_thresholds,fake_species:1}}])assert.throws(()=>validateRuleParameters('pest_image',p),{status:422});
  f.sql.prepare("INSERT INTO telegram_recipients(id,chat_id,owner_username,display_name,connected_at,updated_at) VALUES('a','111111111','garden','User',?,?)").run(now-3600000,now-3600000);
  const p=pestParameters({Plutella_xylostella:2});await saveRule(f,'pest_image',p);
  assert.deepEqual((await observationConfig(f.db)).rules[2].parameters,p);
  await pestPhoto(f,insect('Plutella_xylostella',2)).run();await enqueueDeliveries(f.db,Date.now()+1);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM telegram_deliveries').get().n,1);
  await saveRule(f,'pest_image',pestParameters({Plutella_xylostella:4}));
  assert.ok(f.sql.prepare('SELECT failed_at FROM telegram_deliveries').get().failed_at);
  const cfg=await observationConfig(f.db);await setObservationCrop(f.db,{crop_id:'pear',revision:cfg.profile_revision});
  assert.equal((await observationConfig(f.db)).rules[2].parameters.species_thresholds.Plutella_xylostella,1);
 }finally{f.sql.close();}
});

test('deleted photos, uploads, obsolete leases, pre-setting photos and disabled rules cannot generate species alerts',async()=>{
 const f=fixture();try{
  await saveRule(f,'pest_image',pestParameters({Plutella_xylostella:1}));
  const ds=insect('Plutella_xylostella');
  for(const options of [{deleted:true},{source:'upload'},{leaseValid:false}])await pestPhoto(f,ds,options).run();
  f.sql.prepare("UPDATE observation_rules SET updated_at=? WHERE crop_id='guava' AND id='pest_image'").run(Date.now()+10000);
  await pestPhoto(f,ds).run();
  await saveRule(f,'pest_image',pestParameters({Plutella_xylostella:1}),false);await pestPhoto(f,ds).run();
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM plant_health_alerts').get().n,0);
 }finally{f.sql.close();}
});

test('pest on/off and per-image minimum are enforced before creating a real fruit-tree alert',async()=>{
 const f=fixture();try{
  const id=crypto.randomUUID(),lease=crypto.randomUUID(),d={pest_code:'Conogethes_punctiferalis',identification_status:'identified'};
  f.sql.prepare('INSERT INTO images(image_id,received_at,jpeg) VALUES(?,?,?)').run(id,now,Uint8Array.of(255,216,255,217));
  f.sql.prepare("UPDATE image_analysis SET status='running',lease_token=? WHERE image_id=?").run(lease,id);
  await saveRule(f,'pest_image',{min_identified:2});
  await pestHealthAlertInsert(f.db,{image_id:id,lease_token:lease},{detections:[d],identified_count:1},'one',now).run();assert.equal(f.sql.prepare('SELECT count(*) AS n FROM plant_health_alerts').get().n,0);
  await saveRule(f,'pest_image',{min_identified:2},false);
  await pestHealthAlertInsert(f.db,{image_id:id,lease_token:lease},{detections:[d,d],identified_count:2},'two',now).run();assert.equal(f.sql.prepare('SELECT count(*) AS n FROM plant_health_alerts').get().n,0);
  assert.ok(Knowledge.crops.durian.pest_sources[0].url.includes('nnmt.net.vn'));
 }finally{f.sql.close();}
});

test('migration disables generic alarms without deleting their thresholds, photo data or historical warnings',()=>{
 const f=fixture(sql=>{sql.prepare("INSERT INTO cloud_alerts(id,rule_id,title,message,triggered_at) VALUES('old','humidity','Humidity','Old',?)").run(now);});
 try{
  assert.equal(f.sql.prepare('SELECT sum(enabled) AS n FROM cloud_alert_rules').get().n,0);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='cloud_alert_on_telemetry'").get().n,0);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM cloud_alerts').get().n,1);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM observation_rules').get().n,12);
 }finally{f.sql.close();}
});
