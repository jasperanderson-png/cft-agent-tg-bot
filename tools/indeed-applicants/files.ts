import { excelSerial } from '../../support/common/time.js';
import { env } from '../../support/helpers/env.js';
import { buildXlsx, type Cell } from '../../support/helpers/xlsx.js';
import type { Applicant } from './store.js';

// The lead-import Excel file, in the layout the CRM import takes (the columns, their order and the
// constant values of CFT_Indeed_Leads_Import_*.xlsx). Keep it one sheet: the import reads the first.

const COLUMNS = [
  { header: 'First Name', width: 14 },
  { header: 'Last Name', width: 16 },
  { header: 'Phone', width: 14, style: 'int' as const },
  { header: 'Email', width: 24 },
  { header: 'State', width: 7, style: 'center' as const },
  { header: 'Lead Source', width: 12 },
  { header: 'Lead Status', width: 12 },
  { header: 'CDL A', width: 8 },
  { header: 'OTR', width: 8 },
  { header: 'Experience', width: 12 },
  { header: 'Lead Created', width: 13, style: 'date' as const },
  { header: 'Lead Owner', width: 30 },
];

/** "Nicholas Dattilio Jr" → ["Nicholas", "Dattilio Jr"]; a single name stays a first name. */
export function splitName(name: string): [string, string] {
  const parts = name.trim().split(/\s+/);
  return [parts[0] ?? '', parts.slice(1).join(' ')];
}

/** +18459038077 → 18459038077, the number form of the CRM's Phone column. */
export const phoneNumber = (e164: string | null): number | null => (e164 ? Number(e164.replace(/\D/g, '')) : null);

export function importRow(a: Applicant, tz: string): Cell[] {
  const [first, last] = splitName(a.name);
  const created = a.applied_at ?? a.received_at;
  return [
    first, last, phoneNumber(a.phone), null, a.state, 'Indeed', 'New Lead',
    // CDL A, OTR and Experience: Indeed's candidate list doesn't say; the recruiter fills them in.
    null, null, null,
    { v: Math.floor(excelSerial(created, tz)), s: 'date' }, env.indeedLeadOwner,
  ];
}

export function importFile(list: Applicant[], tz: string): Uint8Array {
  return buildXlsx([{ name: 'Leads', columns: COLUMNS, rows: list.map((a) => importRow(a, tz)) }], 'Indeed leads');
}
