(function (scope) {
  'use strict';
  const classes = ['Cnaphalocrocis_medinalis','Plutella_xylostella','Ostrinia_furnacalis',
    'Scotinophara_coarctata','Conogethes_punctiferalis','Diaphania_indica'];
  function area(box) { return Math.max(0,box.x2-box.x1)*Math.max(0,box.y2-box.y1); }
  function intersection(a,b) { return Math.max(0,Math.min(a.x2,b.x2)-Math.max(a.x1,b.x1))*Math.max(0,Math.min(a.y2,b.y2)-Math.max(a.y1,b.y1)); }
  function iou(a,b) { const n=intersection(a,b); return n/Math.max(1e-9,area(a)+area(b)-n); }
  function sameObject(a,b) {
    if(iou(a,b)>=.45)return true;
    const coverage=intersection(a,b)/Math.max(1e-9,Math.min(area(a),area(b)));
    const distance=Math.hypot((a.x1+a.x2-b.x1-b.x2)/2,(a.y1+a.y2-b.y1-b.y2)/2);
    const diagonal=Math.max(Math.hypot(a.x2-a.x1,a.y2-a.y1),Math.hypot(b.x2-b.x1,b.y2-b.y1));
    return coverage>=.85&&distance<=diagonal*.25;
  }
  function nms(boxes,threshold=.45,classAware=false,max=300) {
    const kept=[];
    for(const box of [...boxes].sort((a,b)=>b.confidence-a.confidence)){
      if(kept.some(other=>(!classAware||box.classIndex===other.classIndex)&&iou(box,other)>=threshold))continue;
      kept.push(box);if(kept.length>=max)break;
    }
    return kept;
  }
  function makeTiles(width,height,size=320){
    const starts=length=>{
      if(length<=size)return [0];
      const step=size/2, end=length-size, values=[];
      for(let p=0;p<=end;p+=step)values.push(p);
      if(values.at(-1)!==end){
        if(values.length>1&&end-values.at(-1)<step/2)values[values.length-1]=end;
        else values.push(end);
      }
      return values;
    };
    const result=[{x:0,y:0,width,height,full:true}];
    if(width>size||height>size)for(const y of starts(height))for(const x of starts(width)){
      result.push({x,y,width:Math.min(size,width-x),height:Math.min(size,height-y),full:false});
    }
    return result;
  }
  function decode(output,tile,transform,classCount,minConfidence,frame){
    const rows=output?.dims?.[2];
    if(output.dims.length!==3||output.dims[0]!==1||output.dims[1]!==4+classCount||![8400,34000].includes(rows))throw Error('Unexpected model output');
    const boxes=[],d=output.data;
    for(let row=0;row<rows;row++){
      let best=-1,second=0,classIndex=-1;
      for(let c=0;c<classCount;c++){
        const value=d[(4+c)*rows+row];
        if(value>best){second=best;best=value;classIndex=c;}else if(value>second)second=value;
      }
      if(!Number.isFinite(best)||best<minConfidence||best>1)continue;
      const cx=(d[row]-transform.left)/transform.ratio;
      const cy=(d[rows+row]-transform.top)/transform.ratio;
      const w=d[2*rows+row]/transform.ratio,h=d[3*rows+row]/transform.ratio;
      if(![cx,cy,w,h].every(Number.isFinite)||w<=0||h<=0||cx<0||cy<0||cx>=tile.width||cy>=tile.height)continue;
      const x1=Math.max(0,cx-w/2),y1=Math.max(0,cy-h/2),x2=Math.min(tile.width,cx+w/2),y2=Math.min(tile.height,cy+h/2);
      if(x2-x1<1||y2-y1<1)continue;
      const edge=!tile.full&&((tile.x>0&&x1<=3)||(tile.y>0&&y1<=3)||
        (tile.x+tile.width<frame.width&&x2>=tile.width-3)||(tile.y+tile.height<frame.height&&y2>=tile.height-3));
      boxes.push({classIndex,confidence:best,margin:best-Math.max(0,second),x1:x1+tile.x,y1:y1+tile.y,x2:x2+tile.x,y2:y2+tile.y,edge});
    }
    return nms(boxes,.7,true).filter(b=>!b.edge);
  }
  function fuse(insects,species,width,height,{speciesThreshold=.7,margin=.15,max=300}={}){
    const generic=nms(insects,.45,false,1200);
    const identified=nms(species.filter(s=>s.confidence>=speciesThreshold&&s.margin>=margin),.45,false,1200);
    const objects=[];
    for(const box of generic){
      const match=identified.find(candidate=>sameObject(box,candidate));
      objects.push({...box,kind:match?'identified':'unknown',species:match?.classIndex??null,
        speciesConfidence:match?.confidence??null,confidence:Math.max(box.confidence,match?.confidence??0)});
    }
    for(const box of identified)if(!objects.some(other=>sameObject(box,other))){
      objects.push({...box,kind:'identified',species:box.classIndex,speciesConfidence:box.confidence});
    }
    const kept=[];
    for(const object of objects.sort((a,b)=>b.confidence-a.confidence)){
      const duplicate=kept.find(other=>sameObject(object,other));
      if(duplicate){
        if(duplicate.kind==='unknown'&&object.kind==='identified')Object.assign(duplicate,{kind:object.kind,species:object.species,speciesConfidence:object.speciesConfidence});
      }else kept.push(object);
    }
    const detections=kept.slice(0,max).map(box=>({pest_code:box.kind==='identified'?classes[box.species]:'unknown',
      identification_status:box.kind,confidence:box.speciesConfidence??box.confidence,
      detection_confidence:box.confidence,species_confidence:box.speciesConfidence,
      x_min:Math.max(0,box.x1/width),y_min:Math.max(0,box.y1/height),
      x_max:Math.min(1,box.x2/width),y_max:Math.min(1,box.y2/height)}));
    return {detections,truncated:kept.length>max,
      total_count:detections.length,identified_count:detections.filter(d=>d.identification_status==='identified').length,
      unknown_count:detections.filter(d=>d.identification_status==='unknown').length};
  }
  const api={classes,area,iou,sameObject,nms,makeTiles,decode,fuse};
  if(typeof module==='object'&&module.exports)module.exports=api;else scope.TrapCore=api;
})(typeof self==='object'?self:globalThis);
