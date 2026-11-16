import { timingSafeEqual } from 'node:crypto';
import { contactKeys, defaultConsentText, identityKeys, normalizeLead } from '../../shared/leads.js';
import { newToken, sha256 } from '../../core/crypto.js';
import { getPool, type Db } from '../../db_storage/db.js';
import { env } from '../../core/env.js';
import { HttpError, type ApiRequest } from '../../core/http.js';

export interface LeadSource {
  id: string;
  name: string;
  kind: 'form' | 'webhook' | 'import' | 'api';
  record_kind: 'driver' | 'carrier';
  consent_mode: 'per_record' | 'attested' | 'public_record';
  active: boolean;
  token_hash: string | null;
  cursor: Record<string, unknown>;
  last_ingested_at: Date | null;
}

export type IngestTrigger = 'form' | 'webhook' | 'import' | 'schedule' | 'manual';

export interface IngestContext {
  trigger: IngestTrigger;
  /** Where consent was given, recorded with the consent (registration page only). */
  ip?: string | null;
  userAgent?: string | null;
  consentText?: string;
  consentMethod?: string;
  /** Stop starting new records after this time (ms since epoch); the run is logged as partial. */
  deadline?: number;
  recordedBy?: number;
}

export interface IngestSummary {
  logId: number;
  received: number;
  processed: number;
  inserted: number;
  updated: number;
  rejected: number;
  optedOut: number;
  partial: boolean;
  errors: { index: number; reason: string }[];
}

const MAX_ERRORS_KEPT = 25;
const CONCURRENCY = 3; // matches the pool size

export async function getSource(db: Db, id: string): Promise<LeadSource | null> {
  if (!/^[a-z][a-z0-9_-]{1,40}$/.test(id)) return null;
  const { rows } = await db.query('select * from lead_sources where id = $1', [id]);
  return rows[0] ?? null;
}

export const consentText = () => env.leadsConsentText ?? defaultConsentText(env.leadsCompanyName);

/**
 * Validates a batch of provider records and adds them to the master database. New people are
 * inserted; records that match an existing driver are merged into it (counted as duplicates) and
 * never become new leads. Every run is written to ingestion_logs.
 */
