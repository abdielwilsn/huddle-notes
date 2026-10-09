// Transcription + summarisation against any OpenAI-compatible API (Groq, OpenAI, local).
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Whisper likes to "hear" these in silence.
const HALLUCINATION = /^(thank you\.?|thanks\.?|thanks for watching[.!]?|you\.?|bye\.?|\.+|okay\.?|subtitles by .*|transcribed by .*)$/i;

async function api(s, path, init, progress, attempt = 0) {
  const headers = { ...(init.headers || {}) };
  if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
  const res = await fetch(s.baseUrl.replace(/\/+$/, '') + path, { ...init, headers });
  if (res.ok) return res.json();
  const body = await res.text();
  if ((res.status === 429 || res.status >= 500) && attempt < 6) {
    let wait = parseFloat(res.headers.get('retry-after'));
    if (!wait || Number.isNaN(wait)) wait = 5 * 2 ** attempt;
    wait = Math.min(Math.max(wait, 2), 120);
    progress?.(`API is rate limiting — retrying in ${Math.ceil(wait)}s…`);
    await sleep(wait * 1000);
    return api(s, path, init, progress, attempt + 1);
  }
  let msg = body;
  try { msg = JSON.parse(body).error?.message || body; } catch {}
  throw new Error(`API error ${res.status}: ${String(msg).slice(0, 300)}`);
}

function keepSegment(x) {
  const text = (x.text || '').trim();
  if (!text) return false;
  const nsp = x.no_speech_prob ?? 0, lp = x.avg_logprob ?? 0;
  if (nsp > 0.6 && lp < -0.4) return false;
  if (lp < -1.2) return false;
  if (HALLUCINATION.test(text) && nsp > 0.2) return false;
  return true;
}

async function transcribeSegment(seg, s, progress) {
  if (!seg.blob || seg.size < 4000) return []; // < ~1s of audio
  const fd = new FormData();
  fd.append('file', seg.blob, `part-${seg.track}-${seg.index + 1}.webm`);
  fd.append('model', s.transcribeModel);
  fd.append('response_format', 'verbose_json');
  fd.append('temperature', '0');
  if (s.language) fd.append('language', s.language);
  if (s.vocabulary) fd.append('prompt', s.vocabulary.slice(0, 800));
  const data = await api(s, '/audio/transcriptions', { method: 'POST', body: fd }, progress);
  const offset = (seg.startMs || 0) / 1000;
  const parts = Array.isArray(data.segments) && data.segments.length
    ? data.segments
    : (data.text ? [{ start: 0, end: 0, text: data.text }] : []);
  return parts.filter(keepSegment).map(x => ({
    start: offset + (x.start || 0),
    end: offset + (x.end || x.start || 0),
    text: x.text.trim()
  }));
}

function buildTranscript(segs, meeting, s) {
  const name = t => (t === 'me' ? (s.myName || 'Me') : t === 'them' ? (s.othersName || 'Others') : null);
  const items = segs.flatMap(seg => (seg.result || []).map(r => ({ ...r, speaker: name(seg.track), track: seg.track })));
  items.sort((a, b) => a.start - b.start);
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.text === it.text && last.speaker === it.speaker && Math.abs(it.start - last.start) < 3) continue; // part-boundary duplicate
    if (last && last.speaker === it.speaker && it.start - last.end < 1.5 && last.text.length + it.text.length < 500) {
      last.text += ' ' + it.text;
      last.end = Math.max(last.end, it.end);
    } else {
      out.push({ start: it.start, end: it.end, speaker: it.speaker, track: it.track, text: it.text });
    }
  }
  return out;
}

