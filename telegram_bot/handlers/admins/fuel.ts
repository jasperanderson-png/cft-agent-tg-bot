import type { Db } from '../../../db_storage/db.js';
import { SECTION } from '../../../core/home.js';
import type { PrivateMessage } from '../../../core/telegram.js';
import { firstSight } from '../../../core/updates.js';
import { sendFuelPrices } from '../../../tools/fuel-prices/export.js';

// The 📥 Download All Fuel Prices button and /fuelprices, for admins. Everyone else is refused in
// ../not-allowed.ts.

export const FUEL_BUTTON = SECTION.fuel;
export const FUEL_COMMAND = { command: 'fuelprices', description: 'Fuel: download all fuel prices' };
export const FUEL_HELP = "⛽ <b>Fuel discounts</b>\n/fuelprices — download every station's prices (also updates what agents see)\nType a state or station to see the agents' prices.";

/** Button text as typed or tapped: no emoji, punctuation or case. */
const canon = (s: string) => s.replace(/[^A-Za-z ]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();

export function isFuelRequest(msg: PrivateMessage): boolean {
  const t = msg.text?.trim();
  if (!t) return false;
  if (t.startsWith('/')) return t.split(/\s+/)[0].split('@')[0].toLowerCase() === '/' + FUEL_COMMAND.command;
  return canon(t) === canon(FUEL_BUTTON);
}

export async function fuelMessage(db: Db, msg: PrivateMessage, updateId: number | undefined): Promise<boolean> {
  if (!isFuelRequest(msg)) return false;
  if (!(await firstSight(db, updateId))) return true; // Telegram retried the same click
  await sendFuelPrices(db, msg.chat.id);
  return true;
}
