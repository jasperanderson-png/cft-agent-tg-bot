import type { Db } from '../../database/db.js';
import { normalizePersonName, normalizePhone, US_STATES } from '../../support/common/leads.js';
import { zoned, zonedToUtc } from '../../support/common/time.js';
import { env } from '../../support/helpers/env.js';
import { bearer, HttpError, secretMatches, type ApiRequest } from '../../support/helpers/http.js';
import { botApi, botSendDocument, TelegramRejected } from '../../support/helpers/telegram.js';
import { reportTimeZone } from '../../support/helpers/updates.js';
import { importFile } from './files.js';
import * as m from './messages.js';
import {
  claimForExport, claimPosts, getCollector, isFirstReport, recordReport, releaseExport, saveApplicants, setAlert, unpost, unposted,
  type Applicant, type IncomingApplicant,
} from './store.js';

// What happens when the office script reports (POST /api/indeed/report), plus the two scheduled jobs:
// the silence watch and the daily import file. The office script only reads Indeed and posts what it
// saw; deciding what is new, the cards, the alerts and the files all happen here.

export const STATUSES = ['ok', 'chrome_closed', 'logged_out', 'no_data', 'error'] as const;
export type Status = (typeof STATUSES)[number];
const MAX_APPLICANTS = 200;
/** No report for this long is announced as a problem. */
export const SILENCE_MS = 2 * 60 * 60 * 1000;

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/** Milliseconds, seconds or an ISO string; null when it isn't a plausible application time. */
function appliedAt(v: unknown, now = Date.now()): Date | null {
  let d: Date | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) d = new Date(v > 1e11 ? v : v * 1000);
  else if (typeof v === 'string' && v.trim()) d = new Date(v);
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.getTime() > Date.UTC(2005, 0, 1) && d.getTime() < now + 86_400_000 ? d : null;
}

/** "Pottsville, PA" → PA; anything else → null. */
export function stateOf(location: string | null): string | null {
  const st = location && /,\s*([A-Za-z]{2})\b/.exec(location)?.[1]?.toUpperCase();
  return st && US_STATES[st] ? st : null;
}

/** One applicant from the script, tidied. Null when it can't be used (no id or no name). */
export function parseApplicant(raw: unknown): IncomingApplicant | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = text(r.id, 120);
  const name = normalizePersonName(r.name);
  if (!id || !name) return null;
  const location = text(r.location, 120);
  const experience = Array.isArray(r.experience) ? r.experience.map((e) => text(e, 150)).filter((e): e is string => !!e).slice(0, 3) : [];
  return { id, name, phone: normalizePhone(r.phone), location, state: stateOf(location), job: text(r.job, 200), experience, appliedAt: appliedAt(r.applied_at) };
}

export interface Report {
  status: Status;
  detail: string | null;
  applicants: IncomingApplicant[];
  skipped: number;
}

export function parseReport(body: unknown): Report {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object body.');
  const b = body as Record<string, unknown>;
  const status = STATUSES.find((s) => s === b.status);
  if (!status) throw new HttpError(400, `status must be one of: ${STATUSES.join(', ')}.`);
  const list = b.applicants ?? [];
  if (!Array.isArray(list)) throw new HttpError(400, 'applicants must be a list.');
  if (list.length > MAX_APPLICANTS) throw new HttpError(413, `At most ${MAX_APPLICANTS} applicants per report.`);
  const applicants = list.map(parseApplicant).filter((a): a is IncomingApplicant => !!a);
  return { status, detail: text(b.detail, 300), applicants, skipped: list.length - applicants.length };
}

/** The office script's key. 503 while the feature isn't set up, 401 for a wrong key. */
export function requireCollector(req: ApiRequest): void {
  if (!env.indeedCollectorToken) throw new HttpError(503, 'Indeed applicants are not set up (INDEED_COLLECTOR_TOKEN is missing).');
  if (!secretMatches(bearer(req) ?? undefined, env.indeedCollectorToken)) throw new HttpError(401, 'Unauthorized.');
}

const say = (chat_id: number, text: string) => botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true });

/** botApi's own refusal ("Telegram sendMessage failed: …"): nothing was sent. Anything else: it may have arrived. */
const refused = (e: unknown) => e instanceof Error && /^Telegram \w+ failed/.test(e.message);

/** Tells the hiring chat about a new problem once, and about its end once. */
async function announce(db: Db, chat: number | null, status: Status | 'silent', detail: string | null, previous: string | null): Promise<void> {
  if (!chat) return;
  const next = status === 'ok' ? null : status;
  if (next === previous) return;
  try {
    if (next) await say(chat, m.problem(next, detail));
    else await say(chat, m.recovered);
    await setAlert(db, next);
  } catch (e) {
    console.warn('indeed: alert not sent', (e as Error).message);
  }
}

