// Speech in and out.
// - On a normal website: the browser's Web Speech API (SpeechRecognition + speechSynthesis).
// - Inside a claude.ai page: the platform's `dictation` and `tts` capabilities, because the
//   browser microphone is blocked there. initVoice() picks whichever is available.

const Recognition = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
const inClaude = typeof window !== 'undefined' && typeof window.claude?.use === 'function';

export const voiceSupported = {
  input: !inClaude && !!Recognition,
  output: !inClaude && typeof speechSynthesis !== 'undefined',
  engine: inClaude ? 'claude' : 'browser',
  ready: !inClaude,
};

let dictation = null;
let tts = null;

const CLAUDE_VOICES = ['buttery', 'airy', 'glassy', 'rounded'];

/** Resolve platform capabilities when running inside claude.ai. Safe to call anywhere. */
export async function initVoice() {
  if (!inClaude) return voiceSupported;
  const [d, t] = await Promise.all([
    window.claude.use('dictation').catch(() => null),
    window.claude.use('tts').catch(() => null),
  ]);
  dictation = d;
  tts = t;
  voiceSupported.input = !!d;
  voiceSupported.output = !!t;
  voiceSupported.ready = true;
  return voiceSupported;
}

/**
 * Create a listener. Callbacks: onInterim(text), onFinal(text), onState('listening'|'idle'), onError(msg).
 * start() must be called straight from a click or key press.
 */
export function createListener(opts) {
  if (dictation) return createClaudeListener(opts);
  if (Recognition && !inClaude) return createBrowserListener(opts);
  return null;
}

function createClaudeListener({ onInterim, onFinal, onState, onError }) {
  let buffer = '';
  let keepOn = false;
  let timer = null;

  // Dictation has no "end of sentence" signal, so a short pause ends the command.
  const flush = () => {
    clearTimeout(timer);
    const text = buffer.trim();
    buffer = '';
    onInterim?.('');
    if (text) onFinal?.(text);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!buffer.trim()) return;
      if (keepOn) flush();
      else dictation.stop().catch(() => {}); // idle handler flushes
    }, 1400);
  };

  dictation.onPartial(({ text }) => {
    onInterim?.((buffer + ' ' + text).trim());
    if (text) clearTimeout(timer); else schedule();
  });
  dictation.onFinal(({ text }) => {
    buffer += text;
    onInterim?.(buffer.trim());
    schedule();
  });
  dictation.onState(({ state, reason }) => {
    const on = state === 'listening' || state === 'starting';
    onState?.(on ? 'listening' : state === 'finishing' ? 'listening' : 'idle');
    if (state === 'idle') {
      flush();
      const msgs = {
        not_granted: 'Microphone access was turned off for this page. Turn it on in the page’s Permissions menu.',
        unavailable: 'Voice input isn’t available here. You can type instead.',
        rate_limited: 'Too many voice requests just now. Try again in a moment.',
        upstream_error: 'The microphone or speech service had a problem. Try again.',
      };
      if (msgs[reason]) onError?.(msgs[reason]);
    }
  });

  return {
    start(continuous = false) {
      keepOn = continuous;
      buffer = '';
      dictation.start().catch((e) => {
        if (e?.code === 'not_granted') onError?.('Microphone access was declined. You can still type commands.');
        else if (e?.code === 'unavailable') onError?.('Voice input isn’t available in this browser. Try Chrome, or type instead.');
        else if (e?.code && e.code !== 'stopped' && e.code !== 'dismissed') onError?.(e.message || 'Voice input failed');
      });
    },
    stop() { keepOn = false; dictation.stop().catch(() => {}); },
    get active() { return dictation.active(); },
    setLang() { /* dictation follows the viewer's own language */ },
  };
}

function createBrowserListener({ lang = 'en-IN', onInterim, onFinal, onState, onError }) {
  let rec = null;
  let active = false;
  let keepAlive = false;

  function start(continuous = false) {
    if (active) return;
    keepAlive = continuous;
    rec = new Recognition();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = continuous;
    rec.maxAlternatives = 1;

    rec.onstart = () => { active = true; onState?.('listening'); };
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) onFinal?.(r[0].transcript.trim());
        else interim += r[0].transcript;
      }
      if (interim) onInterim?.(interim);
    };
    rec.onerror = (e) => {
      const map = {
        'not-allowed': 'Microphone permission was denied. Allow mic access in your browser settings.',
        'no-speech': 'I didn’t hear anything. Tap the mic and try again.',
        'audio-capture': 'No microphone found.',
        network: 'Speech recognition needs an internet connection in this browser.',
      };
      if (e.error === 'aborted') return;
      if (e.error === 'no-speech' && keepAlive) return;
      keepAlive = false;
      onError?.(map[e.error] || `Voice error: ${e.error}`);
    };
    rec.onend = () => {
      active = false;
      if (keepAlive) { try { rec.start(); return; } catch { /* fall through */ } }
      onState?.('idle');
    };
    try { rec.start(); } catch (err) { onError?.(err.message); }
  }

  function stop() { keepAlive = false; try { rec?.stop(); } catch { /* ignore */ } }

  return { start, stop, get active() { return active; }, setLang(l) { lang = l; } };
}

let voicesCache = [];
/** Voices for the settings menu: [{name, lang}]. */
export function getVoices() {
  if (tts) return CLAUDE_VOICES.map((name) => ({ name, lang: 'Claude voice' }));
  if (inClaude || typeof speechSynthesis === 'undefined') return [];
  const v = speechSynthesis.getVoices();
  if (v.length) voicesCache = v;
  return voicesCache;
}
if (!inClaude && typeof speechSynthesis !== 'undefined') speechSynthesis.onvoiceschanged = getVoices;

export function speak(text, { voiceName, lang = 'en-IN', rate = 1 } = {}) {
  if (!text) return Promise.resolve();
  if (tts) {
    const voice = CLAUDE_VOICES.includes(voiceName) ? voiceName : undefined;
    return tts.speak(text.slice(0, 2000), { voice, rate }).catch(() => {});
  }
  if (inClaude || typeof speechSynthesis === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text.replace(/[•·]/g, ','));
    const voices = getVoices();
    u.voice = voices.find((v) => v.name === voiceName) || voices.find((v) => v.lang === lang) ||
              voices.find((v) => v.lang.startsWith(lang.split('-')[0])) || null;
    u.lang = u.voice?.lang || lang;
    u.rate = rate;
    // Some browsers never fire onend (or have no voices); never let that stall a routine.
    const guard = setTimeout(resolve, 2500 + text.length * 90 / rate);
    u.onend = u.onerror = () => { clearTimeout(guard); resolve(); };
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (tts) { if (tts.active()) tts.stop().catch(() => {}); return; }
  if (!inClaude && typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

/** Short two-tone chime for reminders (no audio file needed). */
export function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 0.4);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch { /* audio not available */ }
}
