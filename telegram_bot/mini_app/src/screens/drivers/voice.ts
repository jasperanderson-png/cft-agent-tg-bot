// Spoken directions: the natural
// Google voice (Chirp 3 HD "Fenrir", from /api/driver/voice) played through Web Audio. Phrases are
// fetched ahead of time (fixed lead-ins plus a route's turns), so the voice speaks the moment it should.
// Until the natural voice is available (no key, Google billing off, monthly allowance used up) the
// phone's own voice reads the same sentences, so a driver is never left without guidance.

const VOICE = 'fenrir';
/** Fixed lead-ins (not exact distances), so their audio can be fetched ahead of time. */
export const LEAD_INS = ['In 1 mile,', 'In a quarter mile,', 'In 500 feet,', 'Now,'];

// The natural voice answered "not available": remembered for 30 minutes, so the next phrases (and the
// next openings of the map) go straight to the phone's voice instead of waiting on the server each time.
const OFF_KEY = 'cft.cloudVoiceOff';
let unavailable = (() => {
  try { return Date.now() - Number(localStorage.getItem(OFF_KEY) ?? 0) < 30 * 60_000; } catch { return false; }
})();
const markUnavailable = () => {
  unavailable = true;
  try { localStorage.setItem(OFF_KEY, String(Date.now())); } catch { /* not remembered */ }
};
let ctx: AudioContext | null = null;
const audio = () => {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  ctx = AC ? new AC() : null;
  return ctx;
};

/** Phones only play sound after a tap: resume and prime the audio on one. */
export function unlockVoice() {
  const c = audio();
  if (c) {
    if (c.state !== 'running') c.resume().catch(() => {});
    try {
      const s = c.createBufferSource();
      s.buffer = c.createBuffer(1, 1, 22050);
      s.connect(c.destination);
      s.start(0);
    } catch {
      /* nothing to prime */
    }
  }
  // iOS speaks only after a tap too (the fallback voice).
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis?.speak(u);
  } catch {
    /* no speech synthesis */
  }
}
if (typeof document !== 'undefined') for (const t of ['pointerdown', 'touchend']) document.addEventListener(t, unlockVoice, { once: true, capture: true });

/** Road numbers as they should be read aloud ("I-80" → "Interstate 80"). */
export const spoken = (t: string) =>
  t.replace(/\bI[- ](\d+)/g, 'Interstate $1').replace(/\bUS[- ](\d+)/g, 'U.S. $1').replace(/\bSR[- ](\d+)/g, 'State Route $1').replace(/#(\d+)/g, 'number $1')
    .replace(/\b([NSEW])\b(?=\s*$|\s*[,;)/])/g, (m) => ({ N: 'North', S: 'South', E: 'East', W: 'West' })[m] ?? m);

const clips = new Map<string, Promise<AudioBuffer | null>>();
function clip(text: string): Promise<AudioBuffer | null> {
  let p = clips.get(text);
  if (!p) {
    p = (async () => {
      const c = audio();
      if (!c || unavailable) return null;
      try {
        const res = await fetch(`/api/driver/voice?v=${VOICE}&t=${encodeURIComponent(text)}`);
        if (!res.ok) {
          if (res.status === 503) markUnavailable(); // not set up, billing off or allowance used: stop asking
          return null;
        }
        return await c.decodeAudioData(await res.arrayBuffer());
      } catch {
        return null;
      }
    })();
    p.then((b) => { if (!b) clips.delete(text); });
    clips.set(text, p);
  }
  return p;
}

/** Fetches phrases ahead of time, two at a time. */
export function prefetchVoice(texts: string[]) {
  if (unavailable) return;
  const queue = [...new Set(texts.filter(Boolean).map(spoken))];
  const next = (): Promise<void> => { const t = queue.shift(); return t ? clip(t).then(next) : Promise.resolve(); };
  void next();
  void next();
}

let playing: AudioBufferSourceNode | null = null;
let token = 0;
export function hush() {
  token++;
  try { playing?.stop(); } catch { /* already stopped */ }
  playing = null;
  try { window.speechSynthesis?.cancel(); } catch { /* none */ }
}

// The phone's own voice. Its list of voices loads late on some phones (voiceschanged), so the choice is
// made when speaking: the best English voice the phone has (premium / enhanced / natural first, then
// the well-known clear ones), never a novelty voice.
const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
const GOOD = /premium|enhanced|natural|neural|google us english|samantha|aaron|nicky|evan|zoe|ava|allison|aria|jenny|guy/i;
const NOVELTY = /albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley/i;
let voices: SpeechSynthesisVoice[] = [];
const loadVoices = () => { try { voices = synth?.getVoices() ?? []; } catch { voices = []; } };
loadVoices();
synth?.addEventListener?.('voiceschanged', loadVoices);
function bestVoice(): SpeechSynthesisVoice | null {
  if (!voices.length) loadVoices();
  const en = voices.filter((v) => /^en[-_]/i.test(v.lang) && !NOVELTY.test(v.name));
  const us = en.filter((v) => /^en[-_]US$/i.test(v.lang));
  return us.find((v) => /premium|enhanced|natural|neural/i.test(v.name)) ?? us.find((v) => GOOD.test(v.name)) ?? us.find((v) => v.localService) ?? us[0]
    ?? en.find((v) => GOOD.test(v.name)) ?? en[0] ?? null;
}

