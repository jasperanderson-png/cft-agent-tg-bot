import type { Db } from '../../../database/db.js';
import { SECTION } from '../../../support/helpers/home.js';
import { HttpError, UUID_RE } from '../../../support/helpers/http.js';
import { botApi, type PrivateCallback, type PrivateMessage } from '../../../support/helpers/telegram.js';
import { firstSight, reportTimeZone } from '../../../support/helpers/updates.js';
import { checkChannel, connectChannel } from '../../../tools/task-report/channel.js';
import { dayOf } from '../../../tools/task-report/periods.js';
import { publish, sendPreview } from '../../../tools/task-report/publish.js';
import { beginShift, currentDay, endShift } from '../../../tools/task-report/shifts.js';
import {
  addEntries, checkEntry, deleteEntry, ensureStaff, entriesBetween, getPost, getStaff, openShift, setChannel, shiftMinutes, type Entry, type PeriodKind,
} from '../../../tools/task-report/store.js';
import { cut, durationEn, esc, hm, KIND, KINDS, type Kind } from '../../../tools/task-report/words.js';
import { commandOf } from '../viewer.js';

// ⏱ Shift, for admins: start and end a shift (ending it posts the day's report), add work-log
// entries, see and delete today's entries, preview reports, and connect the chat reports go to
// (a group or a channel).
// The work itself is in tools/task-report/. The bot speaks English; only the reports are in Russian.

export const SHIFT_CALLBACK = 'rep:';
export const SHIFT_COMMANDS = [
  { command: 'shift', description: 'Reports: start / end your shift' },
  { command: 'done', description: 'Reports: log what you did (/done text)' },
  { command: 'worklog', description: "Reports: today's log entries" },
  { command: 'preview', description: 'Reports: preview a report (add: week, month)' },
];
export const SHIFT_HELP = [
  '⏱ <b>Shift and work reports</b>',
  '/shift — start or end your shift (or /startshift, /endshift)',
  '/done text — what you did · /better — what got better · /learned — what you learned · /plan — plan for tomorrow · /blocker — what is in the way',
  'Add an #Area, for example: /done New price search #Топливо',
  "/worklog — today's entries (you can delete them)",
  '/preview · /preview week · /preview month — see a report without sending it',
  '/reportchannel — the group or channel reports go to',
  'The daily report goes to the reports chat when you end your shift, the weekly one on Saturday evening, the monthly one on the last day of the month. Reports are in Russian.',
].join('\n');

const COMMAND_KIND: Record<string, Kind> = Object.fromEntries(KINDS.map((k) => ['/' + KIND[k].command, k]));
const send = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const edit = (cb: PrivateCallback, text: string, extra: Record<string, unknown> = {}) =>
  botApi('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }).catch(() => {});
const btn = (text: string, data: string) => ({ text, callback_data: SHIFT_CALLBACK + data });
type Who = { id: number; first_name?: string; last_name?: string };

// ---- The panel ----

async function panel(db: Db, who: Who): Promise<{ text: string; reply_markup: unknown }> {
  const tz = await reportTimeZone(db);
  const staff = await getStaff(db, who.id);
  const open = staff ? await openShift(db, staff.id) : null;
  const day = staff ? await currentDay(db, staff.id) : dayOf(new Date(), tz);
  const entries = staff ? await entriesBetween(db, staff.id, day, day) : [];
  const n = (k: Kind) => entries.filter((e) => e.kind === k).length;
  const extra = (['learned', 'blocker'] as Kind[]).filter((k) => n(k)).map((k) => ` · ${KIND[k].icon} ${n(k)}`).join('');
  const lines = [
    '⏱ <b>Shift</b>',
    open ? `🟢 On shift since <b>${hm(open.startedAt, tz)}</b> · ${durationEn(shiftMinutes(open))}` : '⚪️ Not on shift',
    `📝 Today: ✅ ${n('done')} done · 📈 ${n('improved')} better · 🔜 ${n('plan')} planned${extra}`,
    staff?.channelTitle ? `📣 Reports go to “${esc(staff.channelTitle)}”` : '📣 No reports chat connected — reports come here. /reportchannel',
    '',
    '<i>Log work: /done text · /better · /learned · /plan · /blocker</i>',
  ];
  const keyboard = [
    [open ? btn('⏹ End shift', 'end') : btn('▶️ Start shift', 'start')],
    [btn("👁 Today's report", 'pv:daily'), btn('📋 Log', 'log')],
    [btn('🔄 Refresh', 'panel')],
  ];
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: keyboard } };
}

async function showPanel(db: Db, chatId: number, who: Who) {
  const p = await panel(db, who);
  await send(chatId, p.text, { reply_markup: p.reply_markup });
}

// ---- Entries ----

