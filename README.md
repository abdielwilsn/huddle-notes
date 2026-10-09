# Huddle Notes

A free tl;dv you run yourself. It records a meeting tab plus your microphone straight from Chrome, so no bot joins the call. Chrome transcribes it live as you talk, and an AI model (optional, free Groq key) writes a summary with action items.

## Install (2 minutes)

1. Unzip this folder somewhere permanent (Chrome loads it from there).
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and pick the `huddle-notes` folder.
3. The Settings page opens. Get a free key at https://console.groq.com/keys, paste it in, click **Test connection**, then **Save**.
4. Click **Allow microphone** once, so your own voice gets recorded too.
5. Pin the extension (puzzle icon → pin).

Brave, Edge, Arc and other Chromium browsers work the same way.

## Use

- Join your call in a browser tab (Google Meet, Zoom web, Teams web, anything).
- Click the icon → **Start recording**, or press **Alt+Shift+R**. The badge shows `REC`.
- Click **Stop & transcribe** when the call ends. The Meetings page opens and fills in the transcript and summary.
- If you close the meeting tab, the recording stops and is processed on its own.

### Live transcript (Chrome)

Chrome transcribes the call as you record, with its built-in speech recognition (`webkitSpeechRecognition`). The text shows in a small box under the timer in the popup, and on the Meetings page, labelled Me / Others when that option is on. When you stop, that becomes the meeting's transcript. No API key, download or Live Caption is needed.

- **Chrome's speech service** (default) works right away. Like any `webkitSpeechRecognition` page, it sends the audio to Google for recognition.
- **On this computer** keeps audio on your Mac and uses your *Words to recognise*, but Chrome first downloads a language pack: Settings → **Test Chrome transcription**.
- **The API key is optional.** Without one you get the transcript; add a Groq key for the summary and action items. Set **Final transcript** to *Whisper* for a more accurate transcript made after the call. **Redo transcript** always uses Whisper.
- The language comes from *Language* (or Chrome's language if blank). Chrome doesn't auto-detect it.

### Desktop apps (Zoom, Teams, Slack…)

Pick the source in the popup's **Record** menu, or in Settings:

- **Computer audio** (no install). Chrome asks what to share: choose **Entire screen** and turn on **Share system audio**. A small Huddle window opens; keep it open (minimised is fine) until you stop. It records everything the computer plays, so mute music and notifications. If Chrome doesn't show the system-audio switch on your Mac, use the next option.
- **Audio input (BlackHole)**. This needs a one-time setup, then records only the meeting app's sound:
  1. `brew install blackhole-2ch` (or the installer from existential.audio/blackhole), then restart the Mac or run `sudo killall coreaudiod`.
  2. Open **Audio MIDI Setup** → **+** → **Create Multi-Output Device**. Tick your headset (or speakers) **and** BlackHole 2ch, with the headset as the main device.
  3. In Zoom/Teams, set **Speaker** to that Multi-Output Device. Leave its **Microphone** on your real mic.
  4. In Huddle Settings, set **Meeting audio comes from** → *An audio input device*, **Meeting audio input** → BlackHole 2ch, and **Microphone** → your headset mic.

Both work with headphones. With **Label who spoke** on, your mic and the app's audio are kept as separate tracks, the same as for tabs.

Meetings, audio, transcripts and summaries are stored only in this browser (IndexedDB). Audio leaves your machine only when it is sent to the transcription API you configured.

## Options worth knowing

| Setting | What it does |
|---|---|
| Meeting audio comes from | A browser tab (default), all computer audio, or an audio input like BlackHole. See above. |
| Microphone | Which mic records your voice. Pick your headset's mic if the default isn't the one you talk into. |
| Label who spoke: me vs. others | Records your mic and the meeting audio as two tracks, so the transcript reads `Me:` / `Others:`. **Use headphones**, or the meeting audio leaks into your mic and gets transcribed twice. |
| Words to recognise | Names and jargon (e.g. "Skolnest, Inertia, Paystack") passed to Whisper so it spells them right. |
| Language | Leave blank to auto-detect, or set `en`, `fr` and so on to force a language. |
| Split audio every N min | Audio is saved in parts (~2.4 MB per 10 min). Each part is uploaded separately, which keeps you under the 25 MB free-tier file limit and lets a failed run resume where it stopped. |
| Provider | Groq (free), OpenAI, or **Custom**: any OpenAI-compatible server, e.g. a local `faster-whisper-server` + Ollama for fully offline notes. |

## Free-tier notes (Groq)

- The free tier is rate-limited. On long calls, or with the two-track mode (which doubles the audio sent), you may see "rate limiting — retrying in Ns". The extension waits and retries by itself. If it still fails, press **Transcribe & summarise** later; parts that are already done are not re-sent.
- Model names change over time. If Test connection says a model isn't found, it lists the models your key can use.
- Long meetings are summarised in chunks first, then combined, to stay within free-tier token limits.

## Files

- `background.js`: start/stop logic, keyboard shortcut, badge
- `recorder.js`: the actual recorder (tab, computer audio or audio input + mic, rotating WebM/Opus parts). Runs in `offscreen.html`, or in `capture.*` for computer audio
- `capture.*`: the window that asks Chrome for computer audio and hosts the recorder while it runs
- `live.js`: live transcript with Chrome's built-in speech recognition
- `process.js`: Whisper transcription, hallucination filter, speaker merge, summary
- `viewer.*`: the Meetings page; `options.*`: Settings; `popup.*`: toolbar popup

## Limits

- Desktop apps need the **Computer audio** or **Audio input** source (see above).
- Closing the Computer audio window mid-call loses the last unsaved part (up to N minutes), and Chrome asks before letting you close it.
- In mixed mode, speakers aren't labelled. Whisper has no speaker diarization.
- Chrome shows a "sharing this tab" (or "sharing your screen") indicator while recording. That's expected; only audio is saved.
