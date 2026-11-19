// Fuel prices: the cabinet client, the Excel file and the 📥 button. The cabinet and Telegram are
// stubbed; nothing here reaches the real websites. The bot tests need TEST_DATABASE_URL.
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, getPool } from '../../../database/db.js';
import type { ApiRequest } from '../../../support/helpers/http.js';
import { fetchAllStations, FuelError, price, toStation, type Stage } from '../cabinet.js';
import { FUEL_BUTTON } from '../../../telegram_bot/handlers/admins/fuel.js';
import { FUEL_FILENAME, FUEL_HEADERS, fuelPricesXlsx } from '../excel.js';
import { fuelInsights } from '../insights.js';
import { fuelCaption } from '../export.js';
import { handle as router } from '../../../telegram_bot/server/router.js';
import { signInitData } from '../../../support/helpers/tests/helpers.js';
import { migrate } from '../../../database/migrate.js';
import { seed } from '../../../database/seeds/academy/seed.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* optional */
}
const DB = process.env.TEST_DATABASE_URL;
const OWNER = 9447180;
const ADMIN = 7301;
const CANDIDATE = 7302;
const AUTH = 'https://auth.production.united-fuel.com/api/auth/login';
const LIST = 'https://cmp-backend.production.united-fuel.com/api/v1/cabinet/station';

/** A station record shaped like the cabinet's. */
const raw = (id: number, o: Record<string, unknown> = {}, price: Record<string, unknown> = {}, addr: Record<string, unknown> = {}) => ({
  id, nameInFile: `PILOT_J ${id}`, nameInEfs: `FJ-TOWN ${id}`, status: 'Discount', isDeleted: false,
  fuelPrices: [{ id: id * 10, stationId: id, retailPrice: 5.29, discountedPrice: 4.61, bestPrice: 4.56, updatedAt: '2026-11-12T18:49:45.640Z', ...price }],
  addresses: [{ street: `${id} Main St`, city: 'DALLAS', state: 'TX', ...addr }],
  ...o,
});

/** A fake cabinet: login plus a paged station list. `order` lets a test reorder rows between requests. */
function cabinet(stations: ReturnType<typeof raw>[], o: { login?: number; mustChange?: boolean; listStatus?: number; order?: (call: number) => ReturnType<typeof raw>[]; malformed?: boolean } = {}) {
  const calls: { url: string; limit?: number; page?: number; auth?: string }[] = [];
  let listCalls = 0;
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (u.href === AUTH) {
      calls.push({ url: AUTH });
      const body = JSON.parse(String(init?.body));
      if (o.login && o.login !== 201) return new Response(JSON.stringify({ success: false, error: 'Invalid credentials' }), { status: o.login });
      if (body.email !== 'cabinet@example.com' || body.password !== 'pa$$-word') return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ success: true, data: { accessToken: 'tok-123', refreshToken: 'r', user: { id: 1, mustChangePassword: !!o.mustChange } } }), { status: 201 });
    }
    if (u.origin + u.pathname === LIST) {
      const page = Number(u.searchParams.get('page'));
      const limit = Number(u.searchParams.get('limit'));
      calls.push({ url: LIST, page, limit, auth });
      if (o.listStatus) return new Response('{"success":false}', { status: o.listStatus });
      if (o.malformed) return new Response(JSON.stringify({ success: true, data: { items: [] } }));
      const all = o.order ? o.order(listCalls++) : stations;
      const data = all.slice((page - 1) * limit, page * limit);
      return new Response(JSON.stringify({ success: true, data, pagination: { currentPage: page, totalPages: Math.ceil(all.length / limit), totalItems: all.length } }));
    }
    throw new Error('unexpected request in test: ' + u.href);
  });
  return { fetch, calls };
}

