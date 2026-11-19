// Admin invite links: an owner makes one, the person opens it and is an admin; each link works once;
// only owners make links or remove admins. Telegram is stubbed. Needs TEST_DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, getPool } from '../../database/db.js';
import { migrate } from '../../database/migrate.js';
import { seed } from '../../database/seeds/academy/seed.js';
import type { ApiRequest } from '../../support/helpers/http.js';
import { handle as router } from '../server/router.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* optional */
}
const DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB)('admin invite links (PostgreSQL)', () => {
  interface Sent { method: string; chat_id?: number; text?: string; body?: any }
  const sent: Sent[] = [];
  const OWNER = 9447180;
  const NEW_ADMIN = 7301;
  const SECOND = 7302;
  const ADMIN = 7303;
  let id = 70_000;
  const hook = (update: Record<string, unknown>) => router({ method: 'POST', path: 'telegram/webhook', query: new URLSearchParams(), headers: { 'x-telegram-bot-api-secret-token': 'hook-secret-1234567890' }, body: update, ip: '10.0.0.1' } as ApiRequest);
  const say = (from: number, text: string) => hook({ update_id: ++id, message: { chat: { id: from, type: 'private' }, from: { id: from, first_name: `U${from}`, username: `u${from}` }, text } });
  const tap = (from: number, data: string) => hook({ update_id: ++id, callback_query: { id: 'cb' + id, from: { id: from, first_name: 'U' }, data, message: { message_id: 5, chat: { id: from, type: 'private' } } } });
  const of = (chat: number, method = 'sendMessage') => sent.filter((m) => (m.chat_id ?? m.body?.scope?.chat_id) === chat && m.method === method);
  const answers = () => sent.filter((m) => m.method === 'answerCallbackQuery').map((m) => m.body.text);
  const buttons = (m: Sent) => (m.body?.reply_markup?.inline_keyboard ?? []).flat() as { text: string; callback_data?: string }[];
  const isAdmin = async (tg: number) => !!(await getPool().query('select 1 from admins where telegram_user_id = $1', [tg])).rows[0];
  async function makeLink(label = 'Aziz') {
    await tap(OWNER, `adm:inv:24:${label}`);
    const edit = of(OWNER, 'editMessageText').at(-1)!;
    return /\?start=admin_([A-Za-z0-9_-]+)/.exec(edit.text!)![1];
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB, TELEGRAM_BOT_TOKEN: '777000:TEST', TELEGRAM_WEBHOOK_SECRET: 'hook-secret-1234567890', APP_URL: 'https://academy.example.com',
      TELEGRAM_BOT_USERNAME: 'cft_Agentbot', ADMIN_TELEGRAM_IDS: String(OWNER), GOOGLE_SERVICE_ACCOUNT_JSON: '',
    });
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? '{}'));
      sent.push({ method: String(url).split('/').pop()!, chat_id: b.chat_id, text: b.text, body: b });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
    await getPool().query('drop schema public cascade; create schema public;');
    await migrate(() => {});
    await seed(() => {});
    await getPool().query(`insert into admins (telegram_user_id, name, role) values ($1, 'Plain admin', 'admin')`, [ADMIN]);
    await getPool().query(`insert into agents (telegram_user_id, name) values ($1, 'Was an agent')`, [NEW_ADMIN]);
  });
  beforeEach(() => {
    sent.length = 0;
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await closePool();
  });

  it('lets an owner make a one-person link, and the person who opens it becomes an admin', async () => {
    await say(OWNER, '/addadmin Aziz');
    const ask = of(OWNER)[0];
    expect(ask.text).toContain('Invite an admin');
    expect(buttons(ask).map((b) => b.text)).toEqual(['1 hour', '1 day', '3 days', '7 days']);
    sent.length = 0;
    const token = await makeLink('Aziz');
    expect(of(OWNER, 'editMessageText').at(-1)!.text).toContain('It works for <b>one person</b>');
    expect(token.length).toBeGreaterThan(30);

    sent.length = 0;
    await say(NEW_ADMIN, `/start admin_${token}`);
    expect(await isAdmin(NEW_ADMIN)).toBe(true);
    expect((await getPool().query('select 1 from agents where telegram_user_id = $1', [NEW_ADMIN])).rows).toHaveLength(0);
    expect(of(NEW_ADMIN).map((m) => m.text).join('\n')).toContain('You are now a CFT admin');
    expect(of(NEW_ADMIN).map((m) => m.text).join('\n')).toContain('<b>CFT Agent bot</b>'); // the admin home
    expect(of(NEW_ADMIN, 'setMyCommands')[0].body.commands.map((c: { command: string }) => c.command)).toContain('addadmin');
    expect(of(OWNER)[0].text).toContain('<b>UNEW</b>'.replace('NEW', String(NEW_ADMIN)));
    expect(of(OWNER)[0].text).toContain('joined as an admin (link “Aziz”)');

    // The link is used up.
    sent.length = 0;
    await say(SECOND, `/start admin_${token}`);
    expect(await isAdmin(SECOND)).toBe(false);
    expect(of(SECOND)[0].text).toContain('already used, has expired or was turned off');
  });

  it('has ➕ Invite (agent, driver or admin) and 👥 Team buttons on the home keyboard', async () => {
    await say(OWNER, '/start');
    const keys = (of(OWNER)[0].body.reply_markup.keyboard as { text: string }[][]).map((r) => r.map((b) => b.text));
    expect(keys).toContainEqual(['➕ Invite', '👥 Team']);
    sent.length = 0;
    await say(OWNER, '➕ Invite');
    expect(of(OWNER)[0].text).toContain('Who is the link for?');
    expect(buttons(of(OWNER)[0]).map((b) => [b.text, b.callback_data])).toEqual([['👤 Agent', 'team:new'], ['🚚 Driver', 'drv:new'], ['🛡 Admin', 'adm:new']]);
    sent.length = 0;
    await tap(OWNER, 'adm:new');
    expect(of(OWNER)[0].text).toContain('Invite an admin');
    // A plain admin can invite agents and drivers, not admins.
    sent.length = 0;
    await say(ADMIN, '➕ Invite');
    expect(buttons(of(ADMIN)[0]).map((b) => b.text)).toEqual(['👤 Agent', '🚚 Driver']);
    expect(of(ADMIN)[0].text).toContain('Only owners can invite admins.');
    // 👥 Team, and the old 👥 Agents button, show every list.
    for (const button of ['👥 Team', '👥 Agents']) {
      sent.length = 0;
      await say(ADMIN, button);
      expect(of(ADMIN)[0].text).toMatch(/👥 <b>Team<\/b>[\s\S]*👤 Agents: <b>\d+<\/b>[\s\S]*🚚 Drivers: <b>\d+<\/b>[\s\S]*🛡 Admins: <b>\d+<\/b>/);
      expect(buttons(of(ADMIN)[0]).map((b) => b.callback_data)).toEqual(['tm:agents', 'drv:list', 'adm:list', 'tm:invite']);
    }
    sent.length = 0;
    await tap(ADMIN, 'tm:agents');
    expect(of(ADMIN)[0].text).toContain('👥 <b>Agents</b>');
  });

  it('is for owners only: admins see the list, others nothing', async () => {
    await say(ADMIN, '/addadmin');
    expect(of(ADMIN)[0].text).toBe('Only owners can add or remove admins.');
    sent.length = 0;
    await tap(ADMIN, 'adm:inv:24:x');
    expect(answers()).toEqual(['Only owners can add or remove admins.']);
    expect(of(ADMIN, 'editMessageText')).toHaveLength(0);
    sent.length = 0;
    await say(ADMIN, '/admins');
    expect(of(ADMIN)[0].text).toContain('🛡 <b>Admins</b> · 3');
    expect(of(ADMIN)[0].body.reply_markup).toBeUndefined();
    sent.length = 0;
    await tap(SECOND, 'adm:new');
    expect(answers()).toEqual(['For CFT administrators only.']);
  });

  it('lets an owner turn a link off and remove an admin', async () => {
    const token = await makeLink('Later');
    const off = buttons(of(OWNER, 'editMessageText').at(-1)!).find((b) => b.text === 'Turn this link off')!;
    await tap(OWNER, off.callback_data!);
    await say(SECOND, `/start admin_${token}`);
    expect(await isAdmin(SECOND)).toBe(false);

    sent.length = 0;
    await say(OWNER, '/admins');
    const list = of(OWNER)[0];
    const rm = buttons(list).find((b) => b.text === `Remove U${ADMIN}`)!; // the Telegram name wins over the stored one
    expect(buttons(list).some((b) => b.text === `Remove U${OWNER}`)).toBe(false); // owners can't be removed
    await tap(OWNER, rm.callback_data!);
    const confirm = of(OWNER).at(-1)!;
    await tap(OWNER, buttons(confirm)[0].callback_data!);
    expect(await isAdmin(ADMIN)).toBe(false);
    expect(of(ADMIN, 'deleteMyCommands')).toHaveLength(1);
  });
});
