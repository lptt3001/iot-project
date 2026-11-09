import {persistAnalysisResult,validateResult} from './automation.js';
export class PhotoAnalysisError extends Error{constructor(status,message){super(message);this.status=status;}}
export function jpegDimensions(bytes){
  if(!bytes||bytes[0]!==255||bytes[1]!==216)return null;
  let at=2;
  while(at+4<bytes.length){
    if(bytes[at++]!==255)continue;
    while(bytes[at]===255)at++;
    const marker=bytes[at++];
    if(marker===0xda||marker===0xd9)break;
    if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
    const size=bytes[at]*256+bytes[at+1];if(size<2||at+size>bytes.length)return null;
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
      if(size<8)return null;
      return {height:bytes[at+3]*256+bytes[at+4],width:bytes[at+5]*256+bytes[at+6]};
    }
    at+=size;
  }
  return null;
}
async function currentModel(env){
  const response=await env.ASSETS.fetch(new URL('/ai/model.json',env.APP_ORIGIN));
  if(!response.ok)throw new PhotoAnalysisError(503,'Chưa đọc được cấu hình AI.');
  return response.json();
}
export async function claimPhotoAnalysis(env,id,now=Date.now(),reanalyze=false){
  const row=await env.DB.prepare(`SELECT i.received_at,i.jpeg,a.status,a.result,a.next_attempt_at FROM images i
    LEFT JOIN image_analysis a USING(image_id) WHERE i.image_id=? AND i.deleted_at IS NULL`).bind(id).first();
  if(!row)throw new PhotoAnalysisError(404,'Ảnh không còn trong thư viện.');
  const model=await currentModel(env);
  if(!reanalyze&&row.status==='succeeded'&&row.result&&JSON.parse(row.result).model_version===model.model_version)
    return {already_completed:true,result:JSON.parse(row.result)};
  const dimensions=jpegDimensions(Uint8Array.from(row.jpeg));
  if(!dimensions)throw new PhotoAnalysisError(422,'Không đọc được kích thước JPEG đã lưu.');
  const token=crypto.randomUUID(),until=now+240000;
  const saved=await env.DB.prepare(`INSERT INTO image_analysis(image_id,created_at,next_attempt_at,status,lease_token)
    VALUES(?,?,?,'running',?) ON CONFLICT(image_id) DO UPDATE SET status='running',lease_token=excluded.lease_token,
      next_attempt_at=excluded.next_attempt_at,attempts=0,error_message=NULL
    WHERE image_analysis.status!='running' OR image_analysis.next_attempt_at<=? RETURNING image_id`)
    .bind(id,now,until,token,now).first();
  if(!saved)throw new PhotoAnalysisError(409,'Ảnh đang được xử lý ở phiên khác.');
  return {lease_token:token,expires_at:until,model_version:model.model_version,...dimensions};
}
export async function completePhotoAnalysis(env,id,body,account,now=Date.now()){
  if(!body||typeof body.lease_token!=='string'||!body.result)throw new PhotoAnalysisError(422,'Thiếu kết quả AI hoặc mã phiên xử lý.');
  const job=await env.DB.prepare(`SELECT a.image_id,a.lease_token,i.received_at,i.jpeg FROM image_analysis a JOIN images i USING(image_id)
    WHERE a.image_id=? AND a.lease_token=? AND a.status='running' AND a.next_attempt_at>? AND i.deleted_at IS NULL`)
    .bind(id,body.lease_token,now).first();
  if(!job)throw new PhotoAnalysisError(409,'Phiên xử lý đã hết hạn hoặc ảnh đã thay đổi.');
  let result;try{result=validateResult(body.result);}catch{throw new PhotoAnalysisError(422,'Kết quả AI không hợp lệ.');}
  const model=await currentModel(env),dimensions=jpegDimensions(Uint8Array.from(job.jpeg));
  if(result.model_version!==model.model_version||result.width!==dimensions?.width||result.height!==dimensions?.height)
    throw new PhotoAnalysisError(422,'Kết quả không khớp ảnh hoặc model hiện tại. Hãy phân tích lại.');
  const saved=await persistAnalysisResult(env,job,result,'browser',account.username,now);
  return {saved:true,result:saved};
}
export async function failPhotoAnalysis(env,id,body){
  if(typeof body?.lease_token!=='string')throw new PhotoAnalysisError(422,'Thiếu mã phiên xử lý.');
  await env.DB.prepare(`UPDATE image_analysis SET status='failed',lease_token=NULL,next_attempt_at=?,
    error_message='Phân tích trên trình duyệt bị ngắt. Có thể mở ảnh để thử lại.'
    WHERE image_id=? AND lease_token=? AND status='running'`).bind(Date.now()+30000,id,body.lease_token).run();
  return {ok:true};
}
