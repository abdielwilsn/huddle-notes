const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);
let currentId = params.get('id');
let pane = 'summary';
let progressText = '';
let objectUrls = [];
let liveView = null;   // the transcript pane while it shows Chrome's live lines

const STATUS = {
  recording: 'Recording', recorded: 'Not transcribed', transcribing: 'Transcribing', summarizing: 'Summarising', done: 'Ready', error: 'Failed'
};

async function liveId() {
  try { const r = await chrome.runtime.sendMessage({ type: 'state' }); return r?.result?.recording ? r.result.id : null; } catch { return null; }
}

function slug(s) { return (s || 'meeting').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'meeting'; }
function dateStr(t) { return new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }

function md(src) {
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/^_(.+)_$/g, '<em>$1</em>');
  let html = '', list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  const open = t => { if (list !== t) { close(); html += `<${t}>`; list = t; } };
  for (const raw of String(src || '').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { close(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { close(); const lv = Math.min(4, m[1].length + 1); html += `<h${lv}>${inline(m[2])}</h${lv}>`; continue; }
    if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))) { open('ul'); html += `<li class="task"><input type="checkbox" ${m[1] !== ' ' ? 'checked' : ''}><span>${inline(m[2])}</span></li>`; continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { open('ul'); html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { open('ol'); html += `<li>${inline(m[1])}</li>`; continue; }
    if (/^-{3,}$/.test(line.trim())) { close(); html += '<hr>'; continue; }
    close(); html += `<p>${inline(line)}</p>`;
  }
  close();
  return html;
}

async function loadList() {
  const [meetings, live] = await Promise.all([DB.listMeetings(), liveId()]);
  const list = $('#list');
  if (!meetings.length) {
    list.innerHTML = '<div class="empty">No meetings yet. Open a call in a tab, click the Huddle Notes icon and press <b>Start recording</b>.</div>';
    return meetings;
  }
  list.innerHTML = meetings.map(m => {
    const st = m.id === live ? '<span class="dot live"></span> Recording' : m.status === 'done' ? '' : esc(STATUS[m.status] || m.status);
    return `<div class="item ${m.id === currentId ? 'active' : ''}" data-id="${esc(m.id)}">
      <div class="t">${esc(m.title)}</div>
      <div class="m">${esc(dateStr(m.startedAt))} · ${esc(fmtDur(m.durationMs))}${st ? ` · ${st}` : ''}</div>
    </div>`;
  }).join('');
  list.querySelectorAll('.item').forEach(el => el.onclick = () => select(el.dataset.id));
  return meetings;
}

async function select(id) {
  currentId = id;
  history.replaceState(null, '', id ? `?id=${encodeURIComponent(id)}` : location.pathname);
  document.querySelectorAll('.item').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  if (id && id === (await liveId())) pane = 'transcript';   // a call in progress: show its live text
  await renderDetail();
}

function setProgress(text) {
  progressText = text;
  const el = $('#progress');
  if (el) { el.hidden = !text; el.innerHTML = text ? `<div class="note">${esc(text)}</div>` : ''; }
}

async function run(id, opts) {
  const p = processMeeting(id, opts, t => { if (currentId === id) setProgress(t); });
  await renderDetail(); await loadList();
  await p;
  progressText = '';
  if (currentId === id) await renderDetail();
  await loadList();
}

