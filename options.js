const $ = s => document.querySelector(s);
const TEXT = ['apiKey', 'baseUrl', 'transcribeModel', 'summaryModel', 'language', 'vocabulary', 'myName', 'othersName', 'segmentMinutes'];
const CHECKS = ['useMic', 'separateSpeakers', 'autoProcess'];

function status(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.style.color = kind === 'err' ? 'var(--rec)' : kind === 'ok' ? 'var(--ok)' : '';
}

const SOURCE_HELP = {
  tab: 'Records only the tab you start from. Works with any headset, no setup.',
  system: 'For desktop apps. Chrome asks what to share each time: pick Entire screen and turn on Share system audio. Other sounds your computer plays get recorded too.',
  device: 'For desktop apps, with a free virtual cable like BlackHole. One-time setup; records only the meeting app\'s sound.'
};

let inputs = [];

function fillDevices(sel, first, saved, savedLabel) {
  sel.innerHTML = '';
  sel.add(new Option(first, ''));
  inputs.forEach((d, i) => sel.add(new Option(d.label || `Input ${i + 1}`, d.deviceId)));
  if (saved && !inputs.some(d => d.deviceId === saved)) sel.add(new Option(`${savedLabel || 'Saved device'} (not connected)`, saved));
  sel.value = saved || '';
}

async function loadDevices(micId, micLabel, othersId, othersLabel) {
  try {
    inputs = (await navigator.mediaDevices.enumerateDevices())
      .filter(d => d.kind === 'audioinput' && d.deviceId && !['default', 'communications'].includes(d.deviceId));
  } catch { inputs = []; }
  fillDevices($('#micDeviceId'), 'System default', micId, micLabel);
  fillDevices($('#othersDeviceId'), 'Choose…', othersId, othersLabel);
  $('#devHelp').hidden = inputs.some(d => d.label);
}

function deviceLabel(id, fallback) {
  return id ? (inputs.find(d => d.deviceId === id)?.label || fallback || '') : '';
}

function showSource(source) {
  $('#sourceHelp').textContent = SOURCE_HELP[source] || '';
  $('#othersRow').hidden = source !== 'device';
}

// Downloads Chrome's language pack if needed (this click counts as the permission Chrome
// wants for that), then transcribes 10 seconds of the microphone.
async function testLive() {
  const btn = $('#liveTest'), say = t => { $('#liveStatus').textContent = t; };
  const f = readForm();
  if (f.liveTranscript === 'off') return say('Live transcript is off. Pick one of the other options first.');
  const lang = liveLang(f), local = f.liveTranscript !== 'cloud';
  if (typeof SR !== 'function') return say('This version of Chrome has no built-in speech recognition.');
  if (local && typeof SR.available !== 'function') return say('This Chrome can only transcribe through Google\'s servers. Pick that option, or update Chrome.');
  btn.disabled = true;
  try {
    let state = typeof SR.available === 'function' ? await SR.available({ langs: [lang], processLocally: local }) : 'available';
    if (local && (state === 'downloadable' || state === 'downloading')) {
      say(`Downloading Chrome's ${lang} speech pack… this can take a few minutes.`);
      const ok = await SR.install({ langs: [lang], processLocally: true });
      state = ok ? 'available' : await SR.available({ langs: [lang], processLocally: true });
    }
    if (state !== 'available') return say(`Chrome can't transcribe ${lang}${local ? ' on this computer' : ''} (${state}).`);
    const mic = await navigator.mediaDevices.getUserMedia({ audio: f.micDeviceId ? { deviceId: { exact: f.micDeviceId } } : true });
    const out = $('#liveOut');
    out.hidden = false; out.textContent = '';
    let done = '';
    say('Listening for 10 seconds — say something…');
    const errors = new Set();
    const live = await startLive({ startedAt: Date.now() }, { mix: mic.getAudioTracks()[0] }, f, (lines, u) => {
      if (u.line) done += u.line.text + ' ';
      if (u.error) { errors.add(u.error); say(u.error); }
      out.textContent = done + (u.interim?.text || '');
    });
    if (live?.error) { say(live.error); mic.getTracks().forEach(t => t.stop()); return; }
    await new Promise(r => setTimeout(r, 10000));
    await live.stop();
    mic.getTracks().forEach(t => t.stop());
    say(done.trim() ? `Done (${local ? 'on this computer' : 'Google'}, ${lang}). Remember to Save.`
      : errors.size ? [...errors].join('; ') : 'Nothing was recognised. Check the microphone, then try again.');
  } catch (e) {
    say(`Failed: ${e.message || e.name || e}`);
  } finally { btn.disabled = false; }
}

