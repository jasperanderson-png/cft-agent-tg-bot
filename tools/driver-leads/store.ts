import { randomUUID } from 'node:crypto';
import { weekStart, zoned, zonedToUtc } from '../../support/common/time.js';
import type { Db } from '../../database/db.js';

/** One row of the master table, with its source's display name. */
export interface DriverRow {
  id: string;
  lead_no: number;
  record_kind: 'driver' | 'carrier';
  full_name: string;
  phone: string | null;
  email: string | null;
  state: string | null;
  city: string | null;
  zip: string | null;
  cdl_class: string | null;
  years_experience: number | null;
  endorsements: string[];
  driver_types: string[];
  equipment: string[];
  employment_preferences: string | null;
  availability: string | null;
  company_name: string | null;
  usdot_number: string | null;
  /** Source details kept with the record; `power_units` is the number of trucks. */
  extra: Record<string, unknown>;
  source_id: string;
  source_name: string;
  source_record_id: string | null;
  first_added_at: Date;
  updated_at: Date;
  update_count: number;
  verification_status: 'verified' | 'unverified' | 'invalid';
  consent_status: 'granted' | 'public_record' | 'unknown' | 'revoked';
  delivery_status: 'pending' | 'claimed' | 'delivered';
  delivered_at: Date | null;
}

/**
 * The one definition of "may leave the database with contact details": there is a contact basis
 * (the person opted in, or it is a public business registration) and the contact data passed validation.
 */
/** How many trucks the driver or carrier runs, when the source said. */
export const trucksOf = (r: Pick<DriverRow, 'extra'>): number | null => (typeof r.extra?.power_units === 'number' ? r.extra.power_units : null);

export const ELIGIBLE = `d.consent_status in ('granted', 'public_record') and d.verification_status = 'verified'`;

export type ExportKind = 'today' | 'full' | 'csv' | 'excel' | 'state' | 'cdl';
export type FileFormat = 'xlsx' | 'csv';

/** Start of today in the report time zone. */
export const dayStart = (tz: string, now = new Date()): Date => {
  const z = zoned(now, tz);
  return zonedToUtc(z.y, z.m, z.d, 0, 0, tz);
};

// ---- Fresh-only delivery ------------------------------------------------------------------------
//
// claim → send → confirm. Claiming is a single UPDATE that moves undelivered, eligible rows from
// 'pending' to 'claimed' under row locks (FOR UPDATE SKIP LOCKED), so two clicks at the same moment
// can never claim the same driver. Rows become 'delivered' once the file was sent; if Telegram
// refuses the file they go back to 'pending'. A claim abandoned by a crashed function is released
// after CLAIM_TIMEOUT.

const CLAIM_TIMEOUT = `interval '5 minutes'`;

export async function recoverStaleClaims(db: Db): Promise<number> {
  const { rows } = await db.query(
    `update drivers set delivery_status = 'pending', delivery_batch_id = null, claimed_at = null
      where delivery_status = 'claimed' and claimed_at < now() - ${CLAIM_TIMEOUT} returning delivery_batch_id`,
  );
  if (rows.length) {
    await db.query(
      `update delivery_batches set status = 'failed', error = 'not confirmed in time; leads returned to the queue', finished_at = now()
        where status = 'claimed' and created_at < now() - ${CLAIM_TIMEOUT}`,
    );
  }
  return rows.length;
}

export async function claimRecent(db: Db, userId: number, chatId: number, limit: number): Promise<{ batchId: string; rows: DriverRow[] }> {
  const batchId = randomUUID();
  const { rows } = await db.query(
    `with picked as (
       select d.id from drivers d
        where d.delivery_status = 'pending' and ${ELIGIBLE}
        order by d.lead_no
        limit $2
        for update skip locked
     ), claimed as (
       update drivers d set delivery_status = 'claimed', delivery_batch_id = $1, claimed_at = now()
         from picked where d.id = picked.id
       returning d.*
     )
     select c.*, s.name as source_name from claimed c join lead_sources s on s.id = c.source_id order by c.lead_no`,
    [batchId, limit],
  );
  if (rows.length) {
    await db.query(`insert into delivery_batches (id, kind, format, requested_by, chat_id, status, lead_count) values ($1, 'recent', 'xlsx', $2, $3, 'claimed', $4)`, [
      batchId, userId, chatId, rows.length,
    ]);
  }
  return { batchId, rows };
}

