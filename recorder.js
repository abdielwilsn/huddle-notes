// Runs in the offscreen document (tab / audio input) or in the capture window
// (computer audio): captures the meeting audio + mic and writes self-contained
// WebM/Opus parts to IndexedDB every N minutes.
const MIME = 'audio/webm;codecs=opus';
let session = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'recorder') return;
  (async () => {
    try {
      if (msg.type === 'start') sendResponse({ ok: true, ...(await startRecording(msg)) });
      else if (msg.type === 'stop') { await stopRecording('user'); sendResponse({ ok: true }); }
      else if (msg.type === 'ping') sendResponse({ ok: true, recording: !!session });
      else sendResponse({ ok: false, error: 'Unknown command' });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
});

const missingDevice = e => e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError';

// The "others" side of the call: a browser tab, the whole computer's audio, or an input like BlackHole.
async function openOthers(source, streamId, settings) {
  const gum = c => navigator.mediaDevices.getUserMedia(c);
  if (source === 'tab') {
    return gum({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
  }
  if (source === 'system') {
    const desktop = { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId };
    // Chrome only hands out desktop audio together with a video track, so ask for a tiny one.
    const stream = await gum({ audio: { mandatory: desktop }, video: { mandatory: { ...desktop, maxWidth: 320, maxHeight: 180, maxFrameRate: 1 } } });
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error('No computer audio came through. In Chrome\'s picker, choose Entire screen and turn on "Share system audio".');
    }
    return stream;
  }
  if (source === 'device') {
    if (!settings.othersDeviceId) throw new Error('Choose the meeting audio input (e.g. BlackHole) in Settings first');
    try {
      return await gum({ audio: { deviceId: { exact: settings.othersDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      if (missingDevice(e)) throw new Error(`The meeting audio input "${settings.othersLabel || 'you chose'}" isn't connected`);
      throw e;
    }
  }
  throw new Error(`Unknown audio source: ${source}`);
}

async function openMic(settings, source, othersStream) {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  let stream = null, note = '';
  try {
    if (settings.micDeviceId) {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: settings.micDeviceId } } }); }
      catch (e) { if (!missingDevice(e)) throw e; note = ' (chosen mic not connected, used the default)'; }
    }
    stream ||= await navigator.mediaDevices.getUserMedia({ audio: base });
  } catch (e) {
    return { micError: e?.name === 'NotAllowedError' ? 'Microphone access not granted' : (e?.message || e?.name || 'Mic unavailable') };
  }
  const track = stream.getAudioTracks()[0];
  if (source === 'device' && othersStream.getAudioTracks()[0]?.getSettings().deviceId === track?.getSettings().deviceId) {
    // e.g. BlackHole is the system default input: recording it twice would duplicate every line.
    stream.getTracks().forEach(t => t.stop());
    return { micError: 'Your microphone is the same device as the meeting audio input. Pick your real mic in Settings' };
  }
  return { micStream: stream, micLabel: (track?.label || 'Default microphone') + note };
}

async function startRecording({ source = 'tab', streamId, meeting, settings }) {
  if (session) throw new Error('Already recording');

  const othersStream = await openOthers(source, streamId, settings);
  const { micStream = null, micError = null, micLabel = '' } = settings.useMic !== false ? await openMic(settings, source, othersStream) : {};

  const ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const othersAudio = new MediaStream(othersStream.getAudioTracks());
  const othersSrc = ctx.createMediaStreamSource(othersAudio);
  // Capturing a tab mutes it for you, so route its audio back to the speakers.
  // Computer audio and input devices aren't muted, and playing them would echo.
  if (source === 'tab') othersSrc.connect(ctx.destination);

  const separate = !!(settings.separateSpeakers && micStream);
  const streams = {};
  if (separate) {
    streams.them = othersAudio;
    streams.me = micStream;
  } else {
    const dest = ctx.createMediaStreamDestination();
    othersSrc.connect(dest);
    if (micStream) ctx.createMediaStreamSource(micStream).connect(dest);
    streams.mix = dest.stream;
  }

  const record = {
    ...meeting,
    status: 'recording',
    source,
    mode: separate ? 'separate' : 'mixed',
    hasMic: !!micStream,
    micError,
    micLabel,
    tracks: Object.keys(streams)
  };
  await DB.putMeeting(record);

  session = { meeting: record, othersStream, micStream, ctx, streams, recorders: {}, counters: {}, pending: [], stopping: null, writes: Promise.resolve() };
  for (const t of Object.keys(streams)) startSegment(t);
  session.rotateTimer = setInterval(rotate, Math.max(1, Number(settings.segmentMinutes) || 10) * 60000);

  const id = record.id;
  const s = session;
  const liveTracks = Object.fromEntries(Object.entries(streams).map(([k, st]) => [k, st.getAudioTracks()[0]]));
  s.live = await startLive(record, liveTracks, settings, (lines, update) => {
    if (update.line || update.error) queueWrite(s, { live: lines.slice(), liveError: s.live?.error || update.error || null });
    const msg = { type: 'live', id, ...update };
    chrome.runtime.sendMessage(msg).catch(() => {});
    self.dispatchEvent(new CustomEvent('huddle-live', { detail: msg }));   // this page doesn't get its own messages
  }).catch(e => ({ error: e?.message || String(e), lines: [], stop: async () => {} }));
  const liveError = s.live?.error || null;
  if (s.live) queueWrite(s, { liveEngine: s.live.engine || null, liveError });

  const reason = source === 'tab' ? 'tab-ended' : 'capture-ended';
  const onEnded = async () => {
    // Tab closed, "Stop sharing" clicked, or the input device unplugged.
    if (!session || session.meeting.id !== id || session.stopping) return;
    await stopRecording(reason);
    chrome.runtime.sendMessage({ type: 'recording-ended', id, reason }).catch(() => {});
  };
  othersStream.getTracks().forEach(t => t.addEventListener('ended', onEnded));

  return { mode: record.mode, hasMic: !!micStream, micError, micLabel, liveError };
}

// Meeting updates are read-modify-write, so run them one at a time.
function queueWrite(s, patch) {
  s.writes = s.writes.then(() => DB.updateMeeting(s.meeting.id, patch)).catch(e => console.error('Saving meeting failed', e));
  return s.writes;
}

function startSegment(track) {
  const s = session;
  const index = (s.counters[track] = (s.counters[track] ?? -1) + 1);
  const rec = new MediaRecorder(s.streams[track], { mimeType: MIME, audioBitsPerSecond: 32000 });
  const chunks = [];
  const startMs = Date.now() - s.meeting.startedAt;
  const meetingId = s.meeting.id;
  let endMs = null;
  rec.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
  const done = new Promise(resolve => {
    rec.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        if (blob.size > 0) {
          await DB.addSegment({ meetingId, track, index, startMs, endMs: endMs ?? Date.now() - s.meeting.startedAt, size: blob.size, blob });
        }
      } catch (e) {
        console.error('Saving audio part failed', e);
      }
      resolve();
    };
  });
  rec.start(1000);
  s.recorders[track] = { rec, done, markEnd: () => { endMs = Date.now() - s.meeting.startedAt; } };
}

