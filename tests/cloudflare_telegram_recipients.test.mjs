import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createPairing,pollPairing,pollConnections,confirmPairing,cancelPairing,pairingStatus,listRecipients,
 updateRecipient,enqueueDeliveries,flushDeliveries,enqueueRecipientTest,enqueueDemoResultTest,deliveryReceipt,hasTelegramRecipients} from '../infra/cloudflare/src/telegram-recipients.js';
const token='123456:abcdefghijklmnopqrstuvwxyz123456789',admin={username:'garden',role:'admin'},alice={username:'alice',role:'member'},bob={username:'bob',role:'member'};
function fixture(beforeMigration){
 const sql=new DatabaseSync(':memory:');
 for(const name of ['schema.sql','alerts.sql','telegram.sql','telegram-pairing.sql','station-startups.sql','camera-requests.sql','automation.sql','plant-health.sql'])sql.exec(readFileSync(new URL('../infra/cloudflare/'+name,import.meta.url),'utf8'));
 beforeMigration?.(sql);sql.exec(readFileSync(new URL('../infra/cloudflare/telegram-recipients.sql',import.meta.url),'utf8'));
 sql.exec(readFileSync(new URL('../infra/cloudflare/observation-alerts.sql',import.meta.url),'utf8'));
 function prepare(query,values=[]){return {bind:(...args)=>prepare(query,args),first:async column=>{const row=sql.prepare(query).get(...values);return column?row?.[column]??null:row??null;},
  all:async()=>({results:sql.prepare(query).all(...values)}),run:async()=>({meta:{changes:Number(sql.prepare(query).run(...values).changes)}}),
  _run:()=>{const stmt=sql.prepare(query);return stmt.columns().length?{results:stmt.all(...values),meta:{changes:sql.prepare('SELECT changes() AS n').get().n}}:{results:[],meta:{changes:Number(stmt.run(...values).changes)}};}};}
 const db={prepare,batch:async statements=>{sql.exec('BEGIN');try{const rows=statements.map(s=>s._run());sql.exec('COMMIT');return rows;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const env={DB:db,TELEGRAM_BOT_TOKEN:token},state={updates:[],calls:[],failChat:null,failCode:0,invalidReceipt:false,wrongBot:false,nextMessage:100};
 const send=async(url,options)=>{
  assert.equal(new URL(url).hostname,'api.telegram.org');assert.equal(options.redirect,'manual');
  const method=new URL(url).pathname.split('/').at(-1),body=JSON.parse(options.body);state.calls.push({method,body});
  if(method==='getMe')return Response.json({ok:true,result:{id:777,is_bot:true,username:'Ptit_Test_Bot'}});
  if(method==='getUpdates')return Response.json({ok:true,result:state.updates.filter(u=>u.update_id>=body.offset)});
  assert.equal(method,'sendMessage');assert.ok(body.text.length<=4096);
  if(state.failChat===body.chat_id)return Response.json({ok:false,error_code:state.failCode,parameters:{retry_after:600}},{status:state.failCode});
  return Response.json({ok:true,result:state.invalidReceipt?{}:{message_id:state.nextMessage++,chat:{id:Number(body.chat_id)},from:{id:state.wrongBot?888:777}}});
 };
 const message=(id,pair,chat=111111111,extras={})=>({update_id:id,message:{text:pair.command,date:Math.floor(Date.now()/1000),chat:{id:chat,type:'private',first_name:'User '+chat},from:{id:chat},...extras}});
 async function connect(account,chat,updateId){const pair=await createPairing(env,account,send);state.updates.push(message(updateId,pair,chat));sql.exec('DELETE FROM telegram_poll_lock');await pollPairing(env,pair.id,account,send);await confirmPairing(env,pair.id,account);return pair;}
 return {sql,db,env,state,send,message,connect};
}

test('two web accounts pair concurrently using independent scoped codes; global polling does not consume the other user’s connection',async()=>{
 const f=fixture();try{
  const a=await createPairing(f.env,alice,f.send),b=await createPairing(f.env,bob,f.send);
  assert.notEqual(a.id,b.id);assert.match(a.command,/^\/start [a-f0-9]{32}_\d{6}$/);
  assert.equal(a.bot_url,'https://t.me/Ptit_Test_Bot?start='+a.command.slice(7));
  f.state.updates=[f.message(1,a,111111111),f.message(2,b,222222222)];
  assert.equal((await pollPairing(f.env,a.id,alice,f.send)).status,'confirmation');
  assert.equal((await pollPairing(f.env,b.id,bob,f.send)).status,'confirmation');
  await assert.rejects(confirmPairing(f.env,a.id,bob),{status:404});
  await Promise.all([confirmPairing(f.env,a.id,alice),confirmPairing(f.env,b.id,bob)]);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM telegram_recipients').get().n,2);
  const stored=f.sql.prepare('SELECT code_hash FROM telegram_pairings WHERE request_id=?').get(a.id);assert.equal(stored.code_hash.length,64);assert.notEqual(stored.code_hash,a.code);
  await assert.rejects(confirmPairing(f.env,a.id,alice),{status:409});
  assert.equal((await listRecipients(f.env,alice)).recipients.length,1);
  assert.equal((await listRecipients(f.env,admin)).recipients.length,2);
  assert.ok(!JSON.stringify(await listRecipients(f.env,alice)).includes('222222222'));
 }finally{f.sql.close();}
});

test('successful pairing queues exactly one Telegram acknowledgement per person with verified message receipt',async()=>{
 const f=fixture();try{
  await f.connect(alice,111111111,1);await f.connect(bob,222222222,2);
  await Promise.all([flushDeliveries(f.env,f.send),flushDeliveries(f.env,f.send)]);
  const rows=f.sql.prepare('SELECT * FROM telegram_deliveries').all();assert.equal(rows.length,2);
  assert.ok(rows.every(r=>r.kind==='connection'&&r.sent_at&&r.message_id&&r.bot_username==='Ptit_Test_Bot'));
  const calls=f.state.calls.filter(c=>c.method==='sendMessage');assert.equal(calls.length,2);assert.ok(calls.every(c=>c.body.text.includes('Đã nhận kết nối')));
  assert.ok((await listRecipients(f.env,admin)).recipients.every(r=>r.state==='ready'));
  await flushDeliveries(f.env,f.send);assert.equal(f.state.calls.filter(c=>c.method==='sendMessage').length,2);
 }finally{f.sql.close();}
});

test('new recipients add to existing subscriptions; reconnecting the same chat does not duplicate it',async()=>{
 const f=fixture();try{
  await f.connect(admin,111111111,1);f.sql.exec('UPDATE telegram_pairings SET created_at=0');await f.connect(admin,222222222,2);
  assert.equal((await listRecipients(f.env,admin)).recipients.length,2);
  f.sql.exec('UPDATE telegram_pairings SET created_at=0');await f.connect(admin,111111111,3);
  assert.equal((await listRecipients(f.env,admin)).recipients.length,2);
  const a=(await listRecipients(f.env,admin)).recipients[0];await assert.rejects(updateRecipient(f.env,a.id,{enabled:false},bob),{status:404});
 }finally{f.sql.close();}
});

test('environment, disease/pest and station startup fan out to every eligible recipient without replay',async()=>{
 const f=fixture();try{
  await f.connect(alice,111111111,1);await f.connect(bob,222222222,2);await flushDeliveries(f.env,f.send);
  const at=Date.now()+10;
  f.sql.prepare('INSERT INTO cloud_alerts(id,rule_id,title,message,triggered_at) VALUES(?,?,?,?,?)').run('env','humidity','Humidity','High',at);
  f.sql.prepare("INSERT INTO plant_health_alerts(id,event_key,kind,title,message,details,triggered_at,next_attempt_at) VALUES('health','health-key','climate','Disease risk','Advice','{}',?,?)").run(at,at);
  f.sql.prepare('INSERT INTO station_startups(id,received_at,next_attempt_at) VALUES(?,?,?)').run('boot',at,at);
  await enqueueDeliveries(f.db,at+1);await enqueueDeliveries(f.db,at+1);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM telegram_deliveries WHERE kind!='connection'").get().n,6);
  await new Promise(r=>setTimeout(r,15));await flushDeliveries(f.env,f.send);
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM telegram_deliveries WHERE sent_at IS NOT NULL").get().n,8);
 }finally{f.sql.close();}
});

test('a blocked recipient does not prevent other recipients receiving the same alert; 429 delays retries',async()=>{
 const f=fixture();try{
  await f.connect(alice,111111111,1);await f.connect(bob,222222222,2);f.state.failChat='111111111';f.state.failCode=403;
  await flushDeliveries(f.env,f.send);
  const states=f.sql.prepare('SELECT chat_id,delivery_state FROM telegram_recipients').all();assert.equal(states.find(r=>r.chat_id==='111111111').delivery_state,'blocked');assert.equal(states.find(r=>r.chat_id==='222222222').delivery_state,'ready');
  const b=(await listRecipients(f.env,bob)).recipients[0];f.state.failChat='222222222';f.state.failCode=429;
  const queued=await enqueueRecipientTest(f.env,b.id,{request_id:crypto.randomUUID()},bob);await flushDeliveries(f.env,f.send,{recipientId:b.id});
  const row=f.sql.prepare('SELECT * FROM telegram_deliveries WHERE event_key=?').get(queued.event_key);assert.equal(row.failed_at,null);assert.ok(row.next_attempt_at>Date.now()+590000);
 }finally{f.sql.close();}
});

test('pausing stops queued notifications; reenable/new connections never backfill previous alerts',async()=>{
 const f=fixture();try{
  await f.connect(alice,111111111,1);const a=(await listRecipients(f.env,alice)).recipients[0];
  await updateRecipient(f.env,a.id,{enabled:false},alice);await flushDeliveries(f.env,f.send);assert.equal(f.state.calls.filter(c=>c.method==='sendMessage').length,0);
  const past=Date.now()-60000;f.sql.prepare('INSERT INTO cloud_alerts(id,rule_id,title,message,triggered_at) VALUES(?,?,?,?,?)').run('old','humidity','Old','Old',past);
  await updateRecipient(f.env,a.id,{enabled:true},alice);await enqueueDeliveries(f.db);assert.equal(f.sql.prepare("SELECT count(*) AS n FROM telegram_deliveries WHERE kind='environment'").get().n,0);
  await f.connect(bob,222222222,2);await enqueueDeliveries(f.db);assert.equal(f.sql.prepare("SELECT count(*) AS n FROM telegram_deliveries WHERE kind='environment'").get().n,0);
 }finally{f.sql.close();}
});

test('ok:true without a valid Telegram message, target chat or sender proof is not marked delivered',async()=>{
 for(const option of ['invalidReceipt','wrongBot']){const f=fixture();try{
  await f.connect(alice,111111111,1);f.state[option]=true;await flushDeliveries(f.env,f.send);
  assert.equal(f.sql.prepare('SELECT sent_at FROM telegram_deliveries').get().sent_at,null);
  assert.equal((await listRecipients(f.env,alice)).recipients[0].state,'error');
 }finally{f.sql.close();}}
});

test('manual test is scoped to the chosen recipient and exposes actual bot/message proof',async()=>{
 const f=fixture();try{
  await f.connect(alice,111111111,1);await flushDeliveries(f.env,f.send);const a=(await listRecipients(f.env,alice)).recipients[0];
  await assert.rejects(enqueueRecipientTest(f.env,a.id,{request_id:crypto.randomUUID()},bob),{status:404});
  const queued=await enqueueRecipientTest(f.env,a.id,{request_id:crypto.randomUUID()},alice);await flushDeliveries(f.env,f.send,{limit:1,recipientId:a.id});
  const receipt=await deliveryReceipt(f.env,queued.event_key,a.id,alice);assert.ok(receipt.message_id);assert.equal(receipt.bot_username,'Ptit_Test_Bot');
  await assert.rejects(enqueueRecipientTest(f.env,a.id,{request_id:crypto.randomUUID()},alice),{status:429});
  assert.ok(await hasTelegramRecipients(f.env));assert.equal(await hasTelegramRecipients({...f.env,TELEGRAM_BOT_TOKEN:''}),false);
 }finally{f.sql.close();}
});

test('forged/expired/cancelled codes and ten bad guesses never activate recipients; polling preserves cursor',async()=>{
 const f=fixture();try{
  const a=await createPairing(f.env,alice,f.send);
  f.state.updates=[f.message(1,a,111111111,{from:{id:999}}),f.message(2,a,111111111,{chat:{id:111111111,type:'group'}}),f.message(3,a,111111111,{date:1})];
  assert.equal((await pollPairing(f.env,a.id,alice,f.send)).status,'pending');
  f.sql.exec('DELETE FROM telegram_poll_lock');
  const wrong=a.command.slice(0,-6)+(a.code==='000000'?'000001':'000000');f.state.updates=Array.from({length:10},(_,i)=>f.message(i+4,{command:wrong}));
  assert.equal((await pollPairing(f.env,a.id,alice,f.send)).status,'cancelled');assert.equal(f.sql.prepare('SELECT count(*) AS n FROM telegram_recipients').get().n,0);
  const b=await createPairing(f.env,bob,f.send);await cancelPairing(f.env,b.id,bob);await assert.rejects(confirmPairing(f.env,b.id,bob),{status:409});
  await assert.rejects(pollPairing(f.env,b.id,alice,f.send),{status:404});
 }finally{f.sql.close();}
});

test('demo result sends the displayed 27/3/24 counts as a labelled test, scoped to the selected recipient without creating real alerts',async()=>{
 const f=fixture();try{
  await f.connect(alice,111111111,1);await flushDeliveries(f.env,f.send);
  const a=(await listRecipients(f.env,alice)).recipients[0];
  const body={request_id:crypto.randomUUID(),sample_id:'cn_01',model_version:'ptit-insects-p2-preserved-20261109-v1',counts:{Cnaphalocrocis_medinalis:3,unknown:24}};
  await assert.rejects(enqueueDemoResultTest(f.env,a.id,body,bob),{status:404});
  const queued=await enqueueDemoResultTest(f.env,a.id,body,alice);await flushDeliveries(f.env,f.send,{limit:1,recipientId:a.id});
  const text=f.state.calls.filter(c=>c.method==='sendMessage').at(-1).body.text;
  assert.match(text,/CẢNH BÁO THỬ TỪ ẢNH MẪU/);assert.match(text,/tổng 27 côn trùng; gợi ý được loài 3; chưa xác định 24/);
  assert.match(text,/Ký chủ: Lúa/);assert.match(text,/Chưa có căn cứ suy ra bệnh cây ăn quả/);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM plant_health_alerts').get().n,0);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM images').get().n,0);
  assert.ok((await deliveryReceipt(f.env,queued.event_key,a.id,alice)).message_id);
  const before=f.state.calls.filter(c=>c.method==='sendMessage').length;
  assert.equal((await enqueueDemoResultTest(f.env,a.id,body,alice)).event_key,queued.event_key);
  await flushDeliveries(f.env,f.send);assert.equal(f.state.calls.filter(c=>c.method==='sendMessage').length,before);
 }finally{f.sql.close();}
});

test('demo messages reject arbitrary sample names, classes, impossible counts and text injection',async()=>{
 const f=fixture();try{
  await f.connect(alice,111111111,1);const a=(await listRecipients(f.env,alice)).recipients[0];
  const base={request_id:crypto.randomUUID(),sample_id:'cn_01',model_version:'p2',counts:{unknown:24}};
  for(const change of [{sample_id:'real-camera'},{counts:{unknown:301}},{counts:{unknown:-1}},{counts:{unknown:1.5}},{counts:{fake_species:1}},{counts:{unknown:300,Cnaphalocrocis_medinalis:1}},{model_version:'p2\nALERT'},{text:'custom message'}]){
   await assert.rejects(enqueueDemoResultTest(f.env,a.id,{...base,...change},alice),{status:422});
  }
  assert.equal(f.sql.prepare("SELECT count(*) AS n FROM telegram_deliveries WHERE kind='test'").get().n,0);
 }finally{f.sql.close();}
});

test('migration retains legacy recipient and sent/failed outcomes without generating a welcome or replaying test messages',async()=>{
 const at=Date.now()-60000;
 const f=fixture(sql=>{
  sql.prepare("INSERT INTO telegram_connection VALUES(1,'111111111','Legacy',?)").run(at-60000);
  sql.prepare("INSERT INTO cloud_alerts(id,rule_id,title,message,triggered_at) VALUES('old','humidity','Old','Old',?)").run(at);
  sql.prepare("INSERT INTO telegram_alert_outbox(alert_id,chat_id,created_at,next_attempt_at,sent_at) VALUES('old','111111111',?,?,?)").run(at,at,at);
 });try{
  f.sql.exec(readFileSync(new URL('../infra/cloudflare/telegram-recipients.sql',import.meta.url),'utf8'));
  await enqueueDeliveries(f.db);await flushDeliveries(f.env,f.send);
  assert.equal(f.state.calls.filter(c=>c.method==='sendMessage').length,0);
  assert.equal(f.sql.prepare('SELECT count(*) AS n FROM telegram_recipients').get().n,1);
  assert.equal(f.sql.prepare('SELECT sent_at FROM telegram_deliveries').get().sent_at,at);
 }finally{f.sql.close();}
});
