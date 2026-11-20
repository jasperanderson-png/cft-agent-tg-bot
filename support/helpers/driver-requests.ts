// Driver access requests: a driver asks in the bot (from fuel.cftransportllc.com, or an agent's or admin's
// personal link), answers three questions, and an admin approves or declines. Approved drivers get the
// route map in the Mini App and on the website. An agent's link always needs an admin; an admin's own
// link is approved at once ("approved by <admin> (own link)"). Every driver record keeps who brought
// them, which link they used and who approved them. The chat side is telegram_bot/cftagents/handlers/driver-requests.ts.
import { randomBytes } from 'node:crypto';
import { tx, type Db } from '../../database/db.js';
import { escHtml as esc } from '../common/html.js';
import type { DriverRequestCard } from '../common/types.js';
import { fmtDMYHM } from '../common/time.js';
import { audit } from './admins.js';
import { botUsername } from './agents.js';
import { env } from './env.js';
import { HttpError, UUID_RE } from './http.js';
import { botApi, storedName, type TelegramUser } from './telegram.js';
import { reportTimeZone } from './updates.js';

export const REQUEST_PREFIX = 'req';
export const REQUEST_CALLBACK = 'dreq:';
export type Via = 'bot' | 'website';
export type Step = 'phone' | 'company' | 'source';
/** Who makes links: an admin (their id) or an agent (their Telegram id). */
export type Referrer = { adminId: string; agentId?: undefined } | { agentId: number; adminId?: undefined };

// ---- Personal links ------------------------------------------------------------------------------

