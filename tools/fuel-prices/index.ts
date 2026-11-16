import type { AgentDiscounts, PartnerBrand } from '../../shared/discounts.js';
import { BRAND_IDS, US_STATES } from '../../shared/discounts.js';
import type { DiscountsAdmin, FuelStations } from '../../shared/types.js';
import { asAdmin, telegramAdmin } from '../../core/admins.js';
import { agentProfile, isAgent } from '../../core/agents.js';
import { isDriver } from '../../core/drivers.js';
import { getPool } from '../../db_storage/db.js';
import { bodyObject, HttpError, type ApiRequest } from '../../core/http.js';
import type { Tool } from '../../core/tool.js';
import { requireInitData, type TelegramUser } from '../../core/telegram.js';
import { touchTelegramUser } from '../../core/users.js';
import { sendAgentExcel, sendSelection, sendStation, type Selection } from './agent-prices.js';
import { fetchAllStations, FuelError, recentStations } from './cabinet.js';
import { sendFuelPrices } from './export.js';
import { agentStations, discountSettings, liveDataset, saveDataset, saveDiscountSettings } from './dataset.js';
import { driverStations } from './driver-map.js';
import { planRoute, searchPlaces } from './routing.js';
import { voiceClip } from './voice.js';

// Fuel prices: every station's retail and discounted fuel price from the United Fuel cabinet
// (admins), and the partner-station discounts agents search (bot and Mini App).

/** The Mini App sends Telegram's signed initData in this header on agent calls. */
const INIT_HEADER = 'x-telegram-init-data';
const MAX_SEND_STATES = 10;

/** An agent or admin calling from the Mini App. Anyone else is refused. */
async function discountViewer(req: ApiRequest): Promise<{ user: TelegramUser; role: 'agent' | 'admin' }> {
  const { user } = requireInitData(req.headers[INIT_HEADER]);
  const db = getPool();
  await touchTelegramUser(db, user);
  if (await telegramAdmin(db, user)) return { user, role: 'admin' };
  if (await isAgent(db, user.id)) return { user, role: 'agent' };
  throw new HttpError(403, 'Fuel discounts are for CFT agents. Ask your CFT admin for an invite link.', 'not_agent');
}

function selection(body: Record<string, unknown>): Selection {
  const states = Array.isArray(body.states) ? body.states.filter((s): s is string => typeof s === 'string' && !!US_STATES[s]) : [];
  const brands = Array.isArray(body.brands) ? body.brands.filter((b): b is PartnerBrand => BRAND_IDS.includes(b as PartnerBrand)) : [];
  return { states: [...new Set(states)], brands: [...new Set(brands)] };
}

/** The route map is also for drivers (joined through a driver link); everything else here is not. */
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

const asViewer = (h: (v: { user: TelegramUser; role: 'agent' | 'admin' }, req: ApiRequest) => Promise<unknown>) => async (req: ApiRequest) => ({ status: 200, body: await h(await discountViewer(req), req) });

function fuelHttp(e: unknown): never {
  if (e instanceof FuelError) throw new HttpError(502, e.message, 'fuel_' + e.kind);
  throw e;
}

