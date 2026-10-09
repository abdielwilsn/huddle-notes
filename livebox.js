// Small live-transcript box under the recording timer (popup and capture window).
function mountLiveBox(el, meetingId, s) {
  const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const name = t => (t === 'me' ? s.myName || 'Me' : t === 'them' ? s.othersName || 'Others' : '');
  const lines = [], interim = {}, seen = new Set();
  const add = l => { const k = `${l.track}|${l.start}|${l.text}`; if (!seen.has(k)) { seen.add(k); lines.push(l); } };
  const row = (track, text, cls = '') => `<div class="${cls}">${name(track) ? `<b class="${track === 'me' ? 'me' : ''}">${esc(name(track))}:</b> ` : ''}${esc(text)}</div>`;
  const draw = () => {
    const now = Object.entries(interim).filter(([, t]) => t);
    el.innerHTML = lines.slice(-30).map(l => row(l.track, l.text)).join('')
      + now.map(([k, t]) => row(k, t, 'interim')).join('')
      || '<div class="interim">Listening…</div>';
    el.scrollTop = el.scrollHeight;
  };
  const onLive = msg => {
    if (msg?.type !== 'live' || msg.id !== meetingId) return;
    if (msg.line) { add(msg.line); interim[msg.line.track] = ''; }
    if (msg.interim) interim[msg.interim.track] = msg.interim.text;
    if (msg.error) el.insertAdjacentHTML('beforeend', `<div class="interim">${esc(msg.error)}</div>`);
    else draw();
  };
  chrome.runtime.onMessage.addListener(onLive);
  self.addEventListener('huddle-live', e => onLive(e.detail));
  el.hidden = false;
  draw();
  // Lines said before this page opened.
  DB.getMeeting(meetingId).then(m => {
    const before = m?.live || [];
    const later = lines.splice(0);
    seen.clear();
    before.concat(later).forEach(add);
    draw();
  });
}
