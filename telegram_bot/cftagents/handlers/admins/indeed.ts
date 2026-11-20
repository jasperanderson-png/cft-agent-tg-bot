import type { Db } from '../../../../database/db.js';
import { env } from '../../../../support/helpers/env.js';
import { SECTION } from '../../../../support/helpers/home.js';
import { botApi, type PrivateCallback, type PrivateMessage } from '../../../../support/helpers/telegram.js';
import { firstSight, reportTimeZone } from '../../../../support/helpers/updates.js';
import * as m from '../../../../tools/indeed-applicants/messages.js';
import { sendImportFile, sendWeekFile, todayStart } from '../../../../tools/indeed-applicants/report.js';
import { indeedStats, receivedSince } from '../../../../tools/indeed-applicants/store.js';

// 📋 Indeed Applicants and /indeed, for admins: the office computer's status, today's count, and two
// inline buttons: 📥 the applicants not in an import file yet (marks them sent) and 🗂 a copy of the
// last 7 days. Everyone else is refused in ../not-allowed.ts.

export const INDEED_COMMAND = { command: 'indeed', description: 'Indeed: new applicants and the import file' };
export const INDEED_CALLBACK = 'indeed:';

/** Button text as typed or tapped: no emoji, punctuation or case. */
const canon = (s: string) => s.replace(/[^A-Za-z ]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();

export function isIndeedRequest(msg: PrivateMessage): boolean {
  const t = msg.text?.trim();
  if (!t) return false;
  if (t.startsWith('/')) return t.split(/\s+/)[0].split('@')[0].toLowerCase() === '/' + INDEED_COMMAND.command;
  return canon(t) === canon(SECTION.indeed);
}

async function showSection(db: Db, chat_id: number): Promise<void> {
  if (!env.indeedCollectorToken) {
    await botApi('sendMessage', { chat_id, text: m.NOT_SET_UP, parse_mode: 'HTML' });
    return;
  }
  const tz = await reportTimeZone(db);
  const s = await indeedStats(db, todayStart(tz));
  await botApi('sendMessage', {
    chat_id,
    text: m.sectionText(s, tz),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: m.BUTTONS.new(s.waiting), callback_data: `${INDEED_CALLBACK}new` }], [{ text: m.BUTTONS.week, callback_data: `${INDEED_CALLBACK}week` }]] },
  });
}

export async function indeedMessage(db: Db, msg: PrivateMessage): Promise<boolean> {
  if (!isIndeedRequest(msg)) return false;
  await showSection(db, msg.chat.id);
  return true;
}

export async function indeedCallback(db: Db, cb: PrivateCallback, updateId: number | undefined): Promise<boolean> {
  if (!cb.data.startsWith(INDEED_CALLBACK)) return false;
  await botApi('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  if (!(await firstSight(db, updateId))) return true; // Telegram retried the same tap
  const chat = cb.message.chat.id;
  const what = cb.data.slice(INDEED_CALLBACK.length);
  if (what === 'new') await sendImportFile(db, chat, 'new');
  else if (what === 'week') await sendWeekFile(db, chat, await receivedSince(db, new Date(Date.now() - 7 * 86_400_000)));
  return true;
}
