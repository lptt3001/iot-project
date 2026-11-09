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
const names = {overview:'Tổng quan',devices:'Trạm & cảm biến',images:'Camera & nhận diện',alerts:'Cảnh báo',simulation:'Phòng mô phỏng',settings:'Thiết lập ngưỡng',accounts:'Duyệt tài khoản'};
const species = {'sau-to':'Sâu tơ','ray-nau':'Rầy nâu','bo-tri':'Bọ trĩ'};
const aiSpecies = {whitefly:'Bọ phấn trắng',black_aphid:'Rệp đen'};
const metricNames = {temperature_c:'Nhiệt độ',air_humidity_pct:'Độ ẩm không khí',soil_moisture_pct:'Độ ẩm đất',soil_raw:'Đất (ADC)',pest_count:'Số đối tượng / ảnh'};
const state = {page:'overview',data:null,account:null,history:[],historyBucketMinutes:1,historyLoadedAt:0,metric:'temperature_c',hours:1,images:[],imageOffset:0,imageTotal:0,alertOffset:0,alertTotal:0,alertState:'all',rules:[],lastImages:-1,lastAlerts:'',imageKey:null,socket:null,refreshing:false};
const canManageDashboard = () => !cloudMode || state.account?.role === 'admin';
let toastTimer, reconnectTimer, registrationVersion=0;

function toast(message, error=false){ const el=$('#toast');el.textContent=message;el.classList.toggle('error',error);el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.hidden=true,5000); }
function showError(message){$('#error-banner').textContent=message;$('#error-banner').hidden=false;}
async function api(path,options={}){
 const headers={'X-Garden-Request':'1',...(options.headers||{})};
 if(options.body && !(options.body instanceof FormData)){headers['Content-Type']='application/json';options.body=JSON.stringify(options.body);}
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
 $$('.export').forEach(button=>button.title='CSV lấy mẫu gần nhất trong mỗi khoảng thời gian');
 $('#hero-description').textContent='Số đo và ảnh từ trạm ESP32-CAM sẽ xuất hiện tại đây.';
 $('.hero-link').href='#devices';
 $('.hero-link').firstChild.textContent='Xem trạm & cảm biến ';
 $('.sidebar .profile small').textContent='Dashboard trên Cloudflare';
 $('.chart-card .card-heading p').textContent='Mẫu gần nhất trong mỗi khoảng · UTC+7';
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
 $('#camera-note').textContent='Mở ảnh từ trạm để phân tích thử bằng AI. Model hiện nhận hai nhóm trên bẫy dính vàng: bọ phấn trắng và rệp đen.';
 $('#ai-demo').hidden=false;
 $('#led-panel').hidden=false;
 try{pendingCloudCaptureId=sessionStorage.getItem(CAPTURE_SESSION_KEY);}catch{}
 updateCaptureButton();
 $('#capture-button').title='Chụp theo yêu cầu khi trời sáng hoặc tối. Camera vẫn kiểm tra cảm biến mưa.';
 $('#page-alerts .subtitle').textContent='Cloudflare kiểm tra ngưỡng cảm biến và lưu cảnh báo tự động.';
 $('#page-settings .subtitle').textContent='Chọn ngưỡng nhiệt độ và độ ẩm không khí cho trạm đang hoạt động.';
 $('#page-settings .info-box').textContent='Cảnh báo được lưu trên Cloudflare và hiển thị trong hộp thư khu vườn.';
 $('#notifications-dialog > p').textContent='Thông báo từ các luật cảnh báo trên Cloudflare';
}

