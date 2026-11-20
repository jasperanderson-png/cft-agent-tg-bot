import { csvObjects, decodeText } from '../../support/common/csv.js';
import { contactKeys } from '../../support/common/leads.js';
import type { Db } from '../../database/db.js';
import { SECTION } from '../../support/helpers/home.js';
import { botApi, botDownloadFile, botSendDocument, TelegramRejected } from '../../support/helpers/telegram.js';
import { leadsCsv, leadsFilename, leadsXlsx, statsSheet } from './files.js';
import { pullEnabled, runPullSources } from './fmcsa.js';
import { createWebhookSource, getSource, ingestRecords, suppress, unsuppress } from './ingest.js';
import * as m from './messages.js';
import {
  cdlCounts, claimRecent, confirmBatch, ELIGIBLE, lastDelivery, leadStats, logExport, queryLeads, recoverStaleClaims,
  releaseBatch, stateCounts, type DriverRow, type ExportKind, type ExportView, type FileFormat, type LeadsRole,
} from './store.js';

// What Driver Leads does in a chat: send new leads once, send read-only files, statistics, and the
// owner tools (sources, FMCSA sync, opt-outs, CSV import). The wording of every message is in
// messages.ts. Which button or command asks for which action, and who may, is decided in
// telegram_bot/cftagents/handlers/admins/leads.ts.

const button = (text: string) => ({ text });
/** Two rows: the main action, then statistics, the downloads menu and Home. Everything else is in 📂 DOWNLOADS. */
export const leadsKeyboard = {
  keyboard: [[button(m.BUTTONS.recent)], [button(m.KEYS.stats), button(m.KEYS.downloads), button(SECTION.home)]],
  resize_keyboard: true,
  is_persistent: true,
};

// ---- The downloads menu: inline buttons under one message --------------------------------------------
// Callback data is "leads:<what>": dl (the menu), states / cdls (pickers), x:<kind> (a file),
// st:<state> and cdl:<class> (a file for one state or class).

const tap = (text: string, data: string) => ({ text, callback_data: 'leads:' + data });
export const downloadsMenu = () => ({
  inline_keyboard: [
    [tap(m.INLINE.today, 'x:today')],
    [tap(m.INLINE.state, 'states'), tap(m.INLINE.cdl, 'cdls')],
    [tap(m.INLINE.excel, 'x:excel'), tap(m.INLINE.csv, 'x:csv')],
    [tap(m.INLINE.full, 'x:full')],
  ],
});
function pickerMenu(items: { key: string; n: number }[], label: (key: string, n: number) => string, perRow: number, data: (key: string) => string) {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow).map((x) => tap(label(x.key, x.n), data(x.key))));
  rows.push([tap(m.INLINE.back, 'dl')]);
  return { inline_keyboard: rows };
}

/**
 * Nothing caps how many leads one click returns. Large results are split into several files, and
 * when a click runs out of time the user continues with one tap.
 */
export const limits = {
  recentPage: 5000, // leads per GET RECENT LEADS file
  xlsxPage: 10_000, // rows per Excel export file (about 1.5 MB)
  csvPage: 25_000,
  budgetMs: 25_000, // stop starting new files after this long
};
const CARDS_MAX = 10; // small deliveries are also shown as text
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
const MAX_IMPORT_ROWS = 5000;
export const CDL_CLASSES = ['A', 'B', 'C'];

// ---- Actions ------------------------------------------------------------------------------------------

export type Action =
  | { t: 'menu' | 'recent' | 'resend' | 'stats' | 'downloads' | 'pickState' | 'pickCdl' | 'sync' }
  | { t: 'export'; view: ExportView; format: FileFormat; after: number; part: number }
  | { t: 'sources' | 'optout'; args: string[] }
  | { t: 'import'; fileId: string; caption: string }
  | { t: 'say'; text: string };

export const OWNER_ONLY = new Set<Action['t']>(['sync', 'sources', 'optout', 'import']);
/** Actions that send files or import data: run once even if Telegram retries the update. */
export const RUN_ONCE = new Set<Action['t']>(['recent', 'resend', 'export', 'sync', 'import']);

export const exportOf = (kind: ExportKind, filter?: string, format: FileFormat = 'xlsx', after = 0, part = 1): Action => ({ t: 'export', view: { kind, filter }, format, after, part });

// ---- Running it ------------------------------------------------------------------------------------

export interface Ctx {
  db: Db;
  chatId: number;
  userId: number;
  role: LeadsRole;
  tz: string;
  deadline: number;
  say: (text: string, extra?: Record<string, unknown>) => Promise<void>;
}

export const withMenu = { reply_markup: leadsKeyboard };
const uploading = (c: Ctx) => botApi('sendChatAction', { chat_id: c.chatId, action: 'upload_document' }).catch(() => {});
const sendFile = (c: Ctx, filename: string, bytes: Uint8Array, caption: string, contentType?: string) =>
  botSendDocument(c.chatId, filename, bytes, caption, { contentType, replyMarkup: leadsKeyboard });

