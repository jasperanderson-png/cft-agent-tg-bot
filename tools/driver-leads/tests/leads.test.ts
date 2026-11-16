// Driver leads: validation, dedupe, fresh-only delivery, exports, access and sources.
// The database tests need TEST_DATABASE_URL (wiped and rebuilt each run). Telegram and FMCSA are stubbed.
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { csvObjects, decodeText, parseCSV } from '../../../shared/csv.js';
import { contactKeys, formatPhone, normalizeCdlClass, normalizeEmail, normalizeLead, normalizePhone, normalizeState, normalizeYears } from '../../../shared/leads.js';
import { closePool, getPool } from '../../../db_storage/db.js';
import type { ApiRequest } from '../../../core/http.js';
import { parseAction } from '../../../telegram_bot/handlers/admins/leads.js';
import { limits } from '../actions.js';
import { LEAD_HEADERS } from '../files.js';
import { BACK, BUTTONS, DOWNLOADS, INLINE, KEYS, NO_NEW_LEADS } from '../messages.js';
import { SECTION } from '../../../core/home.js';
import { censusToRecord, censusWhere } from '../fmcsa.js';
import { handle } from '../../../telegram_bot/server/router.js';
import { migrate } from '../../../db_storage/migrate.js';
import { seed } from '../../../db_storage/seeds/academy/seed.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* optional */
}
const DB = process.env.TEST_DATABASE_URL;
const BOT = '777000:TEST-bot-token';
const OWNER = 9447180;
const OWNER2 = 1270439555;
const MEMBER = 4242;
const STRANGER = 6666;
/** A registration date `daysAgo` days back, as FMCSA writes it (YYYYMMDD). */
const ymd = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');

describe('lead normalisation', () => {
  it('normalises US phone numbers and rejects impossible ones', () => {
    expect(normalizePhone('(845) 270-2285')).toBe('+18452702285');
    expect(normalizePhone('1-845-270-2285')).toBe('+18452702285');
    expect(normalizePhone('+1 845 270 2285')).toBe('+18452702285');
    for (const bad of ['2222222222', '845270228', '045 270 2285', '845 170 2285', '911 270 2285', '845-555-0142', '', null, '+44 20 7946 0958']) expect(normalizePhone(bad)).toBeNull();
    expect(formatPhone('+18452702285')).toBe('(845) 270-2285');
  });

  it('normalises emails, states, CDL classes and experience', () => {
    expect(normalizeEmail('  Joe.Driver@Gmail.COM ')).toBe('joe.driver@gmail.com');
    for (const bad of ['joe@', 'joe@example.com', 'carrie@testing.com', 'not an email']) expect(normalizeEmail(bad)).toBeNull();
    expect([normalizeState('tx'), normalizeState('New York'), normalizeState('ZZ'), normalizeState('Ontario')]).toEqual(['TX', 'NY', null, null]);
    expect(['A', 'Class B', 'CDL-A', 'cdl c', 'A CDL', 'yes', 'none', 'D'].map(normalizeCdlClass)).toEqual(['A', 'B', 'A', 'C', 'A', null, null, null]);
    expect([5, '5+ years', '2-5 yrs', '18 months', 'less than 1 year', 'none', 'lots', 120].map(normalizeYears)).toEqual([5, 5, 2, 1.5, 0, 0, null, null]);
    expect(['<1 year', '10 years, 6 months', '1 yr 3 mos', 'under 5 years', 'less than 6 months', '6 mos'].map(normalizeYears)).toEqual([0, 10.5, 1.3, null, 0, 0.5]);
  });

  it('reads endorsement letters only when they stand alone', () => {
    const endorsements = (v: unknown) => (normalizeLead({ name: 'Ann Lee', phone: '8452702285', endorsements: v }) as any).lead.endorsements;
    expect(endorsements('H, N')).toEqual(['H', 'N']);
    expect(endorsements('Hazmat (H) / T')).toEqual(['H', 'T']);
    expect(endorsements('x')).toEqual(['X']);
    expect(endorsements(['Tanker', 'P'])).toEqual(['N', 'P']);
    for (const none of ['N/A', 'n / a', "don't have any", "driver's license only", 'none']) expect(endorsements(none)).toEqual([]);
  });

  it('maps provider field names and vocabularies', () => {
    const r = normalizeLead({
      'First Name': 'JOHN', 'Last Name': 'SMITH', 'Cell Phone': '845.270.2285', 'E-mail': 'John@Mail.com', State: 'Texas', 'Zip Code': '75001-1234',
      'CDL Class': 'Class A', 'Years of Experience': '7 years', Endorsements: 'Hazmat, Tanker, Doubles/Triples', 'Driver Type': 'OTR owner operator',
      Equipment: 'Dry Van; Reefer', 'TCPA Consent': 'Yes', 'Lead ID': 'abc-1',
    });
    expect(r).toMatchObject({
      ok: true,
      lead: {
        full_name: 'John Smith', phone: '+18452702285', email: 'john@mail.com', state: 'TX', zip: '75001', cdl_class: 'A', years_experience: 7,
        endorsements: ['H', 'N', 'T'], driver_types: ['otr', 'owner_operator'], equipment: ['dry_van', 'reefer'], consent: true, source_record_id: 'abc-1', opt_out: false,
      },
    });
  });

  it('reads the number of trucks under the names providers use', () => {
    const trucks = (o: Record<string, unknown>) => (normalizeLead({ name: 'Ann Lee', phone: '8452702285', ...o }) as any).lead.trucks;
    expect([{ trucks: 3 }, { 'Number of Trucks': '2' }, { power_units: '1' }, { 'Fleet Size': '12 trucks' }, { trucks: 0 }].map(trucks)).toEqual([3, 2, 1, 12, 0]);
    expect([{}, { trucks: 'a few' }, { trucks: '2.5' }, { trucks: -1 }, { trucks: '123456' }].map(trucks)).toEqual([null, null, null, null, null]);
  });

  it('rejects records that cannot be leads', () => {
    expect(normalizeLead({ name: 'Ann Lee' })).toEqual({ ok: false, reason: 'no phone or email' });
    expect(normalizeLead({ name: 'Ann Lee', phone: '123' })).toEqual({ ok: false, reason: 'phone and email are not valid' });
    expect(normalizeLead({ phone: '8452702285' })).toEqual({ ok: false, reason: 'no name' });
    expect(normalizeLead({ name: 'http://spam.example', phone: '8452702285' })).toEqual({ ok: false, reason: 'no name' });
    expect(normalizeLead('x')).toEqual({ ok: false, reason: 'not a record' });
    expect(normalizeLead({ name: 'Ann Lee', email: 'ann@mail.com' })).toMatchObject({ ok: true, lead: { consent: null, verified: null } });
  });

  it('turns typed contacts into identity keys', () => {
    expect(contactKeys('845 270 2285')).toEqual(['phone:+18452702285']);
    expect(contactKeys('Ann@Mail.com')).toEqual(['email:ann@mail.com']);
    expect(contactKeys('hello')).toEqual([]);
    // The digits inside an email address are not a phone number.
    expect(contactKeys('bob4155551234@mail.com')).toEqual(['email:bob4155551234@mail.com']);
    expect(contactKeys('8452702285@')).toEqual([]);
    // The examples the bot and the sign-up page show are numbers the validator accepts.
    expect(contactKeys('(214) 555-7890')).toEqual(['phone:+12145557890']);
  });
});

describe('CSV parsing', () => {
  it('handles quotes, embedded commas and newlines, CRLF and a BOM', () => {
    expect(parseCSV('﻿name,phone\r\n"Lee, Ann","845 ""cell"""\r\n\r\n"multi\nline",x\n')).toEqual([['name', 'phone'], ['Lee, Ann', '845 "cell"'], ['multi\nline', 'x']]);
    expect(csvObjects('Name, Phone\nAnn Lee,8452702285\n')).toEqual([{ Name: 'Ann Lee', Phone: '8452702285' }]);
  });
  it('reads files Excel saves with other separators and encodings', () => {
    expect(csvObjects('Name;Phone;Note\r\n"Lee; Ann";8452702285;a,b\r\n')).toEqual([{ Name: 'Lee; Ann', Phone: '8452702285', Note: 'a,b' }]);
    expect(csvObjects('Name\tPhone\nAnn Lee\t8452702285\n')).toEqual([{ Name: 'Ann Lee', Phone: '8452702285' }]);
    expect(decodeText(new TextEncoder().encode('Имя,José'))).toBe('Имя,José');
    expect(decodeText(Uint8Array.from([0xcf, 0xe5, 0xf2, 0xf0, 0x2c, 0x41]))).toBe('Петр,A'); // windows-1251
    expect(decodeText(Uint8Array.from([0x4a, 0x6f, 0x73, 0xe9, 0x2c, 0x41]))).toBe('José,A'); // windows-1252
    expect(decodeText(Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0x3b, 0x00, 0x42, 0x00]))).toBe('A;B'); // UTF-16 with a BOM
  });
});

