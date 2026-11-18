import { createServer, type Server } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { firstTime, getJson, kv, putJson, rateLimit, spendCapped } from '../kv.js';
import { encode, parse, RedisError } from '../redis.js';

// Our own Redis (REDIS_URL): a fake one in memory that speaks Redis's protocol, with a password.
const store = new Map<string, string>();
const seen: string[][] = [];
let server: Server;
let port = 0;

function reply(cmd: string[], authed: { ok: boolean }): string {
  const [name, ...a] = cmd;
  const op = name.toUpperCase();
  if (op === 'AUTH') { authed.ok = a[a.length - 1] === 's3cret'; return authed.ok ? '+OK\r\n' : '-WRONGPASS invalid password\r\n'; }
  if (!authed.ok) return '-NOAUTH Authentication required.\r\n';
  const bulk = (v: string | undefined) => (v == null ? '$-1\r\n' : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
  switch (op) {
    case 'GET': return bulk(store.get(a[0]));
    case 'SET': {
      if (a.includes('NX') && store.has(a[0])) return '$-1\r\n';
      store.set(a[0], a[1]);
      return '+OK\r\n';
    }
    case 'INCR': case 'INCRBY': case 'DECRBY': {
      const by = op === 'INCR' ? 1 : Number(a[1]) * (op === 'DECRBY' ? -1 : 1);
      const n = Number(store.get(a[0]) ?? 0) + by;
      store.set(a[0], String(n));
      return `:${n}\r\n`;
    }
    case 'EXPIRE': return ':1\r\n';
    case 'DEL': return `:${store.delete(a[0]) ? 1 : 0}\r\n`;
    default: return `-ERR unknown command '${name}'\r\n`;
  }
}

beforeAll(async () => {
  server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    const authed = { ok: false };
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (let r = parse(buf); r; r = parse(buf)) {
        buf = buf.subarray(r[1]);
        seen.push(r[0] as string[]);
        socket.write(reply(r[0] as string[], authed));
      }
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));
afterEach(() => { delete process.env.REDIS_URL; store.clear(); seen.length = 0; });

const useRedis = (password = 's3cret', p = port) => { process.env.REDIS_URL = `redis://:${password}@127.0.0.1:${p}`; };

describe('redis · our own Redis protocol', () => {
  it('writes commands and reads every kind of reply, also when they arrive in pieces', () => {
    expect(encode(['SET', 'k', 'café']).toString()).toBe('*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$5\r\ncafé\r\n');
    const all = Buffer.from('+OK\r\n:42\r\n$5\r\ncafé\r\n$-1\r\n*2\r\n:1\r\n$1\r\nx\r\n-ERR no\r\n');
    const out: unknown[] = [];
    let at = 0;
    for (let r = parse(all, at); r; r = parse(all, at)) { out.push(r[0]); at = r[1]; }
    expect(out.slice(0, 5)).toEqual(['OK', 42, 'café', null, [1, 'x']]);
    expect(out[5]).toBeInstanceOf(RedisError);
    expect(parse(Buffer.from('$5\r\ncaf'))).toBeNull(); // not all here yet
  });
});

describe('redis · the bot on its own Redis (REDIS_URL)', () => {
  it('signs in and answers like Upstash: strings, numbers and null', async () => {
    useRedis();
    expect(await kv('SET', 'cft:t', 'v', 'EX', 60)).toBe('OK');
    expect(await kv('GET', 'cft:t')).toBe('v');
    expect(await kv('GET', 'cft:none')).toBeNull();
    expect(await kv('INCRBY', 'cft:n', 5)).toBe(5);
    expect(seen[0]).toEqual(['AUTH', 's3cret']);
  });
  it('keeps the free allowances in Redis, so a restart does not reset them', async () => {
    useRedis();
    await spendCapped('t-cap', 2, { perDay: 3, perMonth: 100 });
    await expect(spendCapped('t-cap', 2, { perDay: 3, perMonth: 100 })).rejects.toMatchObject({ code: 'allowance' });
    const day = [...store.keys()].find((k) => k.startsWith('cft:budget:t-cap:') && k.length > 'cft:budget:t-cap:2026-11'.length);
    expect(store.get(day!)).toBe('2'); // the refused call was given back
  });
  it('says things once, and keeps small values', async () => {
    useRedis();
    expect(await firstTime('cft:once:1', 60)).toBe(true);
    expect(await firstTime('cft:once:1', 60)).toBe(false);
    await putJson('cft:j', { a: [1, 'two'] }, 60);
    expect(await getJson('cft:j')).toEqual({ a: [1, 'two'] });
  });
  it('refuses with a storage error on a wrong password, and the guards still work from memory', async () => {
    useRedis('wrong');
    await expect(kv('GET', 'cft:x')).rejects.toMatchObject({ status: 503, code: 'kv_down' });
    for (let i = 0; i < 2; i++) await rateLimit('t-wrongpw', 'tg:1', 2);
    await expect(rateLimit('t-wrongpw', 'tg:1', 2)).rejects.toMatchObject({ status: 429 });
  });
  it('falls back to memory when Redis is not running', async () => {
    useRedis('s3cret', 1); // nothing listens on port 1
    await expect(kv('GET', 'cft:x')).rejects.toMatchObject({ code: 'kv_down' });
    expect(await firstTime('cft:down:1', 60)).toBe(true);
    expect(await firstTime('cft:down:1', 60)).toBe(false);
  });
});
