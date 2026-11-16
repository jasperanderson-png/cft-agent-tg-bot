// Telegram-first admin features: owners, admin management, users, result notifications, Excel reports,
// weekly summaries and bot commands. Telegram's API is replaced with a recording stub.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { excelSerial, fmtDMY, fmtDMYHM, rangeFor, weekStart } from '../../../shared/time.js';
import { closePool, getPool } from '../../../db_storage/db.js';
import type { ApiRequest } from '../../../core/http.js';
import { resultMessage } from '../notify.js';
import { handle } from '../../../telegram_bot/server/router.js';
import { buildXlsx, colName } from '../../../core/xlsx.js';
import { migrate } from '../../../db_storage/migrate.js';
import { seed } from '../../../db_storage/seeds/academy/seed.js';
import { signInitData } from '../../../core/tests/helpers.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* optional */
}
const DB = process.env.TEST_DATABASE_URL;
const BOT = '777000:TEST-bot-token';
const OWNER = 9447180;
const OWNER2 = 1270439555;
const OFFICIAL: { n: number; correct: string }[] = JSON.parse(readFileSync('db_storage/seeds/academy/questions.json', 'utf8'));

let hasPython = true;
try {
  execFileSync('python3', ['-c', 'import openpyxl']);
} catch {
  hasPython = false;
}

/** Reads an .xlsx with openpyxl so we know real spreadsheet software can open it. */
function inspectXlsx(bytes: Uint8Array) {
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
  const file = join(dir, 'r.xlsx');
  writeFileSync(file, bytes);
  const py = `
import json, sys, openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
out = {}
for ws in wb.worksheets:
    rows = [[(c.value.isoformat() if hasattr(c.value, 'isoformat') else c.value) for c in r] for r in ws.iter_rows(max_row=min(ws.max_row, 6))]
    fmts = [[c.number_format for c in r] for r in ws.iter_rows(min_row=2, max_row=2)]
    out[ws.title] = {"rows": rows, "fmts": fmts, "freeze": ws.freeze_panes, "filter": ws.auto_filter.ref, "max_row": ws.max_row}
print(json.dumps(out, default=str))`;
  return JSON.parse(execFileSync('python3', ['-I', '-c', py, file]).toString());
}

describe('time helpers', () => {
  const tz = 'Asia/Tashkent'; // UTC+5, no DST
  it('formats dd/mm/yyyy in the report time zone', () => {
    expect(fmtDMY('2026-10-29T20:30:00Z', tz)).toBe('30/10/2026');
    expect(fmtDMYHM('2026-10-29T20:30:59Z', tz)).toBe('30/10/2026 01:30');
    expect(fmtDMY('2026-10-29T20:30:00Z', 'America/Chicago')).toBe('29/10/2026');
  });
  it('finds Monday-start weeks', () => {
    expect(weekStart('2026-10-29T12:00:00Z', tz).toISOString()).toBe('2026-10-25T19:00:00.000Z'); // Mon 26/10 00:00 +05
    expect(weekStart('2026-10-29T12:00:00Z', tz, -1).toISOString()).toBe('2026-10-18T19:00:00.000Z');
    const r = rangeFor('last_week', tz, new Date('2026-10-29T12:00:00Z'));
    expect(r.label).toBe('19/10/2026 – 25/10/2026');
  });
  it('converts to Excel serial dates rounded to the minute', () => {
    expect(excelSerial('2026-10-29T19:00:40Z', tz)).toBe(Date.UTC(2026, 9, 30) / 86_400_000 + 25_569);
  });
});

