// Drivers: truck drivers with the route map (/route), their one permission. They are approved through a
// request (support/helpers/driver-requests.ts), or joined through a driver link made before requests
// (those still work until they expire, or are turned off). Agents see all drivers and remove only those
// they brought. Who is what: admin (support/helpers/admins.ts) > agent (support/helpers/agents.ts) > driver > candidate (everyone else).
import { sha256 } from './crypto.js';
import { tx, type Db } from '../../database/db.js';
import { audit } from './admins.js';
import { botApi, storedName, type TelegramUser } from './telegram.js';
import { DRIVER_ORIGIN_COLS, DRIVER_ORIGIN_JOINS } from './driver-requests.js';

export const DRIVER_INVITE_PREFIX = 'driver_';

/** Who makes or changes something: an admin (their id) or an agent (their Telegram id). */
export type Actor = { adminId: string; agentId?: undefined } | { agentId: number; adminId?: undefined };

export interface DriverRow {
  telegramUserId: number;
  name: string | null;
  username: string | null;
  joinedAt: string;
  /** The admin or agent who made the link they joined with. */
  invitedBy: string | null;
  /** The agent who made that link (null when an admin made it). */
  invitedByAgent: number | null;
  /** Which link they came with (bot, website, or a driver link made before requests) and who approved them. */
  via: 'bot' | 'website' | 'link' | null;
  approvedBy: string | null;
}

export async function isDriver(db: Db, telegramUserId: number): Promise<boolean> {
  const { rows } = await db.query('select 1 from map_drivers where telegram_user_id = $1', [telegramUserId]);
  return !!rows[0];
}

/** Turns a driver link off. Admins can turn off any; an agent only their own. */
export async function revokeDriverInvite(db: Db, by: Actor, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `update driver_invites set revoked_at = now()
      where id = $1 and revoked_at is null and expires_at > now() and ($2::bigint is null or created_by_agent = $2)`,
    [id, by.agentId ?? null],
  );
  if (rowCount) await audit(db, by.adminId ?? null, 'driver.invite_revoke', 'driver_invite', id, { agent: by.agentId ?? null });
  return !!rowCount;
}

export type DriverRedeem =
  | { ok: true; inviterChat: number | null; label: string | null }
  | { ok: false; reason: 'staff' | 'already' | 'invalid' }
  /** An agent's link: the driver requests access, and an admin approves (support/helpers/driver-requests.ts). */
  | { ok: false; reason: 'request'; agentId: number };

/**
 * Turns the person who opened an admin's driver link into a driver. An agent's link (made before
 * requests) leads to a request instead. Admins and agents already have the map.
 */
export async function redeemDriverInvite(user: TelegramUser, token: string, isStaff: boolean): Promise<DriverRedeem> {
  if (isStaff) return { ok: false, reason: 'staff' };
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return { ok: false, reason: 'invalid' };
  return tx(async (c) => {
    const { rows } = await c.query(
      `select i.id, i.label, i.created_by_admin, i.created_by_agent, coalesce(ad.telegram_user_id, i.created_by_agent) as inviter_chat
         from driver_invites i left join admins ad on ad.id = i.created_by_admin
        where i.token_hash = $1 and i.revoked_at is null and i.expires_at > now()
        for update of i`,
      [sha256(token)],
    );
    const inv = rows[0];
    if (!inv) return { ok: false, reason: 'invalid' };
    if (await isDriver(c, user.id)) return { ok: false, reason: 'already' };
    if (inv.created_by_admin == null && inv.created_by_agent != null) return { ok: false, reason: 'request', agentId: Number(inv.created_by_agent) };
    await c.query('insert into map_drivers (telegram_user_id, name, username, invite_id) values ($1, $2, $3, $4)', [user.id, storedName(user), user.username?.slice(0, 64) ?? null, inv.id]);
    await c.query('update driver_invites set uses = uses + 1 where id = $1', [inv.id]);
    await audit(c, inv.created_by_admin, 'driver.join', 'driver', String(user.id), { invite: inv.id });
    return { ok: true, inviterChat: inv.inviter_chat != null ? Number(inv.inviter_chat) : null, label: inv.label };
  });
}

/** Every driver, and how many driver links are still open (only `agentId`'s own when given). */
export async function listDrivers(db: Db, agentId?: number): Promise<{ drivers: DriverRow[]; links: number }> {
  const { rows } = await db.query(
    `select d.telegram_user_id, coalesce(nullif(trim(concat_ws(' ', tu.first_name, tu.last_name)), ''), d.name) as name,
            coalesce(tu.username, d.username) as username, d.joined_at, ${DRIVER_ORIGIN_COLS}
       from map_drivers d
       left join telegram_users tu on tu.id = d.telegram_user_id
       ${DRIVER_ORIGIN_JOINS}
      order by d.joined_at desc`,
  );
  const { rows: l } = await db.query(
    'select count(*)::int as n from driver_invites where revoked_at is null and expires_at > now() and ($1::bigint is null or created_by_agent = $1)',
    [agentId ?? null],
  );
  return {
    drivers: rows.map((r) => ({
      telegramUserId: Number(r.telegram_user_id), name: r.name, username: r.username, joinedAt: r.joined_at.toISOString(), invitedBy: r.invited_by,
      invitedByAgent: r.invited_by_agent != null ? Number(r.invited_by_agent) : null, via: r.via, approvedBy: r.approved_by,
    })),
    links: l[0].n,
  };
}

/**
 * Removes a driver: they lose the route map at once and get the default menu back. Admins remove
 * anyone; an agent only a driver who joined through one of their own links.
 */
export async function removeDriver(db: Db, by: Actor, telegramUserId: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `delete from map_drivers where telegram_user_id = $1
        and ($2::bigint is null or invite_id in (select id from driver_invites where created_by_agent = $2)
             or request_id in (select id from driver_requests where ref_agent = $2))`,
    [telegramUserId, by.agentId ?? null],
  );
  if (!rowCount) return false;
  await audit(db, by.adminId ?? null, 'driver.remove', 'driver', String(telegramUserId), { agent: by.agentId ?? null });
  await botApi('setChatMenuButton', { chat_id: telegramUserId, menu_button: { type: 'default' } }).catch(() => {});
  await botApi('deleteMyCommands', { scope: { type: 'chat', chat_id: telegramUserId } }).catch(() => {});
  return true;
}
