// Drivers: admins and every agent make driver links, drivers get the route map and nothing else,
// agents see all drivers (or their own) and remove their own, an admin removes anyone. Also the
// menu-button repair: each person's menu is set again when Telegram missed it. Telegram is stubbed.
// Needs TEST_DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, getPool } from '../../db_storage/db.js';
import { migrate } from '../../db_storage/migrate.js';
import { seed } from '../../db_storage/seeds/academy/seed.js';
import type { ApiRequest } from '../../core/http.js';
import { botApi } from '../../core/telegram.js';
import { signInitData } from '../../core/tests/helpers.js';
import { handle as router } from '../server/router.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* optional */
}
const DB = process.env.TEST_DATABASE_URL;
const BOT = '777000:TEST';

describe.skipIf(!DB)('drivers (PostgreSQL)', () => {
  interface Sent { method: string; chat_id?: number; text?: string; body?: any }
  const sent: Sent[] = [];
  const OWNER = 9447180;
  const AGENT = 7401;
  const DRIVER = 7402;
  const DRIVER2 = 7403;
  const CANDIDATE = 7404;
  const DRIVER3 = 7405;
  let id = 80_000;
  let failNext: string | null = null;
  const hook = (update: Record<string, unknown>) => router({ method: 'POST', path: 'telegram/webhook', query: new URLSearchParams(), headers: { 'x-telegram-bot-api-secret-token': 'hook-secret-1234567890' }, body: update, ip: '10.0.0.1' } as ApiRequest);
  const say = (from: number, text: string) => hook({ update_id: ++id, message: { chat: { id: from, type: 'private' }, from: { id: from, first_name: `U${from}`, username: `u${from}` }, text } });
  const tap = (from: number, data: string) => hook({ update_id: ++id, callback_query: { id: 'cb' + id, from: { id: from, first_name: 'U' }, data, message: { message_id: 5, chat: { id: from, type: 'private' } } } });
  const of = (chat: number, method = 'sendMessage') => sent.filter((m) => (m.chat_id ?? m.body?.scope?.chat_id) === chat && m.method === method);
  const answers = () => sent.filter((m) => m.method === 'answerCallbackQuery').map((m) => m.body.text);
  const buttons = (m: Sent) => (m.body?.reply_markup?.inline_keyboard ?? []).flat() as { text: string; callback_data?: string; web_app?: { url: string } }[];
  const api = (method: string, path: string, user: number) =>
    router({ method, path, query: new URLSearchParams(), headers: { 'x-telegram-init-data': signInitData({ id: user, first_name: 'D' }, BOT) }, body: null, ip: '10.0.0.2' } as ApiRequest);
  const isDriver = async (tg: number) => !!(await getPool().query('select 1 from map_drivers where telegram_user_id = $1', [tg])).rows[0];
  /** Makes a driver link by tapping through, as an admin or agent would; returns its token. */
  async function driverLink(from: number, label = 'Night') {
    await tap(from, `drv:inv:24:${label}`);
    const edit = of(from, 'editMessageText').at(-1)!;
    return /\?start=driver_([A-Za-z0-9_-]+)/.exec(edit.text!)![1];
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB, TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_WEBHOOK_SECRET: 'hook-secret-1234567890', APP_URL: 'https://academy.example.com',
      TELEGRAM_BOT_USERNAME: 'cft_Agentbot', ADMIN_TELEGRAM_IDS: String(OWNER), GOOGLE_SERVICE_ACCOUNT_JSON: '',
    });
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split('/').pop()!;
      if (failNext === method) {
        failNext = null;
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      const b = JSON.parse(String(init?.body ?? '{}'));
      sent.push({ method, chat_id: b.chat_id, text: b.text, body: b });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
    await getPool().query('drop schema public cascade; create schema public;');
    await migrate(() => {});
    await seed(() => {});
    await getPool().query(`insert into agents (telegram_user_id, name) values ($1, 'Aziz Agent')`, [AGENT]);
  });
  beforeEach(() => {
    sent.length = 0;
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await closePool();
  });

  it('lets an admin send a driver link; the driver gets the route map and the admin hears about it', async () => {
    await say(OWNER, '/start'); // the owner becomes an admin on first contact
    sent.length = 0;
    await tap(OWNER, 'drv:new');
    expect(of(OWNER)[0].text).toContain('Invite a driver');
    const token = await driverLink(OWNER);
    expect(of(OWNER, 'editMessageText').at(-1)!.text).toContain('Anyone with this link can join');

    sent.length = 0;
    await say(DRIVER, `/start driver_${token}`);
    expect(await isDriver(DRIVER)).toBe(true);
    expect(of(DRIVER)[0].text).toContain('CFT route map');
    expect(buttons(of(DRIVER)[0])[0].web_app!.url).toBe('https://academy.example.com/route');
    expect(of(DRIVER, 'setChatMenuButton')[0].body.menu_button).toMatchObject({ text: 'Route map', web_app: { url: 'https://academy.example.com/route' } });
    expect(of(OWNER)[0].text).toContain('joined as a driver (link “Night”)');

    // The map is theirs; the agents' discount lists are not.
    expect((await api('GET', 'driver/stations', DRIVER)).status).toBe(200);
    expect((await api('GET', 'discounts', DRIVER)).status).toBe(403);
    expect((await api('GET', 'driver/stations', CANDIDATE)).status).toBe(403);
    // Staff buttons are refused.
    sent.length = 0;
    await tap(DRIVER, 'team:new');
    await tap(DRIVER, 'drv:new');
    expect(answers()).toEqual(['For CFT administrators only.', 'For CFT admins and agents only.']);
    // Opening the link again just shows the home; staff don't use up driver links.
    sent.length = 0;
    await say(DRIVER, `/start driver_${token}`);
    expect(of(DRIVER)[0].text).toContain('CFT route map');
    await say(AGENT, `/start driver_${token}`);
    expect(of(AGENT)[0].text).toContain('already CFT staff');
    expect(await isDriver(AGENT)).toBe(false);
  });

  it('lets every agent invite drivers from their home screen, and see all drivers or only their own', async () => {
    // No admin switch needed: the home has the driver buttons, the menu the driver commands.
    await say(AGENT, '/start');
    expect(buttons(of(AGENT)[0]).map((b) => b.text)).toEqual(expect.arrayContaining(['🚚 Invite a driver', '👤 My drivers']));
    expect(of(AGENT, 'setMyCommands')[0].body.commands.map((c: { command: string }) => c.command)).toEqual(['start', 'invitedriver', 'drivers', 'help']);
    sent.length = 0;
    await say(AGENT, '/invitedriver Fleet');
    expect(of(AGENT)[0].text).toContain('Invite a driver');
    sent.length = 0;
    const token = await driverLink(AGENT, 'Fleet');
    await say(DRIVER2, `/start driver_${token}`);
    expect(await isDriver(DRIVER2)).toBe(true);
    const joined = of(AGENT)[0];
    expect(joined.text).toContain('joined as a driver (link “Fleet”)');
    expect(buttons(joined)[0].callback_data).toBe('drv:list:mine');

    // All drivers: the admin's driver too, theirs marked; a remove button only for their own.
    sent.length = 0;
    await say(AGENT, '/drivers');
    const all = of(AGENT)[0];
    expect(all.text).toContain('🚚 <b>Drivers</b> · 2');
    expect(all.text).toMatch(/U7403 @u7403 · joined .* · <b>yours<\/b>/);
    expect(buttons(all).filter((b) => b.callback_data?.startsWith('drv:rm:')).map((b) => b.callback_data)).toEqual([`drv:rm:${DRIVER2}`]);
    // My drivers, switched in place.
    sent.length = 0;
    await tap(AGENT, 'drv:view:mine');
    const mine = of(AGENT, 'editMessageText')[0];
    expect(mine.text).toContain('<b>My drivers</b> · 1');
    expect(buttons(mine).map((b) => b.text)).toContain('👥 All drivers');

    // Someone else's driver stays: no confirmation, and the database refuses too.
    sent.length = 0;
    await tap(AGENT, `drv:rm:${DRIVER}`);
    expect(of(AGENT)[0].text).toContain("joined through someone else's link");
    await tap(AGENT, `drv:rmy:${DRIVER}`);
    expect(await isDriver(DRIVER)).toBe(true);
    // Their own driver goes.
    await say(DRIVER3, `/start driver_${token}`);
    sent.length = 0;
    await tap(AGENT, `drv:rm:${DRIVER3}`);
    expect(of(AGENT)[0].text).toContain('Remove <b>U7405</b> as a driver?');
    await tap(AGENT, `drv:rmy:${DRIVER3}`);
    expect(await isDriver(DRIVER3)).toBe(false);
  });

  it('lists drivers for admins and removes one: the map goes at once', async () => {
    await say(OWNER, '/drivers');
    const list = of(OWNER)[0];
    expect(list.text).toContain('🚚 <b>Drivers</b> · 2');
    expect(list.text).toMatch(/by Aziz Agent/);
    sent.length = 0;
    await tap(OWNER, `drv:rm:${DRIVER2}`);
    await tap(OWNER, `drv:rmy:${DRIVER2}`);
    expect(await isDriver(DRIVER2)).toBe(false);
    expect(of(DRIVER2, 'setChatMenuButton')[0].body.menu_button).toEqual({ type: 'default' });
    expect((await api('GET', 'driver/stations', DRIVER2)).status).toBe(403);
  });

  it('records a driver\'s navigated trip once per batch, never counts a gap as driving, and shows it to admins only', async () => {
    const call = (method: string, path: string, user: number, body: unknown) =>
      router({ method, path, query: new URLSearchParams(), headers: { 'x-telegram-init-data': signInitData({ id: user, first_name: 'D' }, BOT) }, body, ip: '10.0.0.3' } as ApiRequest);
    // The driver is told trips are recorded; agents' and admins' drives are not recorded.
    expect(((await api('GET', 'driver/stations', DRIVER)).body as any).trips).toEqual({ record: true, noticeSeen: false });
    expect(((await api('GET', 'driver/stations', AGENT)).body as any).trips).toBeNull();
    const start = {
      from: { label: 'Dallas, TX', lat: 32.78, lng: -96.8 }, to: { label: 'Austin, TX', lat: 30.27, lng: -97.74 },
      stop: { id: 9, name: "Love's 123", brand: 'l', price: 3.459, lat: 31.5, lng: -97.1 },
      plannedMi: 195.4, plannedS: 10_800, source: 'tomtom', path: [[-96.8, 32.78], [-97.74, 30.27]], truck: { heightIn: 162, weightLb: 80000, hazmat: false }, noticeSeen: true,
    };
    expect((await call('POST', 'driver/trips', AGENT, start)).body).toEqual({ id: null });
    const { id } = (await call('POST', 'driver/trips', DRIVER, start)).body as { id: string };
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(((await api('GET', 'driver/stations', DRIVER)).body as any).trips.noticeSeen).toBe(true);

    const t0 = Date.now();
    const batch = { seq: 0, points: [[t0, 32.78, -96.8, 20, 5], [t0 + 15_000, 32.79, -96.8, 20, 5]] };
    expect((await call('POST', `driver/trips/${id}/points`, DRIVER, batch)).body).toEqual({ saved: 2 });
    expect((await call('POST', `driver/trips/${id}/points`, DRIVER, batch)).body).toEqual({ saved: 0 }); // a retry counts once
    // Ten minutes later, far away: a gap, not driving.
    await call('POST', `driver/trips/${id}/points`, DRIVER, { seq: 1, points: [[t0 + 600_000, 32.0, -97.0, 25, 5]], status: 'stop' });
    // Someone else cannot add to it.
    expect((await call('POST', `driver/trips/${id}/points`, DRIVER2 + 1000, { seq: 2, points: [] })).status).toBe(403);
    await call('POST', `driver/trips/${id}/points`, DRIVER, { seq: 2, points: [], status: 'arrived' });

    const login = await router({ method: 'POST', path: 'admin/telegram-login', query: new URLSearchParams(), headers: {}, body: { initData: signInitData({ id: OWNER, first_name: 'O' }, BOT) }, ip: '10.0.0.4' } as ApiRequest);
    const token = (login.body as { token: string }).token;
    const admin = (path: string) => router({ method: 'GET', path, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` }, body: null, ip: '10.0.0.4' } as ApiRequest);
    const drivers = (await admin('admin/drivers')).body as { drivers: { telegramUserId: number; trips: number }[] };
    expect(drivers.drivers.find((d) => d.telegramUserId === DRIVER)?.trips).toBe(1);
    const trip = (await admin(`admin/trips/${id}`)).body as any;
    expect(trip.status).toBe('arrived');
    expect(trip.points).toBe(3);
    expect(trip.drivenMi).toBeCloseTo(0.7, 1); // the 0.69 mi between the first two points, not the gap
    expect(trip.gaps).toHaveLength(1);
    expect(trip.stop).toMatchObject({ name: "Love's 123", price: 3.459 });
    expect(trip.stop.reachedAt).not.toBeNull();
    expect((await router({ method: 'GET', path: `admin/trips/${id}`, query: new URLSearchParams(), headers: {}, body: null, ip: '10.0.0.4' } as ApiRequest)).status).toBe(401);
  });

  it('sets a menu Telegram missed on the next message, once, and retries a timed-out menu call', async () => {
    // As if the button change at joining had timed out: nothing recorded yet.
    await getPool().query('update telegram_users set menu_role = null where id = $1', [AGENT]);
    await say(AGENT, 'nebraska');
    expect(of(AGENT, 'setChatMenuButton').map((m) => m.body.menu_button.text)).toEqual(['Discounts']);
    sent.length = 0;
    await say(AGENT, 'iowa');
    expect(of(AGENT, 'setChatMenuButton')).toHaveLength(0);

    // A timeout on a menu call is tried once more; a new message is never sent twice.
    sent.length = 0;
    failNext = 'setChatMenuButton';
    await botApi('setChatMenuButton', { chat_id: AGENT, menu_button: { type: 'default' } });
    expect(of(AGENT, 'setChatMenuButton')).toHaveLength(1);
    failNext = 'sendMessage';
    await expect(botApi('sendMessage', { chat_id: AGENT, text: 'x' })).rejects.toThrow();
    expect(of(AGENT)).toHaveLength(0);
  });
});
