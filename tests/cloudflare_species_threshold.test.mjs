import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('current species operating point names a 55%/12-point candidate and retains weak or ambiguous insects as unknown',()=>{
 const scope={};runInNewContext(readFileSync(new URL('../infra/cloudflare/ai/insect-core.js',import.meta.url),'utf8'),{self:scope});
 const config=JSON.parse(readFileSync(new URL('../infra/cloudflare/ai/model.json',import.meta.url),'utf8'));
 const generic={classIndex:0,confidence:.2,x1:10,y1:10,x2:40,y2:40};
 const species={...generic,classIndex:1,confidence:.55,margin:.12};
 const infer=(candidate,settings)=>scope.TrapCore.fuse([generic],[candidate],100,100,settings);
 assert.equal(infer(species,{speciesThreshold:.7,margin:.15}).identified_count,0);
 const settings={speciesThreshold:config.species_threshold,margin:config.species_margin};
 assert.equal(infer(species,settings).detections[0].pest_code,'Plutella_xylostella');
 assert.equal(infer({...species,confidence:.499},settings).unknown_count,1);
 assert.equal(infer({...species,margin:.099},settings).unknown_count,1);
});
