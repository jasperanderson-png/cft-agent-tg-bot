// Agents: people who joined through an admin's invite link (anyone with the link can join until it
// expires or is turned off). Today their one permission is
// searching fuel discounts. Who is what: admin (support/helpers/admins.ts) > agent > visitor (everyone else).
import { newToken, sha256 } from './crypto.js';
import { tx, type Db } from '../../database/db.js';
import { env } from './env.js';
import { HttpError } from './http.js';
import { audit, type Admin } from './admins.js';
import { botApi, storedName, type TelegramUser } from './telegram.js';

export const INVITE_PREFIX = 'agent_';
/** How long a new link may work, in hours: the choices admins get. */
export const INVITE_HOURS = [1, 24, 72, 168, 720] as const;
export const DEFAULT_INVITE_HOURS = 168;

export interface AgentRow {
  telegramUserId: number;
  name: string | null;
  username: string | null;
  joinedAt: string;
  invitedBy: string | null;
  inviteLabel: string | null;
  lastSeenAt: string | null;
}

export interface InviteRow {
  id: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  createdBy: string | null;
  /** How many people joined with it so far. */
  uses: number;
}


export async function isAgent(db: Db, telegramUserId: number): Promise<boolean> {
  const { rows } = await db.query("select 1 from agents where telegram_user_id = $1 and 'discounts' = any(permissions)", [telegramUserId]);
  return !!rows[0];
}

/** The agent's own details, for the Mini App profile. */
export async function agentProfile(db: Db, telegramUserId: number): Promise<{ since: string; invitedBy: string | null } | null> {
  const { rows } = await db.query(
    'select a.joined_at, ad.name as invited_by from agents a left join admins ad on ad.id = a.invited_by where a.telegram_user_id = $1',
    [telegramUserId],
  );
  return rows[0] ? { since: rows[0].joined_at.toISOString(), invitedBy: rows[0].invited_by } : null;
}

let cachedUsername: string | null = null;
/** The bot's @username, for t.me links: TELEGRAM_BOT_USERNAME, or asked from Telegram once. */
export async function botUsername(): Promise<string> {
  if (env.botUsername) return env.botUsername;
  if (cachedUsername) return cachedUsername;
  const me = (await botApi('getMe', {})) as { username?: string };
  if (!me.username) throw new HttpError(503, 'Could not find the bot’s username. Set TELEGRAM_BOT_USERNAME.');
  return (cachedUsername = me.username);
}

export const inviteLink = (bot: string, token: string) => `https://t.me/${bot}?start=${INVITE_PREFIX}${token}`;

/** Creates an invite link anyone can join with for `hours` (until an admin turns it off). */
export async function createInvite(db: Db, adminId: string, hoursIn: unknown, labelIn: unknown) {
  const hours = Number(hoursIn ?? DEFAULT_INVITE_HOURS);
  if (!INVITE_HOURS.includes(hours as (typeof INVITE_HOURS)[number])) throw new HttpError(400, 'Choose how long the link works: 1 hour, 1 day, 3 days, 7 days or 30 days.');
  const label = typeof labelIn === 'string' ? labelIn.trim().replace(/\s+/g, ' ').slice(0, 80) || null : null;
  const token = newToken();
  const { rows } = await db.query(
    `insert into agent_invites (token_hash, label, created_by, expires_at) values ($1, $2, $3, now() + make_interval(hours => $4)) returning id, expires_at`,
    [sha256(token), label, adminId, hours],
  );
  await audit(db, adminId, 'agent.invite', 'agent_invite', rows[0].id, { label, hours });
  return { id: rows[0].id as string, link: inviteLink(await botUsername(), token), expiresAt: (rows[0].expires_at as Date).toISOString(), label, hours };
}

export async function revokeInvite(admin: Pick<Admin, 'id'>, id: string) {
  const { rowCount } = await tx(async (c) => {
    const r = await c.query('update agent_invites set revoked_at = now() where id = $1 and revoked_at is null and expires_at > now()', [id]);
    if (r.rowCount) await audit(c, admin.id, 'agent.invite_revoke', 'agent_invite', id, {});
    return r;
  });
  if (!rowCount) throw new HttpError(404, 'This link has already expired, was turned off or does not exist.');
  return { ok: true };
}