export const fuelPrices: Tool = {
  id: 'fuel-prices',
  routes(route) {
    // ---- Admins: the Hub's Fuel prices screen (real prices) --------------------------------------
    route('GET', 'fuel/stations', asAdmin(async (a): Promise<FuelStations> => {
      try {
        const { at, x } = await recentStations(undefined, async () => {
          const fresh = await fetchAllStations();
          await saveDataset(fresh, a.telegramUserId).catch((e: Error) => console.error('[fuel] saving the agents’ dataset failed:', e.message));
          return fresh;
        });
        return {
          siteTotal: x.siteTotal,
          fetchedAt: at.toISOString(),
          stations: x.stations.map((s) => ({
            id: s.id, station: s.station, retail: s.retailPrice, discounted: s.discountedPrice, updatedAt: s.updatedAt?.toISOString() ?? null,
            state: s.state, city: s.city, address: s.address,
          })),
        };
      } catch (e) {
        fuelHttp(e);
      }
    }));
    // "Send Excel to my chat": the same export as the 📥 button, delivered to the admin's chat
    route('POST', 'fuel/send', asAdmin(async (a) => {
      if (!a.telegramUserId) throw new HttpError(400, 'Your admin account is not linked to Telegram, so there is no chat to send the file to.');
      const r = await sendFuelPrices(getPool(), a.telegramUserId);
      if (!r.ok) throw new HttpError(502, r.error, 'fuel_failed');
      return { sent: true, stations: r.stations };
    }));

    // ---- Admins: the discounts dataset agents see, and its settings ------------------------------
    const adminView = async (): Promise<DiscountsAdmin> => {
      const db = getPool();
      const [d, settings] = await Promise.all([liveDataset(db), discountSettings(db)]);
      return {
        settings,
        dataset: d && {
          pulledAt: d.pulledAt.toISOString(), siteTotal: d.siteTotal, partnerStations: d.partnerStations, withDiscount: d.withDiscount,
          noPrice: d.partnerStations - d.withDiscount, broken: d.broken, smallDiscount: d.smallDiscount, states: d.states, byBrand: d.byBrand,
        },
      };
    };
    route('GET', 'admin/discounts', asAdmin(adminView));
    route('PUT', 'admin/discounts/settings', asAdmin(async (_a, req) => {
      const b = bodyObject(req);
      const margin = Number(b.margin);
      if (!Number.isFinite(margin) || margin < 0 || margin > 2) throw new HttpError(400, 'The CFT margin must be between $0.00 and $2.00 per gallon.');
      await saveDiscountSettings(getPool(), { margin: Math.round(margin * 1000) / 1000, showNoPrice: b.showNoPrice === true, showBroken: b.showBroken === true });
      return adminView();
    }));
    route('POST', 'admin/discounts/refresh', asAdmin(async (a) => {
      try {
        await saveDataset(await fetchAllStations(), a.telegramUserId);
      } catch (e) {
        fuelHttp(e);
      }
      return adminView();
    }));

    // ---- Agents (and admins): the Mini App's Find discounts screens ------------------------------
    route('GET', 'discounts', asViewer(async ({ user, role }): Promise<AgentDiscounts> => {
      const db = getPool();
      const { pulledAt, stations } = await agentStations(db);
      const profile = role === 'agent' ? await agentProfile(db, user.id) : null;
      return {
        pulledAt: pulledAt?.toISOString() ?? null,
        stations,
        me: {
          name: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Agent', username: user.username ?? null, role,
          since: profile?.since ?? null, invitedBy: profile?.invitedBy ?? null,
        },
      };
    }));
    route('POST', 'discounts/send', asViewer(async ({ user }, req) => {
      const sel = selection(bodyObject(req));
      if (!sel.states.length || sel.states.length > MAX_SEND_STATES) throw new HttpError(400, `Pick 1 to ${MAX_SEND_STATES} states to send to the chat.`);
      const sent = await sendSelection(getPool(), user.id, sel);
      return { sent };
    }));
    route('POST', 'discounts/send-station', asViewer(async ({ user }, req) => {
      const id = Number(bodyObject(req).id);
      if (!Number.isSafeInteger(id) || !(await sendStation(getPool(), user.id, id))) throw new HttpError(404, 'This station is no longer in the price list.');
      return { sent: 1 };
    }));
    route('POST', 'discounts/excel', asViewer(async ({ user }, req) => {
      const sent = await sendAgentExcel(getPool(), user.id, selection(bodyObject(req)));
      return { sent };
    }));

    // ---- The drivers' fuel map (Mini App /route) -------------------------------------------------
    // For drivers (handlers/drivers/), agents and admins.
    route('GET', 'driver/stations', asMapViewer(() => driverStations(getPool())));
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
