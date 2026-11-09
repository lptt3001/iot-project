'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg aria-hidden="true"><use href="#${name}"/></svg>`;
const cloudMode = document.documentElement.dataset.mode === 'cloud';
const soilMetric = cloudMode ? 'soil_raw' : 'soil_moisture_pct';
const soilLabel = cloudMode ? 'Đất (ADC)' : 'Độ ẩm đất';
const soilUnit = cloudMode ? 'ADC' : '%';
const number = (value, digits=1) => value == null ? '—' : Number(value).toLocaleString('vi-VN',{maximumFractionDigits:digits,minimumFractionDigits:digits});
const date = value => value ? new Date(value).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',hour12:false}) : 'Chưa có dữ liệu';
const shortTime = value => new Date(value).toLocaleTimeString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit',minute:'2-digit',hour12:false});
const shortDate = value => new Date(value).toLocaleDateString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',day:'2-digit',month:'2-digit'});
const names = {overview:'Tổng quan',devices:'Trạm & cảm biến',images:'Camera & nhận diện',alerts:'Cảnh báo',simulation:'Phòng mô phỏng',settings:'Telegram & thiết lập',accounts:'Duyệt tài khoản'};
const species = {'sau-to':'Sâu tơ','ray-nau':'Rầy nâu','bo-tri':'Bọ trĩ'};
const aiSpecies = {Cnaphalocrocis_medinalis:'Ngài sâu cuốn lá nhỏ',Plutella_xylostella:'Ngài sâu tơ',Ostrinia_furnacalis:'Ngài sâu đục thân ngô',Scotinophara_coarctata:'Bọ xít đen',Conogethes_punctiferalis:'Ngài đục quả',Diaphania_indica:'Ngài sâu xanh dưa',unknown:'Côn trùng'};
const aiInfo = {
 Cnaphalocrocis_medinalis:['Lúa','Kiểm tra lá bị cuốn và vết ăn trên lá.','https://databases.nbair.res.in/insectpests/Cnaphalocrocis-medinalis.php'],
 Plutella_xylostella:['Cây họ cải','Kiểm tra sâu non và lỗ ăn trên lá.','https://ipm.ucanr.edu/home-and-landscape/diamondback-moth/'],
 Ostrinia_furnacalis:['Ngô','Kiểm tra lá, thân và bắp để xác nhận sâu non.','https://gd.eppo.int/taxon/PYRUFU'],
 Scotinophara_coarctata:['Lúa','Kiểm tra gốc cây và dấu vết chích hút.','https://books.irri.org/9789712203008_content.pdf'],
 Conogethes_punctiferalis:['Nhiều cây trồng, gồm cây ăn quả','Kiểm tra quả và chồi; cần xác nhận loài tại vườn.','https://planthealthportal.defra.gov.uk/data/pests/20194/data'],
 Diaphania_indica:['Cây họ bầu bí','Kiểm tra lá, hoa và quả để xác nhận sâu non.','https://databases.nbair.res.in/insectpests/Diaphania-indica.php']
};
const metricNames = {temperature_c:'Nhiệt độ',air_humidity_pct:'Độ ẩm không khí',soil_moisture_pct:'Độ ẩm đất',soil_raw:'Đất (ADC)',pest_count:'Số đối tượng / ảnh'};
const state = {page:'overview',data:null,account:null,history:[],historyBucketMinutes:1,historyLoadedAt:0,metric:'temperature_c',hours:1,images:[],imageOffset:0,imageTotal:0,alertOffset:0,alertTotal:0,alertState:'all',rules:[],lastImages:-1,lastAlerts:'',imageKey:null,socket:null,refreshing:false};
const canManageDashboard = () => !cloudMode || state.account?.role === 'admin';
let toastTimer, reconnectTimer, registrationVersion=0;

function toast(message, error=false){ const el=$('#toast');el.textContent=message;el.classList.toggle('error',error);el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.hidden=true,5000); }
function showError(message){$('#error-banner').textContent=message;$('#error-banner').hidden=false;}
async function api(path,options={}){
 const headers={'X-Garden-Request':'1',...(options.headers||{})};
 if(options.body && !(options.body instanceof FormData) && !(options.body instanceof Blob)){headers['Content-Type']='application/json';options.body=JSON.stringify(options.body);}
 const cloudRead=cloudMode&&(!options.method||options.method==='GET');
 const signal=options.signal??(cloudRead?AbortSignal.timeout(12000):undefined);
 const response=await fetch(path,{...options,headers,signal});
 if(cloudMode&&response.status===401){
  window.location.replace('/login');
  throw new Error('Phiên đăng nhập đã hết hạn.');
 }
 if(!response.ok){
  let data;
  try{data=await response.json();}catch{data={};}
  const detail=typeof data?.detail==='string'?data.detail:response.status===422?'Giá trị nhập không hợp lệ. Kiểm tra lại các trường.':`Yêu cầu thất bại (${response.status}).`;
  const error=new Error(detail);
  error.status=response.status;
  throw error;
 }
 return response.json();
}
async function action(button, task){if(button)button.disabled=true;try{await task();}catch(error){toast(error.message,true);}finally{if(button)button.disabled=false;}}
function status(online){return `<span class="status ${online?'':'muted'}"><i></i>${online?(cloudMode?'Trực tuyến':'Đang kết nối'):'Ngoại tuyến'}</span>`;}
function average(metric){const active=state.data.devices.filter(d=>d.online&&d[metric]!=null);return active.length?active.reduce((s,d)=>s+d[metric],0)/active.length:null;}

function configureCloudUi(){
 delete names.simulation;
 configureCloudAccount(null);
 const logoutButton=$('#logout-button');
 logoutButton.hidden=false;
 logoutButton.addEventListener('click',()=>action(logoutButton,async()=>{
  await api('/api/logout',{method:'POST'});
  window.location.replace('/login');
 }));
 $('#page-overview .subtitle').textContent='Theo dõi cảm biến, ảnh và cảnh báo từ trạm ESP32-CAM.';
 $$('.export').forEach(button=>button.title='Tải dữ liệu CSV');
 $('#hero-description').textContent='Số đo và ảnh từ trạm ESP32-CAM sẽ xuất hiện tại đây.';
 $('.hero-link').href='#devices';
 $('.hero-link').firstChild.textContent='Xem trạm & cảm biến ';
 $('.sidebar .profile small').textContent='Quản lý khu vườn';
 $('.chart-card .card-heading p').textContent='Lịch sử đo · UTC+7';
 const soilTab=$('[data-metric="soil_moisture_pct"]');
 soilTab.dataset.metric=soilMetric;
 soilTab.textContent=soilLabel;
 $('.legend').innerHTML='<span><i></i>Trạm 01</span>';
 $('#station-heading').textContent='Trạm đang theo dõi';
 $('#station-description').textContent='Kết nối và tín hiệu tại lần gửi gần nhất';
 $('#station-count').textContent='1 trạm';
 $('#overview-camera-description').textContent='Ảnh bẫy mới nhất từ ESP32-CAM';
 $('.history-card .card-heading p').textContent='60 khoảng gần nhất trong thời gian đã chọn';
 $('#history-soil-heading').textContent=soilLabel;
 $('#history-sample-heading').textContent='Mẫu / khoảng';
 $('#page-images .subtitle').textContent='Xem ảnh thật từ trạm theo thời gian nhận.';
 $('#camera-note').hidden=true;
 $('#ai-demo').hidden=false;
 $('#led-panel').hidden=false;
 try{pendingCloudCaptureId=sessionStorage.getItem(CAPTURE_SESSION_KEY);}catch{}
 updateCaptureButton();
 $('#capture-button').title='Chụp theo yêu cầu khi trời sáng hoặc tối. Camera vẫn kiểm tra cảm biến mưa.';
 $('#page-alerts .subtitle').textContent='Theo dõi nguy cơ và xử lý cảnh báo trong vườn.';
 const healthSummary=document.createElement('div');healthSummary.id='plant-health-summary';healthSummary.className='info-box';$('#metrics').after(healthSummary);
 const healthPanel=document.createElement('article');healthPanel.id='plant-health-panel';healthPanel.className='card plant-health-panel';$('#page-alerts .filter-row').before(healthPanel);
 $('#page-settings .subtitle').textContent='Quản lý cây trồng, ngưỡng cảnh báo và người nhận Telegram.';
 $('#page-settings h1').textContent='Thiết lập cảnh báo';
 $('#page-alerts [href="#settings"]').textContent='Thiết lập cảnh báo';
 $('#page-settings > .info-box').hidden=true;
 $('#notifications-dialog > p').textContent='Cảnh báo và cập nhật mới nhất';
 $('#telegram-pairing-panel').hidden=false;
}

function configureCloudAccount(account){
 state.account=account;
 const canManage=canManageDashboard();
 $('[data-page="accounts"]').hidden=!canManage;
 $$('[data-dashboard-admin]').forEach(element=>element.hidden=!canManage);
 if(cloudMode)$('#rule-forms').hidden=!canManage;
 if(!account)return;
 $('#profile-role').textContent=canManage?'Quản trị viên':'Quyền chỉ xem';
 $$('.avatar').forEach(avatar=>{
  avatar.textContent=account.username.slice(0,2).toUpperCase();
  avatar.title=account.username;
 });
}

function renderSnapshot(data){
 state.data=data;
 $('#error-banner').hidden=true;
 const online=data.devices.filter(d=>d.online).length;
 const hardware=cloudMode||(data.simulation.external_devices||[]).length>0;
 $('.demo-note').innerHTML=cloudMode?'<span class="dot"></span> Giám sát khu vườn':hardware?'<span class="dot"></span> Kết nối phần cứng<p>Dữ liệu thật từ ESP32-CAM qua USB. Đất hiển thị số thô khi chưa hiệu chuẩn.</p>':'<span class="dot"></span> Môi trường mô phỏng<p>Dữ liệu do các trạm ảo tạo ra.</p>';
 $('#data-source').textContent=cloudMode?'Giám sát trực tiếp':hardware?'Cảm biến thật · lịch sử đang lọc phần cứng':'Dữ liệu mô phỏng';
 $('#page-devices .subtitle').textContent=hardware?'Theo dõi kết nối và số đo của từng trạm.':'Dữ liệu do bộ mô phỏng tạo, truyền qua MQTT thật.';
 const measured=metric=>cloudMode?data.devices[0]?.[metric]:average(metric);
 const metricNote=cloudMode?'Mẫu gần nhất từ trạm':'Chỉ tính các trạm đang trực tuyến';
 const alertSuffix=data.totals.open_alerts_truncated?'+':'';
 const alertNote=canManageDashboard()?'Xác nhận sau khi bạn đã kiểm tra':'Đang chờ quản trị viên xác nhận';
 $('#metrics').innerHTML=[[cloudMode?'Nhiệt độ':'Nhiệt độ trung bình',measured('temperature_c'),'°C','temp',metricNote],['Độ ẩm không khí',measured('air_humidity_pct'),'%','drop',metricNote],[soilLabel,measured(soilMetric),soilUnit,'leaf',cloudMode?'Số đo thô · thang 0–4095':metricNote],['Cảnh báo chưa xử lý',data.totals.open_alerts,alertSuffix,'bell',alertNote]].map(([label,value,unit,symbol,note])=>`<article class="metric"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon(symbol)}</span></div><div class="metric-value">${number(value,unit==='°C'||unit==='%'?1:0)}<small>${unit}</small></div><div class="metric-note">${note}</div></article>`).join('');
 const scenario={normal:'Điều kiện đang ở mức bình thường.', 'hot-dry':'Đang mô phỏng nắng nóng và đất khô.', humid:'Đang mô phỏng độ ẩm không khí cao.',pests:'Đang mô phỏng mật độ sâu tăng cao.'}[data.simulation.scenario];
 $('#hero-title').textContent=hardware?(online?'Đang nhận dữ liệu cảm biến thật.':'Đang chờ ESP32-CAM gửi số đo.'):!data.simulation.running?'Khu vườn đang tạm nghỉ.':online?scenario:'Đang chờ các trạm kết nối.';
 const readings=`${Number(data.totals.readings).toLocaleString('vi-VN')}${data.totals.readings_capped?'+':''}`;
 $('#hero-description').textContent=`${online}/${data.devices.length} trạm trực tuyến · ${readings} mẫu đã lưu · ${data.totals.images} ảnh trong thư viện.`;
 $('#nav-alerts').textContent=`${data.totals.open_alerts}${alertSuffix}`;
 $('#unread-dot').hidden=!data.totals.unread;
 $('#overview-alerts').innerHTML=data.alerts.length?data.alerts.map(a=>alertMarkup(a,true)).join(''):'<div class="empty">Chưa có cảnh báo. Khu vườn đang được theo dõi.</div>';
 $('#system-strip').innerHTML=cloudMode?'<span><span class="dot"></span>Hệ thống đang hoạt động</span><span>Tự động cập nhật</span>':`<span><span class="dot"></span>MQTT TLS ${data.system.mqtt?'đã kết nối':'đang kết nối lại'}</span><span><span class="dot"></span>TimescaleDB đang hoạt động</span><span>${data.system.buffered} bản tin chờ xử lý</span><span>Chu kỳ ${data.simulation.interval_seconds} giây</span>`;
 if(!cloudMode)$('#capture-button').lastChild.textContent=hardware?'Chụp thử camera thật':'Chụp mô phỏng';
 $('#last-update').textContent=`Cập nhật ${shortTime(data.server_time*1000)}`;
 if(cloudMode)renderCloudStation();else renderMap();
 if(state.page==='devices')renderDevices();
 const alertVersion=JSON.stringify(data.alerts.map(a=>[a.id,a.acknowledged_at]));
 if(state.page==='alerts'&&state.lastAlerts!==alertVersion){state.lastAlerts=alertVersion;loadAlerts().catch(e=>toast(e.message,true));}
 if(!cloudMode&&data.totals.images!==state.lastImages){state.lastImages=data.totals.images;loadImages().catch(e=>toast(e.message,true));}
}

