// The website's sign-in (fuel.cftransportllc.com), confirmed in the bot: the page asks for a one-time code,
// opens the bot with it, the person taps Confirm there, and the page exchanges the code for a session.
// The session is the same Telegram person as in the Mini App, so it gives exactly the same rights: their
// role is checked on every request, so removing someone locks them out at once. Only hashes are stored.
import type { Db } from '../../database/db.js';
import { newToken, sha256 } from './crypto.js';
import { HttpError } from './http.js';
import { requireInitData, type TelegramUser, type VerifiedInitData } from './telegram.js';

/** A login code works this long after the page asked for it. */
const CODE_MINUTES = 10;
/** A session lasts this long since it was last used. */
export const SESSION_DAYS = 30;
/** Sessions are sent where Telegram's initData goes, with this prefix (support/helpers/telegram.ts). */
export const SESSION_PREFIX = 'cftweb.';
export const LOGIN_PREFIX = 'login_';
const CODE_RE = /^[A-Za-z0-9_-]{20,64}$/;

/** A new login code. The bot link that confirms it is t.me/<bot>?start=login_<code>. */
export async function startWebLogin(db: Db): Promise<string> {
  const code = newToken().slice(0, 32);
  await db.query('insert into web_logins (code_hash) values ($1)', [sha256(code)]);
  if (Math.random() < 0.05) await db.query(`delete from web_logins where created_at < now() - interval '1 day'`).catch(() => {});
  return code;
}

/** In the bot, after Confirm: ties the code to this person. False when the code expired or was used. */
export async function confirmWebLogin(db: Db, user: TelegramUser, code: string): Promise<boolean> {
  if (!CODE_RE.test(code)) return false;
  const { rowCount } = await db.query(
    `update web_logins set telegram_user_id = $2, confirmed_at = now()
      where code_hash = $1 and confirmed_at is null and created_at > now() - make_interval(mins => $3)`,
    [sha256(code), user.id, CODE_MINUTES],
  );
  return !!rowCount;
}

/** The page asks: still waiting, expired, or confirmed (then once: the session). */
export async function pollWebLogin(db: Db, code: string): Promise<{ status: 'waiting' | 'expired' } | { status: 'ok'; session: string }> {
  if (!CODE_RE.test(code)) return { status: 'expired' };
  const { rows } = await db.query(
    `update web_logins set used_at = now()
      where code_hash = $1 and confirmed_at is not null and used_at is null and created_at > now() - make_interval(mins => $2)
      returning telegram_user_id`,
    [sha256(code), CODE_MINUTES],
  );
  if (rows[0]) {
    const token = newToken();
    await db.query(
      `insert into web_sessions (token_hash, telegram_user_id, expires_at) values ($1, $2, now() + make_interval(days => $3))`,
      [sha256(token), rows[0].telegram_user_id, SESSION_DAYS],
    );
    return { status: 'ok', session: SESSION_PREFIX + token };
  }
  const { rows: w } = await db.query(
    `select 1 from web_logins where code_hash = $1 and used_at is null and created_at > now() - make_interval(mins => $2)`,
    [sha256(code), CODE_MINUTES],
  );
  return { status: w[0] ? 'waiting' : 'expired' };
}

/** The person behind a website session, or null. Each use renews it for another SESSION_DAYS. */
export async function sessionUser(db: Db, session: string): Promise<TelegramUser | null> {
  const token = session.startsWith(SESSION_PREFIX) ? session.slice(SESSION_PREFIX.length) : '';
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
  const { rows } = await db.query(
    `update web_sessions s set last_seen_at = now(), expires_at = now() + make_interval(days => $2)
       from (select token_hash from web_sessions where token_hash = $1 and expires_at > now()) x
      where s.token_hash = x.token_hash
      returning s.telegram_user_id,
        (select first_name from telegram_users where id = s.telegram_user_id) as first_name,
        (select last_name from telegram_users where id = s.telegram_user_id) as last_name,
        (select username from telegram_users where id = s.telegram_user_id) as username`,
    [sha256(token), SESSION_DAYS],
  );
  const r = rows[0];
  if (!r) return null;
  return { id: Number(r.telegram_user_id), first_name: r.first_name ?? undefined, last_name: r.last_name ?? undefined, username: r.username ?? undefined };
}

/**
 * The person behind a request: Telegram's signed initData inside the Mini App, or a website session
 * (both arrive in the same place). Every check of "who is asking" goes through here.
 */
export async function requireTelegramUser(db: Db, value: unknown): Promise<VerifiedInitData> {
  if (typeof value === 'string' && value.startsWith(SESSION_PREFIX)) {
    const user = await sessionUser(db, value);
    if (!user) throw new HttpError(401, 'Your sign-in has expired. Log in again on the website.', 'telegram_auth');
    return { user, authDate: Math.floor(Date.now() / 1000), startParam: null };
  }
  return requireInitData(value);
}

/** Logging out on the website ends that session only. */
export async function endWebSession(db: Db, session: string): Promise<void> {
  const token = session.startsWith(SESSION_PREFIX) ? session.slice(SESSION_PREFIX.length) : '';
  if (token) await db.query('delete from web_sessions where token_hash = $1', [sha256(token)]);
}
