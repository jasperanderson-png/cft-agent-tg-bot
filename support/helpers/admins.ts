// CFT administrators, for every product: who is an admin, signing in (Telegram or email + password),
// sessions, the Users and Admins screens, and short-lived file downloads.
import type { AdminMe, AdminUser } from '../common/types.js';
import { dummyHash, newToken, sha256, verifyPassword } from './crypto.js';
import { getPool, tx, type Db } from '../../database/db.js';
import { env } from './env.js';
import { bearer, HttpError, ok, UUID_RE, type ApiRequest, type Handler } from './http.js';
import { fullName, storedName, type TelegramUser } from './telegram.js';
import { requireTelegramUser } from './web-login.js';
import { touchTelegramUser } from './users.js';

const SESSION_HOURS = 12;
const MAX_FAILS_PER_EMAIL = 8;
const MAX_FAILS_PER_IP = 30;
const FAIL_WINDOW = "interval '15 minutes'";

export interface Admin {
  id: string;
  email: string | null;
  name: string | null;
  role: 'owner' | 'admin';
  telegramUserId: number | null;
  sessionId: string;
}


/**
 * The admin row for a Telegram account. Owners listed in ADMIN_TELEGRAM_IDS are created (or
 * promoted back to owner) on first contact, so the bot works for them with no setup.
 */
export async function telegramAdmin(db: Db, user: TelegramUser): Promise<{ id: string; email: string | null; role: string } | null> {
  const owner = env.ownerTelegramIds.includes(user.id);
  if (owner) {
    const { rows } = await db.query(
      `insert into admins (telegram_user_id, name, role) values ($1, $2, 'owner')
       on conflict (telegram_user_id) do update set role = 'owner', name = coalesce(admins.name, excluded.name)
       returning id, email, role`,
      [user.id, storedName(user)],
    );
    return rows[0];
  }
  const { rows } = await db.query('select id, email, role from admins where telegram_user_id = $1', [user.id]);
  return rows[0] ?? null;
}

async function createSession(db: Db, adminId: string) {
  const token = newToken();
  const { rows } = await db.query(
    `insert into admin_sessions (admin_id, token_hash, expires_at) values ($1, $2, now() + interval '${SESSION_HOURS} hours') returning expires_at`,
    [adminId, sha256(token)],
  );
  await db.query('update admins set last_login_at = now() where id = $1', [adminId]);
  return { token, expiresAt: (rows[0].expires_at as Date).toISOString() };
}

export async function login(body: Record<string, unknown>, ip: string | null) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.');
  if (!password || password.length > 200) throw new HttpError(400, 'Enter your password.');

  const db = getPool();
  const { rows: fails } = await db.query(
    `select count(*) filter (where email = $1)::int as by_email, count(*) filter (where ip = $2)::int as by_ip
       from admin_login_failures where created_at > now() - ${FAIL_WINDOW} and (email = $1 or ip = $2)`,
    [email, ip],
  );
  if (fails[0].by_email >= MAX_FAILS_PER_EMAIL || (ip && fails[0].by_ip >= MAX_FAILS_PER_IP)) {
    throw new HttpError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
  }
  const { rows } = await db.query('select id, email, password_hash from admins where email = $1 and password_hash is not null', [email]);
  const valid = await verifyPassword(password, rows[0]?.password_hash ?? (await dummyHash()));
  if (!rows[0] || !valid) {
    await db.query('insert into admin_login_failures (email, ip) values ($1, $2)', [email, ip]);
    throw new HttpError(401, 'Email or password is incorrect.');
  }
  await db.query('delete from admin_login_failures where email = $1', [email]);
  return { ...(await createSession(db, rows[0].id)), email: rows[0].email as string };
}

/** One-tap sign-in inside Telegram for owners and admins linked by Telegram ID. */
export async function telegramLogin(body: Record<string, unknown>) {
  const db = getPool();
  const tg = await requireTelegramUser(db, body.initData);
  await touchTelegramUser(db, tg.user);
  const a = await telegramAdmin(db, tg.user);
  if (!a) throw new HttpError(403, 'This Telegram account is not an admin. Ask an existing admin to add you.', 'not_admin');
  return { ...(await createSession(db, a.id)), email: a.email ?? '' };
}

