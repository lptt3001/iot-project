import Knowledge from '../knowledge/plant-knowledge.cjs';
export {Knowledge};
export {evaluateConditions,evaluatePlantHealth,plantHealthStatus,climateMessage} from './observation-alerts.js';

export function pestHealthAlertInsert(db,job,result,message,now){
  const counts={};
  for(const d of result.detections){
    if(!Object.hasOwn(Knowledge.pestAlertSpecies,d.pest_code)||
      (d.pest_code==='unknown'?d.identification_status!=='unknown':d.identification_status!=='identified'))continue;
    counts[d.pest_code]=(counts[d.pest_code]||0)+1;
  }
  const names=JSON.stringify(Object.fromEntries(Object.values(Knowledge.crops).map(c=>[c.id,c.name])));
  const labels=JSON.stringify(Knowledge.pestAlertSpecies);
  // Evaluate against the stored rule inside the persistence transaction, so a concurrent
  // settings change, deletion or expired job lease cannot create an obsolete alert.
  return db.prepare(`WITH observed AS (
    SELECT c.crop_id,r.revision,d.key AS code,d.value AS count,
      CASE WHEN json_type(r.parameters,'$.species_thresholds')='object'
        THEN json_extract(r.parameters,'$.species_thresholds.'||d.key)
        WHEN d.key='unknown' THEN NULL
        WHEN d.key='Conogethes_punctiferalis' THEN json_extract(r.parameters,'$.min_identified')
        ELSE 1 END AS threshold
    FROM image_analysis a JOIN images i USING(image_id) JOIN image_crop_context c USING(image_id)
    JOIN observation_rules r ON r.crop_id=c.crop_id AND r.id='pest_image'
    CROSS JOIN json_each(?) d
    WHERE a.image_id=? AND a.lease_token=? AND a.status='running' AND i.deleted_at IS NULL
      AND r.enabled=1 AND i.received_at>=r.updated_at
  ), matched AS (SELECT * FROM observed WHERE threshold IS NOT NULL AND count>=threshold)
    INSERT INTO plant_health_alerts
    (id,event_key,kind,image_id,title,message,details,triggered_at,next_attempt_at)
    SELECT ?,?,'pest',?,'Côn trùng trong ảnh bẫy · '||json_extract(?,'$.'||m.crop_id),
      'Cây đang theo dõi: '||json_extract(?,'$.'||m.crop_id)||char(10)||
      'Loài đạt ngưỡng: '||group_concat(json_extract(?,'$.'||m.code)||' ('||m.count||'/'||m.threshold||' con)',', ')||char(10)||?,
      json_set(?,'$.crop_id',m.crop_id,'$.rule_revision',m.revision,'$.qualifying_count',sum(m.count),
        '$.matched_species',json_group_array(json_object('code',m.code,'count',m.count,'threshold',m.threshold))),?,?
    FROM matched m GROUP BY m.crop_id,m.revision
    ON CONFLICT(event_key) DO NOTHING`).bind(JSON.stringify(counts),job.image_id,job.lease_token,
      crypto.randomUUID(),'pest:'+job.image_id,job.image_id,names,names,labels,message,
      JSON.stringify({rule_id:'pest_image',advice:Knowledge.pestAdvice(result.detections),identified_count:result.identified_count,counts}),now,now);
}

export async function flushPlantHealthAlerts(db,settings,send=fetch){
  if(!settings)return;
  const now=Date.now(),lease=crypto.randomUUID();
  await db.prepare(`UPDATE plant_health_alerts SET failed_at=?,lease_token=NULL
    WHERE kind='climate' AND sent_at IS NULL AND failed_at IS NULL AND attempts>=5 AND next_attempt_at<=?`).bind(now,now).run();
  const row=await db.prepare(`UPDATE plant_health_alerts SET attempts=attempts+1,lease_token=?,next_attempt_at=?
    WHERE id=(SELECT id FROM plant_health_alerts WHERE kind='climate' AND chat_id=? AND sent_at IS NULL
      AND failed_at IS NULL AND attempts<5 AND next_attempt_at<=? ORDER BY triggered_at LIMIT 1)
    RETURNING id,title,message,attempts`).bind(lease,now+90000,settings.chatId,now).first();
  if(!row)return;
  let ok=false,permanent=false,delay=60000*2**(row.attempts-1);
  try{
    const response=await send(`https://api.telegram.org/bot${settings.token}/sendMessage`,{
      method:'POST',headers:{'Content-Type':'application/json'},redirect:'manual',signal:AbortSignal.timeout(20000),
      body:JSON.stringify({chat_id:settings.chatId,text:`🌿 PTIT Garden · ${row.title}\n${row.message}`.slice(0,4000),disable_web_page_preview:true})});
    const body=await response.json().catch(()=>null);ok=response.ok&&body?.ok===true;
    const code=Number(body?.error_code)||response.status;permanent=!ok&&code>=300&&code<500&&code!==408&&code!==429;
    if(code===429&&Number.isFinite(body?.parameters?.retry_after))delay=Math.max(delay,Math.min(body.parameters.retry_after,86400)*1000);
  }catch{/* Retry without marking an ambiguous transport outcome successful. */}
  const finished=Date.now();
  await db.prepare(`UPDATE plant_health_alerts SET sent_at=CASE WHEN ? THEN ? ELSE NULL END,
    failed_at=CASE WHEN ? OR (NOT ? AND attempts>=5) THEN ? ELSE NULL END,next_attempt_at=?,lease_token=NULL
    WHERE id=? AND lease_token=?`).bind(Number(ok),finished,Number(permanent),Number(ok),finished,finished+delay,row.id,lease).run();
}
