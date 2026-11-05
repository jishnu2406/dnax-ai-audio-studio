import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');
const DATA = join(ROOT, 'data');
const VOICES = join(DATA, 'voices');
const OUTPUTS = join(DATA, 'outputs');
const ENHANCEMENTS = join(DATA, 'enhancements');
const EXTRACTED = join(DATA, 'extracted');
const RECENT_JOBS = join(DATA, 'recent_jobs.json');
const PREVIEWS = join(DATA, 'previews');
const RVC = join(ROOT, 'vendor', 'rvc');
const PYTHON = process.env.RVC_PYTHON || join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4317);
const MAX_AUDIO = 250 * 1024 * 1024;
const MAX_VIDEO = 1024 * 1024 * 1024;
const AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.aac', '.aiff', '.aif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v']);
const jobs = new Map();
const previewSessions = new Map();
const stereoExports = new Map();
let enhancementBusy = false;
let activeJob = null;

const exists = async path => access(path).then(() => true, () => false);
const id = () => randomUUID().replaceAll('-', '').slice(0, 16);
const clip = (value, length = 100) => String(value ?? '').trim().slice(0, length);
const safeFilename = value => basename(String(value || 'recording.wav')).replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120);
const voiceDir = voiceId => join(VOICES, voiceId);
const metaPath = voiceId => join(voiceDir(voiceId), 'voice.json');
const validId = value => /^[a-f0-9]{16}$/.test(value);

function parseEffects(value) {
  let effects;
  try { effects = typeof value === 'string' ? JSON.parse(decodeURIComponent(value)) : value; }
  catch { fail(400, 'Invalid production effects settings.'); }
  if (!effects || typeof effects !== 'object' || Array.isArray(effects)) fail(400, 'Invalid production effects settings.');
  for (const key of ['enabled', 'autoTune']) if (effects[key] !== undefined && typeof effects[key] !== 'boolean') fail(400, `Invalid ${key} setting.`);
  const ranges = { bass: [-12, 12], body: [-12, 12], presence: [-12, 12], treble: [-12, 12], outputGain: [-12, 12], compression: [0, 100], reverb: [0, 50], highpass: [0, 120], tuneStrength: [0, 100] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (effects[key] !== undefined && (typeof effects[key] !== 'number' || !Number.isFinite(effects[key]) || effects[key] < min || effects[key] > max)) fail(400, `Invalid ${key} setting.`);
  }
  if (effects.tuneKey !== undefined && !['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].includes(effects.tuneKey)) fail(400, 'Invalid tuning key.');
  if (effects.tuneScale !== undefined && !['chromatic', 'major', 'minor'].includes(effects.tuneScale)) fail(400, 'Invalid tuning scale.');
  return effects;
}

function sendJson(res, code, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function fail(code, message) {
  const error = new Error(message);
  error.status = code;
  throw error;
}

async function runAudioWorker(args) {
  const child = spawn(PYTHON, [join(ROOT, 'audio_enhance.py'), ...args], {
    cwd: ROOT, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }
  });
  let details = '';
  child.stderr.on('data', chunk => { details = (details + chunk.toString()).slice(-3000); });
  const code = await new Promise(done => {
    child.on('error', error => { details = error.message; done(-1); });
    child.on('close', done);
  });
  if (code !== 0) fail(500, `Audio processing failed. ${details.slice(-900)}`.trim());
}

async function runTool(executable, args, label) {
  const child = spawn(executable, args, { cwd: ROOT, windowsHide: true });
  let details = '';
  child.stderr.on('data', chunk => { details = (details + chunk.toString()).slice(-4000); });
  const code = await new Promise(done => {
    child.on('error', error => { details = error.message; done(-1); });
    child.on('close', done);
  });
  if (code !== 0) fail(422, `${label} failed. ${details.slice(-800)}`.trim());
}

async function listResources() {
  const voices = await listVoices();
  const references = voices.flatMap(voice => voice.samples.map(sample => ({
    id: sample.id, name: sample.name, bytes: sample.bytes, voiceName: voice.name,
    url: `/api/voices/${voice.id}/samples/${sample.id}`, createdAt: sample.createdAt
  })));
  const extracted = [];
  for (const item of await readdir(EXTRACTED)) {
    if (!/^[a-f0-9]{16}\.json$/.test(item)) continue;
    try {
      const data = JSON.parse(await readFile(join(EXTRACTED, item), 'utf8'));
      if (validId(data.id) && ['wav', 'mp3', 'aac'].includes(data.format) &&
          await exists(join(EXTRACTED, `${data.id}.${data.format}`))) {
        extracted.push({ ...data, url: `/api/extracted/${data.id}.${data.format}` });
      }
    } catch { /* Ignore incomplete metadata. */ }
  }
  const outputs = [...jobs.values()].filter(job => job.kind === 'convert' && job.state === 'completed' && job.resultUrl)
    .map(job => ({ id: job.id, name: `Cloned audio · ${voices.find(voice => voice.id === job.voiceId)?.name || 'Voice'}`,
      url: job.resultUrl, createdAt: job.createdAt }));
  return { references: references.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    extracted: extracted.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    outputs: outputs.reverse() };
}

function mixSettings(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail(400, 'Invalid enhancement settings.');
  const settings = {};
  for (const key of ['speech', 'music', 'background']) {
    const value = options[key] ?? (key === 'speech' ? 100 : 10);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) fail(400, `Invalid ${key} level.`);
    settings[key] = value;
  }
  return settings;
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'Upload is too large. Maximum audio size is 250 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readBody(req);
  try { return JSON.parse(body.toString('utf8')); }
  catch { fail(400, 'Invalid JSON request.'); }
}

async function saveAudio(req, path, limit = MAX_AUDIO) {
  let size = 0;
  const stream = createWriteStream(path, { flags: 'wx' });
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) fail(413, `Upload exceeds the ${Math.round(limit / 1024 / 1024)} MB limit.`);
      if (!stream.write(chunk)) await new Promise(resolveDrain => stream.once('drain', resolveDrain));
    }
    if (!size) fail(400, 'Choose an audio file first.');
    await new Promise((done, reject) => stream.end(error => error ? reject(error) : done()));
    return size;
  } catch (error) {
    stream.destroy();
    await rm(path, { force: true });
    throw error;
  }
}

