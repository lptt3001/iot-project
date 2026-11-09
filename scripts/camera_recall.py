"""Camera-domain adaptation using source labels, with user photos held out of training.

Run in the isolated Ultralytics environment. Work/data stay outside OneDrive.
"""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import sys
import time
import cv2
import numpy as np
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
AI=Path(os.environ['LOCALAPPDATA'])/'PTIT-Garden-AI'
BASE=AI/'p2-improved-20261109'
PHOTOS=[
    'codex-clipboard-e18f8e3c-b9c4-443c-a55f-bdf75b3be536.jpg',
    'codex-clipboard-8deb925e-ff47-4fa4-a7c8-5c38915d24c2.jpg',
    'codex-clipboard-bb3de088-b289-4753-b063-55cfe356662f.jpg',
    'codex-clipboard-d12ee712-842f-4c5e-8249-2d2a65aa41d5.jpg',
]
def dump(path,data):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def read(path):return cv2.imdecode(np.frombuffer(Path(path).read_bytes(),dtype=np.uint8),cv2.IMREAD_COLOR)
def write(path,image):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(cv2.imencode('.jpg',image,[cv2.IMWRITE_JPEG_QUALITY,90])[1].tobytes())
def degrade(image,seed):
    rng=np.random.default_rng(seed);h,w=image.shape[:2]
    value=image.astype(np.float32)/255
    value=np.power(value,float(rng.uniform(1.15,1.85)))
    yy,xx=np.mgrid[-1:1:complex(h),-1:1:complex(w)]
    vignette=np.clip(1-float(rng.uniform(.18,.48))*(xx*xx+yy*yy),.28,1)
    value*=vignette[:,:,None]
    value=cv2.GaussianBlur(value,(0,0),float(rng.uniform(.45,1.35)))
    value=np.clip(value+rng.normal(0,rng.uniform(.008,.025),value.shape),0,1)
    value=(value*255).astype(np.uint8)
    return cv2.imdecode(cv2.imencode('.jpg',value,[cv2.IMWRITE_JPEG_QUALITY,int(rng.integers(35,76))])[1],cv2.IMREAD_COLOR)
def source_rows():
    manifest=json.loads((BASE/'manifest.json').read_text(encoding='utf-8'))
    dataset=AI/'generic-insects/dataset'
    rows=[]
    for original in manifest['photos']:
        row={**original,'path':str(dataset/original['split']/'images'/original['file_name'])}
        assert Path(row['path']).is_file(),row['path'];rows.append(row)
    return rows,dataset
def prepare(args):
    rows,dataset=source_rows();records=[]
    for index,row in enumerate(rows):
        split=row['split'];path=Path(row['path']);label=dataset/split/'labels'/path.with_suffix('.txt').name
        image=read(path)
        # Original and degraded training pairs. The val/test source groups are
        # preserved, so related transformations cannot cross a split.
        modes=['clean','camera'] if split=='train' else ['camera']
        for mode in modes:
            name=f"{path.stem}_{mode}.jpg";dest=args.work/'dataset'/split/'images'/name
            write(dest,image if mode=='clean' else degrade(image,20261109+index))
            target=args.work/'dataset'/split/'labels'/Path(name).with_suffix('.txt')
            target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(label,target)
            records.append({**row,'file_name':name,'path':str(dest),'mode':mode,'source_sha256':digest(path)})
    # Retain source negative examples and a bounded selection of labelled tiles.
    extras=sorted((dataset/'train/images').glob('*.jpg'))
    full_names={r['file_name'] for r in rows if r['split']=='train'}
    extras=[p for p in extras if p.name not in full_names]
    rng=random.Random(20261109);rng.shuffle(extras)
    negatives=[p for p in extras if not (dataset/'train/labels'/p.with_suffix('.txt').name).read_text().strip()]
    chosen=negatives+ [p for p in extras if p not in negatives][:200]
    for index,path in enumerate(chosen):
        name='replay_'+path.name;dest=args.work/'dataset/train/images'/name
        write(dest,degrade(read(path),310000+index) if index%2 else read(path))
        shutil.copy2(dataset/'train/labels'/path.with_suffix('.txt').name,args.work/'dataset/train/labels'/Path(name).with_suffix('.txt'))
    groups={s:sorted({r['group'] for r in rows if r['split']==s}) for s in ['train','val','test']}
    assert all(not(set(groups[a])&set(groups[b])) for a,b in [('train','val'),('train','test'),('val','test')])
    photos=[]
    for index,name in enumerate(PHOTOS,1):
        src=Path(os.environ['TEMP'])/name;dest=args.work/'user-photos'/f'camera_{index}.jpg'
        dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dest)
        photos.append({'id':f'camera_{index}','path':str(dest),'sha256':digest(dest),'scene_group':'dense' if index in [1,4] else 'sparse'})
    dump(args.work/'manifest.json',{'rows':records,'groups':groups,'user_photos':photos,
        'training_images':len(list((args.work/'dataset/train/images').glob('*.jpg'))),
        'policy':'Source labels only; user screen-rephotographs never trained or used as numeric ground truth. Reused source test split is not independent new field data.'})
    dump(args.work/'data.yaml',{'path':str(args.work/'dataset'),'train':'train/images','val':'val/images','test':'test/images','names':{0:'insect'}})
    print('PREPARED',len(records),'paired source examples;',len(chosen),'replay/negative tiles',flush=True)