function lightLabel(value){return value==null?'—':value===1?'Tối':'Sáng';}
function rainLabel(value){return value==null?'—':value===0?'Có mưa / ướt':'Khô';}
function renderCloudStation(){
 const station=state.data.devices[0];
 $('#garden-map').hidden=true;
 $('#map-devices').innerHTML=station?`<div class="cloud-station"><div class="device-head"><span class="device-icon">${icon('signal')}</span><div><strong>${esc(station.name)}</strong><small>${esc(station.id)}</small></div>${status(station.online)}</div><dl class="station-details"><div><dt>Nhận số đo lần cuối</dt><dd>${date(station.last_seen_at||station.observed_at)}</dd></div><div><dt>Wi-Fi</dt><dd>${number(station.rssi_dbm,0)} dBm</dd></div><div><dt>Ánh sáng</dt><dd>${lightLabel(station.light_do)}</dd></div><div><dt>Mưa</dt><dd>${rainLabel(station.rain_do)}</dd></div></dl></div>`:'<div class="empty">Đang chờ trạm ESP32-CAM.</div>';
}

function renderMap(){
 const ds=state.data.devices;
 const minLat=Math.min(...ds.map(d=>d.latitude)), maxLat=Math.max(...ds.map(d=>d.latitude));
 const minLon=Math.min(...ds.map(d=>d.longitude)), maxLon=Math.max(...ds.map(d=>d.longitude));
 const pins=ds.map((d,i)=>{const x=95+(d.longitude-minLon)/Math.max(.0006,maxLon-minLon)*170;const y=140-(d.latitude-minLat)/Math.max(.0006,maxLat-minLat)*85;return `<g><circle cx="${x}" cy="${y}" r="24" fill="${d.online?'#75995c':'#a7a894'}" opacity=".13"/><circle cx="${x}" cy="${y}" r="13" fill="${d.online?'#638650':'#a7a894'}" stroke="white" stroke-width="3"/><text x="${x}" y="${y+3}" font-size="8" fill="white" stroke="none" text-anchor="middle">0${i+1}</text><rect x="${x-32}" y="${y+21}" width="64" height="18" rx="4" fill="white" stroke="none"/><text x="${x}" y="${y+33}" font-size="8" fill="#76876b" stroke="none" text-anchor="middle">Trạm 0${i+1}</text></g>`;}).join('');
 $('#garden-map').innerHTML=`<svg viewBox="0 0 360 210" role="img" aria-label="Sơ đồ vị trí hai trạm trong vườn"><defs><pattern id="beds" patternUnits="userSpaceOnUse" width="19" height="19" patternTransform="rotate(-25)"><rect width="19" height="19" fill="#e7eddb"/><path d="M0 0v19" stroke="#d7e0c8" stroke-width="8"/></pattern></defs><rect width="360" height="210" fill="#edf0e3"/><path d="M-10 185 200-20M180 240 390 40" stroke="#fffdf3" stroke-width="21"/><path d="M10-10 375 208" stroke="#d5e2e3" stroke-width="14"/><path d="m43 82 80-78 184 115-85 81Z" fill="url(#beds)" stroke="#c8d5b7" stroke-dasharray="4 4"/><text x="20" y="30" font-size="9" fill="#99a68c" stroke="none">N ↑</text><text x="252" y="190" font-size="7" fill="#a5ae98" stroke="none">SƠ ĐỒ MÔ PHỎNG</text>${pins}</svg>`;
 $('#map-devices').innerHTML=ds.map(d=>`<div>${esc(d.name)} ${d.online?'●':'○'}<small>${number(d.latitude,4)}, ${number(d.longitude,4)}</small></div>`).join('');
}

async function loadHistory(){
 const device=state.page==='devices'?$('#history-device').value:'';
 const result=await api(`/api/history?hours=${state.hours}${device?'&device='+encodeURIComponent(device):''}`);
 state.history=result.rows;
 state.historyBucketMinutes=result.bucket_minutes;
 state.historyLoadedAt=Date.now();
 renderChart();
 const samples=result.rows.reduce((sum,row)=>sum+Number(row.samples),0).toLocaleString('vi-VN');
 $('#chart-summary').textContent=cloudMode?`${samples} mẫu hiển thị · một mẫu mỗi ${result.bucket_minutes} phút`:`${samples} mẫu · trung bình ${result.bucket_minutes} phút`;
 $('#history-body').innerHTML=result.rows.slice(-60).reverse().map(r=>`<tr><td>${date(r.time)}</td><td>${esc(r.device_id)}</td><td>${number(r.temperature_c)} °C</td><td>${number(r.air_humidity_pct)} %</td><td>${number(r[soilMetric],cloudMode?0:1)} ${soilUnit}</td><td>${r.samples}</td></tr>`).join('')||'<tr><td colspan="6">Chưa có dữ liệu trong khoảng này.</td></tr>';
}
function renderChart(){
 const rows=state.history.filter(r=>r[state.metric]!=null), w=600,h=210,left=40,right=14,top=14,bottom=28;
 if(!rows.length){$('#chart').innerHTML='<div class="empty">Đang chờ mẫu cảm biến đầu tiên…</div>';return;}
 const values=rows.map(r=>r[state.metric]);let low=Math.floor(Math.min(...values)/5)*5-2,high=Math.ceil(Math.max(...values)/5)*5+2;if(high-low<10){low-=4;high+=4;}
 const start=Math.min(...rows.map(r=>new Date(r.time).getTime())), end=Math.max(...rows.map(r=>new Date(r.time).getTime()),start+60000);
 const x=t=>left+(new Date(t).getTime()-start)/(end-start)*(w-left-right), y=v=>top+(high-v)/(high-low)*(h-top-bottom);
 let content='';
 for(let i=0;i<5;i++){const value=low+(high-low)*i/4;content+=`<line x1="${left}" x2="${w-right}" y1="${y(value)}" y2="${y(value)}" stroke="#edf0e7" stroke-dasharray="3 5"/><text x="${left-9}" y="${y(value)+3}" text-anchor="end" fill="#a2ac97" font-size="9" stroke="none">${number(value,0)}</text>`;}
 const tickLabel=cloudMode&&end-start>=24*60*60*1000?shortDate:shortTime;
 for(let i=0;i<5;i++){const t=start+(end-start)*i/4;content+=`<text x="${left+(w-left-right)*i/4}" y="${h-7}" text-anchor="middle" fill="#a2ac97" font-size="9" stroke="none">${tickLabel(t)}</text>`;}
 const stations=cloudMode?state.data.devices.map(d=>d.id):['station-001','station-002'];
 const unit=state.metric==='temperature_c'?'°C':state.metric==='soil_raw'?' ADC':'%';
 const interval=cloudMode?state.historyBucketMinutes*60000:state.hours>6?900000:60000;
 for(const [index,device] of stations.entries()){
  const points=rows.filter(r=>r.device_id===device), color=index?'#c4a375':'#71915e';
  // Break paths at missing time buckets instead of inventing a continuous signal across outages.
  let path='',last=null;for(const r of points){const t=new Date(r.time).getTime();path+=`${last===null||t-last>interval*2?'M':'L'}${x(r.time).toFixed(1)},${y(r[state.metric]).toFixed(1)} `;last=t;}
  content+=`<path d="${path}" stroke="${color}" stroke-width="2" fill="none"/>`;
  for(const r of points){content+=`<circle cx="${x(r.time)}" cy="${y(r[state.metric])}" r="2.7" fill="${color}" stroke="white" stroke-width="1"><title>${esc(device)} · ${date(r.time)} · ${number(r[state.metric],state.metric==='soil_raw'?0:1)}${unit}</title></circle>`;}
 }
 $('#chart').innerHTML=`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Biểu đồ ${metricNames[state.metric]}">${content}</svg>`;
}
function renderDevices(){
 if(cloudMode){
  $('#device-cards').innerHTML=state.data.devices.map(station=>`<article class="card device-card">
   <div class="device-head"><span class="device-icon">${icon('signal')}</span><div><h2>${esc(station.name)}</h2><small>${esc(station.id)} · ESP32-CAM</small></div>${status(station.online)}</div>
   <div class="device-stats"><div><strong>${number(station.temperature_c)} °C</strong><span>Nhiệt độ</span></div><div><strong>${number(station.air_humidity_pct)}%</strong><span>Độ ẩm không khí</span></div><div><strong>${number(station.soil_raw,0)}</strong><span>Đất (ADC)</span></div></div>
   <div class="device-meta"><span>Nhận số đo lần cuối · ${date(station.last_seen_at||station.observed_at)}</span><span>Ánh sáng · ${lightLabel(station.light_do)}</span><span>Mưa · ${rainLabel(station.rain_do)}</span><span>Wi-Fi · ${number(station.rssi_dbm,0)} dBm</span></div>
  </article>`).join('');
  return;
 }
 $('#device-cards').innerHTML=state.data.devices.map(d=>`<article class="card device-card"><div class="device-head"><span class="device-icon">${icon('signal')}</span><div><h2>${esc(d.name)}</h2><small>${esc(d.id)} · ${(state.data.simulation.external_devices||[]).includes(d.id)?'ESP32-CAM · phần cứng':'ESP32 mô phỏng'}</small></div>${status(d.online)}</div><div class="device-stats"><div><strong>${number(d.temperature_c)}°</strong><span>Nhiệt độ</span></div><div><strong>${number(d.air_humidity_pct)}%</strong><span>Độ ẩm không khí</span></div><div><strong>${number(d.soil_moisture_pct)}%</strong><span>Độ ẩm đất</span></div></div><div class="device-meta"><span>Nguồn mẫu: ${d.source==='hardware'?'Phần cứng':d.source==='simulation'?'Mô phỏng':'Lịch sử / MQTT'}</span>${d.soil_raw!=null?`<span>Đất ADC: ${d.soil_raw} / 4095 · chưa hiệu chuẩn${d.soil_raw>=4090?' · gần bão hòa':''}</span><span>Ánh sáng: ${d.light_do==null?'—':d.light_do===1?'Tối':'Sáng'} (DO ${d.light_do??'—'})</span><span>Mưa: ${d.rain_do==null?'—':d.rain_do===0?'Có mưa / ướt':'Khô'} (DO ${d.rain_do??'—'})</span>`:''}<span>Pin ${number(d.battery_v,2)} V</span><span>Wi-Fi ${d.rssi_dbm??'—'} dBm</span><span>${d.enabled?'Cho phép nhận dữ liệu':'Đã tắt trong registry'}</span><span>Mẫu gần nhất: ${date(d.observed_at)}</span>${d.online?'':'<span>Dữ liệu trên là mẫu cuối, không phải trạng thái hiện tại.</span>'}</div><button class="button secondary edit-device" data-id="${esc(d.id)}">Chỉnh sửa trạm</button></article>`).join('');
}
function alertSummary(message){
 const lines=String(message??'').split('\n').map(line=>line.trim()).filter(Boolean);
 const operational=lines.filter(line=>/^(Cây đang theo dõi:|Loài đạt ngưỡng:|Đầu dò đất:|DHT11:|Điều kiện cài đặt:|Đã quan sát |Nên làm:|Cần kiểm tra:|Nguy cơ gây hại:|Cây ký chủ:|Ký chủ:)/.test(line));
 return (operational.length?operational:lines.filter(line=>! /^(Nguồn:|Tham khảo:|Model:|Mô hình:|Đây là ngưỡng |Giới hạn:)/i.test(line)))
  .join('\n').replace(/https?:\/\/\S+/g,'').trim();
}
function alertMarkup(a,compact=false){return `<div class="alert-item ${a.kind&&a.kind!=='environment'?'plant-health-alert':''}"><span class="alert-symbol ${esc(a.severity)}">${icon('bell')}</span><div class="alert-content"><strong>${esc(a.title||a.message.split(':')[0])}</strong><p>${esc(alertSummary(a.message))}</p><small>${esc(a.device_id)} · ${date(a.triggered_at)}${a.acknowledged_at?' · Đã xác nhận':''}</small></div>${!compact&&!a.acknowledged_at&&canManageDashboard()?`<button class="button secondary ack-alert" data-id="${esc(a.id)}">Xác nhận</button>`:''}</div>`;}

