// Apply the production JavaScript fusion to debug images, with no species guessed.
const fs=require('node:fs'),path=require('node:path');
const Core=require('../infra/cloudflare/ai/insect-core.js');
const work=process.argv[2];
const read=name=>JSON.parse(fs.readFileSync(path.join(work,name),'utf8'));
const baseline=read('probe-baseline.json'),selected=read('probe-selected.json'),choice=read('selection-before-test.json');
function fuse(row,threshold){
 const boxes=row.boxes.filter(b=>b.confidence>=threshold).map(b=>({x1:b.xyxy[0],y1:b.xyxy[1],x2:b.xyxy[2],y2:b.xyxy[3],confidence:b.confidence,classIndex:0,margin:1}));
 return Core.fuse(boxes,[],row.width,row.height);
}
const report={threshold:choice.threshold,note:'Four debug photographs of two screen scenes, not independently labelled evaluation; generic detection only.',images:selected.rows.map(row=>{
 const old=baseline.rows.find(r=>r.id===row.id&&r.limit===960&&r.gamma===1);
 return {id:row.id,width:row.width,height:row.height,old_at_0525:fuse(old,.525).total_count,baseline_at_new_threshold:fuse(old,choice.threshold).total_count,...fuse(row,choice.threshold)};
})};
fs.writeFileSync(path.join(work,'user-photo-comparison.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.images.map(({id,old_at_0525,baseline_at_new_threshold,total_count})=>({id,old_at_0525,baseline_at_new_threshold,total_count}))));