/** The phone has a voice of its own (Telegram on Android has none: no speech in its web view). */
const hasPhoneVoice = () => {
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return false;
  if (!voices.length) loadVoices();
  return voices.length > 0;
};

// ---- The voice pack: natural recorded phrases built into the app (public/voice/*.mp3, made once with
// the open Piper voice "LJ Speech", public domain; list in public/voice/pack.json). No street names, but
// it needs no Google billing, no phone voice and, once fetched, no signal. Used when neither the natural
// cloud voice nor a phone voice is there (Telegram on Android).
const packClips = new Map<string, Promise<AudioBuffer | null>>();
function packClip(key: string): Promise<AudioBuffer | null> {
  let p = packClips.get(key);
  if (!p) {
    p = (async () => {
      const c = audio();
      if (!c) return null;
      try {
        const res = await fetch(`/voice/${key}.mp3`);
        return res.ok ? await c.decodeAudioData(await res.arrayBuffer()) : null;
      } catch {
        return null;
      }
    })();
    p.then((b) => { if (!b) packClips.delete(key); });
    packClips.set(key, p);
  }
  return p;
}
/** Fetches the pack phrases a route will need (only when the pack is the voice that will speak). */
export function prefetchPack(keys: string[]) {
  if (voiceKind() !== 'pack') return;
  const queue = [...new Set(keys)];
  const next = (): Promise<void> => { const k = queue.shift(); return k ? packClip(k).then(next) : Promise.resolve(); };
  void next();
  void next();
}

/** Which voice will speak: the natural one, the phone's own, the built-in pack, or none at all. */
export function voiceKind(): 'cloud' | 'phone' | 'pack' | 'none' {
  if (!unavailable && audio()) return 'cloud';
  if (hasPhoneVoice()) return 'phone';
  return audio() ? 'pack' : 'none';
}

/** The pack phrase for a turn: distance + manoeuvre ("quarter-exit_right" = "In a quarter mile, take the exit on the right."). */
export function packTurn(mi: number, type: number, text: string): string {
  const lead = mi > 0.6 ? 'mile' : mi > 0.12 ? 'quarter' : mi > 0.05 ? 'ft500' : 'now';
  const exit = /\bexit\b/i.test(text) && !/roundabout/i.test(text);
  const turn = ({ 0: 'left', 1: 'right', 2: 'sharp_left', 3: 'sharp_right', 4: 'slight_left', 5: 'slight_right', 7: 'roundabout', 8: 'roundabout', 9: 'uturn',
    12: exit ? 'exit_left' : 'keep_left', 13: exit ? 'exit_right' : 'keep_right' } as Record<number, string>)[type] ?? 'straight';
  return `${lead}-${turn}`;
}
/** Every pack phrase a route's turns can need (each turn at each distance). */
export const packForSteps = (steps: { type: number; text: string }[]) =>
  ['rerouting', 'arrived', 'arrived_stop', 'continuing', ...steps.flatMap((st) => [1, 0.25, 0.08, 0].map((mi) => packTurn(mi, st.type, st.text)))];

async function play(c: AudioContext, buffers: AudioBuffer[], mine: number) {
  if (c.state !== 'running') await c.resume().catch(() => {});
  for (const b of buffers) {
    if (mine !== token) return;
    await new Promise<void>((resolve) => {
      const s = c.createBufferSource();
      s.buffer = b;
      s.connect(c.destination);
      s.onended = () => resolve();
      playing = s;
      s.start();
    });
  }
}

function phoneVoice(text: string) {
  if (!synth) return;
  const u = new SpeechSynthesisUtterance(text);
  const v = bestVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
  u.rate = 1;
  u.pitch = 1;
  // iOS can leave the queue paused after the app was in the background.
  try { synth.cancel(); synth.resume(); } catch { /* fine */ }
  synth.speak(u);
}

const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

/**
 * Speaks: the natural voice when its clips arrive in time, else the phone's own voice reading the same
 * words, else (no phone voice) the built-in pack's phrases `pack` (keys from public/voice/pack.json).
 */
export async function speak(parts: string[], pack: string[] = []) {
  const texts = parts.filter(Boolean).map(spoken);
  if (!texts.length) return;
  hush();
  const mine = token;
  const c = audio();
  if (!unavailable && c) {
    const buffers = await within(Promise.all(texts.map(clip)), 2000);
    if (mine !== token) return;
    if (buffers && buffers.every(Boolean)) { await play(c, buffers as AudioBuffer[], mine); return; }
  }
  if (mine !== token) return;
  if (hasPhoneVoice()) { phoneVoice(texts.join(' ')); return; }
  if (c && pack.length) {
    const buffers = await within(Promise.all(pack.map(packClip)), 2500);
    if (mine === token && buffers && buffers.every(Boolean)) await play(c, buffers as AudioBuffer[], mine);
  }
}

/** The lead-in for a turn this far ahead. */
export const leadIn = (mi: number) => (mi > 0.6 ? 'In 1 mile,' : mi > 0.12 ? 'In a quarter mile,' : mi > 0.05 ? 'In 500 feet,' : 'Now,');
/** A step's instruction as a spoken sentence ("turn left onto Main St."). */
export const sentence = (t: string) => `${t.charAt(0).toLowerCase()}${t.slice(1).replace(/\.$/, '')}.`;