describe.skipIf(!hasPython)('xlsx writer', () => {
  it('produces a workbook openpyxl can read, with frozen header, filter and formats', () => {
    const bytes = buildXlsx([
      {
        name: 'Results',
        columns: [{ header: 'Name', width: 20 }, { header: 'Date', width: 12 }, { header: 'Pct', width: 8 }],
        rows: [
          ['=HYPERLINK("x") & <b>', { v: Date.UTC(2026, 9, 30) / 86_400_000 + 25_569, s: 'date' }, { v: 0.733, s: 'pct' }],
          ['Ann “Lee” \u0007', null, { v: 'PASS', s: 'good' }],
        ],
      },
      { name: 'Bad:/name*?', columns: [{ header: 'a', width: 5 }], rows: [], table: false },
    ]);
    const x = inspectXlsx(bytes);
    expect(Object.keys(x)).toEqual(['Results', 'Bad  name']);
    expect(x.Results.rows[0]).toEqual(['Name', 'Date', 'Pct']);
    expect(x.Results.rows[1]).toEqual(['=HYPERLINK("x") & <b>', '2026-10-30T00:00:00', 0.733]);
    expect(x.Results.rows[2][0]).toBe('Ann “Lee” ');
    expect(x.Results.fmts[0]).toEqual(['General', 'dd/mm/yyyy', '0%']);
    expect(x.Results.freeze).toBe('A2');
    expect(x.Results.filter).toBe('A1:C3');
  });
  it('names columns past Z', () => {
    expect([colName(0), colName(25), colName(26), colName(33)]).toEqual(['A', 'Z', 'AA', 'AH']);
  });
});

describe('result message', () => {
  const base = { id: 'x', name: 'Ann <Lee>', username: 'ann_l', total: 30, passMark: 21, unanswered: 2, durationSec: 1260, submittedAt: new Date('2026-10-29T09:05:00Z') };
  it('reports pass and fail with escaped names and dd/mm/yyyy', () => {
    expect(resultMessage({ ...base, correct: 24, pct: 80 }, 'Asia/Tashkent')).toBe(
      '✅ <b>PASSED</b> · Ann &lt;Lee&gt; (@ann_l)\nScore <b>24/30</b> (80%) · pass mark 21\n2 unanswered · 21 min · 29/10/2026 14:05',
    );
    expect(resultMessage({ ...base, correct: 18, pct: 60, unanswered: 0, username: null }, 'Asia/Tashkent')).toMatch(/^❌ <b>FAILED<\/b> · Ann &lt;Lee&gt;\nScore <b>18\/30<\/b> \(60%\)/);
  });
});

