// Run with Node.js 24: node --test tests/cloudflare_telegram.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { enqueueTelegramAlerts, flushTelegramAlerts, telegramDeliveryStatus } from '../infra/cloudflare/src/telegram-alerts.js';

const settings={token:'123456:abcdefghijklmnopqrstuvwxyz123456789',chatId:'123456789'};
function database(){
  const sql=new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../infra/cloudflare/schema.sql',import.meta.url),'utf8'));
  sql.exec(readFileSync(new URL('../infra/cloudflare/alerts.sql',import.meta.url),'utf8'));
  sql.exec(readFileSync(new URL('../infra/cloudflare/telegram.sql',import.meta.url),'utf8'));
  function prepare(query,values=[]){
    return {bind:(...args)=>prepare(query,args),
      first:async()=>sql.prepare(query).get(...values)??null,
      all:async()=>({results:sql.prepare(query).all(...values)}),
      run:async()=>({meta:{changes:Number(sql.prepare(query).run(...values).changes)}}),
      _run:()=>{
        const stmt=sql.prepare(query);
        if(/^\s*SELECT/.test(query))return {results:stmt.all(...values),meta:{changes:0}};
        return {meta:{changes:Number(stmt.run(...values).changes)}};
      }};
  }
  return {sql,prepare,batch:async statements=>{
    sql.exec('BEGIN');
    try{const rows=statements.map(s=>s._run());sql.exec('COMMIT');return rows;}
    catch(error){sql.exec('ROLLBACK');throw error;}
  }};
}
function seed(db){
  const now=Date.now();
  db.sql.prepare('INSERT INTO cloud_alerts(id,rule_id,title,message,triggered_at) VALUES(?,?,?,?,?)')
    .run('alert-1','humidity','Độ ẩm không khí cao','87%, ngưỡng 80%',now);
  db.sql.prepare('INSERT INTO telegram_alert_outbox(alert_id,chat_id,created_at,next_attempt_at) VALUES(?,?,?,?)')
    .run('alert-1',settings.chatId,now,now);
}

test('real sensor threshold creates exactly one queued alert, including duplicate telemetry replay',async()=>{
  const db=database();
  try{
    const now=Date.now(), id=crypto.randomUUID();
    const insert=()=>db.prepare(`INSERT INTO telemetry(message_id,observed_at,received_at,measurements)
      VALUES(?,?,?,?) ON CONFLICT(message_id) DO NOTHING`).bind(id,now,now,JSON.stringify({air_humidity_pct:90}));
    await db.batch([insert(),enqueueTelegramAlerts(db,settings.chatId,now)]);
    assert.equal(db.sql.prepare('SELECT count(*) AS n FROM telegram_alert_outbox').get().n,1);
    await db.batch([insert(),enqueueTelegramAlerts(db,settings.chatId,now)]);
    assert.equal(db.sql.prepare('SELECT count(*) AS n FROM telegram_alert_outbox').get().n,1);
  }finally{db.sql.close();}
});

test('Cloudflare-compatible request sends once; acknowledged web alerts still deliver',async()=>{
  const db=database();seed(db);let calls=0;
  try{
    db.sql.exec('UPDATE cloud_alerts SET acknowledged_at=1');
    const send=async(url,options)=>{
      calls++;
      assert.equal(new URL(url).hostname,'api.telegram.org');
      assert.equal(options.redirect,'manual','Workers rejects redirect:error before any request reaches Telegram');
      assert.equal(options.method,'POST');
      const body=JSON.parse(options.body);
      assert.equal(body.chat_id,settings.chatId);
      assert.match(body.text,/Độ ẩm không khí cao/);
      return Response.json({ok:true,result:{message_id:1}});
    };
    await flushTelegramAlerts(db,settings,send);
    await flushTelegramAlerts(db,settings,send);
    assert.equal(calls,1);
    const row=db.sql.prepare('SELECT * FROM telegram_alert_outbox').get();
    assert.ok(row.sent_at);assert.equal(row.attempts,1);assert.equal(row.failed_at,null);
    const status=await telegramDeliveryStatus(db,settings);
    assert.equal(status.summary.sent,1);
    assert.ok(!JSON.stringify(status).includes(settings.token));
    assert.ok(!JSON.stringify(status).includes(settings.chatId));
  }finally{db.sql.close();}
});

test('temporary failures retry, rate limits are respected and permanent errors stop',async()=>{
  for(const [code,permanent] of [[500,false],[429,false],[403,true],[302,true]]){
    const db=database();seed(db);
    try{
      await flushTelegramAlerts(db,settings,async()=>Response.json({ok:false,error_code:code,parameters:{retry_after:120}},{status:code}));
      const row=db.sql.prepare('SELECT * FROM telegram_alert_outbox').get();
      assert.equal(row.sent_at,null);
      assert.equal(Boolean(row.failed_at),permanent);
      assert.ok(row.next_attempt_at>=Date.now()+119000);
    }finally{db.sql.close();}
  }
});

test('transport errors never mark the message sent; concurrent flushes claim it only once',async()=>{
  const db=database();seed(db);let calls=0,release;
  try{
    const wait=new Promise(resolve=>release=resolve);
    const first=flushTelegramAlerts(db,settings,async()=>{calls++;await wait;throw new TypeError('transport unavailable');});
    await Promise.resolve();await Promise.resolve();
    await flushTelegramAlerts(db,settings,async()=>{calls++;return Response.json({ok:true});});
    release();await first;
    assert.equal(calls,1);
    const row=db.sql.prepare('SELECT * FROM telegram_alert_outbox').get();
    assert.equal(row.sent_at,null);assert.equal(row.failed_at,null);assert.equal(row.attempts,1);
  }finally{db.sql.close();}
});
