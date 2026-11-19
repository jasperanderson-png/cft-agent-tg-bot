import type { Db } from '../../database/db.js';
import { env } from '../../support/helpers/env.js';
import { HttpError } from '../../support/helpers/http.js';
import { fullName } from '../../support/helpers/telegram.js';
import type { Day } from './periods.js';
import { KINDS, type Kind } from './words.js';

// The task report's data: people, shifts, the work log and the posts already sent.
// Dates are read as text ("2026-11-14") so no time zone can shift them.

export interface Staff {
  id: number;
  name: string;
  channelId: number | null;
  channelTitle: string | null;
  statusMessageId: number | null;
}
export interface Shift {
  id: string;
  staffId: number;
  workDate: Day;
  startedAt: Date;
  endedAt: Date | null;
  endReason: 'manual' | 'auto' | null;
}
export interface Entry {
  id: string;
  workDate: Day;
  kind: Kind;
  text: string;
  detail: string | null;
  area: string | null;
  size: 's' | 'm' | 'l';
  highlight: boolean;
  source: 'claude' | 'bot';
  createdAt: Date;
}
export interface NewEntry {
  kind: Kind;
  text: string;
  detail?: string | null;
  area?: string | null;
  size?: 's' | 'm' | 'l';
  highlight?: boolean;
  externalId?: string | null;
  workDate?: Day | null;
}

const STAFF = 'telegram_user_id as id, name, channel_id as "channelId", channel_title as "channelTitle", status_message_id as "statusMessageId"';
const SHIFT = 'id, staff_id as "staffId", work_date::text as "workDate", started_at as "startedAt", ended_at as "endedAt", end_reason as "endReason"';
const ENTRY = 'id, work_date::text as "workDate", kind, text, detail, area, size, highlight, source, created_at as "createdAt"';

export const personName = (u: { first_name?: string; last_name?: string; id: number }) =>
  (fullName(u).trim() || `ID ${u.id}`).slice(0, 80);

/** The person's row, created on first use. Keeps their name up to date. */
export async function ensureStaff(db: Db, u: { id: number; first_name?: string; last_name?: string }): Promise<Staff> {
  const { rows } = await db.query(
    `insert into report_staff (telegram_user_id, name) values ($1, $2)
     on conflict (telegram_user_id) do update set name = excluded.name
     returning ${STAFF}`,
    [u.id, personName(u)],
  );
  return rows[0];
}
export async function getStaff(db: Db, id: number): Promise<Staff | null> {
  const { rows } = await db.query(`select ${STAFF} from report_staff where telegram_user_id = $1`, [id]);
  return rows[0] ?? null;
}
/** The people with work reports (TASK_REPORT_USER_IDS) who have used them. */
export async function listStaff(db: Db): Promise<Staff[]> {
  return (await db.query(`select ${STAFF} from report_staff where telegram_user_id = any($1::bigint[]) order by created_at`, [env.taskReportUserIds])).rows;
}
/** Points a person's reports at a channel (or back at their private chat with null). */
export async function setChannel(db: Db, staffId: number, channelId: number | null, title: string | null): Promise<void> {
  await db.query(
    `update report_staff set channel_id = $2, channel_title = $3,
       status_message_id = case when channel_id is distinct from $2 then null else status_message_id end
     where telegram_user_id = $1`,
    [staffId, channelId, title],
  );
}
/** The bot left a channel: nobody's reports go there any more. Returns who was affected. */
export async function forgetChannel(db: Db, channelId: number): Promise<number[]> {
  const { rows } = await db.query(
    'update report_staff set channel_id = null, channel_title = null, status_message_id = null where channel_id = $1 returning telegram_user_id as id',
    [channelId],
  );
  return rows.map((r) => Number(r.id));
}
/** A group became a supergroup and got a new id: reports follow it. */
export async function moveChannel(db: Db, fromId: number, toId: number): Promise<void> {
  await db.query('update report_staff set channel_id = $2, status_message_id = null where channel_id = $1', [fromId, toId]);
}
export async function setStatusMessage(db: Db, staffId: number, messageId: number | null): Promise<void> {
  await db.query('update report_staff set status_message_id = $2 where telegram_user_id = $1', [staffId, messageId]);
}

// ---- Shifts ----

export async function openShift(db: Db, staffId: number): Promise<Shift | null> {
  const { rows } = await db.query(`select ${SHIFT} from work_shifts where staff_id = $1 and ended_at is null`, [staffId]);
  return rows[0] ?? null;
}
/** Starts a shift unless one is open. `already` is true when it was. */
export async function insertShift(db: Db, staffId: number, workDate: Day, at: Date): Promise<{ shift: Shift; already: boolean }> {
  const { rows } = await db.query(
    `insert into work_shifts (staff_id, work_date, started_at) values ($1, $2, $3)
     on conflict (staff_id) where ended_at is null do nothing returning ${SHIFT}`,
    [staffId, workDate, at],
  );
  if (rows[0]) return { shift: rows[0], already: false };
  const open = await openShift(db, staffId);
  if (!open) throw new Error('A shift was open a moment ago and is gone now.');
  return { shift: open, already: true };
}
/** Closes the open shift. Null when none was open. */
export async function closeShift(db: Db, staffId: number, at: Date, reason: 'manual' | 'auto'): Promise<Shift | null> {
  const { rows } = await db.query(
    `update work_shifts set ended_at = greatest(started_at, $2), end_reason = $3
     where staff_id = $1 and ended_at is null returning ${SHIFT}`,
    [staffId, at, reason],
  );
  return rows[0] ?? null;
}
export async function shiftsBetween(db: Db, staffId: number, from: Day, to: Day): Promise<Shift[]> {
  const { rows } = await db.query(`select ${SHIFT} from work_shifts where staff_id = $1 and work_date between $2 and $3 order by started_at`, [staffId, from, to]);
  return rows;
}
/** Minutes worked in a shift; an open one counts until `now`. */
export const shiftMinutes = (s: Shift, now = new Date()) => Math.max(0, ((s.endedAt ?? now).getTime() - s.startedAt.getTime()) / 60_000);

