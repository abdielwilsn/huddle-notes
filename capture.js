// Computer-audio recordings: shows Chrome's screen picker and hosts the recorder
// (recorder.js), because a desktop capture only works in the page that asked for it.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function show(html, kind = '') {
  $('#msg').className = `note ${kind}`;
  $('#msg').innerHTML = html;
}

function fmt(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function pick() {
  $('#retry').hidden = true;
  chrome.desktopCapture.chooseDesktopMedia(['screen', 'audio'], async (streamId, opts) => {
    if (!streamId) return window.close();   // picker cancelled
    if (!opts?.canRequestAudioTrack) {
      show('No computer audio was shared. Pick <b>Entire screen</b> and turn on <b>Share system audio</b>. If Chrome doesn\'t offer that switch on this computer, use <b>Audio input</b> (BlackHole) in Settings instead.', 'warn');
      $('#retry').hidden = false;
      return;
    }
    show('Starting…');
    const r = await chrome.runtime.sendMessage({ type: 'start', source: 'system', streamId });
    if (!r?.ok) {
      show(r?.error || 'Could not start recording', 'err');
      $('#retry').hidden = false;
      return;
    }
    const { id, startedAt, micError, micLabel, liveError } = r.result;
    $('#heading').textContent = 'Huddle Notes';
    $('#live').hidden = false;
    $('#stop').hidden = false;
    const tick = () => { $('#timer').textContent = fmt(Date.now() - startedAt); };
    tick(); setInterval(tick, 1000);
    const settings = await getSettings();
    if (settings.liveTranscript !== 'off' && !liveError) mountLiveBox($('#liveBox'), id, settings);
    show(`Keep this window open while the call runs (minimise it if you like). Closing it ends the recording.${
      micError ? `<br>Mic not recorded: ${esc(micError)}.` : micLabel ? `<br>Mic: ${esc(micLabel)}` : ''}`, micError ? 'warn' : '');
  });
}

$('#retry').onclick = pick;
$('#stop').onclick = async () => {
  $('#stop').disabled = true; $('#stop').textContent = 'Saving…';
  await chrome.runtime.sendMessage({ type: 'stop' });   // background closes this window
};

// The part being recorded lives in memory until it's saved, so warn before closing mid-call.
window.addEventListener('beforeunload', e => { if (session && !session.stopping) e.preventDefault(); });

pick();
