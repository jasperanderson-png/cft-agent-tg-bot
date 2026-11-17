import { createHash } from 'node:crypto';
import { env } from './env.js';
import { HttpError } from './http.js';

// The Redis store (Upstash, REST) shared with the United Fuel app: monthly budgets that keep TomTom
// truck routing and Google natural voice inside their free allowances, per-client rate limits, and
// the voice clip cache. The key names are the same as United Fuel's (server/navigation.mjs), so the
// two apps count against ONE cap and share cached voice clips.

/** Free allowances, kept a little under the providers' limits (same numbers as United Fuel). */
export const BUDGETS = { route: 19_000, voice: 900_000 } as const;
export type Budget = keyof typeof BUDGETS;

export const kvReady = () => !!(env.kvUrl && env.kvToken);
export const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const month = () => new Date().toISOString().slice(0, 7);

/** One Redis command over Upstash's REST API. */
export async function kv(...command: (string | number)[]): Promise<unknown> {
  if (!kvReady()) throw new HttpError(503, 'Storage is not configured.', 'kv_off');
  let res: Response;
  try {
    res = await fetch(env.kvUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.kvToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    throw new HttpError(503, 'Storage did not answer.', 'kv_down');
  }
  const data = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
  if (!res.ok || data.error) throw new HttpError(503, 'Storage is unavailable.', 'kv_down');
  return data.result;
}

/** Spends `amount` of this month's allowance, or refuses once it is used up (then the caller falls back). */
export async function spend(name: Budget, amount: number): Promise<void> {
  const key = `fuel:budget:${name}:${month()}`;
  const used = Number(await kv('INCRBY', key, amount));
  if (used === amount) await kv('EXPIRE', key, 60 * 60 * 24 * 40);
  if (used > BUDGETS[name]) {
    await kv('DECRBY', key, amount);
    throw new HttpError(503, "This month's free allowance is used up.", 'allowance');
  }
}

// Without Redis (local work, the VM without it) or when it does not answer, counters live in this
// server's memory: still a guard, per server instead of shared.
const local = new Map<string, { n: number; until: number }>();
function localIncr(key: string, ttlSec: number, now = Date.now()): number {
  if (local.size > 5000) for (const [k, v] of local) if (v.until <= now) local.delete(k);
  const e = local.get(key);
  if (!e || e.until <= now) { local.set(key, { n: 1, until: now + ttlSec * 1000 }); return 1; }
  return ++e.n;
}

/**
 * At most `perMinute` calls per client per minute (abuse guard). `client` is a Telegram user
 * ("tg:<id>") for signed-in calls, else the IP address.
 */
export async function rateLimit(name: string, client: string | null, perMinute: number): Promise<void> {
  const key = `fuel:nav:rate:${name}:${digest(client ?? 'local')}:${Math.floor(Date.now() / 60_000)}`;
  let count: number;
  try {
    if (!kvReady()) throw new Error('no redis');
    count = Number(await kv('INCR', key));
    if (count === 1) await kv('EXPIRE', key, 120);
  } catch {
    count = localIncr(key, 120);
  }
  if (count > perMinute) throw new HttpError(429, 'Too many requests. Please wait a moment.', 'rate');
}

/**
 * True the first time `key` is seen within `ttlSec` (Redis SET NX, else this server's memory): for
 * "say it once" messages such as the live location alerts.
 */
export async function firstTime(key: string, ttlSec: number): Promise<boolean> {
  try {
    if (!kvReady()) throw new Error('no redis');
    return (await kv('SET', key, '1', 'NX', 'EX', ttlSec)) === 'OK';
  } catch {
    return localIncr(key, ttlSec) === 1;
  }
}

/** A small JSON value kept for `ttlSec` (Redis, else memory). */
const localJson = new Map<string, { v: string; until: number }>();
export async function putJson(key: string, value: unknown, ttlSec: number): Promise<void> {
  const v = JSON.stringify(value);
  try {
    if (!kvReady()) throw new Error('no redis');
    await kv('SET', key, v, 'EX', ttlSec);
  } catch {
    localJson.set(key, { v, until: Date.now() + ttlSec * 1000 });
  }
}
export async function getJson<T>(key: string): Promise<T | null> {
  let v: string | null = null;
  try {
    if (!kvReady()) throw new Error('no redis');
    v = (await kv('GET', key)) as string | null;
  } catch {
    const e = localJson.get(key);
    v = e && e.until > Date.now() ? e.v : null;
  }
  try {
    return v == null ? null : (JSON.parse(v) as T);
  } catch {
    return null;
  }
}
