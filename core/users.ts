import type { Db } from '../db_storage/db.js';
import type { TelegramUser } from './telegram.js';

/** Records a Telegram account for the admin Users list. `startedBot` marks that the bot can message them. */
export async function touchTelegramUser(db: Db, u: TelegramUser, opts: { startedBot?: boolean; blocked?: boolean } = {}) {
  await db.query(
    `insert into telegram_users (id, first_name, last_name, username, language_code, started_bot, blocked_bot)
     values ($1, $2, $3, $4, $5, coalesce($6, false), coalesce($7, false))
     on conflict (id) do update set
       first_name = coalesce(excluded.first_name, telegram_users.first_name),
       last_name = excluded.last_name,
       username = excluded.username,
       language_code = coalesce(excluded.language_code, telegram_users.language_code),
       started_bot = telegram_users.started_bot or coalesce($6, false),
       blocked_bot = coalesce($7, case when $6 then false else telegram_users.blocked_bot end),
       last_seen_at = now()`,
    [u.id, u.first_name?.slice(0, 80) ?? null, u.last_name?.slice(0, 80) ?? null, u.username?.slice(0, 64) ?? null, u.language_code?.slice(0, 10) ?? null, opts.startedBot ?? null, opts.blocked ?? null],
  );
}
