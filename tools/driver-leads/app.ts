import type { Db } from '../../database/db.js';
import type { LeadsAppData, LeadsFile } from '../../support/common/types.js';
import { storeExport, type Admin } from '../../support/helpers/admins.js';
import { HttpError } from '../../support/helpers/http.js';
import { reportTimeZone } from '../../support/helpers/updates.js';
import { limits } from './actions.js';
import { leadsCsv, leadsFilename, leadsXlsx, statsSheet } from './files.js';
import {
  cdlCounts, claimRecent, confirmBatch, lastDelivery, leadStats, logExport, queryLeads, recoverStaleClaims, stateCounts,
  type ExportKind, type FileFormat,
} from './store.js';

// Driver Leads in the Mini App and on the website (screens/admins/Leads.tsx): the same leads and files as
// the bot's buttons (actions.ts), handed over as downloads from our server instead of chat messages, so
// they keep working when Telegram can't deliver files. Every new lead still goes out once, recorded the
// same way. A download link works for 10 minutes (support/helpers/admins.ts storeExport).

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const KINDS: ExportKind[] = ['today', 'full', 'csv', 'excel', 'state', 'cdl'];

/** Who is asking: Driver Leads records deliveries per Telegram account, like in the bot. */
function personOf(admin: Admin): number {
  if (!admin.telegramUserId) throw new HttpError(403, 'Driver Leads needs your Telegram account. Open the Hub from the bot.');
  return admin.telegramUserId;
}

/** The screen: statistics, and the states and CDL classes to download. */
export async function leadsApp(db: Db): Promise<LeadsAppData> {
  const tz = await reportTimeZone(db);
  const [s, states, cdls] = await Promise.all([leadStats(db, tz), stateCounts(db), cdlCounts(db)]);
  return {
    stats: {
      total: s.total, today: s.today, week: s.week, waiting: s.undelivered, delivered: s.delivered, verified: s.verified,
      noConsent: s.noConsent, optedOut: s.optedOut, carriers: s.carriers, duplicates: s.duplicates, rejected: s.rejected,
      bySource: s.bySource, lastImport: s.lastImport ? { ...s.lastImport, at: s.lastImport.at.toISOString() } : null,
    },
    states,
    cdls,
  };
}

/**
 * GET RECENT LEADS: the next file of new leads (up to 5,000), marked delivered as soon as it is ready.
 * `more` says another file is waiting. No new leads: no file.
 */
export async function recentFile(db: Db, admin: Admin): Promise<LeadsFile> {
  const who = personOf(admin);
  const tz = await reportTimeZone(db);
  await recoverStaleClaims(db);
  const { batchId, rows } = await claimRecent(db, who, who, limits.recentPage);
  if (!rows.length) return { file: null, count: 0, more: false };
  const now = new Date();
  const filename = leadsFilename('recent', undefined, 'xlsx', 1, tz, now);
  const file = await storeExport(admin, filename, XLSX, leadsXlsx(rows, { tz, deliveringAt: now }));
  // The link is ready: the leads count as delivered (a lost download comes back with "last file again").
  await confirmBatch(db, batchId, who, filename);
  return { file, count: rows.length, more: rows.length === limits.recentPage };
}

/** This person's latest GET RECENT LEADS file again. The leads stay delivered; nothing is re-queued. */
export async function lastFile(db: Db, admin: Admin): Promise<LeadsFile> {
  const who = personOf(admin);
  const tz = await reportTimeZone(db);
  const last = await lastDelivery(db, who);
  if (!last) return { file: null, count: 0, more: false };
  const filename = leadsFilename('recent', undefined, 'xlsx', 1, tz);
  const file = await storeExport(admin, filename, XLSX, leadsXlsx(last.rows, { tz }));
  await logExport(db, { kind: 'recent', filter: 'resend', format: 'xlsx', userId: who, chatId: who, count: last.rows.length, filename });
  return { file, count: last.rows.length, more: false };
}

/**
 * A read-only file (today, a state, a CDL class, all as Excel or CSV, the full database), one part at
 * a time: `next` is where the following part starts, null when this was the last.
 */
export async function exportFile(db: Db, admin: Admin, body: Record<string, unknown>): Promise<LeadsFile> {
  const who = personOf(admin);
  const kind = String(body.kind) as ExportKind;
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Which file?');
  const filter = typeof body.filter === 'string' && /^[A-Z]{1,2}$/.test(body.filter) ? body.filter : undefined;
  if ((kind === 'state' || kind === 'cdl') && !filter) throw new HttpError(400, kind === 'state' ? 'Which state?' : 'Which CDL class?');
  const format: FileFormat = kind === 'csv' ? 'csv' : 'xlsx';
  const after = Math.max(0, Number(body.after) || 0);
  const part = Math.max(1, Math.floor(Number(body.part) || 1));
  const tz = await reportTimeZone(db);
  const page = format === 'csv' ? limits.csvPage : limits.xlsxPage;
  const view = { kind, filter };
  const rows = await queryLeads(db, view, tz, after, page);
  if (!rows.length) return { file: null, count: 0, more: false };
  const now = new Date();
  const filename = leadsFilename(kind, filter, format, part, tz, now);
  const bytes = format === 'csv'
    ? leadsCsv(rows, { tz })
    : leadsXlsx(rows, { tz }, kind === 'full' && part === 1 ? [statsSheet(await leadStats(db, tz), tz, now)] : []);
  const file = await storeExport(admin, filename, format === 'csv' ? 'text/csv; charset=utf-8' : XLSX, bytes);
  await logExport(db, { kind, filter, format, userId: who, chatId: who, count: rows.length, filename });
  const more = rows.length === page;
  return { file, count: rows.length, more, next: more ? { after: rows[rows.length - 1].lead_no, part: part + 1 } : null };
}
