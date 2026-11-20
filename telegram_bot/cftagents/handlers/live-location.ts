import { DRIVER_MAP } from '../../../support/common/driver-config.js';
import type { Db } from '../../../database/db.js';
import { botApi, type TelegramUpdate } from '../../../support/helpers/telegram.js';
import { liveLocationAlert } from '../../../tools/driver-map/alerts.js';
import { viewerOf } from './viewer.js';

// A location shared in the private chat with the bot. Live location: the bot alerts the driver when
// a CFT station is coming up ahead (tools/driver-map/alerts.ts). For people who may use the route
// map (drivers, agents, admins); everyone else is ignored. Telegram sends the live updates as
// edited messages: telegram:setup must list "edited_message" in allowed_updates.

const ON = `📍 <b>Live location on.</b> I'll message you when a CFT station is within ${DRIVER_MAP.alerts.aheadMi} mi ahead of you. Stop sharing in Telegram to turn this off.`;
const HOW = '📍 To get alerts on the road, share your <b>live</b> location here: 📎 → Location → Share My Live Location.';

/** Handles a shared location (start or update). True when the update was a location (handled or ignored). */
export async function liveLocation(db: Db, update: TelegramUpdate): Promise<boolean> {
  const msg = update.edited_message ?? update.message;
  const loc = msg?.location;
  if (!msg || !loc || !msg.from || msg.chat?.type !== 'private') return false;
  const who = await viewerOf(db, msg.from, update.update_id);
  if (!who.admin && !who.agent && !who.driver) return true;
  const chat_id = msg.chat.id;
  const isUpdate = !!update.edited_message;
  try {
    if (!isUpdate) {
      // A plain (not live) location: explain how to turn alerts on.
      if (!loc.live_period) {
        await botApi('sendMessage', { chat_id, text: HOW, parse_mode: 'HTML' });
        return true;
      }
      await botApi('sendMessage', { chat_id, text: ON, parse_mode: 'HTML' });
    }
    const text = await liveLocationAlert(db, msg.from.id, { lat: loc.latitude, lng: loc.longitude, heading: loc.heading ?? null });
    if (text) await botApi('sendMessage', { chat_id, text, parse_mode: 'HTML' });
  } catch (e) {
    console.error('live location failed', (e as Error).message);
  }
  return true;
}
