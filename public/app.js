const $ = selector => document.querySelector(selector);
const state = { voices: [], selectedId: '', setup: null, source: null, sourceUrl: null, sourceVersion: 0, jobs: [], uploading: false, playing: null, previewId: '', previewJobId: '', previewFingerprint: '', previewRenderSeq: 0, fxHighpass: 0, enhanceSourceJobId: '', enhancedUrl: '', fullEnhancedUrl: '', enhancing: false, enhancementId: '', originalExportJobId: '', originalUrl: '', originalMp3Url: '', enhancedMp3Url: '', studioUrl: '', studioMp3Url: '', listening: 'original', mixSeq: 0 };

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 6000);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

const postJson = (path, data) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const selectedVoice = () => state.voices.find(voice => voice.id === state.selectedId);
const runningJob = () => state.jobs.find(job => job.state === 'running');

const presets = {
  natural: { bass: 0, body: 0, presence: 0, treble: 0, compression: 0, reverb: 0, outputGain: 0, highpass: 0 },
  professional: { bass: 1, body: -1, presence: 2, treble: 1, compression: 35, reverb: 0, outputGain: 0, highpass: 75 },
  podcast: { bass: 3, body: 1, presence: 2, treble: 1, compression: 50, reverb: 0, outputGain: 1, highpass: 70 },
  narration: { bass: 2, body: 1, presence: 1, treble: -1, compression: 32, reverb: 0, outputGain: 0, highpass: 65 },
  explainer: { bass: 0, body: -1, presence: 3, treble: 2, compression: 40, reverb: 0, outputGain: 0, highpass: 80 },
  cinematic: { bass: 4, body: 1, presence: 0, treble: -1, compression: 24, reverb: 20, outputGain: 0, highpass: 60 },
  broadcast: { bass: 2, body: -1, presence: 3, treble: 2, compression: 60, reverb: 0, outputGain: 0, highpass: 80 },
};

const fxFields = { bass: 'fxBass', body: 'fxBody', presence: 'fxPresence', treble: 'fxTreble', compression: 'fxCompression', reverb: 'fxReverb', outputGain: 'fxOutputGain' };
function updateFxLabels() {
  for (const [key, id] of Object.entries(fxFields)) {
    const value = Number($(`#${id}`).value);
    $(`#${id}Value`).textContent = ['compression', 'reverb'].includes(key) ? `${value}%` : `${value > 0 ? '+' : ''}${value} dB`;
  }
  $('#tuneStrengthValue').textContent = `${$('#tuneStrength').value}%`;
}

function readFxSettings() {
  const preset = $('#fxPreset').value;
  const settings = { enabled: $('#fxEnabled').checked, preset, highpass: state.fxHighpass,
    autoTune: $('#fxEnabled').checked && $('#autoTune').checked,
    tuneKey: $('#tuneKey').value, tuneScale: $('#tuneScale').value, tuneStrength: Number($('#tuneStrength').value) };
  for (const [key, id] of Object.entries(fxFields)) settings[key] = Number($(`#${id}`).value);
  return settings;
}

function previewKey() {
  return JSON.stringify([state.sourceVersion, state.selectedId, $('#pitch').value, $('#indexRate').value, $('#f0Method').value, $('#previewStart').value, $('#previewDuration').value]);
}

function previewStatus(message, live = false) {
  $('#previewStatus').textContent = message;
  $('#previewLive').classList.toggle('hidden', !live);
}

function invalidatePreview() {
  clearTimeout(scheduleBasePreview.timer);
  clearTimeout(schedulePreviewEffects.timer);
  const oldId = state.previewId;
  state.previewId = '';
  state.previewJobId = '';
  state.previewFingerprint = '';
  state.previewRenderSeq++;
  $('#convertedPreview').pause();
  $('#convertedPreview').removeAttribute('src');
  $('#convertedPreview').classList.add('hidden');
  if (oldId) api(`/api/previews/${oldId}`, { method: 'DELETE' }).catch(() => {});
}

function scheduleBasePreview(delay = 650) {
  clearTimeout(scheduleBasePreview.timer);
  if (!state.source || !selectedVoice()?.trained || !state.setup?.ready) return;
  scheduleBasePreview.timer = setTimeout(() => buildPreview().catch(error => previewStatus(error.message)), delay);
}

async function buildPreview(force = false) {
  const voice = selectedVoice();
  if (!voice?.trained || !state.source || !state.setup?.ready) return;
  const key = previewKey();
  if (!force && state.previewFingerprint === key) return;
  if (runningJob()) { previewStatus('Waiting for the current RVC job to finish…'); return; }
  const oldId = state.previewId;
  state.previewId = '';
  state.previewJobId = '';
  state.previewFingerprint = key;
  state.previewRenderSeq++;
  if (oldId) api(`/api/previews/${oldId}`, { method: 'DELETE' }).catch(() => {});
  $('#convertedPreview').classList.add('hidden');
  previewStatus('Building your 5–10 second converted voice sample. This first pass uses RVC and may take a little while…');
  renderButtons();
  try {
    const data = await api('/api/previews', { method: 'POST', headers: {
      'Content-Type': state.source.type || 'application/octet-stream',
      'X-Voice-Id': voice.id, 'X-File-Name': state.source.name.replace(/[^\x20-\x7e]/g, '_'),
      'X-Pitch': $('#pitch').value, 'X-Index-Rate': String(Number($('#indexRate').value) / 100),
      'X-F0-Method': $('#f0Method').value, 'X-Preview-Start': $('#previewStart').value,
      'X-Preview-Duration': $('#previewDuration').value,
    }, body: state.source });
    state.previewId = data.previewId;
    state.previewJobId = data.id;
    if (key !== previewKey()) previewStatus('Voice settings changed. The next preview will use the latest settings.');
    await refreshJobs();
  } catch (error) {
    previewStatus(error.message);
    throw error;
  } finally { renderButtons(); }
}