/** Wraps an API handler that only signed-in admins may call. */
export const asAdmin = (h: (a: Admin, req: ApiRequest, params: string[]) => Promise<unknown>): Handler => async (req, params) => ok(await h(await requireAdmin(req), req, params));

export async function requireAdmin(req: ApiRequest): Promise<Admin> {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'Sign in to continue.', 'auth_required');
  const { rows } = await getPool().query(
    `update admin_sessions s set last_used_at = now()
       from admins a
      where s.token_hash = $1 and a.id = s.admin_id and s.revoked_at is null and s.expires_at > now()
      returning a.id, a.email, a.name, a.role, a.telegram_user_id, s.id as session_id`,
    [sha256(token)],
  );
  const r = rows[0];
  if (!r) throw new HttpError(401, 'Your session has expired. Sign in again.', 'auth_required');
  return { id: r.id, email: r.email, name: r.name, role: r.role, telegramUserId: r.telegram_user_id, sessionId: r.session_id };
}

export async function logout(admin: Admin) {
  await getPool().query('update admin_sessions set revoked_at = now() where id = $1', [admin.sessionId]);
  return { ok: true };
}

export async function audit(db: Db, adminId: string | null, action: string, entity: string, entityId: string | null, details: unknown) {
  await db.query('insert into audit_events (admin_id, action, entity, entity_id, details) values ($1, $2, $3, $4, $5)', [
    adminId, action, entity, entityId, JSON.stringify(details ?? {}),
  ]);
}

export async function adminMe(db: Db, admin: Admin): Promise<AdminMe> {
  const { rows } = await db.query('select notify_results, weekly_report from admins where id = $1', [admin.id]);
  return {
    id: admin.id, email: admin.email, name: admin.name, role: admin.role, telegramUserId: admin.telegramUserId,
    notifyResults: rows[0]?.notify_results ?? false, weeklyReport: rows[0]?.weekly_report ?? false,
  };
}

export async function updatePrefs(admin: Admin, body: Record<string, unknown>): Promise<AdminMe> {
  const db = getPool();
  await db.query('update admins set notify_results = $2, weekly_report = $3 where id = $1', [admin.id, body.notifyResults === true, body.weeklyReport === true]);
  return adminMe(db, admin);
}

/* ---------- Users & admin management ---------- */
// The Users screen also shows each person's latest Agent Academy result.

export async function listUsers(): Promise<AdminUser[]> {
  const { rows } = await getPool().query(
    `with ids as (
       select id as tg from telegram_users
       union select telegram_user_id from admins where telegram_user_id is not null
       union select telegram_user_id from candidates where telegram_user_id is not null
     )
     select ids.tg, tu.first_name, tu.last_name, tu.username, tu.started_bot, tu.blocked_bot, tu.first_seen_at, tu.last_seen_at,
            ad.id as admin_id, ad.role, ad.name as admin_name, ad.created_at as admin_since, adder.name as added_by_name,
            c.full_name as candidate_name,
            la.id as attempt_id, la.status, la.correct_count, la.total_questions, la.score_pct, la.pass_mark, la.submitted_at, la.started_at as attempt_started,
            (select count(*) from assessment_attempts x where x.candidate_id = c.id)::int as attempts
       from ids
       left join telegram_users tu on tu.id = ids.tg
       left join admins ad on ad.telegram_user_id = ids.tg
       left join admins adder on adder.id = ad.added_by
       left join candidates c on c.telegram_user_id = ids.tg
       left join lateral (select * from assessment_attempts a where a.candidate_id = c.id order by a.started_at desc limit 1) la on true
      order by coalesce(tu.last_seen_at, ad.created_at) desc nulls last`,
  );
  return rows.map((r) => ({
    telegramUserId: r.tg,
    name: fullName(r) || r.candidate_name || r.admin_name || null,
    username: r.username,
    candidateName: r.candidate_name,
    startedBot: !!r.started_bot,
    blockedBot: !!r.blocked_bot,
    firstSeenAt: r.first_seen_at?.toISOString() ?? null,
    lastSeenAt: r.last_seen_at?.toISOString() ?? null,
    admin: r.admin_id ? { id: r.admin_id, role: r.role, name: r.admin_name, since: r.admin_since.toISOString(), addedBy: r.added_by_name } : null,
    attempts: r.attempts ?? 0,
    latest: r.attempt_id
      ? {
          id: r.attempt_id, status: r.status, correct: r.correct_count, total: r.total_questions, pct: r.score_pct,
          passed: r.status === 'completed' ? r.correct_count >= r.pass_mark : null, at: (r.submitted_at ?? r.attempt_started).toISOString(),
        }
      : null,
  }));
}

