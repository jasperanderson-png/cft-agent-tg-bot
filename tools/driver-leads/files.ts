import { toCSV } from '../../shared/csv.js';
import { DRIVER_TYPES, ENDORSEMENTS, EQUIPMENT, formatPhone, labels, leadId, US_STATES } from '../../shared/leads.js';
import { excelSerial, fmtDMY, fmtDMYHM } from '../../shared/time.js';
import { buildXlsx, type Cell, type SheetSpec, type Style } from '../../core/xlsx.js';
import { trucksOf, type DriverRow, type ExportKind, type LeadStats } from './store.js';

// The Excel and CSV files of the Driver Leads section. The texts sent with them are in messages.ts.

/** Contact details leave the database only when there is a basis to use them and they passed validation. */
export const isContactable = (r: Pick<DriverRow, 'consent_status' | 'verification_status'>) =>
  (r.consent_status === 'granted' || r.consent_status === 'public_record') && r.verification_status === 'verified';

const recordType = (r: DriverRow) => (r.record_kind === 'carrier' ? 'Carrier (owner-operator)' : 'Driver');
const contactBasis = (r: DriverRow) =>
  r.consent_status === 'granted' ? 'Opt-in consent'
  : r.consent_status === 'public_record' ? 'Public FMCSA business record'
  : r.consent_status === 'revoked' ? 'Opted out — do not contact'
  : 'No consent on file — contact withheld';

export interface FileOptions {
  tz: string;
  /** Set for a GET RECENT LEADS file: its rows are being delivered by this very file. */
  deliveringAt?: Date;
}

interface Col {
  header: string;
  width: number;
  style?: Style;
  /** Plain value (CSV, and Excel unless `cell` is given). */
  value: (r: DriverRow, o: FileOptions) => string | number | null;
  cell?: (r: DriverRow, o: FileOptions) => Cell;
}

const dateCell = (d: Date | null, tz: string): Cell => (d ? { v: Math.floor(excelSerial(d, tz)), s: 'date' } : null);
const timeCell = (d: Date, tz: string): Cell => {
  const x = excelSerial(d, tz);
  return { v: Math.round((x - Math.floor(x)) * 1440) / 1440, s: 'time' };
};
const deliveredAt = (r: DriverRow, o: FileOptions) => r.delivered_at ?? (o.deliveringAt && r.delivery_status === 'claimed' ? o.deliveringAt : null);

const COLUMNS: Col[] = [
  { header: 'Lead ID', width: 11, value: (r) => leadId(r.lead_no) },
  { header: 'Record type', width: 22, value: recordType },
  { header: 'Full name', width: 26, value: (r) => r.full_name },
  { header: 'Phone', width: 16, value: (r) => (isContactable(r) ? formatPhone(r.phone) : '') },
  { header: 'Email', width: 30, value: (r) => (isContactable(r) ? r.email ?? '' : '') },
  { header: 'Number of trucks', width: 17, style: 'int', value: trucksOf },
  { header: 'State', width: 7, style: 'center', value: (r) => r.state },
  { header: 'City', width: 18, value: (r) => r.city },
  { header: 'ZIP', width: 8, value: (r) => r.zip },
  { header: 'CDL class', width: 10, style: 'center', value: (r) => r.cdl_class },
  { header: 'Experience (years)', width: 17, style: 'dec1', value: (r) => r.years_experience },
  { header: 'Endorsements', width: 22, value: (r) => labels(r.endorsements, ENDORSEMENTS) },
  { header: 'Driver type', width: 24, value: (r) => labels(r.driver_types, DRIVER_TYPES) },
  { header: 'Equipment', width: 22, value: (r) => labels(r.equipment, EQUIPMENT) },
  { header: 'Employment preferences', width: 32, value: (r) => r.employment_preferences },
  { header: 'Availability', width: 16, value: (r) => r.availability },
  { header: 'Company', width: 28, value: (r) => r.company_name },
  { header: 'USDOT', width: 10, value: (r) => r.usdot_number },
  { header: 'Source', width: 26, value: (r) => r.source_name },
  { header: 'Source record ID', width: 18, value: (r) => r.source_record_id },
  { header: 'First added', width: 12, value: (r, o) => fmtDMY(r.first_added_at, o.tz), cell: (r, o) => dateCell(r.first_added_at, o.tz) },
  { header: 'Time', width: 8, value: (r, o) => fmtDMYHM(r.first_added_at, o.tz).slice(11), cell: (r, o) => timeCell(r.first_added_at, o.tz) },
  { header: 'Last updated', width: 13, value: (r, o) => fmtDMY(r.updated_at, o.tz), cell: (r, o) => dateCell(r.updated_at, o.tz) },
  { header: 'Verification', width: 13, value: (r) => r.verification_status[0].toUpperCase() + r.verification_status.slice(1) },
  { header: 'Contact basis', width: 30, value: contactBasis },
  {
    header: 'Delivery', width: 13,
    value: (r, o) => (deliveredAt(r, o) ? 'Delivered' : isContactable(r) ? 'New' : 'Not deliverable'),
    cell: (r, o) => (deliveredAt(r, o) ? 'Delivered' : isContactable(r) ? { v: 'New', s: 'good' } : 'Not deliverable'),
  },
  {
    header: 'Delivered on', width: 13,
    value: (r, o) => { const d = deliveredAt(r, o); return d ? fmtDMY(d, o.tz) : ''; },
    cell: (r, o) => dateCell(deliveredAt(r, o), o.tz),
  },
];