describe('fuel cabinet: reading one station', () => {
  it('maps the fields the cabinet table shows, keeping prices exact and missing values empty', () => {
    expect(toStation(raw(1))).toEqual({
      id: 1, station: 'PILOT_J 1', retailPrice: 5.29, discountedPrice: 4.61, updatedAt: new Date('2026-11-12T18:49:45.640Z'), state: 'TX', city: 'DALLAS', address: '1 Main St',
      efsName: 'FJ-TOWN 1', chain: null, routeExit: null, broken: false,
    });
    // Casey's-style record: price as text, no discounted price, no name in the price file, no street.
    expect(toStation(raw(2, { nameInFile: null }, { retailPrice: '5.099', discountedPrice: undefined, bestPrice: '4.7923' }, { street: '' }))).toMatchObject({
      station: 'FJ-TOWN 2', retailPrice: 5.099, discountedPrice: null, address: null,
    });
    expect(toStation(raw(3, { nameInFile: 'A &amp; B  Fuel' }, {}, { street: '1  Route 9 &#38; I-80' }))).toMatchObject({ station: 'A & B Fuel', address: '1 Route 9 & I-80' });
    expect(toStation(raw(4, { fuelPrices: [], addresses: [] }))).toMatchObject({ retailPrice: null, discountedPrice: null, updatedAt: null, state: null, city: null, address: null });
    expect(toStation({ name: 'no id' })).toBeNull();
    expect([price(5.099), price('5.099'), price(' 6 '), price(0), price('N/A'), price(''), price(null), price(NaN), price('-1')]).toEqual([5.099, 5.099, 6, 0, null, null, null, null, null]);
  });
});

describe('fuel cabinet: reading every station', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.FUEL_CABINET_EMAIL = 'cabinet@example.com';
    process.env.FUEL_CABINET_PASSWORD = 'pa$$-word';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const fifty = Array.from({ length: 50 }, (_v, i) => raw(i + 1));

  it('signs in, reads every page and checks the count against the cabinet total', async () => {
    const c = cabinet(fifty);
    globalThis.fetch = c.fetch as typeof fetch;
    const stages: Stage[] = [];
    const x = await fetchAllStations((s) => stages.push(s), 20);
    expect(x).toMatchObject({ siteTotal: 50, pagesRead: 3, reread: false, duplicatesDropped: 0 });
    expect(x.stations).toHaveLength(50);
    expect(new Set(x.stations.map((s) => s.id)).size).toBe(50);
    expect(c.calls.filter((k) => k.url === LIST).map((k) => [k.page, k.limit, k.auth])).toEqual([[1, 20, 'Bearer tok-123'], [2, 20, 'Bearer tok-123'], [3, 20, 'Bearer tok-123']]);
    expect(stages).toEqual([
      { step: 'login' },
      { step: 'page', page: 1, pages: 3, read: 20, total: 50 },
      { step: 'page', page: 2, pages: 3, read: 40, total: 50 },
      { step: 'page', page: 3, pages: 3, read: 50, total: 50 },
    ]);
  });

  it('reads the list again in one request when rows move between pages, and keeps each station once', async () => {
    // The second request returns the rows in another order: page 2 repeats stations from page 1.
    const c = cabinet(fifty, { order: (n) => (n === 1 ? [...fifty].reverse() : fifty) });
    globalThis.fetch = c.fetch as typeof fetch;
    const x = await fetchAllStations(() => {}, 30);
    expect(x).toMatchObject({ siteTotal: 50, reread: true, pagesRead: 3 });
    expect(x.duplicatesDropped).toBeGreaterThan(0);
    expect(new Set(x.stations.map((s) => s.id)).size).toBe(50);
    expect(c.calls.filter((k) => k.url === LIST).at(-1)).toMatchObject({ page: 1, limit: 50 });
  });

  it('never returns an incomplete list', async () => {
    // The cabinet keeps repeating stations 1-30 and never returns 31-50, even when read in one go.
    globalThis.fetch = cabinet(fifty, { order: () => [...fifty.slice(0, 30), ...fifty.slice(0, 20)] }).fetch as typeof fetch;
    await expect(fetchAllStations(() => {}, 30)).rejects.toMatchObject({ kind: 'incomplete', message: expect.stringContaining('of the 50 stations') });
    globalThis.fetch = cabinet([]).fetch as typeof fetch;
    await expect(fetchAllStations()).rejects.toMatchObject({ kind: 'incomplete', message: expect.stringContaining('no stations') });
  });

  it('explains sign-in, site and network problems', async () => {
    const fails = async (setup: () => void) => {
      setup();
      return fetchAllStations().then(() => null, (e: FuelError) => [e.kind, e.message]);
    };
    expect(await fails(() => (globalThis.fetch = cabinet(fifty, { login: 401 }).fetch as typeof fetch))).toEqual(['auth', expect.stringContaining('did not accept the login')]);
    expect(await fails(() => (process.env.FUEL_CABINET_PASSWORD = 'wrong'))).toEqual(['auth', expect.stringContaining('did not accept the login')]);
    process.env.FUEL_CABINET_PASSWORD = 'pa$$-word';
    expect(await fails(() => (globalThis.fetch = cabinet(fifty, { mustChange: true }).fetch as typeof fetch))).toEqual(['auth', expect.stringContaining('new password')]);
    expect(await fails(() => (globalThis.fetch = cabinet(fifty, { login: 503 }).fetch as typeof fetch))).toEqual(['site', expect.stringContaining('HTTP 503')]);
    expect(await fails(() => (globalThis.fetch = cabinet(fifty, { listStatus: 500 }).fetch as typeof fetch))).toEqual(['site', expect.stringContaining('HTTP 500 for stations page 1')]);
    expect(await fails(() => (globalThis.fetch = cabinet(fifty, { malformed: true }).fetch as typeof fetch))).toEqual(['site', expect.stringContaining('does not recognise')]);
    expect(await fails(() => (globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch))).toEqual(['network', expect.stringContaining('could not be reached')]);
    expect(await fails(() => delete process.env.FUEL_CABINET_EMAIL)).toEqual(['config', expect.stringContaining('FUEL_CABINET_EMAIL')]);
  });
});