function configureCloudAccount(account){
 state.account=account;
 const canManage=canManageDashboard();
 $('[data-page="accounts"]').hidden=!canManage;
 $$('[data-dashboard-admin]').forEach(element=>element.hidden=!canManage);
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
 if(cloudMode&&canManageDashboard()){
  $('#page-settings .info-box').textContent=data.system.telegram_configured
   ?'Cảnh báo mới được lưu trong hộp thư và xếp hàng gửi qua Telegram.'
   :'Cảnh báo được lưu trong hộp thư. Telegram đang chờ cấu hình bot và chat nhận.';
 }
 const online=data.devices.filter(d=>d.online).length;
 const hardware=cloudMode||(data.simulation.external_devices||[]).length>0;
 $('.demo-note').innerHTML=cloudMode?'<span class="dot"></span> Vườn đang theo dõi<p>ESP32-CAM gửi số đo và ảnh trực tiếp lên Cloudflare.</p>':hardware?'<span class="dot"></span> Kết nối phần cứng<p>Dữ liệu thật từ ESP32-CAM qua USB. Đất hiển thị số thô khi chưa hiệu chuẩn.</p>':'<span class="dot"></span> Môi trường mô phỏng<p>Dữ liệu do các trạm ảo tạo ra.</p>';
 $('#data-source').textContent=cloudMode?'Dữ liệu ESP32-CAM · Cloudflare':hardware?'Cảm biến thật · lịch sử đang lọc phần cứng':'Dữ liệu mô phỏng';
 $('#page-devices .subtitle').textContent=hardware?'Số đo mới từ phần cứng; mất cảm biến được hiển thị bằng dấu —.':'Dữ liệu do bộ mô phỏng tạo, truyền qua MQTT thật.';
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
 $('#system-strip').innerHTML=cloudMode?'<span><span class="dot"></span>Cloudflare đang hoạt động</span><span>Số đo và ảnh lưu trên D1</span><span>Web làm mới mỗi 15 giây</span>':`<span><span class="dot"></span>MQTT TLS ${data.system.mqtt?'đã kết nối':'đang kết nối lại'}</span><span><span class="dot"></span>TimescaleDB đang hoạt động</span><span>${data.system.buffered} bản tin chờ xử lý</span><span>Chu kỳ ${data.simulation.interval_seconds} giây</span>`;
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
function alertMarkup(a,compact=false){return `<div class="alert-item"><span class="alert-symbol ${esc(a.severity)}">${icon('bell')}</span><div class="alert-content"><strong>${esc(a.title||a.message.split(':')[0])}</strong><p>${esc(a.message)}</p><small>${esc(a.device_id)} · ${date(a.triggered_at)}${a.acknowledged_at?' · Đã xác nhận':''}</small></div>${!compact&&!a.acknowledged_at&&canManageDashboard()?`<button class="button secondary ack-alert" data-id="${esc(a.id)}">Xác nhận</button>`:''}</div>`;}
async function loadAlerts(){const result=await api(`/api/alerts?offset=${state.alertOffset}&limit=20&state=${state.alertState}`);state.alertTotal=result.total;$('#alert-list').innerHTML=result.rows.map(a=>alertMarkup(a)).join('')||'<div class="empty">Không có cảnh báo trong danh sách này.</div>';$('#alert-total').textContent=`${result.total} cảnh báo`;$('#alert-page').textContent=`Trang ${Math.floor(state.alertOffset/20)+1}`;$('#alert-prev').disabled=state.alertOffset===0;$('#alert-next').disabled=state.alertOffset+20>=result.total;}
function mediaPath(id){return `/media/${encodeURIComponent(id)}${cloudMode?'':'.png'}`;}
function imagePreview(row){return `<div class="image-preview"><img src="${mediaPath(row.id)}" alt="${row.source==='simulation'?'Ảnh bẫy tổng hợp':row.source==='hardware'?'Ảnh camera':'Ảnh tải lên'} của ${esc(row.device_id)}" loading="lazy"><svg viewBox="0 0 960 600" aria-hidden="true">${(row.detections||[]).map(d=>`<rect x="${d.x_min*960}" y="${d.y_min*600}" width="${(d.x_max-d.x_min)*960}" height="${(d.y_max-d.y_min)*600}" stroke="#fcfce0" fill="none"/>`).join('')}</svg></div>`;}
async function loadImages(){
 const device=$('#image-device').value;const result=await api(`/api/images?offset=${state.imageOffset}&limit=12${device?'&device='+encodeURIComponent(device):''}`);state.images=result.rows;state.imageTotal=result.total;
 const imageKey=JSON.stringify([state.imageOffset,result.rows,result.total]);
 if(!cloudMode||state.imageKey!==imageKey){
  state.imageKey=imageKey;
  $('#image-total').textContent=`${result.total} ảnh đã lưu`;$('#image-page').textContent=`Trang ${Math.floor(state.imageOffset/12)+1}`;$('#image-prev').disabled=state.imageOffset===0;$('#image-next').disabled=state.imageOffset+12>=result.total;
  $('#image-grid').innerHTML=result.rows.map(row=>`<button class="image-card" data-id="${esc(row.id)}">${imagePreview(row)}<div class="image-info"><h3>${esc(row.device_id)}<span class="tag">${row.source==='simulation'?'Mô phỏng':row.source==='hardware'?'Camera thật':'Ảnh tải lên'}</span></h3><p>${cloudMode?'Nhận lúc ':''}${date(row.captured_at||row.received_at)}</p><p>${row.status==='succeeded'?`${row.pest_count} đối tượng · Đã xử lý`:cloudMode?'Mở ảnh để phân tích thử':row.status==='failed'?'Chưa có model thật':'Đang xử lý…'}</p></div></button>`).join('')||`<div class="empty">${cloudMode?'Đang chờ ảnh đầu tiên từ trạm.':'Chưa có ảnh. Bấm “Chụp mô phỏng” để bắt đầu.'}</div>`;
 }
 let latest=result.rows[0];if(state.imageOffset||device){const first=await api('/api/images?limit=1');latest=first.rows[0];}
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
  const query=cloudMode?`id=${encodeURIComponent(id)}`:'limit=1';
  const result=await api('/api/images?'+query);
  row=result.rows.find(r=>r.id===id);
 }
 if(!row&&cloudMode)throw new Error('Ảnh không còn trong thư viện.');
 if(!row)return;
 if(cloudMode){
  const detail=$('#image-detail');
  if(activeAiJob?.panel===detail)activeAiJob.cancel();
  const heading=`<h2>Ảnh bẫy · ${esc(row.device_id)}</h2><span class="tag">Camera thật</span>`;
  const received=`<p>Nhận lúc ${date(row.captured_at||row.received_at)}</p>`;
  if(row.status==='succeeded'){
   detail.innerHTML=`${heading}${imagePreview(row)}${received}<p>Đã phát hiện ${number(row.pest_count,0)} đối tượng.</p>`;
  }else{
   detail.innerHTML=`${heading}<figure class="ai-photo"><img src="${mediaPath(row.id)}" alt="Ảnh từ camera ${esc(row.device_id)}"><svg class="ai-overlay" aria-hidden="true" hidden></svg></figure>${received}
    <p>Model thử trên bẫy dính vàng nhận hai nhóm: bọ phấn trắng và rệp đen. Cần đối chiếu kết quả trên ảnh thực địa.</p>
    <button class="button secondary" type="button" data-ai-run>Phân tích ảnh này</button><p class="ai-status" role="status"></p><div class="ai-result" hidden></div>`;
   detail.querySelector('[data-ai-run]').addEventListener('click',()=>analyzeAiPhoto(detail,mediaPath(row.id)));
  }
 }else{
  $('#image-detail').innerHTML=`<h2>${esc(row.device_id)} · ${date(row.captured_at)}</h2><span class="tag">${row.source==='simulation'?'Ảnh bẫy tổng hợp':'Ảnh tải lên'}</span>${imagePreview(row)}<p>Trạng thái: ${esc(row.status)} · Bộ xử lý: ${esc(row.model_version)}</p>${row.error_message?`<div class="info-box">${esc(row.error_message)}</div>`:''}<div class="detections">${Object.entries(species).map(([code,name])=>`<span class="tag">${name}: ${row.detections.filter(d=>d.pest_code===code).length}</span>`).join('')}</div><p>${row.source==='simulation'?'Các nhãn và khung được xác định từ màu của hình tổng hợp; không phải xác suất hay độ chính xác của model sâu bệnh thực tế.':'Ảnh đã được lưu an toàn. Chưa thực hiện nhận diện sâu bệnh.'}</p>`;
 }
 $('#image-dialog').showModal();
}