/** "Новый поиск #Топливо" → text and area. */
function parseEntryText(raw: string): { text: string; area: string | null } {
  let area: string | null = null;
  const text = raw.replace(/(^|\s)#([\p{L}\d_-]{2,30})/gu, (_m, sp: string, tag: string) => {
    area ??= tag.charAt(0).toUpperCase() + tag.slice(1).replace(/_/g, ' ');
    return sp;
  }).replace(/\s+/g, ' ').trim();
  return { text, area };
}

/** Most entries one message may add (one per line). */
const MAX_LINES = 20;

/**
 * One entry per line: "/done" followed by four lines adds four tasks. List marks ("-", "•", "1.")
 * are dropped. A line that is only "#Area" tags every line without an area of its own.
 */
export function parseEntryLines(raw: string): { text: string; area: string | null }[] {
  const lines = raw.split(/\r?\n/).map((l) => parseEntryText(l.replace(/^\s*(?:[-–—•*·▪️✅]+|\d{1,2}[.)])\s*/u, '')));
  const shared = lines.find((l) => !l.text && l.area)?.area ?? null;
  return lines.filter((l) => l.text).map((l) => ({ text: l.text, area: l.area ?? shared }));
}

async function addFromChat(db: Db, msg: PrivateMessage, kind: Kind, raw: string) {
  const chat = msg.chat.id;
  const lines = parseEntryLines(raw);
  if (!lines.length) {
    await send(chat, `Write ${KIND[kind].ask} after the command, for example:\n<code>/${KIND[kind].command} Подключил отчёты к каналу #Отчёты</code>\nSeveral at once: one per line.\n<i>Write entries in Russian: they go into the reports as they are.</i>`);
    return;
  }
  if (lines.length > MAX_LINES) {
    await send(chat, `That is ${lines.length} lines. Send at most ${MAX_LINES} entries in one message.`);
    return;
  }
  const staff = await ensureStaff(db, msg.from);
  const { added } = await addEntries(db, staff.id, await currentDay(db, staff.id), lines.map((l) => checkEntry({ kind, text: l.text, area: l.area })), 'bot');
  const tagOf = (e: Entry) => (e.area ? ` <i>#${esc(e.area)}</i>` : '');
  if (added.length === 1) {
    const e = added[0];
    await send(chat, `${KIND[kind].icon} Logged under “${KIND[kind].en}”: ${esc(cut(e.text, 200))}${tagOf(e)}`, {
      reply_markup: { inline_keyboard: [[btn('🗑 Delete', 'rm:' + e.id), btn('📋 All entries', 'log')]] },
    });
    return;
  }
  const del = added.map((e, i) => btn(`🗑 ${i + 1}`, 'rm:' + e.id));
  const rows = [];
  for (let i = 0; i < del.length; i += 5) rows.push(del.slice(i, i + 5));
  rows.push([btn('📋 All entries', 'log')]);
  await send(chat, [`${KIND[kind].icon} Logged ${added.length} entries under “${KIND[kind].en}”:`, ...added.map((e, i) => `${i + 1}. ${esc(cut(e.text, 160))}${tagOf(e)}`)].join('\n'), {
    reply_markup: { inline_keyboard: rows },
  });
}