function keyHelp(provider) {
  const url = PROVIDERS[provider]?.keyUrl;
  $('#keyHelp').innerHTML = url ? `— get one at <a href="${url}" target="_blank">${new URL(url).host}</a>` : '— leave blank if your server needs none';
}

function readForm() {
  const out = { provider: $('#provider').value };
  for (const k of TEXT) out[k] = $('#' + k).value.trim();
  for (const k of CHECKS) out[k] = $('#' + k).checked;
  out.source = $('#source').value;
  out.liveTranscript = $('#liveTranscript').value;
  out.finalTranscript = $('#finalTranscript').value;
  out.micDeviceId = $('#micDeviceId').value;
  out.othersDeviceId = $('#othersDeviceId').value;
  out.segmentMinutes = Math.min(30, Math.max(2, parseInt(out.segmentMinutes, 10) || 10));
  out.baseUrl = out.baseUrl.replace(/\/+$/, '');
  return out;
}

async function ensureHostPermission(baseUrl) {
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { throw new Error('API base URL is not a valid URL'); }
  if (/^https:\/\/api\.(groq|openai)\.com$/.test(origin)) return;
  const pattern = origin + '/*';
  if (await chrome.permissions.contains({ origins: [pattern] })) return;
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) throw new Error(`Permission to reach ${origin} was not granted`);
}

async function init() {
  const s = await getSettings();
  const sel = $('#provider');
  for (const [k, p] of Object.entries(PROVIDERS)) sel.add(new Option(p.label, k));
  sel.value = s.provider;
  for (const k of TEXT) $('#' + k).value = s[k] ?? '';
  for (const k of CHECKS) $('#' + k).checked = !!s[k];
  keyHelp(s.provider);

  $('#liveTranscript').value = s.liveTranscript;
  $('#finalTranscript').value = s.finalTranscript;
  $('#liveTest').onclick = testLive;
  $('#source').value = s.source;
  showSource(s.source);
  $('#source').onchange = () => showSource($('#source').value);
  await loadDevices(s.micDeviceId, s.micLabel, s.othersDeviceId, s.othersLabel);
  // Plugging in a headset or switching devices refreshes the lists, keeping the current picks.
  navigator.mediaDevices.ondevicechange = async () => {
    const saved = await getSettings();
    await loadDevices($('#micDeviceId').value, saved.micLabel, $('#othersDeviceId').value, saved.othersLabel);
  };
  // Device names only show once the mic is allowed (from the Allow microphone tab).
  const perm = await navigator.permissions.query({ name: 'microphone' }).catch(() => null);
  if (perm) perm.onchange = () => navigator.mediaDevices.ondevicechange();

  sel.onchange = () => {
    const p = PROVIDERS[sel.value];
    $('#baseUrl').value = p.baseUrl;
    $('#transcribeModel').value = p.transcribeModel;
    $('#summaryModel').value = p.summaryModel;
    keyHelp(sel.value);
  };

  $('#save').onclick = async () => {
    try {
      const f = readForm();
      if (f.source === 'device' && !f.othersDeviceId) throw new Error('Choose the meeting audio input, or pick another source');
      if (f.source === 'device' && f.othersDeviceId === f.micDeviceId) throw new Error('The microphone and the meeting audio input must be different devices');
      await ensureHostPermission(f.baseUrl);
      const prev = await getSettings();
      f.micLabel = deviceLabel(f.micDeviceId, prev.micLabel);
      f.othersLabel = deviceLabel(f.othersDeviceId, prev.othersLabel);
      await saveSettings(f);
      status('Saved', 'ok');
    } catch (e) { status(e.message, 'err'); }
  };

  $('#test').onclick = async () => {
    const f = readForm();
    status('Testing…');
    try {
      await ensureHostPermission(f.baseUrl);
      const res = await fetch(f.baseUrl + '/models', { headers: f.apiKey ? { Authorization: `Bearer ${f.apiKey}` } : {} });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
      const ids = ((await res.json()).data || []).map(m => m.id);
      const missing = [f.transcribeModel, f.summaryModel].filter(m => ids.length && !ids.includes(m));
      if (missing.length) status(`Connected, but not found on this account: ${missing.join(', ')}. Pick from: ${ids.slice(0, 12).join(', ')}…`, 'err');
      else status('Connected — both models are available. Remember to Save.', 'ok');
    } catch (e) { status(`Failed: ${e.message}`, 'err'); }
  };

  $('#mic').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
}

init();