async function loadPlantHealth(){
 if(!cloudMode)return;
 const report=await api('/api/plant-health'),warnings=report.rules.filter(r=>r.stage==='warning');
 $('#plant-health-summary').innerHTML=`<strong>Giám sát khu vườn · ${esc(report.profile)}</strong><br>${warnings.length?`${warnings.length} điều kiện cần kiểm tra tại cây.`:!report.fresh?'Chờ dữ liệu mới từ trạm.':'Chưa ghi nhận cảnh báo mới.'} <a href="#alerts">Xem chi tiết →</a>`;
 $('#plant-health-panel').innerHTML=`<h2>Trạng thái giám sát · ${esc(report.profile)}</h2><div class="plant-health-grid">${report.rules.map(r=>`<article class="plant-health-rule"><span class="health-badge" data-stage="${esc(r.stage)}">${esc(r.label)}</span><h3>${esc(({soil_wet:'Đất ướt kéo dài',humid_environment:'Môi trường ẩm kéo dài',pest_image:'Sâu hại trong ảnh'})[r.id]||r.name)}</h3><p><strong>Đầu vào:</strong> ${esc(r.sensor)}</p><p class="health-threshold">${esc(r.threshold)}</p><p>${r.stage==='needs_calibration'?'Cần hiệu chuẩn đầu dò đất.':r.stage==='disabled'?'Nhóm cảnh báo đang tắt.':r.fresh?(r.id==='soil_wet'?`Đất ADC ${report.measurements.soil_raw} · chỉ số ướt tương đối ${number(r.wet_index)}%.`:`Nhiệt độ ${number(report.measurements.temperature_c)}°C · RH ${number(report.measurements.air_humidity_pct)}%.`):'Chờ số đo mới.'}</p><p>Thời gian duy trì: ${r.observed_minutes} / ${r.parameters.hold_minutes} phút.</p><p><strong>Cần kiểm tra:</strong> ${esc(r.id==='soil_wet'?r.action:report.crop.humid_action)}</p></article>`).join('')}</div>`;
}
function observationInput(id,name,label,value,min,max,optional=false,step=1){return `<label for="${id}-${name}">${label}<input id="${id}-${name}" name="${name}" type="number" min="${min}" max="${max}" step="${step}" value="${value??''}" ${optional?'':'required'}></label>`;}
function pestSpeciesFields(parameters){
 const thresholds=window.FruitHealth.pestAlertThresholds(parameters);
 return `<div class="pest-alert-list" role="group" aria-label="Loài côn trùng cảnh báo"><div class="pest-alert-head" aria-hidden="true"><span>Loài côn trùng</span><span>Con / ảnh</span></div>${Object.entries(window.FruitHealth.pestAlertSpecies).map(([code,name])=>{
  const enabled=thresholds[code]!=null,id=`pest-threshold-${code}`;
  return `<div class="pest-species-row${code==='unknown'?' pest-unknown-row':''}"><label class="pest-species-choice"><input type="checkbox" data-pest-species="${code}" aria-controls="${id}" ${enabled?'checked':''}><span>${esc(name)}</span></label><input id="${id}" name="threshold_${code}" type="number" min="1" max="300" step="1" value="${thresholds[code]??1}" aria-label="Ngưỡng ${esc(name)} (con/ảnh)" ${enabled?'required':'disabled'}></div>`;
 }).join('')}</div>`;
}
async function loadRules(){
 if(!cloudMode)return;
 const data=await api('/api/rules');state.observationConfig=data;state.rules=data.rules;
 $('#rule-forms').className='observation-settings';
 $('#rule-forms').innerHTML=`<article class="card observation-profile"><h2>Cây trồng đang theo dõi</h2><label for="observation-crop">Hồ sơ cây ăn quả<select id="observation-crop">${data.crops.map(c=>`<option value="${c.id}" ${c.id===data.active_crop?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label></article><div class="observation-rule-grid">${data.rules.map(r=>{
  const p=r.parameters;let fields='';
  if(r.id==='soil_wet')fields=`<div class="info-box">Đo hai mốc đất khô và đất ướt để bật cảnh báo.</div><div class="form-grid">${observationInput(r.id,'dry_raw','Mốc đất khô (ADC)',p.dry_raw,20,4075,true)}${observationInput(r.id,'wet_raw','Mốc đất ướt (ADC)',p.wet_raw,20,4075,true)}</div><div class="actions"><button type="button" class="button secondary" data-soil-reference="dry_raw">Lấy ADC hiện tại làm mốc khô</button><button type="button" class="button secondary" data-soil-reference="wet_raw">Lấy ADC hiện tại làm mốc ướt</button></div>${observationInput(r.id,'wet_index','Chỉ số ướt tương đối từ (%)',p.wet_index,50,100)}`;
  if(r.id==='humid_environment')fields=`<div class="form-grid">${observationInput(r.id,'temperature_min','Nhiệt độ từ (°C)',p.temperature_min,5,40,false,.1)}${observationInput(r.id,'temperature_max','Nhiệt độ đến (°C)',p.temperature_max,5,40,false,.1)}</div>${observationInput(r.id,'humidity_min','Độ ẩm không khí từ (% RH)',p.humidity_min,70,90)}`;
  if(r.id==='pest_image')fields=pestSpeciesFields(p);
  else fields+=`<div class="form-grid">${observationInput(r.id,'hold_minutes','Duy trì ít nhất (phút)',p.hold_minutes,15,720)}${observationInput(r.id,'cooldown_minutes','Khoảng nghỉ gửi lại (phút)',p.cooldown_minutes,15,1440)}</div>`;
  return `<article class="card observation-rule"><h2>${esc(({soil_wet:'Đất ướt kéo dài',humid_environment:'Môi trường ẩm kéo dài',pest_image:'Sâu hại trong ảnh'})[r.id]||r.name)}</h2><span class="tag">${esc(r.sensor)}</span><form class="observation-rule-form" data-id="${r.id}">${fields}<label class="check-row"><input name="enabled" type="checkbox" ${r.enabled?'checked':''}> Bật nhóm cảnh báo này</label><button class="button secondary full" type="submit">Lưu thiết lập · ${esc(data.crop.name)}</button></form></article>`;
 }).join('')}</div>`;
}

async function loadAlerts(){const result=await api(`/api/alerts?offset=${state.alertOffset}&limit=20&state=${state.alertState}`);state.alertTotal=result.total;$('#alert-list').innerHTML=result.rows.map(a=>alertMarkup(a)).join('')||'<div class="empty">Không có cảnh báo trong danh sách này.</div>';$('#alert-total').textContent=`${result.total} cảnh báo`;$('#alert-page').textContent=`Trang ${Math.floor(state.alertOffset/20)+1}`;$('#alert-prev').disabled=state.alertOffset===0;$('#alert-next').disabled=state.alertOffset+20>=result.total;}
function mediaPath(id,trashed=false){return `/media/${encodeURIComponent(id)}${cloudMode?(trashed?'?trashed=1':''):'.png'}`;}
function imageAttribution(row){
 const account=row.actor_username;
 if(row.scheduled_day)return 'Tự chụp theo lịch 07:00 · giờ Việt Nam';
 if(row.capture_origin==='automatic')return 'Cảm biến tự chụp';
 if(row.capture_origin==='manual')return account?`Chụp từ web · tài khoản ${account}`:'Chụp từ web · chưa lưu tài khoản';
 if(row.capture_origin==='upload'||row.source==='upload')return account?`Tải lên · tài khoản ${account}`:'Ảnh tải lên · chưa lưu tài khoản';
 return 'Ảnh cũ · chưa lưu nguồn chụp';
}
function imagePreview(row){
 const detections=row.analysis?.detections||row.detections||[],width=row.analysis?.width||960,height=row.analysis?.height||600;
 return `<div class="image-preview"><img src="${mediaPath(row.id,Boolean(row.deleted_at))}" alt="${row.source==='hardware'?'Ảnh camera':'Ảnh'} của ${esc(row.device_id)}" loading="lazy"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${detections.map(d=>`<rect class="ai-box" data-class="${esc(d.pest_code)}" x="${d.x_min*width}" y="${d.y_min*height}" width="${(d.x_max-d.x_min)*width}" height="${(d.y_max-d.y_min)*height}" fill="none"/>`).join('')}</svg></div>`;
}

let imageLoadVersion=0;
async function loadImages(){
 const version=++imageLoadVersion, device=$('#image-device').value;
 const trashed=Boolean(state.imageTrash);
 const result=await api(`/api/images?offset=${state.imageOffset}&limit=12${trashed?'&trashed=1':''}${device?'&device='+encodeURIComponent(device):''}`);
 if(cloudMode){
  let notice=$('#image-automation');
  if(!notice){notice=document.createElement('div');notice.id='image-automation';notice.className='info-box';$('#image-grid').before(notice);}
  const automation=await api('/api/automation');
  notice.textContent=`Lịch chụp: 07:00 hằng ngày · ${automation.cloud_ai?'Phân tích tự động đã bật':'Phân tích tự động chưa bật'}${automation.pending?` · ${automation.pending} ảnh chờ xử lý`:''}`;
 }
 if(version!==imageLoadVersion)return;
 if(state.imageOffset&&state.imageOffset>=result.total){state.imageOffset=Math.floor(Math.max(0,result.total-1)/12)*12;return loadImages();}
 state.images=result.rows;state.imageTotal=result.total;
 const imageKey=JSON.stringify([trashed,state.imageOffset,result.rows,result.total]);
 if(!cloudMode||state.imageKey!==imageKey){
  state.imageKey=imageKey;
  $('#image-total').textContent=`${result.total} ảnh ${trashed?'trong Thùng rác':'đã lưu'}`;$('#image-page').textContent=`Trang ${Math.floor(state.imageOffset/12)+1}`;$('#image-prev').disabled=state.imageOffset===0;$('#image-next').disabled=state.imageOffset+12>=result.total;
  $('#image-grid').innerHTML=result.rows.map(row=>`<button class="image-card" data-id="${esc(row.id)}">${imagePreview(row)}<div class="image-info"><h3>${esc(row.device_id)}<span class="tag">${row.source==='simulation'?'Mô phỏng':row.source==='hardware'?'Camera thật':'Ảnh tải lên'}</span></h3><p>${cloudMode?'Nhận lúc ':''}${date(row.captured_at||row.received_at)}</p>${cloudMode?`<p class="image-origin">${esc(imageAttribution(row))}</p>`:''}<p>${row.deleted_at?'Đã xóa · Mở để khôi phục':row.status==='succeeded'?`${row.pest_count} côn trùng · Đã lưu kết quả AI`:cloudMode?(['queued','running'].includes(row.status)?'Chờ AI tự động phân tích':row.status==='failed'?'AI tự động chưa thành công · Có thể thử trên web':'Mở ảnh để phân tích thử'):row.status==='failed'?'Chưa có model thật':'Đang xử lý…'}</p></div></button>`).join('')||`<div class="empty">${cloudMode?'Thư viện chưa có ảnh. Bạn có thể tải ảnh lên hoặc chụp ảnh mới.':'Chưa có ảnh. Bấm “Chụp mô phỏng” để bắt đầu.'}</div>`;
 }
 if(!result.rows.length&&trashed)$('#image-grid').innerHTML='<div class="empty">Thùng rác trống.</div>';
 if(cloudMode&&canManageDashboard()&&!trashed)setTimeout(()=>runBrowserAssist(),0);
 let latest=result.rows[0];if(trashed||state.imageOffset||device){const first=await api('/api/images?limit=1');latest=first.rows[0];}
 if(version!==imageLoadVersion)return;
 const camera=$('#overview-camera');
 if(latest&&(!cloudMode||camera.dataset.id!==latest.id)){
  camera.classList.remove('empty');
  camera.innerHTML=`<img src="${mediaPath(latest.id)}" alt="Ảnh bẫy gần nhất"${cloudMode?' loading="lazy" decoding="async"':''}><div class="camera-overlay"><span>${esc(latest.device_id)} · ${latest.source==='simulation'?'MÔ PHỎNG':latest.source==='hardware'?'CAMERA THẬT':'ẢNH TẢI LÊN'}</span><span>${latest.status==='succeeded'?latest.pest_count+' đối tượng':cloudMode?'Mở ảnh để phân tích thử':latest.status==='failed'?'Chưa có model thật':'Đang xử lý'}</span></div>`;
  camera.dataset.id=latest.id;
  if(cloudMode){camera.tabIndex=0;camera.setAttribute('role','button');camera.setAttribute('aria-label','Mở ảnh bẫy gần nhất');}
 }else if(cloudMode&&!latest&&camera.dataset.id){
  delete camera.dataset.id;
  camera.classList.add('empty');
  camera.textContent='Đang chờ ảnh đầu tiên từ trạm.';
  for(const attribute of ['tabindex','role','aria-label'])camera.removeAttribute(attribute);
 }
}
async function openImage(id){
 let row=state.images.find(r=>r.id===id);
 if(!row){
  const query=cloudMode?`id=${encodeURIComponent(id)}${state.page==='images'&&state.imageTrash?'&trashed=1':''}`:'limit=1';
  const result=await api('/api/images?'+query);
  row=result.rows.find(r=>r.id===id);
 }
 if(!row&&cloudMode)throw new Error('Ảnh không còn trong thư viện.');
 if(!row)return;
 if(cloudMode){
  const detail=$('#image-detail');
  if(activeAiJob?.panel===detail)activeAiJob.cancel();
  const heading=`<h2>Ảnh bẫy · ${esc(row.device_id)}</h2><span class="tag">${row.source==='upload'?'Ảnh tải lên':'Camera thật'}</span><p class="image-origin">${esc(imageAttribution(row))}</p>`;
  const received=`<p>Nhận lúc ${date(row.captured_at||row.received_at)}</p>`;
  if(row.deleted_at){
   detail.innerHTML=`${heading}${received}<p>Đã chuyển vào Thùng rác lúc ${date(row.deleted_at)}</p>${imagePreview(row)}`;
  }else if(row.status==='succeeded'){
   detail.innerHTML=`${heading}<figure class="ai-photo"><img src="${mediaPath(row.id)}" alt="Ảnh camera"><svg class="ai-overlay" aria-hidden="true" hidden></svg></figure>${received}<button class="button secondary" type="button" data-ai-run>Phân tích lại</button> <button class="button secondary" type="button" data-ai-cancel hidden>Dừng</button><p class="ai-status" role="status"></p><div class="ai-result" hidden></div>`;
   renderAiResult(detail,{...row.analysis,persisted:true});
   detail.querySelector('[data-ai-run]').addEventListener('click',()=>analyzeAiPhoto(detail,mediaPath(row.id)));
   detail.querySelector('[data-ai-cancel]').addEventListener('click',()=>cancelAiPanel(detail));
  }else{
   detail.innerHTML=`${heading}<figure class="ai-photo"><img src="${mediaPath(row.id)}" alt="${row.source==='upload'?'Ảnh tải lên':'Ảnh camera'} ${esc(row.device_id)}"><svg class="ai-overlay" aria-hidden="true" hidden></svg></figure>${received}
    ${['queued','running'].includes(row.status)?'<p>Đang chờ phân tích tự động…</p>':''}${row.error_message?`<p>${esc(row.error_message)}</p>`:''}<button class="button secondary" type="button" data-ai-run>Phân tích ảnh này</button> <button class="button secondary" type="button" data-ai-cancel hidden>Dừng</button><p class="ai-status" role="status"></p><div class="ai-result" hidden></div>`;
   detail.querySelector('[data-ai-run]').addEventListener('click',()=>analyzeAiPhoto(detail,mediaPath(row.id)));
   detail.querySelector('[data-ai-cancel]').addEventListener('click',()=>cancelAiPanel(detail));
  }
  if(canManageDashboard()){
   const controls=document.createElement('div');controls.className='image-management';
   controls.innerHTML=row.deleted_at?'<button type="button" class="button secondary" data-image-restore>Khôi phục ảnh</button>':`<button type="button" class="button image-delete" data-image-delete>Xóa ảnh</button><div class="image-delete-confirm" hidden><p>Chuyển ảnh này vào Thùng rác? Bạn có thể khôi phục lại trong mục Thùng rác.</p><div class="actions"><button type="button" class="button image-delete" data-image-confirm>Xác nhận xóa</button><button type="button" class="button secondary" data-image-cancel>Giữ lại ảnh</button></div></div>`;
   detail.append(controls);
   if(row.deleted_at){controls.querySelector('[data-image-restore]').addEventListener('click',event=>action(event.currentTarget,()=>changeImageTrash(row,false)));}
   else{
    const prompt=controls.querySelector('.image-delete-confirm'),start=controls.querySelector('[data-image-delete]');
    start.addEventListener('click',()=>{prompt.hidden=false;start.hidden=true;controls.querySelector('[data-image-cancel]').focus();});
    controls.querySelector('[data-image-cancel]').addEventListener('click',()=>{prompt.hidden=true;start.hidden=false;start.focus();});
    controls.querySelector('[data-image-confirm]').addEventListener('click',event=>action(event.currentTarget,()=>changeImageTrash(row,true)));
   }
  }
 }else{
  $('#image-detail').innerHTML=`<h2>${esc(row.device_id)} · ${date(row.captured_at)}</h2><span class="tag">${row.source==='simulation'?'Ảnh bẫy tổng hợp':'Ảnh tải lên'}</span>${imagePreview(row)}<p>Trạng thái: ${esc(row.status)} · Bộ xử lý: ${esc(row.model_version)}</p>${row.error_message?`<div class="info-box">${esc(row.error_message)}</div>`:''}<div class="detections">${Object.entries(species).map(([code,name])=>`<span class="tag">${name}: ${row.detections.filter(d=>d.pest_code===code).length}</span>`).join('')}</div><p>${row.source==='simulation'?'Các nhãn và khung được xác định từ màu của hình tổng hợp; không phải xác suất hay độ chính xác của model sâu bệnh thực tế.':'Ảnh đã được lưu an toàn. Chưa thực hiện nhận diện sâu bệnh.'}</p>`;
 }
 $('#image-dialog').showModal();
}

async function changeImageTrash(row,trashed){
 await api(`/api/images/${encodeURIComponent(row.id)}${trashed?'':'/restore'}`,{method:trashed?'DELETE':'POST',signal:AbortSignal.timeout(15000)});
 if(activeAiJob?.panel===$('#image-detail'))activeAiJob.cancel();
 $('#image-dialog').close();
 state.imageKey=null;
 if(trashed&&$('#capture-result').dataset.imageId===row.id){$('#capture-result').hidden=true;$('#capture-status').textContent='Ảnh vừa chụp đã chuyển vào Thùng rác.';}
 toast(trashed?'Đã chuyển ảnh vào Thùng rác.':'Đã khôi phục ảnh về thư viện.');
 await loadImages();
 await refresh();
}

function setImageTrashView(trashed){
 state.imageTrash=trashed;state.imageOffset=0;state.imageKey=null;
 state.images=[];imageLoadVersion++;
 $('#image-grid').innerHTML='<div class="empty" role="status">Đang tải ảnh…</div>';
 const button=$('#image-trash-toggle');
 button.textContent=trashed?'Về thư viện':'Thùng rác';
 button.setAttribute('aria-pressed',String(trashed));
 $('#image-trash-note').hidden=!trashed;
}

let aiWorker, activeAiJob, aiRequestId=0;
let aiDemoSamples=[], aiDemoLoading=false;
let demoTestPreview=null;

function aiStatus(panel, text, error=false){
 const status=panel.querySelector('.ai-status');
 status.textContent=text;
 status.classList.toggle('error',error);
}

function resetAiResult(panel){
 panel.querySelector('.ai-overlay').setAttribute('hidden','');
 panel.querySelector('.ai-result').hidden=true;
 aiStatus(panel,'');
 if(panel.id==='ai-demo'){
  demoTestPreview=null;
  $('#ai-demo-telegram').hidden=true;
  $('#ai-demo-telegram-status').textContent='';
 }
}

function requestAiInference(panel,input){
 activeAiJob?.cancel();
 aiWorker??=new Worker('/static/ai-inference.js');
 const worker=aiWorker, id=++aiRequestId;
 return new Promise((resolve,reject)=>{
  function finish(){
   clearTimeout(timer);
   worker.onmessage=worker.onerror=worker.onmessageerror=null;
   activeAiJob=null;
  }
  function fail(error){
   finish();
   worker.terminate();
   aiWorker=null;
   reject(error);
  }
  const timer=setTimeout(()=>fail(new Error('Phân tích quá thời gian. Bạn có thể thử lại với ảnh nhỏ hơn.')),180000);
  activeAiJob={panel,cancel:()=>fail(new DOMException('Đã dừng phân tích.','AbortError'))};
  worker.onmessage=({data})=>{
   if(data?.id!==id)return;
   if(data.type==='progress'){
    const regions=data.total>1?` (${data.completed||0}/${data.total} lượt xử lý)`:'';
    aiStatus(panel,data.stage==='loading'?'Đang tải mô hình AI…':`Đang phân tích ảnh${regions}…`);
   }else if(data.type==='result'){
    finish();
    resolve(data);
   }else if(data.type==='error'){
    fail(new Error(data.message||'Chưa phân tích được ảnh. Bạn có thể thử lại.'));
   }
  };
  worker.onerror=event=>{
   event.preventDefault();
   fail(new Error('Trình duyệt chưa khởi động được mô hình AI.'));
  };
  worker.onmessageerror=()=>fail(new Error('Trình duyệt chưa đọc được kết quả AI.'));
  try{worker.postMessage(input instanceof Blob?{id,file:input}:{id,imageUrl:input});}catch(error){fail(error);}
 });
}

function renderAiResult(panel,{width,height,detections,model_version,truncated}){
 if(!Number.isInteger(width)||width<1||!Number.isInteger(height)||height<1||!Array.isArray(detections)){
  throw new Error('Mô hình trả về kết quả ảnh không hợp lệ.');
 }
 const counts=Object.fromEntries(Object.keys(aiSpecies).map(code=>[code,0]));
 const boxes=[];
 for(const detection of detections){
  const {pest_code:code,x_min,y_min,x_max,y_max}=detection;
  if(!Object.hasOwn(counts,code)||![x_min,y_min,x_max,y_max].every(n=>Number.isFinite(n)&&n>=0&&n<=1)||x_max<=x_min||y_max<=y_min)continue;
  counts[code]++;
  const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');
  const attributes={x:x_min*width,y:y_min*height,width:(x_max-x_min)*width,height:(y_max-y_min)*height,class:'ai-box','data-class':code};
  for(const [name,value] of Object.entries(attributes))rect.setAttribute(name,value);
  const title=document.createElementNS('http://www.w3.org/2000/svg','title');
  title.textContent=`#${boxes.length+1} · ${aiSpecies[code]} · điểm model ${number(detection.confidence,2)}`;
  rect.append(title);
  boxes.push(rect);
 }
 const overlay=panel.querySelector('.ai-overlay');
 overlay.setAttribute('viewBox',`0 0 ${width} ${height}`);
 overlay.setAttribute('preserveAspectRatio','none');
 overlay.replaceChildren(...boxes);
 overlay.toggleAttribute('hidden',boxes.length===0);
 const result=panel.querySelector('.ai-result');
 result.innerHTML=`<strong>Kết quả nhận diện</strong><div class="ai-counts"><span>Côn trùng <b>${truncated?'≥ ':''}${boxes.length}</b></span><span>Gợi ý loài <b>${boxes.length-counts.unknown}</b></span><span>Chưa rõ loài <b>${counts.unknown}</b></span></div><div class="ai-species-info">${Object.entries(aiInfo).filter(([code])=>counts[code]>0).map(([code,[host,note]])=>`<article><div class="ai-species-heading"><h3>${esc(aiSpecies[code])}</h3><span class="tag">${counts[code]} con</span></div><p><strong>Cây ký chủ:</strong> ${esc(host)}</p><p>${esc(note)}</p></article>`).join('')}</div>`;
 const download=document.createElement('button');download.type='button';download.className='button secondary';download.textContent='Tải ảnh có khung';
 download.addEventListener('click',()=>action(download,()=>downloadProcessedPhoto(panel,{detections})));
 result.append(download);
 result.hidden=false;
 if(cloudMode&&panel.id==='ai-demo')prepareDemoResultTest(model_version,counts).catch(error=>{
  $('#ai-demo-telegram-status').textContent=error.message;
 });
}

