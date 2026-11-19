// Agents and fuel discounts: the free-text search, partner brands, the driver tables, and the whole
// flow in the bot and the Mini App API (invite → join → search → prices minus the CFT margin →
// removal). Telegram and the fuel cabinet are stubbed. The bot tests need TEST_DATABASE_URL.
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseQuery, type AgentStation } from '../../../support/common/discounts.js';
import { closePool, getPool } from '../../../database/db.js';
import type { ApiRequest } from '../../../support/helpers/http.js';
import { handle as router } from '../../../telegram_bot/server/router.js';
import { signInitData } from '../../../support/helpers/tests/helpers.js';
import { migrate } from '../../../database/migrate.js';
import { seed } from '../../../database/seeds/academy/seed.js';
import { toStation } from '../cabinet.js';
import { displayName, partnerBrand } from '../dataset.js';
import { cheapestByState, stateMessages, stationTable, TABLE_WIDTH } from '../driver-message.js';
import { render, stateImages, svgToPng, tableSvg, textWidth, wrap } from '../table-image.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* optional */
}
const DB = process.env.TEST_DATABASE_URL;
const BOT = '777000:TEST';

describe('free-text search', () => {
  const read = (t: string) => {
    const q = parseQuery(t, ['OMAHA', 'DES MOINES', 'LINCOLN']);
    return { states: q.states, brands: q.brands, cities: q.cities, ambiguous: q.ambiguous?.states ?? null };
  };
  it('reads the examples agents type, spelling mistakes included', () => {
    expect(read('nebraska\ncalorado\niowo\nyuta\nminnesota \ncansas \nnevada\npilot flying love\'s')).toEqual({
      states: ['NE', 'CO', 'IA', 'UT', 'MN', 'KS', 'NV'], brands: ['pilot', 'loves'], cities: [], ambiguous: null,
    });
    expect(read('pilot flying love\'s')).toMatchObject({ states: [], brands: ['pilot', 'loves'] });
    for (const [typed, state] of [['texsa', 'TX'], ['misouri', 'MO'], ['Tennesse', 'TN'], ['pensilvania', 'PA'], ['new yrok', 'NY'], ['nort dakota', 'ND'], ['west virgina', 'WV'], ['indianna', 'IN'], ['arizone', 'AZ']]) {
      expect(read(typed).states, typed).toEqual([state]);
    }
  });
  it('takes codes and short names, without mistaking little words for states', () => {
    expect(read('TX')).toMatchObject({ states: ['TX'] });
    expect(read('tx loves')).toMatchObject({ states: ['TX'], brands: ['loves'] });
    expect(read('cali pilot')).toMatchObject({ states: ['CA'], brands: ['pilot'] });
    expect(read('pilot in iowa')).toMatchObject({ states: ['IA'], brands: ['pilot'] }); // "in" is not Indiana here
    expect(read('show me speedway stations in ohio')).toMatchObject({ states: ['OH'], brands: ['speedway'] });
    expect(read('in')).toMatchObject({ states: ['IN'] }); // alone, it is
    expect(read('loves ok')).toMatchObject({ states: ['OK'], brands: ['loves'] });
    expect(read('petro')).toMatchObject({ brands: ['ta'] });
    expect(read('flyng j utah')).toMatchObject({ states: ['UT'], brands: ['pilot'] });
  });
  it('asks when a word names two states, finds cities, and reports nonsense', () => {
    expect(read('carolina').ambiguous).toEqual(['NC', 'SC']);
    expect(read('dakota').ambiguous).toEqual(['ND', 'SD']);
    expect(read('piolt omaha')).toMatchObject({ brands: ['pilot'], cities: ['OMAHA'] });
    expect(parseQuery('hello there').unknown).toEqual(['hello']);
  });
});

/** A station record shaped like the cabinet's. */
const raw = (id: number, chain: string, name: string, state: string, price: Record<string, unknown> = {}, o: Record<string, unknown> = {}) => ({
  id, nameInFile: name, nameInEfs: o.efs ?? null, status: 'Discount', isDeleted: false, isBroken: o.broken ?? false, chain: { id: 1, name: chain },
  fuelPrices: [{ retailPrice: 6.26, discountedPrice: 5.57, discountPerUnit: 0.69, updatedAt: '2026-11-13T15:49:39.625Z', ...price }],
  addresses: [{ street: `${id} Main St`, city: (o.city as string) ?? 'LINCOLN', state, routeExit: (o.exit as string) ?? 'I-80, Exit 305 &amp;; US 6' }],
});

