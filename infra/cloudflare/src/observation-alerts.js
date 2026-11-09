import Knowledge from '../knowledge/plant-knowledge.cjs';
const MAX_GAP=120000,VERSION=2;
export class ObservationRuleError extends Error{constructor(status,message){super(message);this.status=status;}}
export function defaultConfig(cropId='guava'){
  const crop=Knowledge.crops[cropId];
  return {active_crop:cropId,profile_revision:1,crop,crops:Object.values(Knowledge.crops),rules:Knowledge.rules.map(rule=>({...rule,crop_id:cropId,
    enabled:true,revision:1,effective_at:0,parameters:rule.id==='humid_environment'?{...crop.climate_defaults}:rule.id==='soil_wet'?
      {dry_raw:null,wet_raw:null,wet_index:85,hold_minutes:120,cooldown_minutes:360}:{species_thresholds:Knowledge.pestAlertThresholds()}}))};
}
export async function observationConfig(db){
  const profile=await db.prepare('SELECT crop_id,revision,activated_at FROM observation_profile WHERE id=1').first();
  const config=defaultConfig(profile.crop_id);config.profile_revision=profile.revision;
  const rows=await db.prepare('SELECT id,enabled,parameters,revision,updated_at FROM observation_rules WHERE crop_id=?').bind(profile.crop_id).all();
  config.rules=config.rules.map(r=>{const stored=rows.results.find(x=>x.id===r.id),parameters=JSON.parse(stored.parameters);return {...r,enabled:Boolean(stored.enabled),revision:stored.revision,effective_at:Math.max(profile.activated_at,stored.updated_at),parameters:r.id==='pest_image'?{species_thresholds:Knowledge.pestAlertThresholds(parameters)}:parameters};});
  return config;
}
function exactKeys(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));}
const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
export function calibrationValid(p){return integer(p.dry_raw,20,4075)&&integer(p.wet_raw,20,4075)&&Math.abs(p.dry_raw-p.wet_raw)>=200;}
export function wetIndex(raw,p){return calibrationValid(p)&&integer(raw,0,4095)?Math.max(0,Math.min(100,100*(raw-p.dry_raw)/(p.wet_raw-p.dry_raw))):null;}
export function validateRuleParameters(id,p){
  let valid=false;
  if(id==='soil_wet'&&exactKeys(p,['dry_raw','wet_raw','wet_index','hold_minutes','cooldown_minutes'])){
    valid=(p.dry_raw===null&&p.wet_raw===null||calibrationValid(p))&&integer(p.wet_index,50,100)&&integer(p.hold_minutes,15,720)&&integer(p.cooldown_minutes,15,1440);
  }else if(id==='humid_environment'&&exactKeys(p,['temperature_min','temperature_max','humidity_min','hold_minutes','cooldown_minutes'])){
    valid=[p.temperature_min,p.temperature_max].every(x=>Number.isFinite(x)&&x>=5&&x<=40)&&p.temperature_max-p.temperature_min>=1&&
      integer(p.humidity_min,70,90)&&integer(p.hold_minutes,15,720)&&integer(p.cooldown_minutes,15,1440);
  }else if(id==='pest_image'){
    if(exactKeys(p,['min_identified']))valid=integer(p.min_identified,1,300);
    else if(exactKeys(p,['species_thresholds'])&&exactKeys(p.species_thresholds,Object.keys(Knowledge.pestAlertSpecies))){
      const thresholds=Object.values(p.species_thresholds);
      valid=thresholds.every(n=>n===null||integer(n,1,300))&&thresholds.some(n=>n!==null);
    }
    if(!valid)throw new ObservationRuleError(422,'Chọn ít nhất một loài và đặt ngưỡng từ 1 đến 300 con/ảnh.');
    return {species_thresholds:Knowledge.pestAlertThresholds(p)};
  }
  if(!valid)throw new ObservationRuleError(422,id==='soil_wet'?'Cần hai mốc ADC hợp lệ (20–4075, chênh ít nhất 200) hoặc để trống cả hai; kiểm tra thời gian và ngưỡng.':'Thiết lập cảnh báo không hợp lệ.');
  return p;
}
export async function updateObservationRule(db,id,body){
  if(!Knowledge.rules.some(r=>r.id===id))throw new ObservationRuleError(404,'Không có loại cảnh báo này.');
  if(!exactKeys(body,['crop_id','revision','enabled','parameters'])||!Object.hasOwn(Knowledge.crops,body.crop_id)||!integer(body.revision,1,1e9)||typeof body.enabled!=='boolean')throw new ObservationRuleError(422,'Dữ liệu thiết lập không hợp lệ.');
  const parameters=validateRuleParameters(id,body.parameters);
  const now=Date.now();
  const [saved]=await db.batch([
    db.prepare('UPDATE observation_rules SET enabled=?,parameters=?,revision=revision+1,updated_at=? WHERE crop_id=? AND id=? AND revision=? RETURNING revision')
      .bind(Number(body.enabled),JSON.stringify(parameters),now,body.crop_id,id,body.revision),
    db.prepare(`UPDATE telegram_deliveries SET failed_at=?,lease_token=NULL WHERE sent_at IS NULL AND failed_at IS NULL AND changes()>0 AND event_key IN
      (SELECT 'health:'||id FROM plant_health_alerts WHERE json_extract(details,'$.crop_id')=? AND json_extract(details,'$.rule_id')=?)`).bind(now,body.crop_id,id),
    db.prepare('DELETE FROM plant_health_status WHERE changes()>0 OR id=1'),
  ]);
  if(!saved.results.length)throw new ObservationRuleError(409,'Thiết lập đã được thay đổi ở phiên khác. Tải lại trước khi lưu.');
  return observationConfig(db);
}
export async function setObservationCrop(db,body){
  if(!exactKeys(body,['crop_id','revision'])||!Object.hasOwn(Knowledge.crops,body.crop_id)||!integer(body.revision,1,1e9))throw new ObservationRuleError(422,'Hồ sơ cây không hợp lệ.');
  const now=Date.now();
  const [saved]=await db.batch([
    db.prepare('UPDATE observation_profile SET crop_id=?,revision=revision+1,activated_at=? WHERE id=1 AND revision=? RETURNING revision').bind(body.crop_id,now,body.revision),
    db.prepare(`UPDATE telegram_deliveries SET failed_at=?,lease_token=NULL WHERE sent_at IS NULL AND failed_at IS NULL AND changes()>0
      AND event_key IN(SELECT 'health:'||id FROM plant_health_alerts WHERE json_extract(details,'$.crop_id') IS NOT NULL)`).bind(now),
    db.prepare('DELETE FROM plant_health_status WHERE id=1'),
  ]);
  if(!saved.results.length)throw new ObservationRuleError(409,'Hồ sơ cây đã đổi ở phiên khác. Hãy tải lại.');return observationConfig(db);
}
function measurementValid(rule,m){
  if(rule.id==='soil_wet')return integer(m?.soil_raw,6,4089);
  return Number.isFinite(m?.temperature_c)&&m.temperature_c>=0&&m.temperature_c<=50&&Number.isFinite(m.air_humidity_pct)&&m.air_humidity_pct>=20&&m.air_humidity_pct<=90;
}
function matches(rule,m){const p=rule.parameters;if(!measurementValid(rule,m))return false;
  return rule.id==='soil_wet'?wetIndex(m.soil_raw,p)>=p.wet_index:m.temperature_c>=p.temperature_min&&m.temperature_c<=p.temperature_max&&m.air_humidity_pct>=p.humidity_min;}
