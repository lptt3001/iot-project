const AI_ROOT = new URL('/static/ai/', self.location.origin);
const ORT_ROOT = new URL('ort-1.22.0/', AI_ROOT);
const CLASSES = ['whitefly', 'black_aphid'];
const INPUT_SIZE = 416;
const PREDICTION_ROWS = [8, 16, 32].reduce((sum, stride) => sum + (INPUT_SIZE / stride) ** 2, 0);
const ROW_WIDTH = 5 + CLASSES.length;
const MAX_CANDIDATES = 1200;
const MAX_DETECTIONS = 300;
const MAX_IMAGE_PIXELS = 16_000_000;
const CAPTURE_PATH = /^\/media\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.png)?$/i;
const EXAMPLE_PATH = /^\/static\/ai\/(?:demo\/)?[\w-]+\.jpe?g$/i;
let detectorPromise;
let busy = false;

class InferenceError extends Error {}

async function readAsset(url, byteLimit, errorMessage) {
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new InferenceError('Không có quyền đọc dữ liệu AI. Bạn thử đăng nhập lại.');
    }
    if (!response.ok || Number(response.headers.get('content-length')) > byteLimit) {
      throw new InferenceError(errorMessage);
    }
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > byteLimit) throw new InferenceError(errorMessage);
    return bytes;
  } catch (error) {
    if (error instanceof InferenceError) throw error;
    throw new InferenceError(error.name === 'TimeoutError' ? 'Tải dữ liệu AI quá lâu. Bạn thử lại.' : errorMessage);
  }
}

async function readModelConfig() {
  const errorMessage = 'Cấu hình mô hình AI chưa sẵn sàng.';
  const bytes = await readAsset(new URL('model.json', AI_ROOT), 16_384, errorMessage);
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new InferenceError(errorMessage);
  }
  const {
    model_file: modelFile = 'model.onnx', model_version: version, classes,
    channel_order: channelOrder = 'BGR', input_size: inputSize = INPUT_SIZE,
    confidence_threshold: defaultThreshold = 0.35, confidence_thresholds: classThresholds,
    iou_threshold: iouThreshold = 0.45,
  } = manifest || {};
  const confidenceThresholds = CLASSES.map(code => classThresholds?.[code] ?? defaultThreshold);
  if (typeof modelFile !== 'string' || !/^[\w-]+\.onnx$/.test(modelFile) ||
      typeof version !== 'string' || !version.trim() || version.length > 100 ||
      !Array.isArray(classes) || classes.length !== CLASSES.length ||
      CLASSES.some((code, index) => code !== classes[index]) ||
      !['RGB', 'BGR'].includes(channelOrder) || inputSize !== INPUT_SIZE ||
      ![...confidenceThresholds, iouThreshold].every(value => Number.isFinite(value) && value > 0 && value < 1)) {
    throw new InferenceError(errorMessage);
  }
  const modelUrl = new URL(modelFile, AI_ROOT);
  modelUrl.searchParams.set('v', version);
  return {modelUrl, version, channelOrder, confidenceThresholds, iouThreshold};
}

async function loadDetector() {
  const config = await readModelConfig();
  try {
    if (!self.ort) importScripts(new URL('ort.wasm.min.js', ORT_ROOT).href);
    self.ort.env.wasm.wasmPaths = ORT_ROOT.href;
    self.ort.env.wasm.numThreads = 1;
    self.ort.env.wasm.proxy = false;
    self.ort.env.wasm.initTimeout = 30_000;
  } catch {
    throw new InferenceError('Không tải được bộ xử lý AI trên trình duyệt.');
  }
  const bytes = await readAsset(config.modelUrl, 25 * 1024 * 1024, 'Không tải được mô hình AI.');
  try {
    const session = await self.ort.InferenceSession.create(bytes, {executionProviders: ['wasm']});
    if (session.inputNames.length !== 1 || session.outputNames.length !== 1) {
      await session.release();
      throw new InferenceError('Mô hình AI không khớp với ứng dụng.');
    }
    return {config, session};
  } catch (error) {
    if (error instanceof InferenceError) throw error;
    throw new InferenceError('Không khởi tạo được mô hình AI trên trình duyệt.');
  }
}

async function loadImage(imageUrl) {
  let url;
  try { url = new URL(imageUrl, self.location.origin); } catch { /* handled below */ }
  if (!url || url.origin !== self.location.origin || url.username || url.password ||
      (!CAPTURE_PATH.test(url.pathname) && !EXAMPLE_PATH.test(url.pathname))) {
    throw new InferenceError('Đường dẫn ảnh không hợp lệ.');
  }
  const bytes = await readAsset(url, 8 * 1024 * 1024, 'Không tải được ảnh để phân tích.');
  let image;
  try {
    image = await createImageBitmap(new Blob([bytes]));
  } catch {
    throw new InferenceError('Không đọc được ảnh để phân tích.');
  }
  if (image.width * image.height > MAX_IMAGE_PIXELS) {
    image.close();
    throw new InferenceError('Ảnh quá lớn để phân tích trên trình duyệt.');
  }
  return image;
}

function makeTiles(width, height) {
  // At most four overlapping crops. A VGA camera frame keeps its original pixels.
  const tileSize = Math.max(INPUT_SIZE, Math.ceil(Math.max(width, height) / 1.8));
  const tileWidth = Math.min(tileSize, width);
  const tileHeight = Math.min(tileSize, height);
  const xs = tileWidth === width ? [0] : [0, width - tileWidth];
  const ys = tileHeight === height ? [0] : [0, height - tileHeight];
  return ys.flatMap(y => xs.map(x => ({x, y, width: tileWidth, height: tileHeight})));
}