describe('FMCSA census mapping', () => {
  it('builds the registry query', () => {
    expect(censusWhere('20261101', 2, true)).toBe(`add_date >= '20261101' AND status_code = 'A' AND phy_country = 'US' AND power_units in ('1','2') AND classdef like '%AUTHORIZED FOR HIRE%'`);
    expect(censusWhere('20261101', 1, false)).not.toContain('classdef');
  });
  it('maps a carrier to a record that is labelled as a carrier', () => {
    const n = normalizeLead(censusToRecord({
      dot_number: '7576042', legal_name: 'ANTHONY TIRE MOBILE SERVICE LLC', company_officer_1: 'ANTHONY FERREIRA SIME', phone: '8452702285',
      email_address: 'ANTHONYTIRE15@GMAIL.COM', phy_city: 'WALLINGTON', phy_state: 'NJ', phy_zip: '07057-1149', power_units: '1', total_drivers: '1', add_date: '20261110',
    }));
    expect(n).toMatchObject({
      ok: true,
      lead: { full_name: 'Anthony Ferreira Sime', company_name: 'ANTHONY TIRE MOBILE SERVICE LLC', phone: '+18452702285', email: 'anthonytire15@gmail.com', city: 'Wallington', state: 'NJ', zip: '07057', usdot_number: '7576042', source_record_id: '7576042', driver_types: ['owner_operator'], cdl_class: null, consent: null, trucks: 1 },
    });
  });
});

describe('bot actions', () => {
  const act = (text: string) => parseAction({ text });
  it('recognises the eight buttons, typed or tapped', () => {
    expect(act(BUTTONS.recent)).toEqual({ t: 'recent' });
    expect(act('get recent leads')).toEqual({ t: 'recent' });
    expect(act('TODAYS LEADS')).toMatchObject({ t: 'export', view: { kind: 'today' }, format: 'xlsx' });
    expect(act(BUTTONS.csv)).toMatchObject({ t: 'export', view: { kind: 'csv' }, format: 'csv' });
    expect(act(BUTTONS.excel)).toMatchObject({ t: 'export', view: { kind: 'excel' }, format: 'xlsx' });
    expect(act(BUTTONS.full)).toMatchObject({ t: 'export', view: { kind: 'full' } });
    expect(act(BUTTONS.state)).toEqual({ t: 'pickState' });
    expect(act(BUTTONS.cdl)).toEqual({ t: 'pickCdl' });
    expect(act(BUTTONS.stats)).toEqual({ t: 'stats' });
  });
  it('opens from the section button and leaves the other section alone', () => {
    expect(act(SECTION.leads)).toEqual({ t: 'menu' });
    expect(act(BACK)).toEqual({ t: 'menu' });
    expect(act('/resend')).toEqual({ t: 'resend' });
    expect(act('/optout undo 845 270 2285')).toEqual({ t: 'optout', args: ['undo', '845', '270', '2285'] });
    for (const other of [SECTION.academy, SECTION.home, '/academy', '/stats', '/admin', '/help']) expect(act(other)).toBeNull();
  });
  it('parses pickers, commands and continuation links, and leaves other text alone', () => {
    expect(act('TX · 1,210')).toMatchObject({ t: 'export', view: { kind: 'state', filter: 'TX' } });
    expect(act('CDL not given · 3')).toMatchObject({ t: 'export', view: { kind: 'cdl', filter: 'NA' } });
    expect(act('/state ca')).toMatchObject({ t: 'export', view: { kind: 'state', filter: 'CA' } });
    expect(act('/state zz')).toMatchObject({ t: 'say' });
    expect(act('/more_state_tx_xlsx_20000_3')).toEqual({ t: 'export', view: { kind: 'state', filter: 'TX' }, format: 'xlsx', after: 20000, part: 3 });
    expect(act('/more_full_0_csv_50000_3')).toEqual({ t: 'export', view: { kind: 'full', filter: undefined }, format: 'csv', after: 50000, part: 3 });
    for (const other of ['/start', '/report week', 'hello', 'OK', 'ZZ · 4', '/more_state_zz_xlsx_1_2']) expect(act(other)).toBeNull();
    expect(parseAction({ document: { file_id: 'f', file_name: 'list.CSV' }, caption: 'vendor-x' })).toEqual({ t: 'import', fileId: 'f', caption: 'vendor-x' });
    expect(parseAction({ document: { file_id: 'f', file_name: 'photo.png' } })).toBeNull();
  });
});