export const LEAD_HEADERS = COLUMNS.map((c) => c.header);

function driversSheet(rows: DriverRow[], o: FileOptions, name = 'Drivers'): SheetSpec {
  return {
    name,
    columns: COLUMNS.map((c) => ({ header: c.header, width: c.width, style: c.style })),
    rows: rows.map((r) => COLUMNS.map((c) => (c.cell ? c.cell(r, o) : c.value(r, o)))),
  };
}

export function leadsXlsx(rows: DriverRow[], o: FileOptions, extra: SheetSpec[] = []): Uint8Array {
  return buildXlsx([driversSheet(rows, o), ...extra], 'CFT driver leads');
}

export function leadsCsv(rows: DriverRow[], o: FileOptions): Uint8Array {
  const csv = toCSV(COLUMNS.map((c) => ({ label: c.header, get: (r: DriverRow) => c.value(r, o) })), rows);
  return new TextEncoder().encode('﻿' + csv + '\r\n'); // BOM so Excel reads UTF-8
}

/** Statistics sheet attached to the full database download. */
export function statsSheet(s: LeadStats, tz: string, now = new Date()): SheetSpec {
  const kv = (k: string, v: number): Cell[] => [{ v: k, s: 'bold' }, { v, s: 'int' }];
  const group = (title: string, items: { key: string; n: number }[], label: (k: string) => string): Cell[][] => [
    [],
    [{ v: title, s: 'bold' }],
    ...items.map((i): Cell[] => [label(i.key), { v: i.n, s: 'int' }]),
  ];
  return {
    name: 'Summary',
    table: false,
    columns: [{ header: '', width: 38 }, { header: '', width: 14 }],
    rows: [
      [{ v: 'CFT driver leads — database summary', s: 'title' }],
      [{ v: `Generated: ${fmtDMYHM(now, tz)} (${tz})`, s: 'muted' }],
      [],
      kv('Total records', s.total), kv('Added today', s.today), kv('Added this week', s.week),
      kv('New, not yet delivered', s.undelivered), kv('Delivered', s.delivered), kv('Verified', s.verified),
      kv('No consent on file', s.noConsent), kv('Opted out', s.optedOut), kv('Carrier records (public registry)', s.carriers),
      kv('Duplicates merged, not re-added', s.duplicates), kv('Records rejected as invalid', s.rejected),
      ...group('By state', s.byState, (k) => (US_STATES[k] ? `${k} — ${US_STATES[k]}` : 'Not given')),
      ...group('By CDL class', s.byCdl, (k) => (k === 'NA' ? 'Not given' : `Class ${k}`)),
      ...group('By source', s.bySource, (k) => k),
    ],
  };
}

const stamp = (now: Date, tz: string) => fmtDMYHM(now, tz).replace(/\//g, '-').replace(' ', '_').replace(':', '');

export function leadsFilename(kind: ExportKind | 'recent', filter: string | undefined, format: 'xlsx' | 'csv', part: number, tz: string, now = new Date()): string {
  const what =
    kind === 'recent' ? 'New_Leads' : kind === 'today' ? 'Todays_Leads' : kind === 'full' ? 'Full_Database'
    : kind === 'state' ? `Leads_${filter}` : kind === 'cdl' ? `Leads_CDL-${filter === 'NA' ? 'not-given' : filter}` : 'Leads';
  return `CFT_Driver_${what}_${stamp(now, tz)}${part > 1 ? `_part${part}` : ''}.${format}`;
}
