import { createSign } from 'node:crypto';
import type { SheetsStatus } from '../../shared/types.js';
import { getPool, type Db } from '../../db_storage/db.js';
import { env } from '../../core/env.js';
import { HttpError } from '../../core/http.js';

/**
 * Google Sheets export through a service account (GOOGLE_SERVICE_ACCOUNT_JSON).
 * Uses RAW value input, so candidate-entered text is never evaluated as a formula.
 */

const TAB = 'Results';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';
let cached: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  const sa = env.googleServiceAccount;
  if (!sa) throw new HttpError(503, 'Google Sheets is not configured on the server (GOOGLE_SERVICE_ACCOUNT_JSON).');
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key.replace(/\\n/g, '\n')).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    signal: AbortSignal.timeout(8000),
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!j.access_token) throw new HttpError(502, 'Google rejected the service account: ' + (j.error_description ?? res.status));
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function google(url: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(10_000),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    const email = env.googleServiceAccount?.client_email;
    if (res.status === 403 || res.status === 404) {
      throw new HttpError(400, `Google Sheets couldn't open that sheet. Share it with ${email} as an Editor, then try again.`);
    }
    throw new HttpError(502, 'Google Sheets error: ' + (j.error?.message ?? res.status));
  }
  return j;
}

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

export function spreadsheetIdFromUrl(url: string): string | null {
  const m = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(url.trim());
  return m ? m[1] : null;
}

export interface SheetAttempt {
  name: string;
  id: string;
  startedAt: Date;
  submittedAt: Date;
  correct: number;
  total: number;
  pct: number;
  passMark: number;
  durationSec: number | null;
  answers: Record<number, string>;
}

export function sheetHeader(questionNumbers: number[]): string[] {
  return ['Candidate', 'Attempt ID', 'Started (UTC)', 'Submitted (UTC)', 'Score', 'Percentage', 'Result', 'Duration (min)', ...questionNumbers.map((n) => `Q${n}`)];
}

export function sheetRow(a: SheetAttempt, questionNumbers: number[]): (string | number)[] {
  const iso = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 16);
  return [
    a.name, a.id, iso(a.startedAt), iso(a.submittedAt), `${a.correct}/${a.total}`, a.pct,
    a.correct >= a.passMark ? 'Pass' : 'Below pass mark',
    a.durationSec == null ? '' : Math.max(1, Math.round(a.durationSec / 60)),
    ...questionNumbers.map((n) => a.answers[n] ?? ''),
  ];
}

async function questionNumbers(db: Db): Promise<number[]> {
  const { rows } = await db.query('select number from questions order by number');
  return rows.map((r) => r.number);
}

async function sheetAttempts(db: Db, onlyId?: string): Promise<SheetAttempt[]> {
  const { rows } = await db.query(
    `select a.id, c.full_name, a.started_at, a.submitted_at, a.correct_count, a.total_questions, a.score_pct, a.pass_mark, a.duration_seconds,
            coalesce((select jsonb_object_agg(q.number, aa.selected_option) from attempt_answers aa join questions q on q.id = aa.question_id
                       where aa.attempt_id = a.id and aa.selected_option is not null), '{}'::jsonb) as answers
       from assessment_attempts a join candidates c on c.id = a.candidate_id
      where a.status = 'completed' and ($1::uuid is null or a.id = $1)
      order by a.submitted_at`,
    [onlyId ?? null],
  );
  return rows.map((r) => ({
    id: r.id, name: r.full_name, startedAt: r.started_at, submittedAt: r.submitted_at, correct: r.correct_count, total: r.total_questions,
    pct: r.score_pct, passMark: r.pass_mark, durationSec: r.duration_seconds, answers: r.answers,
  }));
}

export async function sheetsStatus(db: Db): Promise<SheetsStatus> {
  const { rows } = await db.query(
    'select sheets_spreadsheet_id, sheets_url, sheets_name, sheets_auto_sync, sheets_rows_synced, sheets_last_sync_at from app_settings where id = 1',
  );
  const r = rows[0] ?? {};
  return {
    configured: !!env.googleServiceAccount,
    serviceAccountEmail: env.googleServiceAccount?.client_email ?? null,
    connected: !!r.sheets_spreadsheet_id,
    url: r.sheets_url ?? null,
    name: r.sheets_name ?? null,
    autoSync: r.sheets_auto_sync ?? true,
    rowsSynced: r.sheets_rows_synced ?? 0,
    lastSyncAt: r.sheets_last_sync_at?.toISOString() ?? null,
  };
}