function makeInput(context, image, tile, channelOrder) {
  const ratio = Math.min(INPUT_SIZE / tile.width, INPUT_SIZE / tile.height);
  const width = Math.max(1, Math.floor(tile.width * ratio));
  const height = Math.max(1, Math.floor(tile.height * ratio));
  context.fillStyle = 'rgb(114, 114, 114)';
  context.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  context.drawImage(image, tile.x, tile.y, tile.width, tile.height, 0, 0, width, height);
  const {data} = context.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  const input = new Float32Array(plane * 3);
  const blueFirst = channelOrder === 'BGR';
  for (let i = 0; i < plane; i++) {
    const pixel = i * 4;
    input[i] = data[pixel + (blueFirst ? 2 : 0)];
    input[i + plane] = data[pixel + 1];
    input[i + plane * 2] = data[pixel + (blueFirst ? 0 : 2)];
  }
  return {input, width, height};
}

function collectCandidates(candidates, output, tile, width, height, confidenceThresholds) {
  if (output.dims.length !== 3 || output.dims[0] !== 1 ||
      output.dims[1] !== PREDICTION_ROWS || output.dims[2] !== ROW_WIDTH) {
    throw new InferenceError('Đầu ra mô hình AI không khớp với ứng dụng.');
  }
  const xScale = tile.width / width;
  const yScale = tile.height / height;
  const {data} = output;
  for (let row = 0; row < PREDICTION_ROWS; row++) {
    const offset = row * ROW_WIDTH;
    const classIndex = data[offset + 5] >= data[offset + 6] ? 0 : 1;
    const confidence = data[offset + 4] * data[offset + 5 + classIndex];
    if (!Number.isFinite(confidence) || confidence < confidenceThresholds[classIndex] || confidence > 1) continue;
    const cx = data[offset];
    const cy = data[offset + 1];
    const boxWidth = data[offset + 2];
    const boxHeight = data[offset + 3];
    if (!Number.isFinite(boxWidth) || !Number.isFinite(boxHeight) || boxWidth <= 0 || boxHeight <= 0 ||
        !(cx >= 0 && cx < width && cy >= 0 && cy < height)) continue;
    const x1 = tile.x + Math.max(0, cx - boxWidth / 2) * xScale;
    const y1 = tile.y + Math.max(0, cy - boxHeight / 2) * yScale;
    const x2 = tile.x + Math.min(width, cx + boxWidth / 2) * xScale;
    const y2 = tile.y + Math.min(height, cy + boxHeight / 2) * yScale;
    candidates.push({classIndex, confidence, x1, y1, x2, y2, area: (x2 - x1) * (y2 - y1)});
  }
}

function overlap(a, b) {
  const width = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const height = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const intersection = width * height;
  return intersection / (a.area + b.area - intersection);
}

function mergeDetections(candidates, width, height, iouThreshold) {
  candidates.sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  let truncated = candidates.length > MAX_CANDIDATES;
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    // A nearly identical crop detection can disagree on class, but is still one insect.
    const duplicate = kept.some(other => overlap(candidate, other) >=
      (candidate.classIndex === other.classIndex ? iouThreshold : 0.85));
    if (duplicate) continue;
    if (kept.length === MAX_DETECTIONS) {
      truncated = true;
      break;
    }
    kept.push(candidate);
  }
  const detections = kept.map(box => ({
    pest_code: CLASSES[box.classIndex], confidence: box.confidence,
    x_min: box.x1 / width, y_min: box.y1 / height,
    x_max: box.x2 / width, y_max: box.y2 / height,
  }));
  return {detections, truncated};
}

async function analyze(image, id, detector) {
  const {config, session} = detector;
  const tiles = makeTiles(image.width, image.height);
  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const context = canvas.getContext('2d', {alpha: false, willReadFrequently: true});
  if (!context) throw new InferenceError('Không khởi tạo được bộ đọc ảnh trên trình duyệt.');
  context.imageSmoothingQuality = 'low';
  const candidates = [];
  for (const [index, tile] of tiles.entries()) {
    self.postMessage({id, type: 'progress', stage: 'running', completed: index, total: tiles.length});
    const {input, width, height} = makeInput(context, image, tile, config.channelOrder);
    const tensor = new self.ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    let output;
    try {
      const outputs = await session.run({[session.inputNames[0]]: tensor});
      output = outputs[session.outputNames[0]];
      collectCandidates(candidates, output, tile, width, height, config.confidenceThresholds);
    } finally {
      output?.dispose();
      tensor.dispose();
    }
  }
  return {
    width: image.width, height: image.height, model_version: config.version,
    ...mergeDetections(candidates, image.width, image.height, config.iouThreshold),
  };
}

self.addEventListener('message', async ({data}) => {
  const {id, imageUrl} = data || {};
  if (typeof id !== 'string' && !Number.isSafeInteger(id)) return;
  if (busy) {
    self.postMessage({id, type: 'error', message: 'Đang phân tích ảnh khác. Bạn thử lại sau.'});
    return;
  }
  busy = true;
  let image;
  try {
    if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
      throw new InferenceError('Trình duyệt này chưa hỗ trợ phân tích ảnh. Bạn thử Chrome hoặc Edge mới hơn.');
    }
    self.postMessage({id, type: 'progress', stage: 'loading'});
    image = await loadImage(imageUrl);
    detectorPromise ??= loadDetector().catch(error => {
      detectorPromise = undefined;
      throw error;
    });
    const result = await analyze(image, id, await detectorPromise);
    self.postMessage({id, type: 'result', ...result});
  } catch (error) {
    const message = error instanceof InferenceError ? error.message : 'Không thể phân tích ảnh. Bạn thử lại.';
    self.postMessage({id, type: 'error', message});
  } finally {
    image?.close();
    busy = false;
  }
});
