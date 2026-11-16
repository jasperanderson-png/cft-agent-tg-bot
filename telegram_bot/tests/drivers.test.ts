// Drivers and the "may invite drivers" permission: admins make driver links, an admin lets an agent
// make them too, drivers get the route map and nothing else, an admin can remove a driver. Also the
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
    // Admin buttons are refused.
    sent.length = 0;
    await tap(DRIVER, 'team:new');
    await tap(DRIVER, 'drv:new');
    expect(answers()).toEqual(['For CFT administrators only.', 'For CFT administrators only.']);
    // Opening the link again just shows the home; staff don't use up driver links.
    sent.length = 0;
    await say(DRIVER, `/start driver_${token}`);
    expect(of(DRIVER)[0].text).toContain('CFT route map');
    await say(AGENT, `/start driver_${token}`);
    expect(of(AGENT)[0].text).toContain('already CFT staff');
    expect(await isDriver(AGENT)).toBe(false);
  });

  it('lets agents invite drivers only after an admin allows it', async () => {
    await say(AGENT, '/invitedriver');
    expect(of(AGENT)[0].text).toBe('Ask your CFT admin to let you invite drivers.');
    sent.length = 0;
    await tap(AGENT, 'drv:inv:24:x');
    expect(answers()).toEqual(['Ask your CFT admin to let you invite drivers.']);

    // The admin switches it on in the agent list; the agent hears about it and gets the command.
    sent.length = 0;
    await tap(OWNER, 'tm:agents');
    const toggle = buttons(of(OWNER)[0]).find((b) => b.callback_data === `team:drv:${AGENT}`)!;
    expect(toggle.text).toMatch(/^🚚 \+ /); // not allowed yet
    sent.length = 0;
    await tap(OWNER, `team:drv:${AGENT}`);
    expect(answers()).toEqual(['Can invite drivers now']);
    expect(of(AGENT)[0].text).toContain('You can now invite drivers');
    expect(of(AGENT, 'setMyCommands')[0].body.commands.map((c: { command: string }) => c.command)).toContain('invitedriver');
    expect(of(OWNER, 'editMessageText')[0].text).toContain('🚚 invites drivers');

    sent.length = 0;
    await say(AGENT, '/start');
    expect(buttons(of(AGENT)[0]).map((b) => b.text)).toContain('🚚 Invite a driver');
    sent.length = 0;
    const token = await driverLink(AGENT, 'Fleet');
    await say(DRIVER2, `/start driver_${token}`);
    expect(await isDriver(DRIVER2)).toBe(true);
    expect(of(AGENT)[0].text).toContain('joined as a driver (link “Fleet”)');
    // Agents don't get the admins' driver list.
    sent.length = 0;
    await tap(AGENT, 'drv:list');
    expect(answers()).toEqual(['For CFT administrators only.']);

    // Taken back: no more links.
    await tap(OWNER, `team:drv:${AGENT}`);
    sent.length = 0;
    await say(AGENT, '/invitedriver');
    expect(of(AGENT)[0].text).toBe('Ask your CFT admin to let you invite drivers.');
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
