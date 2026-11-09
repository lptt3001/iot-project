import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createPairing, pollPairing, confirmPairing, cancelPairing, pairingStatus, resolveTelegramSettings } from '../infra/cloudflare/src/telegram-pairing.js';

const token='123456:abcdefghijklmnopqrstuvwxyz123456789';
function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../infra/cloudflare/telegram-pairing.sql',import.meta.url),'utf8'));
 function prepare(query,values=[]){
  return {bind:(...args)=>prepare(query,args),first:async()=>sql.prepare(query).get(...values)??null,
   run:async()=>({meta:{changes:Number(sql.prepare(query).run(...values).changes)}}),
   _run:()=>{
    const statement=sql.prepare(query);
    if(statement.columns().length){const results=statement.all(...values);return {results,meta:{changes:sql.prepare('SELECT changes() AS n').get().n}};}
    return {results:[],meta:{changes:Number(statement.run(...values).changes)}};
   }};
 }
 const db={prepare,batch:async statements=>{
  sql.exec('BEGIN');try{const result=statements.map(s=>s._run());sql.exec('COMMIT');return result;}
  catch(error){sql.exec('ROLLBACK');throw error;}
 }};
 const env={DB:db,TELEGRAM_BOT_TOKEN:token,TELEGRAM_CHAT_ID:'111111111'};
 const state={updates:[],calls:[],failure:null};
 const send=async(url,options)=>{
  assert.equal(new URL(url).hostname,'api.telegram.org');assert.equal(options.redirect,'manual');
  const method=new URL(url).pathname.split('/').at(-1),fields=JSON.parse(options.body);state.calls.push({method,fields});
  if(state.failure)return Response.json({ok:false,error_code:state.failure},{status:state.failure});
  if(method==='getMe')return Response.json({ok:true,result:{is_bot:true,username:'Ptit_Test_Bot'}});
  assert.equal(method,'getUpdates','pairing must never send messages or mutate webhook configuration');
  return Response.json({ok:true,result:state.updates.filter(u=>u.update_id>=fields.offset)});
 };
 return {sql,env,state,send,close:()=>sql.close()};
}
const message=(id,code,extra={})=>({update_id:id,message:{date:Math.floor(Date.now()/1000),text:`/start ${code}`,
 chat:{id:222222222,type:'private',first_name:'Nguyễn',username:'garden_user'},from:{id:222222222},...extra}});

test('six digit one-use code is hashed; status and cancellation keep existing recipient private and unchanged',async()=>{
 const f=fixture();try{
  assert.equal((await resolveTelegramSettings(f.env)).chatId,'111111111');
  const pair=await createPairing(f.env,f.send);
  assert.match(pair.code,/^\d{6}$/);assert.equal(pair.command,`/start ${pair.code}`);
  assert.equal(pair.bot_url,`https://t.me/Ptit_Test_Bot?start=${pair.code}`);
  const stored=f.sql.prepare('SELECT * FROM telegram_pairing').get();
  assert.notEqual(stored.code_hash,pair.code);assert.equal(stored.code_hash.length,64);
  assert.equal(pair.expires_at-stored.created_at,300000);
  const status=JSON.stringify(await pairingStatus(f.env));
  for(const secret of [token,'111111111',pair.code,stored.code_hash])assert.ok(!status.includes(secret));
  await assert.rejects(createPairing(f.env,f.send),{status:429});
  await cancelPairing(f.env,pair.id);
  assert.equal((await pairingStatus(f.env)).pairing.status,'cancelled');
  assert.equal((await resolveTelegramSettings(f.env)).chatId,'111111111');
  await assert.rejects(confirmPairing(f.env,pair.id),{status:409});
 }finally{f.close();}
});

test('a matching private chat needs explicit admin confirmation before alerts switch recipients',async()=>{
 const f=fixture();try{
  const pair=await createPairing(f.env,f.send);f.state.updates=[message(10,pair.code)];
  const matched=await pollPairing(f.env,pair.id,f.send);
  assert.equal(matched.status,'confirmation');assert.match(matched.candidate_name,/Nguyễn/);
  assert.equal(matched.candidate_chat,'…2222');
  assert.equal((await resolveTelegramSettings(f.env)).chatId,'111111111');
  assert.ok(!JSON.stringify(matched).includes('222222222'));
  const accepted=await confirmPairing(f.env,pair.id);
  assert.equal(accepted.pairing.status,'connected');
  assert.equal((await resolveTelegramSettings(f.env)).chatId,'222222222');
  await assert.rejects(confirmPairing(f.env,pair.id),{status:409});
  assert.equal((await pollPairing(f.env,pair.id,f.send)).status,'connected');
 }finally{f.close();}
});

