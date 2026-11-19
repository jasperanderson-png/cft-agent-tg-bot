import type { AgentDiscounts, PartnerBrand } from '../../support/common/discounts.js';
import { BRAND_IDS, US_STATES } from '../../support/common/discounts.js';
import type { DiscountsAdmin, FuelStations } from '../../support/common/types.js';
import { asAdmin, telegramAdmin } from '../../support/helpers/admins.js';
import { agentProfile, isAgent } from '../../support/helpers/agents.js';
import { getPool } from '../../database/db.js';
import { bodyObject, HttpError, ok, requireCron, type ApiRequest } from '../../support/helpers/http.js';
import type { Tool } from '../../support/helpers/tool.js';
import { fullName, INIT_HEADER, type TelegramUser } from '../../support/helpers/telegram.js';
import { requireTelegramUser } from '../../support/helpers/web-login.js';
import { touchTelegramUser } from '../../support/helpers/users.js';
import { sendAgentExcel, sendSelection, sendStation, type Selection } from './agent-prices.js';
import { fetchAllStations, FuelError, recentStations } from './cabinet.js';
import { sendFuelPrices } from './export.js';
import { agentStations, discountSettings, liveDataset, saveDataset, saveDiscountSettings } from './dataset.js';

// Fuel prices: every station's retail and discounted fuel price from the United Fuel cabinet
// (admins), and the partner-station discounts agents search (bot and Mini App). The drivers' route
// map is its own tool, tools/driver-map/.

const MAX_SEND_STATES = 10;

/** An agent or admin calling from the Mini App. Anyone else is refused. */
async function discountViewer(req: ApiRequest): Promise<{ user: TelegramUser; role: 'agent' | 'admin' }> {
  const db = getPool();
  const { user } = await requireTelegramUser(db, req.headers[INIT_HEADER]);
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

    // Daily price pull (scheduled job): the same save as the admin's Refresh button, with nobody pressing it.
    // pulled_by stays empty (the column allows it).
    route('GET', 'cron/fuel', async (req) => {
      requireCron(req);
      try {
        const saved = await saveDataset(await fetchAllStations(), null);
        return ok({ datasetId: saved.id, partnerStations: saved.partnerStations });
      } catch (e) {
        return fuelHttp(e);
      }
    });

    // ---- Agents (and admins): the Mini App's Find discounts screens ------------------------------
    route('GET', 'discounts', asViewer(async ({ user, role }): Promise<AgentDiscounts> => {
      const db = getPool();
      const { pulledAt, stations } = await agentStations(db);
      const profile = role === 'agent' ? await agentProfile(db, user.id) : null;
      return {
        pulledAt: pulledAt?.toISOString() ?? null,
        stations,
        me: {
          name: fullName(user) || 'Agent', username: user.username ?? null, role,
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
  },
};
