'use strict';
const AI_ROOT=new URL('/static/ai/',self.location.origin);
const ORT_ROOT=new URL('ort-1.22.0/',AI_ROOT);
importScripts(new URL('insect-core.js',AI_ROOT).href);
const Core=self.TrapCore;
let modelPromise,busy=false;
class InferenceError extends Error {}
async function asset(url,limit){
  const response=await fetch(url,{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(60000)});
  if(response.status===401||response.status===403)throw new InferenceError('Phiên đăng nhập đã hết. Bạn đăng nhập lại để phân tích ảnh.');
  if(!response.ok||Number(response.headers.get('content-length'))>limit)throw new InferenceError('Chưa tải được model AI. Bạn thử lại.');
  const bytes=await response.arrayBuffer();
  if(!bytes.byteLength||bytes.byteLength>limit)throw new InferenceError('Tệp model không hợp lệ.');
  return bytes;
}
async function models(){
  const config=JSON.parse(new TextDecoder().decode(await asset(new URL('model.json',AI_ROOT),32768)));
  const validFile=value=>typeof value==='string'&&/^model-[a-f0-9]{12}\.onnx$/.test(value);
  if(!validFile(config.insect_model)||!validFile(config.species_model)||
    !Number.isFinite(config.insect_threshold)||config.insect_threshold<.05||config.insect_threshold>.95||
    config.species_threshold!==.7||config.classes?.join('|')!==Core.classes.join('|')){
    throw new InferenceError('Cấu hình AI không hợp lệ.');
  }
  importScripts(new URL('ort.wasm.min.js',ORT_ROOT).href);
  self.ort.env.wasm.wasmPaths=ORT_ROOT.href;
  self.ort.env.wasm.numThreads=1;self.ort.env.wasm.proxy=false;self.ort.env.wasm.initTimeout=60000;
  const bytes=await Promise.all([asset(new URL(config.insect_model,AI_ROOT),25*1024**2),asset(new URL(config.species_model,AI_ROOT),25*1024**2)]);
  const sessions=[];
  try{
    for(const data of bytes)sessions.push(await self.ort.InferenceSession.create(data,{executionProviders:['wasm']}));
  }catch(error){for(const session of sessions)await session.release();throw error;}
  return {config,sessions};
}
async function imageFor(data){
  let blob;
  if(data.file instanceof Blob){
    if(!['image/jpeg','image/png','image/webp'].includes(data.file.type)||data.file.size>12*1024**2)throw new InferenceError('Chọn ảnh JPG, PNG hoặc WebP tối đa 12 MB.');
    blob=data.file;
  }else{
    let url;try{url=new URL(data.imageUrl,self.location.origin);}catch{}
    if(!url||url.origin!==self.location.origin||url.username||url.password||
      !(/^\/media\/[a-f0-9-]{36}$/i.test(url.pathname)||/^\/static\/ai\/demo\/[a-z0-9_-]+\.jpg$/i.test(url.pathname))){
      throw new InferenceError('Đường dẫn ảnh không hợp lệ.');
    }
    blob=new Blob([await asset(url,8*1024**2)]);
  }
  let bitmap;
  try{bitmap=await createImageBitmap(blob);}catch{throw new InferenceError('Không đọc được ảnh. Hãy chọn tệp ảnh hợp lệ.');}
  const original={width:bitmap.width,height:bitmap.height};
  if(bitmap.width*bitmap.height>16_000_000){bitmap.close();throw new InferenceError('Ảnh quá lớn. Hãy dùng ảnh dưới 16 megapixel.');}
  if(Math.max(bitmap.width,bitmap.height)>960){
    const ratio=960/Math.max(bitmap.width,bitmap.height);
    const resized=await createImageBitmap(bitmap,{resizeWidth:Math.round(bitmap.width*ratio),resizeHeight:Math.round(bitmap.height*ratio),resizeQuality:'high'});
    bitmap.close();bitmap=resized;
  }
  return {bitmap,original};
}
function inputFor(context,image,tile){
  const ratio=Math.min(640/tile.width,640/tile.height);
  const width=Math.round(tile.width*ratio),height=Math.round(tile.height*ratio);
  const left=Math.floor((640-width)/2),top=Math.floor((640-height)/2);
  context.fillStyle='rgb(114,114,114)';context.fillRect(0,0,640,640);
  context.drawImage(image,tile.x,tile.y,tile.width,tile.height,left,top,width,height);
  const pixels=context.getImageData(0,0,640,640).data,plane=640*640,input=new Float32Array(plane*3);
  for(let i=0;i<plane;i++){
    input[i]=pixels[i*4]/255;input[i+plane]=pixels[i*4+1]/255;input[i+plane*2]=pixels[i*4+2]/255;
  }
  return {input,ratio,left,top};
}
self.addEventListener('message',async({data})=>{
  if(!data||!Number.isSafeInteger(data.id))return;
  const id=data.id;
  if(busy){self.postMessage({id,type:'error',message:'Đang phân tích ảnh khác.'});return;}
  busy=true;let image;
  try{
    self.postMessage({id,type:'progress',stage:'loading'});
    image=await imageFor(data);
    modelPromise??=models().catch(error=>{modelPromise=null;throw error;});
    const {config,sessions}=await modelPromise;
    const canvas=new OffscreenCanvas(640,640),context=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
    if(!context)throw new InferenceError('Trình duyệt chưa hỗ trợ xử lý ảnh. Hãy thử Chrome hoặc Edge.');
    context.imageSmoothingQuality='low';
    const tiles=Core.makeTiles(image.bitmap.width,image.bitmap.height),sets=[[],[]];let completed=0;
    for(const tile of tiles){
      const transform=inputFor(context,image.bitmap,tile);
      for(let index=0;index<2;index++){
        self.postMessage({id,type:'progress',stage:'running',completed,total:tiles.length*2});
        const tensor=new self.ort.Tensor('float32',transform.input,[1,3,640,640]);let output;
        try{
          const session=sessions[index],outputs=await session.run({[session.inputNames[0]]:tensor});output=outputs[session.outputNames[0]];
          sets[index].push(...Core.decode(output,tile,transform,index===0?1:6,index===0?config.insect_threshold:.7,image.bitmap));
        }finally{output?.dispose();tensor.dispose();}
        completed++;
      }
    }
    const result=Core.fuse(sets[0],sets[1],image.bitmap.width,image.bitmap.height,{speciesThreshold:.7,margin:.15});
    self.postMessage({id,type:'result',...image.original,...result,model_version:config.model_version,
      detection_profile:config.detection_profile??'balanced',insect_threshold:config.insect_threshold,
      resized:image.original.width!==image.bitmap.width||image.original.height!==image.bitmap.height});
  }catch(error){
    self.postMessage({id,type:'error',message:error instanceof InferenceError?error.message:'Chưa phân tích được ảnh. Bạn thử lại hoặc chọn ảnh nhỏ hơn.'});
  }finally{image?.bitmap.close();busy=false;}
});