export async function ingestRecords(db: Db, source: LeadSource, raws: unknown[], ctx: IngestContext): Promise<IngestSummary> {
  const sum: IngestSummary = { logId: 0, received: raws.length, processed: 0, inserted: 0, updated: 0, rejected: 0, optedOut: 0, partial: false, errors: [] };
  const reasons: Record<string, number> = {};
  const reject = (index: number, reason: string) => {
    sum.rejected++;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    if (sum.errors.length < MAX_ERRORS_KEPT) sum.errors.push({ index, reason });
  };
  const { rows: log } = await db.query('insert into ingestion_logs (source_id, trigger, received) values ($1, $2, $3) returning id', [source.id, ctx.trigger, raws.length]);
  sum.logId = log[0].id;

  let next = 0;
  let fatal: string | null = null;
  const worker = async () => {
    while (next < raws.length && !fatal) {
      if (ctx.deadline && Date.now() > ctx.deadline) {
        sum.partial = true;
        return;
      }
      const index = next++;
      sum.processed++;
      const n = normalizeLead(raws[index]);
      if (!n.ok) {
        reject(index, n.reason);
        continue;
      }
      const lead = n.lead;
      // An "id" column in a list someone sends is a row number that repeats from file to file, so
      // imported rows are matched by phone and email only.
      if (source.kind === 'import') lead.source_record_id = null;
      try {
        if (lead.opt_out) {
          await suppress(db, identityKeys(lead.phone, lead.email), { method: 'opt_out_source', sourceId: source.id, reason: `opt-out sent by ${source.id}` });
          sum.optedOut++;
          continue;
        }
        const consent =
          source.consent_mode === 'public_record' ? 'public_record'
          : source.consent_mode === 'attested' ? (lead.consent === false ? 'unknown' : 'granted')
          : lead.consent === true ? 'granted' : 'unknown';
        const record = {
          ...lead,
          record_kind: source.record_kind,
          consent_status: consent,
          verification_status: lead.verified === false ? 'unverified' : 'verified',
          consent_method: ctx.consentMethod ?? (source.consent_mode === 'public_record' ? 'public_record' : source.consent_mode === 'attested' && lead.consent !== true ? 'source_attestation' : 'source_record'),
          consent_text: lead.consent_text ?? ctx.consentText ?? null,
          consent_ip: ctx.ip ?? null,
          consent_user_agent: ctx.userAgent?.slice(0, 300) ?? null,
          // The number of trucks is kept with the record's other source details, as power_units.
          extra: { ...extraOf(raws[index]), ...(lead.trucks != null ? { power_units: lead.trucks } : {}) },
        };
        const { rows } = await db.query('select o_outcome from ingest_driver($1, $2::jsonb)', [source.id, JSON.stringify(record)]);
        if (rows[0].o_outcome === 'inserted') sum.inserted++;
        else sum.updated++;
      } catch (e) {
        const msg = (e as Error).message;
        // A constraint the validator didn't anticipate rejects that one record; anything else stops the run.
        if ((e as { code?: string }).code?.startsWith('23') || (e as { code?: string }).code?.startsWith('22')) reject(index, 'failed database validation');
        else fatal = msg;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, raws.length)) }, worker));

  const status = fatal ? 'error' : sum.partial ? 'partial' : 'ok';
  await db.query(
    `update ingestion_logs set status = $2, inserted = $3, updated = $4, rejected = $5, opted_out = $6, error = $7, details = $8, finished_at = now() where id = $1`,
    [sum.logId, status, sum.inserted, sum.updated, sum.rejected, sum.optedOut, fatal, JSON.stringify({ processed: sum.processed, reasons })],
  );
  await db.query('update lead_sources set last_ingested_at = now() where id = $1', [source.id]);
  if (fatal) throw new Error(`Import from ${source.id} stopped: ${fatal}`);
  return sum;
}

/** Provider-specific fields a connector wants kept with the record (set under the `extra` key). */
function extraOf(raw: unknown): Record<string, string | number> {
  const x = (raw as { extra?: unknown } | null)?.extra;
  if (!x || typeof x !== 'object' || Array.isArray(x)) return {};
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(x).slice(0, 20)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k.slice(0, 40)] = v;
    else if (typeof v === 'string' && v) out[k.slice(0, 40)] = v.slice(0, 200);
  }
  return out;
}

/**
 * Records a do-not-contact request. The contact goes on the suppression list (so a provider can't
 * bring it back), and any driver who owns it stops being deliverable.
 */
export async function suppress(
  db: Db,
  keys: string[],
  o: { method: string; reason?: string; sourceId?: string | null; recordedBy?: number | null; ip?: string | null },
): Promise<{ drivers: number }> {
  if (!keys.length) return { drivers: 0 };
  await db.query('insert into lead_suppressions (key, reason, created_by) select k, $2, $3 from unnest($1::text[]) k on conflict do nothing', [keys, o.reason ?? null, o.recordedBy ?? null]);
  const { rows } = await db.query(
    `update drivers set consent_status = 'revoked', updated_at = now()
      where consent_status <> 'revoked' and id in (select driver_id from driver_identities where key = any($1::text[])) returning id`,
    [keys],
  );
  if (rows.length) {
    await db.query(
      `insert into consent_records (driver_id, status, method, source_id, ip, recorded_by) select id, 'revoked', $2, $3, $4, $5 from unnest($1::uuid[]) id`,
      [rows.map((r) => r.id), o.method, o.sourceId ?? null, o.ip ?? null, o.recordedBy ?? null],
    );
  } else {
    await db.query(`insert into consent_records (status, method, source_id, ip, recorded_by, contact_key) values ('revoked', $1, $2, $3, $4, $5)`, [
      o.method, o.sourceId ?? null, o.ip ?? null, o.recordedBy ?? null, keys[0],
    ]);
  }
  return { drivers: rows.length };
}