def predict(model,image,limit=960,gamma=1):
    from trap_detector import tiles
    h,w=image.shape[:2]
    if max(h,w)>limit:
        r=limit/max(h,w);image=cv2.resize(image,(round(w*r),round(h*r)),interpolation=cv2.INTER_LINEAR);h,w=image.shape[:2]
    if gamma!=1:image=np.round((image.astype(np.float32)/255)**gamma*255).astype(np.uint8)
    regions=[(0,0,w,h)]+(tiles(w,h) if w>320 or h>320 else [])
    images=[image[y1:y2,x1:x2] for x1,y1,x2,y2 in regions]
    results=model.predict(images,imgsz=640,conf=.05,iou=.7,rect=False,max_det=300,device=0,verbose=False,batch=4)
    candidates=[]
    for index,((ox,oy,ex,ey),result) in enumerate(zip(regions,results,strict=True)):
        for x1,y1,x2,y2,conf,cls in result.boxes.data.cpu().numpy():
            if index and ((ox>0 and x1<=3) or (oy>0 and y1<=3) or(ex<w and x2>=ex-ox-3)or(ey<h and y2>=ey-oy-3)):continue
            candidates.append({'class_id':int(cls),'confidence':float(conf),'xyxy':[float(x1+ox),float(y1+oy),float(x2+ox),float(y2+oy)]})
    return candidates,w,h,len(regions)
def setup_model(path):
    import torch
    from ultralytics import YOLO,settings
    torch.set_num_threads(4);settings.update({'sync':False})
    if not torch.cuda.is_available():raise RuntimeError('CUDA required; avoid a silent long CPU job')
    return YOLO(str(path))
def probe(args):
    model=setup_model(args.weights);manifest=json.loads((args.work/'manifest.json').read_text(encoding='utf-8'))
    rows=[]
    for photo in manifest['user_photos']:
        for limit,gamma in ([(960,1),(960,.7),(1280,1)] if args.name=='baseline' else [(960,1)]):
            boxes,w,h,n=predict(model,read(photo['path']),limit,gamma)
            row={'id':photo['id'],'width':w,'height':h,'views':n,'gamma':gamma,'limit':limit,'boxes':boxes}
            rows.append(row)
            print('PROBE',photo['id'],limit,gamma,'max',max((b['confidence'] for b in boxes),default=0),flush=True)
    dump(args.work/f'probe-{args.name}.json',{'weights_sha256':digest(args.weights),'rows':rows})
def train(args):
    model=setup_model(args.weights)
    model.train(data=str(args.work/'data.yaml'),epochs=args.epochs,imgsz=640,batch=8,device=0,workers=2,amp=False,
        optimizer='AdamW',lr0=.0001,lrf=.2,freeze=10,warmup_epochs=1,patience=8,
        mosaic=.1,close_mosaic=3,mixup=0,copy_paste=0,degrees=5,translate=.04,scale=.15,fliplr=.5,flipud=.2,
        hsv_h=.005,hsv_s=.15,hsv_v=.15,seed=20261109,deterministic=True,plots=False,
        project=str(args.work/'runs'),name='camera',exist_ok=False,save_period=4,cache=False)
