// Driver Leads in the Mini App (tools/driver-leads/app.ts): the same leads and files as the bot's
// buttons, handed over as 10-minute download links instead of chat messages. Every new lead still goes
// out once, also across the bot and the Mini App. Telegram is stubbed. Needs TEST_DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePool, getPool } from '../../../database/db.js';
import { migrate } from '../../../database/migrate.js';
import { seed } from '../../../database/seeds/academy/seed.js';
import type { ApiRequest } from '../../../support/helpers/http.js';
import { signInitData } from '../../../support/helpers/tests/helpers.js';
import { handle as router } from '../../../telegram_bot/server/router.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* optional */
}
const DB = process.env.TEST_DATABASE_URL;
const BOT = '777000:TEST';

describe.skipIf(!DB)('Driver Leads in the Mini App (PostgreSQL)', () => {
  const OWNER = 9447180;
  let ip = 1;
  let token = '';
  const call = (method: string, path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    router({ method, path, query: new URLSearchParams(), headers: { 'content-type': 'application/json', 'user-agent': 'vitest', ...headers }, body, ip: `10.9.0.${ip++ % 250}` } as ApiRequest);
  const admin = (method: string, path: string, body: unknown = {}) => call(method, path, body, { authorization: `Bearer ${token}` });
  const register = (i: number, state: string, cdl: string) =>
    call('POST', 'leads/register', { consent: true, full_name: `Driver${i} Test`, phone: `845270${String(1000 + i)}`, state, cdl_class: cdl });
  /** Downloads a link the way the Mini App does, and returns the file. */
  const download = async (path: string) => (await router({ method: 'GET', path: path.replace('/api/', ''), query: new URLSearchParams(), headers: {}, body: null, ip: null } as ApiRequest)).file!;

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB, TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_WEBHOOK_SECRET: 'hook-secret-1234567890', APP_URL: 'https://app.example.com',
      ADMIN_TELEGRAM_IDS: String(OWNER), GOOGLE_SERVICE_ACCOUNT_JSON: '', LEADS_FMCSA_ENABLED: 'false', LEADS_COMPANY_NAME: 'CFT',
    });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })));
    await getPool().query('drop schema public cascade; create schema public;');
    await migrate(() => {});
    await seed(() => {});
    const login = await call('POST', 'admin/telegram-login', { initData: signInitData({ id: OWNER, first_name: 'Owner' }, BOT) });
    token = (login.body as { token: string }).token;
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await closePool();
  });

  it('shows the statistics and what can be downloaded, to admins only', async () => {
    for (const [i, st, cdl] of [[1, 'TX', 'A'], [2, 'TX', 'B'], [3, 'OK', 'A']] as const) expect((await register(i, st, cdl)).status).toBe(201);
    const d = (await admin('GET', 'leads/app')).body as { stats: { total: number; waiting: number }; states: { key: string; n: number }[]; cdls: { key: string; n: number }[] };
    expect(d.stats).toMatchObject({ total: 3, waiting: 3 });
    expect(d.states).toEqual(expect.arrayContaining([{ key: 'TX', n: 2 }, { key: 'OK', n: 1 }]));
    expect(d.cdls.map((c) => c.key)).toEqual(expect.arrayContaining(['A', 'B']));
    expect((await call('GET', 'leads/app')).status).toBe(401);
    expect((await call('POST', 'leads/app/recent')).status).toBe(401);
  });

  it('hands out every new lead once, as an Excel download, and the last file again on request', async () => {
    const r = (await admin('POST', 'leads/app/recent')).body as { file: { path: string; filename: string }; count: number; more: boolean };
    expect(r).toMatchObject({ count: 3, more: false });
    expect(r.file.filename).toMatch(/New_Leads.*\.xlsx$/);
    const f = await download(r.file.path);
    expect(f.contentType).toContain('spreadsheetml');
    expect(f.content.length).toBeGreaterThan(1000);
    // Delivered: nothing new now, and the bot's GET RECENT LEADS wouldn't send them again either.
    expect((await admin('POST', 'leads/app/recent')).body).toEqual({ file: null, count: 0, more: false });
    expect(((await admin('GET', 'leads/app')).body as { stats: { waiting: number } }).stats.waiting).toBe(0);
    // The last file again: the same 3 leads, still delivered.
    const again = (await admin('POST', 'leads/app/last')).body as { file: { filename: string }; count: number };
    expect(again.count).toBe(3);
    // A new sign-up is new again.
    await register(4, 'AR', 'C');
    expect(((await admin('POST', 'leads/app/recent')).body as { count: number }).count).toBe(1);
  });

  it('downloads read-only files: a state, a CDL class, CSV and the full database', async () => {
    const tx = (await admin('POST', 'leads/app/export', { kind: 'state', filter: 'TX' })).body as { file: { path: string; filename: string }; count: number; next: unknown };
    expect(tx).toMatchObject({ count: 2, next: null });
    expect(tx.file.filename).toMatch(/Leads_TX/);
    const csv = (await admin('POST', 'leads/app/export', { kind: 'csv' })).body as { file: { path: string; filename: string }; count: number };
    expect(csv.count).toBe(4);
    const text = Buffer.from((await download(csv.file.path)).content).toString('utf8');
    expect(text).toContain('Driver1');
    expect(((await admin('POST', 'leads/app/export', { kind: 'cdl', filter: 'A' })).body as { count: number }).count).toBe(2);
    expect(((await admin('POST', 'leads/app/export', { kind: 'full' })).body as { count: number }).count).toBe(4);
    // A state nobody is in: nothing to download; a bad request is refused.
    expect((await admin('POST', 'leads/app/export', { kind: 'state', filter: 'ZZ' })).body).toMatchObject({ file: null, count: 0 });
    expect((await admin('POST', 'leads/app/export', { kind: 'state' })).status).toBe(400);
    expect((await admin('POST', 'leads/app/export', { kind: 'everything' })).status).toBe(400);
  });
});