/**
 * Lifts a do-not-contact request for these contacts. With `restore` (an owner undoing a mistaken
 * opt-out) each driver gets back the consent they had before it. Without it they return to "no
 * consent on file", so the fresh consent that follows is recorded as a new grant.
 */
export async function unsuppress(db: Db, keys: string[], o: { restore: boolean; recordedBy?: number | null }): Promise<{ removed: number; drivers: number }> {
  if (!keys.length) return { removed: 0, drivers: 0 };
  const { rowCount } = await db.query('delete from lead_suppressions where key = any($1::text[])', [keys]);
  // A driver stays opted out while another of their contacts is still on the list.
  const { rows } = await db.query(
    `update drivers d set updated_at = now(), consent_status = coalesce(
         (select c.status from consent_records c where $2 and c.driver_id = d.id and c.status <> 'revoked' order by c.id desc limit 1), 'unknown')
      where d.consent_status = 'revoked' and d.id in (select driver_id from driver_identities where key = any($1::text[]))
        and not exists (select 1 from driver_identities i join lead_suppressions s on s.key = i.key where i.driver_id = d.id)
      returning d.id, d.consent_status`,
    [keys, o.restore],
  );
  const restored = rows.filter((r) => r.consent_status !== 'unknown').map((r) => r.id);
  if (restored.length) {
    await db.query(
      `insert into consent_records (driver_id, status, method, recorded_by) select d.id, d.consent_status, 'opt_out_undone', $2 from drivers d where d.id = any($1::uuid[])`,
      [restored, o.recordedBy ?? null],
    );
  }
  return { removed: rowCount ?? 0, drivers: rows.length };
}

/** Allows `max` hits per bucket per hour. */
async function rateLimit(db: Db, bucket: string, max: number): Promise<void> {
  const { rows } = await db.query(`select count(*)::int as n from lead_rate_hits where bucket = $1 and created_at > now() - interval '1 hour'`, [bucket]);
  if (rows[0].n >= max) throw new HttpError(429, 'Too many requests. Please try again later.');
  await db.query('insert into lead_rate_hits (bucket) values ($1)', [bucket]);
  if (Math.random() < 0.02) await db.query(`delete from lead_rate_hits where created_at < now() - interval '1 day'`).catch(() => {});
}

// ---- Public endpoints -------------------------------------------------------------------------

/** GET /api/leads/form-config — what the registration page needs to render. */
export function formConfig() {
  return { company: env.leadsCompanyName, consentText: consentText() };
}

const FORM_FIELDS = ['full_name', 'phone', 'email', 'state', 'city', 'zip', 'cdl_class', 'years_experience', 'trucks', 'endorsements', 'driver_type', 'equipment', 'preferences', 'availability'];

/** POST /api/leads/register — a driver signs up on the registration page. */
export async function registerDriver(req: ApiRequest, body: Record<string, unknown>) {
  const db = getPool();
  // Bots fill every field, including the hidden one. Answer as if it worked.
  if (typeof body.website === 'string' && body.website.trim()) return { ok: true };
  await rateLimit(db, 'form:' + (req.ip ?? 'unknown'), 6);
  await rateLimit(db, 'form:all', 400);
  if (body.consent !== true) throw new HttpError(400, 'Please tick the consent box so we are allowed to contact you.', 'consent_required');
  // Only the fields the page offers; a sign-up can't set a record id, a verification flag or anything else.
  const record: Record<string, unknown> = { consent: true, consent_at: new Date().toISOString() };
  for (const f of FORM_FIELDS) if (typeof body[f] === 'string' || typeof body[f] === 'number' || Array.isArray(body[f])) record[f] = body[f];
  const n = normalizeLead(record);
  if (!n.ok) {
    const msg = n.reason === 'no name' ? 'Please enter your full name.' : 'Please enter a valid US phone number or email address.';
    throw new HttpError(400, msg, 'invalid');
  }
  if (!n.lead.phone) throw new HttpError(400, 'Please enter a valid 10-digit US phone number.', 'invalid');
  const source = await getSource(db, 'web-form');
  if (!source?.active) throw new HttpError(503, 'Registration is closed at the moment.');
  // Signing up again, with fresh consent, ends an earlier opt-out for this phone number and email.
  await unsuppress(db, identityKeys(n.lead.phone, n.lead.email), { restore: false });
  const s = await ingestRecords(db, source, [record], {
    trigger: 'form', ip: req.ip, userAgent: req.headers['user-agent'] ?? null, consentText: consentText(), consentMethod: 'web_form',
  });
  if (s.rejected) throw new HttpError(400, 'We could not save your details. Please check them and try again.', 'invalid');
  return { ok: true };
}