function schedulePreviewEffects(delay = 450) {
  clearTimeout(schedulePreviewEffects.timer);
  if (state.previewId && !state.previewJobId) {
    previewStatus('Updating the sample with your production settings…', true);
    schedulePreviewEffects.timer = setTimeout(() => renderPreviewEffects(), delay);
  }
}

async function renderPreviewEffects() {
  const previewId = state.previewId;
  if (!previewId || state.previewJobId) return;
  const serial = ++state.previewRenderSeq;
  const player = $('#convertedPreview');
  const wasPlaying = !player.paused && !!player.src;
  const time = player.currentTime || 0;
  previewStatus('Updating the sample with your production settings…', true);
  try {
    const result = await postJson(`/api/previews/${previewId}/render`, readFxSettings());
    if (serial !== state.previewRenderSeq || previewId !== state.previewId) return;
    player.src = result.resultUrl;
    player.classList.remove('hidden');
    player.addEventListener('loadedmetadata', () => { if (time > 0) player.currentTime = Math.min(time, Math.max(0, player.duration - 0.1)); }, { once: true });
    if (wasPlaying) player.play().catch(() => {});
    previewStatus('Preview ready. Adjust tone and style to hear a refreshed sample.', true);
  } catch (error) {
    if (serial === state.previewRenderSeq && previewId === state.previewId && !error.message.includes('newer preview setting')) previewStatus(error.message);
  }
}

function renderSetup() {
  const ready = state.setup?.ready;
  $('#topStatus').textContent = ready ? 'ENGINE READY' : 'SETUP NEEDED';
  $('#topStatus').classList.toggle('ready', !!ready);
  $('#setupBanner').classList.toggle('hidden', !!ready);
  if (!ready) $('#setupDetails').textContent = state.setup?.missing?.length ? `Missing: ${state.setup.missing.join(', ')}.` : 'Could not check the RVC engine.';
}

function renderVoices() {
  const select = $('#voiceSelect');
  const old = state.selectedId;
  const saved = localStorage.getItem('dnax-active-voice');
  select.replaceChildren();
  if (!state.voices.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No voice profiles yet';
    select.append(option);
    state.selectedId = '';
  } else {
    for (const voice of state.voices) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = `${voice.name}${voice.trained ? ' · trained' : ''}`;
      select.append(option);
    }
    const preferred = [old, saved, [...state.voices].reverse().find(voice => voice.trained)?.id]
      .find(id => state.voices.some(voice => voice.id === id));
    state.selectedId = preferred || state.voices[0].id;
    select.value = state.selectedId;
  }
  renderCurrentVoice();
}

function renderCurrentVoice() {
  const voice = selectedVoice();
  const summary = $('#voiceSummary');
  summary.classList.toggle('empty', !voice);
  summary.lastElementChild.textContent = voice ? `${voice.samples.length} recording${voice.samples.length === 1 ? '' : 's'} · ${voice.trained ? 'Model ready for conversion' : 'Model not trained yet'}` : 'Create a profile to begin.';
  $('#sampleCount').textContent = `${voice?.samples.length || 0} FILE${voice?.samples.length === 1 ? '' : 'S'}`;
  $('#modelBadge').textContent = voice?.trained ? 'MODEL READY' : 'NOT TRAINED';
  $('#modelBadge').classList.toggle('trained', !!voice?.trained);
  const target = $('#targetVoice');
  target.querySelector('strong').textContent = voice?.name || 'No voice selected';
  target.querySelector('small').textContent = voice ? (voice.trained ? 'RVC model ready' : 'Train this voice to convert') : 'Choose and train a profile first';
  target.querySelector('.target-status').textContent = voice?.trained ? 'READY' : '—';
  target.querySelector('.target-status').classList.toggle('ready', !!voice?.trained);
  renderSamples();
  renderJob();
  renderButtons();
}

function renderSamples() {
  const list = $('#sampleList');
  list.replaceChildren();
  const voice = selectedVoice();
  if (!voice?.samples.length) {
    const item = document.createElement('li');
    item.className = 'empty-list';
    item.textContent = voice ? 'Add your first voice recording.' : 'Your recordings will appear here.';
    list.append(item);
    return;
  }
  for (const sample of voice.samples) {
    const item = document.createElement('li');
    item.className = 'sample-item';
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'sample-icon icon-button';
    play.title = `Play ${sample.name}`;
    play.setAttribute('aria-label', `Play ${sample.name}`);
    play.innerHTML = '<svg><use href="#i-play"/></svg>';
    play.addEventListener('click', () => {
      state.playing?.pause();
      state.playing = new Audio(`/api/voices/${voice.id}/samples/${sample.id}`);
      state.playing.play().catch(() => toast('Could not play this recording.'));
    });
    const info = document.createElement('div');
    info.className = 'sample-info';
    const name = document.createElement('strong');
    name.textContent = sample.name;
    const size = document.createElement('small');
    size.textContent = formatBytes(sample.bytes);
    info.append(name, size);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button';
    remove.title = `Remove ${sample.name}`;
    remove.setAttribute('aria-label', `Remove ${sample.name}`);
    remove.innerHTML = '<svg><use href="#i-trash"/></svg>';
    remove.disabled = !!runningJob();
    remove.addEventListener('click', async () => {
      try {
        await api(`/api/voices/${voice.id}/samples/${sample.id}`, { method: 'DELETE' });
        await refreshVoices();
        await refreshResources();
      } catch (error) { toast(error.message); }
    });
    item.append(play, info, remove);
    list.append(item);
  }
}