/** The file was sent: the claimed leads are delivered, for good. */
export async function confirmBatch(db: Db, batchId: string, userId: number, filename: string): Promise<number> {
  const { rows } = await db.query(
    `with done as (
       update drivers set delivery_status = 'delivered', delivered_at = now(), delivered_to = $2
        where delivery_batch_id = $1 and delivery_status = 'claimed' returning id
     ), hist as (
       insert into delivery_history (driver_id, batch_id, telegram_user_id) select id, $1, $2 from done
       on conflict (driver_id) do nothing
     )
     update delivery_batches set status = 'delivered', finished_at = now(), filename = $3, lead_count = (select count(*) from done)
      where id = $1 returning lead_count`,
    [batchId, userId, filename],
  );
  return rows[0]?.lead_count ?? 0;
}

/** Telegram refused the file: put the claimed leads back so the next click delivers them. */
export async function releaseBatch(db: Db, batchId: string, error: string): Promise<void> {
  await db.query(`update drivers set delivery_status = 'pending', delivery_batch_id = null, claimed_at = null where delivery_batch_id = $1 and delivery_status = 'claimed'`, [batchId]);
  await db.query(`update delivery_batches set status = 'failed', error = $2, finished_at = now() where id = $1`, [batchId, error.slice(0, 500)]);
}

// ---- Read-only views (exports never change delivery state) -------------------------------------------

export interface ExportView {
  kind: ExportKind;
  /** State code for 'state'; A, B, C or NA for 'cdl'. */
  filter?: string;
}

export async function queryLeads(db: Db, view: ExportView, tz: string, after: number, limit: number): Promise<DriverRow[]> {
  const params: unknown[] = [after, limit];
  let where = ELIGIBLE;
  if (view.kind === 'full') where = 'true';
  else if (view.kind === 'today') {
    params.push(dayStart(tz));
    where += ` and d.first_added_at >= $3`;
  } else if (view.kind === 'state') {
    params.push(view.filter);
    where += ` and d.state = $3`;
  } else if (view.kind === 'cdl') {
    if (view.filter === 'NA') where += ' and d.cdl_class is null';
    else {
      params.push(view.filter);
      where += ` and d.cdl_class = $3`;
    }
  }
  const { rows } = await db.query(
    `select d.*, s.name as source_name from drivers d join lead_sources s on s.id = d.source_id
      where d.lead_no > $1 and ${where} order by d.lead_no limit $2`,
    params,
  );
  return rows;
}

/** The leads of this person's latest GET RECENT LEADS file, as they are stored now, for sending it again. */
export async function lastDelivery(db: Db, userId: number): Promise<{ at: Date; rows: DriverRow[] } | null> {
  const { rows: batch } = await db.query(
    `select id, finished_at from delivery_batches
      where kind = 'recent' and status = 'delivered' and filter is null and requested_by = $1 order by finished_at desc limit 1`,
    [userId],
  );
  if (!batch[0]) return null;
  const { rows } = await db.query(
    `select d.*, s.name as source_name from delivery_history h join drivers d on d.id = h.driver_id join lead_sources s on s.id = d.source_id
      where h.batch_id = $1 order by d.lead_no`,
    [batch[0].id],
  );
  return rows.length ? { at: batch[0].finished_at, rows } : null;
}

/** Audit trail: every file that left the database. A repeat of a GET RECENT LEADS file is kind 'recent' with filter 'resend'. */
export async function logExport(db: Db, o: { kind: ExportKind | 'recent'; filter?: string; format: FileFormat; userId: number; chatId: number; count: number; filename: string }) {
  await db.query(
    `insert into delivery_batches (kind, filter, format, requested_by, chat_id, status, lead_count, filename, finished_at) values ($1, $2, $3, $4, $5, 'delivered', $6, $7, now())`,
    [o.kind, o.filter ?? null, o.format, o.userId, o.chatId, o.count, o.filename],
  );
}