// ---- The work log ----

const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Checks an entry from the API or the bot. Throws a 400 that says what is wrong. */
export function checkEntry(raw: unknown, i = 0): NewEntry {
  const e = (raw ?? {}) as Record<string, unknown>;
  const where = `Entry ${i + 1}`;
  if (!KINDS.includes(e.kind as Kind)) throw new HttpError(400, `${where}: kind must be one of ${KINDS.join(', ')}.`);
  const text = clean(e.text, 400);
  if (!text) throw new HttpError(400, `${where}: text is empty.`);
  const size = e.size ?? 'm';
  if (!['s', 'm', 'l'].includes(size as string)) throw new HttpError(400, `${where}: size must be s, m or l.`);
  const workDate = e.date ?? e.workDate ?? null;
  if (workDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(workDate))) throw new HttpError(400, `${where}: date must look like 2026-11-14.`);
  return {
    kind: e.kind as Kind, text, size: size as 's' | 'm' | 'l', highlight: e.highlight === true,
    detail: clean(e.detail, 300) || null, area: clean(e.area, 40) || null,
    externalId: clean(e.id ?? e.externalId, 100) || null, workDate: workDate as Day | null,
  };
}

/** Adds entries; ones whose externalId is already in the log are skipped. */
export async function addEntries(db: Db, staffId: number, defaultDay: Day, entries: NewEntry[], source: 'claude' | 'bot'): Promise<{ added: Entry[]; skipped: number }> {
  const added: Entry[] = [];
  let skipped = 0;
  for (const e of entries) {
    const { rows } = await db.query(
      `insert into work_entries (staff_id, work_date, kind, text, detail, area, size, highlight, source, external_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (staff_id, external_id) do nothing returning ${ENTRY}`,
      [staffId, e.workDate ?? defaultDay, e.kind, e.text, e.detail ?? null, e.area ?? null, e.size ?? 'm', e.highlight ?? false, source, e.externalId ?? null],
    );
    if (rows[0]) added.push(rows[0]);
    else skipped++;
  }
  return { added, skipped };
}
export async function entriesBetween(db: Db, staffId: number, from: Day, to: Day): Promise<Entry[]> {
  const { rows } = await db.query(`select ${ENTRY} from work_entries where staff_id = $1 and work_date between $2 and $3 order by work_date, created_at`, [staffId, from, to]);
  return rows;
}
export async function deleteEntry(db: Db, staffId: number, id: string): Promise<Entry | null> {
  const { rows } = await db.query(`delete from work_entries where staff_id = $1 and id = $2 returning ${ENTRY}`, [staffId, id]);
  return rows[0] ?? null;
}
/** When the last entry of a shift was written, to close a forgotten shift at the last sign of work. */
export async function lastActivity(db: Db, staffId: number, since: Date): Promise<Date | null> {
  const { rows } = await db.query('select max(created_at) as at from work_entries where staff_id = $1 and created_at >= $2', [staffId, since]);
  return rows[0]?.at ?? null;
}

// ---- Posts already sent ----

export type PeriodKind = 'daily' | 'weekly' | 'monthly';
export interface Post {
  chatId: number;
  messageId: number | null;
}
export async function getPost(db: Db, staffId: number, period: PeriodKind, start: Day): Promise<Post | null> {
  const { rows } = await db.query('select chat_id as "chatId", message_id as "messageId" from report_posts where staff_id = $1 and period = $2 and period_start = $3', [staffId, period, start]);
  return rows[0] ?? null;
}
/**
 * Claims the right to post a report to `chatId`. False when it was already posted there (or another
 * run is posting it right now). A post to a different chat (the channel changed) is replaced.
 */
export async function claimPost(db: Db, staffId: number, period: PeriodKind, start: Day, chatId: number): Promise<boolean> {
  const { rows } = await db.query(
    `insert into report_posts (staff_id, period, period_start, chat_id) values ($1, $2, $3, $4)
     on conflict (staff_id, period, period_start) do update set chat_id = excluded.chat_id, message_id = null, sent_at = now()
       where report_posts.chat_id <> excluded.chat_id
     returning 1`,
    [staffId, period, start, chatId],
  );
  return !!rows[0];
}
export async function savePost(db: Db, staffId: number, period: PeriodKind, start: Day, messageId: number | null): Promise<void> {
  await db.query('update report_posts set message_id = $4, sent_at = now() where staff_id = $1 and period = $2 and period_start = $3', [staffId, period, start, messageId]);
}
export async function dropPost(db: Db, staffId: number, period: PeriodKind, start: Day): Promise<void> {
  await db.query('delete from report_posts where staff_id = $1 and period = $2 and period_start = $3', [staffId, period, start]);
}
