// Test the actual ONNX Runtime Web 1.22 WASM backend, without a browser UI.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {performance} = require('node:perf_hooks');

async function main() {
  const work = path.resolve(process.argv[2]);
  const repository = path.resolve(__dirname, '..');
  const runtime = path.join(process.env.LOCALAPPDATA, 'PTIT-Garden-AI', 'onnx-web', 'package', 'dist');
  const ort = require(path.join(runtime, 'ort.wasm.min.js'));
  ort.env.wasm.numThreads = 1;
  const inputBytes = fs.readFileSync(path.join(work, 'web-input.f32'));
  const input = new Float32Array(inputBytes.buffer.slice(inputBytes.byteOffset, inputBytes.byteOffset + inputBytes.byteLength));
  const parity = JSON.parse(fs.readFileSync(path.join(work, 'onnx-parity.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(path.join(work, 'web-expected.json'), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(path.join(repository, 'infra/cloudflare/ai/model.json'), 'utf8'));
  const models = [
    ['v1', path.join(repository, 'infra/cloudflare/ai', baseline.insect_model)],
    ['p2_improved', parity.onnx],
  ];
  const report = {runtime: 'ONNX Runtime Web 1.22.0 WASM in Node; one thread',
    scope: 'One 640x640 input, not full tiled browser pipeline latency', models: {}};
  for (const [label, file] of models) {
    const start = performance.now();
    const session = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(file)), {executionProviders: ['wasm']});
    const loadMs = performance.now() - start;
    const tensor = new ort.Tensor('float32', input, [1, 3, 640, 640]);
    let output;
    const times = [], warmup = [];
    for (let index = 0; index < 12; index++) {
      const tick = performance.now();
      const outputs = await session.run({[session.inputNames[0]]: tensor});
      output?.dispose(); output = outputs[session.outputNames[0]];
      (index < 4 ? warmup : times).push(performance.now() - tick);
    }
    assert.deepEqual(output.dims, [1, 5, label === 'v1' ? 8400 : 34000]);
    let maxScore = 0;
    for (let i = 4 * output.dims[2]; i < output.data.length; i++) maxScore = Math.max(maxScore, output.data[i]);
    if (label === 'p2_improved') assert(Math.abs(maxScore - expected.max_score) < .002, 'WASM/native score mismatch');
    report.models[label] = {dims: output.dims, max_score: maxScore, load_ms: loadMs,
      warmup_ms: warmup, inference_ms: times,
      median_inference_ms: [...times].sort((a,b)=>a-b).slice(3,5).reduce((a,b)=>a+b)/2};
    output.dispose(); tensor.dispose(); await session.release();
    console.log('PASS', label, JSON.stringify(report.models[label]));
  }
  fs.writeFileSync(path.join(work, 'onnx-web-verification.json'), JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