/** Does what a Driver Leads action asks for. Who may ask is checked by the caller. */
export async function runAction(c: Ctx, a: Action): Promise<void> {
  switch (a.t) {
    case 'menu':
      return c.say(m.menu(c.role), withMenu);
    case 'say':
      return c.say(a.text);
    case 'recent':
      return sendRecent(c);
    case 'resend':
      return resend(c);
    case 'export':
      return sendExport(c, a.view, a.format, a.after, a.part);
    case 'stats':
      return c.say(m.stats(await leadStats(c.db, c.tz), c.tz), withMenu);
    case 'downloads':
      return c.say(m.DOWNLOADS, { reply_markup: downloadsMenu() });
    case 'pickState':
    case 'pickCdl': {
      const p = await picker(c.db, a.t === 'pickState' ? 'states' : 'cdls');
      return c.say(p.text, p.markup ? { reply_markup: p.markup } : withMenu);
    }
    case 'sync':
      return sync(c);
    case 'sources':
      return a.args.length ? sourceCommand(c, a.args) : listSources(c);
    case 'optout':
      return optOut(c, a.args);
    case 'import':
      return importCsv(c, a.fileId, a.caption);
  }
}

/** A state or CDL picker as inline buttons, or the "nothing yet" text. */
export async function picker(db: Db, which: 'states' | 'cdls'): Promise<{ text: string; markup?: ReturnType<typeof pickerMenu> }> {
  const items = which === 'states' ? await stateCounts(db) : await cdlCounts(db);
  if (!items.length) return { text: which === 'states' ? m.NO_STATES : m.NO_LEADS };
  return which === 'states'
    ? { text: m.PICK_STATE, markup: pickerMenu(items, m.stateButton, 4, (k) => 'st:' + k) }
    : { text: m.PICK_CDL, markup: pickerMenu(items, m.cdlButton, 2, (k) => 'cdl:' + k) };
}

// ---- GET RECENT LEADS: every new lead, once ---------------------------------------------------------

async function sendRecent(c: Ctx): Promise<void> {
  await uploading(c);
  await recoverStaleClaims(c.db);
  let total = 0;
  let firstRows: DriverRow[] = [];
  for (let part = 1; ; part++) {
    const { batchId, rows } = await claimRecent(c.db, c.userId, c.chatId, limits.recentPage);
    if (!rows.length) break;
    const now = new Date();
    const filename = leadsFilename('recent', undefined, 'xlsx', part, c.tz, now);
    let confirmedByTelegram = true;
    try {
      await sendFile(c, filename, leadsXlsx(rows, { tz: c.tz, deliveringAt: now }), m.recentCaption(rows, part, c.tz, now));
    } catch (e) {
      console.error('lead delivery failed', (e as Error).message);
      if (e instanceof TelegramRejected) {
        // Nothing reached the chat, so nothing counts as delivered.
        await releaseBatch(c.db, batchId, (e as Error).message);
        return c.say(m.SEND_REFUSED);
      }
      // A timeout or a dropped connection: the file may be in the chat. It counts as sent, so the
      // leads can't go out twice, and /resend gets it for the person if it never arrived.
      confirmedByTelegram = false;
    }
    const recorded = await markDelivered(c, batchId, filename);
    if (!confirmedByTelegram) return c.say(m.SEND_UNCONFIRMED);
    if (!recorded) return c.say(m.SENT_NOT_RECORDED);
    if (!total) firstRows = rows;
    total += rows.length;
    if (rows.length < limits.recentPage) break;
    if (Date.now() > c.deadline) return c.say(m.MORE_RECENT);
  }
  if (!total) return c.say(m.NO_NEW_LEADS, withMenu);
  if (total <= CARDS_MAX) await c.say(m.leadCards(firstRows)).catch(() => {});
}

/** The file is out, so a database hiccup while recording it is retried rather than given up on. */
async function markDelivered(c: Ctx, batchId: string, filename: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await confirmBatch(c.db, batchId, c.userId, filename);
      return true;
    } catch (e) {
      console.error('recording a delivery failed, attempt', attempt, (e as Error).message);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  return false;
}

/** Sends this person's latest GET RECENT LEADS file again. The leads stay delivered; nothing is re-queued. */
async function resend(c: Ctx): Promise<void> {
  const last = await lastDelivery(c.db, c.userId);
  if (!last) return c.say(m.NOTHING_TO_RESEND, withMenu);
  await uploading(c);
  const filename = leadsFilename('recent', undefined, 'xlsx', 1, c.tz);
  await sendFile(c, filename, leadsXlsx(last.rows, { tz: c.tz }), m.resendCaption(last.rows, last.at, c.tz));
  await logExport(c.db, { kind: 'recent', filter: 'resend', format: 'xlsx', userId: c.userId, chatId: c.chatId, count: last.rows.length, filename });
}

// ---- Read-only files --------------------------------------------------------------------------------

