import pg from 'pg';
import { env } from '../core/env.js';
import { HttpError } from '../core/http.js';

// Return BIGINT/NUMERIC as JS numbers; our values are far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

let pool: pg.Pool | null = null;

function sslFor(url: URL): pg.PoolConfig['ssl'] {
  const mode = process.env.DATABASE_SSL;
  if (mode === 'disable') return false;
  if (!mode && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return false;
  // A database on another machine: TLS with the certificate checked, against DATABASE_CA_CERT if given,
  // otherwise against the system's trusted CAs. Ours is on 127.0.0.1 and needs none of this.
  if (process.env.DATABASE_CA_CERT) return { ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n') };
  return { rejectUnauthorized: true };
}

export function getPool(): pg.Pool {
  if (pool) return pool;
  if (!env.databaseUrl) throw new HttpError(503, 'The server is not configured yet (DATABASE_URL is missing).');
  const url = new URL(env.databaseUrl);
  url.searchParams.delete('sslmode'); // TLS is configured explicitly below
  pool = new pg.Pool({
    connectionString: url.toString(),
    ssl: sslFor(url),
    max: Number(process.env.PG_POOL_MAX ?? 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  });
  pool.on('error', (e) => console.error('pg pool error', e.message));
  return pool;
}

export type Db = pg.PoolClient | pg.Pool;

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