describe('partner brands', () => {
  const st = (r: ReturnType<typeof raw>) => toStation(r)!;
  it('keeps Pilot / Flying J, Love\'s, TA / Petro and Speedway, and nothing else', () => {
    expect(partnerBrand(st(raw(1, 'PILOT/J', 'PILOT_J 746', 'UT')))).toBe('pilot');
    expect(partnerBrand(st(raw(2, 'LOVES', 'LOVES 300', 'NE')))).toBe('loves');
    expect(partnerBrand(st(raw(3, 'TA/PETRO', 'PETRO 312', 'IA')))).toBe('ta');
    expect(partnerBrand(st(raw(4, '7Eleven', 'Speedway-45983', 'OH', {}, { efs: 'Speedway #4638' })))).toBe('speedway');
    expect(partnerBrand(st(raw(5, '7Eleven', '7-eleven-34516', 'TX')))).toBeNull();
    expect(partnerBrand(st(raw(6, 'Caseys', 'CASEYS 3', 'IA')))).toBeNull();
  });
  it('names stations the way drivers know them', () => {
    expect(displayName(st(raw(1, 'PILOT/J', 'PILOT_J 746', 'UT', {}, { efs: 'FJ-SALT LAKE CITY 746' })), 'pilot')).toBe('Flying J 746');
    expect(displayName(st(raw(1, 'PILOT/J', 'PILOT 1476', 'CO')), 'pilot')).toBe('Pilot 1476');
    expect(displayName(st(raw(2, 'LOVES', 'LOVES #838 TRAVEL STOP', 'CO')), 'loves')).toBe("Love's 838");
    expect(displayName(st(raw(3, 'TA/PETRO', 'PETRO 312', 'IA')), 'ta')).toBe('Petro 312');
    expect(displayName(st(raw(3, 'TA/PETRO', 'TA 45', 'IA')), 'ta')).toBe('TA 45');
    expect(displayName(st(raw(4, '7Eleven', 'Speedway-45983', 'OH', {}, { efs: 'Speedway #4638' })), 'speedway')).toBe('Speedway 4638');
    expect(st(raw(9, 'LOVES', 'LOVES 1', 'NE')).routeExit).toBe('I-80, Exit 305 & US 6');
  });
});

describe('driver tables', () => {
  const s = (id: number, name: string, city: string, price: number, state = 'NE'): AgentStation => ({
    id, brand: 'loves', name, state, city, address: null, exit: null, price, retail: price + 0.9, saving: 0.9, updatedAt: null,
  });
  it('fits a phone: every line at most 32 characters, prices lined up', () => {
    const t = stationTable([s(1, "Love's 300", 'NORTH PLATTE', 5.37), s(2, 'Speedway 46874', 'SOUTH SIOUX CITY', 5.099), s(3, 'TA 45', 'OMAHA', 5.5)]);
    const lines = t.replace(/<\/?pre>/g, '').split('\n');
    expect(lines[0]).toMatch(/^Station\s+City\s+Price$/);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(TABLE_WIDTH);
    expect(lines.slice(2).map((l) => l.length)).toEqual([TABLE_WIDTH, TABLE_WIDTH, TABLE_WIDTH]);
    expect(lines[2]).toMatch(/^Love's 300 +North Pla… +\$5\.37$/); // long city names shorten to fit
    expect(lines[3]).toMatch(/^Speedway 46874 South Sio… \$5\.099$/); // the store number is never cut
  });
  it('sorts cheapest first, splits long lists and summarises brands by state', () => {
    const many = Array.from({ length: 150 }, (_v, i) => s(i, `Love's ${i}`, 'LINCOLN', 4 + i / 1000));
    const msgs = stateMessages([{ state: 'NE', stations: many.reverse() }], 'HEAD');
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(m.length).toBeLessThan(4096);
    expect(msgs[0]).toContain('📍 <b>Nebraska</b> · 150 stations · save up to $0.90');
    expect(msgs[0].indexOf("Love's 0 ")).toBeLessThan(msgs[0].indexOf("Love's 1 "));
    const quick = stateMessages([{ state: 'NE', stations: many }], 'HEAD', 15);
    expect(quick).toHaveLength(1);
    expect(quick[0]).toContain('cheapest 15 of 150');
    const sum = cheapestByState([s(1, 'A 1', 'X', 5, 'TX'), s(2, 'B 2', 'Y', 4.5, 'TX'), s(3, 'C 3', 'Z', 5.2, 'NE')], 'HEAD')[0];
    expect(sum).toMatch(/NE +\$5\.20 C 3/);
    expect(sum).toMatch(/TX +\$4\.50 B 2/);
  });
});

describe('price table pictures', () => {
  const row = (id: number, name: string, price: number, retail: number | null, saving: number | null): AgentStation => ({
    id, brand: 'loves', name, state: 'OH', city: 'N. Baltimore', address: null, exit: null, price, retail, saving, updatedAt: null,
  });
  it('has the seven columns, prices right-aligned, cheapest first, 25 rows per picture', () => {
    const svg = tableSvg([row(1, "Love's 356", 5.46, 6.09, 0.63), row(2, 'TA <Express> & Co', 6.2, 6.2, null)], { heading: 'Ohio', date: 'Prices of 14/11/2026' });
    expect(svg).toContain('>Ohio<');
    expect(svg).toContain('>Prices of 14/11/2026<');
    expect(svg).toContain('data:image/svg+xml;base64,'); // the CFT logo
    for (const h of ['Station', 'City', 'State', 'Retail Price', 'Discount', 'Discounted Price', 'Discounted Percent']) expect(svg).toContain(`>${h}</text>`);
    expect(svg).toContain('>10.3%<'); // 0.63 of 6.09
    expect(svg).toMatch(/text-anchor="end"[^>]*>\$6\.09</);
    expect(svg).toContain('>N. BALTIMORE<');
    expect(svg).toContain('>OH<');
    expect(svg).toContain('>TA &lt;Express&gt; &amp; Co<');
    expect(svg).toContain('>—<');
    const many = Array.from({ length: 60 }, (_v, i) => row(i, `Love's ${i}`, 6 - i / 100, 7, 1));
    const saved = render.png;
    const pages: string[] = [];
    render.png = (s) => (pages.push(s), new Uint8Array());
    stateImages(many, 'Ohio', 'Prices of 14/11/2026');
    render.png = saved;
    expect(pages).toHaveLength(3);
    expect(pages[0]).toContain('page 1 of 3');
    expect(pages[0].indexOf("Love's 59")).toBeLessThan(pages[0].indexOf("Love's 58"));
  });
  it('wraps long names inside their column and keeps the gaps between columns equal', () => {
    const long = row(3, 'TA Express Littlefield Crossroads Travel Center', 5.5, 6.3, 0.8);
    const svg = tableSvg([row(1, "Love's 356", 5.46, 6.09, 0.63), long], { heading: 'Ohio', date: 'Prices of 14/11/2026' });
    const texts = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)</g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), t: m[3] }));
    const parts = texts.filter((t) => t.x === texts.find((x) => x.t === 'Station')!.x && t.y > 260).map((t) => t.t);
    expect(parts.length).toBeGreaterThan(2); // the long name takes two lines
    expect(parts.join(' ')).toContain('TA Express Littlefield Crossroads Travel Center');
    for (const p of parts) expect(textWidth(p)).toBeLessThanOrEqual(321);
    expect(wrap('Supercalifragilisticexpialidocious', 120).length).toBeGreaterThan(1); // one long word is split too
  });
  it('draws a real PNG with the bundled font', () => {
    const png = svgToPng(tableSvg([row(1, "Love's 356", 5.46, 6.09, 0.63)], { heading: 'Ohio', date: 'Prices of 14/11/2026' }));
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.length).toBeGreaterThan(5000);
  });
});