export async function stateCounts(db: Db): Promise<{ key: string; n: number }[]> {
  const { rows } = await db.query(`select d.state as key, count(*) as n from drivers d where ${ELIGIBLE} and d.state is not null group by 1 order by 1`);
  return rows;
}

export async function cdlCounts(db: Db): Promise<{ key: string; n: number }[]> {
  const { rows } = await db.query(`select coalesce(d.cdl_class, 'NA') as key, count(*) as n from drivers d where ${ELIGIBLE} group by 1 order by 1`);
  return rows;
}

export interface LeadStats {
  total: number;
  today: number;
  week: number;
  undelivered: number;
  delivered: number;
  verified: number;
  noConsent: number;
  optedOut: number;
  carriers: number;
  duplicates: number;
  rejected: number;
  byState: { key: string; n: number }[];
  byCdl: { key: string; n: number }[];
  bySource: { key: string; n: number }[];
  lastImport: { source: string; at: Date; inserted: number; updated: number; rejected: number; status: string } | null;
}

export async function leadStats(db: Db, tz: string, now = new Date()): Promise<LeadStats> {
  const [t, logs, byState, byCdl, bySource, last] = await Promise.all([
    db.query(
      `select count(*) as total,
              count(*) filter (where d.first_added_at >= $1) as today,
              count(*) filter (where d.first_added_at >= $2) as week,
              count(*) filter (where d.delivery_status <> 'delivered' and ${ELIGIBLE}) as undelivered,
              count(*) filter (where d.delivery_status = 'delivered') as delivered,
              count(*) filter (where d.verification_status = 'verified') as verified,
              count(*) filter (where d.consent_status = 'unknown') as no_consent,
              count(*) filter (where d.consent_status = 'revoked') as opted_out,
              count(*) filter (where d.record_kind = 'carrier') as carriers
         from drivers d`,
      [dayStart(tz, now), weekStart(now, tz)],
    ),
    db.query('select coalesce(sum(updated), 0) as duplicates, coalesce(sum(rejected), 0) as rejected from ingestion_logs'),
    db.query(`select coalesce(d.state, '—') as key, count(*) as n from drivers d group by 1 order by 2 desc, 1`),
    db.query(`select coalesce(d.cdl_class, 'NA') as key, count(*) as n from drivers d group by 1 order by 1`),
    db.query(`select s.name as key, count(d.id) as n from lead_sources s left join drivers d on d.source_id = s.id group by s.id, s.name having count(d.id) > 0 order by 2 desc`),
    db.query(`select source_id as source, coalesce(finished_at, started_at) as at, inserted, updated, rejected, status from ingestion_logs order by id desc limit 1`),
  ]);
  const r = t.rows[0];
  return {
    total: r.total, today: r.today, week: r.week, undelivered: r.undelivered, delivered: r.delivered, verified: r.verified,
    noConsent: r.no_consent, optedOut: r.opted_out, carriers: r.carriers,
    duplicates: logs.rows[0].duplicates, rejected: logs.rows[0].rejected,
    byState: byState.rows, byCdl: byCdl.rows, bySource: bySource.rows, lastImport: last.rows[0] ?? null,
  };
}

// ---- Access ---------------------------------------------------------------------------------------

export type LeadsRole = 'owner' | 'admin';

/**
 * Driver Leads is for Academy administrators, and nobody else. Owners (ADMIN_TELEGRAM_IDS) also get
 * the owner tools. Access follows the admin list: add or remove an admin in the Academy console.
 */
export async function leadsRole(db: Db, telegramUserId: number, ownerIds: number[]): Promise<LeadsRole | null> {
  if (ownerIds.includes(telegramUserId)) return 'owner';
  const { rows } = await db.query('select 1 from admins where telegram_user_id = $1', [telegramUserId]);
  return rows[0] ? 'admin' : null;
}
