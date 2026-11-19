import { asAdmin, telegramAdmin } from '../../support/helpers/admins.js';
import { isAgent } from '../../support/helpers/agents.js';
import { isDriver } from '../../support/helpers/drivers.js';
import { getPool } from '../../database/db.js';
import { bodyObject, HttpError, ok, requireCron, type ApiRequest } from '../../support/helpers/http.js';
import { env } from '../../support/helpers/env.js';
import { rateLimit } from '../../support/helpers/kv.js';
import { DRIVER_MAP } from '../../support/common/driver-config.js';
import { detourMinutes, readAsks } from './detours.js';
import type { Tool } from '../../support/helpers/tool.js';
import { INIT_HEADER, requireInitData, type TelegramUser } from '../../support/helpers/telegram.js';
import { touchTelegramUser } from '../../support/helpers/users.js';
import { driverStations, locateStations, refreshStationLocations, stationPoints } from './stations.js';
import { planRoute, searchPlaces } from './routing.js';
import { voiceClip } from './voice.js';
import { addTripPoints, adminDrivers, adminTrip, adminTrips, sendTripFile, startTrip, tripNoticeSeen } from './trips.js';

// The drivers' fuel map (Mini App /route): CFT partner stations on a map, the cheapest ones along a
// truck route, turn-by-turn directions and the voice. For drivers (handlers/drivers/), agents and admins.

/** The route map is also for drivers (joined through a driver link). Anyone else is refused. */
async function mapViewer(req: ApiRequest): Promise<{ user: TelegramUser; role: 'agent' | 'admin' | 'driver' }> {
  const { user } = requireInitData(req.headers[INIT_HEADER]);
  const db = getPool();
  await touchTelegramUser(db, user);
  if (await telegramAdmin(db, user)) return { user, role: 'admin' };
  if (await isAgent(db, user.id)) return { user, role: 'agent' };
  if (await isDriver(db, user.id)) return { user, role: 'driver' };
  throw new HttpError(403, 'The route map is for CFT drivers. Ask CFT for a driver link.', 'not_driver');
}
type MapViewer = { user: TelegramUser; role: 'agent' | 'admin' | 'driver' };
const asMapViewer = (h: (v: MapViewer, req: ApiRequest, params: string[]) => Promise<unknown>) => async (req: ApiRequest, params: string[]) => ({ status: 200, body: await h(await mapViewer(req), req, params) });
/** Per Telegram user (not per IP: many trucks share a phone carrier's addresses), whichever service answers. */
const limit = (v: MapViewer, name: 'route' | 'places' | 'detours') => rateLimit(name, `tg:${v.user.id}`, env.driverRate(name, DRIVER_MAP.ratePerMinute[name]));
const driverName = (u: TelegramUser) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || null;

export const driverMap: Tool = {
  id: 'driver-map',
  routes(route) {
    // Drivers learn here that their trips are recorded (admins' and agents' drives are not).
    route('GET', 'driver/stations', asMapViewer(async (v) => ({
      ...(await driverStations(getPool())),
      // Before migration 0011 the trip tables are missing: the map works, nothing is recorded.
      trips: v.role === 'driver'
        ? await tripNoticeSeen(getPool(), v.user.id).then((noticeSeen) => ({ record: true as const, noticeSeen }), () => null)
        : null,
    })));
    // Trip history (trips.ts): the start, then the driven track in batches. Drivers only; others get no id.
    route('POST', 'driver/trips', asMapViewer(async (v, req) => (v.role === 'driver' ? startTrip(getPool(), { id: v.user.id, name: driverName(v.user) }, bodyObject(req)) : { id: null })));
    route('POST', 'driver/trips/:id/points', asMapViewer(async (v, req, [id]) => {
      if (v.role !== 'driver') throw new HttpError(404, 'Trip not found.');
      return addTripPoints(v.user.id, id, bodyObject(req));
    }));
    // For admins: drivers, their trips, one trip, and a trip as a file in their chat.
    route('GET', 'admin/drivers', asAdmin(() => adminDrivers(getPool())));
    route('GET', 'admin/drivers/:tg/trips', asAdmin((_a, _r, [tg]) => adminTrips(getPool(), Number(tg))));
    route('GET', 'admin/trips/:id', asAdmin((_a, _r, [id]) => adminTrip(getPool(), id)));
    route('POST', 'admin/trips/:id/send', asAdmin((a, _r, [id]) => sendTripFile(getPool(), a.telegramUserId, id)));
    route('POST', 'driver/locate', asMapViewer(() => locateStations(getPool())));
    route('POST', 'driver/route', asMapViewer(async (v, req) => {
      await limit(v, 'route');
      return planRoute(bodyObject(req), fetch);
    }));
    // Real detour time for the cheapest stations near the route (detours.ts).
    route('POST', 'driver/detours', asMapViewer(async (v, req) => {
      await limit(v, 'detours');
      const asks = readAsks(req.body);
      return { detours: await detourMinutes(asks, await stationPoints(getPool(), asks.map((a) => a.id)), fetch) };
    }));
    // Daily (scheduled job, after the price pull): map points for new stations, old ones checked again.
    route('GET', 'cron/stations', async (req) => {
      requireCron(req);
      return ok(await refreshStationLocations(getPool()));
    });
    // The natural voice: a plain GET so phones and the CDN cache each phrase (no sign-in: an <audio>
    // fetch carries no headers; rate-limited and capped by the shared allowance).
    route('GET', 'driver/voice', async (req) => {
      const content = await voiceClip(req.query.get('t') ?? '', req.query.get('v') ?? 'fenrir', req.ip);
      return { status: 200, body: null, file: { contentType: 'audio/mpeg', filename: 'voice.mp3', content, inline: true, cacheControl: 'public, max-age=31536000, s-maxage=31536000, immutable' } };
    });
    // Errors from the map page on people's phones, written to the server log (no sign-in: a page
    // that failed to sign in must still be able to say so). Short and plain text only.
    route('POST', 'driver/log', async (req) => {
      const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const clean = (v: unknown, n: number) => String(v ?? '').replace(/[^\x20-\x7E\n]/g, '?').slice(0, n);
      console.warn('[route page error]', JSON.stringify({ message: clean(b.message, 500), platform: clean(b.platform, 20), version: clean(b.version, 10), signedIn: b.signedIn === true, ua: clean(b.ua, 200), stack: clean(b.stack, 1500) }));
      return { status: 204, body: null };
    });
    route('GET', 'driver/places', asMapViewer(async (v, req) => {
      await limit(v, 'places');
      const lat = Number(req.query.get('lat'));
      const lng = Number(req.query.get('lng'));
      return { places: await searchPlaces(req.query.get('q') ?? '', Number.isFinite(lat) && Number.isFinite(lng) && req.query.has('lat') ? { lat, lng } : null) };
    }));
  },
};
