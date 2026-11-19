import { connect } from 'node:net';

// A tiny Redis client for our own Redis on the same server (REDIS_URL, e.g. redis://:secret@127.0.0.1:6379):
// one short connection per command, speaking Redis's own protocol (RESP), so no package is needed.
// It answers like Upstash's REST API: strings, numbers, null and arrays. support/helpers/kv.ts picks it when set.

/** A command Redis refused (its "-ERR …" reply). */
export class RedisError extends Error {}

/** A command as Redis expects it on the wire: an array of byte strings. */
export function encode(command: (string | number)[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${command.length}\r\n`)];
  for (const c of command) {
    const b = Buffer.from(String(c), 'utf8');
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

/** One reply from `buf` at `at`: [value, where the next one starts], or null while it is incomplete. */
export function parse(buf: Buffer, at = 0): [unknown, number] | null {
  const end = buf.indexOf('\r\n', at);
  if (end < 0) return null;
  const kind = buf[at];
  const line = buf.toString('utf8', at + 1, end);
  const next = end + 2;
  switch (kind) {
    case 0x2b: return [line, next]; // + simple string ("OK")
    case 0x2d: return [new RedisError(line), next]; // - error
    case 0x3a: return [Number(line), next]; // : integer
    case 0x24: { // $ bulk string
      const n = Number(line);
      if (n < 0) return [null, next];
      if (buf.length < next + n + 2) return null;
      return [buf.toString('utf8', next, next + n), next + n + 2];
    }
    case 0x2a: { // * array
      const n = Number(line);
      if (n < 0) return [null, next];
      const out: unknown[] = [];
      let pos = next;
      for (let i = 0; i < n; i++) {
        const r = parse(buf, pos);
        if (!r) return null;
        out.push(r[0]);
        pos = r[1];
      }
      return [out, pos];
    }
    default:
      throw new RedisError(`Unexpected reply from Redis (${String.fromCharCode(kind)})`);
  }
}

/** Runs one command on the Redis at `url` (signing in first when the URL has a password). */
export function redisCommand(url: string, command: (string | number)[], timeoutMs = 3000): Promise<unknown> {
  const u = new URL(url);
  const commands: (string | number)[][] = [];
  if (u.password) commands.push(u.username ? ['AUTH', decodeURIComponent(u.username), decodeURIComponent(u.password)] : ['AUTH', decodeURIComponent(u.password)]);
  const db = u.pathname.replace('/', '');
  if (db) commands.push(['SELECT', db]);
  commands.push(command);

  return new Promise((resolve, reject) => {
    const socket = connect({ host: u.hostname || '127.0.0.1', port: Number(u.port || 6379) });
    let buf: Buffer = Buffer.alloc(0);
    let pos = 0;
    const replies: unknown[] = [];
    let done = false;
    const finish = (err: Error | null, value?: unknown) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('Redis did not answer in time')));
    socket.on('error', (e) => finish(e));
    socket.on('close', () => finish(new Error('Redis closed the connection')));
    socket.on('connect', () => socket.write(Buffer.concat(commands.map(encode))));
    socket.on('data', (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try {
        for (let r = parse(buf, pos); r; r = parse(buf, pos)) {
          replies.push(r[0]);
          pos = r[1];
          if (replies.length === commands.length) {
            const failed = replies.find((x) => x instanceof RedisError);
            return failed ? finish(failed as RedisError) : finish(null, replies[replies.length - 1]);
          }
        }
      } catch (e) {
        finish(e as Error);
      }
    });
  });
}
