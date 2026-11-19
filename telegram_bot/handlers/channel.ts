import { telegramAdmin } from '../../support/helpers/admins.js';
import { hasWorkReports } from '../../support/helpers/home.js';
import type { Db } from '../../database/db.js';
import { botApi, type ChatMemberUpdate, type TelegramMessage } from '../../support/helpers/telegram.js';
import { checkChannel, connectChannel, REPORT_CHAT_TYPES } from '../../tools/task-report/channel.js';
import { ensureStaff, forgetChannel, getStaff, moveChannel } from '../../tools/task-report/store.js';
import { offerChannel } from './admins/shift.js';
import { commandOf } from './viewer.js';

// Groups and channels, where work reports can go. The bot does nothing else in them.
//  - An admin adds the bot to a group or channel: they are asked in their private chat whether their
//    reports should go there.
//  - An admin sends /reports in a group the bot is already in: reports go to that group at once.
//  - The bot leaves: reports that went there come back to the person's private chat.

export async function channelMembership(db: Db, upd: ChatMemberUpdate): Promise<void> {
  const chat = upd.chat;
  if (!REPORT_CHAT_TYPES.includes(chat?.type ?? '') || !chat?.id || !upd.from) return;
  const status = upd.new_chat_member?.status;
  if (status === 'administrator' || (status === 'member' && chat.type !== 'channel')) {
    if (!hasWorkReports(upd.from.id) || !(await telegramAdmin(db, upd.from))) return;
    if ((await getStaff(db, upd.from.id))?.channelId === chat.id) return; // already connected; only its rights changed
    await offerChannel(upd.from.id, chat.id, chat.title);
  } else if (status === 'left' || status === 'kicked') {
    for (const id of await forgetChannel(db, chat.id)) {
      await botApi('sendMessage', { chat_id: id, text: `📣 The bot is no longer in “${chat.title ?? ''}”, so your reports come here again. /reportchannel` }).catch(() => {});
    }
  }
}

/** A message in a group the bot is in. Only /reports from an admin, and group upgrades, mean anything. */
export async function groupMessage(db: Db, msg: TelegramMessage): Promise<void> {
  const chat = msg.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return;
  if (msg.migrate_to_chat_id) {
    await moveChannel(db, chat.id, msg.migrate_to_chat_id);
    return;
  }
  if (commandOf(msg.text) !== '/reports' || !msg.from) return;
  if (!hasWorkReports(msg.from.id) || !(await telegramAdmin(db, msg.from))) return; // not for anyone else; stay quiet in the group
  const check = await checkChannel(chat.id);
  if (!check.ok) {
    await botApi('sendMessage', { chat_id: msg.from.id, text: `⚠️ ${check.reason}` }).catch(() => {});
    return;
  }
  const staff = await connectChannel(db, await ensureStaff(db, msg.from), chat.id, check.title);
  await botApi('sendMessage', { chat_id: msg.from.id, text: `✅ “${staff.channelTitle}” connected: your work reports go there now. /shift` }).catch(() => {});
}