describe('fuel prices Excel file', () => {
  it('has the Stations sheet with the requested columns, formats, filter, frozen header and total', () => {
    const stations = [toStation(raw(1))!, toStation(raw(2, {}, { retailPrice: '5.099', discountedPrice: undefined }, { state: 'AL', city: 'Birmingham' }))!];
    const files = unzipSync(fuelPricesXlsx({ stations, siteTotal: 2, pagesRead: 1, reread: false, duplicatesDropped: 0 }, 'Asia/Tashkent'));
    expect(FUEL_FILENAME).toBe('fuel_prices.xlsx');
    expect(strFromU8(files['xl/workbook.xml'])).toMatch(/<sheet name="Stations".*<sheet name="Summary"/);
    const xml = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(FUEL_HEADERS).toEqual(['Station', 'Retail price', 'Discounted price', 'Updated time', 'State', 'City', 'Address']);
    for (const h of FUEL_HEADERS) expect(xml).toContain(`>${h}<`);
    expect(xml).toContain('state="frozen"');
    expect(xml).toContain('<autoFilter ref="A1:G3"/>'); // the table only, not the total under it
    expect(xml).toMatch(/<c r="B2" s="14"><v>5.29<\/v>/); // price format, value as sent
    expect(xml).toMatch(/<c r="B3" s="14"><v>5.099<\/v>/); // three decimals kept
    expect(xml).toMatch(/<c r="C3" s="14"\/>/); // no discounted price: empty, not 0
    expect(xml).toMatch(/<c r="D2" s="15"><v>[\d.]+<\/v>/); // date and time
    expect(xml).toMatch(/<row r="5">.*Total stations.*<v>2<\/v>/);
    expect(strFromU8(files['xl/styles.xml'])).toContain('formatCode="&quot;$&quot;0.00##"');
    expect(xml).toContain('<col min="7" max="7" width="11"'); // Address fitted to "1 Main St" plus padding
  });
});