describe.skipIf(!DB)('Telegram admin features (PostgreSQL)', () => {
  const sent: { method: string; chat_id?: number; text?: string; filename?: string; body?: any }[] = [];
  const realFetch = globalThis.fetch;

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const req: ApiRequest = { method, path, query: new URLSearchParams(), headers, body: body ?? null, ip: '10.0.0.2' };
    const res = await handle(req);
    return { status: res.status, body: res.body as any, file: res.file };
  }
  const tg = (id: number, first = 'Test', last = 'User') => signInitData({ id, first_name: first, last_name: last, username: 'u' + id }, BOT);
  const bearer = (t: string) => ({ authorization: 'Bearer ' + t });
  const hook = (update: unknown) => call('POST', 'telegram/webhook', update, { 'x-telegram-bot-api-secret-token': 'hook-secret-1234567890' });
  const msg = (from: number, text: string) => ({ update_id: 1, message: { chat: { id: from, type: 'private' }, from: { id: from, first_name: 'U' + from }, text } });
  async function takeTest(id: number, name: string, correctUpTo: number) {
    const s = await call('POST', 'attempts', { name, initData: tg(id, ...(name.split(' ') as [string, string])) });
    const answers = Object.fromEntries(OFFICIAL.filter((q) => q.n <= correctUpTo).map((q) => [q.n, q.correct]));
    return call('POST', `attempts/${s.body.attemptId}/submit`, { answers }, { 'x-attempt-token': s.body.token });
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB, TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_WEBHOOK_SECRET: 'hook-secret-1234567890', APP_URL: 'https://academy.example.com',
      ADMIN_TELEGRAM_IDS: `${OWNER}, ${OWNER2}`, CRON_SECRET: 'cron-secret-abcdefghij', ALLOW_WEB_CANDIDATES: 'false', GOOGLE_SERVICE_ACCOUNT_JSON: '',
    });
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (!u.startsWith('https://api.telegram.org/')) return realFetch(url, init);
      const method = u.split('/').pop()!;
      if (init?.body instanceof FormData) {
        const f = init.body.get('document') as File;
        sent.push({ method, chat_id: Number(init.body.get('chat_id')), filename: f.name, body: new Uint8Array(await f.arrayBuffer()) });
      } else {
        const b = JSON.parse(String(init?.body ?? '{}'));
        sent.push({ method, chat_id: b.chat_id, text: b.text, body: b });
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), { headers: { 'content-type': 'application/json' } });
    });
    await getPool().query('drop schema public cascade; create schema public;');
    await migrate(() => {});
    await seed(() => {});
  });
  beforeEach(() => {
    sent.length = 0;
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await closePool();
  });

  let ownerToken = '';
  let adminToken = '';

  it('signs owners in with one tap and creates their admin row', async () => {
    const r = await call('POST', 'admin/telegram-login', { initData: tg(OWNER, 'Owner', 'One') });
    expect(r.status).toBe(200);
    ownerToken = r.body.token;
    expect((await call('GET', 'admin/me', undefined, bearer(ownerToken))).body).toMatchObject({ role: 'owner', telegramUserId: OWNER, name: 'Owner One' });
    expect((await call('POST', 'admin/telegram-login', { initData: tg(5555) })).status).toBe(403);
    expect((await call('POST', 'session', { initData: tg(OWNER2) })).body).toMatchObject({ state: 'none', isAdmin: true });
  });

  it('lets admins add admins by Telegram ID, and only owners remove them', async () => {
    expect((await call('POST', 'admin/admins', { telegramUserId: 'abc' }, bearer(ownerToken))).status).toBe(400);
    const add = await call('POST', 'admin/admins', { telegramUserId: '7001', name: 'Dana Admin' }, bearer(ownerToken));
    expect(add.status).toBe(200);
    expect((await call('POST', 'admin/admins', { telegramUserId: 7001 }, bearer(ownerToken))).status).toBe(409);

    const login = await call('POST', 'admin/telegram-login', { initData: tg(7001) });
    expect(login.status).toBe(200);
    adminToken = login.body.token;
    const owner2 = (await getPool().query('select id from admins where telegram_user_id = $1', [OWNER2])).rows[0].id;
    expect((await call('DELETE', `admin/admins/${add.body.id}`, undefined, bearer(adminToken))).status).toBe(403);
    expect((await call('DELETE', `admin/admins/${owner2}`, undefined, bearer(ownerToken))).status).toBe(400);
    const ownerId = (await call('GET', 'admin/me', undefined, bearer(ownerToken))).body.id;
    expect((await call('DELETE', `admin/admins/${ownerId}`, undefined, bearer(ownerToken))).status).toBe(400);

    const extra = await call('POST', 'admin/admins', { telegramUserId: 7002 }, bearer(adminToken));
    expect((await call('DELETE', `admin/admins/${extra.body.id}`, undefined, bearer(ownerToken))).status).toBe(200);
    expect((await call('POST', 'admin/telegram-login', { initData: tg(7002) })).status).toBe(403);
  });

  it('notifies admins when a candidate passes or fails, respecting preferences', async () => {
    await hook(msg(OWNER, '/start')); // owners must have started the bot to receive messages
    sent.length = 0;
    const pass = await takeTest(8001, 'Pat Pass', 25);
    expect(pass.body.passed).toBe(true);
    const toOwner = sent.filter((m) => m.method === 'sendMessage' && m.chat_id === OWNER);
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0].text).toContain('✅ <b>PASSED</b> · Pat Pass');
    expect(toOwner[0].body.reply_markup.inline_keyboard[0][0].web_app.url).toBe(`https://academy.example.com/#/admin/attempt/${pass.body.attemptId}`);
    expect(sent.map((m) => m.chat_id)).toEqual(expect.arrayContaining([OWNER2, 7001]));

    await call('PUT', 'admin/me', { notifyResults: false, weeklyReport: true }, bearer(ownerToken));
    sent.length = 0;
    const fail = await takeTest(8002, 'Finn Fail', 10);
    expect(fail.body.passed).toBe(false);
    expect(sent.some((m) => m.chat_id === OWNER)).toBe(false);
    expect(sent.find((m) => m.chat_id === OWNER2)?.text).toContain('❌ <b>FAILED</b> · Finn Fail');
    await call('PUT', 'admin/me', { notifyResults: true, weeklyReport: true }, bearer(ownerToken));
  });

  it('lists users with their role and latest result', async () => {
    const r = await call('GET', 'admin/users', undefined, bearer(adminToken));
    expect(r.status).toBe(200);
    const pat = r.body.find((u: any) => u.telegramUserId === 8001);
    expect(pat).toMatchObject({ name: 'Pat Pass', admin: null, attempts: 1, latest: { status: 'completed', correct: 25, passed: true } });
    expect(r.body.find((u: any) => u.telegramUserId === OWNER)).toMatchObject({ startedBot: true, admin: { role: 'owner' } });
    expect(r.body.find((u: any) => u.telegramUserId === 7001)?.admin).toMatchObject({ role: 'admin', name: 'Dana Admin', addedBy: 'Owner One' });
    expect((await call('GET', 'admin/users')).status).toBe(401);
  });

  it.skipIf(!hasPython)('builds a clean Excel report for download', async () => {
    const r = await call('POST', 'admin/reports', { range: 'all', deliver: 'download' }, bearer(ownerToken));
    expect(r.body.filename).toMatch(/^CFT_Academy_Report_all-time_\d\d-\d\d-\d{4}\.xlsx$/);
    const file = (await call('GET', r.body.path.replace('/api/', ''))).file!;
    expect(file.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const x = inspectXlsx(file.content as Uint8Array);
    expect(Object.keys(x)).toEqual(['Summary', 'Results', 'In progress', 'Answers', 'Questions', 'Topics']);
    expect(x.Results.rows[0]).toEqual(['#', 'Candidate', 'Telegram', 'Date', 'Time', 'Score', 'Percent', 'Result', 'Unanswered', 'Duration (min)']);
    expect(x.Results.max_row).toBe(3);
    expect(x.Results.fmts[0].slice(3, 7)).toEqual(['dd/mm/yyyy', 'hh:mm', 'General', '0%']);
    const finn = x.Results.rows.find((row: any[]) => row[1] === 'Finn Fail');
    expect(finn.slice(5, 8)).toEqual(['10/30', 0.333, 'FAIL']);
    expect(x.Summary.rows[0][0]).toBe('CFT Agent Academy — Results report');
    expect(x.Answers.rows[0].slice(0, 4)).toEqual(['Candidate', 'Date', 'Score', 'Q1']);
  });

  it('sends reports to the admin’s Telegram chat', async () => {
    const r = await call('POST', 'admin/reports', { range: 'week', deliver: 'telegram' }, bearer(ownerToken));
    expect(r.body).toEqual({ sent: true });
    const doc = sent.find((m) => m.method === 'sendDocument');
    expect(doc).toMatchObject({ chat_id: OWNER, filename: expect.stringMatching(/^CFT_Academy_Week_.+\.xlsx$/) });
    expect(Buffer.from(doc!.body.slice(0, 2)).toString()).toBe('PK');
  });

  it('runs the weekly summary from cron once per week', async () => {
    expect((await call('GET', 'cron/weekly')).status).toBe(401);
    expect((await call('GET', 'cron/weekly', undefined, { authorization: 'Bearer wrong' })).status).toBe(401);
    const r = await call('GET', 'cron/weekly', undefined, { authorization: 'Bearer cron-secret-abcdefghij' });
    expect(r.status).toBe(200);
    expect(r.body.sent).toBeGreaterThan(0);
    expect(sent.find((m) => m.method === 'sendMessage' && m.chat_id === OWNER)?.text).toContain('📊 <b>Academy · Weekly report</b>');
    expect(sent.some((m) => m.method === 'sendDocument' && m.chat_id === OWNER)).toBe(true);
    const again = await call('GET', 'cron/weekly', undefined, { authorization: 'Bearer cron-secret-abcdefghij' });
    expect(again.body).toEqual({ sent: 0, skipped: 'already sent this week' });
  });

  it('handles bot commands for candidates and admins', async () => {
    await hook(msg(9100, '/start'));
    const welcome = sent.find((m) => m.chat_id === 9100)!;
    expect(welcome.body.reply_markup.inline_keyboard).toEqual([[{ text: 'Open CFT Agent Academy', web_app: { url: 'https://academy.example.com' } }]]);

    sent.length = 0;
    await hook(msg(9100, '/report'));
    expect(sent[0].text).toContain('for CFT administrators');
    expect(sent.some((m) => m.method === 'sendDocument')).toBe(false);

    sent.length = 0;
    await hook(msg(OWNER, '/stats'));
    expect(sent.find((m) => m.method === 'sendMessage')?.text).toMatch(/📊 <b>Academy · This week so far<\/b>[\s\S]*Completed: <b>2<\/b>[\s\S]*Pass rate <b>50%<\/b>/);

    sent.length = 0;
    await hook(msg(OWNER, '/report 30d'));
    expect(sent.find((m) => m.method === 'sendDocument')?.filename).toMatch(/last-30-days/);

    // Owners also have Driver Leads, so /start asks which section they want.
    sent.length = 0;
    await hook(msg(OWNER, '/start'));
    expect(sent[0].body.reply_markup.keyboard[0].map((b: any) => b.text)).toEqual(['🎓 Agent Academy', '🚚 Driver Leads']);
    expect(sent.some((m) => m.method === 'setMyCommands' && m.body.scope?.chat_id === OWNER)).toBe(true);
    sent.length = 0;
    await hook(msg(OWNER, '🎓 Agent Academy'));
    expect(sent[0].body.reply_markup.inline_keyboard[1][0]).toEqual({ text: 'Admin console', web_app: { url: 'https://academy.example.com/#/admin' } });
    expect(sent[1].text).toContain('Agent Academy · Admin commands');

    // Every Academy admin has both sections; a candidate has only the test.
    sent.length = 0;
    await hook(msg(7001, '/start'));
    expect(sent[0].body.reply_markup.keyboard[0].map((b: any) => b.text)).toEqual(['🎓 Agent Academy', '🚚 Driver Leads']);
    sent.length = 0;
    await hook(msg(9100, '/start'));
    await hook(msg(9100, '/help'));
    expect(sent.some((m) => m.body?.reply_markup?.keyboard || /Driver Leads/.test(m.text ?? ''))).toBe(false);
  });

  it('stops messaging people who block the bot', async () => {
    await hook({ update_id: 2, my_chat_member: { chat: { type: 'private' }, from: { id: OWNER2, first_name: 'O2' }, new_chat_member: { status: 'kicked' } } });
    expect((await getPool().query('select blocked_bot from telegram_users where id = $1', [OWNER2])).rows[0].blocked_bot).toBe(true);
    sent.length = 0;
    await takeTest(8003, 'Ben Block', 22);
    expect(sent.some((m) => m.chat_id === OWNER2)).toBe(false);
    expect(sent.some((m) => m.chat_id === OWNER)).toBe(true);
  });

  it('validates the report time zone', async () => {
    const base = { passMark: 21, minSample: 10, allowRetakes: false };
    expect((await call('PUT', 'admin/settings', { ...base, timezone: 'Mars/Base' }, bearer(ownerToken))).status).toBe(400);
    expect((await call('PUT', 'admin/settings', { ...base, timezone: 'America/Chicago' }, bearer(ownerToken))).body.timezone).toBe('America/Chicago');
  });
});