async function getVoice(voiceId) {
  if (!validId(voiceId)) fail(404, 'Voice not found.');
  try { return JSON.parse(await readFile(metaPath(voiceId), 'utf8')); }
  catch { fail(404, 'Voice not found.'); }
}

async function saveVoice(voice) {
  const target = metaPath(voice.id);
  const temp = `${target}.${id()}.tmp`;
  await writeFile(temp, JSON.stringify(voice, null, 2));
  await rename(temp, target);
}

async function listVoices() {
  await mkdir(VOICES, { recursive: true });
  const names = await readdir(VOICES, { withFileTypes: true });
  const values = await Promise.all(names.filter(item => item.isDirectory() && validId(item.name)).map(async item => {
    try {
      const voice = await getVoice(item.name);
      voice.trained = await exists(join(RVC, 'assets', 'weights', `${item.name}.pth`));
      return voice;
    } catch { return null; }
  }));
  return values.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function readiness() {
  const required = [
    ['RVC repository', join(RVC, 'webui.py')],
    ['Python 3.12 environment', PYTHON],
    ['HuBERT config', join(RVC, 'assets/hubert_base/config.json')],
    ['HuBERT preprocessor', join(RVC, 'assets/hubert_base/preprocessor_config.json')],
    ['HuBERT model', join(RVC, 'assets/hubert_base/pytorch_model.bin')],
    ['RMVPE model', join(RVC, 'assets/rmvpe/rmvpe.pt')],
    ['Pretrained generator', join(RVC, 'assets/pretrained_v2/f0G40k.pth')],
    ['Pretrained discriminator', join(RVC, 'assets/pretrained_v2/f0D40k.pth')],
    ['Training silence samples', join(RVC, 'logs/mute/0_gt_wavs/mute40k.wav')],
  ];
  if (process.platform === 'win32') {
    required.push(['FFmpeg', join(RVC, 'ffmpeg.exe')], ['FFprobe', join(RVC, 'ffprobe.exe')]);
  }
  const missing = [];
  for (const [label, path] of required) if (!(await exists(path))) missing.push(label);
  return { ready: missing.length === 0, missing, python: PYTHON, repository: 'RVC-Project/Retrieval-based-Voice-Conversion-WebUI', localOnly: HOST === '127.0.0.1' };
}

function publicJob(job) {
  return { id: job.id, kind: job.kind, voiceId: job.voiceId, previewId: job.previewId || null, state: job.state, stage: job.stage, logs: job.logs.slice(-80), createdAt: job.createdAt, resultUrl: job.resultUrl || null, error: job.error || null };
}

function startJob(kind, voiceId, args, outputPath, inputPath, previewId) {
  if (activeJob) fail(409, 'Another training or conversion job is running.');
  const job = { id: id(), kind, voiceId, previewId, state: 'running', stage: 'Starting RVC', logs: [], createdAt: new Date().toISOString(), resultUrl: null, process: null, cancelled: false };
  jobs.set(job.id, job);
  activeJob = job;
  if (jobs.size > 30) {
    const oldest = [...jobs.keys()][0];
    if (oldest !== job.id) jobs.delete(oldest);
  }
  const worker = join(ROOT, 'rvc_worker.py');
  const child = spawn(PYTHON, [worker, kind, ...args], { cwd: RVC, env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', GRADIO_ANALYTICS_ENABLED: 'False', PATH: `${RVC}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}` }, windowsHide: true, detached: process.platform !== 'win32' });
  job.process = child;
  let pending = '';
  function consume(chunk) {
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('__RVC_EVENT__')) {
        try {
          const event = JSON.parse(line.slice('__RVC_EVENT__'.length));
          if (event.stage) job.stage = event.stage;
          if (event.resultUrl) job.resultUrl = event.resultUrl;
          if (event.error) job.error = event.error;
        } catch { /* Keep raw process output below. */ }
      } else if (line.trim()) job.logs.push(line.slice(0, 1000));
    }
    if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
  }
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.on('error', error => { job.error = error.message; job.state = 'failed'; activeJob = null; });
  child.on('close', async code => {
    if (pending.trim()) consume(Buffer.from('\n'));
    if (job.cancelled) job.state = 'cancelled';
    else if (code === 0) {
      if ((kind === 'convert' || kind === 'preview') && outputPath && await exists(outputPath)) {
        job.resultUrl = kind === 'preview' ? `/api/previews/${previewId}/audio?v=0` : `/api/outputs/${basename(outputPath)}`;
        job.state = 'completed';
      } else if (kind === 'train' && await exists(join(RVC, 'assets/weights', `${voiceId}.pth`))) job.state = 'completed';
      else { job.state = 'failed'; job.error ||= 'RVC did not produce the expected model or audio file.'; }
    } else { job.state = 'failed'; job.error ||= `RVC exited with code ${code}. See the job log.`; }
    job.stage = job.state === 'completed' ? 'Complete' : job.state === 'cancelled' ? 'Cancelled' : 'Failed';
    if (kind === 'convert' && job.state === 'completed') {
      const recent = [...jobs.values()].filter(item => item.kind === 'convert' && item.state === 'completed').slice(-10).map(publicJob);
      await writeFile(RECENT_JOBS, JSON.stringify(recent)).catch(() => {});
    }
    if (activeJob?.id === job.id) activeJob = null;
    if (inputPath) await rm(inputPath, { force: true }).catch(() => {});
    if (job.state !== 'completed' && outputPath) await rm(outputPath, { force: true }).catch(() => {});
    if (kind === 'preview' && job.state !== 'completed') previewSessions.delete(previewId);
  });
  return publicJob(job);
}

async function renderPreview(req, res, previewId) {
  const session = previewSessions.get(previewId);
  if (!session || !(await exists(session.basePath))) fail(404, 'Generate a voice preview first.');
  const settings = parseEffects(await readJson(req));
  session.generation += 1;
  const generation = session.generation;
  if (session.renderProcess) session.renderProcess.kill();
  if (!settings.enabled) {
    session.currentPath = session.basePath;
    return sendJson(res, 200, { resultUrl: `/api/previews/${previewId}/audio?v=${generation}`, duration: session.duration });
  }
  const output = join(PREVIEWS, `${previewId}-fx-${generation}.wav`);
  const child = spawn(PYTHON, [join(ROOT, 'audio_fx.py'), '--input', session.basePath, '--output', output, '--settings-json', JSON.stringify(settings)], { cwd: ROOT, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
  session.renderProcess = child;
  let details = '';
  child.stderr.on('data', chunk => { details = (details + chunk.toString()).slice(-2500); });
  const exitCode = await new Promise(resolveExit => {
    child.on('error', error => { details = error.message; resolveExit(-1); });
    child.on('close', resolveExit);
  });
  if (session.renderProcess === child) session.renderProcess = null;
  if (generation !== session.generation || previewSessions.get(previewId) !== session) {
    await rm(output, { force: true }).catch(() => {});
    fail(409, 'A newer preview setting replaced this render.');
  }
  if (exitCode !== 0 || !(await exists(output))) {
    await rm(output, { force: true }).catch(() => {});
    fail(500, `Could not render production effects. ${details.slice(-600)}`.trim());
  }
  const previous = session.currentPath;
  session.currentPath = output;
  if (previous !== session.basePath && previous !== output) await rm(previous, { force: true }).catch(() => {});
  return sendJson(res, 200, { resultUrl: `/api/previews/${previewId}/audio?v=${generation}`, duration: session.duration });
}

function serveFile(req, res, path, type, download = false) {
  stat(path).then(info => {
    if (!info.isFile()) return sendJson(res, 404, { error: 'File not found.' });
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' };
    if (download) headers['Content-Disposition'] = `attachment; filename="${safeFilename(basename(path))}"`;
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
      createReadStream(path, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': info.size });
      createReadStream(path).pipe(res);
    }
  }).catch(() => sendJson(res, 404, { error: 'File not found.' }));
}

async function route(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  const method = req.method || 'GET';
  if (!['GET', 'HEAD'].includes(method) && req.headers.origin) {
    const origin = new URL(req.headers.origin);
    if (!['127.0.0.1', 'localhost'].includes(origin.hostname) || Number(origin.port) !== PORT) fail(403, 'Request origin is not allowed.');
  }
  if (path === '/api/status' && method === 'GET') return sendJson(res, 200, await readiness());
  if (path === '/api/resources' && method === 'GET') return sendJson(res, 200, await listResources());
  if (path === '/api/video/extract' && method === 'POST') {
    const filename = safeFilename(req.headers['x-file-name'] || 'video.mp4');
    const extension = extname(filename).toLowerCase();
    if (!VIDEO_EXT.has(extension)) fail(415, 'Choose MP4, MOV, MKV, AVI, WebM, or M4V video.');
    const format = String(req.headers['x-format'] || 'wav').toLowerCase();
    if (!['wav', 'mp3', 'aac'].includes(format)) fail(400, 'Choose WAV, MP3, or AAC output.');
    const bitrate = Number(req.headers['x-bitrate'] || 256);
    if (!Number.isInteger(bitrate) || ![64, 128, 192, 256, 320].includes(bitrate)) fail(400, 'Invalid audio bitrate.');
    const resourceId = id();
    const input = join(EXTRACTED, `${resourceId}-input${extension}`);
    const output = join(EXTRACTED, `${resourceId}.${format}`);
    await saveAudio(req, input, MAX_VIDEO);
    try {
      const codec = format === 'wav' ? ['-c:a', 'pcm_s24le'] :
        format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', `${bitrate}k`] :
          ['-c:a', 'aac', '-b:a', `${bitrate}k`];
      await runTool(join(RVC, 'ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
        '-map', '0:a:0', '-vn', '-ar', '48000', '-ac', '2', ...codec, output], 'Video audio extraction');
      const info = await stat(output);
      const record = { id: resourceId, name: filename, format, bitrate: format === 'wav' ? null : bitrate,
        bytes: info.size, createdAt: new Date().toISOString() };
      await writeFile(join(EXTRACTED, `${resourceId}.json`), JSON.stringify(record));
      return sendJson(res, 201, { ...record, url: `/api/extracted/${resourceId}.${format}` });
    } catch (error) {
      await rm(output, { force: true }).catch(() => {});
      throw error;
    } finally { await rm(input, { force: true }).catch(() => {}); }
  }
  let extractedMatch = /^\/api\/extracted\/([a-f0-9]{16})\.(wav|mp3|aac)$/.exec(path);
  if (extractedMatch && method === 'GET') return serveFile(req, res,
    join(EXTRACTED, `${extractedMatch[1]}.${extractedMatch[2]}`),
    { wav: 'audio/wav', mp3: 'audio/mpeg', aac: 'audio/aac' }[extractedMatch[2]],
    url.searchParams.has('download'));
  if (path === '/api/voices' && method === 'GET') return sendJson(res, 200, await listVoices());
  if (path === '/api/voices' && method === 'POST') {
    const data = await readJson(req);
    const name = clip(data.name, 60);
    if (!name) fail(400, 'Enter a name for the voice.');
    const voice = { id: id(), name, createdAt: new Date().toISOString(), samples: [] };
    await mkdir(join(voiceDir(voice.id), 'samples'), { recursive: true });
    await saveVoice(voice);
    return sendJson(res, 201, voice);
  }
  let match = /^\/api\/voices\/([a-f0-9]{16})\/samples$/.exec(path);
  if (match && method === 'POST') {
    const voice = await getVoice(match[1]);
    if (voice.samples.length >= 40) fail(400, 'A voice can hold up to 40 recordings.');
    const filename = safeFilename(req.headers['x-file-name'] || url.searchParams.get('name'));
    const extension = extname(filename).toLowerCase();
    if (!AUDIO_EXT.has(extension)) fail(415, 'Use WAV, MP3, FLAC, M4A, OGG, AAC, or AIFF audio.');
    const sampleId = id();
    const storedName = `${sampleId}${extension}`;
    const size = await saveAudio(req, join(voiceDir(voice.id), 'samples', storedName));
    const sample = { id: sampleId, name: filename, storedName, bytes: size, createdAt: new Date().toISOString() };
    voice.samples.push(sample);
    await saveVoice(voice);
    return sendJson(res, 201, sample);
  }
  match = /^\/api\/voices\/([a-f0-9]{16})\/samples\/([a-f0-9]{16})$/.exec(path);
  if (match && method === 'DELETE') {
    const voice = await getVoice(match[1]);
    if (activeJob?.voiceId === voice.id) fail(409, 'Wait for the current job to finish.');
    const sample = voice.samples.find(item => item.id === match[2]);
    if (!sample) fail(404, 'Recording not found.');
    voice.samples = voice.samples.filter(item => item.id !== sample.id);
    await saveVoice(voice);
    await rm(join(voiceDir(voice.id), 'samples', sample.storedName), { force: true });
    return sendJson(res, 200, { ok: true });
  }
  if (match && method === 'GET') {
    const voice = await getVoice(match[1]);
    const sample = voice.samples.find(item => item.id === match[2]);
    if (!sample) fail(404, 'Recording not found.');
    return serveFile(req, res, join(voiceDir(voice.id), 'samples', sample.storedName), 'audio/*');
  }
  if (path === '/api/train' && method === 'POST') {
    const data = await readJson(req);
    const voice = await getVoice(data.voiceId);
    if (!voice.samples.length) fail(400, 'Upload at least one voice recording.');
    const status = await readiness();
    if (!status.ready) fail(503, `RVC setup is incomplete: ${status.missing.join(', ')}. Run setup.ps1.`);
    const epochs = Number(data.epochs ?? 40);
    if (!Number.isInteger(epochs) || epochs < 10 || epochs > 300) fail(400, 'Training epochs must be between 10 and 300.');
    const batch = Number(data.batch ?? 4);
    if (!Number.isInteger(batch) || batch < 1 || batch > 16) fail(400, 'Batch size must be between 1 and 16.');
    return sendJson(res, 202, startJob('train', voice.id, ['--voice-id', voice.id, '--samples', join(voiceDir(voice.id), 'samples'), '--epochs', String(epochs), '--batch', String(batch)]));
  }
  if (path === '/api/previews' && method === 'POST') {
    if (activeJob) fail(409, 'Wait for the current RVC job to finish before generating a preview.');
    const voice = await getVoice(req.headers['x-voice-id']);
    if (!(await exists(join(RVC, 'assets/weights', `${voice.id}.pth`)))) fail(400, 'Train this voice before previewing.');
    const filename = safeFilename(req.headers['x-file-name']);
    const extension = extname(filename).toLowerCase();
    if (!AUDIO_EXT.has(extension)) fail(415, 'Choose a supported audio file.');
    const pitch = Number(req.headers['x-pitch'] || 0);
    const indexRate = Number(req.headers['x-index-rate'] ?? 0.75);
    const method = req.headers['x-f0-method'] || 'rmvpe';
    const start = Number(req.headers['x-preview-start'] || 0);
    const duration = Number(req.headers['x-preview-duration'] || 8);
    if (!Number.isInteger(pitch) || pitch < -12 || pitch > 12) fail(400, 'Pitch must be from -12 to 12 semitones.');
    if (!Number.isFinite(indexRate) || indexRate < 0 || indexRate > 1) fail(400, 'Index strength must be from 0 to 1.');
    if (!['rmvpe', 'pm', 'fcpe'].includes(method)) fail(400, 'Unsupported pitch method.');
    if (!Number.isFinite(start) || start < 0 || start > 36000) fail(400, 'Invalid preview start time.');
    if (!Number.isFinite(duration) || duration < 5 || duration > 10) fail(400, 'Preview length must be 5 to 10 seconds.');
    await mkdir(PREVIEWS, { recursive: true });
    const previewId = id();
    const input = join(PREVIEWS, `${previewId}-source${extension}`);
    const base = join(PREVIEWS, `${previewId}-base.wav`);
    await saveAudio(req, input);
    previewSessions.set(previewId, { voiceId: voice.id, basePath: base, currentPath: base, duration, generation: 0, renderProcess: null });
    return sendJson(res, 202, startJob('preview', voice.id, ['--voice-id', voice.id, '--input', input, '--output', base, '--pitch', String(pitch), '--index-rate', String(indexRate), '--method', method, '--start', String(start), '--duration', String(duration)], base, input, previewId));
  }
  let previewMatch = /^\/api\/previews\/([a-f0-9]{16})\/render$/.exec(path);
  if (previewMatch && method === 'POST') return renderPreview(req, res, previewMatch[1]);
  previewMatch = /^\/api\/previews\/([a-f0-9]{16})\/audio$/.exec(path);
  if (previewMatch && method === 'GET') {
    const session = previewSessions.get(previewMatch[1]);
    if (!session) fail(404, 'Preview not found.');
    return serveFile(req, res, session.currentPath, 'audio/wav');
  }
  previewMatch = /^\/api\/previews\/([a-f0-9]{16})$/.exec(path);
  if (previewMatch && method === 'DELETE') {
    const session = previewSessions.get(previewMatch[1]);
    if (!session) return sendJson(res, 200, { ok: true });
    if (activeJob?.previewId === previewMatch[1]) fail(409, 'Wait for preview generation to finish.');
    session.renderProcess?.kill();
    previewSessions.delete(previewMatch[1]);
    for (const file of await readdir(PREVIEWS)) if (file.startsWith(`${previewMatch[1]}-`)) await rm(join(PREVIEWS, file), { force: true }).catch(() => {});
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/api/convert' && method === 'POST') {
    if (activeJob) fail(409, 'Another training or conversion job is running.');
    const voice = await getVoice(req.headers['x-voice-id']);
    if (!(await exists(join(RVC, 'assets/weights', `${voice.id}.pth`)))) fail(400, 'Train this voice before converting.');
    const filename = safeFilename(req.headers['x-file-name']);
    const extension = extname(filename).toLowerCase();
    if (!AUDIO_EXT.has(extension)) fail(415, 'Choose a supported audio file.');
    const pitch = Number(req.headers['x-pitch'] || 0);
    if (!Number.isInteger(pitch) || pitch < -12 || pitch > 12) fail(400, 'Pitch must be from -12 to 12 semitones.');
    const indexRate = Number(req.headers['x-index-rate'] ?? 0.75);
    if (!Number.isFinite(indexRate) || indexRate < 0 || indexRate > 1) fail(400, 'Index strength must be from 0 to 1.');
    const method = req.headers['x-f0-method'] || 'rmvpe';
    if (!['rmvpe', 'pm', 'fcpe'].includes(method)) fail(400, 'Unsupported pitch method.');
    const effects = parseEffects(req.headers['x-fx-settings'] || '{}');
    await mkdir(OUTPUTS, { recursive: true });
    const conversionId = id();
    const input = join(OUTPUTS, `${conversionId}-source${extension}`);
    const output = join(OUTPUTS, `${conversionId}.wav`);
    await saveAudio(req, input);
    return sendJson(res, 202, startJob('convert', voice.id, ['--voice-id', voice.id, '--input', input, '--output', output, '--pitch', String(pitch), '--index-rate', String(indexRate), '--method', method, '--fx-json', JSON.stringify(effects)], output, input));
  }
  if (path === '/api/jobs' && method === 'GET') return sendJson(res, 200, [...jobs.values()].reverse().map(publicJob));
  match = /^\/api\/jobs\/([a-f0-9]{16})$/.exec(path);
  if (match && method === 'GET') {
    const job = jobs.get(match[1]);
    if (!job) fail(404, 'Job not found.');
    return sendJson(res, 200, publicJob(job));
  }
  if (match && method === 'DELETE') {
    const job = jobs.get(match[1]);
    if (!job) fail(404, 'Job not found.');
    if (job.state !== 'running') fail(409, 'Job is no longer running.');
    job.cancelled = true;
    job.stage = 'Stopping';
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(job.process.pid), '/T', '/F'], { windowsHide: true });
    else { try { process.kill(-job.process.pid, 'SIGTERM'); } catch { job.process.kill('SIGTERM'); } }
    return sendJson(res, 200, publicJob(job));
  }
  match = /^\/api\/outputs\/([a-f0-9]{16}\.(?:wav|mp3))$/.exec(path);
  const crispMatch = /^\/api\/outputs\/([a-f0-9]{16}\.wav)\/crisp$/.exec(path);
  if (crispMatch && method === 'POST') {
    if (enhancementBusy || activeJob) fail(409, 'Wait for the current audio job to finish.');
    const input = join(OUTPUTS, crispMatch[1]);
    if (!(await exists(input))) fail(404, 'Audio was not found.');
    const options = await readJson(req);
    if (!options || !['podcast', 'natural'].includes(options.preset)) fail(400, 'Choose a CrispVoice mastering style.');
    const output = join(OUTPUTS, `${id()}.wav`);
    enhancementBusy = true;
    try {
      await runTool(PYTHON, [join(ROOT, 'crisp_finish.py'), '--input', input, '--output', output,
        '--preset', options.preset], 'CrispVoice mastering');
    } catch (error) {
      await rm(output, { force: true }).catch(() => {});
      await rm(output.replace(/\.wav$/, '.mp3'), { force: true }).catch(() => {});
      throw error;
    } finally { enhancementBusy = false; }
    return sendJson(res, 200, { resultUrl: `/api/outputs/${basename(output)}`,
      mp3Url: `/api/outputs/${basename(output, '.wav')}.mp3` });
  }
  const enhanceMatch = /^\/api\/outputs\/([a-f0-9]{16}\.wav)\/enhance$/.exec(path);
  if (enhanceMatch && method === 'POST') {
    if (enhancementBusy || activeJob) fail(409, 'Wait for the current audio job to finish.');
    const input = join(OUTPUTS, enhanceMatch[1]);
    if (!(await exists(input))) fail(404, 'Converted audio was not found.');
    const options = await readJson(req);
    const levels = mixSettings(options);
    const strength = options.strength ?? 100;
    if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > 100) fail(400, 'Enhancement strength must be between 0 and 100.');
    if (typeof options.separateMusic !== 'boolean') fail(400, 'Choose whether to separate music.');
    const output = join(OUTPUTS, `${id()}.wav`);
    const enhancementId = id();
    const stems = join(ENHANCEMENTS, enhancementId);
    enhancementBusy = true;
    try {
      await runAudioWorker(['--input', input, '--output', output, '--stems-dir', stems, '--strength', String(strength),
        '--speech', String(levels.speech), '--music', String(levels.music), '--background', String(levels.background),
        ...(options.separateMusic ? ['--separate-music'] : [])]);
    } catch (error) {
      await rm(output, { force: true }).catch(() => {});
      await rm(stems, { force: true, recursive: true }).catch(() => {});
      throw error;
    } finally { enhancementBusy = false; }
    const info = JSON.parse(await readFile(join(stems, 'meta.json'), 'utf8'));
    return sendJson(res, 200, { enhancementId, resultUrl: `/api/outputs/${basename(output)}`,
      mp3Url: `/api/outputs/${basename(output, '.wav')}.mp3`, sourceUrl: `/api/outputs/${enhanceMatch[1]}`,
      duration: info.duration });
  }
  const exportMatch = /^\/api\/outputs\/([a-f0-9]{16}\.wav)\/export$/.exec(path);
  if (exportMatch && method === 'POST') {
    const input = join(OUTPUTS, exportMatch[1]);
    if (!(await exists(input))) fail(404, 'Converted audio was not found.');
    const stem = createHash('sha256').update(`stereo-export:${exportMatch[1]}`).digest('hex').slice(0, 16);
    const output = join(OUTPUTS, `${stem}.wav`);
    const mp3 = join(OUTPUTS, `${stem}.mp3`);
    let work = stereoExports.get(stem);
    if (!work && !(await exists(output) && await exists(mp3))) {
      work = runAudioWorker(['--original', '--input', input, '--output', output]);
      stereoExports.set(stem, work);
    }
    if (work) {
      try { await work; }
      catch (error) {
        await rm(output, { force: true }).catch(() => {});
        await rm(mp3, { force: true }).catch(() => {});
        throw error;
      } finally { if (stereoExports.get(stem) === work) stereoExports.delete(stem); }
    }
    return sendJson(res, 200, { resultUrl: `/api/outputs/${basename(output)}`,
      mp3Url: `/api/outputs/${basename(mp3)}` });
  }
  const mixMatch = /^\/api\/enhancements\/([a-f0-9]{16})\/mix$/.exec(path);
  if (mixMatch && method === 'POST') {
    const stems = join(ENHANCEMENTS, mixMatch[1]);
    if (!(await exists(join(stems, 'meta.json')))) fail(404, 'Enhancement session was not found.');
    const options = await readJson(req);
    const levels = mixSettings(options);
    const preview = options.preview === true;
    const previewStart = options.previewStart ?? 0;
    if (typeof previewStart !== 'number' || !Number.isFinite(previewStart) || previewStart < 0 || previewStart > 36000) fail(400, 'Invalid preview start.');
    const info = JSON.parse(await readFile(join(stems, 'meta.json'), 'utf8'));
    if (preview && previewStart >= info.duration) fail(400, 'Preview start is beyond the recording.');
    const output = join(OUTPUTS, `${id()}.wav`);
    try {
      await runAudioWorker(['--mix-only', '--stems-dir', stems, '--output', output,
        '--speech', String(levels.speech), '--music', String(levels.music), '--background', String(levels.background),
        ...(preview ? ['--preview-seconds', '8', '--preview-start', String(previewStart)] : [])]);
    } catch (error) {
      await rm(output, { force: true }).catch(() => {});
      throw error;
    }
    return sendJson(res, 200, { resultUrl: `/api/outputs/${basename(output)}`,
      mp3Url: `/api/outputs/${basename(output, '.wav')}.mp3`, preview });
  }
  const stemExportMatch = /^\/api\/enhancements\/([a-f0-9]{16})\/stems\/export$/.exec(path);
  if (stemExportMatch && method === 'POST') {
    const stems = join(ENHANCEMENTS, stemExportMatch[1]);
    if (!(await exists(join(stems, 'meta.json')))) fail(404, 'Enhancement session was not found.');
    if (!(await exists(join(stems, 'speech-download.mp3')))) {
      await runAudioWorker(['--export-stems', '--stems-dir', stems, '--output', join(stems, 'unused.wav')]);
    }
    const urls = {};
    for (const name of ['speech', 'music', 'background']) {
      urls[name] = {
        wav: `/api/enhancements/${stemExportMatch[1]}/stems/${name}.wav`,
        mp3: `/api/enhancements/${stemExportMatch[1]}/stems/${name}.mp3`
      };
    }
    return sendJson(res, 200, { stems: urls });
  }
  const stemMatch = /^\/api\/enhancements\/([a-f0-9]{16})\/stems\/(speech|music|background)\.(wav|mp3)$/.exec(path);
  if (stemMatch && method === 'GET') {
    const file = join(ENHANCEMENTS, stemMatch[1], `${stemMatch[2]}-download.${stemMatch[3]}`);
    return serveFile(req, res, file, stemMatch[3] === 'mp3' ? 'audio/mpeg' : 'audio/wav', url.searchParams.has('download'));
  }
  if (match && method === 'GET') return serveFile(req, res, join(OUTPUTS, match[1]),
    match[1].endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav', url.searchParams.has('download'));
  const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/studio.css': ['studio.css', 'text/css; charset=utf-8'] };
  if (method === 'GET' && assets[path]) return serveFile(req, res, join(PUBLIC, assets[path][0]), assets[path][1]);
  fail(404, 'Page not found.');
}

await mkdir(VOICES, { recursive: true });
await mkdir(OUTPUTS, { recursive: true });
await mkdir(ENHANCEMENTS, { recursive: true });
await mkdir(EXTRACTED, { recursive: true });
await mkdir(PREVIEWS, { recursive: true });
try {
  const recent = JSON.parse(await readFile(RECENT_JOBS, 'utf8'));
  for (const job of recent) {
    if (job.kind === 'convert' && job.state === 'completed' && validId(job.id) &&
        /^\/api\/outputs\/[a-f0-9]{16}\.wav$/.test(job.resultUrl) &&
        await exists(join(OUTPUTS, basename(job.resultUrl)))) jobs.set(job.id, job);
  }
} catch { /* No saved conversions yet. */ }
http.createServer((req, res) => route(req, res).catch(error => {
  if (res.headersSent) return res.destroy(error);
  sendJson(res, error.status || 500, { error: error.status ? error.message : 'Internal server error.' });
  if (!error.status) console.error(error);
})).listen(PORT, HOST, () => console.log(`DNAX.ai Audio Studio: http://${HOST}:${PORT}`));