/** POST /api/leads/optout — anyone can ask not to be contacted. Never reveals whether the contact is known. */
export async function publicOptOut(req: ApiRequest, body: Record<string, unknown>) {
  const db = getPool();
  await rateLimit(db, 'optout:' + (req.ip ?? 'unknown'), 10);
  const keys = contactKeys(body.contact);
  if (!keys.length) throw new HttpError(400, 'Enter the phone number or email address you want removed.', 'invalid');
  await suppress(db, keys, { method: 'opt_out_self', reason: 'self-service opt-out', ip: req.ip });
  return { ok: true };
}

const MAX_WEBHOOK_RECORDS = 500;

/**
 * POST /api/leads/ingest/:source — a provider pushes one lead, an array, or { leads: [...] }.
 * Authenticated by the source's secret: "Authorization: Bearer <token>", "X-Lead-Token", or ?token=.
 */
export async function webhookIngest(req: ApiRequest, sourceId: string) {
  const db = getPool();
  const given = /^Bearer\s+(\S+)$/i.exec(req.headers['authorization'] ?? '')?.[1] ?? req.headers['x-lead-token'] ?? req.query.get('token') ?? '';
  const source = await getSource(db, sourceId);
  const want = source?.token_hash ? Buffer.from(source.token_hash) : null;
  const got = Buffer.from(sha256(given));
  // Same answer for an unknown source and a wrong token.
  if (!source || source.kind !== 'webhook' || !want || want.length !== got.length || !timingSafeEqual(want, got)) throw new HttpError(401, 'Unknown source or wrong token.');
  if (!source.active) throw new HttpError(403, 'This source is switched off.');

  const b = req.body;
  const list = Array.isArray(b) ? b : b && typeof b === 'object' && Array.isArray((b as { leads?: unknown }).leads) ? (b as { leads: unknown[] }).leads : [b];
  if (list.length > MAX_WEBHOOK_RECORDS) throw new HttpError(413, `Send at most ${MAX_WEBHOOK_RECORDS} leads per request.`);
  const s = await ingestRecords(db, source, list, { trigger: 'webhook', deadline: Date.now() + 40_000 });
  return { received: s.received, processed: s.processed, inserted: s.inserted, duplicates: s.updated, rejected: s.rejected, opted_out: s.optedOut, errors: s.errors };
}

// ---- Source management (owners, from the bot) ---------------------------------------------------

export async function createWebhookSource(db: Db, id: string, name: string, createdBy: number): Promise<{ token: string }> {
  if (!/^[a-z][a-z0-9_-]{1,40}$/.test(id)) throw new HttpError(400, 'The source id must be 2–41 characters: lowercase letters, digits, - or _, starting with a letter.');
  const token = newToken();
  const { rows } = await db.query(
    `insert into lead_sources (id, name, kind, record_kind, consent_mode, token_hash, created_by) values ($1, $2, 'webhook', 'driver', 'per_record', $3, $4)
     on conflict (id) do nothing returning id`,
    [id, name.slice(0, 80) || id, sha256(token), createdBy],
  );
  if (!rows[0]) throw new HttpError(409, 'A source with this id already exists.');
  return { token };
}
