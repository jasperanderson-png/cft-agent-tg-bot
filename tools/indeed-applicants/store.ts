import type { Db } from '../../database/db.js';

// The database side of Indeed Applicants: saving what the office script saw, the hiring-chat cards,
// the Excel claim (each applicant goes into one import file) and the script's last report.

export interface Applicant {
  submission_id: string;
  name: string;
  /** +1XXXXXXXXXX, or null when Indeed gave none or it isn't a US number. */
  phone: string | null;
  location: string | null;
  state: string | null;
  job_title: string | null;
  experience: string[];
  applied_at: Date | null;
  received_at: Date;
  baseline: boolean;
  posted_at: Date | null;
  exported_at: Date | null;
}

/** One applicant as the office script reports it, already checked (report.ts). */
export interface IncomingApplicant {
  id: string;
  name: string;
  phone: string | null;
  location: string | null;
  state: string | null;
  job: string | null;
  experience: string[];
  appliedAt: Date | null;
}

export interface Collector {
  last_seen_at: Date | null;
  last_ok_at: Date | null;
  last_status: string | null;
  last_detail: string | null;
  /** The problem the hiring chat was last told about, or null. */
  alert: string | null;
}

/** Oldest application first, the order cards and file rows go in. */
export const byApplied = (a: Applicant, b: Applicant) =>
  (a.applied_at ?? a.received_at).getTime() - (b.applied_at ?? b.received_at).getTime() || a.submission_id.localeCompare(b.submission_id);

/** True before the first report was ever saved. */
export async function isFirstReport(db: Db): Promise<boolean> {
  const { rows } = await db.query('select not exists (select 1 from indeed_applicants) as first');
  return rows[0].first;
}

/**
 * Saves the applicants of one report and returns the ones that are new. Known ones keep their row,
 * except that a job title or phone missing before is filled in. `baseline`: the applicants already
 * there when the bot was connected; they get no card and stay out of the Excel files.
 */
export async function saveApplicants(db: Db, list: IncomingApplicant[], baseline: boolean): Promise<Applicant[]> {
  if (!list.length) return [];
  const rows = list.map((a) => ({
    submission_id: a.id, name: a.name, phone: a.phone, location: a.location, state: a.state, job_title: a.job,
    experience: a.experience, applied_at: a.appliedAt?.toISOString() ?? null,
  }));
  const { rows: saved } = await db.query(
    `insert into indeed_applicants (submission_id, name, phone, location, state, job_title, experience, applied_at, baseline, posted_at, exported_at)
     select x.submission_id, x.name, x.phone, x.location, x.state, x.job_title, coalesce(x.experience, '[]'), x.applied_at,
            $2, case when $2 then now() end, case when $2 then now() end
       from jsonb_to_recordset($1::jsonb) as x(submission_id text, name text, phone text, location text, state text, job_title text, experience jsonb, applied_at timestamptz)
     on conflict (submission_id) do update
       set job_title = coalesce(indeed_applicants.job_title, excluded.job_title),
           phone = coalesce(indeed_applicants.phone, excluded.phone)
     returning *, (xmax = 0) as inserted`,
    [JSON.stringify(rows), baseline],
  );
  return (saved as (Applicant & { inserted: boolean })[]).filter((r) => r.inserted).map(({ inserted: _, ...r }) => r);
}

/** Applicants whose card isn't in the hiring chat yet (new ones, and ones Telegram refused before). */
export async function unposted(db: Db): Promise<Applicant[]> {
  const { rows } = await db.query('select * from indeed_applicants where posted_at is null order by received_at, submission_id limit 200');
  return (rows as Applicant[]).sort(byApplied);
}

/**
 * Marks cards as posted, before they are sent, and returns the ones this call took: two reports at the
 * same moment never post the same card twice. A refused card is put back with unpost().
 */
export async function claimPosts(db: Db, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const { rows } = await db.query('update indeed_applicants set posted_at = now() where submission_id = any($1) and posted_at is null returning submission_id', [ids]);
  return rows.map((r) => r.submission_id);
}

export async function unpost(db: Db, ids: string[]): Promise<void> {
  if (ids.length) await db.query('update indeed_applicants set posted_at = null where submission_id = any($1)', [ids]);
}

/**
 * Takes every applicant that hasn't been in an import file yet, in one statement, so two requests
 * at the same moment never put the same person in two files.
 */
export async function claimForExport(db: Db): Promise<Applicant[]> {
  const { rows } = await db.query('update indeed_applicants set exported_at = now() where exported_at is null returning *');
  return (rows as Applicant[]).sort(byApplied);
}

/** Puts claimed applicants back in the queue (their file was not sent). */
export async function releaseExport(db: Db, ids: string[]): Promise<void> {
  if (ids.length) await db.query('update indeed_applicants set exported_at = null where submission_id = any($1)', [ids]);
}

/** Applicants received since `since`, delivered or not (a read-only copy). */
export async function receivedSince(db: Db, since: Date): Promise<Applicant[]> {
  const { rows } = await db.query('select * from indeed_applicants where not baseline and received_at >= $1', [since]);
  return (rows as Applicant[]).sort(byApplied);
}

export interface IndeedStats {
  /** Not in an import file yet. */
  waiting: number;
  /** Received since `since` (today's start in the report time zone). */
  today: number;
  /** Received since the bot was connected. */
  total: number;
  collector: Collector;
}

export async function indeedStats(db: Db, since: Date): Promise<IndeedStats> {
  const { rows } = await db.query(
    `select count(*) filter (where exported_at is null) as waiting,
            count(*) filter (where not baseline and received_at >= $1) as today,
            count(*) filter (where not baseline) as total
       from indeed_applicants`,
    [since],
  );
  return { ...rows[0], collector: await getCollector(db) };
}

export async function getCollector(db: Db): Promise<Collector> {
  const { rows } = await db.query('select last_seen_at, last_ok_at, last_status, last_detail, alert from indeed_collector where id = 1');
  return rows[0] ?? { last_seen_at: null, last_ok_at: null, last_status: null, last_detail: null, alert: null };
}

/** Records one report from the office script. */
export async function recordReport(db: Db, status: string, detail: string | null): Promise<void> {
  await db.query(
    `update indeed_collector
        set last_seen_at = now(), last_status = $1, last_detail = $2,
            last_ok_at = case when $1 = 'ok' then now() else last_ok_at end
      where id = 1`,
    [status, detail],
  );
}

export async function setAlert(db: Db, alert: string | null): Promise<void> {
  await db.query('update indeed_collector set alert = $1 where id = 1', [alert]);
}