describe('fuel prices summary', () => {
  const stations = [
    toStation(raw(1, {}, { retailPrice: 5.29, discountedPrice: 4.61 }))!,
    toStation(raw(2, { nameInFile: 'LOVES 2' }, { retailPrice: 6.1, discountedPrice: 4.11 }, { state: 'OK', city: 'ARDMORE' }))!,
    toStation(raw(3, { nameInFile: 'CASEYS 3' }, { retailPrice: '5.099', discountedPrice: undefined }, { state: 'IA', city: 'AMES' }))!,
  ];
  it('works out the figures shared by the caption and the Summary sheet', () => {
    const f = fuelInsights(stations);
    expect(f).toMatchObject({ stations: 3, states: 3, withDiscount: 2, retailOnly: 1, avgDiscounted: 4.36, avgRetail: 5.496, avgSaving: 1.335 });
    expect(f.cheapest).toMatchObject({ price: 4.11, station: { station: 'LOVES 2' } });
    expect(f.biggestSaving).toMatchObject({ saving: 1.99, station: { station: 'LOVES 2' } });
    expect(f.byState.map((s) => [s.state, s.stations, s.cheapestDiscounted, s.avgSaving])).toEqual([['IA', 1, null, null], ['OK', 1, 4.11, 1.99], ['TX', 1, 4.61, 0.68]]);
  });
  it("writes a caption with the key figures, within Telegram's limit", () => {
    const c = fuelCaption(fuelInsights(stations), '13/11/2026 01:21', 'Asia/Tashkent');
    expect(c.split('\n')).toEqual([
      '⛽ <b>Fuel prices · all stations</b>',
      '',
      '📍 <b>3</b> stations in <b>3</b> states',
      '💲 Cheapest discounted: <b>$4.11</b> · LOVES 2, Ardmore, OK',
      '📉 Average saving: <b>$1.335</b> per gallon',
      '🏆 Biggest saving: <b>$1.99</b> · LOVES 2, Ardmore, OK',
      '🕐 Downloaded 13/11/2026 01:21 (Tashkent time)',
      '',
      '📊 <b>Stations</b> sheet: every station, with filters · <b>By state</b> · <b>Summary</b>',
      '<i>ℹ️ 1 station has only a retail price in the cabinet, so its discounted cell is empty.</i>',
    ]);
    expect(c.length).toBeLessThan(1024);
  });
  it('adds the By state and Summary sheets to the workbook', () => {
    const files = unzipSync(fuelPricesXlsx({ stations, siteTotal: 3, pagesRead: 1, reread: false, duplicatesDropped: 0 }, 'Asia/Tashkent'));
    expect(strFromU8(files['xl/workbook.xml'])).toMatch(/<sheet name="Stations".*<sheet name="By state".*<sheet name="Summary"/);
    const byState = strFromU8(files['xl/worksheets/sheet2.xml']);
    for (const h of ['State', 'Stations', 'Cheapest discounted', 'Average discounted', 'Average retail', 'Average saving']) expect(byState).toContain(`>${h}<`);
    expect(byState).toContain('<autoFilter ref="A1:F4"/>');
    expect(byState).toMatch(/All states.*<v>3<\/v>.*<v>4.11<\/v>/);
    const summary = strFromU8(files['xl/worksheets/sheet3.xml']);
    for (const t of ['AT A GLANCE', 'Cheapest discounted price', 'LOVES 2, Ardmore, OK', 'CHECKS', '✓ Complete: every station, each one once', 'HOW TO READ THIS FILE', 'Asia/Tashkent time']) expect(summary).toContain(t);
  });
});

