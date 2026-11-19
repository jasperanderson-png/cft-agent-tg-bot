import type { Db } from '../../database/db.js';
import { escHtml as esc } from '../../support/common/html.js';
import { telegramAdmin } from '../../support/helpers/admins.js';
import {
  afterDecision, announceRequest, answerRequest, decide, openRequest, refreshAdminMessages, REQUEST_CALLBACK, requestCard, requestPayload, startRequest,
  type RequestRow, type Via,
} from '../../support/helpers/driver-requests.js';
import { env } from '../../support/helpers/env.js';
import { HttpError } from '../../support/helpers/http.js';
import { botApi, fullName, type PrivateCallback, type PrivateMessage } from '../../support/helpers/telegram.js';
import { firstSight } from '../../support/helpers/updates.js';
import { confirmWebLogin, LOGIN_PREFIX } from '../../support/helpers/web-login.js';
import type { Viewer } from './viewer.js';

// Driver access requests and the website's sign-in, in the chat. Anyone may open these links, so they
// are answered before the role folders (telegram_bot/webhook.ts):
//   /start req[_<code>][_w]  a driver asks for the route map: phone, company / MC number, who told them;
//                            the admins approve or decline (support/helpers/driver-requests.ts)
//   /start login_<code>      the website asks this person to confirm the sign-in (support/helpers/web-login.ts)

