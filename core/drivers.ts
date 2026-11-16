// Drivers: truck drivers who joined through a driver invite link. Their one permission is the route
// map (/route). Admins make driver links, and so can agents an admin allowed to (the 'drivers'
// permission in agents.permissions). A link works for anyone until it expires or is turned off.
// Who is what: admin (core/admins.ts) > agent (core/agents.ts) > driver > candidate (everyone else).
import { newToken, sha256 } from './crypto.js';
import { tx, type Db } from '../db_storage/db.js';
import { HttpError } from './http.js';
import { audit } from './admins.js';
import { botUsername, INVITE_HOURS } from './agents.js';
import { botApi, type TelegramUser } from './telegram.js';

export const DRIVER_INVITE_PREFIX = 'driver_';
/** The agents' permission to make driver links. */
export const DRIVER_PERMISSION = 'drivers';

/** Who makes or changes something: an admin (their id) or an agent (their Telegram id). */
export type Actor = { adminId: string; agentId?: undefined } | { agentId: number; adminId?: undefined };

export interface DriverRow {
  telegramUserId: number;
  name: string | null;
  username: string | null;
  joinedAt: string;
  /** The admin or agent who made the link they joined with. */
  invitedBy: string | null;
}

const tgName = (u: TelegramUser) => [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 80) || null;
export const driverInviteLink = (bot: string, token: string) => `https://t.me/${bot}?start=${DRIVER_INVITE_PREFIX}${token}`;

export async function isDriver(db: Db, telegramUserId: number): Promise<boolean> {
  const { rows } = await db.query('select 1 from map_drivers where telegram_user_id = $1', [telegramUserId]);
  return !!rows[0];
}

/** Whether an agent may make driver links. */
export async function canInviteDrivers(db: Db, agentId: number): Promise<boolean> {
  const { rows } = await db.query('select 1 from agents where telegram_user_id = $1 and $2 = any(permissions)', [agentId, DRIVER_PERMISSION]);
  return !!rows[0];
}

/** An admin lets an agent make driver links, or takes it back. Returns the agent's name, or null when not an agent. */
export async function setDriverPermission(db: Db, adminId: string, agentId: number, on: boolean): Promise<{ name: string | null } | null> {
  const { rows } = await db.query(
    `update agents set permissions = case when $2 then array(select distinct unnest(permissions || array[$3::text])) else array_remove(permissions, $3::text) end
      where telegram_user_id = $1 returning name`,
    [agentId, on, DRIVER_PERMISSION],
  );
  if (!rows[0]) return null;
  await audit(db, adminId, on ? 'agent.allow_drivers' : 'agent.disallow_drivers', 'agent', String(agentId), {});
  return { name: rows[0].name };
}

async function assertMayInvite(db: Db, by: Actor) {
  if (by.agentId != null && !(await canInviteDrivers(db, by.agentId))) throw new HttpError(403, 'Ask your CFT admin to let you invite drivers.');
}

/** A driver link anyone can join with for `hours`. */
export async function createDriverInvite(db: Db, by: Actor, hoursIn: unknown, labelIn: unknown) {
  await assertMayInvite(db, by);
  const hours = Number(hoursIn);
  if (!INVITE_HOURS.includes(hours as (typeof INVITE_HOURS)[number])) throw new HttpError(400, 'Choose how long the link works: 1 hour, 1 day, 3 days, 7 days or 30 days.');
  const label = typeof labelIn === 'string' ? labelIn.trim().replace(/\s+/g, ' ').slice(0, 80) || null : null;
  const token = newToken();
  const { rows } = await db.query(
    `insert into driver_invites (token_hash, label, created_by_admin, created_by_agent, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(hours => $5)) returning id, expires_at`,
    [sha256(token), label, by.adminId ?? null, by.agentId ?? null, hours],
  );
  await audit(db, by.adminId ?? null, 'driver.invite', 'driver_invite', rows[0].id, { label, hours, agent: by.agentId ?? null });
  return { id: rows[0].id as string, link: driverInviteLink(await botUsername(), token), expiresAt: (rows[0].expires_at as Date).toISOString(), label, hours };
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
  | { ok: false; reason: 'staff' | 'already' | 'invalid' };

/** Turns the person who opened a driver link into a driver. Admins and agents already have the map. */
export async function redeemDriverInvite(user: TelegramUser, token: string, isStaff: boolean): Promise<DriverRedeem> {
  if (isStaff) return { ok: false, reason: 'staff' };
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return { ok: false, reason: 'invalid' };
  return tx(async (c) => {
    const { rows } = await c.query(
      `select i.id, i.label, i.created_by_admin, coalesce(ad.telegram_user_id, i.created_by_agent) as inviter_chat
         from driver_invites i left join admins ad on ad.id = i.created_by_admin
        where i.token_hash = $1 and i.revoked_at is null and i.expires_at > now()
        for update of i`,
      [sha256(token)],
    );
    const inv = rows[0];
    if (!inv) return { ok: false, reason: 'invalid' };
    if (await isDriver(c, user.id)) return { ok: false, reason: 'already' };
    await c.query('insert into map_drivers (telegram_user_id, name, username, invite_id) values ($1, $2, $3, $4)', [user.id, tgName(user), user.username?.slice(0, 64) ?? null, inv.id]);
    await c.query('update driver_invites set uses = uses + 1 where id = $1', [inv.id]);
    await audit(c, inv.created_by_admin, 'driver.join', 'driver', String(user.id), { invite: inv.id });
    return { ok: true, inviterChat: inv.inviter_chat != null ? Number(inv.inviter_chat) : null, label: inv.label };
  });
}

export async function listDrivers(db: Db): Promise<{ drivers: DriverRow[]; links: number }> {
  const { rows } = await db.query(
    `select d.telegram_user_id, coalesce(nullif(trim(concat_ws(' ', tu.first_name, tu.last_name)), ''), d.name) as name,
            coalesce(tu.username, d.username) as username, d.joined_at, coalesce(ad.name, ag.name) as invited_by
       from map_drivers d
       left join telegram_users tu on tu.id = d.telegram_user_id
       left join driver_invites i on i.id = d.invite_id
       left join admins ad on ad.id = i.created_by_admin
       left join agents ag on ag.telegram_user_id = i.created_by_agent
      order by d.joined_at desc`,
  );
  const { rows: l } = await db.query('select count(*)::int as n from driver_invites where revoked_at is null and expires_at > now()');
  return {
    drivers: rows.map((r) => ({ telegramUserId: Number(r.telegram_user_id), name: r.name, username: r.username, joinedAt: r.joined_at.toISOString(), invitedBy: r.invited_by })),
    links: l[0].n,
  };
}

/** Removes a driver: they lose the route map at once and get the default menu back. */
export async function removeDriver(db: Db, adminId: string, telegramUserId: number): Promise<boolean> {
  const { rowCount } = await db.query('delete from map_drivers where telegram_user_id = $1', [telegramUserId]);
  if (!rowCount) return false;
  await audit(db, adminId, 'driver.remove', 'driver', String(telegramUserId), {});
  await botApi('setChatMenuButton', { chat_id: telegramUserId, menu_button: { type: 'default' } }).catch(() => {});
  await botApi('deleteMyCommands', { scope: { type: 'chat', chat_id: telegramUserId } }).catch(() => {});
  return true;
}