async function prepareDemoResultTest(model_version,counts){
 const preview={request_id:crypto.randomUUID(),sample_id:$('#ai-demo-sample').value,model_version,counts:{...counts},sent:new Set()};
 demoTestPreview=preview;
 $('#ai-demo-telegram').hidden=false;$('#ai-demo-send-test').disabled=true;
 $('#ai-demo-telegram-status').textContent='Đang tải người nhận Telegram…';
 const data=await api('/api/telegram/recipients');
 if(demoTestPreview!==preview)return;
 const people=data.recipients.filter(r=>r.enabled&&r.state!=='blocked'),selector=$('#ai-demo-recipient');
 selector.replaceChildren(new Option('Chọn người nhận',''),...people.map(r=>new Option(`${r.name} · ${r.chat}`,r.id)));
 if(people.length===1)selector.value=people[0].id;
 $('#ai-demo-send-test').disabled=!people.length;
 $('#ai-demo-telegram-status').textContent=people.length?'Chọn người nhận để gửi tin thử.':'Kết nối người nhận trong mục Telegram & thiết lập.';
}
if(cloudMode){
 $('#ai-demo-recipient').addEventListener('change',()=>{
  $('#ai-demo-send-test').disabled=!demoTestPreview||!$('#ai-demo-recipient').value||demoTestPreview.sent.has($('#ai-demo-recipient').value);
 });
 $('#ai-demo-send-test').addEventListener('click',async event=>{
  const button=event.currentTarget;
  const preview=demoTestPreview,id=$('#ai-demo-recipient').value;
  if(!preview||!id){$('#ai-demo-telegram-status').textContent='Bạn chọn người nhận Telegram trước khi gửi thử.';return;}
  button.disabled=true;
  const {sent,...body}=preview;
  $('#ai-demo-telegram-status').textContent='Đang gửi cảnh báo thử từ kết quả ảnh mẫu…';
  try{
   const result=await api(`/api/telegram/recipients/${id}/demo-test`,{method:'POST',body,signal:AbortSignal.timeout(25000)});
   if(demoTestPreview!==preview)return;
   const receipt=result.receipt;
   if(receipt?.sent_at&&receipt.message_id){
    preview.sent.add(id);
    $('#ai-demo-telegram-status').textContent=`Đã gửi tin thử · ${date(receipt.sent_at)}`;
   }else $('#ai-demo-telegram-status').textContent=receipt?.failed_at?'Telegram chưa gửi được tin thử. Kiểm tra trạng thái kết nối.':'Tin thử đã vào hàng đợi Telegram; hệ thống sẽ thử lại khi có thể.';
  }catch(error){if(demoTestPreview===preview)$('#ai-demo-telegram-status').textContent=error.message;}
  finally{if(demoTestPreview===preview)button.disabled=preview.sent.has($('#ai-demo-recipient').value);}
 });
}

