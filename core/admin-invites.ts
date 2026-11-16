// Admin invite links: an owner sends one, the person opens it and taps Start, and they are a CFT
// admin. Each link works for ONE person (an admin sees every lead and the real fuel prices, so a
// forwarded link must not make several), until it expires or an owner turns it off.
import { newToken, sha256 } from './crypto.js';
import { tx, type Db } from '../db_storage/db.js';
import { env } from './env.js';
import { HttpError } from './http.js';
import { audit } from './admins.js';
import { botUsername } from './agents.js';
import type { TelegramUser } from './telegram.js';

export const ADMIN_INVITE_PREFIX = 'admin_';
/** How long a new admin link may work, in hours. */
export const ADMIN_INVITE_HOURS = [1, 24, 72, 168] as const;

const tgName = (u: TelegramUser) => [u.first_name, u.last_name].filter(Boolean).join(' ').slice(0, 80) || null;
export const adminInviteLink = (bot: string, token: string) => `https://t.me/${bot}?start=${ADMIN_INVITE_PREFIX}${token}`;

export async function createAdminInvite(db: Db, ownerId: string, hoursIn: unknown, labelIn: unknown) {
  const hours = Number(hoursIn);
  if (!ADMIN_INVITE_HOURS.includes(hours as (typeof ADMIN_INVITE_HOURS)[number])) throw new HttpError(400, 'Choose how long the link works: 1 hour, 1 day, 3 days or 7 days.');
  const label = typeof labelIn === 'string' ? labelIn.trim().replace(/\s+/g, ' ').slice(0, 80) || null : null;
  const token = newToken();
  const { rows } = await db.query(
    `insert into admin_invites (token_hash, label, created_by, expires_at) values ($1, $2, $3, now() + make_interval(hours => $4)) returning id, expires_at`,
    [sha256(token), label, ownerId, hours],
  );
  await audit(db, ownerId, 'admin.invite', 'admin_invite', rows[0].id, { label, hours });
  return { id: rows[0].id as string, link: adminInviteLink(await botUsername(), token), expiresAt: (rows[0].expires_at as Date).toISOString(), label, hours };
}

export async function revokeAdminInvite(db: Db, ownerId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query('update admin_invites set revoked_at = now() where id = $1 and revoked_at is null and used_at is null and expires_at > now()', [id]);
  if (rowCount) await audit(db, ownerId, 'admin.invite_revoke', 'admin_invite', id, {});
  return !!rowCount;
}

export type AdminRedeem = { ok: true; inviterChat: number | null; label: string | null } | { ok: false; reason: 'already' | 'invalid' };

/** Makes the person who opened an admin link an admin. The link is used up. */
export async function redeemAdminInvite(user: TelegramUser, token: string, isAdmin: boolean): Promise<AdminRedeem> {
  if (isAdmin || env.ownerTelegramIds.includes(user.id)) return { ok: false, reason: 'already' };
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return { ok: false, reason: 'invalid' };
  return tx(async (c) => {
    const { rows } = await c.query(
      `select i.id, i.label, i.created_by, ad.telegram_user_id as inviter_chat
         from admin_invites i left join admins ad on ad.id = i.created_by
        where i.token_hash = $1 and i.revoked_at is null and i.used_at is null and i.expires_at > now()
        for update of i`,
      [sha256(token)],
    );
    const inv = rows[0];
    if (!inv) return { ok: false, reason: 'invalid' };
    const { rows: added } = await c.query(
      `insert into admins (telegram_user_id, name, role, added_by) values ($1, $2, 'admin', $3)
       on conflict (telegram_user_id) do nothing returning id`,
      [user.id, tgName(user), inv.created_by],
    );
    if (!added[0]) return { ok: false, reason: 'already' };
    // An agent who becomes an admin keeps nothing of the agent role: admins see everything agents do.
    await c.query('delete from agents where telegram_user_id = $1', [user.id]);
    await c.query('update admin_invites set used_at = now(), used_by = $2 where id = $1', [inv.id, user.id]);
    await audit(c, inv.created_by, 'admin.join', 'admin', added[0].id, { invite: inv.id, telegramUserId: user.id });
    return { ok: true, inviterChat: inv.inviter_chat ? Number(inv.inviter_chat) : null, label: inv.label };
  });
}

export interface AdminListRow {
  id: string;
  name: string | null;
  username: string | null;
  role: 'owner' | 'admin';
  telegramUserId: number | null;
  since: string;
}
export async function listAdmins(db: Db): Promise<{ admins: AdminListRow[]; links: { id: string; label: string | null; expiresAt: string }[] }> {
  const { rows } = await db.query(
    `select a.id, coalesce(nullif(trim(concat_ws(' ', tu.first_name, tu.last_name)), ''), a.name, a.email) as name, tu.username, a.role,
            a.telegram_user_id, a.created_at
       from admins a left join telegram_users tu on tu.id = a.telegram_user_id
      order by (a.role = 'owner') desc, a.created_at`,
  );
  const { rows: links } = await db.query(
    'select id, label, expires_at from admin_invites where revoked_at is null and used_at is null and expires_at > now() order by created_at desc',
  );
  return {
    admins: rows.map((r) => ({ id: r.id, name: r.name, username: r.username, role: r.role, telegramUserId: r.telegram_user_id == null ? null : Number(r.telegram_user_id), since: r.created_at.toISOString() })),
    links: links.map((r) => ({ id: r.id, label: r.label, expiresAt: r.expires_at.toISOString() })),
  };
}
