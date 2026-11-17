import { escHtml as esc } from '../../shared/html.js';
import { BRANDS, headingDeg, milesBetween, payPrice, savingOf, type LatLng } from '../../shared/driver-route.js';
import { DRIVER_MAP } from '../../shared/driver-config.js';
import { titleCase } from '../../shared/discounts.js';
import type { DriverStation } from '../../shared/types.js';
import type { Db } from '../../db_storage/db.js';
import { firstTime, getJson, putJson } from '../../core/kv.js';
import { driverStations } from './stations.js';

// Alerts on the road: a driver shares their live location in the bot chat, Telegram sends a new
// position every few seconds to minutes, and when the nearest CFT partner station ahead is within
// DRIVER_MAP.alerts.aheadMi the bot says so, once per station (not again for repeatHours).
// "Ahead" means within coneDeg of the direction of travel: the phone's heading when Telegram sends
// one, else the direction from the previous position. Who may get alerts: telegram_bot/handlers.

export interface LiveFix extends LatLng {
  /** Direction of travel from the phone (degrees, 1–360), when Telegram sends one. */
  heading?: number | null;
}

const angleBetween = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** The direction of travel: the phone's heading, else from the previous position if the truck moved enough. */
export function travelHeading(fix: LiveFix, prev: LatLng | null, minMoveMi: number = DRIVER_MAP.alerts.minMoveMi): number | null {
  if (fix.heading != null && fix.heading > 0 && fix.heading <= 360) return fix.heading % 360;
  if (!prev || milesBetween(prev, fix) < minMoveMi) return null;
  return headingDeg(prev, fix);
}

/** The nearest station with a map point that lies ahead (within the cone) and within reach of an alert. */
export function nextStationAhead<T extends { lat: number | null; lng: number | null }>(
  stations: T[],
  here: LatLng,
  heading: number,
  { aheadMi, coneDeg }: { aheadMi: number; coneDeg: number } = DRIVER_MAP.alerts,
): { station: T; mi: number } | null {
  let best: { station: T; mi: number } | null = null;
  for (const s of stations) {
    if (s.lat == null || s.lng == null) continue;
    const p = { lat: s.lat, lng: s.lng };
    const mi = milesBetween(here, p);
    // Already there (or just passed): not "ahead".
    if (mi > aheadMi || mi < 0.25) continue;
    if (angleBetween(headingDeg(here, p), heading) > coneDeg) continue;
    if (!best || mi < best.mi) best = { station: s, mi };
  }
  return best;
}

/** The alert message (HTML): the station, how far, and the driver's CFT price. */
export function alertText(s: DriverStation, mi: number): string {
  const price = payPrice(s);
  const save = savingOf(s);
  const where = [titleCase(s.city ?? ''), s.state].filter(Boolean).join(', ');
  return [
    `⛽ <b>CFT station ahead: ${esc(s.station)}</b>`,
    `${esc(BRANDS[s.brand].label)}${where ? ' · ' + esc(where) : ''} · about ${Math.max(1, Math.round(mi))} mi`,
    price != null ? `Your price: <b>$${price.toFixed(2)}/gal</b>${save != null && save > 0 ? ` (save $${save.toFixed(2)})` : ''}` : 'No CFT price right now.',
  ].join('\n');
}

// The station list changes once a day: kept for 10 minutes per server so frequent position updates
// don't each load it.
let cache: { at: number; list: DriverStation[] } | null = null;
async function stationsNow(db: Db): Promise<DriverStation[]> {
  if (!cache || Date.now() - cache.at > 10 * 60_000) cache = { at: Date.now(), list: (await driverStations(db)).stations };
  return cache.list;
}

/** One live position from a driver: the alert to send, or null (nothing new ahead). */
export async function liveLocationAlert(db: Db, userId: number, fix: LiveFix, load: (db: Db) => Promise<DriverStation[]> = stationsNow): Promise<string | null> {
  const lastKey = `cft:live:last:${userId}`;
  const prev = await getJson<LatLng>(lastKey);
  const heading = travelHeading(fix, prev);
  // Keep the earlier point until the truck has moved enough to tell the direction from it.
  if (!prev || milesBetween(prev, fix) >= DRIVER_MAP.alerts.minMoveMi) await putJson(lastKey, { lat: fix.lat, lng: fix.lng }, 3600);
  if (heading == null) return null;
  const next = nextStationAhead(await load(db), fix, heading);
  if (!next) return null;
  if (!(await firstTime(`cft:live:alerted:${userId}:${next.station.id}`, DRIVER_MAP.alerts.repeatHours * 3600))) return null;
  return alertText(next.station, next.mi);
}
