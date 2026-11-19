/**
 * Every text the bot sends in the Driver Leads section, in one place. To change the wording of a
 * message, change it here. Telegram HTML: anything that comes from the database goes through esc().
 *
 * House style: the first line is an emoji and a bold title that says what the message is, counts
 * are bold, dates are dd/mm/yyyy, and footnotes are in italics.
 */
import { DRIVER_TYPES, EQUIPMENT, labels, leadId, US_STATES } from '../../support/common/leads.js';
import { escHtml as esc } from '../../support/common/html.js';
import { fmtDMY, fmtDMYHM } from '../../support/common/time.js';
import { env } from '../../support/helpers/env.js';
import type { SyncResult } from './fmcsa.js';
import type { IngestSummary, LeadSource } from './ingest.js';
import { trucksOf, type DriverRow, type ExportKind, type ExportView, type LeadsRole, type LeadStats } from './store.js';

export const num = (n: number) => Number(n).toLocaleString('en-US');
const count = (n: number, one: string, many = one + 's') => `${num(n)} ${Number(n) === 1 ? one : many}`;
const code = (s: string | number) => `<code>${s}</code>`;
/** Joins lines, dropping the ones a condition switched off. An empty string stays, as a blank line. */
const lines = (...l: (string | false | null | undefined)[]) => l.filter((x): x is string => typeof x === 'string').join('\n');
const cdlLabel = (k: string | undefined) => (k === 'NA' ? 'not given' : k ?? '');
const fileNote = (part: number) => (part > 1 ? ` · file ${part}` : '');

// ---- Buttons ----------------------------------------------------------------------------------------

export const BUTTONS = {
  recent: '🆕 GET RECENT LEADS',
  today: "📅 TODAY'S LEADS",
  stats: '📈 DATABASE STATISTICS',
  state: '📍 FILTER BY STATE',
  cdl: '🪪 FILTER BY CDL CLASS',
  excel: '📊 DOWNLOAD EXCEL',
  csv: '📄 DOWNLOAD CSV',
  full: '🗄 DOWNLOAD FULL DATABASE',
} as const;
/** The slim keyboard: the main action, then statistics, the downloads menu and Home. */
export const KEYS = { stats: '📈 STATISTICS', downloads: '📂 DOWNLOADS' } as const;
/** Leaves a picker of the old keyboard (still recognised for keyboards people have open). */
export const BACK = '⬅️ Back to Driver Leads';
/** The inline downloads menu under one message. */
export const INLINE = {
  today: "📅 Today's leads",
  state: '📍 By state',
  cdl: '🪪 By CDL class',
  excel: '📊 All as Excel',
  csv: '📄 All as CSV',
  full: '🗄 Full database',
  back: '⬅️ Back',
} as const;
export const stateButton = (state: string, n: number) => `${state} · ${num(n)}`;
export const cdlButton = (cdl: string, n: number) => `CDL ${cdlLabel(cdl)} · ${num(n)}`;

// ---- Menu -------------------------------------------------------------------------------------------

/** The section's help: what each button does, and the owner tools. Also the Driver Leads part of /help. */
export const menu = (role: LeadsRole) =>
  lines(
    '🚚 <b>Driver Leads</b>',
    '',
    '🆕 <b>GET RECENT LEADS</b> — new leads that were never sent before, as an Excel file. Each lead is sent once.',
    '📈 <b>STATISTICS</b> — totals by state, CDL class and source.',
    "📂 <b>DOWNLOADS</b> — today's leads, one state or CDL class, everything as Excel or CSV, or the full database.",
    '/resend — send your last new-leads file again.',
    '',
    '<i>Only GET RECENT LEADS marks leads as sent. Everything else is a read-only copy.</i>',
    ...(role === 'owner'
      ? [
          '',
          '<b>Owner tools</b>',
          '/leadsource — sources and vendor webhooks',
          '/leadsync — check the FMCSA registry now',
          '/optout — stop contacting a phone number or email',
          'Send a <b>.csv</b> file to import a list.',
          env.appUrl ? `\nDriver sign-up page: ${env.appUrl}/drivers/` : null,
        ]
      : []),
  );

