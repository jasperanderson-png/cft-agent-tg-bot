// Applies db_storage/migrations/*.sql in order, once each. Usage: npm run db:migrate
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closePool, getPool } from './db.js';

const dir = join(import.meta.dirname, 'migrations');

export async function migrate(log = console.log) {
  const db = getPool();
  await db.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  await db.query('alter table schema_migrations enable row level security');
  const done = new Set((await db.query('select name from schema_migrations')).rows.map((r) => r.name));
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const c = await db.connect();
    try {
      await c.query('begin');
      await c.query(readFileSync(join(dir, f), 'utf8'));
      await c.query('insert into schema_migrations (name) values ($1)', [f]);
      await c.query('commit');
      log(`applied ${f}`);
    } catch (e) {
      await c.query('rollback');
      throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
    } finally {
      c.release();
    }
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  migrate()
    .then(() => console.log('Database is up to date.'))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(closePool);
}
