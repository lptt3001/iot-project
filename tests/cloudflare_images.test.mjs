import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { setImageTrashed, cameraImageInsert, uploadedImageInsert } from '../infra/cloudflare/src/image-library.js';
import { createCameraRequest, nextCameraRequest } from '../infra/cloudflare/src/camera-requests.js';
import { imageData, dashboardData } from '../infra/cloudflare/src/dashboard-data.js';

function database(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../infra/cloudflare/schema.sql',import.meta.url),'utf8'));
 sql.exec(readFileSync(new URL('../infra/cloudflare/camera-requests.sql',import.meta.url),'utf8'));
 sql.exec(readFileSync(new URL('../infra/cloudflare/automation.sql',import.meta.url),'utf8'));
 function prepare(query,values=[]){return {bind:(...args)=>prepare(query,args),
  first:async()=>sql.prepare(query).get(...values)??null,
   all:async()=>({results:sql.prepare(query).all(...values)}),
   run:async()=>({meta:{changes:Number(sql.prepare(query).run(...values).changes)}}),
   _run:()=>{
    const statement=sql.prepare(query);
    if(statement.columns().length){const results=statement.all(...values);return {results,meta:{changes:sql.prepare('SELECT changes() AS n').get().n}};}
    return {results:[],meta:{changes:Number(statement.run(...values).changes)}};
   }};}
 return {sql,prepare,batch:async statements=>{
  sql.exec('BEGIN');try{const rows=statements.map(s=>s._run());sql.exec('COMMIT');return rows;}
  catch(error){sql.exec('ROLLBACK');throw error;}
 }};
}
const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
function seed(db,id,received=Date.now()){
 db.sql.prepare('INSERT INTO images(image_id,received_at,jpeg) VALUES(?,?,?)').run(id,received,new Uint8Array([255,216,255,217]));
}

test('camera provenance snapshots the authenticated requester and survives command pruning and duplicate JPEG replay',async()=>{
 const db=database(),jpeg=new Uint8Array([255,216,255,217]);
 try{
  await nextCameraRequest(db);
  await createCameraRequest(db,a,'garden');
  await createCameraRequest(db,a,'another-user');
  assert.equal(db.sql.prepare('SELECT requested_by FROM camera_requests WHERE id=?').get(a).requested_by,'garden');
  await nextCameraRequest(db);
  await cameraImageInsert(db,a,Date.now(),jpeg).run();
  await cameraImageInsert(db,b,Date.now(),jpeg).run();
  db.sql.exec('DELETE FROM camera_requests');
  await cameraImageInsert(db,a,Date.now()+1000,new Uint8Array([1,2,3,4])).run();
  const rows=(await imageData(db,new URLSearchParams())).rows;
  assert.equal(rows.find(r=>r.id===a).capture_origin,'manual');
  assert.equal(rows.find(r=>r.id===a).actor_username,'garden');
  assert.equal(rows.find(r=>r.id===b).capture_origin,'automatic');
  assert.equal(rows.find(r=>r.id===b).actor_username,null);
  assert.deepEqual(db.sql.prepare('SELECT jpeg FROM images WHERE image_id=?').get(a).jpeg,jpeg);
 }finally{db.sql.close();}
});

test('uploads keep account attribution through trash/restore while legacy photos stay unknown',async()=>{
 const db=database(),jpeg=new Uint8Array([255,216,255,217]);
 try{
  await uploadedImageInsert(db,a,Date.now(),jpeg,'garden').run();seed(db,b);
  await setImageTrashed(db,a,true);
  let row=(await imageData(db,new URLSearchParams('trashed=1'))).rows[0];
  assert.equal(row.capture_origin,'upload');assert.equal(row.actor_username,'garden');
  await setImageTrashed(db,a,false);
  row=(await imageData(db,new URLSearchParams(),a)).rows[0];
  assert.equal(row.actor_username,'garden');
  const legacy=(await imageData(db,new URLSearchParams(),b)).rows[0];
  assert.equal(legacy.capture_origin,'unknown');assert.equal(legacy.actor_username,null);
 }finally{db.sql.close();}
});

test('trash hides image from gallery and totals, restore preserves original JPEG and timestamp',async()=>{
 const db=database();
 try{
  seed(db,a,1000);seed(db,b,2000);
  assert.equal((await imageData(db,new URLSearchParams())).total,2);
  assert.deepEqual(await setImageTrashed(db,b,true),{id:b,trashed:true});
  const deleted=db.sql.prepare('SELECT * FROM images WHERE image_id=?').get(b);
  assert.ok(deleted.deleted_at);
  await setImageTrashed(db,b,true);
  assert.equal(db.sql.prepare('SELECT deleted_at FROM images WHERE image_id=?').get(b).deleted_at,deleted.deleted_at);
  const active=await imageData(db,new URLSearchParams());
  assert.equal(active.total,1);assert.equal(active.rows[0].id,a);
  assert.equal((await imageData(db,new URLSearchParams(),b)).total,0);
  const trash=await imageData(db,new URLSearchParams('trashed=1'));
  assert.equal(trash.total,1);assert.equal(trash.rows[0].id,b);assert.ok(trash.rows[0].deleted_at);
  assert.equal((await dashboardData(db)).totals.images,1);
  await setImageTrashed(db,b,false);
  const restored=db.sql.prepare('SELECT * FROM images WHERE image_id=?').get(b);
  assert.equal(restored.deleted_at,null);assert.equal(restored.received_at,2000);
  assert.deepEqual(restored.jpeg,deleted.jpeg);
  assert.equal((await imageData(db,new URLSearchParams())).total,2);
  assert.equal((await imageData(db,new URLSearchParams('trashed=1'))).total,0);
  assert.equal(await setImageTrashed(db,'missing',true),null);
  await assert.rejects(imageData(db,new URLSearchParams('trashed=garbage')));
 }finally{db.sql.close();}
});

test('deleting final item leaves an empty gallery, and pagination sorts each view independently',async()=>{
 const db=database();
 try{
  seed(db,a,1000);seed(db,b,2000);
  assert.equal((await imageData(db,new URLSearchParams('offset=1&limit=1'))).rows[0].id,a);
  await setImageTrashed(db,a,true);await setImageTrashed(db,b,true);
  assert.equal((await imageData(db,new URLSearchParams())).total,0);
  assert.equal((await dashboardData(db)).totals.images,0);
  assert.equal((await imageData(db,new URLSearchParams('trashed=1'))).total,2);
 }finally{db.sql.close();}
});

test('retention keeps 100 active photos and 100 most recently trashed photos separately',()=>{
 const db=database();
 try{
  const insert=db.sql.prepare('INSERT INTO images(image_id,received_at,jpeg,deleted_at) VALUES(?,?,?,?)');
  for(let i=0;i<205;i++)insert.run('photo-'+i,i,new Uint8Array([255,216,255,217]),i<103?null:i);
  const source=readFileSync(new URL('../infra/cloudflare/src/worker.js',import.meta.url),'utf8');
  const statement=/const trimImages = `([\s\S]*?)`;/.exec(source)[1];
  db.sql.exec(statement);
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM images WHERE deleted_at IS NULL').get().n,100);
  assert.equal(db.sql.prepare('SELECT count(*) AS n FROM images WHERE deleted_at IS NOT NULL').get().n,100);
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM images WHERE image_id='photo-204'").get().n,1);
 }finally{db.sql.close();}
});
