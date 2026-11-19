import type { Db } from '../../database/db.js';

// Helpers every part of the bot uses when it answers a Telegram update.

/**
 * Telegram retries a webhook call that is slow to answer. Actions that send files or change data
 * call this first: true the first time an update is seen, false for a retry of the same update.
 */
export async function firstSight(db: Db, updateId: number | undefined): Promise<boolean> {
  if (!Number.isSafeInteger(updateId)) return true;
  const { rows } = await db.query('insert into bot_updates (update_id) values ($1) on conflict do nothing returning 1', [updateId]);
  if (Math.random() < 0.02) await db.query(`delete from bot_updates where received_at < now() - interval '2 days'`).catch(() => {});
  return !!rows[0];
}

/** The time zone dates in files and messages are shown in (Settings in the admin console). */
export async function reportTimeZone(db: Db): Promise<string> {
  const { rows } = await db.query('select timezone from app_settings where id = 1');
  return rows[0]?.timezone ?? 'Asia/Tashkent';
}