async function analyzeAiPhoto(panel,imageUrl){
 if(!imageUrl)return;
 const button=panel.querySelector('[data-ai-run]');if(button.disabled)return;
 const photoId=typeof imageUrl==='string'?/^\/media\/([a-f0-9-]{36})$/i.exec(imageUrl)?.[1]:null;
 let claim;
 button.disabled=true;const cancel=panel.querySelector('[data-ai-cancel]');if(cancel)cancel.hidden=false;
 resetAiResult(panel);aiStatus(panel,'Đang chuẩn bị mô hình AI…');
 try{
  if(photoId&&canManageDashboard()){
   claim=await api(`/api/images/${photoId}/analysis/claim?reanalyze=1`,{method:'POST'});
   if(claim.already_completed){renderAiResult(panel,claim.result);aiStatus(panel,'Kết quả và khung đã được lưu.');return;}
  }
  let result=await requestAiInference(panel,imageUrl);
  if(claim){
   const saved=await api(`/api/images/${photoId}/analysis/complete`,{method:'POST',body:{lease_token:claim.lease_token,result}});
   claim=null;result=saved.result;await loadImages();
  }
  renderAiResult(panel,result);aiStatus(panel,photoId&&canManageDashboard()?'Đã lưu kết quả và khung vào thư viện.':'Đã phân tích xong.');
 }catch(error){if(error.name!=='AbortError')aiStatus(panel,error.message||'Chưa phân tích được ảnh.',true);}
 finally{
  if(claim?.lease_token)await api(`/api/images/${photoId}/analysis/fail`,{method:'POST',body:{lease_token:claim.lease_token}}).catch(()=>{});
  button.disabled=false;if(cancel)cancel.hidden=true;
 }
}

let browserAssistBusy=false,browserAssistEnabled=true;
const browserAssistAttempted=new Set();
try{browserAssistEnabled=localStorage.getItem('ptit-browser-ai')!=='off';}catch{}
function browserAssistPanel(){
 let panel=$('#browser-ai-panel');if(panel)return panel;
 panel=document.createElement('article');panel.id='browser-ai-panel';panel.className='card';
 panel.innerHTML='<h2>AI lưu ảnh tự động</h2><label class="check-row"><input type="checkbox" data-browser-ai> Xử lý ảnh camera khi mở trang này</label><p>Khi cloud bị giới hạn, trình duyệt sẽ xử lý ảnh chờ/lỗi và lưu các khung về thư viện.</p><p class="ai-status" role="status"></p><button class="button secondary" type="button" data-browser-retry>Thử lại ảnh lỗi</button>';
 panel.querySelector('[data-browser-ai]').checked=browserAssistEnabled;
 panel.querySelector('[data-browser-ai]').addEventListener('change',event=>{
  browserAssistEnabled=event.target.checked;try{localStorage.setItem('ptit-browser-ai',browserAssistEnabled?'on':'off');}catch{}
  if(!browserAssistEnabled&&activeAiJob?.panel===panel)activeAiJob.cancel();
  if(browserAssistEnabled)runBrowserAssist();
 });
 panel.querySelector('[data-browser-retry]').addEventListener('click',()=>{browserAssistAttempted.clear();runBrowserAssist();});
 $('#image-grid').before(panel);return panel;
}
async function runBrowserAssist(){
 if(!cloudMode||!canManageDashboard()||document.hidden||!['images','overview'].includes(state.page))return;
 const panel=browserAssistPanel();
 if(!browserAssistEnabled||browserAssistBusy||activeAiJob)return;
 const row=state.images.find(r=>r.source==='hardware'&&!r.deleted_at&&['queued','failed'].includes(r.status)&&!browserAssistAttempted.has(r.id));
 if(!row)return;
 browserAssistBusy=true;browserAssistAttempted.add(row.id);let claim;
 try{
  claim=await api(`/api/images/${row.id}/analysis/claim`,{method:'POST'});
  if(!claim.already_completed){
   aiStatus(panel,'Đang xử lý ảnh camera · '+date(row.received_at));
   const result=await requestAiInference(panel,mediaPath(row.id));
   await api(`/api/images/${row.id}/analysis/complete`,{method:'POST',body:{lease_token:claim.lease_token,result}});
  }
  claim=null;aiStatus(panel,'Đã lưu ảnh và khung. Cảnh báo được xét theo ngưỡng của ảnh.');await loadImages();
 }catch(error){
  if(error.name!=='AbortError')aiStatus(panel,error.status===409?'Ảnh đang được cloud/phiên khác xử lý.':error.message,true);
  else browserAssistAttempted.delete(row.id);
 }finally{
  if(claim?.lease_token)await api(`/api/images/${row.id}/analysis/fail`,{method:'POST',body:{lease_token:claim.lease_token}}).catch(()=>{});
  browserAssistBusy=false;
  if(browserAssistEnabled)setTimeout(()=>runBrowserAssist(),1500);
 }
}

async function downloadProcessedPhoto(panel,result){
 const img=panel.querySelector('.ai-photo img');await img.decode();
 const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
 const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);ctx.lineWidth=Math.max(2,canvas.width/400);ctx.font=`${Math.max(12,canvas.width/65)}px Arial`;
 for(const d of result.detections){
  const x=d.x_min*canvas.width,y=d.y_min*canvas.height,w=(d.x_max-d.x_min)*canvas.width,h=(d.y_max-d.y_min)*canvas.height;
  ctx.strokeStyle=d.pest_code==='unknown'?'#e3339e':'#1475e8';ctx.fillStyle=ctx.strokeStyle;ctx.strokeRect(x,y,w,h);
  ctx.fillText(d.pest_code==='unknown'?'Côn trùng':aiSpecies[d.pest_code],x,Math.max(16,y-4));
 }
 const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.92));if(!blob)throw new Error('Chưa xuất được ảnh.');
 const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='PTIT-anh-da-xu-ly.jpg';link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}

function cancelAiPanel(panel){
 if(activeAiJob?.panel===panel){activeAiJob.cancel();aiStatus(panel,'Đã dừng phân tích.');}
}

let uploadFile=null, uploadPreview=null, uploadVersion=0, uploadSavedVersion=null;
function clearUpload(){
 const panel=$('#ai-upload');
 cancelAiPanel(panel);
 uploadVersion++;
 uploadFile=null;
 panel.querySelector('img').removeAttribute('src');
 if(uploadPreview)URL.revokeObjectURL(uploadPreview);
 uploadPreview=null;
 $('#image-upload').value='';
 panel.hidden=true;
}
async function chooseUpload(file){
 if(!file)return;
 if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Chọn ảnh JPEG, PNG hoặc WebP.');
 if(file.size>12*1024*1024)throw new Error('Ảnh tối đa 12 MB.');
 const version=++uploadVersion;
 let bitmap;
 try{bitmap=await createImageBitmap(file);}catch{throw new Error('Không đọc được ảnh. Hãy chọn tệp ảnh khác.');}
 const valid=bitmap.width*bitmap.height<=16000000&&bitmap.width>0&&bitmap.height>0;
 bitmap.close();
 if(!valid)throw new Error('Ảnh tối đa 16 triệu điểm ảnh.');
 if(version!==uploadVersion)return;
 const panel=$('#ai-upload');
 cancelAiPanel(panel);
 if(uploadPreview)URL.revokeObjectURL(uploadPreview);
 uploadFile=file;
 uploadPreview=URL.createObjectURL(file);
 panel.querySelector('img').src=uploadPreview;
 $('#upload-name').textContent=file.name;
 $('#upload-save-status').textContent='';
 $('#save-upload').disabled=false;
 resetAiResult(panel);
 panel.hidden=false;
 panel.scrollIntoView({behavior:'smooth',block:'start'});
}
async function saveUpload(){
 const file=uploadFile, version=uploadVersion;
 if(!file)return;
 let blob=file.type==='image/jpeg'&&file.size<=512*1024?file:null;
 if(!blob){
 const bitmap=await createImageBitmap(file);
 try{
  const ratio=Math.min(1,1920/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(bitmap.width*ratio));
  canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
  const context=canvas.getContext('2d');
  context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
  context.drawImage(bitmap,0,0,canvas.width,canvas.height);
  for(const quality of [.95,.85,.7,.5,.3]){
   blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
   if(blob&&blob.size<=512*1024)break;
  }
 }finally{bitmap.close();}
 }
 if(!blob||blob.size>512*1024)throw new Error('Chưa nén được ảnh để lưu. Hãy chọn ảnh nhỏ hơn.');
 if(version!==uploadVersion)return;
 const result=await api('/api/images/upload',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:blob,signal:AbortSignal.timeout(30000)});
 if(version===uploadVersion){
  $('#upload-save-status').textContent=blob===file?'Đã lưu nguyên ảnh JPEG vào thư viện. Kết quả phân tích hiện tại không được lưu kèm.':'Đã lưu bản JPEG đã nén vào thư viện. Nén ảnh có thể làm thay đổi số đếm; kết quả hiện tại không được lưu kèm.';
  $('#save-upload').disabled=true;
  uploadSavedVersion=version;
 }
 setImageTrashView(false);
 await loadImages();
 toast('Đã lưu ảnh vào thư viện.');
 return result;
}