export async function addAdmin(admin: Admin, body: Record<string, unknown>) {
  const id = Number(typeof body.telegramUserId === 'string' ? body.telegramUserId.trim() : body.telegramUserId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Enter a numeric Telegram user ID (e.g. 123456789).');
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ').slice(0, 80) || null : null;
  return tx(async (c) => {
    const { rows: tu } = await c.query("select trim(concat_ws(' ', first_name, last_name)) as n from telegram_users where id = $1", [id]);
    const { rows } = await c.query(
      `insert into admins (telegram_user_id, name, role, added_by) values ($1, $2, $3, $4)
       on conflict (telegram_user_id) do nothing returning id`,
      [id, name ?? (tu[0]?.n || null), env.ownerTelegramIds.includes(id) ? 'owner' : 'admin', admin.id],
    );
    if (!rows[0]) throw new HttpError(409, 'This Telegram account is already an admin.');
    await audit(c, admin.id, 'admin.add', 'admin', rows[0].id, { telegramUserId: id });
    return { ok: true, id: rows[0].id as string };
  });
}

export async function removeAdmin(admin: Admin, targetId: string) {
  if (!UUID_RE.test(targetId)) throw new HttpError(404, 'Admin not found.');
  if (admin.role !== 'owner') throw new HttpError(403, 'Only owners can remove admins.');
  if (targetId === admin.id) throw new HttpError(400, "You can't remove yourself.");
  return tx(async (c) => {
    const { rows } = await c.query('select role, telegram_user_id from admins where id = $1 for update', [targetId]);
    if (!rows[0]) throw new HttpError(404, 'Admin not found.');
    if (rows[0].role === 'owner' || env.ownerTelegramIds.includes(Number(rows[0].telegram_user_id))) {
      throw new HttpError(400, 'Owners are set in the server configuration (ADMIN_TELEGRAM_IDS) and can’t be removed here.');
    }
    await c.query('delete from admins where id = $1', [targetId]);
    await audit(c, admin.id, 'admin.remove', 'admin', targetId, { telegramUserId: rows[0].telegram_user_id });
    return { ok: true };
  });
}

/* ---------- Downloads ---------- */

export async function storeExport(admin: Admin, filename: string, contentType: string, content: Uint8Array) {
  const db = getPool();
  await db.query('delete from export_files where expires_at < now()');
  const token = newToken();
  await db.query(
    "insert into export_files (admin_id, token_hash, filename, content_type, content, expires_at) values ($1, $2, $3, $4, $5, now() + interval '10 minutes')",
    [admin.id, sha256(token), filename, contentType, Buffer.from(content)],
  );
  return { path: `/api/exports/${token}`, filename };
}

export async function createExport(admin: Admin, body: Record<string, unknown>) {
  const filename = typeof body.filename === 'string' ? body.filename : '';
  const content = typeof body.content === 'string' ? body.content : '';
  if (!/^[A-Za-z0-9._-]{1,120}\.csv$/.test(filename)) throw new HttpError(400, 'Invalid file name.');
  if (!content || content.length > 2_000_000) throw new HttpError(400, 'The export is empty or too large.');
  return storeExport(admin, filename, 'text/csv; charset=utf-8', Buffer.from('﻿' + content, 'utf8'));
}

export async function downloadExport(token: string) {
  const { rows } = await getPool().query('select filename, content_type, content from export_files where token_hash = $1 and expires_at > now()', [sha256(token)]);
  if (!rows[0]) throw new HttpError(404, 'This download link has expired. Export again.');
  return { contentType: rows[0].content_type as string, filename: rows[0].filename as string, content: rows[0].content as Buffer };
}