let aiWorker, activeAiJob, aiRequestId=0;
let aiDemoSamples=[], aiDemoLoading=false;

function aiStatus(panel, text, error=false){
 const status=panel.querySelector('.ai-status');
 status.textContent=text;
 status.classList.toggle('error',error);
}

function resetAiResult(panel){
 panel.querySelector('.ai-overlay').setAttribute('hidden','');
 panel.querySelector('.ai-result').hidden=true;
 aiStatus(panel,'');
}

function requestAiInference(panel,imageUrl){
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
  const timer=setTimeout(()=>fail(new Error('Phân tích quá thời gian. Bạn có thể thử lại.')),90000);
  activeAiJob={panel,cancel:()=>fail(new DOMException('Đã dừng phân tích.','AbortError'))};
  worker.onmessage=({data})=>{
   if(data?.id!==id)return;
   if(data.type==='progress'){
    const regions=data.total>1?` (${data.completed||0}/${data.total} vùng ảnh)`:'';
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
  try{worker.postMessage({id,imageUrl});}catch(error){fail(error);}
 });
}

function renderAiResult(panel,{width,height,detections,model_version,truncated}){
 if(!Number.isInteger(width)||width<1||!Number.isInteger(height)||height<1||!Array.isArray(detections)){
  throw new Error('Mô hình trả về kết quả ảnh không hợp lệ.');
 }
 const counts={whitefly:0,black_aphid:0};
 const boxes=[];
 for(const detection of detections){
  const {pest_code:code,x_min,y_min,x_max,y_max}=detection;
  if(!Object.hasOwn(counts,code)||![x_min,y_min,x_max,y_max].every(n=>Number.isFinite(n)&&n>=0&&n<=1)||x_max<=x_min||y_max<=y_min)continue;
  counts[code]++;
  const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');
  const attributes={x:x_min*width,y:y_min*height,width:(x_max-x_min)*width,height:(y_max-y_min)*height,class:'ai-box','data-class':code};
  for(const [name,value] of Object.entries(attributes))rect.setAttribute(name,value);
  boxes.push(rect);
 }
 const overlay=panel.querySelector('.ai-overlay');
 overlay.setAttribute('viewBox',`0 0 ${width} ${height}`);
 overlay.setAttribute('preserveAspectRatio','none');
 overlay.replaceChildren(...boxes);
 overlay.toggleAttribute('hidden',boxes.length===0);
 const result=panel.querySelector('.ai-result');
 result.innerHTML=`<strong>AI phát hiện ${truncated?'ít nhất ':''}${boxes.length} đối tượng</strong>${Object.entries(aiSpecies).map(([code,label])=>`<span class="tag" data-class="${code}">${label} · ${counts[code]}</span>`).join('')}${model_version?`<small>Model ${esc(model_version)}</small>`:''}`;
 result.hidden=false;
}

