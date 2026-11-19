import type { Db } from '../../database/db.js';
import { env } from '../../support/helpers/env.js';
import { getSource, ingestRecords, type IngestSummary, type IngestTrigger, type LeadSource } from './ingest.js';

/**
 * The one pull source: the FMCSA Company Census File (data.transportation.gov, dataset az4n-8mr2),
 * the public registry of every entity with a USDOT number, refreshed daily. It describes CARRIERS
 * (companies), not individual drivers: there is no public FMCSA database of driver contact details.
 *
 * With LEADS_FMCSA_ENABLED=true this takes newly registered, active US carriers with a very small
 * fleet (owner-operators running their own authority). They are stored as record_kind = 'carrier'
 * with consent_status = 'public_record' and are labelled that way in every file and message.
 *
 * The registration page, vendor webhooks and CSV imports push records in as they happen and need
 * no sync. To add another pull provider, fetch its new records, pass them to ingestRecords() as
 * runFmcsa() does, and call it from runPullSources().
 */

const SOURCE = 'fmcsa-census';
const ENDPOINT = 'https://data.transportation.gov/resource/az4n-8mr2.json';
const PAGE = 1000;
const MAX_PAGES = 8;
const FIELDS = [
  'dot_number', 'legal_name', 'dba_name', 'company_officer_1', 'phone', 'cell_phone', 'email_address', 'phy_city', 'phy_state', 'phy_zip',
  'power_units', 'total_drivers', 'total_cdl', 'add_date', 'carrier_operation', 'classdef', 'docket1prefix', 'docket1',
] as const;
type CensusRow = Partial<Record<(typeof FIELDS)[number], string>>;

const yyyymmdd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const tidy = (s: string | undefined) => (s ? s.trim().replace(/\s+/g, ' ') : undefined);

export function censusWhere(sinceYmd: string, maxPowerUnits: number, forHireOnly: boolean): string {
  const units = Array.from({ length: maxPowerUnits }, (_v, i) => `'${i + 1}'`).join(',');
  return [
    `add_date >= '${sinceYmd}'`,
    `status_code = 'A'`,
    `phy_country = 'US'`,
    `power_units in (${units})`,
    forHireOnly ? `classdef like '%AUTHORIZED FOR HIRE%'` : null,
  ].filter(Boolean).join(' AND ');
}

/** One census row as a provider record for the shared normaliser. */
export function censusToRecord(c: CensusRow): Record<string, unknown> {
  const drivers = Number(c.total_drivers);
  return {
    name: tidy(c.company_officer_1),
    company: tidy(c.legal_name),
    phone: c.cell_phone || c.phone,
    email: c.email_address,
    city: tidy(c.phy_city)?.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase()),
    state: c.phy_state,
    zip: c.phy_zip,
    usdot: c.dot_number,
    id: c.dot_number,
    driver_type: 'owner operator',
    trucks: c.power_units,
    extra: {
      ...(Number.isFinite(drivers) ? { drivers } : {}),
      ...(c.dba_name ? { dba: c.dba_name } : {}),
      ...(c.add_date ? { fmcsa_add_date: c.add_date } : {}),
      ...(c.classdef ? { classification: c.classdef } : {}),
      ...(c.docket1 ? { docket: `${c.docket1prefix ?? ''}${c.docket1}` } : {}),
    },
  };
}