/** The agent's or admin's own code (made on first use), in both of their links. */
export async function refCode(db: Db, by: Referrer): Promise<string> {
  const col = by.agentId != null ? 'agent_id' : 'admin_id';
  const owner = by.agentId ?? by.adminId;
  const { rows } = await db.query(`select code from referral_codes where ${col} = $1`, [owner]);
  if (rows[0]) return rows[0].code;
  for (;;) {
    const code = [...randomBytes(8)].map((b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
    const { rows: r } = await db.query(
      `insert into referral_codes (code, ${col}) values ($1, $2) on conflict do nothing returning code`,
      [code, owner],
    );
    if (r[0]) return r[0].code;
    const again = await db.query(`select code from referral_codes where ${col} = $1`, [owner]);
    if (again.rows[0]) return again.rows[0].code; // made by a second tap at the same moment
  }
}

/** The two links an agent or admin sends to drivers: the bot, and the website. */
export async function personalLinks(db: Db, by: Referrer): Promise<{ bot: string; website: string }> {
  const code = await refCode(db, by);
  return { bot: `https://t.me/${await botUsername()}?start=${REQUEST_PREFIX}_${code}`, website: `${env.webUrl}/?ref=${code}` };
}

/** "/start req", "/start req_<code>" (bot link) or "/start req_<code>_w" / "/start req_w" (from the website). */
export function requestPayload(text: string | undefined): { code: string | null; via: Via } | null {
  const [first = '', payload = ''] = (text ?? '').trim().split(/\s+/);
  if (first.split('@')[0].toLowerCase() !== '/start') return null;
  const m = /^req(?:_([a-z0-9]{6,16}))?(_w)?$/.exec(payload);
  return m ? { code: m[1] ?? null, via: m[2] ? 'website' : 'bot' } : null;
}

// ---- The request ---------------------------------------------------------------------------------

export interface RequestRow {
  id: string;
  telegramUserId: number;
  status: 'asking' | 'pending' | 'approved' | 'declined';
  step: Step | null;
  phone: string | null;
  company: string | null;
  source: string | null;
  via: Via;
  refAgent: number | null;
  refAdmin: string | null;
}

const ROW = `id, telegram_user_id, status, step, phone, company, source, via, ref_agent, ref_admin`;
const toRow = (r: Record<string, any>): RequestRow => ({
  id: r.id, telegramUserId: Number(r.telegram_user_id), status: r.status, step: r.step, phone: r.phone, company: r.company,
  source: r.source, via: r.via, refAgent: r.ref_agent != null ? Number(r.ref_agent) : null, refAdmin: r.ref_admin,
});

/** The person's request that is still being answered or waiting, if any. */
export async function openRequest(db: Db, telegramUserId: number): Promise<RequestRow | null> {
  const { rows } = await db.query(`select ${ROW} from driver_requests where telegram_user_id = $1 and status in ('asking', 'pending')`, [telegramUserId]);
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Starts a request (or returns the open one). `code` is the personal code of the link they came with
 * (an unknown code counts as none). Staff and drivers don't need one.
 */
export async function startRequest(db: Db, user: TelegramUser, code: string | null, via: Via): Promise<RequestRow> {
  const open = await openRequest(db, user.id);
  if (open) return open;
  const { rows: ref } = code ? await db.query('select agent_id, admin_id from referral_codes where code = $1', [code]) : { rows: [] };
  const { rows } = await db.query(
    `insert into driver_requests (telegram_user_id, step, via, ref_agent, ref_admin) values ($1, 'phone', $2, $3, $4)
     on conflict (telegram_user_id) where status in ('asking', 'pending') do nothing returning ${ROW}`,
    [user.id, via, ref[0]?.agent_id ?? null, ref[0]?.admin_id ?? null],
  );
  return rows[0] ? toRow(rows[0]) : (await openRequest(db, user.id))!;
}

/** The next question after `step`; "who told you" is skipped when the link already says. */
const nextStep = (r: RequestRow, step: Step): Step | null => (step === 'phone' ? 'company' : step === 'company' && r.refAgent == null && r.refAdmin == null ? 'source' : null);

/**
 * Saves an answer to the question being asked and moves on. Returns the updated request: still
 * 'asking' (with the next step), or submitted ('pending', or 'approved' at once for an admin's own link).
 */
export async function answerRequest(db: Db, r: RequestRow, answer: string): Promise<RequestRow> {
  if (r.status !== 'asking' || !r.step) return r;
  const value = answer.trim().replace(/\s+/g, ' ').slice(0, r.step === 'phone' ? 32 : r.step === 'company' ? 120 : 200);
  const step = nextStep(r, r.step);
  const { rows } = await db.query(
    `update driver_requests set ${r.step} = $2, step = $3, status = case when $3::text is null then 'pending' else status end,
            submitted_at = case when $3::text is null then now() else submitted_at end
      where id = $1 and status = 'asking' returning ${ROW}`,
    [r.id, value, step],
  );
  const next = rows[0] ? toRow(rows[0]) : r;
  if (next.status === 'pending' && next.refAdmin) return (await decide(next.id, next.refAdmin, true)).request ?? next;
  return next;
}

// ---- Deciding ------------------------------------------------------------------------------------

export type Decision =
  | { done: true; request: RequestRow }
  | { done: false; request?: RequestRow; decidedBy: string | null; status: string };

/**
 * An admin approves or declines a waiting request. The first decision wins; later taps are told who
 * decided. Approving makes the person a driver (the route map in the Mini App and on the website).
 */
export async function decide(requestId: string, adminId: string, approve: boolean): Promise<Decision> {
  if (!UUID_RE.test(requestId)) throw new HttpError(404, 'Request not found.');
  return tx(async (c) => {
    const { rows } = await c.query(`select ${ROW}, decided_by from driver_requests where id = $1 for update`, [requestId]);
    if (!rows[0]) throw new HttpError(404, 'Request not found.');
    const r = toRow(rows[0]);
    if (r.status !== 'pending') {
      const { rows: by } = await c.query('select name from admins where id = $1', [rows[0].decided_by]);
      return { done: false, request: r, decidedBy: by[0]?.name ?? null, status: r.status };
    }
    const status = approve ? 'approved' : 'declined';
    await c.query(`update driver_requests set status = $2, step = null, decided_at = now(), decided_by = $3 where id = $1`, [requestId, status, adminId]);
    if (approve) {
      const { rows: tu } = await c.query('select first_name, last_name, username from telegram_users where id = $1', [r.telegramUserId]);
      const u = { id: r.telegramUserId, first_name: tu[0]?.first_name, last_name: tu[0]?.last_name, username: tu[0]?.username } as TelegramUser;
      await c.query(
        `insert into map_drivers (telegram_user_id, name, username, request_id) values ($1, $2, $3, $4)
         on conflict (telegram_user_id) do update set request_id = excluded.request_id`,
        [r.telegramUserId, storedName(u), u.username?.slice(0, 64) ?? null, requestId],
      );
    }
    await audit(c, adminId, approve ? 'driver.approve' : 'driver.decline', 'driver_request', requestId, { driver: r.telegramUserId });
    return { done: true, request: { ...r, status, step: null } };
  });
}

// ---- Where a driver came from (the bot's /drivers and the Mini App's Drivers screen) ------------

/**
 * Joins for a query over map_drivers d: the request they were approved with, or the driver link they
 * joined with before requests. Use with DRIVER_ORIGIN_COLS.
 */
export const DRIVER_ORIGIN_JOINS = `
  left join driver_requests rq on rq.id = d.request_id
  left join agents rag on rag.telegram_user_id = rq.ref_agent
  left join admins rad on rad.id = rq.ref_admin
  left join admins dad on dad.id = rq.decided_by
  left join driver_invites i on i.id = d.invite_id
  left join admins iad on iad.id = i.created_by_admin
  left join agents iag on iag.telegram_user_id = i.created_by_agent`;
export const DRIVER_ORIGIN_COLS = `coalesce(rag.name, rad.name, iad.name, iag.name) as invited_by,
  coalesce(rq.ref_agent, i.created_by_agent) as invited_by_agent,
  coalesce(rq.via, case when d.invite_id is not null then 'link' end) as via,
  dad.name as approved_by, rq.decided_at as approved_at, coalesce(rq.decided_by = rq.ref_admin, false) as own_link`;

// ---- What admins see -----------------------------------------------------------------------------

/** A request as admins see it (the same shape the Mini App's Drivers screen gets). */
export type RequestCard = DriverRequestCard;

const CARD = `select r.id, r.telegram_user_id, r.status, r.phone, r.company, r.source, r.via, r.submitted_at, r.decided_at,
    coalesce(nullif(trim(concat_ws(' ', tu.first_name, tu.last_name)), ''), 'Telegram user') as name, tu.username,
    coalesce(ag.name, ra.name) as invited_by, coalesce(r.decided_by = r.ref_admin, false) as own_link, da.name as decided_by
  from driver_requests r
  left join telegram_users tu on tu.id = r.telegram_user_id
  left join agents ag on ag.telegram_user_id = r.ref_agent
  left join admins ra on ra.id = r.ref_admin
  left join admins da on da.id = r.decided_by`;
const toCard = (r: Record<string, any>): RequestCard => ({
  id: r.id, telegramUserId: Number(r.telegram_user_id), name: r.name, username: r.username, phone: r.phone, company: r.company, source: r.source,
  via: r.via, invitedBy: r.invited_by, ownLink: r.own_link, status: r.status, submittedAt: r.submitted_at?.toISOString() ?? null,
  decidedBy: r.decided_by, decidedAt: r.decided_at?.toISOString() ?? null,
});

export async function requestCard(db: Db, id: string): Promise<RequestCard | null> {
  const { rows } = await db.query(`${CARD} where r.id = $1`, [id]);
  return rows[0] ? toCard(rows[0]) : null;
}

/** Waiting requests (oldest first) and the last 30 decided ones, for the Drivers screen. */
export async function listRequests(db: Db): Promise<{ pending: RequestCard[]; decided: RequestCard[] }> {
  const { rows: p } = await db.query(`${CARD} where r.status = 'pending' order by r.submitted_at`);
  const { rows: d } = await db.query(`${CARD} where r.status in ('approved', 'declined') order by r.decided_at desc limit 30`);
  return { pending: p.map(toCard), decided: d.map(toCard) };
}

/** "Invited by Aziz · via website link" (or "came by themselves"). */
export const originText = (c: Pick<RequestCard, 'invitedBy' | 'via'>) =>
  `${c.invitedBy ? `Invited by <b>${esc(c.invitedBy)}</b>` : 'Came by themselves'} · via ${c.via === 'website' ? 'website' : 'bot'}${c.invitedBy ? ' link' : ''}`;

/** The admins' message about a request: who, their answers, where they came from, and the decision. */
export async function cardText(db: Db, c: RequestCard): Promise<string> {
  const tz = await reportTimeZone(db);
  const lines = [
    `🚚 <b>${c.status === 'pending' ? 'New driver request' : 'Driver request'}</b>`,
    '',
    `<b>${esc(c.name)}</b>${c.username ? ` @${esc(c.username)}` : ''}`,
    `📱 ${c.phone ? esc(c.phone) : '—'}`,
    `🏢 ${c.company ? esc(c.company) : '—'}`,
  ];
  if (c.source) lines.push(`💬 Heard about us: ${esc(c.source)}`);
  lines.push(originText(c));
  if (c.status === 'approved') lines.push('', `✅ Approved by <b>${esc(c.decidedBy ?? 'an admin')}</b>${c.ownLink ? ' (own link)' : ''} · ${fmtDMYHM(c.decidedAt!, tz)}`);
  else if (c.status === 'declined') lines.push('', `❌ Declined by <b>${esc(c.decidedBy ?? 'an admin')}</b> · ${fmtDMYHM(c.decidedAt!, tz)}`);
  return lines.join('\n');
}

const decideButtons = (id: string) => ({ inline_keyboard: [[{ text: '✅ Approve', callback_data: `${REQUEST_CALLBACK}ok:${id}` }, { text: '❌ Decline', callback_data: `${REQUEST_CALLBACK}no:${id}` }]] });

/** Admin chats to tell: every admin linked to Telegram (owners included) who hasn't blocked the bot. */
async function adminChats(db: Db): Promise<number[]> {
  const { rows } = await db.query(
    `select distinct id from (
       select telegram_user_id as id from admins where telegram_user_id is not null
       union select unnest($1::bigint[])
     ) a where not exists (select 1 from telegram_users tu where tu.id = a.id and tu.blocked_bot)`,
    [env.ownerTelegramIds],
  );
  return rows.map((r) => Number(r.id));
}

/** Tells every admin about a new request, with Approve / Decline, and remembers the messages. */
export async function announceRequest(db: Db, id: string): Promise<void> {
  const c = await requestCard(db, id);
  if (!c) return;
  const text = await cardText(db, c);
  const sent: { chat: number; message: number }[] = [];
  for (const chat of await adminChats(db)) {
    try {
      const m = (await botApi('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', reply_markup: c.status === 'pending' ? decideButtons(id) : undefined })) as { message_id?: number };
      if (m?.message_id) sent.push({ chat, message: m.message_id });
    } catch (e) {
      console.error('request not announced', chat, (e as Error).message);
    }
  }
  await db.query('update driver_requests set admin_messages = $2 where id = $1', [id, JSON.stringify(sent)]);
}

/** Every admin's message about the request shows its current state (the buttons go once decided). */
export async function refreshAdminMessages(db: Db, id: string): Promise<RequestCard | null> {
  const c = await requestCard(db, id);
  if (!c) return null;
  const text = await cardText(db, c);
  const { rows } = await db.query('select admin_messages from driver_requests where id = $1', [id]);
  for (const m of (rows[0]?.admin_messages ?? []) as { chat: number; message: number }[]) {
    await botApi('editMessageText', { chat_id: m.chat, message_id: m.message, text, parse_mode: 'HTML' }).catch(() => {});
  }
  return c;
}

/** After a decision (once): the admins' messages show it, and the driver hears the answer. */
export async function afterDecision(db: Db, id: string): Promise<void> {
  const c = await refreshAdminMessages(db, id);
  if (!c) return;
  if (c.status === 'approved') {
    const map = env.appUrl ? { inline_keyboard: [[{ text: '🗺 Open the route map', web_app: { url: `${env.appUrl}/route` } }]] } : undefined;
    await botApi('sendMessage', {
      chat_id: c.telegramUserId, parse_mode: 'HTML', reply_markup: map, disable_web_page_preview: true,
      text: `✅ <b>You're approved!</b>\n\nYou now have the CFT route map: truck routes, partner stations with the CFT price, and navigation.\n\n• Here in Telegram: the <b>Route map</b> button below the chat.\n• On any phone or computer: ${env.webUrl.replace(/^https?:\/\//, '')} → <b>Log in</b>.`,
    }).catch(() => {});
    if (env.appUrl) await botApi('setChatMenuButton', { chat_id: c.telegramUserId, menu_button: { type: 'web_app', text: 'Route map', web_app: { url: `${env.appUrl}/route` } } }).catch(() => {});
    // Their commands and menu are set again on their next message (telegram_bot/cftagents/webhook.ts ensureMenu).
    await db.query('update telegram_users set menu_role = null where id = $1', [c.telegramUserId]);
    // The agent who invited them hears it (an admin's own link: the admin approved it themselves).
    const { rows: ref } = await db.query('select ref_agent from driver_requests where id = $1', [id]);
    if (ref[0]?.ref_agent != null) {
      await botApi('sendMessage', {
        chat_id: Number(ref[0].ref_agent), parse_mode: 'HTML',
        text: `✅ <b>${esc(c.name)}</b>${c.username ? ` @${esc(c.username)}` : ''}, whom you invited, was approved by ${esc(c.decidedBy ?? 'an admin')}. They now have the CFT route map. /drivers`,
      }).catch(() => {});
    }
  } else if (c.status === 'declined') {
    await botApi('sendMessage', { chat_id: c.telegramUserId, text: 'Your request for the CFT route map was not approved. If you think this is a mistake, contact the CFT agent who invited you.' }).catch(() => {});
  }
}