function selectAiDemoSample(panel){
 const selector=$('#ai-demo-sample');
 const sample=aiDemoSamples.find(item=>item.id===selector.value);
 if(!sample)return;
 if(activeAiJob?.panel===panel)activeAiJob.cancel();
 resetAiResult(panel);
 const photo=panel.querySelector('.ai-photo');
 const img=photo.querySelector('img');
 img.alt=sample.title;
 img.src=sample.image;
 photo.hidden=false;

}

async function loadAiDemo(panel){
 if(aiDemoLoading||aiDemoSamples.length)return;
 aiDemoLoading=true;
 const retry=$('#ai-demo-retry');
 retry.hidden=true;
 aiStatus(panel,'Đang tải ảnh mẫu…');
 try{
  const manifest=await api('/static/ai/demo.json');
  aiDemoSamples=(manifest.samples||[]).filter(sample=>typeof sample?.id==='string'&&typeof sample.title==='string'&&typeof sample.image==='string'&&/^\/static\/ai\/demo\/[a-z0-9_-]+\.jpg$/i.test(sample.image));
  if(!aiDemoSamples.length)throw new Error('Chưa có ảnh mẫu trong thư viện AI.');
  const selector=$('#ai-demo-sample');
  selector.replaceChildren(...aiDemoSamples.map(sample=>new Option(sample.title,sample.id)));
  selector.disabled=false;
  panel.querySelector('[data-ai-run]').disabled=false;
  selectAiDemoSample(panel);
 }catch(error){
  aiStatus(panel,error.message||'Chưa tải được ảnh mẫu.',true);
  retry.hidden=false;
 }finally{
  aiDemoLoading=false;
 }
}

const CAPTURE_SESSION_KEY='ptit-garden.capture';
let pendingCloudCaptureId=null;
const pauseCapture=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const captureRetryMessage='Chưa xác nhận được kết quả. Bấm “Kiểm tra lại” để xem trạng thái yêu cầu.';

class CaptureConnectionError extends Error {
 constructor(){super(captureRetryMessage);}
}

function rememberCloudCapture(id){
 pendingCloudCaptureId=id;
 try{
  if(id)sessionStorage.setItem(CAPTURE_SESSION_KEY,id);
  else sessionStorage.removeItem(CAPTURE_SESSION_KEY);
 }catch{}
}

function updateCaptureButton(){
 $('#capture-button').lastChild.textContent=pendingCloudCaptureId?'Kiểm tra lại':'Chụp ảnh ngay';
}

async function requestCloudCapture(path,options,deadline,onReconnect){
 let delay=1000;
 while(performance.now()<deadline){
  try{
   const timeout=Math.max(1,Math.min(7000,Math.ceil(deadline-performance.now())));
   return await api(path,{...options,signal:AbortSignal.timeout(timeout)});
  }catch(error){
   const retryable=error instanceof TypeError||error instanceof SyntaxError||
    error.name==='TimeoutError'||error.name==='AbortError'||
    error.status===408||(error.status>=500&&error.status<=599);
   if(!retryable)throw error;
   onReconnect();
   await pauseCapture(Math.min(delay,Math.max(0,deadline-performance.now())));
   delay=Math.min(delay*2,5000);
  }
 }
 throw new CaptureConnectionError();
}

async function captureCloudImage(){
 const feedback=$('#capture-feedback');
 const statusElement=$('#capture-status');
 const view=$('#capture-result');
 const showStatus=message=>{if(statusElement.textContent!==message)statusElement.textContent=message;};
 const onReconnect=()=>showStatus('Kết nối gián đoạn. Đang kiểm tra lại yêu cầu chụp…');
 const resume=Boolean(pendingCloudCaptureId);
 feedback.hidden=false;
 feedback.classList.remove('capture-error');
 view.hidden=true;
 showStatus(resume?'Đang kiểm tra lại yêu cầu chụp…':'Đang gửi yêu cầu chụp…');

 let request;
 try{
  const collection='/api/camera/requests';
  if(!resume){
   const id=crypto.randomUUID();
   rememberCloudCapture(id);
   request=await requestCloudCapture(collection,{method:'POST',headers:{'X-Garden-Capture-ID':id}},
    performance.now()+25000,onReconnect);
   rememberCloudCapture(request.id);
  }
  const requestPath=collection+'/'+encodeURIComponent(pendingCloudCaptureId);
  const deadline=performance.now()+100000;
  if(resume)request=await requestCloudCapture(requestPath,{},deadline,onReconnect);
  while(request.status==='queued'||request.status==='sent'){
   if(performance.now()+2000>=deadline)throw new CaptureConnectionError();
   showStatus(request.status==='queued'
    ?'Đã gửi yêu cầu. Đang chờ ESP32-CAM nhận lệnh…'
    :'ESP32-CAM đã nhận lệnh. Đang chờ ảnh tải lên…');
   await pauseCapture(2000);
   request=await requestCloudCapture(requestPath,{},deadline,onReconnect);
  }
  if(request.status==='failed')throw new Error(request.error||'ESP32-CAM chưa gửi được ảnh.');
  if(request.status!=='succeeded'||!request.image_id)throw new Error('Chưa xác nhận được ảnh đã chụp.');
  rememberCloudCapture(null);
 }catch(error){
  if(!(error instanceof CaptureConnectionError))rememberCloudCapture(null);
  feedback.classList.add('capture-error');
  showStatus(error.message);
  return;
 }finally{
  updateCaptureButton();
 }

 showStatus('Đã nhận và lưu ảnh từ ESP32-CAM.');
 view.dataset.imageId=request.image_id;
 view.hidden=false;
 if(state.page==='images'){
  setImageTrashView(false);
  loadImages().catch(error=>toast(error.message,true));
  if(!$('#image-dialog').open)await openImage(request.image_id).catch(error=>toast(error.message,true));
 }
}
function fillSimulation(){if(!state.data)return;const form=$('#simulation-form'),s=state.data.simulation;form.elements.scenario.value=s.scenario;form.elements.interval_seconds.value=s.interval_seconds;form.elements.camera_seconds.value=s.camera_seconds;form.elements.running.checked=s.running;$$('input[name=offline]').forEach(c=>c.checked=s.offline_devices.includes(c.value));}
const TELEGRAM_PAIR_KEY='ptit-garden.telegram-pair';
let telegramPairingData=null, telegramPairBusy=false, telegramIssuedCode=null;
function cachedTelegramCode(pair){
 try{
  const cached=telegramIssuedCode??JSON.parse(sessionStorage.getItem(TELEGRAM_PAIR_KEY)||'null');
  return cached?.id===pair?.id&&/^\d{6}$/.test(cached.code)?cached.code:null;
 }catch{return null;}
}
function telegramPairMessage(text,error=false){
 $('#telegram-pairing-status').textContent=text;
 $('#telegram-pairing-status').classList.toggle('error',error);
}
function renderTelegramPairing(){
 if(!telegramPairingData)return;
 const data=telegramPairingData,pair=data.pairing;
 let status=pair?.status;
 if(['pending','confirmation'].includes(status)&&pair.expires_at<=Date.now())status='expired';
 const people=data.recipients||[],active=people.filter(r=>r.enabled&&r.state!=='blocked');
 $('#telegram-connection').textContent=data.bot_configured
  ?`${data.bot_username?'Bot @'+data.bot_username+' · ':''}${active.length} người đang bật nhận / ${people.length} kết nối${data.scope==='own'?' của bạn':''}.`
  :'Bot Telegram chưa được cấu hình.';
 $('#telegram-create-code').disabled=telegramPairBusy||!data.bot_configured;
 for(const id of ['telegram-refresh','telegram-confirm','telegram-cancel'])$('#'+id).disabled=telegramPairBusy;
 const pairingActive=['pending','confirmation'].includes(status),code=cachedTelegramCode(pair);
 $('#telegram-code-box').hidden=!(status==='pending'&&code);
 $('#telegram-confirm-box').hidden=status!=='confirmation';
 $('#telegram-cancel').hidden=!pairingActive;
 $('#telegram-expiry').hidden=!pairingActive;
 if(pairingActive){
  const seconds=Math.max(0,Math.min(600,Math.ceil((pair.expires_at-Date.now())/1000)));
  $('#telegram-expiry').textContent=`Mã hết hạn sau ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}. Chỉ dùng một lần.`;
 }
 if(code&&status==='pending'){
  $('#telegram-code').textContent=code;
  const payload=pair.id.replaceAll('-','')+'_'+code;
  $('#telegram-command').value=`/start ${payload}`;
  $('#telegram-open-bot').href=`https://t.me/${pair.bot_username}?start=${payload}`;
 }
 if(status==='confirmation')$('#telegram-candidate').textContent=`${pair.candidate_name} (${pair.candidate_chat})`;
 if(status==='pending')telegramPairMessage(code?'Đang chờ bạn gửi mã cho bot.':'Có mã đang chờ. Nếu đã gửi mã, bấm Kiểm tra kết nối; hoặc lấy mã mới.');
 else if(status==='confirmation')telegramPairMessage('Kiểm tra đúng chat của bạn rồi bấm Xác nhận kết nối.');
 else if(status==='expired')telegramPairMessage('Mã đã hết hạn. Tạo mã mới để kết nối.');
 else if(status==='cancelled')telegramPairMessage('Đã hủy mã kết nối.');
 else if(status==='connected')telegramPairMessage('Đã kết nối người nhận Telegram.');
 else telegramPairMessage('');
 if(pair&&!pairingActive){telegramIssuedCode=null;try{sessionStorage.removeItem(TELEGRAM_PAIR_KEY);}catch{}}
}
async function telegramTask(task){
 if(telegramPairBusy)return;
 telegramPairBusy=true;renderTelegramPairing();
 try{await task();}
 catch(error){telegramPairMessage(error.message||'Chưa kiểm tra được Telegram.',true);}
 finally{
  telegramPairBusy=false;
  $('#telegram-create-code').disabled=!telegramPairingData?.bot_configured;
  for(const id of ['telegram-refresh','telegram-confirm','telegram-cancel'])$('#'+id).disabled=false;
 }
}
async function loadTelegramPairing(poll=false){
 if(!cloudMode||!state.account)return;
 await telegramTask(async()=>{
  telegramPairingData=await api('/api/telegram/pairing');
  const pair=telegramPairingData.pairing;
  if(poll&&pair?.status==='pending')telegramPairingData.pairing=await api(`/api/telegram/pairing/${pair.id}/poll`,{method:'POST',signal:AbortSignal.timeout(15000)});
  renderTelegramPairing();
 });
}
if(cloudMode){
 $('#telegram-list-open').addEventListener('click',()=>action(null,async()=>{await loadTelegramRecipients(true);$('#telegram-recipients-dialog').showModal();}));
 $('#telegram-list-refresh').addEventListener('click',event=>action(event.currentTarget,()=>loadTelegramRecipients(true)));
 $('#telegram-create-code').addEventListener('click',()=>telegramTask(async()=>{
  telegramPairMessage('Đang lấy mã kết nối…');
  const pair=await api('/api/telegram/pairing',{method:'POST',signal:AbortSignal.timeout(15000)});
  telegramIssuedCode={id:pair.id,code:pair.code};
  try{sessionStorage.setItem(TELEGRAM_PAIR_KEY,JSON.stringify({id:pair.id,code:pair.code}));}catch{}
  telegramPairingData={...telegramPairingData,bot_configured:true,pairing:pair};
  renderTelegramPairing();
 }));
 $('#telegram-refresh').addEventListener('click',()=>loadTelegramPairing(true));
 $('#telegram-copy').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText($('#telegram-command').value);toast('Đã sao chép lệnh. Dán vào chat của bot Telegram.');}
  catch{$('#telegram-command').focus();$('#telegram-command').select();toast('Hãy sao chép lệnh đang được chọn.');}
 });
 $('#telegram-confirm').addEventListener('click',()=>telegramTask(async()=>{
  const id=telegramPairingData?.pairing?.id;if(!id)return;
  telegramPairingData=await api(`/api/telegram/pairing/${id}/confirm`,{method:'POST'});
  renderTelegramPairing();await refresh();toast('Đã thêm người nhận. Bot sẽ gửi xác nhận trên Telegram.');
 }));
 $('#telegram-cancel').addEventListener('click',()=>telegramTask(async()=>{
  const id=telegramPairingData?.pairing?.id;if(!id)return;
  telegramPairingData=await api(`/api/telegram/pairing/${id}/cancel`,{method:'POST'});
  renderTelegramPairing();
 }));
 setInterval(()=>{
  if(state.page!=='settings'||document.hidden)return;
  const pair=telegramPairingData?.pairing;
  if(pair?.status==='pending'&&pair.expires_at>Date.now())loadTelegramPairing(true);
  else if(pair?.status==='confirmation'||pair?.expires_at<=Date.now())renderTelegramPairing();
 },5000);
}

