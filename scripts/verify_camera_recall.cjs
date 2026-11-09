// Run the exported camera-adapted detector using the actual web WASM runtime.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
async function main(){
 const work=process.argv[2],expected=JSON.parse(fs.readFileSync(path.join(work,'onnx-parity.json'),'utf8'));
 const ort=require(path.join(process.env.LOCALAPPDATA,'PTIT-Garden-AI/onnx-web/package/dist/ort.wasm.min.js'));
 ort.env.wasm.numThreads=1;
 const bytes=fs.readFileSync(path.join(work,'web-input.f32'));
 const tensor=new ort.Tensor('float32',new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)),[1,3,640,640]);
 const session=await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(expected.onnx)),{executionProviders:['wasm']});
 const started=performance.now(),outputs=await session.run({[session.inputNames[0]]:tensor}),output=outputs[session.outputNames[0]];
 assert.deepEqual(output.dims,[1,5,34000]);let maxScore=0;
 for(let i=4*34000;i<output.data.length;i++)maxScore=Math.max(maxScore,output.data[i]);
 assert(Math.abs(maxScore-expected.max_score)<.002,'Web/native scores disagree');
 const report={runtime:'ONNX Runtime Web 1.22 WASM, one thread',dims:output.dims,max_score:maxScore,expected_max_score:expected.max_score,inference_ms:performance.now()-started};
 output.dispose();tensor.dispose();await session.release();
 fs.writeFileSync(path.join(work,'onnx-web-verification.json'),JSON.stringify(report,null,2)+'\n');console.log('PASS',JSON.stringify(report));
}
main().catch(e=>{console.error(e);process.exitCode=1});
