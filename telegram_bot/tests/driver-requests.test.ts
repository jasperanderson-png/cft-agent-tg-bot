// Driver access requests and the website's sign-in through the bot: every agent and admin has two
// personal links (Telegram and website); a driver requests access with one (phone, company / MC number,
// who told them), the admins approve or decline (first tap wins), and an admin's own link gives access
// at once. Approved drivers use the map in the Mini App and on the website, signed in by confirming in
// the bot. Each driver keeps who invited them, which link and who approved them. Telegram is stubbed.
// Needs TEST_DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, getPool } from '../../database/db.js';
import { migrate } from '../../database/migrate.js';
import { seed } from '../../database/seeds/academy/seed.js';
import type { ApiRequest } from '../../support/helpers/http.js';
import { signInitData } from '../../support/helpers/tests/helpers.js';
import { handle as router } from '../server/router.js';

try {
  process.loadEnvFile('.env.local');
} catch {
  /* optional */
}
const DB = process.env.TEST_DATABASE_URL;
const BOT = '777000:TEST';

describe.skipIf(!DB)('driver access requests (PostgreSQL)', () => {
  interface Sent { method: string; chat_id?: number; text?: string; body?: any }
  const sent: Sent[] = [];
  const OWNER = 9447180;
  const ADMIN2 = 9001;
  const AGENT = 8401;
  const D1 = 8501, D2 = 8502, D3 = 8503, D4 = 8504, D5 = 8505;
  let id = 90_000;
  let message = 100;
  const hook = (update: Record<string, unknown>) => router({ method: 'POST', path: 'telegram/webhook', query: new URLSearchParams(), headers: { 'x-telegram-bot-api-secret-token': 'hook-secret-1234567890' }, body: update, ip: '10.0.0.1' } as ApiRequest);
  const from = (u: number) => ({ id: u, first_name: `Driver${u}`, last_name: 'Test', username: `d${u}` });
  const say = (u: number, text: string) => hook({ update_id: ++id, message: { chat: { id: u, type: 'private' }, from: from(u), text } });
  const shareContact = (u: number, phone: string, owner = u) => hook({ update_id: ++id, message: { chat: { id: u, type: 'private' }, from: from(u), contact: { phone_number: phone, user_id: owner } } });
  const tap = (u: number, data: string) => hook({ update_id: ++id, callback_query: { id: 'cb' + id, from: from(u), data, message: { message_id: 5, chat: { id: u, type: 'private' } } } });
  const of = (chat: number, method = 'sendMessage') => sent.filter((m) => m.chat_id === chat && m.method === method);
  const last = (chat: number) => of(chat).at(-1)!;
  const answers = () => sent.filter((m) => m.method === 'answerCallbackQuery').map((m) => m.body.text);
  const buttons = (m: Sent) => (m.body?.reply_markup?.inline_keyboard ?? []).flat() as { text: string; callback_data?: string; url?: string; web_app?: { url: string } }[];
  const api = (method: string, path: string, headers: Record<string, string> = {}, body: unknown = null) =>
    router({ method, path, query: new URLSearchParams(), headers: { 'content-type': 'application/json', ...headers }, body, ip: '10.0.0.2' } as ApiRequest);
  const asTelegram = (u: number) => ({ 'x-telegram-init-data': signInitData(from(u), BOT) });
  const isDriver = async (u: number) => !!(await getPool().query('select 1 from map_drivers where telegram_user_id = $1', [u])).rows[0];
  const request = async (u: number) => (await getPool().query('select * from driver_requests where telegram_user_id = $1 order by created_at desc limit 1', [u])).rows[0];
  /** The agent's or admin's two links, from /invitedriver. */
  async function links(u: number) {
    sent.length = 0;
    await say(u, '/invitedriver');
    const text = last(u).text!;
    return { bot: /🤖 Telegram: <code>([^<]+)<\/code>/.exec(text)![1], website: /🌐 Website: <code>([^<]+)<\/code>/.exec(text)![1], text, msg: last(u) };
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB, TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_WEBHOOK_SECRET: 'hook-secret-1234567890', APP_URL: 'https://app.example.com',
      WEB_URL: 'https://fuel.example.com', TELEGRAM_BOT_USERNAME: 'cft_Agentbot', ADMIN_TELEGRAM_IDS: String(OWNER), GOOGLE_SERVICE_ACCOUNT_JSON: '',
    });
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split('/').pop()!;
      const b = JSON.parse(String(init?.body ?? '{}'));
      sent.push({ method, chat_id: b.chat_id, text: b.text, body: b });
      return new Response(JSON.stringify({ ok: true, result: { message_id: ++message } }));
    });
    await getPool().query('drop schema public cascade; create schema public;');
    await migrate(() => {});
    await seed(() => {});
    await getPool().query(`insert into agents (telegram_user_id, name) values ($1, 'Aziz Agent')`, [AGENT]);
    await say(OWNER, '/start'); // the owner becomes an admin on first contact
    await getPool().query(`insert into admins (telegram_user_id, name) values ($1, 'Dana Admin')`, [ADMIN2]);
  });
  beforeEach(() => {
    sent.length = 0;
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await closePool();
  });

  it('gives every agent two personal links that stay the same', async () => {
    const a = await links(AGENT);
    expect(a.bot).toMatch(/^https:\/\/t\.me\/cft_Agentbot\?start=req_[a-z0-9]{8}$/);
    const code = a.bot.split('req_')[1];
    expect(a.website).toBe(`https://fuel.example.com/?ref=${code}`);
    expect(a.text).toContain('a CFT admin approves it');
    expect(buttons(a.msg).map((b) => b.text)).toEqual(['📤 Share Telegram link', '📤 Share website link', '👤 My drivers']);
    expect((await links(AGENT)).bot).toBe(a.bot);
  });

  it('asks the driver three things, sends the request to every admin, and the first decision wins', async () => {
    const { bot } = await links(AGENT);
    sent.length = 0;
    await say(D1, `/start ${bot.split('start=')[1]}`);
    const ask = last(D1);
    expect(ask.text).toContain('Step 1 of 2');
    expect(ask.body.reply_markup.keyboard[0][0]).toEqual({ text: '📱 Share my phone', request_contact: true });
    // Someone else's contact is not their phone; their own is.
    await shareContact(D1, '+15550001111', 1234);
    expect(last(D1).text).toContain('Share my phone');
    await shareContact(D1, '+1 214 555 0101');
    expect(last(D1).text).toContain('Step 2 of 2');
    await say(D1, 'ABC Trucking MC 123456');
    expect(last(D1).text).toContain('Request sent.');
    expect(last(D1).text).toContain('invited by Aziz Agent');
    expect(await isDriver(D1)).toBe(false);
    expect((await api('GET', 'driver/stations', asTelegram(D1))).status).toBe(403);

    // Every admin hears about it, with the answers and where the driver came from.
    for (const admin of [OWNER, ADMIN2]) {
      const card = last(admin);
      expect(card.text).toContain('New driver request');
      expect(card.text).toContain('+1 214 555 0101');
      expect(card.text).toContain('ABC Trucking MC 123456');
      expect(card.text).toContain('Invited by <b>Aziz Agent</b> · via bot link');
      expect(buttons(card).map((b) => b.text)).toEqual(['✅ Approve', '❌ Decline']);
    }
    const req = await request(D1);
    expect(req).toMatchObject({ status: 'pending', via: 'bot', ref_agent: AGENT });

    // Dana approves; the owner's later tap is told, and the driver hears it once.
    sent.length = 0;
    await tap(ADMIN2, `dreq:ok:${req.id}`);
    expect(await isDriver(D1)).toBe(true);
    expect(of(D1)).toHaveLength(1);
    expect(of(D1)[0].text).toContain("You're approved");
    expect(buttons(of(D1)[0])[0].web_app!.url).toBe('https://app.example.com/route');
    expect(of(D1, 'setChatMenuButton')[0].body.menu_button.text).toBe('Route map');
    expect(of(AGENT)[0].text).toContain('whom you invited, was approved by Dana Admin');
    const edits = sent.filter((m) => m.method === 'editMessageText');
    expect(edits.map((e) => e.chat_id).sort()).toEqual([ADMIN2, OWNER].sort());
    expect(edits[0].text).toContain('✅ Approved by <b>Dana Admin</b>');
    expect(edits[0].body.reply_markup).toBeUndefined();
    sent.length = 0;
    await tap(OWNER, `dreq:no:${req.id}`);
    expect(answers()).toEqual(['Already approved by Dana Admin']);
    expect(of(D1)).toHaveLength(0);
    expect(await isDriver(D1)).toBe(true);

    // The map is theirs now; the bot's /drivers shows who brought them.
    expect((await api('GET', 'driver/stations', asTelegram(D1))).status).toBe(200);
    sent.length = 0;
    await say(AGENT, '/drivers');
    expect(last(AGENT).text).toMatch(/Driver8501 Test @d8501 · joined .* · <b>yours<\/b>/);
  });

  it('marks requests from the website link, and tells a declined driver', async () => {
    const { website } = await links(AGENT);
    const code = website.split('ref=')[1];
    await say(D2, `/start req_${code}_w`);
    await shareContact(D2, '+12145550102');
    await say(D2, 'Solo owner-operator');
    const req = await request(D2);
    expect(req).toMatchObject({ status: 'pending', via: 'website' });
    expect(last(OWNER).text).toContain('Invited by <b>Aziz Agent</b> · via website link');
    sent.length = 0;
    await tap(OWNER, `dreq:no:${req.id}`);
    expect(await isDriver(D2)).toBe(false);
    expect(last(D2).text).toContain('was not approved');
    expect(sent.filter((m) => m.method === 'editMessageText')[0].text).toContain('❌ Declined by');
  });

  it('asks who told them when they came by themselves, and lets them cancel', async () => {
    await say(D3, '/start req_w'); // the website's own Request access button
    expect(last(D3).text).toContain('Step 1 of 3');
    await say(D3, 'hello'); // not a phone number
    expect(last(D3).text).toContain('type your phone number');
    await say(D3, '(214) 555-0103'); // typed: some desktop apps have no contact button
    await say(D3, 'XYZ Freight');
    expect(last(D3).text).toContain('Step 3 of 3');
    await say(D3, 'A friend at the truck stop');
    expect(last(OWNER).text).toContain('Heard about us: A friend at the truck stop');
    expect(last(OWNER).text).toContain('Came by themselves · via website');

    // Cancelling while answering; opening again starts fresh.
    await say(D4, '/start req');
    await say(D4, '/cancel');
    expect(last(D4).text).toContain('Request cancelled');
    expect(await request(D4)).toBeUndefined();
  });

  it("gives access at once through an admin's own link, approved by that admin", async () => {
    const { bot, text } = await links(OWNER);
    expect(text).toContain('gets the route map at once, approved by you');
    sent.length = 0;
    await say(D5, `/start ${bot.split('start=')[1]}`);
    await shareContact(D5, '+12145550105');
    await say(D5, 'Owner Fleet LLC');
    expect(await isDriver(D5)).toBe(true);
    expect(of(D5).map((m) => m.text).join('\n')).toContain("You're approved");
    const info = sent.find((m) => m.chat_id === ADMIN2 && m.method === 'sendMessage')!;
    expect(info.text).toContain('(own link)');
    expect(buttons(info)).toHaveLength(0);
  });

  it('tells staff and drivers they already have the map, and turns old agent links into requests', async () => {
    const { bot } = await links(AGENT);
    sent.length = 0;
    await say(AGENT, `/start ${bot.split('start=')[1]}`);
    expect(last(AGENT).text).toContain('already have the route map');
    await say(D1, `/start ${bot.split('start=')[1]}`);
    expect(last(D1).text).toContain('You already have the CFT route map');

    // A driver link an agent made before requests: a request with that agent as the inviter.
    const token = 'A'.repeat(43);
    await getPool().query(`insert into driver_invites (token_hash, created_by_agent, expires_at) values (encode(sha256($1::bytea), 'hex'), $2, now() + interval '1 day')`, [token, AGENT]);
    const D6 = 8506;
    await say(D6, `/start driver_${token}`);
    expect(last(D6).text).toContain('Step 1 of 2');
    expect(await request(D6)).toMatchObject({ ref_agent: AGENT, via: 'bot' });
    expect(await isDriver(D6)).toBe(false);
  });

  it('lets admins see and decide requests on the Drivers screen, with who invited and approved each driver', async () => {
    const login = await api('POST', 'admin/telegram-login', {}, { initData: signInitData({ id: OWNER, first_name: 'O' }, BOT) });
    const auth = { authorization: `Bearer ${(login.body as { token: string }).token}` };
    const list = (await api('GET', 'admin/driver-requests', auth)).body as { pending: { id: string; name: string; invitedBy: string | null; via: string }[] };
    const d3 = list.pending.find((p) => p.name === 'Driver8503 Test')!;
    expect(d3).toMatchObject({ invitedBy: null, via: 'website' });
    const after = (await api('POST', `admin/driver-requests/${d3.id}/approve`, auth)).body as { pending: unknown[]; decided: { id: string; status: string; decidedBy: string }[] };
    expect(after.decided.find((d) => d.id === d3.id)).toMatchObject({ status: 'approved' });
    expect(await isDriver(D3)).toBe(true);
    expect((await api('POST', `admin/driver-requests/${d3.id}/decline`, auth)).status).toBe(409);
    // Only admins.
    expect((await api('GET', 'admin/driver-requests')).status).toBe(401);

    const drivers = ((await api('GET', 'admin/drivers', auth)).body as { drivers: { telegramUserId: number; invitedBy: string | null; via: string; approvedBy: string | null; ownLink: boolean }[] }).drivers;
    expect(drivers.find((d) => d.telegramUserId === D1)).toMatchObject({ invitedBy: 'Aziz Agent', via: 'bot', approvedBy: 'Dana Admin', ownLink: false });
    expect(drivers.find((d) => d.telegramUserId === D5)).toMatchObject({ via: 'bot', ownLink: true });
    expect(drivers.find((d) => d.telegramUserId === D3)).toMatchObject({ invitedBy: null, via: 'website' });
  });

  it('signs a driver in on the website after they confirm in the bot, with the same rights as in Telegram', async () => {
    const start = (await api('POST', 'web/login')).body as { code: string; link: string };
    expect(start.link).toBe(`https://t.me/cft_Agentbot?start=login_${start.code}`);
    expect((await api('GET', `web/login/${start.code}`)).body).toEqual({ status: 'waiting' });

    await say(D1, `/start login_${start.code}`);
    const ask = last(D1);
    expect(ask.text).toContain('Log in to fuel.example.com?');
    sent.length = 0;
    await tap(D1, buttons(ask)[0].callback_data!);
    expect(answers()).toEqual(['Logged in']);

    const done = (await api('GET', `web/login/${start.code}`)).body as { status: string; session: string };
    expect(done.status).toBe('ok');
    expect(done.session).toMatch(/^cftweb\./);
    // The code works once.
    expect((await api('GET', `web/login/${start.code}`)).body).toEqual({ status: 'expired' });
    await tap(D2, buttons(ask)[0].callback_data!);
    expect(answers().at(-1)).toBe('This login has expired');

    const web = { 'x-telegram-init-data': done.session };
    expect((await api('GET', 'web/me', web)).body).toMatchObject({ role: 'drivers', name: 'Driver8501 Test' });
    expect((await api('GET', 'driver/stations', web)).status).toBe(200);
    expect((await api('GET', 'discounts', web)).status).toBe(403); // a driver, not an agent

    // Removing the driver locks the website out at once too.
    await getPool().query('delete from map_drivers where telegram_user_id = $1', [D1]);
    expect((await api('GET', 'driver/stations', web)).status).toBe(403);
    // Logging out ends the session.
    await api('POST', 'web/logout', web);
    expect((await api('GET', 'web/me', web)).status).toBe(401);
    expect((await api('GET', 'web/me', { 'x-telegram-init-data': 'cftweb.' + 'x'.repeat(43) })).status).toBe(401);
  });
});
