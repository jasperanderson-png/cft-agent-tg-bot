import { telegramAdmin } from '../../support/helpers/admins.js';
import { isAgent } from '../../support/helpers/agents.js';
import { isDriver } from '../../support/helpers/drivers.js';
import type { Db } from '../../database/db.js';
import { env } from '../../support/helpers/env.js';
import type { PrivateCallback, PrivateMessage, TelegramUser } from '../../support/helpers/telegram.js';

/** Who sent an update. Decides which folder of telegram_bot/handlers/ answers it. */
export interface Viewer {
  /** A CFT administrator (support/helpers/admins.ts). */
  admin: boolean;
  /** One of the owners (ADMIN_TELEGRAM_IDS). */
  owner: boolean;
  /** An agent (joined through an invite link; support/helpers/agents.ts). Admins are never also counted as agents. */
  agent: boolean;
  /** A driver (joined through a driver link; support/helpers/drivers.ts): the route map only. Never also an admin or agent. */
  driver?: boolean;
  /** Telegram's id for the update, used to run file-sending actions once. */
  updateId?: number;
}

export type Role = 'admins' | 'agents' | 'drivers' | 'candidates';

export async function viewerOf(db: Db, from: TelegramUser, updateId: number | undefined): Promise<Viewer> {
  const admin = !!(await telegramAdmin(db, from));
  const agent = !admin && (await isAgent(db, from.id));
  const driver = !admin && !agent && (await isDriver(db, from.id));
  return { admin, owner: env.ownerTelegramIds.includes(from.id), agent, driver, updateId };
}

export const roleOf = (who: Viewer): Role => (who.admin ? 'admins' : who.agent ? 'agents' : who.driver ? 'drivers' : 'candidates');

/**
 * What is recorded in telegram_users.menu_role once a role's menu is set. Change a role's value when
 * its menu changes: everyone with that role gets the new menu on their next message.
 */
export const menuKey = (role: Role): string => (role === 'agents' ? 'agents.2' : role); // .2: driver commands for every agent

/** One role's part of the bot: telegram_bot/handlers/<role>/index.ts. */
export interface RoleHandlers {
  /** Answers a private message (or stays quiet when it means nothing to this role). */
  message(db: Db, msg: PrivateMessage, who: Viewer): Promise<void>;
  /** Answers a tap on an inline button. False when no handler claimed it. */
  callback(db: Db, cb: PrivateCallback, who: Viewer): Promise<boolean>;
  /** Sets this role's menu button and command menu in a chat. Throws when Telegram refuses, so it is tried again. */
  menu(chatId: number, who: Viewer): Promise<void>;
}

/** The command a message starts with ("/report week" → "/report"), lower-case, without @botname. */
export const commandOf = (text: string | undefined) => (text?.trim().split(/\s+/)[0] ?? '').split('@')[0].toLowerCase();