async function renderDetail() {
  objectUrls.forEach(u => URL.revokeObjectURL(u)); objectUrls = [];
  const box = $('#detail');
  if (!currentId) { box.innerHTML = '<div class="placeholder"><div>Pick a meeting on the left.</div></div>'; return; }
  const m = await DB.getMeeting(currentId);
  if (!m) { box.innerHTML = '<div class="placeholder"><div>That meeting no longer exists.</div></div>'; return; }
  const live = (await liveId()) === m.id;
  const working = busy.has(m.id);
  const interrupted = !working && !live && ['transcribing', 'summarizing', 'recording'].includes(m.status);
  const hasTranscript = !!m.transcript?.length;

  const source = SOURCES[m.source || 'tab'];
  const modeLabel = m.mode === 'separate' ? 'Me / Others' : m.hasMic ? `${source} + mic` : `${source} only`;
  let banner = '';
  if (live) banner = '<div class="note"><span class="dot live"></span> Recording in progress — stop it from the extension icon (or Alt+Shift+R).</div>';
  else if (m.status === 'error') banner = `<div class="note err">${esc(m.error)}</div>`;
  else if (interrupted) banner = '<div class="note warn">Processing was interrupted. Press Transcribe to pick up where it left off.</div>';
  else if (m.micError) banner = `<div class="note warn">Your microphone wasn't recorded (${esc(m.micError)}), so only the other side of the call is here.</div>`;
  if (m.liveError && (live || !hasTranscript)) banner += `<div class="note warn" style="margin-top:8px">No live transcript: ${esc(m.liveError)}.</div>`;

  const canProcess = !live && !working;
  box.innerHTML = `
    <h1><span id="title">${esc(m.title)}</span><button id="rename" title="Rename">Rename</button></h1>
    <div class="meta"><span>${esc(dateStr(m.startedAt))}</span><span>${esc(fmtDur(m.durationMs))}</span><span class="chip">${esc(modeLabel)}</span>${m.url ? `<a class="small muted" href="${esc(m.url)}" target="_blank">open call link</a>` : ''}</div>
    <div id="progress" ${working && progressText ? '' : 'hidden'}>${working && progressText ? `<div class="note">${esc(progressText)}</div>` : ''}</div>
    ${banner ? `<div style="margin-top:16px">${banner}</div>` : ''}
    <div class="actions">
      ${!hasTranscript || m.status === 'error' || interrupted
        ? `<button class="primary" id="go" ${canProcess ? '' : 'disabled'}>${working ? 'Working…' : 'Transcribe & summarise'}</button>`
        : `<button id="copySummary">Copy summary</button><button id="copyTranscript">Copy transcript</button><button id="download">Download .md</button><button id="downloadTxt">Transcript .txt</button>
           <button id="resum" ${canProcess ? '' : 'disabled'}>Redo summary</button><button id="retrans" ${canProcess ? '' : 'disabled'}>Redo transcript</button>`}
      <span class="spacer"></span>
      <button class="danger" id="del" ${live || working ? 'disabled' : ''}>Delete</button>
    </div>
    <div class="tabs">
      <button data-pane="summary">Summary</button>
      <button data-pane="transcript">Transcript${hasTranscript ? ` <span class="chip">${m.transcript.length}</span>` : live || m.live?.length ? ' <span class="chip">live</span>' : ''}</button>
      <button data-pane="audio">Audio</button>
    </div>
    <div class="pane" id="pane"></div>`;

  box.querySelectorAll('.tabs button').forEach(b => {
    b.classList.toggle('on', b.dataset.pane === pane);
    b.onclick = () => { pane = b.dataset.pane; renderDetail(); };
  });

  const on = (sel, fn) => { const el = box.querySelector(sel); if (el) el.onclick = fn; };
  on('#go', () => run(m.id, {}));
  on('#resum', () => run(m.id, { summaryOnly: true }));
  on('#retrans', () => { if (confirm('Re-run speech-to-text on the whole recording?')) run(m.id, { retranscribe: true }); });
  on('#rename', async () => {
    const t = prompt('Meeting name', m.title);
    if (t && t.trim()) { await DB.updateMeeting(m.id, { title: t.trim() }); await renderDetail(); await loadList(); }
  });
  on('#copySummary', e => copy(m.summary || '', e.target));
  on('#copyTranscript', e => copy(transcriptText(m.transcript), e.target));
  on('#download', () => downloadMd(m));
  on('#downloadTxt', () => downloadTxt(m));
  on('#del', async () => {
    if (!confirm(`Delete "${m.title}" and its audio? This can't be undone.`)) return;
    await DB.deleteMeeting(m.id);
    const rest = await loadList();
    await select(rest[0]?.id || null);
  });

  await renderPane(m);
}

