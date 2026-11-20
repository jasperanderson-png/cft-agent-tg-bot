// Indeed applicants: the office script's reports (key, checks, what is new), the hiring-chat cards and
// alerts, the silence watch, the lead-import Excel file (daily and 📥, each applicant once) and the
// admins' section. The database tests need TEST_DATABASE_URL (wiped and rebuilt). Telegram is stubbed.
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, getPool } from '../../../database/db.js';
import { migrate } from '../../../database/migrate.js';
import { seed } from '../../../database/seeds/academy/seed.js';
import type { ApiRequest } from '../../../support/helpers/http.js';
import { SECTION } from '../../../support/helpers/home.js';
import { handle } from '../../../telegram_bot/server/router.js';
import { phoneNumber, splitName } from '../files.js';
import { MAX_CARDS } from '../messages.js';
import { parseApplicant, parseReport, stateOf } from '../report.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* optional */
}
const DB = process.env.TEST_DATABASE_URL;

describe('Indeed report checks', () => {
  it('tidies one applicant and drops the unusable ones', () => {
    const a = parseApplicant({ id: 'sub-1', name: 'NICHOLAS DATTILIO', phone: '+1 845-903-8077', location: 'Pottsville, PA', job: 'CDL A Driver', applied_at: 1795190000000, experience: ['Tri axle driver — Motters', '', 5] });
    expect(a).toMatchObject({ id: 'sub-1', name: 'Nicholas Dattilio', phone: '+18459038077', state: 'PA', job: 'CDL A Driver', experience: ['Tri axle driver — Motters'] });
    expect(a!.appliedAt!.getTime()).toBe(1795190000000);
    expect(parseApplicant({ id: 'x', name: 'A' })).toBeNull();
    expect(parseApplicant({ name: 'Ann Lee' })).toBeNull();
    expect(parseApplicant({ id: 'y', name: 'Ann Lee', phone: '123', applied_at: 'never' })).toMatchObject({ phone: null, appliedAt: null });
    expect([stateOf('Las Vegas, NV'), stateOf('Remote'), stateOf('Toronto, ON'), stateOf(null)]).toEqual(['NV', null, null, null]);
  });

  it('accepts only known statuses and a sane number of applicants', () => {
    expect(() => parseReport({ status: 'great' })).toThrow('status');
    expect(() => parseReport({ status: 'ok', applicants: 'x' })).toThrow('list');
    expect(() => parseReport({ status: 'ok', applicants: Array(201).fill({}) })).toThrow('At most');
    expect(parseReport({ status: 'ok', applicants: [{ id: '1', name: 'Ann Lee' }, {}] })).toMatchObject({ status: 'ok', skipped: 1 });
  });

  it('splits names and writes phones as the CRM file does', () => {
    expect(splitName('Nicholas Dattilio Jr')).toEqual(['Nicholas', 'Dattilio Jr']);
    expect(splitName('Cher')).toEqual(['Cher', '']);
    expect(phoneNumber('+18459038077')).toBe(18459038077);
    expect(phoneNumber(null)).toBeNull();
  });
});

