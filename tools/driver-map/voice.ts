import { env } from '../../support/helpers/env.js';
import { HttpError } from '../../support/helpers/http.js';
import { digest, kv, kvReady, rateLimit, spend } from '../../support/helpers/kv.js';

// The natural navigation voice: Google Cloud Text-to-Speech, Chirp 3 HD. A phrase is synthesised
// once: the MP3 is kept in our Redis and, being a plain GET URL, by the phone.
// Characters count against our daily and monthly allowance (support/helpers/kv.ts, support/common/driver-config.ts).

/** The voices offered (US English); Fenrir, a male voice, is the default the user chose. */
export const VOICES: Record<string, string> = { fenrir: 'Fenrir', charon: 'Charon', orus: 'Orus', aoede: 'Aoede', kore: 'Kore', leda: 'Leda' };

export const voiceReady = () => !!env.googleTtsKey && kvReady();

/** The MP3 for a phrase in a voice. */
export async function voiceClip(textIn: string, voiceId: string, client: string | null, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  if (!voiceReady()) throw new HttpError(503, 'Natural voice is not configured.', 'voice_off');
  const text = textIn.replace(/\s+/g, ' ').trim();
  const voice = VOICES[voiceId || 'fenrir'];
  if (!voice) throw new HttpError(400, 'Unknown voice.');
  if (!text || text.length > 240) throw new HttpError(400, 'Send 1–240 characters.');
  const cacheKey = `cft:voice:${digest(`${voice}|${text}`)}`;
  let audio = (await kv('GET', cacheKey)) as string | null;
  if (!audio) {
    await rateLimit('voice', client, 60);
    await spend('voice', text.length);
    let res: Response;
    try {
      res = await fetchImpl('https://texttospeech.googleapis.com/v1/text:synthesize', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.googleTtsKey },
        body: JSON.stringify({ input: { text }, voice: { languageCode: 'en-US', name: `en-US-Chirp3-HD-${voice}` }, audioConfig: { audioEncoding: 'MP3' } }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new HttpError(503, 'The voice service did not answer in time.', 'voice_down');
    }
    const body = (await res.json().catch(() => null)) as { audioContent?: string } | null;
    if (!res.ok || !body?.audioContent) throw new HttpError(503, 'The voice service is unavailable.', 'voice_down');
    audio = body.audioContent;
    await kv('SET', cacheKey, audio, 'EX', 60 * 60 * 24 * 60);
  }
  return new Uint8Array(Buffer.from(audio, 'base64'));
}