function renderButtons() {
  const voice = selectedVoice();
  const busy = !!runningJob() || state.uploading;
  const ready = !!state.setup?.ready;
  $('#trainButton').disabled = !ready || !voice?.samples.length || busy;
  $('#convertButton').disabled = !ready || !voice?.trained || !state.source || busy;
  $('#previewButton').disabled = !ready || !voice?.trained || !state.source || busy;
  $('#voiceSelect').disabled = busy;
  $('#sampleFiles').disabled = !voice || busy;
  $('#sourceFile').disabled = busy;
  $('#trainHint').textContent = !ready ? 'Run setup.ps1 to install RVC before training.' : !voice ? 'Create a voice profile and add recordings to start.' : !voice.samples.length ? 'Add your own voice recordings to begin.' : busy ? 'Wait for the current job to finish.' : voice.trained ? 'Train again to update this model with your recordings.' : 'Your recordings are ready for training.';
  $('#convertHint').textContent = !ready ? 'Run setup.ps1 to install the conversion engine.' : !voice?.trained ? 'Train a voice model before converting.' : !state.source ? 'Choose a source audio file to convert.' : busy ? 'Wait for the current job to finish.' : 'Ready to convert.';
  $('#previewButton').lastChild.textContent = state.previewId && !state.previewJobId ? ' Rebuild voice preview' : ' Build voice preview';
}

async function refreshVoices() {
  state.voices = await api('/api/voices');
  renderVoices();
}

async function refreshSetup() {
  state.setup = await api('/api/status');
  renderSetup();
  renderButtons();
}

const waveformCache = new Map();
let waveformDrawId = 0;
async function drawWaveform(url) {
  const drawId = ++waveformDrawId;
  const canvas = $('#resultWaveform');
  const width = canvas.clientWidth || 500;
  const height = canvas.clientHeight || 70;
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = getComputedStyle(document.body).getPropertyValue('--panel-soft').trim();
  context.fillRect(0, 0, width, height);
  if (!url) return;
  let peaks = waveformCache.get(url);
  if (!peaks) {
    try {
      const bytes = await (await fetch(url)).arrayBuffer();
      const audioContext = new AudioContext();
      const decoded = await audioContext.decodeAudioData(bytes);
      const channel = decoded.getChannelData(0);
      peaks = new Float32Array(512);
      for (let i = 0; i < peaks.length; i++) {
        const start = Math.floor(i * channel.length / peaks.length);
        const end = Math.floor((i + 1) * channel.length / peaks.length);
        const stride = Math.max(1, Math.floor((end - start) / 128));
        let max = 0, energy = 0, count = 0;
        for (let j = start; j < end; j += stride) {
          const level = Math.abs(channel[j]);
          max = Math.max(max, level);
          energy += level * level;
          count++;
        }
        peaks[i] = Math.max(max * 0.75, Math.sqrt(energy / Math.max(1, count)) * 1.6);
      }
      waveformCache.set(url, peaks);
      await audioContext.close();
    } catch { return; }
  }
  if (drawId !== waveformDrawId) return;
  context.fillStyle = getComputedStyle(document.body).getPropertyValue('--text').trim();
  const barWidth = width < 420 ? 2 : 3;
  const gap = 2;
  const barCount = Math.max(1, Math.floor((width + gap) / (barWidth + gap)));
  const sorted = Array.from(peaks).sort((a, b) => a - b);
  const fullScale = Math.max(0.01, sorted[Math.floor(sorted.length * 0.96)]);
  for (let i = 0; i < barCount; i++) {
    const start = Math.floor(i * peaks.length / barCount);
    const end = Math.max(start + 1, Math.floor((i + 1) * peaks.length / barCount));
    let peak = 0;
    for (let j = start; j < end; j++) peak = Math.max(peak, peaks[j]);
    const barHeight = Math.max(3, Math.round(Math.min(1, peak / fullScale) * (height - 14)));
    const x = Math.round((i + 0.5) * width / barCount - barWidth / 2);
    context.fillRect(x, Math.floor((height - barHeight) / 2), barWidth, barHeight);
  }
}

let waveformResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(waveformResizeTimer);
  waveformResizeTimer = setTimeout(() => drawWaveform($('#resultAudio').getAttribute('src')), 100);
});

function listenTo(mode, url, resetTime = false) {
  if (!url) return;
  const player = $('#resultAudio');
  const time = resetTime ? 0 : player.currentTime || 0;
  const wasPlaying = !player.paused;
  state.listening = mode;
  $('#listenOriginal').classList.toggle('active', mode === 'original');
  $('#listenEnhanced').classList.toggle('active', mode === 'enhanced');
  $('#listenStudio').classList.toggle('active', mode === 'studio');
  $('#listenOriginal').setAttribute('aria-pressed', mode === 'original');
  $('#listenEnhanced').setAttribute('aria-pressed', mode === 'enhanced');
  $('#listenStudio').setAttribute('aria-pressed', mode === 'studio');
  if (player.getAttribute('src') !== url) {
    player.src = url;
    player.addEventListener('loadedmetadata', () => {
      player.currentTime = Math.min(time, Math.max(0, player.duration - 0.2));
      if (wasPlaying) player.play().catch(() => {});
    }, { once: true });
    drawWaveform(url);
  }
}