async function fetchPage(where: string, offset: number): Promise<CensusRow[]> {
  const url = new URL(ENDPOINT);
  url.searchParams.set('$select', FIELDS.join(','));
  url.searchParams.set('$where', where);
  url.searchParams.set('$order', 'add_date, dot_number');
  url.searchParams.set('$limit', String(PAGE));
  url.searchParams.set('$offset', String(offset));
  const res = await fetch(url, {
    headers: { accept: 'application/json', ...(env.socrataAppToken ? { 'x-app-token': env.socrataAppToken } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`FMCSA census request failed: HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('FMCSA census returned an unexpected response.');
  return rows as CensusRow[];
}

/**
 * Collects registrations added in the last LEADS_FMCSA_LOOKBACK_DAYS days and imports the ones the
 * database doesn't have yet. FMCSA publishes some registrations a few days after their add date, so
 * every run re-reads the window; carriers already stored are skipped before import and are not
 * counted as duplicates. With LEADS_FMCSA_REPLACE_OLD (the default) the run then deletes the
 * carriers whose registration date has left the window.
 */
async function runFmcsa(db: Db, source: LeadSource, trigger: IngestTrigger, deadline: number, now = new Date()): Promise<IngestSummary & { removed: number }> {
  const since = yyyymmdd(new Date(now.getTime() - env.fmcsaLookbackDays * 86_400_000));
  const where = censusWhere(since, env.fmcsaMaxPowerUnits, env.fmcsaForHireOnly);
  const all: CensusRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await fetchPage(where, page * PAGE);
    all.push(...rows);
    if (rows.length < PAGE || Date.now() > deadline) break;
  }
  const key = (r: CensusRow) => `src:${SOURCE}:${r.dot_number}`;
  const withDot = all.filter((r) => /^\d{1,9}$/.test(r.dot_number ?? ''));
  // Known = stored now, or stored once and since deleted as old.
  const { rows: known } = await db.query(
    'select key from driver_identities where key = any($1::text[]) union select key from lead_tombstones where key = any($1::text[])',
    [withDot.map(key)],
  );
  const have = new Set(known.map((k) => k.key as string));

  const sum = await ingestRecords(db, source, withDot.filter((r) => !have.has(key(r))).map(censusToRecord), { trigger, deadline });
  const removed = env.fmcsaReplaceOld ? await removeOld(db, since) : 0;

  await db.query('update lead_sources set cursor = $2 where id = $1', [SOURCE, JSON.stringify({ window_from: since, last_run: now.toISOString(), fetched: all.length, removed })]);
  if (removed) await db.query('update ingestion_logs set details = details || $2::jsonb where id = $1', [sum.logId, JSON.stringify({ removed_old: removed })]);
  return { ...sum, removed };
}

/**
 * Deletes FMCSA carrier records registered before `sinceYmd`, going by each record's own
 * registration date (the day it was stored, if it has none). What FMCSA answered today plays no
 * part, so a short or broken answer can never empty the database. Left alone: a record a delivery
 * is using right now, and a carrier who has since signed up and given consent (a driver lead in its
 * own right). Every USDOT key of a deleted record is remembered, so it never returns as a new lead.
 */
async function removeOld(db: Db, sinceYmd: string): Promise<number> {
  const { rows } = await db.query(
    `with gone as (
       delete from drivers d
        where d.source_id = $1 and d.record_kind = 'carrier' and d.consent_status <> 'granted' and d.delivery_status <> 'claimed'
          and (case when d.extra->>'fmcsa_add_date' ~ '^[0-9]{8}$' then d.extra->>'fmcsa_add_date' else to_char(d.first_added_at, 'YYYYMMDD') end) < $2
       returning d.id
     ), remembered as (
       insert into lead_tombstones (key)
       select i.key from driver_identities i join gone g on g.id = i.driver_id where starts_with(i.key, 'src:' || $1 || ':')
       on conflict do nothing
     )
     select count(*) as n from gone`,
    [SOURCE, sinceYmd],
  );
  return Number(rows[0].n);
}

export interface SyncResult {
  sourceId: string;
  ok: boolean;
  inserted: number;
  duplicates: number;
  rejected: number;
  /** Old records deleted in this run. */
  removed: number;
  partial: boolean;
  error?: string;
}

/** True when a pull source is switched on in the deployment settings. */
export const pullEnabled = () => env.fmcsaEnabled;

/** Runs the pull sources that are switched on (daily schedule, or /leadsync). A failure is reported, not thrown. */
export async function runPullSources(db: Db, trigger: IngestTrigger, budgetMs = 40_000): Promise<SyncResult[]> {
  const source = pullEnabled() ? await getSource(db, SOURCE) : null;
  if (!source?.active) return [];
  try {
    const s = await runFmcsa(db, source, trigger, Date.now() + budgetMs);
    return [{ sourceId: SOURCE, ok: true, inserted: s.inserted, duplicates: s.updated, rejected: s.rejected, removed: s.removed, partial: s.partial }];
  } catch (e) {
    const error = (e as Error).message;
    console.error('Lead source failed', SOURCE, error);
    await db.query(`insert into ingestion_logs (source_id, trigger, status, error, finished_at) values ($1, $2, 'error', $3, now())`, [SOURCE, trigger, error.slice(0, 500)]).catch(() => {});
    return [{ sourceId: SOURCE, ok: false, inserted: 0, duplicates: 0, rejected: 0, removed: 0, partial: false, error }];
  }
}
