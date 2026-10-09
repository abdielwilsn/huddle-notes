// Shared settings (loaded by background, popup, options, viewer).
const PROVIDERS = {
  groq: {
    label: 'Groq (free tier)',
    baseUrl: 'https://api.groq.com/openai/v1',
    transcribeModel: 'whisper-large-v3-turbo',
    summaryModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys'
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    transcribeModel: 'whisper-1',
    summaryModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  custom: {
    label: 'Custom (any OpenAI-compatible server)',
    baseUrl: 'http://localhost:8000/v1',
    transcribeModel: 'whisper-1',
    summaryModel: 'llama3',
    keyUrl: ''
  }
};

// Where the other side of the call comes from.
const SOURCES = {
  tab: 'Meeting tab',      // a browser tab (Meet, Zoom web, Teams web)
  system: 'Computer audio', // everything the computer plays (desktop apps); Chrome asks each time
  device: 'Audio input'    // a loopback input such as BlackHole
};

const DEFAULT_SETTINGS = {
  provider: 'groq',
  baseUrl: PROVIDERS.groq.baseUrl,
  apiKey: '',
  transcribeModel: PROVIDERS.groq.transcribeModel,
  summaryModel: PROVIDERS.groq.summaryModel,
  language: '',          // e.g. "en"; blank = auto-detect
  vocabulary: '',        // names / jargon to help Whisper spell things right
  myName: 'Me',
  othersName: 'Others',
  source: 'tab',
  othersDeviceId: '',    // audio input carrying the meeting when source is 'device'
  othersLabel: '',
  useMic: true,
  micDeviceId: '',       // blank = system default
  micLabel: '',
  separateSpeakers: false, // record mic and tab separately -> "Me" vs "Others" labels (use headphones)
  liveTranscript: 'cloud', // Chrome's speech recognition while recording: 'cloud' (Google, no download) | 'local' | 'off'
  finalTranscript: 'live', // 'live' (keep Chrome's transcript) | 'whisper' (API, best quality)
  segmentMinutes: 10,
  autoProcess: true,
  settingsVersion: 2
};

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  if (settings && (settings.settingsVersion || 1) < 2) {
    // v2 made Chrome the main transcriber; settings saved before that still say Whisper / on-device.
    Object.assign(merged, { liveTranscript: 'cloud', finalTranscript: 'live', settingsVersion: 2 });
    await chrome.storage.local.set({ settings: merged });
  }
  return merged;
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