async function prepareOriginal(job) {
  if (state.originalExportJobId === job.id) return;
  state.originalExportJobId = job.id;
  state.originalUrl = '';
  state.originalMp3Url = '';
  $('#downloadResult').classList.add('hidden');
  $('#downloadResultMp3').classList.add('hidden');
  $('#originalExportStatus').textContent = 'Preparing stereo WAV and MP3…';
  try {
    const result = await postJson(`${job.resultUrl}/export`, {});
    if (state.originalExportJobId !== job.id) return;
    state.originalUrl = result.resultUrl;
    state.originalMp3Url = result.mp3Url;
    $('#downloadResult').href = `${result.resultUrl}?download`;
    $('#downloadResultMp3').href = `${result.mp3Url}?download`;
    $('#downloadResult').classList.remove('hidden');
    $('#downloadResultMp3').classList.remove('hidden');
    $('#originalExportStatus').textContent = '';
    if (state.listening === 'original') listenTo('original', result.resultUrl);
  } catch (error) { $('#originalExportStatus').textContent = error.message; }
}

function renderJob() {
  const job = state.jobs[0];
  $('#resultPanel').classList.add('hidden');
  const activity = $('#activityState');
  activity.className = `activity-state ${job?.state || ''}`;
  activity.textContent = job?.state?.toUpperCase() || 'IDLE';
  $('#activityEmpty').classList.toggle('hidden', !!job);
  $('#jobPanel').classList.toggle('hidden', !job);
  if (!job) return;
  $('#jobTitle').textContent = job.kind === 'train' ? 'Training voice model' : job.kind === 'preview' ? 'Building voice preview' : 'Converting audio';
  $('#jobStage').textContent = job.error || job.stage;
  $('#jobLogs').textContent = job.logs.length ? job.logs.slice(-35).join('\n') : 'Waiting for RVC output…';
  $('#cancelJob').classList.toggle('hidden', job.state !== 'running');
  const converted = state.jobs.find(item => item.kind === 'convert' && item.state === 'completed' && item.resultUrl);
  $('#openEnhancer').classList.toggle('hidden', !converted);
  $('#enhancerEmpty').classList.toggle('hidden', !!converted);
  $('#crispButton').disabled = !converted;
  if (converted) {
    const job = converted;
    if (state.enhanceSourceJobId !== job.id) {
      state.enhanceSourceJobId = job.id;
      state.enhancedUrl = '';
      state.fullEnhancedUrl = '';
      state.enhancementId = '';
      state.originalExportJobId = '';
      state.studioUrl = '';
      $('#listenStudio').disabled = true;
      $('#crispResult').classList.add('hidden');
      $('#crispStatus').textContent = 'Optional finish is ready for this cloned output.';
      state.listening = 'original';
      $('#listenEnhanced').disabled = true;
      $('#listenOriginal').classList.add('active');
      $('#listenEnhanced').classList.remove('active');
      $('#enhanceEnabled').checked = false;
      $('#enhanceControls').classList.add('hidden');
      $('#enhancedPanel').classList.add('hidden');
      $('#enhanceStrength').value = '100';
      $('#enhanceStrengthValue').textContent = '100%';
      $('#enhanceStatus').textContent = 'Start enhancement to create a clean speech track.';
      try {
        const saved = JSON.parse(localStorage.getItem(`voiceStudioEnhancement:${job.id}`) || 'null');
        if (saved?.sourceUrl === job.resultUrl && /^[a-f0-9]{16}$/.test(saved.enhancementId) &&
            /^\/api\/outputs\/[a-f0-9]{16}\.wav$/.test(saved.resultUrl)) {
          state.enhancementId = saved.enhancementId;
          state.enhancedUrl = saved.resultUrl;
          state.fullEnhancedUrl = saved.resultUrl;
          state.enhancedMp3Url = saved.mp3Url;
          $('#enhanceEnabled').checked = true;
          $('#enhanceControls').classList.remove('hidden');
          $('#enhancedPanel').classList.remove('hidden');
          $('#listenEnhanced').disabled = false;
          $('#enhanceStrength').value = String(saved.strength);
          $('#enhanceStrengthValue').textContent = `${saved.strength}%`;
          $('#separateMusic').checked = saved.separateMusic;
          $('#mixMusic').disabled = !saved.separateMusic;
          for (const key of ['speech', 'music', 'background']) {
            const id = `mix${key[0].toUpperCase()}${key.slice(1)}`;
            $(`#${id}`).value = String(saved.levels[key]);
            $(`#${id}Value`).textContent = `${saved.levels[key]}%`;
          }
          $('#downloadEnhanced').href = `${saved.resultUrl}?download`;
          $('#downloadEnhancedMp3').href = `${saved.mp3Url}?download`;
          $('#enhancePreviewStart').max = String(Math.max(0, Math.floor(saved.duration - 1)));
          $('#enhanceStatus').textContent = 'Enhanced audio restored. Compare Original and Enhanced above.';
        }
      } catch { /* Saved session may be from an older app version. */ }
    }
    const player = $('#resultAudio');
    if (player.dataset.jobId !== job.id) {
      player.src = job.resultUrl;
      player.dataset.jobId = job.id;
      drawWaveform(job.resultUrl);
    }
    prepareOriginal(job);
    $('#resultPanel').classList.remove('hidden');
  }
}

let previousJobState = '';
async function refreshJobs() {
  const jobs = await api('/api/jobs');
  state.jobs = jobs;
  renderJob();
  renderButtons();
  const current = jobs[0];
  const key = current ? `${current.id}:${current.state}` : '';
  if (current?.state === 'completed' && key !== previousJobState && current.kind === 'train') await refreshVoices();
  if (current?.state === 'completed' && key !== previousJobState && current.kind === 'convert') await refreshResources();
  if (current?.kind === 'preview' && current.id === state.previewJobId && current.state !== 'running') {
    state.previewJobId = '';
    if (state.previewFingerprint !== previewKey()) invalidatePreview();
    else if (current.state === 'completed') schedulePreviewEffects(0);
    else previewStatus(current.error || 'Could not build the preview. Try a different start time.');
  }
  if (current?.state === 'failed' && key !== previousJobState) toast(current.error || 'RVC job failed. Check Activity for details.');
  previousJobState = key;
  if (!runningJob() && state.source && selectedVoice()?.trained && state.previewFingerprint !== previewKey()) scheduleBasePreview(500);
}

