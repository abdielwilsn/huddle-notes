// Live transcript with Chrome's built-in speech recognition. Runs next to recorder.js:
// one recogniser per recorded track, fed the same audio that is being saved.

// Chrome's speech recogniser; older versions only have the webkit-prefixed name.
const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
const LIVE_FATAL = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported', 'phrases-not-supported', 'audio-capture']);

// Chrome wants a full locale ("en-US"); the Whisper setting is often just "en".
function liveLang(s) {
  const nav = navigator.language || 'en-US';
  if (!s.language) return nav;
  return nav.toLowerCase().startsWith(s.language.toLowerCase()) ? nav : s.language;
}

function livePhrases(s) {
  if (typeof SpeechRecognitionPhrase !== 'function') return [];
  return (s.vocabulary || '').split(/[,\n]/).map(w => w.trim()).filter(Boolean).slice(0, 50)
    .map(w => new SpeechRecognitionPhrase(w, 3));
}

// Resolves to null when live transcription can run, or a reason it can't.
async function liveUnavailable(s, lang) {
  if (typeof SR !== 'function') return 'This version of Chrome has no built-in speech recognition';
  const local = s.liveTranscript !== 'cloud';
  // Before on-device support, webkitSpeechRecognition always sent audio to Google.
  if (typeof SR.available !== 'function') return local ? 'This Chrome can only transcribe through Google\'s servers. Choose that in Settings, or update Chrome' : null;
  const state = await SR.available({ langs: [lang], processLocally: local }).catch(() => 'unavailable');
  if (state === 'available') return null;
  if (local && (state === 'downloadable' || state === 'downloading')) {
    return `Chrome's on-device speech for ${lang} isn't installed yet. Open Settings and press Test Chrome transcription to download it`;
  }
  return `Chrome can't transcribe ${lang}${local ? ' on this computer' : ''}`;
}

// Keeps one recogniser running on `track` for the whole call: Chrome ends sessions after
// silence or a few minutes, so it is restarted until stop() is called.
function runRecognizer({ track, lang, local, phrases, onLine, onInterim, onFatal }) {
  let stopped = false, r = null, utterStart = null, restarts = 0;
  const begin = () => {
    if (stopped) return;
    r = new SR();
    Object.assign(r, { lang, continuous: true, interimResults: true });
    if ('processLocally' in r) r.processLocally = local;
    if (local && phrases.length) r.phrases = phrases;
    r.onresult = e => {
      restarts = 0;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i], text = res[0].transcript.trim();
        utterStart ??= Date.now();
        if (res.isFinal) {
          if (text) onLine(text, utterStart, Date.now());
          utterStart = null;
        } else interim += ' ' + text;
      }
      onInterim(interim.trim());
    };
    r.onerror = e => {
      if (!LIVE_FATAL.has(e.error)) return;   // no-speech, network, aborted: onend restarts
      stopped = true;
      onFatal(e.error);
    };
    r.onend = () => {
      if (!stopped) setTimeout(begin, Math.min(5000, 250 * 2 ** Math.min(restarts++, 4)));
    };
    // No track: Chrome listens to the default microphone itself.
    try { track ? r.start(track) : r.start(); } catch (e) { stopped = true; onFatal(e.message); }
  };
  begin();
  return { stop() { stopped = true; try { r?.stop(); } catch {} } };
}

// tracks: { me, them } or { mix } -> MediaStreamTrack. onChange(lines, update) fires on
// every final line ({ line }) and interim update ({ interim: { track, text } }).
async function startLive(meeting, tracks, s, onChange) {
  if (s.liveTranscript === 'off') return null;
  const lang = liveLang(s);
  const reason = await liveUnavailable(s, lang);
  if (reason) return { error: reason, lines: [], stop: async () => {} };

  const local = s.liveTranscript !== 'cloud';
  const phrases = local ? livePhrases(s) : [];
  const lines = [];
  const live = { lines, error: null, engine: local ? 'local' : 'cloud' };
  const clones = [];
  // Chrome's speech service hears nothing from a recorded track, only the microphone itself.
  // So it transcribes the mic: your voice, plus the others' if the call plays through speakers.
  if (!local) tracks = { [tracks.me ? 'me' : 'mix']: null };
  const recs = Object.entries(tracks).map(([key, t]) => {
    const track = t?.clone() || null;       // own copy, so stopping it never touches the recording
    if (track) clones.push(track);
    return runRecognizer({
      track, lang, local, phrases,
      onLine: (text, from, to) => {
        const line = { start: (from - meeting.startedAt) / 1000, end: (to - meeting.startedAt) / 1000, track: key, text };
        lines.push(line);
        onChange(lines, { line });
      },
      onInterim: text => onChange(lines, { interim: { track: key, text } }),
      onFatal: err => { live.error = `Live transcript stopped (${err})`; onChange(lines, { error: live.error }); }
    });
  });
  live.stop = async () => {
    recs.forEach(r => r.stop());
    await new Promise(r => setTimeout(r, 1000));   // let the last words come through
    clones.forEach(t => t.stop());
  };
  return live;
}