test('expiry, replacement, replay, group messages and forged identities cannot replace the recipient',async()=>{
 const f=fixture();try{
  const old=await createPairing(f.env,f.send);
  f.sql.exec('UPDATE telegram_pairing SET expires_at=1');
  assert.equal((await pollPairing(f.env,old.id,f.send)).status,'expired');
  await assert.rejects(confirmPairing(f.env,old.id),{status:409});
  f.sql.exec('UPDATE telegram_pairing SET created_at=0');
  const pair=await createPairing(f.env,f.send);
  await assert.rejects(pollPairing(f.env,old.id,f.send),{status:404});
  f.state.updates=[
   message(1,pair.code,{chat:{id:-123,type:'group'},from:{id:222222222}}),
   message(2,pair.code,{from:{id:999999999}}),
   message(3,pair.code,{date:Math.floor(Date.now()/1000)-60}),
   message(4,pair.code,{text:`/start@Another_Bot ${pair.code}`}),
  ];
  assert.equal((await pollPairing(f.env,pair.id,f.send)).status,'pending');
  f.sql.exec('UPDATE telegram_pairing SET poll_after=0');
  // Previously consumed update ids cannot be replayed after a new poll.
  f.state.updates=[message(2,pair.code)];
  assert.equal((await pollPairing(f.env,pair.id,f.send)).status,'pending');
  assert.equal((await resolveTelegramSettings(f.env)).chatId,'111111111');
 }finally{f.close();}
});

test('ten wrong guesses cancel the code; a later correct message cannot bypass the limit',async()=>{
 const f=fixture();try{
  const pair=await createPairing(f.env,f.send),wrong=pair.code==='000000'?'000001':'000000';
  f.state.updates=Array.from({length:10},(_,i)=>message(i+1,wrong));
  assert.equal((await pollPairing(f.env,pair.id,f.send)).status,'cancelled');
  f.state.updates=[message(20,pair.code)];f.sql.exec('UPDATE telegram_pairing SET poll_after=0');
  assert.equal((await pollPairing(f.env,pair.id,f.send)).status,'cancelled');
  await assert.rejects(confirmPairing(f.env,pair.id),{status:409});
 }finally{f.close();}
});

test('poll lease prevents duplicate readers; failures are recoverable and never expose the token',async()=>{
 const f=fixture();try{
  const pair=await createPairing(f.env,f.send);
  let release,entered;
  const waiting=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  let calls=0;
  const first=pollPairing(f.env,pair.id,async(url,options)=>{calls++;entered();await waiting;return f.send(url,options);});
  await started;
  assert.equal((await pollPairing(f.env,pair.id,()=>{throw Error('duplicate reader');})).status,'pending');
  release();await first;assert.equal(calls,1);
  f.sql.exec('UPDATE telegram_pairing SET poll_after=0');f.state.failure=409;
  await assert.rejects(pollPairing(f.env,pair.id,f.send),error=>error.status===409&&!error.message.includes(token));
  assert.equal((await pairingStatus(f.env)).pairing.status,'pending');
  assert.equal((await resolveTelegramSettings(f.env)).chatId,'111111111');
 }finally{f.close();}
});

test('bot-only configuration can pair without a legacy recipient; malformed bot responses cannot create codes',async()=>{
 const f=fixture();try{
  delete f.env.TELEGRAM_CHAT_ID;
  assert.equal(await resolveTelegramSettings(f.env),null);
  const pair=await createPairing(f.env,f.send);f.state.updates=[message(1,pair.code)];
  await pollPairing(f.env,pair.id,f.send);await confirmPairing(f.env,pair.id);
  assert.equal((await resolveTelegramSettings(f.env)).chatId,'222222222');
  f.sql.exec('UPDATE telegram_pairing SET created_at=0');
  await assert.rejects(createPairing(f.env,async()=>Response.json({ok:true,result:{username:'bad/name',is_bot:true}})),{status:503});
 }finally{f.close();}
});