async function renderPane(m) {
  const el = $('#pane');
  liveView = null;
  if (pane === 'summary') {
    if (m.summary) el.innerHTML = `<div class="md">${md(m.summary)}</div>`;
    else el.innerHTML = `<p class="muted">${busy.has(m.id) ? 'The summary will appear here when processing finishes.' : 'No summary yet.'}</p>`;
  } else if (pane === 'transcript') {
    const s = await getSettings();
    const recording = (await liveId()) === m.id;
    const showLive = !m.transcript?.length && (m.live?.length || (recording && !m.liveError));
    if (!m.transcript?.length && !showLive) { el.innerHTML = '<p class="muted">No transcript yet.</p>'; return; }
    let lines = showLive ? liveTranscript(m, s) : m.transcript;
    const about = !showLive ? ''
      : `<p class="small muted">Live transcript from Chrome${recording ? ', updating as people talk' : ''}.${s.finalTranscript === 'whisper' ? ' Transcribing replaces it with Whisper\'s more accurate version.' : ''}</p>`;
    el.innerHTML = `${about}<input id="search" type="search" placeholder="Search the transcript"><div id="lines"></div>${recording ? '<div id="interim" class="small muted"></div>' : ''}`;
    const draw = q => {
      const rx = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
      const rows = lines.filter(l => !rx || l.text.match(rx) || (l.speaker || '').match(rx));
      $('#lines').innerHTML = rows.map(l => {
        const text = rx ? esc(l.text).replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), s => `<mark>${s}</mark>`) : esc(l.text);
        return `<div class="line ${l.speaker ? '' : 'nospk'}"><span class="ts">${ts(l.start)}</span>${l.speaker ? `<span class="sp ${l.track === 'me' ? 'me' : ''}">${esc(l.speaker)}</span>` : ''}<span>${text}</span></div>`;
      }).join('') || `<p class="muted">${showLive && !q ? 'Waiting for someone to speak…' : 'No matches.'}</p>`;
    };
    draw('');
    $('#search').oninput = e => draw(e.target.value.trim());
    if (recording) {
      const interim = {};
      liveView = {
        id: m.id,
        line(line) {
          (m.live ||= []).push(line);
          lines = liveTranscript(m, s);
          const main = document.querySelector('main');
          const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 80;
          draw($('#search').value.trim());
          if (atBottom) main.scrollTop = main.scrollHeight;
        },
        interim({ track, text }) {
          interim[track] = text;
          const name = t => (t === 'me' ? s.myName || 'Me' : t === 'them' ? s.othersName || 'Others' : '');
          $('#interim').innerHTML = Object.entries(interim).filter(([, t]) => t)
            .map(([k, t]) => `<div class="line ${name(k) ? '' : 'nospk'}"><span class="ts">…</span>${name(k) ? `<span class="sp ${k === 'me' ? 'me' : ''}">${esc(name(k))}</span>` : ''}<span>${esc(t)}</span></div>`).join('');
        }
      };
    }
  } else {
    const segs = await DB.getSegments(m.id);
    if (!segs.length) { el.innerHTML = '<p class="muted">No audio saved.</p>'; return; }
    const label = t => (t === 'me' ? 'Your mic' : t === 'them' ? SOURCES[m.source || 'tab'] : 'Call');
    el.innerHTML = `<p class="small muted">Saved in parts so long calls stay under the upload limit. ${(segs.reduce((a, s) => a + (s.size || 0), 0) / 1048576).toFixed(1)} MB total, stored only in this browser.</p>` +
      segs.map((s, i) => {
        const url = URL.createObjectURL(s.blob); objectUrls.push(url);
        return `<div class="part"><span class="small" style="width:150px">${label(s.track)} · part ${s.index + 1}<br><span class="muted">${ts(s.startMs / 1000)}–${ts((s.endMs || s.startMs) / 1000)}</span></span><audio controls preload="none" src="${url}"></audio><a class="small" href="${url}" download="${slug(m.title)}-${s.track}-${s.index + 1}.webm">Download</a></div>`;
      }).join('');
  }
}

async function copy(text, btn) {
  await navigator.clipboard.writeText(text);
  const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = old), 1200);
}

function saveFile(text, type, name) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function downloadTxt(m) {
  const body = `${m.title}\r\n${dateStr(m.startedAt)} · ${fmtDur(m.durationMs)}\r\n\r\n${transcriptText(m.transcript).replace(/\n/g, '\r\n')}\r\n`;
  saveFile('\ufeff' + body, 'text/plain;charset=utf-8', `${new Date(m.startedAt).toISOString().slice(0, 10)}-${slug(m.title)}-transcript.txt`);
}

function downloadMd(m) {
  const body = `# ${m.title}\n\n_${dateStr(m.startedAt)} · ${fmtDur(m.durationMs)}_\n\n${m.summary || ''}\n\n---\n\n## Transcript\n\n${transcriptText(m.transcript)}\n`;
  const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${new Date(m.startedAt).toISOString().slice(0, 10)}-${slug(m.title)}.md` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

$('#settings').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

// Live transcript lines from the recorder.
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type !== 'live' || !liveView || msg.id !== liveView.id) return;
  if (msg.line) liveView.line(msg.line);
  if (msg.interim) liveView.interim(msg.interim);
  if (msg.error) renderDetail();
});

// Keep the list fresh when a recording starts or stops elsewhere.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.rec) { loadList(); if (currentId) renderDetail(); }
});

(async () => {
  const meetings = await loadList();
  if (!currentId && meetings[0]) currentId = meetings[0].id;
  await select(currentId);
  if (params.get('process') === '1' && currentId) {
    const m = await DB.getMeeting(currentId);
    if (m && !m.transcript?.length) await run(currentId, {});
  }
})();