describe.skipIf(!DB)('Indeed applicants (PostgreSQL)', () => {
  const BOT = '777000:TEST-bot-token';
  const KEY = 'indeed-office-key-0123456789abcdef';
  const CRON = 'cron-secret-0123456789';
  const CHAT = -5311699263;
  const OWNER = 9447180;
  const STRANGER = 6666;
  interface Sent { method: string; chat_id?: number; text?: string; body?: any; filename?: string; caption?: string; bytes?: Uint8Array }
  const sent: Sent[] = [];
  let refuseDocuments = false;
  let refuseMessages = false;
  let id = 70_000;
  const realFetch = globalThis.fetch;

  const api = (method: string, path: string, headers: Record<string, string> = {}, body: unknown = null) =>
    handle({ method, path, query: new URLSearchParams(), headers: { 'content-type': 'application/json', ...headers }, body, ip: '10.0.0.3' } as ApiRequest);
  const report = (body: unknown, key = KEY) => api('POST', 'indeed/report', { authorization: `Bearer ${key}` }, body);
  const cron = (job: string) => api('GET', `cron/${job}`, { authorization: `Bearer ${CRON}` });
  const hook = (update: Record<string, unknown>) => handle({ method: 'POST', path: 'telegram/webhook', query: new URLSearchParams(), headers: { 'x-telegram-bot-api-secret-token': 'hook-secret-1234567890' }, body: update, ip: '10.0.0.1' } as ApiRequest);
  const from = (u: number) => ({ id: u, first_name: `User${u}`, username: `u${u}` });
  const say = (u: number, text: string) => hook({ update_id: ++id, message: { chat: { id: u, type: 'private' }, from: from(u), text } });
  const tap = (u: number, data: string) => hook({ update_id: ++id, callback_query: { id: 'cb' + id, from: from(u), data, message: { message_id: 5, chat: { id: u, type: 'private' } } } });
  const toChat = (method = 'sendMessage') => sent.filter((m) => m.chat_id === CHAT && m.method === method);
  const applicant = (n: number, extra: Record<string, unknown> = {}) => ({
    id: `sub-${n}`, name: `Driver${String.fromCharCode(65 + (n % 26))} Number${n}`, phone: `(845) 903-${String(8000 + n).slice(-4)}`,
    location: 'Pottsville, PA', job: 'CDL A Driver', applied_at: Date.UTC(2026, 10, 20, 12, n % 60), experience: ['Tri axle driver — Motters Collision'], ...extra,
  });
  /** The first sheet of an .xlsx as rows of cell texts. */
  const sheetRows = (bytes: Uint8Array) => {
    const xml = strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml']);
    return [...xml.matchAll(/<row [^>]*>(.*?)<\/row>/g)].map((r) => [...r[1].matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>(?:<v>([^<]*)<\/v>|<is><t[^>]*>([^<]*)<\/t><\/is>)<\/c>)/g)].map((c) => [c[1], c[2] ?? c[3] ?? '']));
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB, TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_WEBHOOK_SECRET: 'hook-secret-1234567890', APP_URL: 'https://app.example.com',
      ADMIN_TELEGRAM_IDS: String(OWNER), CRON_SECRET: CRON, INDEED_COLLECTOR_TOKEN: KEY, INDEED_CHAT_ID: String(CHAT), INDEED_LEAD_OWNER: '', GOOGLE_SERVICE_ACCOUNT_JSON: '',
    });
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (!u.startsWith('https://api.telegram.org/')) return realFetch(url, init);
      const method = u.split('/').pop()!;
      if (init?.body instanceof FormData) {
        if (refuseDocuments) return new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 });
        const f = init.body.get('document') as File;
        sent.push({ method, chat_id: Number(init.body.get('chat_id')), filename: f.name, caption: String(init.body.get('caption') ?? ''), bytes: new Uint8Array(await f.arrayBuffer()) });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }
      const b = JSON.parse(String(init?.body ?? '{}'));
      if (refuseMessages && method === 'sendMessage' && b.chat_id === CHAT) return new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was kicked' }), { status: 403 });
      sent.push({ method, chat_id: b.chat_id, text: b.text, body: b });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }));
    });
    await getPool().query('drop schema public cascade; create schema public;');
    await migrate(() => {});
    await seed(() => {});
    await say(OWNER, '/start'); // the owner becomes an admin on first contact
  });
  beforeEach(() => {
    sent.length = 0;
    refuseDocuments = false;
    refuseMessages = false;
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await closePool();
  });

  it('takes reports only with the office key', async () => {
    expect((await report({ status: 'ok' }, 'wrong-key-0123456789abcdef')).status).toBe(401);
    expect((await api('POST', 'indeed/report', {}, { status: 'ok' })).status).toBe(401);
    process.env.INDEED_COLLECTOR_TOKEN = '';
    expect((await report({ status: 'ok' })).status).toBe(503);
    process.env.INDEED_COLLECTOR_TOKEN = KEY;
    expect((await report({ status: 'nope' })).status).toBe(400);
    expect((await cron('indeed-excel')).status).toBe(200);
    expect((await api('GET', 'cron/indeed-excel')).status).toBe(401);
    sent.length = 0;
  });

  it('treats the first report as what was already there: no cards, not in the next file', async () => {
    const r = await report({ status: 'ok', applicants: [applicant(1), applicant(2), { id: 'bad' }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ received: 2, new: 0, skipped: 1, first: true });
    expect(toChat()).toHaveLength(1);
    expect(toChat()[0].text).toContain('connected');
    expect(toChat()[0].text).toContain('2 applicants were already there');
  });

  it('posts a card for each new applicant once, oldest first', async () => {
    const r = await report({ status: 'ok', applicants: [applicant(1), applicant(4, { applied_at: Date.UTC(2026, 10, 20, 15) }), applicant(3, { applied_at: Date.UTC(2026, 10, 20, 14), job: undefined, phone: '' })] });
    expect(r.body).toMatchObject({ received: 3, new: 2, posted: 2, first: false });
    const cards = toChat().map((m) => m.text!);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('<b>DriverD Number3</b>');
    expect(cards[0]).toContain('no phone number');
    expect(cards[0]).not.toContain('💼');
    expect(cards[1]).toContain('<b>DriverE Number4</b>');
    expect(cards[1]).toContain('📞 (845) 903-8004');
    expect(cards[1]).toContain('💼 CDL A Driver');
    expect(cards[1]).toContain('📍 Pottsville, PA');
    expect(cards[1]).toContain('Tri axle driver — Motters Collision');
    sent.length = 0;
    await report({ status: 'ok', applicants: [applicant(3, { job: 'Local Driver' }), applicant(4)] });
    expect(toChat()).toHaveLength(0);
    const { rows } = await getPool().query(`select job_title from indeed_applicants where submission_id = 'sub-3'`);
    expect(rows[0].job_title).toBe('Local Driver'); // a missing title is filled in later
  });

  it('tries a refused card again on the next report', async () => {
    refuseMessages = true;
    expect((await report({ status: 'ok', applicants: [applicant(5)] })).body).toMatchObject({ new: 1, posted: 0 });
    refuseMessages = false;
    expect((await report({ status: 'ok', applicants: [applicant(5)] })).body).toMatchObject({ new: 0, posted: 1 });
    expect(toChat()[0].text).toContain('Number5');
  });

  it('posts each card once when two reports arrive at the same moment', async () => {
    const both = [applicant(7), applicant(8)];
    await Promise.all([report({ status: 'ok', applicants: both }), report({ status: 'ok', applicants: both })]);
    expect(toChat().map((m) => m.text!.match(/Number\d+/)![0]).sort()).toEqual(['Number7', 'Number8']);
  });

  it('sums up a big batch instead of flooding the chat', async () => {
    const many = Array.from({ length: MAX_CARDS + 3 }, (_, i) => applicant(100 + i));
    await report({ status: 'ok', applicants: many });
    expect(toChat()).toHaveLength(MAX_CARDS + 1);
    expect(toChat().at(-1)!.text).toContain('3 more new Indeed applicants');
    sent.length = 0;
    await report({ status: 'ok', applicants: many });
    expect(toChat()).toHaveLength(0);
  });

  it('announces each problem once and its end once', async () => {
    await report({ status: 'chrome_closed', detail: 'connect ECONNREFUSED 127.0.0.1:9222' });
    await report({ status: 'chrome_closed' });
    expect(toChat()).toHaveLength(1);
    expect(toChat()[0].text).toContain('Chrome - Indeed Bot');
    expect(toChat()[0].text).toContain('ECONNREFUSED');
    await report({ status: 'logged_out' });
    expect(toChat().at(-1)!.text).toContain('signed out');
    sent.length = 0;
    await report({ status: 'ok', applicants: [applicant(5)] });
    await report({ status: 'ok', applicants: [applicant(5)] });
    expect(toChat().map((m) => m.text)).toEqual([expect.stringContaining('working again')]);
  });

  it('warns once when the office computer goes quiet', async () => {
    expect((await cron('indeed-watch')).body).toEqual({ silent: false });
    await getPool().query(`update indeed_collector set last_seen_at = now() - interval '3 hours'`);
    expect((await cron('indeed-watch')).body).toEqual({ silent: true });
    await cron('indeed-watch');
    expect(toChat()).toHaveLength(1);
    expect(toChat()[0].text).toContain('has not reported');
    await report({ status: 'ok', applicants: [applicant(5)] });
    expect(toChat().at(-1)!.text).toContain('working again');
  });

  it('sends the daily import file in the CRM layout, each applicant once', async () => {
    refuseDocuments = true;
    expect((await cron('indeed-excel')).body).toMatchObject({ delivery: 'refused', count: 23 });
    expect(toChat().at(-1)!.text).toContain('were not marked as sent');
    refuseDocuments = false;
    sent.length = 0;

    expect((await cron('indeed-excel')).body).toMatchObject({ delivery: 'sent', count: 23 });
    const file = toChat('sendDocument')[0];
    expect(file.filename).toMatch(/^CFT_Indeed_Leads_Import_\d\d_\d\d_\d\d\.xlsx$/);
    expect(file.caption).toContain('23 new applicants');
    const rows = sheetRows(file.bytes!);
    expect(rows[0].map((c) => c[1])).toEqual(['First Name', 'Last Name', 'Phone', 'Email', 'State', 'Lead Source', 'Lead Status', 'CDL A', 'OTR', 'Experience', 'Lead Created', 'Lead Owner']);
    expect(rows).toHaveLength(24); // 23 applicants: the 2 from the first report are left out
    const nick = rows.find((r) => r.some((c) => c[1] === 'Number4'))!;
    expect(Object.fromEntries(nick)).toMatchObject({ A: 'DriverE', B: 'Number4', C: '18459038004', E: 'PA', F: 'Indeed', G: 'New Lead', L: 'james.c@cftransportllc.com' });
    expect(Number(Object.fromEntries(nick).K)).toBeGreaterThan(46000); // a real date
    expect(rows.flat().some((c) => c[1] === 'Number1')).toBe(false);

    sent.length = 0;
    expect((await cron('indeed-excel')).body).toMatchObject({ delivery: 'none' });
    expect(toChat()[0].text).toContain('No new Indeed applicants');
  });

  it('gives admins the section, the 📥 file and the 7-day copy; nobody else', async () => {
    await report({ status: 'ok', applicants: [applicant(6)] });
    sent.length = 0;
    await say(OWNER, SECTION.indeed);
    const section = sent.find((m) => m.chat_id === OWNER && m.method === 'sendMessage')!;
    expect(section.text).toContain('Office computer: last check');
    expect(section.text).toContain('waiting for the import file: <b>1</b>');
    const buttons = section.body.reply_markup.inline_keyboard.flat();
    expect(buttons.map((b: any) => b.text)).toEqual(['📥 New applicants · 1', '🗂 Last 7 days']);

    sent.length = 0;
    await tap(OWNER, 'indeed:new');
    const mine = sent.filter((m) => m.chat_id === OWNER && m.method === 'sendDocument');
    expect(mine).toHaveLength(1);
    expect(sheetRows(mine[0].bytes!)).toHaveLength(2);
    sent.length = 0;
    await cron('indeed-excel');
    expect(toChat()[0].text).toContain('No new Indeed applicants'); // already in the admin's file

    sent.length = 0;
    await tap(OWNER, 'indeed:week');
    const week = sent.find((m) => m.chat_id === OWNER && m.method === 'sendDocument')!;
    expect(week.filename).toContain('last_7_days');
    expect(sheetRows(week.bytes!)).toHaveLength(25); // 24 since connecting, read-only

    sent.length = 0;
    await say(STRANGER, '/indeed');
    expect(sent.filter((m) => m.chat_id === STRANGER && m.method === 'sendMessage').map((m) => m.text)).toEqual([expect.stringContaining('administrators only')]);
    await tap(STRANGER, 'indeed:new');
    expect(sent.some((m) => m.method === 'sendDocument')).toBe(false);
  });
});
