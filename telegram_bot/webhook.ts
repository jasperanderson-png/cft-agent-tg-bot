import { getPool } from '../database/db.js';
import { env } from '../support/helpers/env.js';
import { HttpError, secretMatches, type ApiRequest } from '../support/helpers/http.js';
import { botApi, type PrivateCallback, type PrivateMessage, type TelegramUpdate } from '../support/helpers/telegram.js';
import { touchTelegramUser } from '../support/helpers/users.js';
import { admins } from './handlers/admins/index.js';
import { agents } from './handlers/agents/index.js';
import { candidates } from './handlers/candidates/index.js';
import { drivers } from './handlers/drivers/index.js';
import { channelMembership, groupMessage } from './handlers/channel.js';
import { inviteToken, joinWithInvite } from './handlers/invite.js';
import { liveLocation } from './handlers/live-location.js';
import { menuKey, roleOf, viewerOf, type Role, type RoleHandlers, type Viewer } from './handlers/viewer.js';
import type { Db } from '../database/db.js';

// The bot's front door. It checks that an update really comes from Telegram, works out WHO sent it
// (admin, agent, driver or candidate) and hands it to that role's folder in handlers/. Each role folder
// decides what its people can do; the work itself is done by the tools (tools/).
//
// To add a role (drivers, dispatchers…): write handlers/<role>/index.ts and add it to ROLES and to
// roleOf() in handlers/viewer.ts.

const ROLES: Record<Role, RoleHandlers> = { admins, agents, drivers, candidates };

/**
 * Makes sure Telegram shows this person their role's menu button and commands. What was set last is
 * kept in telegram_users.menu_role; when the role changed, or Telegram missed an earlier change (a
 * timeout), it is set again. Runs after the answer, so the reply is never late because of it.
 */
async function ensureMenu(db: Db, chatId: number, who: Viewer): Promise<void> {
  const role = roleOf(who);
  const key = menuKey(role);
  try {
    const { rows } = await db.query('select menu_role from telegram_users where id = $1', [chatId]);
    if (rows[0]?.menu_role === key) return;
    await ROLES[role].menu(chatId, who);
    await db.query('update telegram_users set menu_role = $2 where id = $1', [chatId, key]);
  } catch (e) {
    console.error('menu not set', chatId, key, (e as Error).message);
  }
}

/** Telegram webhook. Answers 200 for every authentic call so Telegram doesn't retry. */
export async function handleWebhook(req: ApiRequest) {
  if (!secretMatches(req.headers['x-telegram-bot-api-secret-token'], env.webhookSecret)) throw new HttpError(401, 'Bad webhook secret.');
  const update = (req.body ?? {}) as TelegramUpdate;
  const db = getPool();

  // Track whether the bot can message this person (they blocked or unblocked it).
  const mcm = update.my_chat_member;
  if (mcm?.from && mcm.chat?.type === 'private') {
    const status = mcm.new_chat_member?.status;
    await touchTelegramUser(db, mcm.from, status === 'kicked' ? { blocked: true } : { startedBot: true });
    return { ok: true };
  }
  // The bot was added to or removed from a group or channel (work reports can go to one).
  if (mcm) {
    await channelMembership(db, mcm).catch((e) => console.error('chat membership update failed', (e as Error).message));
    return { ok: true };
  }

  // A tap on an inline button.
  const cb = update.callback_query;
  if (cb) {
    if (!cb.data || !cb.message?.chat?.id || cb.message.chat.type !== 'private') return { ok: true };
    await touchTelegramUser(db, cb.from, { startedBot: true });
    try {
      const who = await viewerOf(db, cb.from, update.update_id);
      if (await ROLES[roleOf(who)].callback(db, cb as PrivateCallback, who)) return { ok: true };
    } catch (e) {
      console.error('bot callback failed', (e as Error).message);
    }
    await botApi('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
    return { ok: true };
  }

  // A message in a group: only what work reports need (handlers/channel.ts).
  if (update.message?.chat?.type === 'group' || update.message?.chat?.type === 'supergroup') {
    await groupMessage(db, update.message).catch((e) => console.error('group message failed', (e as Error).message));
    return { ok: true };
  }

  // A shared location (live location alerts on the road): handlers/live-location.ts.
  if (await liveLocation(db, update).catch((e) => { console.error('location update failed', (e as Error).message); return true; })) return { ok: true };

  // A message in a private chat.
  if (!update.message?.chat?.id || !update.message.from || update.message.chat.type !== 'private') return { ok: true };
  const msg = update.message as PrivateMessage;
  await touchTelegramUser(db, msg.from, { startedBot: true });
  try {
    const who = await viewerOf(db, msg.from, update.update_id);
    const token = inviteToken(msg.text);
    if (token) await joinWithInvite(msg, token, who);
    else {
      await ROLES[roleOf(who)].message(db, msg, who);
      await ensureMenu(db, msg.chat.id, who);
    }
  } catch (e) {
    console.error('bot update failed', (e as Error).message);
    await botApi('sendMessage', { chat_id: msg.chat.id, text: 'Sorry, something went wrong. Please try again in a moment.', parse_mode: 'HTML' }).catch(() => {});
  }
  return { ok: true };
}
