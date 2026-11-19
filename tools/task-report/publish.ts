import type { Db } from '../../database/db.js';
import { botApi, botEditPhoto, botSendPhoto } from '../../support/helpers/telegram.js';
import { reportTimeZone } from '../../support/helpers/updates.js';
import { dailyReport, isEmpty, monthlyReport, weeklyReport, type Report } from './build.js';
import { monthlyTaskList, reportCaption } from './captions.js';
import { cardRender, reportSvg } from './card.js';
import type { Day } from './periods.js';
import { claimPost, dropPost, getPost, savePost, setStatusMessage, shiftMinutes, type PeriodKind, type Shift, type Staff } from './store.js';
import { duration, esc, hm } from './words.js';

// Sending reports: to the person's channel (or, until one is connected, to their private chat).
// Each report goes out once (report_posts); a second shift on the same day replaces that day's
// picture in place instead of posting again, so the channel never gets spammed.

export interface Published {
  chatId: number;
  messageId: number | null;
  /** True when an earlier post was updated instead of a new one sent. */
  edited: boolean;
  toChannel: boolean;
}

const target = (s: Staff) => s.channelId ?? s.id;
const filename = (r: Report) => `${r.kind === 'daily' ? 'otchet' : r.kind === 'weekly' ? 'nedelya' : 'mesyac'}.png`;
const periodStart = (r: Report): Day => (r.kind === 'daily' ? r.day : r.period.start);

export async function buildReport(db: Db, staff: Staff, kind: PeriodKind, day: Day, now = new Date()): Promise<Report> {
  return kind === 'daily' ? dailyReport(db, staff, day, now) : kind === 'weekly' ? weeklyReport(db, staff, day, now) : monthlyReport(db, staff, day, now);
}

export function renderReport(r: Report, tz: string): { png: Uint8Array; caption: string } {
  return { png: cardRender.png(reportSvg(r, tz)), caption: reportCaption(r, tz) };
}

/**
 * Posts a report. Daily reports are updated in place when that day was already posted; weekly and
 * monthly reports are posted once and then left alone. Null when there was nothing to post.
 */
export async function publish(db: Db, staff: Staff, kind: PeriodKind, day: Day, now = new Date()): Promise<Published | null> {
  const tz = await reportTimeZone(db);
  const r = await buildReport(db, staff, kind, day, now);
  if (isEmpty(r)) return null;
  const chatId = target(staff);
  const start = periodStart(r);
  const toChannel = staff.channelId != null;

  const prev = await getPost(db, staff.id, kind, start);
  if (prev && prev.chatId === chatId) {
    if (kind !== 'daily' || !prev.messageId) return kind === 'daily' ? null : { chatId, messageId: prev.messageId, edited: false, toChannel };
    const { png, caption } = renderReport(r, tz);
    try {
      await botEditPhoto(chatId, prev.messageId, png, caption, filename(r));
      return { chatId, messageId: prev.messageId, edited: true, toChannel };
    } catch (e) {
      if (/not modified/i.test((e as Error).message)) return { chatId, messageId: prev.messageId, edited: true, toChannel };
      // The old post is gone (deleted by hand): post the day again.
      console.warn('[report] editing the daily post failed, posting again:', (e as Error).message);
      await dropPost(db, staff.id, kind, start);
    }
  }
  if (!(await claimPost(db, staff.id, kind, start, chatId))) return null;
  try {
    const { png, caption } = renderReport(r, tz);
    const messageId = await botSendPhoto(chatId, png, caption, { filename: filename(r) });
    await savePost(db, staff.id, kind, start, messageId);
    if (r.kind === 'monthly') {
      for (const text of monthlyTaskList(r)) await botApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_notification: true });
    }
    return { chatId, messageId, edited: false, toChannel };
  } catch (e) {
    await dropPost(db, staff.id, kind, start).catch(() => {});
    throw e;
  }
}

/** A report sent only to `chatId` (a preview), never recorded. */
export async function sendPreview(db: Db, staff: Staff, kind: PeriodKind, day: Day, chatId: number, now = new Date()): Promise<boolean> {
  const tz = await reportTimeZone(db);
  const r = await buildReport(db, staff, kind, day, now);
  const { png, caption } = renderReport(r, tz);
  await botSendPhoto(chatId, png, `👁 <i>Preview — not sent to the channel</i>\n\n${caption}`.slice(0, 1024), { filename: filename(r) });
  return !isEmpty(r);
}

// ---- The live status message in the channel ----

export function statusText(staff: Staff, open: Shift | null, last: Shift | null, tz: string): string {
  const who = `<b>${esc(staff.name)}</b>`;
  if (open) return `🟢 ${who} на смене с ${hm(open.startedAt, tz)}`;
  if (last?.endedAt) return `⚪️ ${who} не на смене\n<i>Последняя смена: ${hm(last.startedAt, tz)}–${hm(last.endedAt, tz)} (${duration(shiftMinutes(last))})</i>`;
  return `⚪️ ${who} не на смене`;
}

/**
 * Updates the channel's status message: edited silently when it exists, otherwise sent once without
 * a sound and pinned. Does nothing without a channel. Never throws: a report matters more.
 */
export async function updateStatus(db: Db, staff: Staff, open: Shift | null, last: Shift | null): Promise<void> {
  if (staff.channelId == null) return;
  try {
    const text = statusText(staff, open, last, await reportTimeZone(db));
    if (staff.statusMessageId) {
      try {
        await botApi('editMessageText', { chat_id: staff.channelId, message_id: staff.statusMessageId, text, parse_mode: 'HTML' });
        return;
      } catch (e) {
        if (/not modified/i.test((e as Error).message)) return;
        console.warn('[report] status message gone, sending a new one:', (e as Error).message);
      }
    }
    const sent = (await botApi('sendMessage', { chat_id: staff.channelId, text, parse_mode: 'HTML', disable_notification: true })) as { message_id?: number };
    if (!sent?.message_id) return;
    await setStatusMessage(db, staff.id, sent.message_id);
    staff.statusMessageId = sent.message_id;
    await botApi('pinChatMessage', { chat_id: staff.channelId, message_id: sent.message_id, disable_notification: true }).catch(() => {});
  } catch (e) {
    console.error('[report] status message failed:', (e as Error).message);
  }
}