function rotate() {
  const s = session;
  if (!s || s.stopping) return;
  for (const track of Object.keys(s.streams)) {
    const old = s.recorders[track];
    startSegment(track);           // start the next part first so nothing is lost
    old.markEnd();
    if (old.rec.state !== 'inactive') old.rec.stop();
    s.pending.push(old.done);
  }
}

function stopRecording(reason) {
  const s = session;
  if (!s) return Promise.resolve();
  if (s.stopping) return s.stopping;
  s.stopping = (async () => {
    clearInterval(s.rotateTimer);
    const liveDone = s.live?.stop();
    for (const r of Object.values(s.recorders)) {
      r.markEnd();
      if (r.rec.state !== 'inactive') r.rec.stop();
      s.pending.push(r.done);
    }
    await Promise.all(s.pending);
    s.othersStream.getTracks().forEach(t => t.stop());
    s.micStream?.getTracks().forEach(t => t.stop());
    await s.ctx.close().catch(() => {});
    await liveDone;
    const endedAt = Date.now();
    const live = s.live ? { live: s.live.lines.slice(), liveError: s.live.error || null } : {};
    await queueWrite(s, { ...live, status: 'recorded', endedAt, durationMs: endedAt - s.meeting.startedAt, endReason: reason });
    session = null;
  })();
  return s.stopping;
}