/** Posts the cards that aren't in the hiring chat yet. Stops at a refusal; those are tried again next report. */
async function postCards(db: Db, chat: number, tz: string): Promise<number> {
  const list = await unposted(db);
  const cards = list.slice(0, m.MAX_CARDS);
  const rest = list.slice(m.MAX_CARDS);
  let posted = 0;
  for (const a of cards) {
    if (!(await claimPosts(db, [a.submission_id])).length) continue; // another report is posting it
    try {
      await say(chat, m.card(a, tz));
    } catch (e) {
      if (refused(e)) {
        console.warn('indeed: card refused', (e as Error).message);
        await unpost(db, cards.slice(cards.indexOf(a)).map((x) => x.submission_id));
        return posted;
      }
      console.warn('indeed: card may not have arrived', (e as Error).message); // not repeated: it may be there
    }
    posted++;
  }
  const taken = await claimPosts(db, rest.map((a) => a.submission_id));
  if (taken.length) {
    try {
      await say(chat, m.moreApplicants(taken.length));
    } catch (e) {
      if (refused(e)) await unpost(db, taken);
    }
  }
  return posted;
}

export interface ReportResult {
  received: number;
  new: number;
  skipped: number;
  posted: number;
  first: boolean;
}

export async function handleReport(db: Db, report: Report): Promise<ReportResult> {
  const chat = env.indeedChatId;
  const tz = await reportTimeZone(db);
  const before = await getCollector(db);
  await recordReport(db, report.status, report.detail);
  await announce(db, chat, report.status, report.detail, before.alert);

  const first = report.status === 'ok' && report.applicants.length > 0 && (await isFirstReport(db));
  const saved = await saveApplicants(db, report.applicants, first);
  let posted = 0;
  if (first) {
    if (chat) await say(chat, m.connected(saved.length)).catch((e) => console.warn('indeed: connected message not sent', (e as Error).message));
  } else if (chat) {
    posted = await postCards(db, chat, tz);
  }
  return { received: report.applicants.length, new: first ? 0 : saved.length, skipped: report.skipped, posted, first };
}

/** The silence watch (every 30 minutes): the office computer stopped reporting. */
export async function watch(db: Db, now = new Date()): Promise<{ silent: boolean }> {
  const c = await getCollector(db);
  const silent = !!c.last_seen_at && now.getTime() - c.last_seen_at.getTime() > SILENCE_MS;
  if (silent) await announce(db, env.indeedChatId, 'silent', null, c.alert);
  return { silent };
}

export type Delivery = 'sent' | 'none' | 'refused' | 'unknown';

/**
 * Sends every applicant that isn't in an import file yet, as one Excel file, to `chat` (the hiring
 * chat for the daily file, an admin for 📥). Each applicant goes into one file only.
 */
export async function sendImportFile(db: Db, chat: number, kind: 'daily' | 'new', now = new Date()): Promise<{ delivery: Delivery; count: number }> {
  const tz = await reportTimeZone(db);
  const list = await claimForExport(db);
  if (!list.length) {
    await say(chat, m.NOTHING_NEW);
    return { delivery: 'none', count: 0 };
  }
  try {
    await botSendDocument(chat, m.fileName(now, tz), importFile(list, tz), m.fileCaption(list.length, kind));
    return { delivery: 'sent', count: list.length };
  } catch (e) {
    if (e instanceof TelegramRejected) {
      await releaseExport(db, list.map((a) => a.submission_id));
      await say(chat, m.SEND_FAILED).catch(() => {});
      return { delivery: 'refused', count: list.length };
    }
    console.warn('indeed: import file may not have arrived', (e as Error).message);
    await say(chat, m.SEND_UNKNOWN).catch(() => {});
    return { delivery: 'unknown', count: list.length };
  }
}

/** A read-only copy: the applicants of the last 7 days, delivered or not. */
export async function sendWeekFile(db: Db, chat: number, list: Applicant[], now = new Date()): Promise<void> {
  const tz = await reportTimeZone(db);
  if (!list.length) {
    await say(chat, m.NOTHING_THIS_WEEK);
    return;
  }
  await botSendDocument(chat, m.fileName(now, tz).replace('.xlsx', '_last_7_days.xlsx'), importFile(list, tz), m.fileCaption(list.length, 'week'));
}

/** Midnight today in the report time zone. */
export function todayStart(tz: string, now = new Date()): Date {
  const z = zoned(now, tz);
  return zonedToUtc(z.y, z.m, z.d, 0, 0, tz);
}
