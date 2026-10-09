const $ = s => document.querySelector(s);
let tickTimer = null;

async function bg(type, extra = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...extra });
  if (!r?.ok) throw new Error(r?.error || 'No response from extension');
  return r.result;
}

function fmt(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function note(html, kind = '') {
  const d = document.createElement('div');
  d.className = `note ${kind}`;
  d.innerHTML = html;
  $('#notes').appendChild(d);
  return d;
}

// Chrome hides the URL of tabs it hasn't shared with us; let tabCapture decide those.
function capturable(url) {
  return !url || /^(https?|file):/.test(url);
}

async function render() {
  $('#notes').innerHTML = '';
  clearInterval(tickTimer);
  const [state, settings, [tab]] = await Promise.all([
    bg('state'),
    getSettings(),
    chrome.tabs.query({ active: true, currentWindow: true })
  ]);
  const btn = $('#main');
  btn.disabled = false;

  const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  $('#srcRow').hidden = !!state.recording;

  if (state.recording) {
    const source = state.source || 'tab';
    $('#label').textContent = source === 'tab'
      ? (state.tabId === tab?.id ? 'Recording this tab' : 'Recording another tab')
      : `Recording ${SOURCES[source].toLowerCase()}`;
    $('#tabTitle').textContent = state.title;
    $('#timerWrap').hidden = false;
    const tick = () => { $('#timer').textContent = fmt(Date.now() - state.startedAt); };
    tick(); tickTimer = setInterval(tick, 1000);
    if (settings.liveTranscript !== 'off' && !state.liveError) mountLiveBox($('#liveBox'), state.id, settings);
    btn.textContent = 'Stop & transcribe';
    btn.className = 'rec';
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'Saving…';
      try { await bg('stop'); window.close(); } catch (e) { note(e.message, 'err'); btn.disabled = false; }
    };
    const mode = $('#mode');
    mode.hidden = false;
    const short = { tab: 'Tab', system: 'Computer', device: 'Input' }[source];
    mode.textContent = state.mode === 'separate' ? 'Me / Others' : state.hasMic ? `${short} + mic` : `${short} only`;
    if (settings.liveTranscript !== 'off') {
      if (state.liveError) note(`No live transcript: ${esc(state.liveError)}.`, 'warn');
      else {
        const n = note('<a href="#" id="openLive">Watch the live transcript</a>');
        n.querySelector('#openLive').onclick = e => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?id=${encodeURIComponent(state.id)}`) }); };
      }
    }
    if (state.micLabel) note(`Mic: ${esc(state.micLabel)}`);
    if (state.micError) note(`Mic not recorded: ${state.micError}. <a href="#" id="fixMic">Allow microphone</a> before the next call.`, 'warn');
    if (state.tabId !== tab?.id && state.tabId) {
      const n = note('<a href="#" id="goTab">Go to the recorded tab</a>');
      n.querySelector('#goTab').onclick = e => { e.preventDefault(); chrome.tabs.update(state.tabId, { active: true }); };
    }
  } else {
    const source = settings.source || 'tab';
    const sel = $('#source');
    sel.value = source;
    sel.onchange = async () => { await saveSettings({ source: sel.value }); render().catch(e => note(e.message, 'err')); };
    $('#label').textContent = source === 'tab' ? 'This tab' : SOURCES[source];
    $('#tabTitle').textContent = source === 'tab' ? (tab?.title || 'Current tab')
      : source === 'system' ? 'Zoom, Teams, Slack or any app'
      : (settings.othersLabel || 'No input chosen');
    $('#timerWrap').hidden = true;
    $('#mode').hidden = true;
    btn.textContent = 'Start recording';
    btn.className = 'primary';
    if (source === 'tab' && !capturable(tab?.url)) {
      btn.disabled = true;
      note('Open your meeting tab (Google Meet, Zoom web, Teams…) and click again.', '');
    }
    // With activeTab granted, clicking the icon reveals the tab's URL. No URL means Chrome
    // is still running the old manifest.
    if (source === 'tab' && tab && !tab.url) note('Chrome isn\'t sharing this tab\'s name with Huddle yet. Open <b>chrome://extensions</b>, click ↻ on Huddle Notes, then click the icon again. Recording still works.', 'warn');
    if (source === 'system') note('Chrome will ask what to share: pick <b>Entire screen</b> and turn on <b>Share system audio</b>. Other sounds (music, notifications) get recorded too.');
    if (source === 'device' && !settings.othersDeviceId) {
      btn.disabled = true;
      note('Choose the meeting audio input (e.g. BlackHole) in <a href="#" class="toSettings">Settings</a> first.', 'warn');
    }
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'Starting…';
      try {
        if (source === 'system') {
          await bg('pick-system');   // the capture window takes it from here
          return window.close();
        }
        if (source === 'device') await bg('start', { source });
        else {
          const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
          await bg('start', { source, streamId, tabId: tab.id, title: tab.title, url: tab.url });
        }
        await render();
      } catch (e) {
        note(e.message, 'err');
        btn.disabled = false; btn.textContent = 'Start recording';
      }
    };

    if (settings.useMic) {
      const perm = await navigator.permissions.query({ name: 'microphone' }).catch(() => null);
      if (perm && perm.state !== 'granted') {
        note('Your own voice won\'t be recorded until you <a href="#" id="fixMic">allow the microphone</a> (one-time).', 'warn');
      }
    }
    if (!settings.apiKey) {
      note(settings.finalTranscript === 'live'
        ? 'Chrome writes the transcript. For a summary and action items, add a free Groq key in <a href="#" class="toSettings">Settings</a>.'
        : 'No API key yet — you can record now, but add a free Groq key in <a href="#" class="toSettings">Settings</a> to get transcripts.', settings.finalTranscript === 'live' ? '' : 'warn');
    }
  }

  const fixMic = $('#fixMic');
  if (fixMic) fixMic.onclick = e => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') }); };
  document.querySelectorAll('.toSettings').forEach(a => { a.onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); }; });
}

$('#openMeetings').onclick = e => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') }); };
$('#openSettings').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

render().catch(e => note(e.message, 'err'));
