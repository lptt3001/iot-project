import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {recordStationStartup,flushStationStartups} from '../infra/cloudflare/src/station-startups.js';

const settings={token:'123456:abcdefghijklmnopqrstuvwxyz123456789',chatId:'123456789'};
function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../infra/cloudflare/station-startups.sql',import.meta.url),'utf8'));
 function prepare(query,values=[]){return {
  bind:(...args)=>prepare(query,args),first:async()=>sql.prepare(query).get(...values)??null,
  run:async()=>({meta:{changes:Number(sql.prepare(query).run(...values).changes)}}),
 };}
 return {sql,prepare};
}

test('one boot ID survives resends and concurrent delivery; a new boot gets a new message',async()=>{
 const db=fixture(),id=crypto.randomUUID();let calls=0,release;
 try{
  assert.equal((await recordStationStartup(db,settings,{boot_id:id})).duplicate,false);
  assert.equal((await recordStationStartup(db,settings,{boot_id:id.toUpperCase()})).duplicate,true);
  const wait=new Promise(resolve=>release=resolve);
  const send=async(url,options)=>{
   calls++;assert.equal(options.redirect,'manual');assert.equal(new URL(url).hostname,'api.telegram.org');
   const body=JSON.parse(options.body);assert.equal(body.chat_id,settings.chatId);
   assert.match(body.text,/Trạm khởi động/);assert.match(body.text,/station-001/);
   await wait;return Response.json({ok:true,result:{message_id:1}});
  };
  const first=flushStationStartups(db,settings,send);
  await new Promise(resolve=>setImmediate(resolve));
  await flushStationStartups(db,settings,send);assert.equal(calls,1);
  release();await first;
  await recordStationStartup(db,settings,{boot_id:id});await flushStationStartups(db,settings,send);
  assert.equal(calls,1);
  await recordStationStartup(db,settings,{boot_id:crypto.randomUUID()});await flushStationStartups(db,settings,send);
  assert.equal(calls,2);assert.equal(db.sql.prepare('SELECT count(*) AS n FROM station_startups WHERE sent_at IS NOT NULL').get().n,2);
 }finally{db.sql.close();}
});

test('failed Telegram requests retry with backoff, respect rate limits, stop on permanent errors and handle exhausted leases',async()=>{
 for(const code of [500,429,403,302]){
  const db=fixture();try{
   await recordStationStartup(db,settings,{boot_id:crypto.randomUUID()});
   await flushStationStartups(db,settings,async()=>Response.json({ok:false,error_code:code,parameters:{retry_after:120}},{status:code}));
   const row=db.sql.prepare('SELECT * FROM station_startups').get();
   assert.equal(row.sent_at,null);assert.equal(Boolean(row.failed_at),[403,302].includes(code));
   if(code===429)assert.ok(row.next_attempt_at>=Date.now()+119000);
   let called=false;await flushStationStartups(db,settings,async()=>{called=true;});assert.equal(called,false);
   db.sql.exec('UPDATE station_startups SET attempts=5,next_attempt_at=0,failed_at=NULL');
   await flushStationStartups(db,settings,async()=>{throw Error('must not send exhausted event');});
   assert.ok(db.sql.prepare('SELECT failed_at FROM station_startups').get().failed_at);
  }finally{db.sql.close();}
 }
});

test('malformed events fail; disabled Telegram records the boot without sending or exposing configuration',async()=>{
 const db=fixture();try{
  for(const body of [null,{}, {boot_id:'bad'}, {boot_id:crypto.randomUUID(),chat_id:'spoof'}]){
   await assert.rejects(recordStationStartup(db,settings,body));
  }
  const result=await recordStationStartup(db,null,{boot_id:crypto.randomUUID()});
  assert.equal(result.telegram_configured,false);
  await flushStationStartups(db,null,()=>{throw Error('disabled Telegram must not send');});
  assert.equal(db.sql.prepare('SELECT chat_id FROM station_startups').get().chat_id,null);
 }finally{db.sql.close();}
});