describe.skipIf(!DB)('📥 Download All Fuel Prices button (PostgreSQL)', () => {
  interface Sent { method: string; chat_id?: number; text?: string; filename?: string; caption?: string; bytes?: Uint8Array; body?: any }
  const sent: Sent[] = [];
  const realFetch = globalThis.fetch;
  let cab = cabinet(Array.from({ length: 7 }, (_v, i) => raw(i + 1)));
  let id = 50_000;

  const hook = (update: Record<string, unknown>) => router({ method: 'POST', path: 'telegram/webhook', query: new URLSearchParams(), headers: { 'x-telegram-bot-api-secret-token': 'hook-secret-1234567890' }, body: update, ip: '10.0.0.1' } as ApiRequest);
  const press = (from: number, text: string = FUEL_BUTTON, update_id = ++id) => hook({ update_id, message: { chat: { id: from, type: 'private' }, from: { id: from, first_name: 'U' }, text } });
  const of = (chat: number, method: string) => sent.filter((m) => m.chat_id === chat && m.method === method);

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB, TELEGRAM_BOT_TOKEN: '777000:TEST', TELEGRAM_WEBHOOK_SECRET: 'hook-secret-1234567890', APP_URL: 'https://academy.example.com',
      ADMIN_TELEGRAM_IDS: String(OWNER), GOOGLE_SERVICE_ACCOUNT_JSON: '', FUEL_CABINET_EMAIL: 'cabinet@example.com', FUEL_CABINET_PASSWORD: 'pa$$-word',
    });
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (!u.startsWith('https://api.telegram.org/')) return cab.fetch(url, init);
      const method = u.split('/').pop()!;
      if (init?.body instanceof FormData) {
        const f = init.body.get('document') as File;
        sent.push({ method, chat_id: Number(init.body.get('chat_id')), filename: f.name, caption: String(init.body.get('caption') ?? ''), bytes: new Uint8Array(await f.arrayBuffer()) });
        return new Response(JSON.stringify({ ok: true, result: {} }));
      }
      const b = JSON.parse(String(init?.body ?? '{}'));
      sent.push({ method, chat_id: b.chat_id, text: b.text, body: b });
      return new Response(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: 99 } : true }));
    });
    await getPool().query('drop schema public cascade; create schema public;');
    await migrate(() => {});
    await seed(() => {});
    await getPool().query(`insert into admins (telegram_user_id, name, role) values ($1, 'Fuel Admin', 'admin')`, [ADMIN]);
  });
  beforeEach(() => {
    sent.length = 0;
    cab = cabinet(Array.from({ length: 7 }, (_v, i) => raw(i + 1)));
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
    await closePool();
  });

  it('shows the button and command to admins only', async () => {
    await press(OWNER, '/start');
    expect((sent[0].body.reply_markup.keyboard as { text: string }[][]).flat().map((b) => b.text)).toContain(FUEL_BUTTON);
    expect(sent.find((m) => m.method === 'setMyCommands')!.body.commands.map((c: any) => c.command)).toContain('fuelprices');
    sent.length = 0;
    await press(CANDIDATE, '/start');
    expect(JSON.stringify(sent)).not.toContain(FUEL_BUTTON);
    expect(JSON.stringify(sent)).not.toContain('fuelprices');
  });

  it('sends every station as fuel_prices.xlsx, with live status', async () => {
    await press(ADMIN);
    const doc = of(ADMIN, 'sendDocument');
    expect(doc).toHaveLength(1);
    expect(doc[0].filename).toBe('fuel_prices.xlsx');
    expect(doc[0].caption).toContain('📍 <b>7</b> stations in <b>1</b> state');
    expect(doc[0].caption).toContain('💲 Cheapest discounted: <b>$4.61</b> · PILOT_J 1, Dallas, TX');
    const xml = strFromU8(unzipSync(doc[0].bytes!)['xl/worksheets/sheet1.xml']);
    expect(xml.match(/PILOT_J \d/g)).toHaveLength(7);
    expect(xml).toMatch(/Total stations.*<v>7<\/v>/);
    // One status message, edited step by step, ending with the result.
    expect(of(ADMIN, 'sendMessage').map((m) => m.text)).toEqual(['⛽ <b>Fuel prices</b>\n⏳ Starting…']);
    const edits = of(ADMIN, 'editMessageText').map((m) => m.text!.split('\n')[1]);
    expect(edits).toEqual([
      '⏳ Signing in to the fuel cabinet…',
      '⏳ Reading stations: page 1 of 1 · 7 of 7 stations',
      expect.stringContaining('All 7 stations read and checked'),
      '✅ Done: 7 of 7 stations, sent below.',
    ]);
    expect(cab.calls.map((c) => c.url)).toEqual([AUTH, LIST]);
    // /fuelprices does the same.
    sent.length = 0;
    await press(OWNER, '/fuelprices');
    expect(of(OWNER, 'sendDocument')).toHaveLength(1);
  });

  it('refuses anyone who is not an admin, without contacting the cabinet', async () => {
    await press(CANDIDATE);
    await press(CANDIDATE, '/fuelprices');
    expect(of(CANDIDATE, 'sendMessage').map((m) => m.text)).toEqual(['⛽ Fuel prices are for CFT administrators only.', '⛽ Fuel prices are for CFT administrators only.']);
    expect(cab.calls).toHaveLength(0);
    expect(of(CANDIDATE, 'sendDocument')).toHaveLength(0);
  });

  it('runs once when Telegram retries the same click', async () => {
    await press(ADMIN, FUEL_BUTTON, 777_001);
    await press(ADMIN, FUEL_BUTTON, 777_001);
    expect(of(ADMIN, 'sendDocument')).toHaveLength(1);
    expect(cab.calls.filter((c) => c.url === AUTH)).toHaveLength(1);
  });

  it('gives admins the CFT Hub menu button and candidates the default one', async () => {
    await press(ADMIN, '/start');
    expect(of(ADMIN, 'setChatMenuButton')[0].body.menu_button).toEqual({ type: 'web_app', text: 'CFT Hub', web_app: { url: 'https://academy.example.com/#/hub' } });
    await press(CANDIDATE, '/start');
    expect(of(CANDIDATE, 'setChatMenuButton')[0].body.menu_button).toEqual({ type: 'default' });
  });

  it('serves the Hub: summaries and the station list for admins, and sends the Excel file to their chat', async () => {
    const api = (method: string, path: string, token = '', body?: unknown) =>
      router({ method, path, query: new URLSearchParams(), headers: token ? { authorization: 'Bearer ' + token } : {}, body: body ?? null, ip: '10.0.0.2' } as ApiRequest);
    for (const p of ['fuel/stations', 'leads/summary', 'academy/summary']) expect((await api('GET', p)).status).toBe(401);
    const candidate = await api('POST', 'admin/telegram-login', '', { initData: signInitData({ id: CANDIDATE, first_name: 'C' }, '777000:TEST') });
    expect(candidate.status).toBe(403);
    const login = await api('POST', 'admin/telegram-login', '', { initData: signInitData({ id: ADMIN, first_name: 'A' }, '777000:TEST') });
    const token = (login.body as { token: string }).token;

    // The Hub and the Fuel screen ask at the same moment: one sign-in, one read of the cabinet.
    const [list, again] = await Promise.all([api('GET', 'fuel/stations', token), api('GET', 'fuel/stations', token)]);
    expect(again.body).toEqual(list.body);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ siteTotal: 7, fetchedAt: expect.any(String) });
    expect((list.body as any).stations[0]).toEqual({ id: expect.any(Number), station: expect.stringMatching(/^PILOT_J \d$/), retail: 5.29, discounted: 4.61, updatedAt: '2026-11-12T18:49:45.640Z', state: 'TX', city: 'DALLAS', address: expect.stringContaining('Main St') });
    await api('GET', 'fuel/stations', token);
    expect(cab.calls.filter((c) => c.url === AUTH)).toHaveLength(1); // the list is reused for a while

    expect((await api('GET', 'leads/summary', token)).body).toEqual({ waiting: 0, today: 0, total: 0 });
    expect((await api('GET', 'academy/summary', token)).body).toEqual({ week: { started: 0, completed: 0, passed: 0 } });

    sent.length = 0;
    const r = await api('POST', 'fuel/send', token, {});
    expect(r.body).toEqual({ sent: true, stations: 7 });
    expect(of(ADMIN, 'sendDocument')[0].filename).toBe('fuel_prices.xlsx');
    expect(cab.calls.filter((c) => c.url === AUTH)).toHaveLength(2); // sending always reads the cabinet fresh

    cab = cabinet([], { login: 401 });
    const failed = await api('POST', 'fuel/send', token, {});
    expect(failed).toMatchObject({ status: 502, body: { error: expect.stringContaining('did not accept the login') } });
  });

  it('sends no file and says why when the export fails', async () => {
    cab = cabinet([], { login: 401 });
    await press(ADMIN);
    expect(of(ADMIN, 'sendDocument')).toHaveLength(0);
    const last = of(ADMIN, 'editMessageText').at(-1)!.text!;
    expect(last).toContain('❌ The fuel cabinet did not accept the login');
    expect(last).toContain('No file was sent');
    expect(last).not.toContain('pa$$-word');

    sent.length = 0;
    cab = cabinet(Array.from({ length: 7 }, (_v, i) => raw(i + 1)), { listStatus: 502 });
    await press(ADMIN);
    expect(of(ADMIN, 'sendDocument')).toHaveLength(0);
    expect(of(ADMIN, 'editMessageText').at(-1)!.text).toContain('HTTP 502');
  });
});