async function analyzeAiPhoto(panel,imageUrl){
 if(!imageUrl)return;
 const button=panel.querySelector('[data-ai-run]');
 if(button.disabled)return;
 button.disabled=true;
 resetAiResult(panel);
 aiStatus(panel,'Đang chuẩn bị mô hình AI…');
 try{
  const result=await requestAiInference(panel,imageUrl);
  renderAiResult(panel,result);
  aiStatus(panel,'Đã phân tích xong.');
 }catch(error){
  if(error.name!=='AbortError')aiStatus(panel,error.message||'Chưa phân tích được ảnh.',true);
 }finally{
  button.disabled=false;
 }
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
 const reference=$('#ai-demo-reference');
 const counts=sample.ground_truth||{};
 reference.textContent='Số lượng theo nhãn tham chiếu · '+Object.entries(aiSpecies).map(([code,label])=>`${label} ${number(counts[code],0)}`).join(' · ');
 reference.hidden=false;
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
  if(typeof manifest.source?.credit==='string')$('#ai-demo-credit').textContent=' · '+manifest.source.credit;
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
  state.imageOffset=0;
  loadImages().catch(error=>toast(error.message,true));
  if(!$('#image-dialog').open)await openImage(request.image_id).catch(error=>toast(error.message,true));
 }
}
function fillSimulation(){if(!state.data)return;const form=$('#simulation-form'),s=state.data.simulation;form.elements.scenario.value=s.scenario;form.elements.interval_seconds.value=s.interval_seconds;form.elements.camera_seconds.value=s.camera_seconds;form.elements.running.checked=s.running;$$('input[name=offline]').forEach(c=>c.checked=s.offline_devices.includes(c.value));}
async function loadRules(){state.rules=await api('/api/rules');$('#rule-forms').innerHTML=state.rules.map(r=>`<article class="card rule-card"><h2>${esc(r.name)}</h2><span class="tag">${metricNames[r.metric]}</span><form class="rule-form" data-id="${r.id}"><label>Tên luật<input name="name" value="${esc(r.name)}" maxlength="100" required></label><div class="form-grid"><label>So sánh<select name="operator">${[['gte','Lớn hơn hoặc bằng ≥'],['gt','Lớn hơn >'],['lte','Nhỏ hơn hoặc bằng ≤'],['lt','Nhỏ hơn <']].map(([v,n])=>`<option value="${v}" ${r.operator===v?'selected':''}>${n}</option>`).join('')}</select></label><label>Ngưỡng<input type="number" name="threshold" step="any" min="${cloudMode&&r.metric==='air_humidity_pct'?0:-40}" max="${cloudMode&&r.metric==='air_humidity_pct'?100:125}" value="${r.threshold}" required></label></div><div class="form-grid"><label>Trung bình (phút)<input name="window_minutes" type="number" min="1" max="${cloudMode?15:1440}" value="${r.window_minutes}" ${r.metric==='pest_count'?'disabled':''} required></label><label>Khoảng nghỉ (phút)<input name="cooldown_minutes" type="number" min="1" max="1440" value="${r.cooldown_minutes}" required></label></div>${r.metric==='pest_count'?'<p class="form-note">Luật camera tính số đối tượng trên từng ảnh.</p>':''}<label class="check-row"><input type="checkbox" name="enabled" ${r.enabled?'checked':''}> Bật luật cảnh báo</label><button class="button secondary full">Lưu thiết lập</button></form></article>`).join('');}
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
  (requestedPage!=='settings'||canManageDashboard())&&
  (requestedPage!=='accounts'||(cloudMode&&canManageDashboard()));
 state.page=allowed?requestedPage:'overview';
 $$('.page').forEach(p=>p.hidden=p.id!==`page-${state.page}`);
 $$('nav a').forEach(a=>a.classList.toggle('active',a.dataset.page===state.page));
 $('#breadcrumb').textContent=names[state.page];
 if(!state.data)return;
 try{
  if(state.page==='simulation')fillSimulation();
  if(state.page==='settings')await loadRules();
  if(state.page==='accounts')await loadRegistrations();
  if(state.page==='devices'){renderDevices();await loadHistory();}
  if(state.page==='overview')await loadHistory();
  if(state.page==='images')await loadImages();
  if(state.page==='alerts')await loadAlerts();
 }catch(error){toast(error.message,true);}
}
function refreshError(error){
 return cloudMode&&error.name==='TimeoutError'?'Cloudflare phản hồi chậm. Trang sẽ tự thử tải lại.':error.message;
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
  $('#connection').innerHTML='<i></i>Đã kết nối cloud';
  const widgets=[];
  if(firstLoad)widgets.push(loadLed());
  if(historyVisible&&Date.now()-state.historyLoadedAt>=60000)widgets.push(loadHistory());
  if(imagesVisible)widgets.push(loadImages());
  if(firstLoad&&state.page==='settings')widgets.push(loadRules());
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
  ? `Chưa có xác nhận gần đây từ mạch. Lệnh đang lưu: ${wanted} đèn. Cần firmware hỗ trợ IO12 và kết nối Internet.`
  : s.pending?`Đang chờ mạch ${wanted} đèn…`
  : `Mạch đã xác nhận ${actual} đèn · ${date(s.confirmed_at)}. Chưa kiểm chứng ánh sáng thực tế.`;
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
$$('.export').forEach(b=>b.addEventListener('click',()=>{const device=state.page==='devices'?$('#history-device').value:'';window.location.assign(`/api/export.csv?hours=${state.hours}${device?'&device='+encodeURIComponent(device):''}`);toast(cloudMode?'Đang tải mẫu gần nhất trong mỗi khoảng…':'Đang tải dữ liệu CSV…');}));
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
 $('#image-dialog').addEventListener('close',()=>{
  if(activeAiJob?.panel===$('#image-detail'))activeAiJob.cancel();
 });
}
for(const [id,delta] of [['image-prev',-12],['image-next',12]])$('#'+id).addEventListener('click',()=>{state.imageOffset=Math.max(0,state.imageOffset+delta);loadImages().catch(e=>toast(e.message,true));});
for(const [id,delta] of [['alert-prev',-20],['alert-next',20]])$('#'+id).addEventListener('click',()=>{state.alertOffset=Math.max(0,state.alertOffset+delta);loadAlerts().catch(e=>toast(e.message,true));});
$('#image-device').addEventListener('change',()=>{state.imageOffset=0;loadImages().catch(e=>toast(e.message,true));});
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
$('#image-upload').addEventListener('change',e=>action(null,async()=>{const file=e.target.files[0];if(!file)return;if(file.size>8*1024*1024)throw new Error('Ảnh tối đa 8 MB.');const body=new FormData();body.append('file',file);const result=await api(`/api/images/upload?device_id=${$('#image-device').value||'station-001'}`,{method:'POST',body});e.target.value='';state.imageOffset=0;await loadImages();toast(result.message);}));
$('#device-form').addEventListener('submit',e=>{e.preventDefault();action(e.submitter,async()=>{const f=e.target.elements;await api(`/api/devices/${f.id.value}`,{method:'PUT',body:{name:f.name.value,latitude:Number(f.latitude.value),longitude:Number(f.longitude.value),enabled:f.enabled.checked}});$('#device-dialog').close();await refresh();toast('Đã lưu trạm.');});});
$('#rule-forms').addEventListener('submit',e=>{e.preventDefault();const rule=state.rules.find(r=>r.id===e.target.dataset.id);action(e.submitter,async()=>{const f=e.target.elements;await api(`/api/rules/${rule.id}`,{method:'PUT',body:{name:f.name.value,metric:rule.metric,operator:f.operator.value,threshold:Number(f.threshold.value),window_minutes:Number(f.window_minutes.value),cooldown_minutes:Number(f.cooldown_minutes.value),enabled:f.enabled.checked}});toast('Đã lưu ngưỡng cảnh báo.');});});
async function loadNotifications(){const rows=await api('/api/notifications');$('#notification-list').innerHTML=rows.map(n=>`<div class="notification ${n.read_at?'':'unread'}">${esc(n.message)}<small>${date(n.created_at)} · ${n.read_at?'Đã đọc':'Chưa đọc'}</small></div>`).join('')||'<div class="empty">Chưa có thông báo.</div>';}
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