async function logView(db: Db, who: Who): Promise<{ text: string; reply_markup?: unknown }> {
  const staff = await getStaff(db, who.id);
  if (!staff) return { text: '📋 No entries yet. Start your shift: /shift' };
  const day = await currentDay(db, staff.id);
  const entries = await entriesBetween(db, staff.id, day, day);
  if (!entries.length) return { text: `📋 <b>Log for ${day.slice(8)}/${day.slice(5, 7)}</b>\n\nNothing yet. Add: /done text` };
  const lines = [`📋 <b>Log for ${day.slice(8)}/${day.slice(5, 7)}</b> · ${entries.length}`];
  const numbered: Entry[] = [];
  for (const k of KINDS) {
    const list = entries.filter((e) => e.kind === k);
    if (!list.length) continue;
    lines.push('', `${KIND[k].icon} <b>${KIND[k].en}</b>`);
    for (const e of list) {
      numbered.push(e);
      lines.push(`${numbered.length}. ${esc(cut(e.text, 160))}${e.area ? ` <i>#${esc(e.area)}</i>` : ''}${e.source === 'claude' ? ' 🤖' : ''}`);
    }
  }
  lines.push('', '<i>🤖 = logged by Claude. Tap 🗑 with a number to delete that entry.</i>');
  const del = numbered.slice(0, 16).map((e, i) => btn(`🗑 ${i + 1}`, 'rm:' + e.id));
  const rows = [];
  for (let i = 0; i < del.length; i += 4) rows.push(del.slice(i, i + 4));
  rows.push([btn('🔄 Update posted report', 'pub'), btn('⏱ Shift', 'panel')]);
  return { text: lines.join('\n').slice(0, 4000), reply_markup: { inline_keyboard: rows } };
}

// ---- Ending a shift ----

async function askEnd(db: Db, chatId: number, who: Who, cb?: PrivateCallback) {
  const staff = await getStaff(db, who.id);
  const open = staff ? await openShift(db, staff.id) : null;
  if (!staff || !open) {
    const text = '⚪️ No shift is open. Start one: /startshift';
    if (cb) await edit(cb, text);
    else await send(chatId, text);
    return;
  }
  const where = staff.channelTitle ? `to “${esc(staff.channelTitle)}”` : 'here (no reports chat connected)';
  const text = `⏹ End your shift (${durationEn(shiftMinutes(open))}) and send the day's report ${where}?`;
  await send(chatId, text, { reply_markup: { inline_keyboard: [[btn('✅ End and send', 'endy'), btn('Cancel', 'endn')]] } });
}

async function finish(db: Db, who: Who): Promise<string> {
  const staff = await getStaff(db, who.id);
  if (!staff) return '⚪️ No shift is open.';
  const r = await endShift(db, staff);
  if (!r) return '⚪️ The shift was already ended.';
  const tz = await reportTimeZone(db);
  const head = `⏹ Shift ended: ${hm(r.shift.startedAt, tz)}–${hm(r.shift.endedAt!, tz)} (${durationEn(shiftMinutes(r.shift))}).`;
  if (r.reportError) return `${head}\n⚠️ The report could not be sent: ${esc(cut(r.reportError, 200))}\nThe bot tries again this evening.`;
  if (!r.report) return `${head}\nThe day's report was already sent.`;
  const where = r.report.toChannel ? `in “${esc(staff.channelTitle ?? '')}”` : 'above (no reports chat connected)';
  return `${head}\n📤 The day's report was ${r.report.edited ? 'updated' : 'sent'} ${where}.`;
}

// ---- The reports chat: a group or a channel ----

/** Asks the person whether reports should go to a group or channel the bot was added to. */
export async function offerChannel(userId: number, channelId: number, title: string | undefined) {
  await send(userId, `📣 The bot was added to “${esc(title ?? 'a chat')}”.\nSend your work reports (daily, weekly, monthly) there?`, {
    reply_markup: { inline_keyboard: [[btn('✅ Yes, send them there', `ch:${channelId}`), btn('No', 'chn')]] },
  });
}

async function channelInfo(db: Db, chatId: number, who: Who) {
  const staff = await getStaff(db, who.id);
  const how = 'To connect a group: add @cft_Agentbot to it (as an admin, so it can pin its status message), then send <code>/reports@cft_Agentbot</code> in that group. For a channel: Channel → Settings → Administrators → Add Admin → @cft_Agentbot (post, edit and pin messages); the bot then asks here, or forward any channel post to this chat.';
  if (staff?.channelId) {
    await send(chatId, `📣 Reports go to “${esc(staff.channelTitle ?? '')}”.\n\n${how}`, { reply_markup: { inline_keyboard: [[btn('Disconnect', 'choff')]] } });
  } else await send(chatId, `📣 No reports chat connected: reports come here.\n\n${how}`);
}

// ---- Messages and taps ----

export async function shiftMessage(db: Db, msg: PrivateMessage): Promise<boolean> {
  const chat = msg.chat.id;
  const origin = msg.forward_origin;
  if ((origin?.type === 'channel' || origin?.type === 'chat') && origin.chat?.id) {
    const staff = await getStaff(db, msg.from.id);
    if (staff?.channelId === origin.chat.id) await send(chat, `📣 Already connected: reports go to “${esc(staff.channelTitle ?? '')}”.`);
    else await offerChannel(chat, origin.chat.id, origin.chat.title);
    return true;
  }
  const text = msg.text?.trim() ?? '';
  const cmd = text === SECTION.shift ? '/shift' : commandOf(text);
  const rest = text.replace(/^\S+[^\S\n]*/, '');
  if (COMMAND_KIND[cmd]) {
    await addFromChat(db, msg, COMMAND_KIND[cmd], rest);
    return true;
  }
  switch (cmd) {
    case '/shift':
      await showPanel(db, chat, msg.from);
      return true;
    case '/startshift': {
      const { shift, already } = await beginShift(db, msg.from);
      const tz = await reportTimeZone(db);
      await send(chat, already ? `🟢 Your shift has been running since ${hm(shift.startedAt, tz)}.` : `▶️ Shift started at ${hm(shift.startedAt, tz)}. Have a good one!`);
      return true;
    }
    case '/endshift':
      await askEnd(db, chat, msg.from);
      return true;
    case '/worklog': {
      const v = await logView(db, msg.from);
      await send(chat, v.text, v.reply_markup ? { reply_markup: v.reply_markup } : {});
      return true;
    }
    case '/preview': {
      const kind: PeriodKind = /^week/i.test(rest) ? 'weekly' : /^month/i.test(rest) ? 'monthly' : 'daily';
      await preview(db, chat, msg.from, kind);
      return true;
    }
    case '/reportchannel':
      await channelInfo(db, chat, msg.from);
      return true;
    default:
      return false;
  }
}

async function preview(db: Db, chatId: number, who: Who, kind: PeriodKind) {
  const staff = await getStaff(db, who.id);
  if (!staff) {
    await send(chatId, 'No report yet: start a shift (/shift) or log something (/done text).');
    return;
  }
  await botApi('sendChatAction', { chat_id: chatId, action: 'upload_photo' }).catch(() => {});
  await sendPreview(db, staff, kind, await currentDay(db, staff.id), chatId);
}

export async function shiftCallback(db: Db, cb: PrivateCallback, updateId: number | undefined): Promise<boolean> {
  if (!cb.data.startsWith(SHIFT_CALLBACK)) return false;
  const answer = (text?: string) => botApi('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});
  const [kind, arg = ''] = cb.data.slice(SHIFT_CALLBACK.length).split(':');
  const chat = cb.message.chat.id;
  // Taps that change something or send pictures run once, even if Telegram retries.
  if (['start', 'endy', 'rm', 'ch', 'choff', 'pv', 'pub'].includes(kind) && !(await firstSight(db, updateId))) return true;
  try {
    if (kind === 'panel') {
      const p = await panel(db, cb.from);
      await answer();
      await edit(cb, p.text, { reply_markup: p.reply_markup });
    } else if (kind === 'start') {
      const { shift, already } = await beginShift(db, cb.from);
      await answer(already ? 'Your shift is already running' : `Shift started at ${hm(shift.startedAt, await reportTimeZone(db))}`);
      const p = await panel(db, cb.from);
      await edit(cb, p.text, { reply_markup: p.reply_markup });
    } else if (kind === 'end') {
      await answer();
      await askEnd(db, chat, cb.from, undefined);
    } else if (kind === 'endy') {
      await answer('Ending your shift…');
      await edit(cb, '⏳ Ending your shift and preparing the report…');
      await edit(cb, await finish(db, cb.from));
    } else if (kind === 'endn') {
      await answer();
      await edit(cb, 'Your shift goes on.');
    } else if (kind === 'log') {
      await answer();
      const v = await logView(db, cb.from);
      await send(chat, v.text, v.reply_markup ? { reply_markup: v.reply_markup } : {});
    } else if (kind === 'rm' && UUID_RE.test(arg)) {
      const removed = await deleteEntry(db, cb.from.id, arg);
      await answer(removed ? 'Entry deleted' : 'This entry is already gone');
      if (removed && cb.message) {
        const v = await logView(db, cb.from);
        if (v.reply_markup) await edit(cb, v.text, { reply_markup: v.reply_markup });
        else await edit(cb, `🗑 Deleted: ${esc(cut(removed.text, 200))}`);
      }
    } else if (kind === 'pub') {
      // After fixing entries: redraw today's report where it was posted (edited in place, no new post).
      const staff = await getStaff(db, cb.from.id);
      const day = staff ? await currentDay(db, staff.id) : null;
      if (!staff || !day || !(await getPost(db, staff.id, 'daily', day))) {
        await answer("Today's report isn't posted yet: it goes out when you end your shift.");
      } else {
        await answer('Updating…');
        const r = await publish(db, staff, 'daily', day);
        await send(chat, r ? "🔄 Today's report was updated where it was posted." : 'Nothing to update.');
      }
    } else if (kind === 'pv' && ['daily', 'weekly', 'monthly'].includes(arg)) {
      await answer('Preparing the report…');
      await preview(db, chat, cb.from, arg as PeriodKind);
    } else if (kind === 'ch' && /^-?\d+$/.test(arg)) {
      const check = await checkChannel(Number(arg));
      if (!check.ok) {
        await answer('That did not work');
        await send(chat, `⚠️ ${esc(check.reason)}`);
        return true;
      }
      const staff = await connectChannel(db, await ensureStaff(db, cb.from), Number(arg), check.title);
      await answer('Connected');
      await edit(cb, `✅ “${esc(staff.channelTitle ?? check.title)}” connected. Work reports go there, with a shift status message (pinned when the bot may pin).`);
    } else if (kind === 'chn') {
      await answer();
      await edit(cb, 'OK, reports are not sent there.');
    } else if (kind === 'choff') {
      await setChannel(db, cb.from.id, null, null);
      await answer('Disconnected');
      await edit(cb, '📣 Disconnected. Reports come here again.');
    } else await answer();
  } catch (e) {
    await answer(e instanceof HttpError ? e.message.slice(0, 190) : 'Something went wrong. Try again.');
    console.error('shift action failed', kind, (e as Error).message);
  }
  return true;
}