async function loadTelegramRecipients(check=false){
 const data=await api('/api/telegram/recipients'+(check?'?check=1':''));
 const botLink=$('#telegram-current-bot');botLink.hidden=!data.bot_username;
 if(data.bot_username)botLink.href='https://t.me/'+data.bot_username;
 $('#telegram-list-summary').textContent=`${data.bot_username?'Bot @'+data.bot_username+' · ':''}${data.recipients.length} kết nối${data.scope==='own'?' của bạn':''}.`;
 $('#telegram-recipient-list').innerHTML=data.recipients.map(r=>`<article class="telegram-recipient"><div><strong>${esc(r.name)}</strong><span class="health-badge" data-state="${esc(r.state)}">${esc(r.status)}</span><p>Tài khoản web: ${esc(r.owner_username)} · Telegram ${esc(r.chat)}</p><p>Kết nối: ${date(r.connected_at)}<br>Gửi thành công gần nhất: ${date(r.last_sent_at)}</p>${r.last_error_at?`<p>Lần gửi gặp lỗi: ${date(r.last_error_at)}${r.last_error_code?' · Mã '+r.last_error_code:''}</p>`:''}</div><div class="actions"><button class="button secondary" data-telegram-toggle="${r.id}" data-enabled="${r.enabled?'0':'1'}">${r.enabled?'Tạm dừng nhận':'Bật nhận lại'}</button><button class="button secondary" data-telegram-test="${r.id}" ${!r.enabled||r.state==='blocked'?'disabled':''}>Gửi tin thử</button></div></article>`).join('')||'<div class="empty">Chưa có người kết nối. Bấm “Kết nối người nhận” để bắt đầu.</div>';
}
if(cloudMode)$('#telegram-recipient-list').addEventListener('click',event=>{
 const toggle=event.target.closest('[data-telegram-toggle]'),test=event.target.closest('[data-telegram-test]');
 if(toggle)action(toggle,async()=>{await api('/api/telegram/recipients/'+toggle.dataset.telegramToggle,{method:'PUT',body:{enabled:toggle.dataset.enabled==='1'}});await loadTelegramRecipients();await loadTelegramPairing();});
 if(test)action(test,async()=>{
  $('#telegram-test-status').textContent='Đang gửi tin thử…';
  try{const result=await api(`/api/telegram/recipients/${test.dataset.telegramTest}/test`,{method:'POST',body:{request_id:crypto.randomUUID()},signal:AbortSignal.timeout(25000)});
   const r=result.receipt;$('#telegram-test-status').textContent=r?.sent_at&&r.message_id?`Đã gửi tin thử · ${date(r.sent_at)}`:r?.failed_at?'Telegram chưa gửi được. Xem trạng thái lỗi trong danh sách.':'Tin thử đang chờ gửi lại. Danh sách sẽ cập nhật trạng thái.';
  }catch(error){$('#telegram-test-status').textContent=error.message;}
  await loadTelegramRecipients();
 });
});

async function loadRegistrations(){
 const version=++registrationVersion;
 const refreshButton=$('#refresh-registrations');
 const status=$('#registration-status');
 const list=$('#registration-rows');
 refreshButton.disabled=true;
 status.textContent='Đang tải danh sách…';
 status.hidden=!list.hidden;
 try{
  const {registrations}=await api('/api/admin/registrations');
  if(version!==registrationVersion)return;
  list.innerHTML=registrations.map(({username,created_at})=>`<li class="alert-item"><span class="alert-symbol">${icon('users')}</span><div class="alert-content"><strong>${esc(username)}</strong><small>Đăng ký lúc ${date(created_at)}</small></div><button class="button secondary" type="button" data-approve="${esc(username)}" aria-label="Duyệt tài khoản ${esc(username)}">Duyệt</button></li>`).join('');
  list.hidden=registrations.length===0;
  status.textContent='Chưa có tài khoản nào đang chờ duyệt.';
  status.hidden=!list.hidden;
 }catch(error){
  if(version!==registrationVersion)return;
  status.textContent=error.message;
  status.hidden=false;
 }finally{
  if(version===registrationVersion)refreshButton.disabled=false;
 }
}

async function route(){
 const requestedPage=location.hash.slice(1);
 const allowed=Object.hasOwn(names,requestedPage)&&
  (requestedPage!=='settings'||cloudMode||canManageDashboard())&&
  (requestedPage!=='accounts'||(cloudMode&&canManageDashboard()));
 state.page=allowed?requestedPage:'overview';
 $$('.page').forEach(p=>p.hidden=p.id!==`page-${state.page}`);
 $$('nav a').forEach(a=>a.classList.toggle('active',a.dataset.page===state.page));
 $('#breadcrumb').textContent=names[state.page];
 if(!state.data)return;
 try{
  if(state.page==='simulation')fillSimulation();
  if(state.page==='settings')await Promise.all([canManageDashboard()?loadRules():Promise.resolve(),loadTelegramPairing()]);
  if(state.page==='accounts')await loadRegistrations();
  if(state.page==='devices'){renderDevices();await loadHistory();}
  if(state.page==='overview')await loadHistory();
  if(state.page==='images')await loadImages();
  if(state.page==='alerts')await loadAlerts();
  if(cloudMode&&['overview','alerts','settings'].includes(state.page))await loadPlantHealth();
 }catch(error){toast(error.message,true);}
}
function refreshError(error){
 return cloudMode&&error.name==='TimeoutError'?'Kết nối chậm. Đang thử lại…':error.message;
}
async function refresh(){
 if(state.refreshing)return;
 state.refreshing=true;
 try{
  const firstLoad=!state.data;
  const dashboard=await api('/api/dashboard');
  if(cloudMode&&firstLoad){
   configureCloudAccount(dashboard.account);
   await route();
  }
  renderSnapshot(dashboard);
  const historyVisible=['overview','devices'].includes(state.page);
  const imagesVisible=['overview','images'].includes(state.page);
  if(!cloudMode){
   if(historyVisible)await loadHistory();
   if(imagesVisible)await loadImages();
   return;
  }
  $('#connection').className='status';
 $('#connection').innerHTML='<i></i>Đã kết nối';
  const widgets=[];
  if(['overview','alerts','settings'].includes(state.page))widgets.push(loadPlantHealth());
  if(firstLoad)widgets.push(loadLed());
  if(historyVisible&&Date.now()-state.historyLoadedAt>=60000)widgets.push(loadHistory());
  if(imagesVisible)widgets.push(loadImages());
  if(state.page==='settings'){widgets.push(loadTelegramPairing());if(firstLoad&&canManageDashboard())widgets.push(loadRules());}
  if($('#telegram-recipients-dialog').open)widgets.push(loadTelegramRecipients());
  if(firstLoad&&state.page==='accounts')widgets.push(loadRegistrations());
  const failed=(await Promise.allSettled(widgets)).find(result=>result.status==='rejected');
  if(failed)showError(refreshError(failed.reason));
 }catch(e){
  if(cloudMode){$('#connection').className='status muted';$('#connection').innerHTML='<i></i>Đang kết nối lại';}
  showError(refreshError(e));
 }finally{state.refreshing=false;}
}
function connectSocket(){clearTimeout(reconnectTimer);const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);state.socket=ws;ws.onopen=()=>{$('#connection').className='status';$('#connection').innerHTML='<i></i>Cập nhật trực tiếp';};ws.onmessage=event=>{const value=JSON.parse(event.data);if(value.type==='snapshot')renderSnapshot(value.data);else showError(value.message);};ws.onclose=()=>{$('#connection').className='status muted';$('#connection').innerHTML='<i></i>Đang kết nối lại';reconnectTimer=setTimeout(async()=>{try{await api('/api/session',{method:'POST'});connectSocket();}catch{connectSocket();}},3000);};ws.onerror=()=>ws.close();}