function ts(sec) {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function fmtDur(ms) {
  if (!ms) return '—';
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
}

function transcriptText(lines) {
  return (lines || []).map(l => `[${ts(l.start)}] ${l.speaker ? l.speaker + ': ' : ''}${l.text}`).join('\n');
}

function chunkLines(text, max) {
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > max) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function chat(s, messages, progress) {
  const data = await api(s, '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: s.summaryModel, messages, temperature: 0.2 })
  }, progress);
  const out = data.choices?.[0]?.message?.content || '';
  return out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function summaryPrompt(meeting, s) {
  const speakers = meeting.mode === 'separate'
    ? `Lines labelled "${s.myName || 'Me'}" are the person you are writing for; "${s.othersName || 'Others'}" is everyone else on the call. Refer to them as "you" and "the others" or by names mentioned in the call.`
    : 'Speakers are not labelled; infer who said what only when the transcript makes it clear (e.g. people addressing each other by name).';
  return `You turn meeting transcripts into short, accurate meeting notes.
${speakers}
Rules: use only what is in the transcript. Never invent names, numbers, dates, owners or decisions. Transcripts come from speech recognition, so silently fix obvious mis-hearings but do not guess at unclear content. Write in the language most of the meeting was in.
Return Markdown with exactly these sections:
## TL;DR
2–3 sentences: what the meeting was about and where it landed.
## Key points
Bullets of the substantive points, figures and context.
## Decisions
Bullets, or "None recorded."
## Action items
One per line as "- [ ] **Owner** — task (due date if one was said)". Use "Unassigned" when no owner is clear. Or "None recorded."
## Open questions
Bullets of unresolved questions or follow-ups, or "None recorded."`;
}

const NOTES_PROMPT = 'You are taking detailed notes on one part of a longer meeting transcript. Capture topics discussed, facts and figures, decisions, action items with owners and dates, and open questions, as concise bullets. Keep [mm:ss] timestamps for important moments. Use only what is in the text.';

async function summarize(meeting, s, progress) {
  const text = transcriptText(meeting.transcript);
  const chunks = chunkLines(text, 18000);
  let material = text, label = 'Transcript';
  if (chunks.length > 1) {
    const notes = [];
    for (let i = 0; i < chunks.length; i++) {
      progress?.(`Summarising part ${i + 1} of ${chunks.length}…`);
      notes.push(await chat(s, [
        { role: 'system', content: NOTES_PROMPT },
        { role: 'user', content: `Part ${i + 1} of ${chunks.length}:\n\n${chunks[i]}` }
      ], progress));
    }
    material = notes.map((n, i) => `### Notes from part ${i + 1}\n${n}`).join('\n\n');
    label = 'Detailed notes taken across the meeting';
    progress?.('Combining notes…');
  }
  return chat(s, [
    { role: 'system', content: summaryPrompt(meeting, s) },
    { role: 'user', content: `Meeting: ${meeting.title}\nDate: ${new Date(meeting.startedAt).toLocaleString()}\nDuration: ${fmtDur(meeting.durationMs)}\n\n${label}:\n\n${material}` }
  ], progress);
}

const busy = new Set();

// Chrome's live lines, merged the same way as Whisper's.
function liveTranscript(meeting, s) {
  const byTrack = {};
  for (const l of meeting.live || []) (byTrack[l.track] ||= []).push(l);
  return buildTranscript(Object.entries(byTrack).map(([track, result]) => ({ track, result })), meeting, s);
}

// opts: { retranscribe: bool (always Whisper), summaryOnly: bool }
async function processMeeting(id, opts = {}, progress = () => {}) {
  if (busy.has(id)) return;
  busy.add(id);
  const s = await getSettings();
  try {
    const noKey = !s.apiKey && /api\.(groq|openai)\.com/.test(s.baseUrl);
    const useLive = s.finalTranscript === 'live' && !opts.retranscribe && (await DB.getMeeting(id))?.live?.length;
    if (useLive && !opts.summaryOnly) {
      const meeting = await DB.getMeeting(id);
      await DB.updateMeeting(id, { transcript: liveTranscript(meeting, s), transcriptSource: 'live', error: null });
    } else if (!opts.summaryOnly) {
      if (noKey) {
        throw new Error(s.finalTranscript === 'live'
          ? 'Chrome didn\'t transcribe anything in this call. The audio is saved: add an API key in Settings and press Transcribe to use Whisper instead.'
          : 'Whisper needs an API key. Add one in Settings, or set Final transcript to Chrome\'s transcript.');
      }
      await DB.updateMeeting(id, { status: 'transcribing', error: null });
      const segs = await DB.getSegments(id);
      if (!segs.length) throw new Error('No audio was saved for this meeting.');
      let n = 0;
      for (const seg of segs) {
        n++;
        if (seg.result && !opts.retranscribe) continue;
        progress(`Transcribing part ${n} of ${segs.length}…`);
        seg.result = await transcribeSegment(seg, s, progress);
        await DB.putSegment(seg);
      }
      const meeting = await DB.getMeeting(id);
      await DB.updateMeeting(id, { transcript: buildTranscript(segs, meeting, s), transcriptSource: 'whisper' });
    }
    const meeting = await DB.getMeeting(id);
    if (!meeting.transcript?.length) {
      await DB.updateMeeting(id, { status: 'done', summary: '_No speech was detected in this recording._', processedAt: Date.now() });
      return;
    }
    if (noKey) {
      // The transcript is done; a summary needs the API.
      await DB.updateMeeting(id, { status: 'done', summary: '_Add an API key in Settings, then press **Redo summary** to get a summary and action items._', processedAt: Date.now() });
      return;
    }
    await DB.updateMeeting(id, { status: 'summarizing', error: null });
    progress('Writing summary…');
    const summary = await summarize(meeting, s, progress);
    await DB.updateMeeting(id, { summary, status: 'done', processedAt: Date.now() });
  } catch (e) {
    await DB.updateMeeting(id, { status: 'error', error: e?.message || String(e) });
  } finally {
    busy.delete(id);
  }
}