const LOGIN_CALLBACK = 'wlog:';
const send = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const NO_KEYBOARD = { reply_markup: { remove_keyboard: true } };
const site = () => env.webUrl.replace(/^https?:\/\//, '');

/** How many questions this request has: "who told you" is skipped when a personal link says. */
const total = (r: RequestRow) => (r.refAgent != null || r.refAdmin != null ? 2 : 3);

/** Asks the question the request is on. */
async function ask(chat: number, r: RequestRow) {
  const n = total(r);
  if (r.step === 'phone') {
    await send(chat, `🚚 <b>CFT route map: request access</b>\n\nTruck routes, partner stations with the CFT fuel price, and navigation, in Telegram and on ${esc(site())}.\n\n<b>Step 1 of ${n}:</b> tap the button below to share your phone number, so CFT can reach you.`, {
      reply_markup: { keyboard: [[{ text: '📱 Share my phone', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
    });
  } else if (r.step === 'company') {
    await send(chat, `<b>Step 2 of ${n}:</b> your company name or MC number?`, NO_KEYBOARD);
  } else if (r.step === 'source') {
    await send(chat, `<b>Step 3 of 3:</b> who told you about CFT? (an agent's name, a friend, a website…)`, NO_KEYBOARD);
  }
}

/** Starts (or continues) a request. Staff and drivers already have the map. */
export async function beginRequest(db: Db, msg: PrivateMessage, who: Viewer, code: string | null, via: Via): Promise<void> {
  const chat = msg.chat.id;
  if (who.admin || who.agent) return void (await send(chat, 'You are CFT staff and already have the route map (📍 on Find discounts, or the Hub). Send this link to a driver.'));
  if (who.driver) {
    return void (await send(chat, '✅ You already have the CFT route map.', {
      ...(env.appUrl ? { reply_markup: { inline_keyboard: [[{ text: '🗺 Open the route map', web_app: { url: `${env.appUrl}/route` } }]] } } : {}),
    }));
  }
  const r = await startRequest(db, msg.from, code, via);
  if (r.status === 'pending') return void (await send(chat, '⏳ Your request is waiting for a CFT admin. You will get a message here when it is decided.', NO_KEYBOARD));
  await ask(chat, r);
}

/** Takes the answer to the question being asked, then asks the next one or sends the request. */
async function takeAnswer(db: Db, msg: PrivateMessage, r: RequestRow): Promise<void> {
  const chat = msg.chat.id;
  const text = msg.text?.trim() ?? '';
  if (text.toLowerCase() === '/cancel') {
    await db.query('delete from driver_requests where id = $1 and status = $2', [r.id, 'asking']);
    return void (await send(chat, 'Request cancelled. Open the link again whenever you want to request access.', NO_KEYBOARD));
  }
  let answer: string | null = null;
  if (r.step === 'phone') {
    // Their own contact from the button; a typed number works too (some desktop apps have no button).
    if (msg.contact && (msg.contact.user_id == null || msg.contact.user_id === msg.from.id)) answer = msg.contact.phone_number;
    else if (/^\+?[\d\s().-]{7,20}$/.test(text) && text.replace(/\D/g, '').length >= 7) answer = text;
    if (!answer) return void (await send(chat, 'Please tap <b>📱 Share my phone</b> below, or type your phone number.'));
  } else if (text && !text.startsWith('/')) {
    answer = text;
  } else {
    return void (await ask(chat, r));
  }
  const next = await answerRequest(db, r, answer);
  if (next.status === 'asking') return void (await ask(chat, next));
  const card = await requestCard(db, next.id);
  await send(
    chat,
    next.status === 'approved'
      ? '✅ Thanks! Your access is being set up…'
      : `✅ <b>Request sent.</b>${card?.invitedBy ? ` (invited by ${esc(card.invitedBy)})` : ''}\n\nA CFT admin will look at it, and you will get a message here once it is decided.`,
    NO_KEYBOARD,
  );
  await announceRequest(db, next.id);
  if (next.status === 'approved') await afterDecision(db, next.id);
}

/**
 * Request links, answers to the request's questions, and the website's sign-in. True when handled;
 * everything else goes on to the person's role folder.
 */
export async function requestMessage(db: Db, msg: PrivateMessage, who: Viewer): Promise<boolean> {
  const text = msg.text?.trim() ?? '';
  const [first = '', payload = ''] = text.split(/\s+/);
  if (first.split('@')[0].toLowerCase() === '/start' && payload.startsWith(LOGIN_PREFIX)) {
    const code = payload.slice(LOGIN_PREFIX.length);
    await send(msg.chat.id, `🔐 <b>Log in to ${esc(site())}?</b>\n\nYou will be signed in as <b>${esc(fullName(msg.from) || 'you')}</b> on the browser that asked. If you did not just try to log in, ignore this message.`, {
      reply_markup: { inline_keyboard: [[{ text: '✅ Confirm login', callback_data: `${LOGIN_CALLBACK}${code}` }]] },
    });
    return true;
  }
  const req = requestPayload(text);
  if (req) {
    await beginRequest(db, msg, who, req.code, req.via);
    return true;
  }
  if (who.admin || who.agent || who.driver) return false;
  const open = await openRequest(db, msg.from.id);
  if (!open) return false;
  if (open.status === 'asking') {
    await takeAnswer(db, msg, open);
    return true;
  }
  // Waiting for an admin: /start says so; anything else is answered as usual (the Academy test).
  if (first.split('@')[0].toLowerCase() === '/start') {
    await send(msg.chat.id, '⏳ Your request for the CFT route map is waiting for an admin. You will get a message here when it is decided.');
    return true;
  }
  return false;
}

/** The admins' Approve / Decline, and the website's Confirm login. True when handled. */
export async function requestCallback(db: Db, cb: PrivateCallback, who: Viewer): Promise<boolean> {
  const answer = (text?: string) => botApi('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});
  const edit = (text: string) => botApi('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text, parse_mode: 'HTML' }).catch(() => {});
  if (cb.data.startsWith(LOGIN_CALLBACK)) {
    const ok = await confirmWebLogin(db, cb.from, cb.data.slice(LOGIN_CALLBACK.length));
    await answer(ok ? 'Logged in' : 'This login has expired');
    await edit(ok ? `✅ <b>Logged in.</b> Go back to ${esc(site())}: it opens by itself in a moment.` : 'This login link has expired or was already used. On the website, tap <b>Log in</b> again.');
    return true;
  }
  if (!cb.data.startsWith(REQUEST_CALLBACK)) return false;
  const [kind, id = ''] = cb.data.slice(REQUEST_CALLBACK.length).split(':');
  const admin = who.admin ? await telegramAdmin(db, cb.from) : null;
  if (!admin) {
    await answer('For CFT administrators only.');
    return true;
  }
  if (!(await firstSight(db, who.updateId))) return true;
  try {
    const d = await decide(id, admin.id, kind === 'ok');
    if (d.done) {
      await answer(kind === 'ok' ? 'Approved' : 'Declined');
      await afterDecision(db, id);
    } else {
      await answer(`Already ${d.status}${d.decidedBy ? ` by ${d.decidedBy}` : ''}`);
      await refreshAdminMessages(db, id).catch(() => {}); // brings this admin's message up to date; the driver was told once
    }
  } catch (e) {
    await answer(e instanceof HttpError ? e.message.slice(0, 190) : 'Something went wrong. Try again.');
    if (!(e instanceof HttpError)) console.error('driver request decision failed', (e as Error).message);
  }
  return true;
}