window.addEventListener('hashchange',route);
let ledState=null, ledBusy=false, ledVersion=0, ledLoading=false;
function renderLed(){
 if(!ledState)return;
 const s=ledState;
 const wanted=s.desired_on?'bật':'tắt';
 const actual=s.applied_on?'bật':'tắt';
 $('#led-status').textContent=!s.online
  ? `Mất kết nối · Lệnh chờ: ${wanted} đèn`
  : s.pending?`Đang chờ mạch ${wanted} đèn…`
  : `Đã xác nhận ${actual} đèn · ${date(s.confirmed_at)}`;
 for(const [id,on] of [['#led-on',true],['#led-off',false]]){
  const button=$(id);
  button.disabled=ledBusy||!canManageDashboard();
  button.setAttribute('aria-pressed',String(s.online&&!s.pending&&s.applied_on===on));
 }
}
async function loadLed(){
 if(!cloudMode||ledLoading||ledBusy)return;
 ledLoading=true;
 const version=ledVersion;
 try{
  const result=await api('/api/led');
  if(version===ledVersion){ledState=result;renderLed();}
 }catch(error){
  if(version===ledVersion){
   ledState=null;
   $('#led-status').textContent='Chưa kiểm tra được trạng thái đèn. '+refreshError(error);
   $('#led-on').disabled=$('#led-off').disabled=true;
  }
 }finally{ledLoading=false;}
}
async function changeLed(on){
 if(!cloudMode||!canManageDashboard()||ledBusy||!ledState)return;
 ledBusy=true;ledVersion++;renderLed();
 try{
  ledState=await api('/api/led',{method:'PUT',body:{on,revision:ledState.revision},signal:AbortSignal.timeout(12000)});
  toast(`Đã lưu lệnh ${on?'bật':'tắt'} đèn. Đang chờ mạch xác nhận.`);
 }catch(error){
  ledState=null;
  $('#led-status').textContent='Chưa xác nhận được lệnh. Bấm “Kiểm tra lại” trước khi gửi tiếp.';
  toast(error.message,true);
 }finally{
  ledBusy=false;
  if(ledState)renderLed();else $('#led-on').disabled=$('#led-off').disabled=true;
 }
}
$('#led-on').addEventListener('click',()=>changeLed(true));
$('#led-off').addEventListener('click',()=>changeLed(false));
$('#led-refresh').addEventListener('click',()=>loadLed());
setInterval(()=>{if(cloudMode&&state.page==='images'&&!document.hidden)loadLed();},5000);
$('#chart-hours').addEventListener('change',()=>{state.hours=Number($('#chart-hours').value);loadHistory().catch(e=>toast(e.message,true));});
$('#chart-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-metric]');if(!b)return;state.metric=b.dataset.metric;$$('#chart-tabs button').forEach(el=>el.classList.toggle('selected',el===b));renderChart();});
$('#history-device').addEventListener('change',()=>loadHistory().catch(e=>toast(e.message,true)));
$$('.export').forEach(b=>b.addEventListener('click',()=>{const device=state.page==='devices'?$('#history-device').value:'';window.location.assign(`/api/export.csv?hours=${state.hours}${device?'&device='+encodeURIComponent(device):''}`);toast(cloudMode?'Đang tải dữ liệu CSV…':'Đang tải dữ liệu CSV…');}));
$('#alert-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-state]');if(!b)return;state.alertState=b.dataset.state;state.alertOffset=0;$$('#alert-tabs button').forEach(el=>el.classList.toggle('selected',el===b));loadAlerts().catch(e=>toast(e.message,true));});
document.addEventListener('click',e=>{const ack=e.target.closest('.ack-alert');if(ack)action(ack,async()=>{await api(`/api/alerts/${ack.dataset.id}/ack`,{method:'POST'});await loadAlerts();await refresh();toast('Đã xác nhận cảnh báo.');});const image=e.target.closest('.image-card');if(image)action(null,()=>openImage(image.dataset.id));const edit=e.target.closest('.edit-device');if(edit){const d=state.data.devices.find(d=>d.id===edit.dataset.id),f=$('#device-form');for(const k of ['id','name','latitude','longitude'])f.elements[k].value=d[k];f.elements.enabled.checked=d.enabled;$('#device-dialog').showModal();}});
$('#overview-camera').addEventListener('click',()=>{if($('#overview-camera').dataset.id)action(null,()=>openImage($('#overview-camera').dataset.id));});
if(cloudMode)$('#overview-camera').addEventListener('keydown',event=>{
 if(event.key==='Enter'||event.key===' '){event.preventDefault();event.currentTarget.click();}
});
if(cloudMode){
 const demo=$('#ai-demo');
 demo.addEventListener('toggle',()=>{
  if(demo.open)loadAiDemo(demo);
  else if(activeAiJob?.panel===demo){
   activeAiJob.cancel();
   aiStatus(demo,'Đã dừng phân tích.');
  }
 });
 $('#ai-demo-sample').addEventListener('change',()=>selectAiDemoSample(demo));
 $('#ai-demo-retry').addEventListener('click',()=>loadAiDemo(demo));
 demo.querySelector('[data-ai-run]').addEventListener('click',()=>analyzeAiPhoto(demo,demo.querySelector('.ai-photo img').getAttribute('src')));
 demo.querySelector('[data-ai-cancel]').addEventListener('click',()=>cancelAiPanel(demo));
 $('#image-dialog').addEventListener('close',()=>{
  if(activeAiJob?.panel===$('#image-detail'))activeAiJob.cancel();
 });
}
for(const [id,delta] of [['image-prev',-12],['image-next',12]])$('#'+id).addEventListener('click',()=>{state.imageOffset=Math.max(0,state.imageOffset+delta);loadImages().catch(e=>toast(e.message,true));});
for(const [id,delta] of [['alert-prev',-20],['alert-next',20]])$('#'+id).addEventListener('click',()=>{state.alertOffset=Math.max(0,state.alertOffset+delta);loadAlerts().catch(e=>toast(e.message,true));});
$('#image-device').addEventListener('change',()=>{state.imageOffset=0;loadImages().catch(e=>toast(e.message,true));});
$('#image-trash-toggle').addEventListener('click',event=>action(event.currentTarget,async()=>{
 setImageTrashView(!state.imageTrash);
 await loadImages();
}));
$('#simulation-form').addEventListener('submit',e=>{e.preventDefault();const f=e.target.elements;action(e.submitter,async()=>{const body={scenario:f.scenario.value,running:f.running.checked,interval_seconds:Number(f.interval_seconds.value),camera_seconds:Number(f.camera_seconds.value),external_devices:state.data?.simulation.external_devices||[],offline_devices:$$('input[name=offline]:checked').map(c=>c.value)};await api('/api/simulation',{method:'PUT',body});await refresh();toast('Đã áp dụng kịch bản. Dữ liệu mới đang được gửi qua MQTT.');});});
$('#capture-form').addEventListener('submit',e=>{e.preventDefault();action(e.submitter,async()=>{await api('/api/captures',{method:'POST',body:{device_id:e.target.elements.device_id.value,count:Number(e.target.elements.count.value)}});state.imageOffset=0;await loadImages();toast('Đã tạo ảnh. Bộ xử lý đang nhận diện các hình tổng hợp.');});});
$('#capture-result').addEventListener('click',e=>action(e.currentTarget,()=>openImage(e.currentTarget.dataset.imageId)));
$('#capture-button').addEventListener('click',e=>action(e.currentTarget,async()=>{
 if(cloudMode){
  if(canManageDashboard())await captureCloudImage();
  return;
 }
 const device=$('#image-device').value||'station-001';
 if((state.data?.simulation.external_devices||[]).includes(device)){
  const request=await api('/api/camera/requests',{method:'POST',body:{device_id:device,test_mode:true}});
  toast('Đang chờ camera thật. Chụp thử cho phép lúc sáng, vẫn chặn khi có mưa.');
  const deadline=Date.now()+125000;
  while(Date.now()<deadline){
   await new Promise(resolve=>setTimeout(resolve,1500));
   const result=await api('/api/camera/requests/'+request.id);
   if(result.status==='failed')throw new Error('Camera: '+result.error);
   if(result.status==='succeeded'){
    state.imageOffset=0;
    await loadImages();
    await openImage(result.image_id);
    toast('Đã nhận và lưu ảnh thật từ ESP32-CAM.');
    return;
   }
 }
 throw new Error('Chưa nhận được ảnh. Kiểm tra firmware camera và gateway COM5.');
}
 await api('/api/captures',{method:'POST',body:{device_id:device,count:state.data?.simulation.scenario==='pests'?9:2}});
 state.imageOffset=0;
 await loadImages();
 toast('Đã chụp ảnh mô phỏng.');
}));
$('#choose-image').addEventListener('click',()=>$('#image-upload').click());
$('#image-upload').addEventListener('change',e=>action(null,()=>chooseUpload(e.target.files[0])));
$('#clear-upload').addEventListener('click',clearUpload);
$('#ai-upload [data-ai-run]').addEventListener('click',()=>analyzeAiPhoto($('#ai-upload'),uploadFile));
$('#ai-upload [data-ai-cancel]').addEventListener('click',()=>cancelAiPanel($('#ai-upload')));
$('#save-upload').addEventListener('click',async()=>{
 await action($('#save-upload'),saveUpload);
 $('#save-upload').disabled=uploadSavedVersion===uploadVersion;
});
$('#device-form').addEventListener('submit',e=>{e.preventDefault();action(e.submitter,async()=>{const f=e.target.elements;await api(`/api/devices/${f.id.value}`,{method:'PUT',body:{name:f.name.value,latitude:Number(f.latitude.value),longitude:Number(f.longitude.value),enabled:f.enabled.checked}});$('#device-dialog').close();await refresh();toast('Đã lưu trạm.');});});
$('#rule-forms').addEventListener('submit',event=>{
 event.preventDefault();const rule=state.rules.find(r=>r.id===event.target.dataset.id);if(!rule)return;
 action(event.submitter,async()=>{
  const f=event.target.elements,parameters={};
  if(rule.id==='pest_image'){
   parameters.species_thresholds=Object.fromEntries(Object.keys(window.FruitHealth.pestAlertSpecies).map(code=>{
    const selected=event.target.querySelector(`[data-pest-species="${code}"]`).checked;
    return [code,selected?Number(f[`threshold_${code}`].value):null];
   }));
   if(!Object.values(parameters.species_thresholds).some(n=>n!==null))throw new Error('Chọn ít nhất một loài để cảnh báo.');
  }else for(const key of Object.keys(rule.parameters))parameters[key]=(key==='dry_raw'||key==='wet_raw')&&f[key].value===''?null:Number(f[key].value);
  await api('/api/rules/'+rule.id,{method:'PUT',body:{crop_id:rule.crop_id,revision:rule.revision,enabled:f.enabled.checked,parameters}});
  await loadRules();await loadPlantHealth();toast('Đã lưu thiết lập cảnh báo.');
 });
});
$('#rule-forms').addEventListener('change',event=>{
 if(event.target.matches('[data-pest-species]')){
  const input=document.getElementById(event.target.getAttribute('aria-controls'));
  input.disabled=!event.target.checked;input.required=event.target.checked;return;
 }
 if(event.target.id!=='observation-crop')return;
 action(event.target,async()=>{try{await api('/api/rules/profile',{method:'PUT',body:{crop_id:event.target.value,revision:state.observationConfig.profile_revision}});}
  finally{await loadRules();await loadPlantHealth();}});
});
$('#rule-forms').addEventListener('click',event=>{
 const button=event.target.closest('[data-soil-reference]');if(!button)return;
 const station=state.data?.devices[0],raw=station?.soil_raw;
 if(!station?.online||!Number.isInteger(raw)||raw<20||raw>4075){toast('Cần số đo đất mới, ổn định và không chạm biên ADC để lấy mốc.',true);return;}
 const form=button.closest('form');form.elements[button.dataset.soilReference].value=raw;
 toast('Đã lấy mốc ADC. Kiểm tra đúng mẫu đất tham chiếu rồi bấm Lưu.');
});
async function loadNotifications(){const rows=await api('/api/notifications');$('#notification-list').innerHTML=rows.map(n=>`<div class="notification ${n.read_at?'':'unread'}">${esc(alertSummary(n.message))}<small>${date(n.created_at)} · ${n.read_at?'Đã đọc':'Chưa đọc'}</small></div>`).join('')||'<div class="empty">Chưa có thông báo.</div>';}
$('#notifications-button').addEventListener('click',()=>action(null,async()=>{await loadNotifications();$('#notifications-dialog').showModal();}));
$('#read-all').addEventListener('click',e=>action(e.currentTarget,async()=>{await api('/api/notifications/read',{method:'POST'});await loadNotifications();await refresh();}));
$('#refresh-registrations').addEventListener('click',loadRegistrations);
$('#registration-rows').addEventListener('click',event=>{
 const button=event.target.closest('[data-approve]');
 if(!button)return;
 const username=button.dataset.approve;
 action(button,async()=>{
  await api(`/api/admin/registrations/${encodeURIComponent(username)}/approve`,{method:'POST'});
  button.closest('li').remove();
  toast(`Đã duyệt tài khoản ${username}.`);
  await loadRegistrations();
  if(state.page==='accounts'&&document.activeElement===document.body)$('#refresh-registrations').focus();
 });
});
$$('.dialog-close').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
const imageDialog=$('#image-dialog');
let imageBackdropPressed=false;
function outsideImageDialog(event){
 const box=imageDialog.getBoundingClientRect();
 return event.target===imageDialog&&(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom);
}
imageDialog.addEventListener('pointerdown',event=>{imageBackdropPressed=event.button===0&&outsideImageDialog(event);});
imageDialog.addEventListener('click',event=>{
 if(imageBackdropPressed&&outsideImageDialog(event))imageDialog.close();
 imageBackdropPressed=false;
});
imageDialog.addEventListener('close',()=>{
 imageBackdropPressed=false;
 if(activeAiJob?.panel===$('#image-detail'))activeAiJob.cancel();
});
async function boot(){
 await route();
 if(cloudMode){await refresh();return;}
 try{await api('/api/session',{method:'POST'});await refresh();await route();connectSocket();}
 catch(e){showError('Chưa kết nối được dịch vụ. '+e.message);setTimeout(boot,5000);}
}
if(cloudMode)configureCloudUi();
else $('#capture-button').hidden=false;
boot();
setInterval(()=>{if((cloudMode||state.data)&&!document.hidden)refresh();},cloudMode?15000:10000);
