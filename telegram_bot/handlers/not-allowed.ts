import { botApi, type PrivateCallback, type PrivateMessage } from '../../support/helpers/telegram.js';
import { NOT_AUTHORIZED } from '../../tools/driver-leads/messages.js';
import { ADMINS_ONLY as INDEED_ADMINS_ONLY } from '../../tools/indeed-applicants/messages.js';
import { DISCOUNT_CALLBACK } from '../../tools/fuel-prices/agent-prices.js';
import { isFuelRequest } from './admins/fuel.js';
import { INDEED_CALLBACK, isIndeedRequest } from './admins/indeed.js';
import { LEADS_CALLBACK, parseAction } from './admins/leads.js';
import { ADMIN_TEAM_CALLBACK } from './admins/team/admins.js';
import { SHIFT_CALLBACK } from './admins/shift.js';
import { TEAM_CALLBACK } from './admins/team/agents.js';
import { DRIVER_CALLBACK } from './driver-invites.js';

// Polite refusals, for people who type or tap something their role doesn't have (an agent pressing
// an old Driver Leads button, a candidate typing /fuelprices…). The real handlers live in the
// role folders; this file only recognises their buttons and commands and says no.

const say = (chat_id: number, text: string) => botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true });
const answer = (cb: PrivateCallback, text: string) => botApi('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {});

/** Admin-only buttons and commands, from someone who is not an admin. True when refused. */
export async function refuseAdminMessage(msg: PrivateMessage): Promise<boolean> {
  const leads = parseAction(msg);
  if (leads) {
    // Stay quiet about files from people who are not admins; answer commands and typed button names.
    if (leads.t !== 'import') await say(msg.chat.id, NOT_AUTHORIZED);
    return true;
  }
  if (isFuelRequest(msg)) {
    await say(msg.chat.id, '⛽ Fuel prices are for CFT administrators only.');
    return true;
  }
  if (isIndeedRequest(msg)) {
    await say(msg.chat.id, INDEED_ADMINS_ONLY);
    return true;
  }
  return false;
}

/** Taps on admin-only inline buttons. True when refused. */
export async function refuseAdminCallback(cb: PrivateCallback): Promise<boolean> {
  if (cb.data.startsWith(LEADS_CALLBACK)) await answer(cb, NOT_AUTHORIZED.replace(/<[^>]+>/g, ''));
  else if (cb.data.startsWith(INDEED_CALLBACK)) await answer(cb, INDEED_ADMINS_ONLY);
  else if (cb.data.startsWith(DRIVER_CALLBACK)) await answer(cb, 'For CFT admins and agents only.'); // agents have the driver links too
  else if (cb.data.startsWith(TEAM_CALLBACK) || cb.data.startsWith(SHIFT_CALLBACK) || cb.data.startsWith(ADMIN_TEAM_CALLBACK)) await answer(cb, 'For CFT administrators only.');
  else return false;
  return true;
}

/** Taps on the agents' price buttons, from someone who is not an agent. True when refused. */
export async function refuseAgentCallback(cb: PrivateCallback): Promise<boolean> {
  if (!cb.data.startsWith(DISCOUNT_CALLBACK)) return false;
  await answer(cb, 'Fuel discounts are for CFT agents.');
  return true;
}
