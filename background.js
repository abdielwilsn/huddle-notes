importScripts('settings.js');

const OFFSCREEN_URL = 'offscreen.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hasOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctxs.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Record the meeting audio and your microphone'
  });
}

async function windowExists(id) {
  return chrome.windows.get(id).then(() => true, () => false);
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

// The recorder page may need a moment to attach its listener after creation.
async function sendRecorder(msg, tries = 20) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ target: 'recorder', ...msg });
      if (res !== undefined) return res;
    } catch (e) { lastErr = e; }
    await sleep(100);
  }
  throw lastErr || new Error('Recorder did not respond');
}

function setBadge(recording) {
  chrome.action.setBadgeText({ text: recording ? 'REC' : '' });
  if (recording) chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
}

async function getState() {
  const { rec } = await chrome.storage.session.get('rec');
  if (rec?.recording && !(rec.windowId ? await windowExists(rec.windowId) : await hasOffscreen())) {
    // Stale state (e.g. extension reloaded mid-recording)
    await chrome.storage.session.remove('rec');
    setBadge(false);
    return { recording: false };
  }
  return rec || { recording: false };
}

function cleanTitle(title, url) {
  let t = (title || '').replace(/\s*[-|–]\s*(Google Meet|Zoom|Microsoft Teams)\s*$/i, '').replace(/^Meet\s*[-–]\s*/i, '').trim();
  if (!t) { try { t = new URL(url).hostname; } catch { t = 'Meeting'; } }
  return t;
}

async function start({ source = 'tab', streamId, tabId, title, url }, sender) {
  const st = await getState();
  if (st.recording) throw new Error('Already recording');
  const settings = await getSettings();
  // A desktop capture only works in the page that asked for it, so computer audio
  // is recorded in the capture window. Everything else records offscreen.
  const windowId = source === 'system' ? sender?.tab?.windowId : undefined;
  if (source === 'system' && !windowId) throw new Error('Computer audio must be started from the capture window');
  if (!windowId) await ensureOffscreen();
  const startedAt = Date.now();
  const time = new Date(startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const meeting = {
    id: crypto.randomUUID(),
    title: source === 'tab' ? cleanTitle(title, url) : `Call at ${time}`,
    url: source === 'tab' ? url : '',
    startedAt
  };
  const res = await sendRecorder({ type: 'start', source, streamId, meeting, settings });
  if (!res?.ok) { if (!windowId) await closeOffscreen(); throw new Error(res?.error || 'Could not start recording'); }
  const rec = { recording: true, id: meeting.id, source, tabId, windowId, title: meeting.title, startedAt, hasMic: res.hasMic, micError: res.micError, micLabel: res.micLabel, liveError: res.liveError, mode: res.mode };
  await chrome.storage.session.set({ rec });
  setBadge(true);
  return rec;
}

let finalizing = null;
async function stop(reason = 'user') {
  if (finalizing) return finalizing;
  finalizing = (async () => {
    const { rec } = await chrome.storage.session.get('rec');
    if (!rec?.recording) return null;
    if (reason === 'user') {
      try { await sendRecorder({ type: 'stop' }, 5); } catch (e) { console.warn('stop failed', e); }
    }
    if (rec.windowId) await chrome.windows.remove(rec.windowId).catch(() => {});
    else await closeOffscreen();
    await chrome.storage.session.remove('rec');
    setBadge(false);
    const settings = await getSettings();
    const q = `id=${encodeURIComponent(rec.id)}${settings.autoProcess ? '&process=1' : ''}`;
    await chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?${q}`) });
    return rec.id;
  })();
  try { return await finalizing; } finally { finalizing = null; }
}

// Computer audio: open a small window that shows Chrome's screen picker and then records.
async function openCaptureWindow() {
  if ((await getState()).recording) throw new Error('Already recording');
  await chrome.windows.create({ url: chrome.runtime.getURL('capture.html'), type: 'popup', width: 460, height: 320, focused: true });
}

// Start with whatever source is set in Settings (keyboard shortcut path).
async function begin(tab) {
  const { source } = await getSettings();
  if (source === 'system') return openCaptureWindow();
  if (source === 'device') return start({ source });
  if (!tab) return;
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  return start({ source, streamId, tabId: tab.id, title: tab.title, url: tab.url });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'recorder') return;
  const handlers = {
    start: () => start(msg, sender),
    'pick-system': () => openCaptureWindow(),
    stop: () => stop('user'),
    state: () => getState(),
    'recording-ended': () => stop(msg.reason || 'ended')
  };
  const h = handlers[msg?.type];
  if (!h) return;
  Promise.resolve().then(h).then(
    result => sendResponse({ ok: true, result }),
    e => sendResponse({ ok: false, error: e?.message || String(e) })
  );
  return true;
});

chrome.commands.onCommand.addListener(async cmd => {
  if (cmd !== 'toggle-recording') return;
  try {
    const st = await getState();
    if (st.recording) return void (await stop('user'));
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await begin(tab);
  } catch (e) {
    console.error(e);
    chrome.action.setBadgeText({ text: 'ERR' });
    chrome.action.setBadgeBackgroundColor({ color: '#71717a' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  }
});

// Closing the capture window ends a computer-audio recording; keep what was saved.
chrome.windows.onRemoved.addListener(async windowId => {
  const { rec } = await chrome.storage.session.get('rec');
  if (rec?.recording && rec.windowId === windowId) stop('window-closed');
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  setBadge(false);
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => setBadge(false));