describe.skipIf(!DB)('Driver leads (PostgreSQL)', () => {
  interface Sent { method: string; chat_id?: number; text?: string; filename?: string; caption?: string; bytes?: Uint8Array; body?: any }
  const sent: Sent[] = [];
  const realFetch = globalThis.fetch;
  let failNextDocument = false;
  let dropNextDocument = false; // the connection drops: nobody knows whether the file arrived
  let csvFile: string | Uint8Array<ArrayBuffer> = '';
  let census: unknown[] = [];
  let updateId = 1000;

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, ip = '10.0.0.9', query = '') {
    const req: ApiRequest = { method, path, query: new URLSearchParams(query), headers, body: body ?? null, ip };
    const res = await handle(req);
    return { status: res.status, body: res.body as any };
  }
  const hook = (update: Record<string, unknown>) => call('POST', 'telegram/webhook', { update_id: ++updateId, ...update }, { 'x-telegram-bot-api-secret-token': 'hook-secret-1234567890' });
  const say = (from: number, text: string) => hook({ message: { chat: { id: from, type: 'private' }, from: { id: from, first_name: 'U' + from }, text } });
  /** A tap on an inline button under message 77. */
  const tap = (from: number, data: string, update: Record<string, unknown> = {}) =>
    hook({ callback_query: { id: 'cb-' + from, from: { id: from, first_name: 'U' + from }, data, message: { message_id: 77, chat: { id: from, type: 'private' } } }, ...update });
  const inline = (m: Sent) => (m.body.reply_markup.inline_keyboard as { text: string; callback_data: string }[][]).flat();
  const docs = () => sent.filter((m) => m.method === 'sendDocument');
  const texts = (chat: number) => sent.filter((m) => m.method === 'sendMessage' && m.chat_id === chat).map((m) => m.text ?? '');
  /** The last message the bot sent (menu updates may follow it). */
  const lastMsg = () => sent.filter((m) => m.method === 'sendMessage').at(-1)!;
  const sheetXml = (bytes: Uint8Array, n = 1) => strFromU8(unzipSync(bytes)[`xl/worksheets/sheet${n}.xml`]);
  const leadIds = (bytes: Uint8Array) => sheetXml(bytes).match(/D-\d{6}/g) ?? [];
  const db = () => getPool();
  const driver = async (phone: string) => (await db().query('select * from drivers where phone = $1', [phone])).rows[0];
  const count = async (where = 'true') => Number((await db().query(`select count(*) as n from drivers where ${where}`)).rows[0].n);
  const register = (o: Record<string, unknown>, ip = '10.1.0.' + (updateId++ % 250)) => call('POST', 'leads/register', { consent: true, ...o }, { 'user-agent': 'vitest' }, ip);

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB, TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_WEBHOOK_SECRET: 'hook-secret-1234567890', APP_URL: 'https://academy.example.com',
      ADMIN_TELEGRAM_IDS: `${OWNER}, ${OWNER2}`, CRON_SECRET: 'cron-secret-abcdefghij', GOOGLE_SERVICE_ACCOUNT_JSON: '', LEADS_FMCSA_ENABLED: 'false', LEADS_COMPANY_NAME: 'CFT',
    });
    delete process.env.LEADS_CONSENT_TEXT;
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('https://data.transportation.gov/')) return new Response(JSON.stringify(census), { headers: { 'content-type': 'application/json' } });
      if (u.startsWith('https://api.telegram.org/file/')) return new Response(new Blob([csvFile]));
      if (!u.startsWith('https://api.telegram.org/')) return realFetch(url, init);
      const method = u.split('/').pop()!;
      if (init?.body instanceof FormData) {
        if (failNextDocument) {
          failNextDocument = false;
          return new Response(JSON.stringify({ ok: false, description: 'Bad Gateway' }), { status: 502 });
        }
        if (dropNextDocument) {
          dropNextDocument = false;
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        }
        const f = init.body.get('document') as File;
        sent.push({ method, chat_id: Number(init.body.get('chat_id')), filename: f.name, caption: String(init.body.get('caption') ?? ''), bytes: new Uint8Array(await f.arrayBuffer()) });
        return new Response(JSON.stringify({ ok: true, result: {} }));
      }
      const b = JSON.parse(String(init?.body ?? '{}'));
      sent.push({ method, chat_id: b.chat_id, text: b.text, body: b });
      const result = method === 'getFile' ? { file_path: 'documents/list.csv', file_size: csvFile.length } : {};
      return new Response(JSON.stringify({ ok: true, result }));
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

  it('serves the consent wording and requires consent to register', async () => {
    const cfg = await call('GET', 'leads/form-config');
    expect(cfg.body.consentText).toContain('CFT and its agents may contact me');
    expect((await register({ full_name: 'Ann Lee', phone: '(845) 270-2201', consent: false })).status).toBe(400);
    expect((await register({ full_name: 'Ann Lee', phone: '12' })).status).toBe(400);
    expect((await register({ full_name: 'Ann Lee', email: 'ann@mail.com' })).status).toBe(400); // phone is required on the form
    expect(await count()).toBe(0);
  });

  it('stores a sign-up with its consent record, and ignores bots and injected fields', async () => {
    const r = await register({
      full_name: 'ann lee', phone: '(845) 270-2201', email: 'Ann@Mail.com', state: 'TX', city: 'Dallas', zip: '75001', cdl_class: 'A', years_experience: '5',
      driver_type: ['otr', 'owner operator'], equipment: ['reefer'], verified: false, id: 'forged', record_kind: 'carrier', trucks: '2',
    });
    expect(r.status).toBe(201);
    const d = await driver('+18452702201');
    expect(d).toMatchObject({
      full_name: 'Ann Lee', email: 'ann@mail.com', state: 'TX', cdl_class: 'A', years_experience: 5, driver_types: ['otr', 'owner_operator'], equipment: ['reefer'],
      source_id: 'web-form', source_record_id: null, record_kind: 'driver', consent_status: 'granted', verification_status: 'verified', delivery_status: 'pending', update_count: 0,
      extra: { power_units: 2 },
    });
    const consent = (await db().query('select * from consent_records where driver_id = $1', [d.id])).rows;
    expect(consent).toHaveLength(1);
    expect(consent[0]).toMatchObject({ status: 'granted', method: 'web_form', ip: expect.stringMatching(/^10\.1\.0\./), user_agent: 'vitest' });
    expect(consent[0].consent_text).toContain('CFT and its agents');

    expect((await register({ full_name: 'Spam Bot', phone: '8452702299', website: 'http://x.test' })).status).toBe(201);
    expect(await count()).toBe(1);
  });

  it('merges a repeat sign-up instead of adding a second driver', async () => {
    expect((await register({ full_name: 'Ann M. Lee', phone: '845-270-2201', city: 'Austin', equipment: ['flatbed'] })).status).toBe(201);
    expect(await count()).toBe(1);
    expect(await driver('+18452702201')).toMatchObject({ full_name: 'Ann Lee', city: 'Austin', equipment: ['flatbed', 'reefer'], update_count: 1, delivery_status: 'pending' });
    const log = (await db().query(`select inserted, updated from ingestion_logs order by id desc limit 1`)).rows[0];
    expect(log).toEqual({ inserted: 0, updated: 1 });
  });

  it('rate-limits sign-ups per address', async () => {
    const results = [];
    for (let i = 0; i < 8; i++) results.push((await register({ full_name: 'Rate Test', phone: '845270230' + i }, '10.9.9.9')).status);
    expect(results.filter((s) => s === 201)).toHaveLength(6);
    expect(results.slice(6)).toEqual([429, 429]);
    await db().query(`delete from drivers where full_name = 'Rate Test'`);
  });

  it('opens Driver Leads to Academy admins only, and the owner tools to owners only', async () => {
    await say(STRANGER, BUTTONS.recent);
    expect(texts(STRANGER)).toEqual([expect.stringContaining('for CFT administrators only')]);
    expect(docs()).toHaveLength(0);

    // Access follows the Academy admin list: no separate list to keep.
    await say(MEMBER, '/leads');
    expect(texts(MEMBER)).toEqual([expect.stringContaining('for CFT administrators only')]);
    await db().query(`insert into admins (telegram_user_id, name, role) values ($1, 'Dana Admin', 'admin')`, [MEMBER]);
    sent.length = 0;
    await say(MEMBER, '/leads');
    expect(lastMsg().body.reply_markup.keyboard[0][0].text).toBe(BUTTONS.recent);
    expect(lastMsg().body.reply_markup.keyboard.at(-1).at(-1).text).toBe(SECTION.home);
    expect(lastMsg().text).not.toContain('Owner tools');
    sent.length = 0;
    await say(MEMBER, '/leadsource add evil Evil');
    expect(texts(MEMBER)).toEqual(['Only owners can do this.']);
    await say(OWNER, '/leads');
    expect(lastMsg().text).toContain('Owner tools');
    expect(lastMsg().text).toContain('https://academy.example.com/drivers/');

    // Someone who stops being an admin loses Driver Leads at once.
    const gone = 5151;
    await db().query(`insert into admins (telegram_user_id, name, role) values ($1, 'Former Admin', 'admin')`, [gone]);
    sent.length = 0;
    await say(gone, BUTTONS.stats);
    expect(texts(gone)[0]).toContain('Driver leads · Statistics');
    await db().query('delete from admins where telegram_user_id = $1', [gone]);
    sent.length = 0;
    await say(gone, BUTTONS.stats);
    expect(texts(gone)).toEqual([expect.stringContaining('for CFT administrators only')]);
    // The old access command is gone, for everyone.
    sent.length = 0;
    await say(OWNER, `/leadsaccess add ${STRANGER}`);
    await say(STRANGER, BUTTONS.recent);
    expect(texts(OWNER)).toEqual([]);
    expect(texts(STRANGER)).toEqual([expect.stringContaining('for CFT administrators only')]);
  });

  it('keeps Agent Academy and Driver Leads apart as two sections of the bot', async () => {
    const keys = (m: Sent) => (m.body.reply_markup.keyboard as { text: string }[][]).flat().map((b) => b.text);
    // /start is the home screen: a choice between the two sections, and a command menu labelled by section.
    await say(OWNER, '/start');
    expect(texts(OWNER)).toHaveLength(1);
    expect(texts(OWNER)[0]).toMatch(/Choose what you need[\s\S]*🎓 Agent Academy[\s\S]*🚚 Driver Leads[\s\S]*📥 Download All Fuel Prices[\s\S]*➕ Invite[\s\S]*👥 Team/);
    expect(keys(sent[0])).toEqual([SECTION.academy, SECTION.leads, SECTION.fuel, SECTION.invite, SECTION.team]);
    const commands = sent.find((m) => m.method === 'setMyCommands')!.body.commands;
    expect(commands.map((c: any) => c.command)).toEqual(['start', 'academy', 'admin', 'stats', 'weekly', 'report', 'leads', 'fuelprices', 'invite', 'invitedriver', 'addadmin', 'agents', 'drivers', 'admins', 'help']);
    expect(commands.map((c: any) => c.description.split(':')[0])).toEqual(['Home', 'Academy', 'Academy', 'Academy', 'Academy', 'Academy', 'Driver Leads', 'Fuel', 'Agents', 'Drivers', 'Admins', 'Agents', 'Drivers', 'Admins', 'Help']);

    // Driver Leads has its own keyboard, with a way back.
    sent.length = 0;
    await say(OWNER, SECTION.leads);
    expect(texts(OWNER)[0]).toContain('🚚 <b>Driver Leads</b>');
    // Two rows: the main action, then statistics, downloads and the way back.
    expect(sent[0].body.reply_markup.keyboard.map((r: { text: string }[]) => r.map((b) => b.text))).toEqual([[BUTTONS.recent], [KEYS.stats, KEYS.downloads, SECTION.home]]);
    sent.length = 0;
    await say(OWNER, SECTION.home);
    expect(keys(sent[0])).toEqual([SECTION.academy, SECTION.leads, SECTION.fuel, SECTION.invite, SECTION.team]);

    // Agent Academy opens the test, lists only Academy commands and puts the switcher back.
    sent.length = 0;
    await say(OWNER, SECTION.academy);
    expect(sent[0].body.reply_markup.inline_keyboard[0][0].web_app.url).toBe('https://academy.example.com');
    expect(texts(OWNER)[1]).toContain('Agent Academy · Admin commands');
    expect(texts(OWNER).join('\n')).not.toMatch(/lead/i);
    expect(keys(sent[1])).toEqual([SECTION.academy, SECTION.leads, SECTION.fuel, SECTION.invite, SECTION.team]);

    // An admin who is not an owner has both sections too. /help covers both, each under its own heading.
    sent.length = 0;
    await say(MEMBER, '/start');
    expect(keys(sent[0])).toEqual([SECTION.academy, SECTION.leads, SECTION.fuel, SECTION.invite, SECTION.team]);
    expect(sent.find((m) => m.method === 'setMyCommands')!.body.commands).toEqual(commands);
    sent.length = 0;
    await say(MEMBER, '/help');
    expect(texts(MEMBER)[0]).toMatch(/🎓 Agent Academy[\s\S]*Admin commands[\s\S]*🚚 <b>Driver Leads<\/b>/);
    expect(texts(MEMBER)[0]).not.toContain('Owner tools');

    // Someone who is not an admin only ever sees the test.
    sent.length = 0;
    await say(STRANGER, '/start');
    expect(sent[0].body.reply_markup.inline_keyboard[0][0].text).toBe('Open CFT Agent Academy');
    expect(sent.some((m) => m.body?.reply_markup?.keyboard)).toBe(false);
    expect(sent.some((m) => m.method === 'setMyCommands')).toBe(false);
    expect(texts(STRANGER).join('\n')).not.toMatch(/lead/i);
    sent.length = 0;
    await say(STRANGER, SECTION.leads);
    expect(texts(STRANGER)).toEqual([expect.stringContaining('for CFT administrators only')]);
    sent.length = 0;
    await say(STRANGER, '/help');
    expect(texts(STRANGER).join('\n')).not.toMatch(/lead/i);
  });

  let vendorToken = '';
  it('lets an owner create a vendor webhook and accepts leads only with its token', async () => {
    await say(OWNER, '/leadsource add acme-leads Acme Driver Leads');
    const reply = texts(OWNER)[0];
    expect(reply).toContain('https://academy.example.com/api/leads/ingest/acme-leads');
    vendorToken = /Bearer ([A-Za-z0-9_-]{30,})/.exec(reply)![1];
    await say(OWNER, '/leadsource add acme-leads Again');
    expect(texts(OWNER)[1]).toContain('already exists');

    const lead = { first_name: 'Bob', last_name: 'Stone', phone: '8452702202', state: 'CA', cdl: 'B', consent: true, lead_id: 'acme-1' };
    expect((await call('POST', 'leads/ingest/acme-leads', lead)).status).toBe(401);
    expect((await call('POST', 'leads/ingest/acme-leads', lead, { authorization: 'Bearer wrong-token-wrong-token-wrong' })).status).toBe(401);
    expect((await call('POST', 'leads/ingest/nope', lead, { authorization: 'Bearer ' + vendorToken })).status).toBe(401);
    expect((await call('POST', 'leads/ingest/web-form', lead, { authorization: 'Bearer ' + vendorToken })).status).toBe(401);

    const ok = await call('POST', 'leads/ingest/acme-leads', { leads: [
      lead,
      { name: 'Cara Dunn', phone: '8452702203', state: 'CA', cdl: 'A' },                      // no consent flag → stored, never delivered
      { name: 'Dan Fox', email: 'dan@mail.com', state: 'FL', consent: 'yes', verified: false }, // provider says: not verified yet
      { name: 'No Contact' },                                                                  // invalid
      { name: 'Bob Stone', phone: '8452702202', consent: true },                               // same person again in one batch (stored in either order)
    ] }, { authorization: 'Bearer ' + vendorToken });
    expect(ok.body).toMatchObject({ received: 5, inserted: 3, duplicates: 1, rejected: 1, errors: [{ index: 3, reason: 'no phone or email' }] });
    expect(await driver('+18452702203')).toMatchObject({ consent_status: 'unknown' });
    expect((await db().query(`select verification_status from drivers where email = 'dan@mail.com'`)).rows[0].verification_status).toBe('unverified');
    expect((await call('POST', 'leads/ingest/acme-leads', lead, {}, '10.0.0.9', 'token=' + vendorToken)).body).toMatchObject({ inserted: 0, duplicates: 1 });
  });

  let firstDelivery: string[] = [];
  it('GET RECENT LEADS sends every eligible new lead once and records the delivery', async () => {
    await say(OWNER, BUTTONS.recent);
    expect(docs()).toHaveLength(1);
    const d = docs()[0];
    expect(d).toMatchObject({ chat_id: OWNER, filename: expect.stringMatching(/^CFT_Driver_New_Leads_\d\d-\d\d-\d{4}_\d{4}\.xlsx$/) });
    expect(d.caption).toContain('🆕 <b>2 new driver leads</b>');
    expect(d.caption).toContain('never sent before');
    const xml = sheetXml(d.bytes!);
    for (const h of LEAD_HEADERS) expect(xml).toContain(`>${h}<`);
    expect(xml).toContain('Ann Lee');
    expect(xml).toContain('(845) 270-2202');
    expect(xml).not.toContain('Cara Dunn'); // no consent
    expect(xml).not.toContain('Dan Fox'); // not verified
    firstDelivery = leadIds(d.bytes!);
    expect(firstDelivery).toHaveLength(2);
    // The number of trucks sits right after the contact details: column F, here Ann Lee's 2.
    expect(LEAD_HEADERS.slice(3, 6)).toEqual(['Phone', 'Email', 'Number of trucks']);
    expect(xml).toMatch(/<c r="F2" s="5"><v>2<\/v><\/c>/);
    expect(xml).not.toMatch(/<c r="F3"[^>]*><v>/); // Bob's source did not say
    // Small deliveries are also shown as cards with tap-to-call numbers.
    expect(texts(OWNER).at(-1)).toContain('📞 +18452702201');
    expect(texts(OWNER).at(-1)).toMatch(/Ann Lee<\/b> · CDL-A · 5 yrs · 2 trucks · Austin, TX/);

    expect(await driver('+18452702201')).toMatchObject({ delivery_status: 'delivered', delivered_to: OWNER, delivered_at: expect.any(Date) });
    const hist = (await db().query('select h.telegram_user_id, b.kind, b.status, b.lead_count from delivery_history h join delivery_batches b on b.id = h.batch_id')).rows;
    expect(hist).toEqual([{ telegram_user_id: OWNER, kind: 'recent', status: 'delivered', lead_count: 2 }, { telegram_user_id: OWNER, kind: 'recent', status: 'delivered', lead_count: 2 }]);
  });

  it('answers with the "no new leads" message when nothing new has arrived — for every user', async () => {
    await say(OWNER, BUTTONS.recent);
    await say(MEMBER, BUTTONS.recent);
    expect(docs()).toHaveLength(0);
    expect(texts(OWNER)).toEqual([NO_NEW_LEADS]);
    expect(texts(MEMBER)).toEqual([NO_NEW_LEADS]);
  });

  it('does not treat an updated profile of a delivered driver as a new lead', async () => {
    const before = await driver('+18452702202');
    const r = await call('POST', 'leads/ingest/acme-leads', { lead_id: 'acme-1', name: 'Robert Stone', phone: '8452702202', email: 'bob@mail.com', city: 'Fresno', experience: '9 years', consent: true }, { authorization: 'Bearer ' + vendorToken });
    expect(r.body).toMatchObject({ inserted: 0, duplicates: 1 });
    const after = await driver('+18452702202');
    expect(after).toMatchObject({ id: before.id, lead_no: before.lead_no, full_name: 'Bob Stone', city: 'Fresno', email: 'bob@mail.com', years_experience: 9, delivery_status: 'delivered' });
    expect(after.first_added_at).toEqual(before.first_added_at);
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    // The same person arriving through another source, matched by email this time.
    await register({ full_name: 'Bob Stone', phone: '8452702202', email: 'BOB@mail.com' });
    await say(OWNER, BUTTONS.recent);
    expect(docs()).toHaveLength(0);
    expect(texts(OWNER)).toEqual([NO_NEW_LEADS]);
  });

  it('delivers a stored driver for the first time once consent arrives', async () => {
    await call('POST', 'leads/ingest/acme-leads', { name: 'Cara Dunn', phone: '8452702203', consent: true }, { authorization: 'Bearer ' + vendorToken });
    await say(MEMBER, BUTTONS.recent);
    expect(docs()).toHaveLength(1);
    expect(docs()[0].chat_id).toBe(MEMBER);
    const ids = leadIds(docs()[0].bytes!);
    expect(ids).toHaveLength(1);
    expect(firstDelivery).not.toContain(ids[0]);
    expect(sheetXml(docs()[0].bytes!)).toContain('Cara Dunn');
  });

  it('never delivers the same lead twice when two people click at the same moment', async () => {
    const batch = Array.from({ length: 40 }, (_v, i) => ({ name: `Driver ${i}`, phone: `84527031${String(i).padStart(2, '0')}`, state: i % 2 ? 'TX' : 'OH', cdl: 'A', consent: true }));
    expect((await call('POST', 'leads/ingest/acme-leads', batch, { authorization: 'Bearer ' + vendorToken })).body.inserted).toBe(40);
    await Promise.all([say(OWNER, BUTTONS.recent), say(MEMBER, BUTTONS.recent), say(OWNER2, BUTTONS.recent)]);
    const delivered = docs().flatMap((d) => leadIds(d.bytes!));
    expect(delivered).toHaveLength(40);
    expect(new Set(delivered).size).toBe(40);
    expect(Number((await db().query('select count(*) as n, count(distinct driver_id) as d from delivery_history')).rows[0].n)).toBe(43);
    expect(await count(`delivery_status = 'claimed'`)).toBe(0);
  });

  it('runs a retried Telegram update only once', async () => {
    await call('POST', 'leads/ingest/acme-leads', { name: 'Retry Case', phone: '8452702210', consent: true }, { authorization: 'Bearer ' + vendorToken });
    const update = { update_id: 555001, message: { chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'O' }, text: BUTTONS.recent } };
    const headers = { 'x-telegram-bot-api-secret-token': 'hook-secret-1234567890' };
    await call('POST', 'telegram/webhook', update, headers);
    await call('POST', 'telegram/webhook', update, headers);
    expect(docs()).toHaveLength(1);
    expect(texts(OWNER).filter((t) => t === NO_NEW_LEADS)).toHaveLength(0);
  });

  it('keeps leads in the queue when Telegram rejects the file, and delivers them on the next click', async () => {
    await call('POST', 'leads/ingest/acme-leads', { name: 'Eve Gray', phone: '8452702204', state: 'GA', consent: true }, { authorization: 'Bearer ' + vendorToken });
    failNextDocument = true;
    await say(OWNER, BUTTONS.recent);
    expect(docs()).toHaveLength(0);
    expect(texts(OWNER)[0]).toContain('<b>not</b> marked as sent');
    expect(await driver('+18452702204')).toMatchObject({ delivery_status: 'pending', delivery_batch_id: null, delivered_at: null });
    expect((await db().query(`select status, error from delivery_batches order by created_at desc limit 1`)).rows[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('Bad Gateway') });

    sent.length = 0;
    await say(OWNER, BUTTONS.recent);
    expect(docs()).toHaveLength(1);
    expect(sheetXml(docs()[0].bytes!)).toContain('Eve Gray');
    expect(await driver('+18452702204')).toMatchObject({ delivery_status: 'delivered' });
  });

  it('returns leads claimed by a crashed delivery to the queue', async () => {
    await call('POST', 'leads/ingest/acme-leads', { name: 'Finn Hale', phone: '8452702205', consent: true }, { authorization: 'Bearer ' + vendorToken });
    await db().query(`update drivers set delivery_status = 'claimed', delivery_batch_id = gen_random_uuid(), claimed_at = now() - interval '1 minute' where phone = '+18452702205'`);
    await say(OWNER, BUTTONS.recent);
    expect(texts(OWNER)).toEqual([NO_NEW_LEADS]); // a delivery still in flight is left alone
    await db().query(`update drivers set claimed_at = now() - interval '6 minutes' where phone = '+18452702205'`);
    sent.length = 0;
    await say(OWNER, BUTTONS.recent);
    expect(docs()).toHaveLength(1);
    expect(sheetXml(docs()[0].bytes!)).toContain('Finn Hale');
  });

  it('counts a file as sent when Telegram does not answer, and sends it again on request', async () => {
    await say(MEMBER, '/resend');
    expect(docs()).toHaveLength(1); // the member's own last file
    expect(docs()[0]).toMatchObject({ chat_id: MEMBER, caption: expect.stringContaining('sent again') });
    const again = leadIds(docs()[0].bytes!);
    expect((await db().query(`select count(*) as n from drivers where delivered_to = $1 and 'D-' || lpad(lead_no::text, 6, '0') = any($2)`, [MEMBER, again])).rows[0].n).toBe(again.length);
    sent.length = 0;

    await call('POST', 'leads/ingest/acme-leads', { name: 'Tim Out', phone: '8452702241', consent: true }, { authorization: 'Bearer ' + vendorToken });
    dropNextDocument = true;
    await say(OWNER2, BUTTONS.recent);
    expect(docs()).toHaveLength(0);
    expect(texts(OWNER2)[0]).toContain('did not confirm the file');
    expect(texts(OWNER2)[0]).toContain('/resend');
    expect(await driver('+18452702241')).toMatchObject({ delivery_status: 'delivered', delivered_to: OWNER2 });

    // It never goes out as a new lead again, to anyone…
    sent.length = 0;
    await say(OWNER, BUTTONS.recent);
    await say(OWNER2, BUTTONS.recent);
    expect(docs()).toHaveLength(0);
    // …and the person it was meant for can still get it.
    sent.length = 0;
    await say(OWNER2, '/resend');
    expect(docs()).toHaveLength(1);
    expect(docs()[0].caption).toContain('🔁 <b>1 driver lead, sent again</b>');
    expect(docs()[0].caption).toContain('not new leads');
    expect(sheetXml(docs()[0].bytes!)).toContain('Tim Out');
    expect((await db().query(`select count(*) as n from delivery_history h join drivers d on d.id = h.driver_id where d.phone = '+18452702241'`)).rows[0].n).toBe(1);
    sent.length = 0;
    await say(STRANGER, '/resend');
    expect(docs()).toHaveLength(0);
  });

  it('retries recording a delivery instead of sending the leads twice', async () => {
    await call('POST', 'leads/ingest/acme-leads', { name: 'Rhea Try', phone: '8452702242', consent: true }, { authorization: 'Bearer ' + vendorToken });
    // The database fails the first two attempts to record the delivery.
    await db().query(`
      create sequence test_fail_seq;
      create function test_fail_twice() returns trigger language plpgsql as $f$
        begin if nextval('test_fail_seq') <= 2 then raise exception 'database hiccup'; end if; return new; end $f$;
      create trigger test_fail_twice before insert on delivery_history for each row execute function test_fail_twice();`);
    try {
      await say(OWNER, BUTTONS.recent);
    } finally {
      await db().query('drop trigger test_fail_twice on delivery_history; drop function test_fail_twice(); drop sequence test_fail_seq;');
    }
    expect(docs()).toHaveLength(1);
    expect(texts(OWNER).some((t) => t.includes('⚠️'))).toBe(false);
    expect(await driver('+18452702242')).toMatchObject({ delivery_status: 'delivered' });
    sent.length = 0;
    await say(OWNER, BUTTONS.recent);
    expect(texts(OWNER)).toEqual([NO_NEW_LEADS]);
  });

  it('opts out only the contact that was given, and lets an owner take an opt-out back', async () => {
    // Two drivers; the email address of one happens to contain the phone number of the other.
    await call('POST', 'leads/ingest/acme-leads', [
      { name: 'Olga Park', phone: '8452702243', consent: true },
      { name: 'Pete Quinn', email: 'pete8452702243@mail.com', consent: true },
    ], { authorization: 'Bearer ' + vendorToken });
    await say(OWNER, '/optout pete8452702243@mail.com');
    expect(texts(OWNER)[0]).toContain('1 record is now marked');
    expect(await driver('+18452702243')).toMatchObject({ consent_status: 'granted' });
    expect((await db().query(`select 1 from lead_suppressions where key like 'phone:%2702243'`)).rows).toHaveLength(0);

    sent.length = 0;
    await say(OWNER, '/optout');
    expect(texts(OWNER)[0]).toContain('/optout undo');
    const example = /\/optout (\(\d{3}\) \d{3}-\d{4})/.exec(texts(OWNER)[0])![1];
    expect(contactKeys(example)).toHaveLength(1); // the example in the usage text is accepted by the command itself

    sent.length = 0;
    await say(OWNER, '/optout undo pete8452702243@mail.com');
    expect(texts(OWNER)[0]).toContain('Opt-out removed. 1 record has the consent status from before');
    const pete = (await db().query(`select id, consent_status from drivers where email = 'pete8452702243@mail.com'`)).rows[0];
    expect(pete.consent_status).toBe('granted');
    expect((await db().query('select status, method, recorded_by from consent_records where driver_id = $1 order by id', [pete.id])).rows).toEqual([
      { status: 'granted', method: 'source_record', recorded_by: null },
      { status: 'revoked', method: 'opt_out_admin', recorded_by: OWNER },
      { status: 'granted', method: 'opt_out_undone', recorded_by: OWNER },
    ]);
    await say(OWNER, '/optout undo pete8452702243@mail.com');
    expect(texts(OWNER).at(-1)).toBe('This contact is not on the do-not-contact list.');
    await say(MEMBER, '/optout undo pete8452702243@mail.com');
    expect(texts(MEMBER)).toEqual(['Only owners can do this.']);

    sent.length = 0;
    await say(OWNER, BUTTONS.recent);
    expect(leadIds(docs()[0].bytes!)).toHaveLength(2);
  });

  it('lets a driver who opted out sign up again with fresh consent', async () => {
    // Somebody (maybe not the driver) puts the number on the do-not-contact list first.
    expect((await call('POST', 'leads/optout', { contact: '845-270-2244' })).status).toBe(200);
    expect((await register({ full_name: 'Quinn Reed', phone: '(845) 270-2244', email: 'quinn@mail.com' })).status).toBe(201);
    const quinn = await driver('+18452702244');
    expect(quinn).toMatchObject({ consent_status: 'granted', delivery_status: 'pending' });
    expect((await db().query(`select 1 from lead_suppressions where key = 'phone:+18452702244'`)).rows).toHaveLength(0);

    // A driver who is in the database opts out and later signs up again: the new consent is on record.
    await call('POST', 'leads/optout', { contact: 'quinn@mail.com' });
    expect(await driver('+18452702244')).toMatchObject({ consent_status: 'revoked' });
    expect((await register({ full_name: 'Quinn Reed', phone: '(845) 270-2244', email: 'quinn@mail.com' })).status).toBe(201);
    expect(await driver('+18452702244')).toMatchObject({ id: quinn.id, consent_status: 'granted' });
    expect((await db().query('select status, method from consent_records where driver_id = $1 order by id', [quinn.id])).rows).toEqual([
      { status: 'granted', method: 'web_form' },
      { status: 'revoked', method: 'opt_out_self' },
      { status: 'granted', method: 'web_form' },
    ]);
    // A provider's word is not the driver's: it still cannot bring back someone who opted out.
    await call('POST', 'leads/optout', { contact: '845-270-2244' });
    await call('POST', 'leads/ingest/acme-leads', { name: 'Quinn Reed', phone: '8452702244', consent: true }, { authorization: 'Bearer ' + vendorToken });
    expect(await driver('+18452702244')).toMatchObject({ consent_status: 'revoked' });
    await say(OWNER, BUTTONS.recent);
    expect(docs()).toHaveLength(0);
  });

  it('honours opt-outs, including for people a provider sends again', async () => {
    await call('POST', 'leads/ingest/acme-leads', { name: 'Gus Ivy', phone: '8452702206', email: 'gus@mail.com', consent: true }, { authorization: 'Bearer ' + vendorToken });
    await say(OWNER, '/optout (845) 270-2206');
    expect(texts(OWNER)[0]).toContain('1 record is now marked “do not contact”');
    expect(await driver('+18452702206')).toMatchObject({ consent_status: 'revoked', delivery_status: 'pending' });
    await call('POST', 'leads/ingest/acme-leads', { name: 'Gus Ivy', phone: '8452702206', consent: true }, { authorization: 'Bearer ' + vendorToken });
    expect(await driver('+18452702206')).toMatchObject({ consent_status: 'revoked' });

    // Opt-out before the person is in the database (public page), then a provider sends them.
    expect((await call('POST', 'leads/optout', { contact: 'hal@mail.com' })).status).toBe(200);
    expect((await call('POST', 'leads/optout', { contact: 'nonsense' })).status).toBe(400);
    await call('POST', 'leads/ingest/acme-leads', [{ name: 'Hal Jones', email: 'hal@mail.com', phone: '8452702207', consent: true }, { phone: '8452702208', optout: true }], { authorization: 'Bearer ' + vendorToken });
    expect(await driver('+18452702207')).toMatchObject({ consent_status: 'revoked' });
    expect((await db().query(`select 1 from lead_suppressions where key = 'phone:+18452702208'`)).rows).toHaveLength(1);

    sent.length = 0;
    await say(OWNER, BUTTONS.recent);
    expect(docs()).toHaveLength(0);
    expect(texts(OWNER)).toEqual([NO_NEW_LEADS]);
  });

  it('exports are read-only copies and withhold contacts that have no consent', async () => {
    await register({ full_name: 'Ivy King', phone: '8452702209', state: 'TX', cdl_class: 'B' });
    const pendingBefore = await count(`delivery_status = 'pending'`);

    await say(OWNER, BUTTONS.today);
    expect(docs()[0].filename).toMatch(/^CFT_Driver_Todays_Leads_.*\.xlsx$/);
    expect(docs()[0].caption).toContain('1 not sent yet');
    expect(docs()[0].caption).toContain('Read-only copy');
    expect(sheetXml(docs()[0].bytes!)).toContain('Ivy King');

    sent.length = 0;
    await say(OWNER, BUTTONS.csv);
    const csv = new TextDecoder().decode(docs()[0].bytes!);
    expect(docs()[0].filename).toMatch(/\.csv$/);
    expect(csv.split('\r\n')[0].replace('﻿', '')).toBe(LEAD_HEADERS.join(','));
    expect(csv).toContain('Ivy King,(845) 270-2209');
    expect(csv).not.toContain('Gus Ivy'); // opted out
    expect(csv).not.toContain('Dan Fox'); // unverified

    sent.length = 0;
    await say(OWNER, BUTTONS.full);
    const full = sheetXml(docs()[0].bytes!);
    expect(full).toContain('Gus Ivy');
    expect(full).not.toContain('(845) 270-2206');
    expect(full).not.toContain('gus@mail.com');
    expect(full).toContain('Opted out — do not contact');
    expect(sheetXml(docs()[0].bytes!, 2)).toContain('CFT driver leads — database summary');

    // The old keyboard's state button still works; the picker is now inline buttons under one message.
    sent.length = 0;
    await say(OWNER, BUTTONS.state);
    const stateButtons = inline(sent[0]);
    expect(stateButtons.map((b) => b.text)).toEqual(expect.arrayContaining(['TX · 22', 'OH · 20', INLINE.back]));
    expect(stateButtons.find((b) => b.text === 'OH · 20')!.callback_data).toBe('leads:st:OH');
    sent.length = 0;
    await tap(OWNER, 'leads:st:OH');
    expect(docs()[0].caption).toContain('<b>Ohio</b> · 20 leads');
    expect(leadIds(docs()[0].bytes!)).toHaveLength(20);

    sent.length = 0;
    await say(OWNER, '/cdl');
    expect(inline(sent[0]).map((b) => b.text)).toContain('CDL B · 2');
    sent.length = 0;
    await say(OWNER, '/cdl B');
    expect(leadIds(docs()[0].bytes!)).toHaveLength(2);
    sent.length = 0;
    await say(OWNER, '/state WY');
    expect(texts(OWNER)).toEqual(['No contactable leads in this state.']);

    expect(await count(`delivery_status = 'pending'`)).toBe(pendingBefore);
    expect(Number((await db().query(`select count(*) as n from delivery_batches where kind <> 'recent'`)).rows[0].n)).toBe(5);
    await say(OWNER, BUTTONS.recent); // Ivy is still new
    expect(docs().at(-1)!.caption).toContain('1 new driver lead</b>');
  });

  it('keeps the rarer downloads in one inline menu', async () => {
    await say(OWNER, KEYS.downloads);
    expect(texts(OWNER)).toEqual([DOWNLOADS]);
    expect(inline(sent[0]).map((b) => b.text)).toEqual([INLINE.today, INLINE.state, INLINE.cdl, INLINE.excel, INLINE.csv, INLINE.full]);

    // Pickers and "Back" change the same message instead of adding new ones.
    sent.length = 0;
    await tap(OWNER, 'leads:states');
    const edit = sent.find((m) => m.method === 'editMessageText')!;
    expect(edit.body).toMatchObject({ chat_id: OWNER, message_id: 77, text: expect.stringContaining('Leads by state') });
    expect(inline(edit).map((b) => b.text)).toEqual(expect.arrayContaining(['TX · 22', INLINE.back]));
    sent.length = 0;
    await tap(OWNER, 'leads:dl');
    expect(sent.find((m) => m.method === 'editMessageText')!.body.text).toBe(DOWNLOADS);
    expect(sent.filter((m) => m.method === 'sendMessage')).toHaveLength(0);

    // A file arrives as a new message; the tap's spinner is stopped right away.
    sent.length = 0;
    await tap(OWNER, 'leads:x:csv', { update_id: 880_001 });
    await tap(OWNER, 'leads:x:csv', { update_id: 880_001 }); // Telegram retried the same tap
    expect(docs()).toHaveLength(1);
    expect(docs()[0].filename).toMatch(/\.csv$/);
    expect(sent.find((m) => m.method === 'answerCallbackQuery')!.body.text).toBe('Preparing the file…');

    // Someone who is not an admin gets a short notice and nothing else.
    sent.length = 0;
    await tap(STRANGER, 'leads:x:full');
    expect(docs()).toHaveLength(0);
    expect(sent.map((m) => m.method)).toEqual(['answerCallbackQuery']);
    expect(sent[0].body.text).toContain('for CFT administrators only');
    // A tap the bot does not know is answered and ignored.
    sent.length = 0;
    await tap(OWNER, 'leads:x:secret');
    await tap(OWNER, 'other:thing');
    expect(sent.map((m) => m.method)).toEqual(['answerCallbackQuery', 'answerCallbackQuery']);
  });

  it('imports a CSV file sent by an owner', async () => {
    csvFile = 'Name,Phone,Email,State,CDL Class,Experience,Consent\r\n"Kane, Jo",845-270-2211,jo@mail.com,Nevada,A,3 years,yes\r\nLou Marsh,845-270-2212,,AZ,B,1,\r\nAnn Lee,(845) 270-2201,,TX,A,6,yes\r\nBroken Row,12,,,,,yes\r\n';
    const doc = (from: number) => hook({ message: { chat: { id: from, type: 'private' }, from: { id: from, first_name: 'U' }, document: { file_id: 'F1', file_name: 'drivers.csv' } } });
    await doc(MEMBER);
    expect(texts(MEMBER)).toEqual(['Only owners can do this.']);
    await doc(STRANGER);
    expect(texts(STRANGER)).toEqual([]);
    await doc(OWNER);
    const reply = texts(OWNER)[0];
    expect(reply).toContain('4 rows · <b>2 new</b> · 1 duplicate merged · 1 rejected');
    expect(reply).toContain('Ready for GET RECENT LEADS: <b>1</b>');
    expect(await driver('+18452702211')).toMatchObject({ full_name: 'Kane, Jo', state: 'NV', source_id: 'csv-import', consent_status: 'granted' });
    expect(await driver('+18452702212')).toMatchObject({ consent_status: 'unknown' });

    // Two lists that number their rows the same way hold different people.
    sent.length = 0;
    csvFile = 'id,Name,Phone,Consent,Number of trucks\n1,Mia Nash,845-270-2251,yes,3\n2,Noel Odom,845-270-2252,yes,\n';
    await doc(OWNER);
    csvFile = 'id,Name,Phone,Consent\n1,Otis Pine,845-270-2253,yes\n2,Mia Nash,845-270-2251,yes\n';
    await doc(OWNER);
    expect(texts(OWNER).map((t) => /<b>(\d) new<\/b> · (\d) duplicate/.exec(t)!.slice(1, 3))).toEqual([['2', '0'], ['1', '1']]);
    expect(await driver('+18452702251')).toMatchObject({ full_name: 'Mia Nash', source_record_id: null, extra: { power_units: 3 } });
    expect((await driver('+18452702252')).extra).toEqual({});
    expect(await driver('+18452702253')).toMatchObject({ full_name: 'Otis Pine' });

    // A file saved by Excel under Russian regional settings: ";" between columns, Windows-1251 text.
    sent.length = 0;
    csvFile = Uint8Array.from([...Buffer.from('Name;Phone;City;Consent\r\nPavel Rudin;845-270-2254;'), 0xcc, 0xee, 0xf1, 0xea, 0xe2, 0xe0, ...Buffer.from(';yes\r\n')]);
    await doc(OWNER);
    expect(texts(OWNER)[0]).toContain('1 row · <b>1 new</b>');
    expect(await driver('+18452702254')).toMatchObject({ full_name: 'Pavel Rudin', city: 'Москва' });

    // When no row is usable, the reply shows which columns were found.
    sent.length = 0;
    csvFile = 'Fahrer,Telefon\nAnn Lee,8452702201\n';
    await doc(OWNER);
    expect(texts(OWNER)[0]).toContain('Columns found: Fahrer, Telefon');
  });

  it('collects FMCSA carrier records only when enabled, labels them, and skips known ones', async () => {
    const cron = () => call('GET', 'cron/leads', undefined, { authorization: 'Bearer cron-secret-abcdefghij' });
    expect((await call('GET', 'cron/leads')).status).toBe(401);
    census = [
      { dot_number: '7576042', legal_name: 'ANTHONY TIRE MOBILE SERVICE LLC', company_officer_1: 'ANTHONY FERREIRA SIME', phone: '8452702220', email_address: 'ANTHONYTIRE15@GMAIL.COM', phy_city: 'WALLINGTON', phy_state: 'NJ', phy_zip: '07057-1149', power_units: '1', total_drivers: '1', add_date: ymd(2), classdef: 'AUTHORIZED FOR HIRE' },
      { dot_number: '7575264', legal_name: 'DRAGON EXPRESS INC', company_officer_1: 'JIA LIU', phone: '8452702221', phy_state: 'CA', power_units: '1', add_date: ymd(2) },
      { dot_number: '7575000', legal_name: 'NO CONTACT LLC', phy_state: 'CA', power_units: '1' },
    ];
    expect((await cron()).body).toEqual({ sources: [] }); // LEADS_FMCSA_ENABLED is off
    await say(OWNER, '/leadsync');
    expect(texts(OWNER)[0]).toContain('The FMCSA registry source is not switched on');

    process.env.LEADS_FMCSA_ENABLED = 'true';
    expect((await cron()).body.sources).toEqual([{ sourceId: 'fmcsa-census', ok: true, inserted: 2, duplicates: 0, rejected: 1, removed: 0, partial: false }]);
    expect(await driver('+18452702220')).toMatchObject({
      record_kind: 'carrier', full_name: 'Anthony Ferreira Sime', company_name: 'ANTHONY TIRE MOBILE SERVICE LLC', usdot_number: '7576042', source_id: 'fmcsa-census',
      source_record_id: '7576042', consent_status: 'public_record', driver_types: ['owner_operator'], extra: expect.objectContaining({ power_units: 1, fmcsa_add_date: ymd(2) }),
    });
    expect((await cron()).body.sources[0]).toMatchObject({ inserted: 0, duplicates: 0, rejected: 1 }); // known carriers are skipped, not re-counted

    sent.length = 0;
    await say(OWNER, BUTTONS.recent);
    expect(docs()[0].caption).toContain('2 of them are carrier records from the public FMCSA registry, not driver sign-ups.');
    const xml = sheetXml(docs()[0].bytes!);
    // Every FMCSA carrier row shows the registry's truck count.
    const carrierRows = xml.match(/<row r="\d+">(?:(?!<\/row>).)*Carrier \(owner-operator\)(?:(?!<\/row>).)*<\/row>/g)!;
    expect(carrierRows).toHaveLength(2);
    for (const row of carrierRows) expect(row).toMatch(/<c r="F\d+" s="5"><v>1<\/v><\/c>/);
    expect(xml).toContain('Carrier (owner-operator)');
    expect(xml).toContain('Public FMCSA business record');
    process.env.LEADS_FMCSA_ENABLED = 'false';
  });

  it('replaces old FMCSA data by registration date, whatever FMCSA answers, without re-delivering', async () => {
    const cron = async () => (await call('GET', 'cron/leads', undefined, { authorization: 'Bearer cron-secret-abcdefghij' })).body.sources[0];
    const carrier = (dot: string, name: string, phone: string, daysAgo: number | null = 1) =>
      ({ dot_number: dot, legal_name: `${name} LLC`.toUpperCase(), company_officer_1: name, phone, phy_state: 'TX', power_units: '1', ...(daysAgo === null ? {} : { add_date: ymd(daysAgo) }) });
    /** Makes stored carriers look as if they were registered long ago (the look-back window is 10 days). */
    const age = (...dots: string[]) => db().query(`update drivers set extra = extra || '{"fmcsa_add_date": "20200101"}' where usdot_number = any($1)`, [dots]);
    const others = await count(`source_id <> 'fmcsa-census'`);
    process.env.LEADS_FMCSA_ENABLED = 'true';
    try {
      // A carrier who also signed up on the registration page is a consented driver now, and must survive.
      await register({ full_name: 'Jia Liu', phone: '8452702221' });
      expect(await driver('+18452702221')).toMatchObject({ source_id: 'fmcsa-census', record_kind: 'driver', consent_status: 'granted' });

      // An outage (empty answer) or a short answer deletes nothing: only a carrier's own date counts.
      const total = await count();
      census = [];
      expect(await cron()).toMatchObject({ inserted: 0, removed: 0 });
      census = [carrier('7580001', 'Nora New', '8452702230')];
      expect(await cron()).toMatchObject({ inserted: 1, removed: 0 });
      expect(await count()).toBe(total + 1);
      expect(await driver('+18452702220')).toBeDefined();

      // Carriers whose registration left the window are deleted, delivered or not.
      await age('7576042', '7575264');
      expect(await cron()).toMatchObject({ inserted: 0, removed: 1 });
      expect(await driver('+18452702220')).toBeUndefined(); // old carrier: deleted
      expect(await driver('+18452702221')).toMatchObject({ full_name: 'Jia Liu' }); // consented: kept
      expect(await driver('+18452702230')).toBeDefined(); // still in the window: untouched
      expect(await count(`source_id <> 'fmcsa-census'`)).toBe(others);

      // A deleted carrier that shows up again is not a new lead.
      census = [{ ...carrier('7576042', 'Anthony Ferreira Sime', '8452702220'), legal_name: 'ANTHONY TIRE MOBILE SERVICE LLC' }, census[0]];
      expect(await cron()).toMatchObject({ inserted: 0, removed: 0 });
      expect(await driver('+18452702220')).toBeUndefined();

      // Two USDOT numbers of one owner (same phone) share a record. Deleting it remembers both numbers.
      census = [carrier('7580010', 'Owen Twice', '8452702233', 6)];
      expect(await cron()).toMatchObject({ inserted: 1 });
      sent.length = 0;
      await say(OWNER, BUTTONS.recent);
      expect(sheetXml(docs()[0].bytes!)).toContain('Owen Twice');
      census = [census[0], carrier('7580011', 'Owen Twice', '8452702233', 1)];
      expect(await cron()).toMatchObject({ inserted: 0, duplicates: 1, removed: 0 });
      expect(await driver('+18452702233')).toMatchObject({ usdot_number: '7580011', delivery_status: 'delivered' });
      await age('7580011');
      expect(await cron()).toMatchObject({ removed: 1 });
      expect((await db().query(`select key from lead_tombstones where key like '%:75800__' order by 1`)).rows.map((r) => r.key)).toEqual(['src:fmcsa-census:7580010', 'src:fmcsa-census:7580011']);
      census = [carrier('7580011', 'Owen Twice', '8452702233', 1)];
      expect(await cron()).toMatchObject({ inserted: 0, removed: 0 });
      sent.length = 0;
      await say(OWNER, BUTTONS.recent);
      expect(texts(OWNER)).toEqual([NO_NEW_LEADS]);

      // A record without a registration date goes by the day it was stored.
      census = [carrier('7580003', 'Lee Later', '8452702232', null)];
      expect(await cron()).toMatchObject({ inserted: 1, removed: 0 });
      await db().query(`update drivers set first_added_at = now() - interval '30 days' where usdot_number = '7580003'`);
      expect(await cron()).toMatchObject({ removed: 1 });

      // Replace mode can be switched off.
      process.env.LEADS_FMCSA_REPLACE_OLD = 'false';
      await age('7580001');
      expect(await cron()).toMatchObject({ removed: 0 });
      expect(await driver('+18452702230')).toBeDefined();
    } finally {
      delete process.env.LEADS_FMCSA_REPLACE_OLD;
      process.env.LEADS_FMCSA_ENABLED = 'false';
    }
  });

  it('reports database statistics', async () => {
    await say(OWNER, BUTTONS.stats);
    const t = texts(OWNER)[0];
    const total = await count();
    expect(t).toMatch(/^📈 <b>Driver leads · Statistics<\/b>\n\d\d\/\d\d\/\d{4} \d\d:\d\d\n/);
    expect(t).toContain(`Records in the database: <b>${total}</b>`);
    expect(t).toContain(`Added today: <b>${total}</b>`);
    expect(t).toContain('New, not sent yet: <b>0</b>');
    expect(t).toMatch(/Sent: <b>\d+<\/b>/);
    expect(t).toMatch(/Not deliverable: \d+ without consent · \d+ opted out · 1 not verified/);
    expect(t).toMatch(/<b>By state<\/b>: .*TX 2\d/);
    expect(t).toMatch(/<b>By CDL class<\/b>: A \d+ · B \d+ · not given \d+/);
    expect(t).toContain('Acme Driver Leads');
    expect(t).toMatch(/All imports: \d+ duplicates merged · \d+ rejected as invalid/);
    expect(t).toContain(`Carrier records (public FMCSA registry): ${await count(`record_kind = 'carrier'`)}`);
    // Every delivered driver was delivered exactly once.
    const h = (await db().query('select count(*) as n, count(distinct driver_id) as d from delivery_history')).rows[0];
    expect(h.n).toBe(h.d);
    expect(h.n).toBe(await count(`delivery_status = 'delivered'`));
  });

  it('splits a large delivery into several files without dropping or repeating a lead', async () => {
    const batch = Array.from({ length: 35 }, (_v, i) => ({ name: `Bulk ${i}`, phone: `84527032${String(i).padStart(2, '0')}`, consent: true }));
    await call('POST', 'leads/ingest/acme-leads', batch, { authorization: 'Bearer ' + vendorToken });
    const saved = { ...limits };
    try {
      limits.recentPage = 15;
      await say(OWNER, BUTTONS.recent);
      expect(docs().map((d) => leadIds(d.bytes!).length)).toEqual([15, 15, 5]);
      expect(docs().map((d) => d.filename)).toEqual([expect.not.stringContaining('part'), expect.stringContaining('_part2.xlsx'), expect.stringContaining('_part3.xlsx')]);
      expect(new Set(docs().flatMap((d) => leadIds(d.bytes!))).size).toBe(35);

      // A click that runs out of time delivers what it can and says how to get the rest.
      await call('POST', 'leads/ingest/acme-leads', batch.map((b, i) => ({ ...b, name: `More ${i}`, phone: `84527033${String(i).padStart(2, '0')}` })), { authorization: 'Bearer ' + vendorToken });
      limits.budgetMs = -1;
      sent.length = 0;
      await say(OWNER, BUTTONS.recent);
      expect(docs()).toHaveLength(1);
      expect(texts(OWNER).at(-1)).toContain('More new leads are waiting');
      expect(await count(`delivery_status = 'pending' and consent_status = 'granted' and verification_status = 'verified'`)).toBe(20);
      limits.budgetMs = saved.budgetMs;
      await say(OWNER, BUTTONS.recent);
      expect(await count(`delivery_status = 'pending' and consent_status = 'granted' and verification_status = 'verified'`)).toBe(0);

      // Read-only exports continue through a tappable command.
      const eligible = await count(`consent_status in ('granted','public_record') and verification_status = 'verified'`);
      limits.xlsxPage = 50;
      limits.budgetMs = -1;
      const seen: string[] = [];
      let next = BUTTONS.excel as string;
      for (let i = 0; i < 10 && next; i++) {
        sent.length = 0;
        await say(OWNER, next);
        seen.push(...docs().flatMap((d) => leadIds(d.bytes!)));
        next = /\/more_excel_0_xlsx_\d+_\d+/.exec(texts(OWNER).join('\n'))?.[0] ?? '';
      }
      expect(seen).toHaveLength(eligible);
      expect(new Set(seen).size).toBe(eligible);
      expect(eligible).toBeGreaterThan(100);
    } finally {
      Object.assign(limits, saved);
    }
  });

  it('keeps the rest of the bot working', async () => {
    await say(OWNER, '/stats');
    expect(texts(OWNER)[0]).toContain('This week so far');
    await say(STRANGER, 'hello there');
    expect(texts(STRANGER)).toEqual([]);
  });
});