describe.skipIf(!DB)('agents in the bot and the Mini App (PostgreSQL)', () => {
  interface Sent { method: string; chat_id?: number; text?: string; filename?: string; caption?: string; bytes?: Uint8Array; body?: any }
  const sent: Sent[] = [];
  const OWNER = 9447180;
  const ADMIN = 8401;
  const AGENT = 8402;
  const OTHER = 8403;
  const CANDIDATE = 8404;
  let id = 90_000;
  let geocodeCalls = 0;
  let stations = [
    raw(1, 'PILOT/J', 'PILOT_J 746', 'NE', { retailPrice: 6.26, discountedPrice: 5.57 }, { efs: 'FJ-LINCOLN 746' }),
    raw(2, 'LOVES', 'LOVES 300', 'NE', { retailPrice: 6.1, discountedPrice: 5.31 }, { city: 'NORTH PLATTE' }),
    raw(3, 'TA/PETRO', 'TA 45', 'NE', { retailPrice: 6.2, discountedPrice: null }), // no discounted price
    raw(4, 'LOVES', 'LOVES 301', 'NE', { retailPrice: 6.0, discountedPrice: 5.1 }, { broken: true }),
    raw(5, 'PILOT/J', 'PILOT 1476', 'CO', { retailPrice: 6.2, discountedPrice: 5.51 }, { city: 'HUDSON' }),
    raw(6, '7Eleven', 'Speedway-45983', 'IA', { retailPrice: 5.9, discountedPrice: 5.0 }, { efs: 'Speedway #4638', city: 'DES MOINES' }),
    raw(7, 'Caseys', 'CASEYS 3', 'NE', { retailPrice: 5.0, discountedPrice: 4.0 }), // not a partner
    raw(8, 'LOVES', 'LOVES 302', 'NE', { retailPrice: 6.0, discountedPrice: 5.85 }), // 15¢ discount: less than the margin
  ];

  const hook = (update: Record<string, unknown>) => router({ method: 'POST', path: 'telegram/webhook', query: new URLSearchParams(), headers: { 'x-telegram-bot-api-secret-token': 'hook-secret-1234567890' }, body: update, ip: '10.0.0.1' } as ApiRequest);
  const say = (from: number, text: string, extra: Record<string, unknown> = {}) => hook({ update_id: ++id, message: { chat: { id: from, type: 'private' }, from: { id: from, first_name: `U${from}`, username: `u${from}`, ...extra }, text } });
  const tap = (from: number, data: string) => hook({ update_id: ++id, callback_query: { id: 'cb' + id, from: { id: from, first_name: 'U' }, data, message: { message_id: 5, chat: { id: from, type: 'private' } } } });
  const of = (chat: number, method = 'sendMessage') => sent.filter((m) => m.chat_id === chat && m.method === method);
  const texts = (chat: number) => sent.filter((m) => m.chat_id === chat && (m.method === 'sendMessage' || m.method === 'sendPhoto')).map((m) => `${m.caption ?? ''}\n${m.method === 'sendMessage' ? m.text : ''}`).join('\n---\n');
  /** The cells of the table pictures sent to a chat, joined with " | ". */
  const tables = (chat: number) =>
    of(chat, 'sendPhoto').flatMap((m) => [...m.text!.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((x) => x[1].replace(/&amp;/g, '&'))).join(' | ');
  const api = (method: string, path: string, user: number | null, body?: unknown) =>
    router({ method, path, query: new URLSearchParams(), headers: user ? { 'x-telegram-init-data': signInitData({ id: user, first_name: 'Aziz', last_name: 'Karimov', username: 'aziz_k' }, BOT) } : {}, body: body ?? null, ip: '10.0.0.2' } as ApiRequest);
  async function adminToken(user: number) {
    const r = await router({ method: 'POST', path: 'admin/telegram-login', query: new URLSearchParams(), headers: {}, body: { initData: signInitData({ id: user, first_name: 'A' }, BOT) }, ip: '10.0.0.3' } as ApiRequest);
    return (r.body as { token: string }).token;
  }
  const adminApi = (token: string, method: string, path: string, body?: unknown) =>
    router({ method, path, query: new URLSearchParams(), headers: { authorization: 'Bearer ' + token }, body: body ?? null, ip: '10.0.0.3' } as ApiRequest);
  /** Makes an invite through the bot, as an admin would, and returns its token. */
  async function invite(label = 'Aziz', hours = 168) {
    await tap(ADMIN, `team:inv:${hours}:${label}`);
    const edit = of(ADMIN, 'editMessageText').at(-1)!;
    return /\?start=agent_([A-Za-z0-9_-]+)/.exec(edit.text!)![1];
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB, TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_WEBHOOK_SECRET: 'hook-secret-1234567890', APP_URL: 'https://academy.example.com', TELEGRAM_BOT_USERNAME: 'cft_Agentbot',
      ADMIN_TELEGRAM_IDS: String(OWNER), GOOGLE_SERVICE_ACCOUNT_JSON: '', FUEL_CABINET_EMAIL: 'cabinet@example.com', FUEL_CABINET_PASSWORD: 'pa$$-word',
    });
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith('https://auth.production.united-fuel.com/')) return new Response(JSON.stringify({ data: { accessToken: 'tok', user: {} } }), { status: 201 });
      // The drivers' map: the chains' store list (All The Places), the Census and OpenRouteService.
      if (u === 'https://data.alltheplaces.xyz/runs/latest.json') return new Response(JSON.stringify({ output_url: 'https://atp.example/runs/1/output.zip' }));
      if (u.startsWith('https://atp.example/runs/1/output/')) {
        const loves = [{ geometry: { coordinates: [-100.7654, 41.1239] }, properties: { ref: '300', 'addr:city': 'North Platte', 'addr:state': 'NE' } }];
        return new Response(JSON.stringify({ features: u.endsWith('loves_us.geojson') ? loves : [] }));
      }
      if (u.startsWith('https://geocoding.geo.census.gov/')) {
        geocodeCalls++;
        return new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -96 - geocodeCalls / 100, y: 40 } }] } }));
      }
      if (u.startsWith('https://api.openrouteservice.org/v2/directions/')) {
        return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [[-96.7, 40.8], [-100.76, 41.12]] }, properties: { summary: { distance: 360000, duration: 12600 }, segments: [{ steps: [{ distance: 360000, duration: 12600, type: 11, instruction: 'Head west on I-80 W', name: 'I-80 W', way_points: [0, 1] }] }] } }] }));
      }
      if (u.startsWith('https://cmp-backend.production.united-fuel.com/')) return new Response(JSON.stringify({ data: stations, pagination: { totalItems: stations.length, totalPages: 1 } }));
      const method = u.split('/').pop()!;
      if (init?.body instanceof FormData) {
        const f = (init.body.get('document') ?? init.body.get('photo')) as File;
        const bytes = new Uint8Array(await f.arrayBuffer());
        // Pictures of tables are recorded as their SVG text (see render.png below).
        sent.push({ method, chat_id: Number(init.body.get('chat_id')), filename: f.name, caption: String(init.body.get('caption') ?? ''), bytes, text: method === 'sendPhoto' ? new TextDecoder().decode(bytes) : undefined, body: { reply_markup: JSON.parse(String(init.body.get('reply_markup') ?? 'null')) } });
        return new Response(JSON.stringify({ ok: true, result: {} }));
      }
      const b = JSON.parse(String(init?.body ?? '{}'));
      sent.push({ method, chat_id: b.chat_id, text: b.text, body: b });
      return new Response(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: 99 } : true }));
    });
    render.png = (svg) => new TextEncoder().encode(svg);
    await getPool().query('drop schema public cascade; create schema public;');
    await migrate(() => {});
    await seed(() => {});
    await getPool().query(`insert into admins (telegram_user_id, name, role) values ($1, 'Jasper', 'admin')`, [ADMIN]);
  });
  beforeEach(() => {
    sent.length = 0;
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await closePool();
  });

  it('gives admins the ➕ Invite and 👥 Team buttons and an invite link they choose the lifetime of', async () => {
    await say(ADMIN, '/start');
    expect((sent[0].body.reply_markup.keyboard as { text: string }[][]).flat().map((b) => b.text)).toEqual(expect.arrayContaining(['➕ Invite', '👥 Team']));
    sent.length = 0;
    await say(ADMIN, '/invite Aziz Karimov');
    const ask = of(ADMIN)[0];
    expect(ask.text).toContain('Invite an agent');
    expect(ask.body.reply_markup.inline_keyboard.flat().map((b: any) => b.text)).toEqual(['1 hour', '1 day', '3 days', '7 days', '30 days']);
    expect(ask.body.reply_markup.inline_keyboard[1][0].callback_data).toBe('team:inv:168:Aziz Karimov');
    const token = await invite('Aziz Karimov', 24);
    expect(of(ADMIN, 'editMessageText').at(-1)!.text).toMatch(/https:\/\/t\.me\/cft_Agentbot\?start=agent_/);
    expect(of(ADMIN, 'editMessageText').at(-1)!.text).toContain('Anyone with this link can join until');
    expect(token.length).toBeGreaterThan(30);
    // Not for anyone else.
    sent.length = 0;
    await say(CANDIDATE, '/invite');
    await tap(CANDIDATE, 'team:inv:24:x');
    expect(JSON.stringify(sent)).not.toContain('start=agent_');
  });

  it('turns everyone who opens the link into an agent until it expires, and tells the admin', async () => {
    const token = await invite('Aziz');
    sent.length = 0;
    await say(AGENT, `/start agent_${token}`, { first_name: 'Aziz', last_name: 'Karimov', username: 'aziz_k' });
    expect(texts(AGENT)).toContain('Welcome, Aziz! You can now look up CFT discount prices');
    expect(of(AGENT, 'setChatMenuButton')[0].body.menu_button).toEqual({ type: 'web_app', text: 'Discounts', web_app: { url: 'https://academy.example.com/#/discounts' } });
    expect(sent.find((m) => m.method === 'setMyCommands' && m.body.scope?.chat_id === AGENT)!.body.commands.map((c: any) => c.command)).toEqual(['start', 'help']);
    expect(texts(ADMIN)).toContain('✅ <b>Aziz Karimov</b> @aziz_k joined as an agent (link “Aziz”)');
    // The same link works for a second person too, and counts them.
    sent.length = 0;
    await say(OTHER, `/start agent_${token}`);
    expect(texts(OTHER)).toContain('You can now look up CFT discount prices');
    expect((await getPool().query("select uses from agent_invites where label = 'Aziz'")).rows[0].uses).toBe(2);
    await getPool().query('delete from agents where telegram_user_id = $1', [OTHER]);
    sent.length = 0;
    // An expired link, a made-up one, and an admin opening a link: nobody joins, the link stays unused.
    const late = await invite('Late');
    await getPool().query("update agent_invites set expires_at = now() - interval '1 minute' where label = 'Late'");
    await say(OTHER, `/start agent_${late}`);
    await say(OTHER, '/start agent_nonsense-token-that-is-long-enough');
    expect(texts(OTHER)).toContain('has expired or was turned off');
    const fresh = await invite('Fresh');
    sent.length = 0;
    await say(ADMIN, `/start agent_${fresh}`);
    expect(texts(ADMIN)).toContain('already a CFT admin');
    expect((await getPool().query("select used_at from agent_invites where label = 'Fresh'")).rows[0].used_at).toBeNull();
    expect((await getPool().query('select count(*)::int as n from agents')).rows[0].n).toBe(1);
  });

  it('says prices are not loaded before the first pull, and ignores candidates', async () => {
    await say(AGENT, 'nebraska');
    expect(texts(AGENT)).toContain('not loaded yet');
    await say(CANDIDATE, 'nebraska');
    expect(of(CANDIDATE)).toHaveLength(0);
  });

  it('updates what agents see whenever an admin pulls the prices', async () => {
    await say(ADMIN, '📥 Download All Fuel Prices');
    expect(of(ADMIN, 'sendDocument')[0].filename).toBe('fuel_prices.xlsx');
    expect(of(ADMIN, 'editMessageText').at(-1)!.text).toContain('👥 Agents now see these prices (7 partner stations).');
    const { rows } = await getPool().query('select name, brand from discount_stations order by station_id');
    expect(rows.map((r) => `${r.brand}:${r.name}`)).toEqual(['pilot:Flying J 746', "loves:Love's 300", 'ta:TA 45', "loves:Love's 301", 'pilot:Pilot 1476', 'speedway:Speedway 4638', "loves:Love's 302"]);
  });

  it('answers a typed state with a clean table: the cabinet discount minus 20 cents', async () => {
    await say(AGENT, 'nebraska');
    expect(of(AGENT, 'sendPhoto')).toHaveLength(1);
    expect(of(AGENT, 'sendPhoto')[0].caption).toBe('⛽ <b>Nebraska</b> · 2 stations · save up to $0.59\n<i>Per gallon with the CFT discount · prices of ' + of(AGENT, 'sendPhoto')[0].caption!.split('prices of ')[1]);
    const t = tables(AGENT);
    expect(t).toContain('Station | City | State | Retail Price | Discount | Discounted Price | Discounted Percent');
    expect(t).toContain("Love's 300 | NORTH PLATTE | NE | $6.10 | $0.59 | $5.51 | 9.7%"); // discount 0.79 − 0.20
    expect(t).toContain('Flying J 746 | LINCOLN | NE | $6.26 | $0.49 | $5.77 | 7.8%'); // discount 0.69 − 0.20
    expect(t.indexOf("Love's 300")).toBeLessThan(t.indexOf('Flying J 746')); // cheapest first
    const m = texts(AGENT) + t;
    expect(m).not.toContain('5.57'); // the real discounted price never reaches agents
    expect(m).not.toContain("Love's 302"); // a discount smaller than 20¢ is hidden
    expect(m).not.toContain('TA 45'); // no discounted price: hidden by default
    expect(m).not.toContain("Love's 301"); // broken: hidden by default
    expect(m).not.toContain('Admin view');
  });

  it('reads a list of misspelt states and brands, asks about "carolina", and helps with nonsense', async () => {
    await say(AGENT, 'nebraska\ncalorado\niowo\nyuta');
    const m = texts(AGENT);
    expect(m).toContain('<b>Nebraska</b>');
    expect(m).toContain('<b>Colorado</b>');
    expect(m).toContain('<b>Iowa</b>');
    expect(tables(AGENT)).toContain('Speedway 4638 | DES MOINES | IA | $5.90 | $0.70 | $5.20 | 11.9%');
    expect(m).toContain('No partner stations in Utah.');
    expect(of(AGENT, 'sendPhoto')).toHaveLength(3); // one picture per state
    sent.length = 0;
    await say(AGENT, "pilot flying love's");
    expect(texts(AGENT)).toContain('Cheapest in each state');
    expect(tables(AGENT)).toContain('State | Station | City | Retail Price | Discount | Discounted Price | Discounted Percent');
    expect(tables(AGENT)).toContain('CO | Pilot 1476 | HUDSON | $6.20 | $0.49 | $5.71 | 7.9%');
    expect(tables(AGENT)).not.toContain('Speedway');
    sent.length = 0;
    await say(AGENT, 'carolina');
    expect(of(AGENT)[0].body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual(['disc:s:NC:15', 'disc:s:SC:15']);
    sent.length = 0;
    await say(AGENT, 'hello there');
    expect(texts(AGENT)).toContain('I couldn’t find a state or station');
  });

  it('answers a store number with just that station, its address and map link', async () => {
    await say(AGENT, "nebraska love's 300");
    expect(of(AGENT, 'sendPhoto')).toHaveLength(1);
    const t = tables(AGENT);
    expect(t).toContain("Love's 300 | NORTH PLATTE | NE | $6.10 | $0.59 | $5.51 | 9.7%");
    expect(t).not.toContain('Flying J 746');
    expect(of(AGENT, 'sendPhoto')[0].caption).toContain('1 station');
    expect(texts(AGENT)).toContain("⛽ <b>Love's 300</b> · North Platte, NE");
    expect(texts(AGENT)).toContain('Open in Google Maps');
    expect(JSON.stringify(of(AGENT, 'sendPhoto')[0].body.reply_markup)).not.toContain('disc:x'); // no Excel for one station
    // Without the state, and with "#".
    sent.length = 0;
    await say(AGENT, 'loves #300');
    expect(tables(AGENT)).toContain("Love's 300 | NORTH PLATTE");
    // A number that is not there says so instead of sending the whole state.
    sent.length = 0;
    await say(AGENT, "nebraska love's 999");
    expect(of(AGENT, 'sendPhoto')).toHaveLength(0);
    expect(texts(AGENT)).toContain("No Love's #999 in Nebraska in the agents’ price list");
    // A road number is not a store number.
    sent.length = 0;
    await say(AGENT, 'nebraska i 80');
    expect(tables(AGENT)).toContain('Flying J 746');
    expect(tables(AGENT)).toContain("Love's 300");
  });

  it('sends an agent-priced Excel file from the button', async () => {
    await tap(AGENT, 'disc:x:NE:15');
    const doc = of(AGENT, 'sendDocument')[0];
    expect(doc.filename).toBe('cft_discounts_NE.xlsx');
    const xml = strFromU8(unzipSync(doc.bytes!)['xl/worksheets/sheet1.xml']);
    expect(xml).toContain('>CFT price<');
    expect(xml).toMatch(/<v>5\.51<\/v>/);
    expect(xml).not.toMatch(/<v>5\.31<\/v>/);
  });

  it('lets admins set the margin and show stations without a discount or flagged broken', async () => {
    const token = await adminToken(ADMIN);
    const before = await adminApi(token, 'GET', 'admin/discounts');
    expect(before.body).toMatchObject({ settings: { margin: 0.2, showNoPrice: false, showBroken: false }, dataset: { partnerStations: 7, withDiscount: 6, noPrice: 1, broken: 1, smallDiscount: 1, siteTotal: 8 } });
    expect((await adminApi(token, 'PUT', 'admin/discounts/settings', { margin: 5, showNoPrice: true, showBroken: true })).status).toBe(400);
    await adminApi(token, 'PUT', 'admin/discounts/settings', { margin: 0.3, showNoPrice: true, showBroken: true });
    await say(AGENT, 'NE');
    const m = tables(AGENT);
    expect(m).toContain("Love's 300 | NORTH PLATTE | NE | $6.10 | $0.49 | $5.61 | 8.0%"); // discount 0.79 − 0.30
    expect(m).toContain('TA 45 | LINCOLN | NE | $6.20 | — | $6.20 | —'); // retail, no discount
    expect(m).toContain("Love's 301");
    await adminApi(token, 'PUT', 'admin/discounts/settings', { margin: 0.2, showNoPrice: false, showBroken: false });
    // Admins searching see the agents' view, labelled.
    sent.length = 0;
    await say(ADMIN, 'nebraska');
    expect(texts(ADMIN)).toContain('Admin view: these are the agents’ prices (cabinet discount − $0.20; smaller discounts are hidden)');
  });

  it('serves the Mini App to agents and admins only, never with the real discounted price', async () => {
    const r = await api('GET', 'discounts', AGENT);
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.me).toMatchObject({ role: 'agent', invitedBy: 'Jasper', since: expect.any(String) });
    expect(body.stations).toHaveLength(4); // 2 in NE (no-price and broken hidden again), 1 in CO, 1 in IA
    expect(body.stations.find((s: any) => s.name === "Love's 300")).toEqual({
      id: 2, brand: 'loves', name: "Love's 300", state: 'NE', city: 'NORTH PLATTE', address: '2 Main St', exit: 'I-80, Exit 305 & US 6', price: 5.51, retail: 6.1, saving: 0.59, updatedAt: '2026-11-13T15:49:39.625Z',
    });
    expect(JSON.stringify(body)).not.toContain('discounted');
    expect((await api('GET', 'discounts', CANDIDATE)).status).toBe(403);
    expect((await api('GET', 'discounts', null)).status).toBe(401);
    expect((await api('GET', 'discounts', OWNER)).body).toMatchObject({ me: { role: 'admin' } });

    sent.length = 0;
    expect((await api('POST', 'discounts/send', AGENT, { states: ['NE', 'IA'], brands: [] })).body).toEqual({ sent: 3 });
    expect(texts(AGENT)).toContain('<b>Nebraska</b>');
    expect(texts(AGENT)).toContain('<b>Iowa</b>');
    expect((await api('POST', 'discounts/send', AGENT, { states: [] })).status).toBe(400);
    sent.length = 0;
    await api('POST', 'discounts/send-station', AGENT, { id: 2 });
    expect(texts(AGENT)).toContain("⛽ <b>Love's 300</b> · North Platte, NE");
    expect(texts(AGENT)).toContain('💲 <b>$5.51</b> per gallon with CFT · retail $6.10 · <b>save $0.59</b>');
    expect(texts(AGENT)).toContain('🛣 I-80, Exit 305 &amp; US 6');
    expect(texts(AGENT)).toContain('https://www.google.com/maps/search/?api=1&query=');
    sent.length = 0;
    await api('POST', 'discounts/excel', AGENT, { states: ['NE'], brands: ['loves'] });
    expect(of(AGENT, 'sendDocument')[0].filename).toBe('cft_discounts_NE.xlsx');
  });

  it('gives the drivers\' map the agents\' prices, each station placed once, and truck routes', async () => {
    delete process.env.ORS_API_KEY; // a developer's .env.local may have one
    expect((await api('GET', 'driver/stations', CANDIDATE)).status).toBe(403);
    expect((await api('GET', 'driver/stations', null)).status).toBe(401);
    // The list answers at once (no lookups); the page then asks for the missing map points in the background.
    let body = (await api('GET', 'driver/stations', AGENT)).body as any;
    expect(body).toMatchObject({ routing: false, pendingGeocode: 4 });
    expect(body.stations.every((s: any) => s.lat === null)).toBe(true);
    expect((await api('POST', 'driver/locate', CANDIDATE)).status).toBe(403);
    expect((await api('POST', 'driver/locate', AGENT)).body).toMatchObject({ placed: 4, pending: 0 });
    body = (await api('GET', 'driver/stations', AGENT)).body as any;
    expect(body).toMatchObject({ routing: false, pendingGeocode: 0 });
    // Love's 300 from Love's own store list (by store number); the others by street address.
    expect(body.stations.find((s: any) => s.station === "Love's 300")).toMatchObject({ brand: 'l', retail: 6.1, discounted: 5.51, lat: 41.1239, lng: -100.7654 });
    expect(body.stations.every((s: any) => typeof s.lat === 'number')).toBe(true);
    expect(geocodeCalls).toBe(body.stations.length - 1);
    expect(JSON.stringify(body)).not.toContain('5.31'); // the cabinet's own price never reaches the map
    const { rows } = await getPool().query('select source, count(*)::int as n from station_geo group by source order by source');
    expect(rows).toEqual([{ source: 'census', n: 3 }, { source: 'chain', n: 1 }]);
    // From the cache next time, for admins too.
    const calls = geocodeCalls;
    await api('GET', 'driver/stations', OWNER);
    expect(geocodeCalls).toBe(calls);

    // Truck routes need the OpenRouteService key.
    expect((await api('POST', 'driver/route', AGENT, { from: { lat: 40.8, lng: -96.7 }, to: { lat: 41.12, lng: -100.76, label: 'North Platte' } })).status).toBe(503);
    process.env.ORS_API_KEY = 'ors-key';
    try {
      expect(((await api('GET', 'driver/stations', AGENT)).body as any).routing).toBe(true);
      const r = await api('POST', 'driver/route', AGENT, { from: { lat: 40.8, lng: -96.7 }, to: { lat: 41.12, lng: -100.76, label: 'North Platte' }, truck: { heightIn: 162, weightLb: 80000 } });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ durationS: 12600, to: { label: 'North Platte' }, steps: [{ street: 'I-80 W', type: 11 }] });
      expect((await api('POST', 'driver/route', CANDIDATE, { from: { lat: 1, lng: 1 }, to: 'x' })).status).toBe(403);
    } finally {
      delete process.env.ORS_API_KEY;
    }
  });

  it('lists agents and invites for admins, and removing an agent takes discounts away at once', async () => {
    const token = await adminToken(ADMIN);
    const list = (await adminApi(token, 'GET', 'admin/agents')).body as any;
    expect(list.agents).toEqual([expect.objectContaining({ telegramUserId: AGENT, name: 'Aziz Karimov', username: 'aziz_k', invitedBy: 'Jasper', inviteLabel: 'Aziz' })]);
    expect(list.invites.map((i: any) => i.label)).toEqual(expect.arrayContaining(['Fresh']));
    const made = (await adminApi(token, 'POST', 'admin/agents/invites', { hours: 1, label: 'From the app' })).body as any;
    expect(made.link).toMatch(/^https:\/\/t\.me\/cft_Agentbot\?start=agent_/);
    expect((await adminApi(token, 'POST', 'admin/agents/invites', { hours: 5 })).status).toBe(400);
    expect((await adminApi(token, 'DELETE', `admin/agents/invites/${made.id}`)).status).toBe(200);
    await say(OTHER, '/start agent_' + made.link.split('agent_')[1]);
    expect(texts(OTHER)).toContain('was turned off');

    sent.length = 0;
    await tap(ADMIN, `team:rm:${AGENT}`);
    expect(texts(ADMIN)).toContain('Remove <b>Aziz Karimov</b> as an agent?');
    await tap(ADMIN, `team:rmy:${AGENT}`);
    expect(of(AGENT, 'setChatMenuButton')[0].body.menu_button).toEqual({ type: 'default' });
    sent.length = 0;
    await say(AGENT, 'nebraska');
    expect(of(AGENT)).toHaveLength(0);
    expect((await api('GET', 'discounts', AGENT)).status).toBe(403);
  });
});
