// Spoken directions (ported from the United Fuel app, src/voice-cloud.ts + directions.ts): the natural
// Google voice (Chirp 3 HD "Fenrir", from /api/driver/voice) played through Web Audio. Phrases are
// fetched ahead of time (fixed lead-ins plus a route's turns), so the voice speaks the moment it should.
// Until the natural voice is available (no key, Google billing off, monthly allowance used up) the
// phone's own voice reads the same sentences, so a driver is never left without guidance.

const VOICE = 'fenrir';
/** Fixed lead-ins (not exact distances), so their audio can be fetched ahead of time. */
export const LEAD_INS = ['In 1 mile,', 'In a quarter mile,', 'In 500 feet,', 'Now,'];

let unavailable = false;
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
          if (res.status === 503) unavailable = true; // not set up, billing off or allowance used: stop asking
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

function phoneVoice(text: string) {
  const s = window.speechSynthesis;
  if (!s) return;
  const voices = s.getVoices();
  const v = voices.find((x) => x.lang === 'en-US' && /premium|enhanced|natural|neural/i.test(x.name)) ?? voices.find((x) => x.lang === 'en-US') ?? null;
  const u = new SpeechSynthesisUtterance(text);
  if (v) u.voice = v;
  u.lang = 'en-US';
  s.speak(u);
}

/** Speaks the parts in order: the natural voice when its clips arrive in time, else the phone's. */
export async function speak(parts: string[]) {
  const texts = parts.filter(Boolean).map(spoken);
  if (!texts.length) return;
  hush();
  const mine = token;
  const c = audio();
  if (!unavailable && c) {
    const buffers = await Promise.race([Promise.all(texts.map(clip)), new Promise<null>((r) => setTimeout(() => r(null), 3500))]);
    if (mine !== token) return;
    if (buffers && buffers.every(Boolean)) {
      if (c.state !== 'running') await c.resume().catch(() => {});
      for (const b of buffers as AudioBuffer[]) {
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
      return;
    }
  }
  if (mine === token) phoneVoice(texts.join(' '));
}

/** The lead-in for a turn this far ahead. */
export const leadIn = (mi: number) => (mi > 0.6 ? 'In 1 mile,' : mi > 0.12 ? 'In a quarter mile,' : mi > 0.05 ? 'In 500 feet,' : 'Now,');
/** A step's instruction as a spoken sentence ("turn left onto Main St."). */
export const sentence = (t: string) => `${t.charAt(0).toLowerCase()}${t.slice(1).replace(/\.$/, '')}.`;