export function evaluateConditions(samples,now=Date.now(),config=defaultConfig()){
  const rows=samples.filter(r=>Number.isSafeInteger(r.observed_at)&&r.observed_at<=now).sort((a,b)=>b.observed_at-a.observed_at);
  const latest=rows[0],timely=Boolean(latest&&now-latest.observed_at<=MAX_GAP);
  const rules=config.rules.filter(r=>r.id!=='pest_image').map(rule=>{
    const p=rule.parameters,calibrated=rule.id!=='soil_wet'||calibrationValid(p),fresh=timely&&latest.observed_at>=rule.effective_at&&measurementValid(rule,latest.measurements);
    let minutes=0,oldest=latest?.observed_at,previous=oldest;
    if(rule.enabled&&calibrated&&fresh&&matches(rule,latest.measurements)){
      for(const row of rows){if(row.observed_at<rule.effective_at||previous-row.observed_at>MAX_GAP||!matches(rule,row.measurements))break;oldest=row.observed_at;previous=oldest;}
      minutes=Math.floor((latest.observed_at-oldest)/60000);
    }
    const matching=Boolean(calibrated&&fresh&&matches(rule,latest.measurements));
    const stage=!rule.enabled?'disabled':!calibrated?'needs_calibration':!fresh?'no_data':!matching?'not_matching':minutes<p.hold_minutes?'tracking':'warning';
    return {...rule,stage,fresh,matching,observed_minutes:minutes,wet_index:rule.id==='soil_wet'?wetIndex(latest?.measurements?.soil_raw,p):null,
      label:{disabled:'Đã tắt',needs_calibration:'Chờ hiệu chuẩn đất',no_data:'Thiếu số đo hợp lệ/mới',not_matching:'Chưa khớp điều kiện theo dõi',tracking:'Đang theo dõi thời gian',warning:'Cần kiểm tra tại cây'}[stage],
      threshold:rule.id==='soil_wet'?`Chỉ số ướt tương đối ≥${p.wet_index}% trong ${p.hold_minutes} phút (sau hiệu chuẩn).`:
        `${p.temperature_min}–${p.temperature_max}°C và RH ≥${p.humidity_min}% trong ${p.hold_minutes} phút.`,
      target:rule.id==='soil_wet'?'Tình trạng rễ và thoát nước':config.crop.humid_target};
  });
  return {schema_version:VERSION,profile:config.crop.name,crop_id:config.active_crop,profile_revision:config.profile_revision,
    rule_revisions:config.rules.map(r=>r.revision).join(','),crop:config.crop,evaluated_at:now,observed_at:latest?.observed_at??null,
    measurements:latest?.measurements??null,fresh:timely,rules};
}
export function climateMessage(rule,report){
  const m=report.measurements,p=rule.parameters;
  const observation=rule.id==='soil_wet'?`Đầu dò đất: ADC ${m.soil_raw}, chỉ số ướt tương đối ${rule.wet_index.toFixed(1)}%. Cảm biến mưa: ${m.rain_do===0?'báo ướt':m.rain_do===1?'khô':'chưa có dữ liệu'}.`:
    `DHT11: nhiệt độ ${m.temperature_c.toFixed(1)}°C, RH ${m.air_humidity_pct.toFixed(1)}%.`;
  const interpretation=rule.id==='soil_wet'?'Đất ướt kéo dài có thể gây thiếu oxy vùng rễ và thuận lợi cho một số tác nhân gây thối rễ; chưa chứng minh rễ đã bệnh.':
    `Điều kiện cần chú ý khi kiểm tra ${report.crop.humid_target}. ${report.crop.climate_reference}`;
  return `Cây đang theo dõi: ${report.crop.name}\n${observation}\nĐiều kiện cài đặt: ${rule.threshold}\nĐã quan sát ${rule.observed_minutes} phút, khoảng trống mẫu không quá 2 phút.\n`+
    `${interpretation}\nNên làm: ${rule.id==='soil_wet'?rule.action:report.crop.humid_action}\n`+
    'Đây là ngưỡng giám sát vận hành, chưa phải ngưỡng xác nhận nhiễm bệnh. Độ ẩm đất là chỉ số tương đối đã hiệu chuẩn; cảm biến mưa không đo độ ướt lá/quả.\n'+
    `Nguồn: ${(rule.id==='soil_wet'?rule.sources:report.crop.disease_sources)[0].url}`;
}
export async function evaluatePlantHealth(db,settings,now=Date.now()){
  const config=await observationConfig(db);
  const rows=await db.prepare(`SELECT observed_at,measurements FROM telemetry WHERE observed_at BETWEEN ? AND ?
    AND observed_at BETWEEN received_at-120000 AND received_at ORDER BY observed_at DESC LIMIT 6000`).bind(now-13*3600000,now).all();
  const report=evaluateConditions(rows.results.map(r=>({...r,measurements:JSON.parse(r.measurements)})),now,config);
  const statements=[db.prepare(`INSERT INTO plant_health_status VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET evaluated_at=excluded.evaluated_at,report=excluded.report
    WHERE plant_health_status.evaluated_at<=excluded.evaluated_at`).bind(now,JSON.stringify(report))];
  for(const rule of report.rules){if(rule.stage!=='warning')continue;
    const event=`observe:${config.active_crop}:${rule.id}:r${rule.revision}:${Math.floor(now/(rule.parameters.cooldown_minutes*60000))}`;
    statements.push(db.prepare(`INSERT INTO plant_health_alerts(id,event_key,kind,disease_id,stage,title,message,details,triggered_at,next_attempt_at)
      SELECT ?,?,'climate',?,'warning',?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM plant_health_alerts
        WHERE disease_id=? AND json_extract(details,'$.crop_id')=? AND triggered_at>?)
      AND EXISTS(SELECT 1 FROM observation_rules r JOIN observation_profile p ON p.crop_id=r.crop_id
        WHERE r.id=? AND r.crop_id=? AND r.revision=? AND r.enabled=1 AND p.revision=?)
      ON CONFLICT(event_key) DO NOTHING`).bind(crypto.randomUUID(),event,rule.id,`${rule.name} · ${config.crop.name}`,climateMessage(rule,report),
        JSON.stringify({crop_id:config.active_crop,rule_id:rule.id,rule,observed_at:report.observed_at,measurements:report.measurements}),now,now,
        rule.id,config.active_crop,now-rule.parameters.cooldown_minutes*60000,rule.id,config.active_crop,rule.revision,config.profile_revision));
  }
  await db.batch(statements);return report;
}
export async function plantHealthStatus(db,now=Date.now()){
  const config=await observationConfig(db),row=await db.prepare('SELECT evaluated_at,report FROM plant_health_status WHERE id=1').first();
  let report=row?JSON.parse(row.report):null;
  if(!report||report.schema_version!==VERSION||report.crop_id!==config.active_crop||report.profile_revision!==config.profile_revision||
    report.rule_revisions!==config.rules.map(r=>r.revision).join(','))report=evaluateConditions([],now,config);
  if(!report.observed_at||now-report.observed_at>MAX_GAP){report.fresh=false;report.rules=report.rules.map(r=>r.stage==='disabled'||r.stage==='needs_calibration'?r:{...r,stage:'no_data',fresh:false,matching:false,label:'Thiếu số đo hợp lệ/mới'});}
  return {...report,sensor_note:'Một trạm và một đầu dò đất chỉ đại diện vị trí đang đặt. Hiệu chuẩn lại theo đất/vị trí. DHT11 có sai số; ngưỡng nóng ẩm là nhắc kiểm tra, không khẳng định bệnh. Mưa/ánh sáng chỉ bổ sung bối cảnh và điều khiển bẫy.'};
}
