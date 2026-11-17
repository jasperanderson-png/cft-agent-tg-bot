import { telegramAdmin } from '../../core/admins.js';
import { isAgent } from '../../core/agents.js';
import { isDriver } from '../../core/drivers.js';
import { getPool } from '../../db_storage/db.js';
import { bodyObject, HttpError, type ApiRequest } from '../../core/http.js';
import type { Tool } from '../../core/tool.js';
import { INIT_HEADER, requireInitData, type TelegramUser } from '../../core/telegram.js';
import { touchTelegramUser } from '../../core/users.js';
import { driverStations, locateStations } from './stations.js';
import { planRoute, searchPlaces } from './routing.js';
import { voiceClip } from './voice.js';

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
const asMapViewer = (h: (v: { user: TelegramUser; role: 'agent' | 'admin' | 'driver' }, req: ApiRequest) => Promise<unknown>) => async (req: ApiRequest) => ({ status: 200, body: await h(await mapViewer(req), req) });

export const driverMap: Tool = {
  id: 'driver-map',
  routes(route) {
    route('GET', 'driver/stations', asMapViewer(() => driverStations(getPool())));
    route('POST', 'driver/locate', asMapViewer(() => locateStations(getPool())));
    route('POST', 'driver/route', asMapViewer((_v, req) => planRoute(bodyObject(req), fetch, req.ip)));
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
    route('GET', 'driver/places', asMapViewer(async (_v, req) => {
      const lat = Number(req.query.get('lat'));
      const lng = Number(req.query.get('lng'));
      return { places: await searchPlaces(req.query.get('q') ?? '', Number.isFinite(lat) && Number.isFinite(lng) && req.query.has('lat') ? { lat, lng } : null) };
    }));
  },
};