export type RedeemResult =
  | { ok: true; inviterChat: number | null; label: string | null }
  | { ok: false; reason: 'admin' | 'already' | 'invalid' };

/**
 * Turns the person who opened an invite link into an agent. A link works for anyone until it expires
 * or an admin turns it off; each new agent is counted on it.
 */
export async function redeemInvite(user: TelegramUser, token: string, isAdmin: boolean): Promise<RedeemResult> {
  if (isAdmin) return { ok: false, reason: 'admin' };
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return { ok: false, reason: 'invalid' };
  return tx(async (c) => {
    const { rows } = await c.query(
      `select i.id, i.label, i.created_by, ad.telegram_user_id as inviter_chat
         from agent_invites i left join admins ad on ad.id = i.created_by
        where i.token_hash = $1 and i.revoked_at is null and i.expires_at > now()
        for update of i`,
      [sha256(token)],
    );
    const inv = rows[0];
    if (!inv) return { ok: false, reason: 'invalid' };
    if (await isAgent(c, user.id)) return { ok: false, reason: 'already' };
    await c.query(
      `insert into agents (telegram_user_id, name, username, invite_id, invited_by) values ($1, $2, $3, $4, $5)
       on conflict (telegram_user_id) do update set permissions = '{discounts}', name = excluded.name, username = excluded.username,
         invite_id = excluded.invite_id, invited_by = excluded.invited_by, joined_at = now()`,
      [user.id, storedName(user), user.username?.slice(0, 64) ?? null, inv.id, inv.created_by],
    );
    await c.query('update agent_invites set used_at = now(), used_by = $2, uses = uses + 1 where id = $1', [inv.id, user.id]);
    await audit(c, inv.created_by, 'agent.join', 'agent', String(user.id), { invite: inv.id });
    return { ok: true, inviterChat: inv.inviter_chat ?? null, label: inv.label };
  });
}

export async function listAgents(db: Db): Promise<{ agents: AgentRow[]; invites: InviteRow[] }> {
  const { rows } = await db.query(
    `select a.telegram_user_id, coalesce(nullif(trim(concat_ws(' ', tu.first_name, tu.last_name)), ''), a.name) as name,
            coalesce(tu.username, a.username) as username, a.joined_at, ad.name as invited_by, i.label, tu.last_seen_at
       from agents a
       left join telegram_users tu on tu.id = a.telegram_user_id
       left join admins ad on ad.id = a.invited_by
       left join agent_invites i on i.id = a.invite_id
      order by a.joined_at desc`,
  );
  const { rows: inv } = await db.query(
    `select i.id, i.label, i.created_at, i.expires_at, i.uses, ad.name as created_by
       from agent_invites i left join admins ad on ad.id = i.created_by
      where i.revoked_at is null and i.expires_at > now()
      order by i.created_at desc`,
  );
  return {
    agents: rows.map((r) => ({
      telegramUserId: Number(r.telegram_user_id), name: r.name, username: r.username, joinedAt: r.joined_at.toISOString(),
      invitedBy: r.invited_by, inviteLabel: r.label, lastSeenAt: r.last_seen_at?.toISOString() ?? null,
    })),
    invites: inv.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString(), createdBy: r.created_by, uses: r.uses })),
  };
}

/** Removes an agent. They become a visitor again: their menu button and commands go back to the defaults. */
export async function removeAgent(admin: Pick<Admin, 'id'>, telegramUserId: number) {
  if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) throw new HttpError(404, 'Agent not found.');
  const removed = await tx(async (c) => {
    const { rows } = await c.query('delete from agents where telegram_user_id = $1 returning name', [telegramUserId]);
    if (rows[0]) await audit(c, admin.id, 'agent.remove', 'agent', String(telegramUserId), {});
    return rows[0];
  });
  if (!removed) throw new HttpError(404, 'Agent not found.');
  await botApi('setChatMenuButton', { chat_id: telegramUserId, menu_button: { type: 'default' } }).catch(() => {});
  await botApi('deleteMyCommands', { scope: { type: 'chat', chat_id: telegramUserId } }).catch(() => {});
  return { ok: true };
}