async function ensureTab(id: string) {
  const meta = await google(`${SHEETS}/${id}?fields=properties.title,sheets.properties.title`);
  if (!meta.sheets?.some((s: any) => s.properties?.title === TAB)) {
    await google(`${SHEETS}/${id}:batchUpdate`, { method: 'POST', body: { requests: [{ addSheet: { properties: { title: TAB } } }] } });
  }
  return meta.properties?.title as string;
}

/** Rewrites the whole Results tab from the database. */
async function fullSync(db: Db, id: string): Promise<number> {
  const qn = await questionNumbers(db);
  const rows = (await sheetAttempts(db)).map((a) => sheetRow(a, qn));
  await google(`${SHEETS}/${id}/values/${TAB}!A:ZZ:clear`, { method: 'POST', body: {} });
  await google(`${SHEETS}/${id}/values/${TAB}!A1?valueInputOption=RAW`, { method: 'PUT', body: { values: [sheetHeader(qn), ...rows] } });
  await db.query('update app_settings set sheets_rows_synced = $1, sheets_last_sync_at = now() where id = 1', [rows.length]);
  return rows.length;
}

export async function linkSheet(url: unknown) {
  const id = typeof url === 'string' ? spreadsheetIdFromUrl(url) : null;
  if (!id) throw new HttpError(400, 'Paste a Google Sheets link, e.g. https://docs.google.com/spreadsheets/d/…');
  const db = getPool();
  const title = await ensureTab(id);
  await db.query('update app_settings set sheets_spreadsheet_id = $1, sheets_url = $2, sheets_name = $3 where id = 1', [
    id, `https://docs.google.com/spreadsheets/d/${id}/edit`, title || 'Linked sheet',
  ]);
  await fullSync(db, id);
  return sheetsStatus(db);
}

export async function createSheet(shareWith: string) {
  const db = getPool();
  const created = await google(SHEETS, {
    method: 'POST',
    body: { properties: { title: 'CFT Agent Academy — Results' }, sheets: [{ properties: { title: TAB } }] },
  });
  const id = created.spreadsheetId as string;
  // The service account owns the new file; give the signed-in admin edit access.
  await google(`https://www.googleapis.com/drive/v3/files/${id}/permissions?sendNotificationEmail=true`, {
    method: 'POST',
    body: { type: 'user', role: 'writer', emailAddress: shareWith },
  });
  await db.query('update app_settings set sheets_spreadsheet_id = $1, sheets_url = $2, sheets_name = $3 where id = 1', [
    id, created.spreadsheetUrl, created.properties?.title ?? 'CFT Agent Academy — Results',
  ]);
  await fullSync(db, id);
  return sheetsStatus(db);
}

export async function syncNow() {
  const db = getPool();
  const s = await sheetsStatus(db);
  const { rows } = await db.query('select sheets_spreadsheet_id from app_settings where id = 1');
  if (!s.connected) throw new HttpError(400, 'No sheet is connected.');
  await fullSync(db, rows[0].sheets_spreadsheet_id);
  return sheetsStatus(db);
}

export async function setAutoSync(on: unknown) {
  const db = getPool();
  await db.query('update app_settings set sheets_auto_sync = $1 where id = 1', [on === true]);
  return sheetsStatus(db);
}

export async function disconnectSheet() {
  const db = getPool();
  await db.query(
    `update app_settings set sheets_spreadsheet_id = null, sheets_url = null, sheets_name = null, sheets_rows_synced = 0,
            sheets_last_sync_at = null, sheets_auto_sync = true where id = 1`,
  );
  return sheetsStatus(db);
}

/** Appends one graded attempt. Never throws: a Sheets outage must not fail a candidate's submit. */
export async function autoSyncAttempt(attemptId: string): Promise<void> {
  try {
    const db = getPool();
    const { rows } = await db.query('select sheets_spreadsheet_id, sheets_auto_sync from app_settings where id = 1');
    const id = rows[0]?.sheets_spreadsheet_id;
    if (!id || !rows[0].sheets_auto_sync || !env.googleServiceAccount) return;
    const [a] = await sheetAttempts(db, attemptId);
    if (!a) return;
    await google(`${SHEETS}/${id}/values/${TAB}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: { values: [sheetRow(a, await questionNumbers(db))] },
    });
    await db.query('update app_settings set sheets_rows_synced = sheets_rows_synced + 1, sheets_last_sync_at = now() where id = 1');
  } catch (e) {
    console.error('Sheets auto-sync failed for attempt', attemptId, (e as Error).message);
  }
}