async function sendExport(c: Ctx, view: ExportView, format: FileFormat, after: number, part: number): Promise<void> {
  await uploading(c);
  const page = format === 'csv' ? limits.csvPage : limits.xlsxPage;
  const first = part === 1 && after === 0;
  let sent = 0;
  for (;;) {
    const rows = await queryLeads(c.db, view, c.tz, after, page);
    if (!rows.length) break;
    const now = new Date();
    const filename = leadsFilename(view.kind, view.filter, format, part, c.tz, now);
    const bytes =
      format === 'csv' ? leadsCsv(rows, { tz: c.tz })
      : leadsXlsx(rows, { tz: c.tz }, view.kind === 'full' && part === 1 ? [statsSheet(await leadStats(c.db, c.tz), c.tz, now)] : []);
    await sendFile(c, filename, bytes, m.exportCaption(view, rows, part, c.tz), format === 'csv' ? 'text/csv' : undefined);
    await logExport(c.db, { kind: view.kind, filter: view.filter, format, userId: c.userId, chatId: c.chatId, count: rows.length, filename });
    sent += rows.length;
    after = rows[rows.length - 1].lead_no;
    part++;
    if (rows.length < page) break;
    if (Date.now() > c.deadline) return c.say(m.moreFiles(`/more_${view.kind}_${(view.filter ?? '0').toLowerCase()}_${format}_${after}_${part}`));
  }
  if (!sent) await c.say(first ? m.EMPTY_EXPORT[view.kind] : m.LAST_FILE, withMenu);
}

// ---- Owner tools ------------------------------------------------------------------------------------

async function sync(c: Ctx): Promise<void> {
  if (!pullEnabled()) return c.say(m.SYNC_NOT_ENABLED);
  const results = await runPullSources(c.db, 'manual', limits.budgetMs);
  await c.say(results.length ? m.syncReport(results) : m.SYNC_ALL_OFF);
}

async function listSources(c: Ctx): Promise<void> {
  const { rows } = await c.db.query(
    `select s.id, s.name, s.kind, s.record_kind, s.consent_mode, s.active, s.last_ingested_at, count(d.id) as n
       from lead_sources s left join drivers d on d.source_id = s.id group by s.id order by s.created_at, s.id`,
  );
  await c.say(m.sourceList(rows, c.tz));
}

async function sourceCommand(c: Ctx, [verb, idRaw = '', ...rest]: string[]): Promise<void> {
  const id = idRaw.toLowerCase();
  if (verb === 'add') {
    const name = rest.join(' ') || id;
    const { token } = await createWebhookSource(c.db, id, name, c.userId);
    return c.say(m.sourceCreated(id, name, token));
  }
  const source = await getSource(c.db, id);
  if (!source) return c.say(m.SOURCE_UNKNOWN);
  if (verb === 'on' || verb === 'off') {
    await c.db.query('update lead_sources set active = $2 where id = $1', [id, verb === 'on']);
    return c.say(m.sourceSwitched(source.name, verb === 'on'));
  }
  if (verb !== 'attest') return c.say(m.SOURCE_USAGE);
  if (source.consent_mode === 'public_record' || source.kind === 'form') return c.say(m.SOURCE_NO_ATTEST);
  await c.db.query(`update lead_sources set consent_mode = 'attested', notes = coalesce(notes || E'\\n', '') || $2 where id = $1`, [
    id, `Opt-in attested by Telegram user ${c.userId} on ${new Date().toISOString()}.`,
  ]);
  await c.say(m.sourceAttested(source.name));
}

async function optOut(c: Ctx, args: string[]): Promise<void> {
  if (!args.length) return c.say(m.OPTOUT_USAGE);
  const undo = args[0].toLowerCase() === 'undo';
  const keys = contactKeys(args.slice(undo ? 1 : 0).join(' '));
  if (!keys.length) return c.say(m.OPTOUT_INVALID);
  if (undo) {
    const { removed, drivers } = await unsuppress(c.db, keys, { restore: true, recordedBy: c.userId });
    return c.say(m.optOutUndone(removed, drivers));
  }
  const { drivers } = await suppress(c.db, keys, { method: 'opt_out_admin', reason: 'opt-out recorded by an owner', recordedBy: c.userId });
  await c.say(m.optedOut(drivers));
}

async function importCsv(c: Ctx, fileId: string, caption: string): Promise<void> {
  const sourceId = (caption.split(/\s+/)[0] || 'csv-import').toLowerCase();
  const source = await getSource(c.db, sourceId);
  if (!source || source.kind === 'form' || source.kind === 'api') return c.say(m.IMPORT_SOURCE);
  const records = csvObjects(decodeText(await botDownloadFile(fileId, MAX_IMPORT_BYTES)));
  if (!records.length) return c.say(m.IMPORT_EMPTY);
  if (records.length > MAX_IMPORT_ROWS) return c.say(m.importTooLong(records.length, MAX_IMPORT_ROWS));
  const summary = await ingestRecords(c.db, source, records, { trigger: 'import', deadline: c.deadline, recordedBy: c.userId });
  const { rows } = await c.db.query(`select count(*) as n from drivers d where d.delivery_status = 'pending' and ${ELIGIBLE}`);
  await c.say(m.importReport(source, summary, Object.keys(records[0]), rows[0].n), withMenu);
}