def evaluate(args):
    from trap_detector import score
    model=setup_model(args.weights);manifest=json.loads((args.work/'manifest.json').read_text(encoding='utf-8'))
    rows=[r for r in manifest['rows'] if r['split']==args.split]
    predictions={};truth={}
    for index,row in enumerate(rows,1):
        candidates,w,h,_=predict(model,read(row['path']))
        # Same global suppression as the web generic detector, independent of species.
        if candidates:
            xywh=np.asarray([b['xyxy'] for b in candidates]);xywh[:,2:]-=xywh[:,:2]
            keep=cv2.dnn.NMSBoxes(xywh.tolist(),[b['confidence'] for b in candidates],.049,.45)
            candidates=[candidates[int(i)] for i in np.asarray(keep).reshape(-1)]
        predictions[row['file_name']]=candidates;truth[row['file_name']]=row['boxes']
        if index%25==0:print('EVALUATE',args.name,args.split,index,'/',len(rows),flush=True)
    grid=[]
    for threshold in [.075,.1,.125,.15,.2,.25,.35,.525]:
        m=score(predictions,truth,[threshold]*6)['overall'];p,r=m['precision'] or 0,m['recall'] or 0
        grid.append({'threshold':threshold,**m,'f2':5*p*r/(4*p+r) if p+r else 0,'f3':10*p*r/(9*p+r) if p+r else 0})
    dump(args.work/f'evaluation-{args.name}-{args.split}.json',{'weights_sha256':digest(args.weights),'split':args.split,'grid':grid,'predictions':predictions})
    print('METRICS',args.name,args.split,json.dumps(grid),flush=True)
def export(args):
    model=setup_model(args.weights)
    path=model.export(format='onnx',imgsz=640,batch=1,opset=17,dynamic=False,simplify=False,device='cpu',nms=False)
    import onnxruntime as ort
    import torch
    manifest=json.loads((args.work/'manifest.json').read_text(encoding='utf-8'))
    image=read(manifest['user_photos'][0]['path']);h,w=image.shape[:2]
    r=min(640/w,640/h);nw,nh=round(w*r),round(h*r)
    canvas=np.full((640,640,3),114,np.uint8);x,y=(640-nw)//2,(640-nh)//2
    canvas[y:y+nh,x:x+nw]=cv2.resize(image,(nw,nh))
    tensor=np.ascontiguousarray(canvas[:,:,::-1].transpose(2,0,1)[None],dtype=np.float32)/255
    model.model.cpu().eval()
    with torch.inference_mode():expected=model.model(torch.from_numpy(tensor))[0].numpy()
    options=ort.SessionOptions();options.intra_op_num_threads=2
    session=ort.InferenceSession(str(path),sess_options=options,providers=['CPUExecutionProvider'])
    actual=session.run(None,{session.get_inputs()[0].name:tensor})[0]
    assert actual.shape==(1,5,34000) and np.isfinite(actual).all()
    error=float(np.abs(expected[:,4:]-actual[:,4:]).max());assert error<.001
    tensor.tofile(args.work/'web-input.f32')
    dump(args.work/'onnx-parity.json',{'onnx':str(path),'sha256':digest(path),'shape':list(actual.shape),
        'pytorch_onnx_score_max_abs_error':error,'max_score':float(actual[:,4:].max())})
    print('EXPORTED',path,digest(path),flush=True)
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['prepare','probe','train','evaluate','export'])
    parser.add_argument('--work',type=Path,default=AI/'camera-recall-20261109')
    parser.add_argument('--weights',type=Path,default=BASE/'runs/p2/weights/best.pt')
    parser.add_argument('--name',default='baseline');parser.add_argument('--split',choices=['val','test'],default='val')
    parser.add_argument('--epochs',type=int,default=8)
    args=parser.parse_args();args.work=args.work.resolve();args.work.mkdir(parents=True,exist_ok=True)
    os.environ['YOLO_CONFIG_DIR']=str(args.work/'settings');os.environ['YOLO_AUTOINSTALL']='false'
    sys.stdout.reconfigure(encoding='utf-8',line_buffering=True)
    globals()[args.action](args)
if __name__=='__main__':main()
