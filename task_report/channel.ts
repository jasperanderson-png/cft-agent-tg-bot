import type { Db } from '../db_storage/db.js';
import { env } from '../core/env.js';
import { botApi } from '../core/telegram.js';
import { reportTimeZone } from '../core/updates.js';
import { dayOf } from './periods.js';
import { updateStatus } from './publish.js';
import { lastShiftOn } from './shifts.js';
import { getStaff, openShift, setChannel, type Staff } from './store.js';

// Connecting the chat reports go to: a group or a channel. The bot can't join by an invite link: an
// admin adds it, then confirms in their private chat or sends /reports in the group (see
// telegram_bot/handlers/channel.ts and admins/shift.ts).

export type ChannelCheck = { ok: true; title: string } | { ok: false; reason: string };

export const REPORT_CHAT_TYPES = ['channel', 'group', 'supergroup'];

/** Whether the bot can post in a group or channel. */
export async function checkChannel(chatId: number): Promise<ChannelCheck> {
  try {
    const chat = (await botApi('getChat', { chat_id: chatId })) as { title?: string; type?: string };
    if (!REPORT_CHAT_TYPES.includes(chat.type ?? '')) return { ok: false, reason: 'Reports can go to a group or a channel only.' };
    const botId = Number(env.botToken.split(':')[0]);
    const me = (await botApi('getChatMember', { chat_id: chatId, user_id: botId })) as { status?: string; can_post_messages?: boolean; can_send_messages?: boolean };
    if (chat.type === 'channel') {
      if (me.status !== 'administrator') return { ok: false, reason: 'The bot is not an administrator of this channel. Add it as an admin first.' };
      if (me.can_post_messages === false) return { ok: false, reason: 'The bot has no "Post messages" right in this channel.' };
    } else {
      if (!['member', 'administrator', 'restricted'].includes(me.status ?? '')) return { ok: false, reason: 'The bot is not in this group. Add it first.' };
      if (me.status === 'restricted' && me.can_send_messages === false) return { ok: false, reason: 'The bot may not send messages in this group.' };
    }
    return { ok: true, title: chat.title ?? 'чат' };
  } catch (e) {
    return { ok: false, reason: `Telegram refused access to the channel (${(e as Error).message.replace(/^Telegram \w+ failed: /, '')}).` };
  }
}

/** Points the person's reports at the channel and puts the status message there. */
export async function connectChannel(db: Db, staff: Staff, chatId: number, title: string): Promise<Staff> {
  await setChannel(db, staff.id, chatId, title.slice(0, 120));
  const fresh = (await getStaff(db, staff.id))!;
  const open = await openShift(db, staff.id);
  await updateStatus(db, fresh, open, open ? null : await lastShiftOn(db, staff.id, dayOf(new Date(), await reportTimeZone(db))));
  return (await getStaff(db, staff.id))!;
}