function allowDrop(label, handle) {
  label.addEventListener('dragover', event => { event.preventDefault(); label.classList.add('dragging'); });
  label.addEventListener('dragleave', () => label.classList.remove('dragging'));
  label.addEventListener('drop', event => { event.preventDefault(); label.classList.remove('dragging'); handle(event.dataTransfer.files); });
  label.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); label.querySelector('input').click(); } });
}

async function uploadSamples(files) {
  const voice = selectedVoice();
  if (!voice) return toast('Create or select a voice profile first.');
  if (!files?.length) return;
  state.uploading = true;
  renderButtons();
  try {
    for (const [index, file] of [...files].entries()) {
      if (file.size > 250 * 1024 * 1024) throw new Error(`${file.name} is larger than 250 MB.`);
      $('#sampleCount').textContent = `UPLOADING ${index + 1}/${files.length}`;
      await api(`/api/voices/${voice.id}/samples?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    }
    await refreshVoices();
    await refreshResources();
  } catch (error) { toast(error.message); }
  finally { state.uploading = false; $('#sampleFiles').value = ''; renderButtons(); }
}

function chooseSource(files) {
  const file = files?.[0];
  if (!file) return;
  if (runningJob()) return toast('Wait for the current voice job to finish before changing the source.');
  if (file.size > 250 * 1024 * 1024) return toast('Source audio is larger than 250 MB.');
  invalidatePreview();
  state.source = file;
  state.sourceVersion++;
  if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
  state.sourceUrl = URL.createObjectURL(file);
  $('#sourcePreview').src = state.sourceUrl;
  $('#sourcePreview').classList.remove('hidden');
  $('#sourceTitle').textContent = file.name;
  $('#sourceSubtitle').textContent = formatBytes(file.size);
  $('#resultPanel').classList.add('hidden');
  renderButtons();
  scheduleBasePreview(350);
}

$('#createVoiceForm').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('#voiceName');
  try {
    const voice = await postJson('/api/voices', { name: input.value });
    input.value = '';
    await refreshVoices();
    state.selectedId = voice.id;
    localStorage.setItem('dnax-active-voice', voice.id);
    $('#voiceSelect').value = voice.id;
    renderCurrentVoice();
  } catch (error) { toast(error.message); }
});

$('#voiceSelect').addEventListener('change', event => { invalidatePreview(); state.selectedId = event.target.value; localStorage.setItem('dnax-active-voice', state.selectedId); renderCurrentVoice(); scheduleBasePreview(350); });
$('#sampleFiles').addEventListener('change', event => uploadSamples(event.target.files));
allowDrop($('#sampleDrop'), uploadSamples);
$('#sourceFile').addEventListener('change', event => chooseSource(event.target.files));
allowDrop($('#sourceDrop'), chooseSource);

$('#pitch').addEventListener('input', event => { const value = Number(event.target.value); $('#pitchValue').textContent = `${value > 0 ? '+' : ''}${value} semitones`; scheduleBasePreview(); });
$('#indexRate').addEventListener('input', event => { $('#indexValue').textContent = `${event.target.value}%`; scheduleBasePreview(); });
for (const selector of ['#f0Method', '#previewStart', '#previewDuration']) $(selector).addEventListener('change', () => scheduleBasePreview());
$('#previewStart').addEventListener('input', () => scheduleBasePreview(900));
$('#sourcePreview').addEventListener('loadedmetadata', event => {
  const duration = event.target.duration;
  if (Number.isFinite(duration)) $('#previewStart').max = String(Math.max(0, Math.floor(duration - 1)));
});

$('#fxEnabled').addEventListener('change', () => {
  $('#fxControls').classList.toggle('hidden', !$('#fxEnabled').checked);
  schedulePreviewEffects();
});
$('#autoTune').addEventListener('change', () => {
  $('#tuneControls').classList.toggle('hidden', !$('#autoTune').checked);
  schedulePreviewEffects();
});
$('#fxPreset').addEventListener('change', event => {
  const preset = presets[event.target.value];
  if (preset) {
    state.fxHighpass = preset.highpass;
    for (const [key, id] of Object.entries(fxFields)) $(`#${id}`).value = preset[key];
    updateFxLabels();
  }
  schedulePreviewEffects();
});
for (const id of [...Object.values(fxFields), 'tuneStrength']) {
  $(`#${id}`).addEventListener('input', () => {
    if (id !== 'tuneStrength') $('#fxPreset').value = 'custom';
    updateFxLabels();
    schedulePreviewEffects();
  });
}
for (const id of ['tuneKey', 'tuneScale']) $(`#${id}`).addEventListener('change', () => schedulePreviewEffects());
$('#previewButton').addEventListener('click', () => buildPreview(true).catch(error => toast(error.message)));

$('#enhanceEnabled').addEventListener('change', () => {
  $('#enhanceControls').classList.toggle('hidden', !$('#enhanceEnabled').checked);
  if (!$('#enhanceEnabled').checked) listenTo('original', state.originalUrl || state.jobs.find(job => job.id === state.enhanceSourceJobId)?.resultUrl);
});
for (const id of ['enhanceStrength', 'mixSpeech', 'mixMusic', 'mixBackground']) {
  $(`#${id}`).addEventListener('input', event => {
    $(`#${id}Value`).textContent = `${event.target.value}%`;
    if (id === 'enhanceStrength') {
      state.enhancementId = '';
      $('#enhancedPanel').classList.add('hidden');
      $('#listenEnhanced').disabled = true;
      $('#enhanceStatus').textContent = 'Rebuild enhancement to apply this cleanup strength.';
    } else scheduleMixPreview();
  });
}
$('#separateMusic').addEventListener('change', () => {
  state.enhancementId = '';
  $('#enhancedPanel').classList.add('hidden');
  $('#listenEnhanced').disabled = true;
  $('#enhanceStatus').textContent = 'Rebuild enhancement to update music separation.';
});
$('#enhancePreviewStart').addEventListener('change', () => scheduleMixPreview());
$('#listenOriginal').addEventListener('click', () => listenTo('original', state.originalUrl || state.jobs.find(job => job.id === state.enhanceSourceJobId)?.resultUrl));
$('#listenEnhanced').addEventListener('click', () => listenTo('enhanced', state.enhancedUrl));
$('#listenStudio').addEventListener('click', () => listenTo('studio', state.studioUrl));
$('#resultWaveform').addEventListener('click', event => {
  const player = $('#resultAudio');
  if (Number.isFinite(player.duration)) player.currentTime = (event.offsetX / event.currentTarget.clientWidth) * player.duration;
});

function mixLevels() {
  return { speech: Number($('#mixSpeech').value), music: Number($('#mixMusic').value), background: Number($('#mixBackground').value) };
}

let mixTimer;
function scheduleMixPreview() {
  if (!state.enhancementId) return;
  $('#mixStatus').textContent = 'Updating eight second preview…';
  $('#downloadEnhanced').classList.add('hidden');
  $('#downloadEnhancedMp3').classList.add('hidden');
  clearTimeout(mixTimer);
  const seq = ++state.mixSeq;
  mixTimer = setTimeout(async () => {
    const session = state.enhancementId;
    try {
      const result = await postJson(`/api/enhancements/${session}/mix`, { ...mixLevels(), preview: true, previewStart: Number($('#enhancePreviewStart').value) || 0 });
      if (state.enhancementId !== session || state.mixSeq !== seq) return;
      state.enhancedUrl = result.resultUrl;
      $('#listenEnhanced').disabled = false;
      listenTo('enhanced', result.resultUrl, true);
      $('#mixStatus').textContent = 'Preview updated. Render the full mix to download.';
    } catch (error) { if (state.mixSeq === seq) $('#mixStatus').textContent = error.message; }
  }, 350);
}

$('#enhanceButton').addEventListener('click', async () => {
  const job = state.jobs.find(item => item.id === state.enhanceSourceJobId);
  const filename = /^\/api\/outputs\/([a-f0-9]{16}\.wav)$/.exec(job?.resultUrl || '')?.[1];
  if (!filename || state.enhancing) return;
  const strength = Number($('#enhanceStrength').value);
  const separateMusic = $('#separateMusic').checked;
  state.enhancing = true;
  $('#enhanceButton').disabled = true;
  $('#enhanceStatus').textContent = 'Separating tracks and enhancing speech locally. The first pass may take a minute…';
  try {
    const result = await postJson(`/api/outputs/${filename}/enhance`, { strength, separateMusic, ...mixLevels() });
    if (state.enhanceSourceJobId !== job.id) return;
    state.enhancementId = result.enhancementId;
    state.enhancedUrl = result.resultUrl;
    state.fullEnhancedUrl = result.resultUrl;
    state.enhancedMp3Url = result.mp3Url;
    state.studioUrl = '';
    $('#listenStudio').disabled = true;
    $('#crispResult').classList.add('hidden');
    $('#mixMusic').disabled = !separateMusic;
    $('#enhancePreviewStart').max = String(Math.max(0, Math.floor(result.duration - 1)));
    $('#downloadEnhanced').href = `${result.resultUrl}?download`;
    $('#downloadEnhancedMp3').href = `${result.mp3Url}?download`;
    $('#downloadEnhanced').classList.remove('hidden');
    $('#downloadEnhancedMp3').classList.remove('hidden');
    $('#stemLinks').replaceChildren();
    $('#stemLinks').classList.add('hidden');
    $('#stemStatus').textContent = '';
    $('#listenEnhanced').disabled = false;
    $('#enhancedPanel').classList.remove('hidden');
    listenTo('enhanced', result.resultUrl);
    $('#enhanceStatus').textContent = 'Enhanced audio ready. Switch between Original and Enhanced above.';
    $('#mixStatus').textContent = 'Move a slider to hear a new eight second mix.';
    localStorage.setItem(`voiceStudioEnhancement:${job.id}`, JSON.stringify({
      sourceUrl: job.resultUrl, enhancementId: result.enhancementId, resultUrl: result.resultUrl,
      mp3Url: result.mp3Url, strength, separateMusic, levels: mixLevels(), duration: result.duration
    }));
  } catch (error) { $('#enhanceStatus').textContent = error.message; }
  finally { state.enhancing = false; $('#enhanceButton').disabled = false; }
});
$('#prepareStems').addEventListener('click', async () => {
  const session = state.enhancementId;
  if (!session) return;
  const button = $('#prepareStems');
  button.disabled = true;
  $('#stemStatus').textContent = 'Preparing separate stereo tracks…';
  try {
    const result = await postJson(`/api/enhancements/${session}/stems/export`, {});
    if (state.enhancementId !== session) return;
    const container = $('#stemLinks');
    container.replaceChildren();
    for (const [name, urls] of Object.entries(result.stems)) {
      const row = document.createElement('div');
      row.className = 'stem-link-row';
      const title = document.createElement('strong');
      title.textContent = name[0].toUpperCase() + name.slice(1);
      row.append(title);
      for (const [format, link] of Object.entries(urls)) {
        const anchor = document.createElement('a');
        anchor.className = 'download-link';
        anchor.textContent = format.toUpperCase();
        anchor.href = `${link}?download`;
        anchor.download = '';
        row.append(anchor);
      }
      container.append(row);
    }
    container.classList.remove('hidden');
    $('#stemStatus').textContent = 'Separate tracks are ready.';
  } catch (error) { $('#stemStatus').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#renderEnhanced').addEventListener('click', async () => {
  const session = state.enhancementId;
  if (!session) return;
  const button = $('#renderEnhanced');
  button.disabled = true;
  $('#mixStatus').textContent = 'Rendering the full stereo WAV and MP3…';
  try {
    const result = await postJson(`/api/enhancements/${session}/mix`, { ...mixLevels(), preview: false });
    if (state.enhancementId !== session) return;
    state.enhancedUrl = result.resultUrl;
    state.fullEnhancedUrl = result.resultUrl;
    state.enhancedMp3Url = result.mp3Url;
    state.studioUrl = '';
    $('#listenStudio').disabled = true;
    $('#crispResult').classList.add('hidden');
    const job = state.jobs.find(item => item.id === state.enhanceSourceJobId);
    if (job) {
      try {
        const previous = JSON.parse(localStorage.getItem(`voiceStudioEnhancement:${job.id}`) || 'null');
        if (previous?.enhancementId === session) {
          previous.resultUrl = result.resultUrl;
          previous.mp3Url = result.mp3Url;
          previous.levels = mixLevels();
          localStorage.setItem(`voiceStudioEnhancement:${job.id}`, JSON.stringify(previous));
        }
      } catch { /* A stale session can be discarded. */ }
    }
    $('#downloadEnhanced').href = `${result.resultUrl}?download`;
    $('#downloadEnhancedMp3').href = `${result.mp3Url}?download`;
    $('#downloadEnhanced').classList.remove('hidden');
    $('#downloadEnhancedMp3').classList.remove('hidden');
    listenTo('enhanced', result.resultUrl);
    $('#mixStatus').textContent = 'Full mix ready in stereo WAV and MP3.';
  } catch (error) { $('#mixStatus').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#trainButton').addEventListener('click', async () => {
  const voice = selectedVoice();
  if (!voice) return;
  try {
    await postJson('/api/train', { voiceId: voice.id, epochs: Number($('#epochs').value), batch: Number($('#batch').value) });
    await refreshJobs();
  } catch (error) { toast(error.message); }
});

$('#convertButton').addEventListener('click', async () => {
  const voice = selectedVoice();
  if (!voice || !state.source) return;
  const fileName = state.source.name.replace(/[^\x20-\x7e]/g, '_');
  try {
    $('#resultPanel').classList.add('hidden');
    await api('/api/convert', { method: 'POST', headers: { 'Content-Type': state.source.type || 'application/octet-stream', 'X-Voice-Id': voice.id, 'X-File-Name': fileName, 'X-Pitch': $('#pitch').value, 'X-Index-Rate': String(Number($('#indexRate').value) / 100), 'X-F0-Method': $('#f0Method').value, 'X-FX-Settings': encodeURIComponent(JSON.stringify(readFxSettings())) }, body: state.source });
    await refreshJobs();
  } catch (error) { toast(error.message); }
});

$('#cancelJob').addEventListener('click', async () => {
  const job = runningJob();
  if (!job) return;
  try { await api(`/api/jobs/${job.id}`, { method: 'DELETE' }); await refreshJobs(); }
  catch (error) { toast(error.message); }
});

const tabs = { video: '#videoView', cloner: '#clonerView', enhancer: '#enhancerView', resources: '#resourcesView' };
function showTab(name) {
  const tab = tabs[name] ? name : ({ convert: 'cloner', workspace: 'cloner', activity: 'resources' }[name] || 'video');
  for (const [key, selector] of Object.entries(tabs)) $(selector).classList.toggle('hidden', key !== tab);
  document.querySelectorAll('.nav-link[data-tab]').forEach(link => {
    const current = link.dataset.tab === tab;
    link.classList.toggle('active', current);
    if (current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (tab === 'enhancer') requestAnimationFrame(() => drawWaveform($('#resultAudio').getAttribute('src')));
}

function setTheme(theme) {
  const mode = theme === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = mode;
  localStorage.setItem('dnax-audio-theme', mode);
  $('#themeToggle span').textContent = mode === 'dark' ? 'Light theme' : 'Dark theme';
  $('#themeToggle').setAttribute('aria-label', `Switch to ${mode === 'dark' ? 'light' : 'dark'} theme`);
  $('#themeToggle use').setAttribute('href', mode === 'dark' ? '#i-sun' : '#i-moon');
  drawWaveform($('#resultAudio').getAttribute('src'));
}

function setupShell() {
  $('#enhancerMount').append($('#resultPanel'));
  $('#activityMount').append($('#activity'));
  setTheme(localStorage.getItem('dnax-audio-theme') || 'dark');
  showTab(location.hash.slice(1));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
  $('#themeToggle').addEventListener('click', () => setTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('#openEnhancer').addEventListener('click', () => { location.hash = 'enhancer'; });
}

let selectedVideo = null;
let extractedAudio = null;
$('#videoFile').addEventListener('change', event => {
  selectedVideo = event.target.files?.[0] || null;
  $('#videoFileName').textContent = selectedVideo?.name || 'Choose a video';
  $('#videoConvertButton').disabled = !selectedVideo;
  $('#videoStatus').textContent = selectedVideo ? `${formatBytes(selectedVideo.size)} ready to extract.` : 'Choose a video to begin.';
});
$('#videoFormat').addEventListener('change', event => { $('#videoBitrate').disabled = event.target.value === 'wav'; });
$('#videoConvertButton').addEventListener('click', async () => {
  if (!selectedVideo) return;
  if (selectedVideo.size > 1024 * 1024 * 1024) return toast('Video exceeds the 1 GB limit.');
  const button = $('#videoConvertButton');
  button.disabled = true;
  $('#videoStatus').textContent = 'Uploading video and extracting its audio track…';
  $('#videoResult').classList.add('hidden');
  try {
    const result = await api('/api/video/extract', { method: 'POST',
      headers: { 'Content-Type': selectedVideo.type || 'application/octet-stream',
        'X-File-Name': selectedVideo.name.replace(/[^\x20-\x7e]/g, '_'),
        'X-Format': $('#videoFormat').value, 'X-Bitrate': $('#videoBitrate').value },
      body: selectedVideo });
    extractedAudio = result;
    $('#videoAudio').src = result.url;
    $('#videoDownload').href = `${result.url}?download`;
    $('#videoDownload').textContent = `Download ${result.format.toUpperCase()}`;
    $('#videoResult').classList.remove('hidden');
    $('#videoStatus').textContent = 'Audio extracted and saved to Resources.';
    await refreshResources();
  } catch (error) { $('#videoStatus').textContent = error.message; }
  finally { button.disabled = false; }
});

async function useResourceAsSource(resource) {
  try {
    if (runningJob()) throw new Error('Wait for the current voice job to finish.');
    const response = await fetch(resource.url);
    if (!response.ok) throw new Error('Could not open this local audio resource.');
    const blob = await response.blob();
    if (blob.size > 250 * 1024 * 1024) throw new Error('Audio exceeds the Voice Cloner 250 MB source limit.');
    const extension = resource.format || resource.url.split('.').pop();
    const name = (resource.name || 'source').replace(/\.[^.]+$/, '') + '.' + extension;
    chooseSource([new File([blob], name, { type: blob.type || 'audio/wav' })]);
    location.hash = 'cloner';
    toast('Audio loaded as the Voice Cloner source.');
  } catch (error) { toast(error.message); }
}
$('#videoUseSource').addEventListener('click', () => { if (extractedAudio) useResourceAsSource(extractedAudio); });

function resourceCard(resource, kind) {
  const row = document.createElement('div');
  row.className = 'resource-item';
  const title = document.createElement('strong');
  title.textContent = resource.name;
  const detail = document.createElement('small');
  detail.textContent = [resource.voiceName, resource.format?.toUpperCase(), resource.bytes ? formatBytes(resource.bytes) : ''].filter(Boolean).join(' · ');
  const actions = document.createElement('div');
  actions.className = 'resource-actions';
  const play = document.createElement('button');
  play.type = 'button';
  play.textContent = 'Play';
  play.addEventListener('click', () => {
    state.playing?.pause();
    state.playing = new Audio(resource.url);
    state.playing.play().catch(() => toast('Could not play this audio.'));
  });
  const download = document.createElement('a');
  download.textContent = 'Download';
  download.href = `${resource.url}?download`;
  download.download = '';
  actions.append(play, download);
  if (kind !== 'references') {
    const use = document.createElement('button');
    use.type = 'button';
    use.textContent = 'Use as source';
    use.addEventListener('click', () => useResourceAsSource(resource));
    actions.append(use);
  }
  row.append(title, detail, actions);
  return row;
}

async function refreshResources() {
  const library = await api('/api/resources');
  for (const [kind, selector, count] of [
    ['references', '#referenceResources', '#referenceCount'],
    ['extracted', '#extractedResources', '#extractedCount'],
    ['outputs', '#outputResources', '#outputCount']
  ]) {
    const container = $(selector);
    container.replaceChildren();
    const items = library[kind];
    $(count).textContent = String(items.length);
    if (items.length) items.slice(0, 30).forEach(item => container.append(resourceCard(item, kind)));
    else {
      const empty = document.createElement('p');
      empty.className = 'resource-note';
      empty.textContent = kind === 'references' ? 'No reference recordings yet.' :
        kind === 'extracted' ? 'No video soundtracks yet.' : 'No cloned outputs yet.';
      container.append(empty);
    }
  }
}

$('#crispButton').addEventListener('click', async () => {
  const job = state.jobs.find(item => item.kind === 'convert' && item.state === 'completed' && item.id === state.enhanceSourceJobId);
  const sourceUrl = $('#enhanceEnabled').checked && state.fullEnhancedUrl ? state.fullEnhancedUrl : job?.resultUrl;
  if (!/^\/api\/outputs\/[a-f0-9]{16}\.wav$/.test(sourceUrl || '')) return;
  const button = $('#crispButton');
  button.disabled = true;
  $('#crispStatus').textContent = 'Applying CrispVoice EQ, de-essing, dynamics, and loudness…';
  try {
    const result = await postJson(`${sourceUrl}/crisp`, { preset: $('#crispPreset').value });
    state.studioUrl = result.resultUrl;
    state.studioMp3Url = result.mp3Url;
    $('#crispWav').href = `${result.resultUrl}?download`;
    $('#crispMp3').href = `${result.mp3Url}?download`;
    $('#crispResult').classList.remove('hidden');
    $('#listenStudio').disabled = false;
    listenTo('studio', result.resultUrl);
    $('#crispStatus').textContent = 'Studio finish ready in stereo WAV and MP3.';
  } catch (error) { $('#crispStatus').textContent = error.message; }
  finally { button.disabled = false; }
});

async function init() {
  setupShell();
  try { await Promise.all([refreshVoices(), refreshSetup(), refreshJobs(), refreshResources()]); }
  catch (error) { toast(error.message); }
  setInterval(() => refreshJobs().catch(() => {}), 2000);
  setInterval(() => refreshSetup().catch(() => {}), 15000);
}
init();