export const NOT_AUTHORIZED = '🚚 Driver Leads is for CFT administrators only.';
export const OWNERS_ONLY = 'Only owners can do this.';
export const FAILED = 'Sorry, something went wrong. Please try again in a moment.';

// ---- GET RECENT LEADS -------------------------------------------------------------------------------

export const NO_NEW_LEADS = 'No new driver leads available at the moment. Check again later.';

const topStates = (rows: DriverRow[], n = 5) => {
  const m = new Map<string, number>();
  for (const r of rows) if (r.state) m.set(r.state, (m.get(r.state) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([s, c]) => `${s} ${c}`).join(' · ');
};

const leadFacts = (rows: DriverRow[]) => {
  const carriers = rows.filter((r) => r.record_kind === 'carrier').length;
  const states = topStates(rows);
  return [
    states ? `Top states: ${states}` : null,
    carriers === 1 ? '1 of them is a carrier record from the public FMCSA registry, not a driver sign-up.' : null,
    carriers > 1 ? `${num(carriers)} of them are carrier records from the public FMCSA registry, not driver sign-ups.` : null,
  ];
};

export const recentCaption = (rows: DriverRow[], part: number, tz: string, now: Date) =>
  lines(
    `🆕 <b>${count(rows.length, 'new driver lead')}</b>${fileNote(part)}`,
    ...leadFacts(rows),
    `<i>Sent ${fmtDMYHM(now, tz)} · never sent before</i>`,
  );

export const resendCaption = (rows: DriverRow[], firstSent: Date, tz: string) =>
  lines(`🔁 <b>${count(rows.length, 'driver lead')}, sent again</b>`, ...leadFacts(rows), `<i>First sent ${fmtDMYHM(firstSent, tz)} · not new leads</i>`);

export const NOTHING_TO_RESEND = 'You have no new-leads file to send again yet. Press GET RECENT LEADS first.';
export const SEND_REFUSED = '⚠️ Telegram refused the file, so these leads were <b>not</b> marked as sent. Press GET RECENT LEADS again.';
export const SEND_UNCONFIRMED =
  '⚠️ Telegram did not confirm the file. These leads are marked as sent so that nobody gets them twice.\nIf no file arrived above, send /resend to get it.';
export const SENT_NOT_RECORDED =
  '⚠️ The file above was sent, but saving that to the database failed. These leads may appear once more in the next new-leads file.';
export const MORE_RECENT = 'More new leads are waiting. Press GET RECENT LEADS again for the next file.';

/** A short card per lead, for small deliveries. Phone numbers are tap-to-call. */
export const leadCards = (rows: DriverRow[]) =>
  rows
    .map((r, i) => {
      const facts = [
        r.cdl_class ? `CDL-${r.cdl_class}` : null,
        r.years_experience != null ? `${r.years_experience} yr${r.years_experience === 1 ? '' : 's'}` : null,
        trucksOf(r) != null ? count(trucksOf(r)!, 'truck') : null,
        [r.city, r.state].filter(Boolean).join(', ') || null,
      ].filter(Boolean).join(' · ');
      const kinds = [labels(r.driver_types, DRIVER_TYPES), labels(r.equipment, EQUIPMENT)].filter(Boolean).join(' · ');
      return lines(
        `<b>${i + 1}. ${esc(r.full_name)}</b>${facts ? ' · ' + esc(facts) : ''}`,
        [r.phone ? `📞 ${r.phone}` : null, r.email ? `✉️ ${esc(r.email)}` : null].filter(Boolean).join('   ') || null,
        r.company_name ? `🏢 ${esc(r.company_name)}${r.usdot_number ? ` · USDOT ${r.usdot_number}` : ''}` : null,
        kinds ? esc(kinds) : null,
        `<i>${esc(r.source_name)} · ${leadId(r.lead_no)}</i>`,
      );
    })
    .join('\n\n');

// ---- Read-only files --------------------------------------------------------------------------------

export function exportCaption(view: ExportView, rows: DriverRow[], part: number, tz: string): string {
  const fresh = rows.filter((r) => r.delivery_status !== 'delivered').length;
  const title: Record<ExportKind, string> = {
    today: `📅 <b>Today's leads</b> · ${fmtDMY(new Date(), tz)}${fileNote(part)}\n${num(rows.length)} added today · ${num(fresh)} not sent yet`,
    full: `🗄 <b>Full database</b>${fileNote(part)} · ${count(rows.length, 'record')}\nContact details are left out where there is no consent.`,
    state: `📍 <b>${esc(US_STATES[view.filter ?? ''] ?? view.filter ?? '')}</b>${fileNote(part)} · ${count(rows.length, 'lead')}`,
    cdl: `🪪 <b>CDL class ${cdlLabel(view.filter)}</b>${fileNote(part)} · ${count(rows.length, 'lead')}`,
    excel: `📊 <b>All contactable leads</b>${fileNote(part)} · ${count(rows.length, 'record')}`,
    csv: `📄 <b>All contactable leads</b>${fileNote(part)} · ${count(rows.length, 'record')}`,
  };
  return `${title[view.kind]}\n<i>Read-only copy</i>`;
}

export const EMPTY_EXPORT: Record<ExportKind, string> = {
  today: 'No driver leads have been added today yet.',
  full: 'The driver leads database is empty.',
  csv: 'There are no contactable leads to export yet.',
  excel: 'There are no contactable leads to export yet.',
  state: 'No contactable leads in this state.',
  cdl: 'No contactable leads with this CDL class.',
};
export const LAST_FILE = 'That was the last file.';
export const moreFiles = (command: string) => `More records remain. Tap to get the next file:\n${command}`;

export const DOWNLOADS = '📂 <b>Driver leads · Downloads</b>\nChoose what to download. These are read-only copies: they never change what GET RECENT LEADS sends.';
export const PICK_STATE = '📍 <b>Leads by state</b>\nChoose a state. The number is how many contactable leads it has.';
export const PICK_CDL = '🪪 <b>Leads by CDL class</b>\nChoose a class.';
export const NO_STATES = 'No leads with a state yet.';
export const NO_LEADS = 'No leads yet.';
export const STATE_USAGE = `Use a two-letter state code, for example ${code('/state TX')}.`;
export const CDL_USAGE = `Use ${code('/cdl A')}, ${code('/cdl B')} or ${code('/cdl C')}.`;

// ---- Statistics -------------------------------------------------------------------------------------

export function stats(s: LeadStats, tz: string, now = new Date()): string {
  const list = (items: { key: string; n: number }[], label: (k: string) => string, max: number) => {
    const shown = items.slice(0, max).map((i) => `${esc(label(i.key))} ${num(i.n)}`).join(' · ');
    return items.length > max ? `${shown} · +${items.length - max} more` : shown || '—';
  };
  const held = [
    s.noConsent ? `${num(s.noConsent)} without consent` : null,
    s.optedOut ? `${num(s.optedOut)} opted out` : null,
    s.total - s.verified ? `${num(s.total - s.verified)} not verified` : null,
  ].filter(Boolean).join(' · ');
  const last = s.lastImport;
  return lines(
    `📈 <b>Driver leads · Statistics</b>`,
    fmtDMYHM(now, tz),
    '',
    `Records in the database: <b>${num(s.total)}</b>`,
    `🆕 New, not sent yet: <b>${num(s.undelivered)}</b>`,
    `✅ Sent: <b>${num(s.delivered)}</b>`,
    `➕ Added today: <b>${num(s.today)}</b> · this week: <b>${num(s.week)}</b>`,
    held ? `🚫 Not deliverable: ${held}` : null,
    s.carriers ? `🏢 Carrier records (public FMCSA registry): ${num(s.carriers)}` : null,
    '',
    `<b>By state</b>: ${list(s.byState, (k) => k, 12)}`,
    `<b>By CDL class</b>: ${list(s.byCdl, cdlLabel, 4)}`,
    `<b>By source</b>: ${list(s.bySource, (k) => k, 8)}`,
    '',
    `<i>All imports: ${count(s.duplicates, 'duplicate')} merged · ${num(s.rejected)} rejected as invalid</i>`,
    last ? `<i>Last import: ${esc(last.source)} · ${fmtDMYHM(last.at, tz)} · ${num(last.inserted)} new · ${count(last.updated, 'duplicate')}${last.status !== 'ok' ? ` (${last.status})` : ''}</i>` : null,
  );
}

// ---- Owner tools ------------------------------------------------------------------------------------

export const SYNC_NOT_ENABLED =
  '🔄 <b>Driver leads · Sync</b>\nThe FMCSA registry source is not switched on.\n\n' +
  'The sign-up page and vendor webhooks add leads the moment they arrive, so they need no sync. To also collect newly registered ' +
  `owner-operator carriers from the public FMCSA registry, set ${code('LEADS_FMCSA_ENABLED=true')} in the deployment settings.`;
export const SYNC_ALL_OFF = 'The FMCSA source is switched off. Turn it on with /leadsource.';
export const syncReport = (results: SyncResult[]) =>
  lines(
    '🔄 <b>Driver leads · Sync</b>',
    ...results.map((r) =>
      r.ok
        ? `✅ <b>${esc(r.sourceId)}</b>: ${num(r.inserted)} new · ${count(r.duplicates, 'duplicate')} · ${num(r.rejected)} rejected${r.removed ? ` · ${num(r.removed)} old removed` : ''}${r.partial ? ' · more to do, run /leadsync again' : ''}`
        : `⚠️ <b>${esc(r.sourceId)}</b>: ${esc(r.error ?? 'failed')}`,
    ),
  );

const CONSENT_MODE: Record<LeadSource['consent_mode'], string> = {
  per_record: 'consent needed per record',
  attested: 'opt-in attested by you',
  public_record: 'public registry, no opt-in',
};
export type SourceRow = Pick<LeadSource, 'id' | 'name' | 'kind' | 'record_kind' | 'consent_mode' | 'active' | 'last_ingested_at'> & { n: number };

export const sourceList = (sources: SourceRow[], tz: string) =>
  lines(
    '🗂 <b>Driver leads · Sources</b>',
    '',
    sources
      .map((s) => {
        const off = s.id === 'fmcsa-census' && !env.fmcsaEnabled ? ' · not enabled (LEADS_FMCSA_ENABLED)' : s.active ? '' : ' · OFF';
        const last = s.last_ingested_at ? ` · last ${fmtDMYHM(s.last_ingested_at, tz)}` : '';
        return `<b>${esc(s.name)}</b> (${code(s.id)})\n${s.kind} · ${s.record_kind === 'carrier' ? 'carrier records' : 'drivers'} · ${CONSENT_MODE[s.consent_mode]} · ${count(s.n, 'record')}${last}${off}`;
      })
      .join('\n\n'),
    '',
    `${code('/leadsource add vendor-id Vendor name')} — new vendor webhook`,
    `${code('/leadsource attest vendor-id')} — every record from it is opt-in (per your contract)`,
    `${code('/leadsource off vendor-id')} · ${code('/leadsource on vendor-id')}`,
  );

export const sourceCreated = (id: string, name: string, token: string) => {
  const url = `${env.appUrl || 'https://<your-app>'}/api/leads/ingest/${id}`;
  return lines(
    `✅ Source <b>${esc(name)}</b> created.`,
    '',
    'Give the vendor this endpoint and token. The token is shown only once.',
    '',
    `POST ${code(esc(url))}`,
    `Header: ${code(`Authorization: Bearer ${token}`)}`,
    `or: ${code(`${esc(url)}?token=${token}`)}`,
    '',
    `Body: JSON (one lead, a list, or {"leads": [...]}) or a form post. A lead is deliverable only with ${code('"consent": true')}, unless you run ${code(`/leadsource attest ${id}`)}.`,
  );
};
export const SOURCE_UNKNOWN = 'No source with this id. Send /leadsource to see the list.';
export const SOURCE_USAGE = 'Use add, attest, on or off.';
export const SOURCE_NO_ATTEST = 'This source can’t be attested.';
export const sourceAttested = (name: string) =>
  `Recorded: every record from <b>${esc(name)}</b> is treated as opt-in from now on, on your word that the provider collected consent to be contacted by you. Records already stored are not changed.`;
export const sourceSwitched = (name: string, on: boolean) => `<b>${esc(name)}</b> is now ${on ? 'on' : 'off'}.`;

// The sample number passes the bot's own phone validation (a 555 exchange outside the reserved 0100–0199 block).
export const OPTOUT_USAGE = lines(
  '🚫 <b>Driver leads · Do not contact</b>',
  `${code('/optout (214) 555-7890')} or ${code('/optout name@mail.com')} — never deliver this contact again`,
  `${code('/optout undo (214) 555-7890')} — take an opt-out back`,
);
export const OPTOUT_INVALID = 'That is not a valid US phone number or email address.';
export const optedOut = (drivers: number) =>
  `🚫 Recorded. ${drivers ? `${count(drivers, 'record is', 'records are')} now marked “do not contact”` : 'No record has this contact yet'}, and it will never be delivered, even if a provider sends it again.`;
export const optOutUndone = (removed: number, drivers: number) =>
  removed
    ? `↩️ Opt-out removed. ${drivers ? `${count(drivers, 'record has', 'records have')} the consent status from before the opt-out again.` : 'No stored record was affected.'}`
    : 'This contact is not on the do-not-contact list.';

export const IMPORT_SOURCE = `Put a source id in the file’s caption (for example ${code('csv-import')}), or leave the caption empty. Send /leadsource to see the list.`;
export const IMPORT_EMPTY = 'The file has no rows. The first row must be column names (for example: name, phone, email, state, cdl_class, experience, consent).';
export const importTooLong = (rows: number, max: number) => `The file has ${num(rows)} rows. Send at most ${num(max)} rows per file.`;
export const importReport = (source: LeadSource, s: IngestSummary, columns: string[], ready: number) => {
  const reasons = [...new Set(s.errors.map((e) => e.reason))].slice(0, 4).join('; ');
  return lines(
    `📥 <b>Driver leads · Import into ${esc(source.name)}</b>`,
    `${count(s.received, 'row')} · <b>${num(s.inserted)} new</b> · ${count(s.updated, 'duplicate')} merged · ${num(s.rejected)} rejected${s.optedOut ? ` · ${count(s.optedOut, 'opt-out')}` : ''}`,
    s.rejected && reasons ? `Rejected because: ${esc(reasons)}` : null,
    // Nothing usable usually means the columns were not recognised.
    s.rejected === s.processed ? `Columns found: ${esc(columns.slice(0, 12).join(', '))}. A row needs a name and a phone number or email.` : null,
    s.partial ? `⚠️ Time ran out after ${num(s.processed)} rows. Send the remaining rows as a new file.` : null,
    source.consent_mode === 'per_record' ? 'Only rows with a <b>consent</b> column set to yes can be delivered.' : null,
    `Ready for GET RECENT LEADS: <b>${num(ready)}</b>`,
  );
};
