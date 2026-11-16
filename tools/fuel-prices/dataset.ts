import type { AgentStation, PartnerBrand } from '../../shared/discounts.js';
import { tx, type Db } from '../../db_storage/db.js';
import type { Extraction, Station } from './cabinet.js';

// The discounts dataset agents search. Every complete pull of the cabinet by an admin is saved here
// (partner stations only, with the cabinet's real prices); agents always read the newest pull, with
// the CFT margin taken off the discounted price at read time.

/** How many pulls are kept (the newest is the live one). */
export const KEEP_DATASETS = 5;

const compact = (s: string | null) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Which partner brand a station belongs to, from the cabinet's chain (names as a fallback). Speedway
 * sits inside the cabinet's 7-Eleven chain, so it is told apart by its name. Anything else (Casey's,
 * plain 7-Eleven) is not a partner and is left out.
 */
export function partnerBrand(s: Pick<Station, 'chain' | 'station' | 'efsName'>): PartnerBrand | null {
  const chain = compact(s.chain);
  const names = `${s.station} ${s.efsName ?? ''}`.toUpperCase();
  if (chain === 'PILOTJ' || chain === 'PILOT' || chain === 'FLYINGJ') return 'pilot';
  if (chain === 'LOVES') return 'loves';
  if (chain === 'TAPETRO' || chain === 'TA' || chain === 'PETRO') return 'ta';
  if (/SPEEDWAY/.test(names) && (chain === '' || chain.includes('ELEVEN') || chain === 'SPEEDWAY')) return 'speedway';
  if (chain) return null;
  // No chain in the record: go by the name the price file uses.
  if (/^(PILOT|FLYING ?J)/.test(names)) return 'pilot';
  if (/^LOVE/.test(names)) return 'loves';
  if (/^(TA|PETRO)\b/.test(names.replace(/[_/-]/g, ' '))) return 'ta';
  return null;
}

/** The store number drivers know: after "#" in either name, else the last number in the price-file name. */
function storeNumber(s: Pick<Station, 'station' | 'efsName'>): string | null {
  for (const n of [s.efsName, s.station]) {
    const m = n && /#\s*(\d{1,6})/.exec(n);
    if (m) return m[1];
  }
  const all = s.station.match(/\d{1,6}/g);
  return all ? all[all.length - 1] : null;
}

const titleWords = (t: string) => t.toLowerCase().replace(/(^|[\s\-/.(])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

/**
 * "Flying J 746", "Pilot 1476", "Love's 695", "Speedway 4638". TA and Petro stations are named by place
 * in the cabinet ("TA TUSCALOOSA", "TA EXPRESS - BIRMINGHAM"): they keep the place when it is not just
 * their city ("TA Express", "Petro Atlanta East"), and a store number when they have one ("TA 45").
 */
export function displayName(s: Pick<Station, 'station' | 'efsName'> & { city?: string | null }, brand: PartnerBrand): string {
  const n = storeNumber(s);
  const upper = s.station.toUpperCase();
  if (brand === 'ta') {
    const petro = /^PETRO\b/.test(upper.replace(/[_/-]/g, ' ')) || (!/^TA\b/.test(upper.replace(/[_/-]/g, ' ')) && /\bPETRO\b/.test(upper));
    const rest = upper.replace(/^(TA\s*\/\s*PETRO|TA|PETRO)\b[\s_-]*/, '').replace(/#?\s*\d+\s*$/, '').trim();
    const express = /^EXPRESS\b/.test(rest);
    const place = rest.replace(/^EXPRESS\b[\s-]*/, '').trim();
    const label = (petro ? 'Petro' : 'TA') + (express ? ' Express' : '');
    const samePlace = !place || place.replace(/[^A-Z]/g, '') === (s.city ?? '').toUpperCase().replace(/[^A-Z]/g, '');
    if (n) return `${label} ${n}`;
    return samePlace ? label : `${label} ${titleWords(place)}`;
  }
  const label =
    brand === 'pilot' ? (/^FJ\b|^FJ-|FLYING ?J/.test((s.efsName ?? '').toUpperCase()) || /^FLYING/.test(upper) ? 'Flying J' : 'Pilot')
    : brand === 'loves' ? "Love's"
    : 'Speedway';
  return n ? `${label} ${n}` : label;
}

/** Saves a complete pull as the new live dataset and drops pulls older than the last few. */
export async function saveDataset(x: Extraction, pulledBy: number | null): Promise<{ id: number; partnerStations: number }> {
  const rows = x.stations.flatMap((s) => {
    const brand = partnerBrand(s);
    return brand ? [{ s, brand }] : [];
  });
  return tx(async (c) => {
    const { rows: ds } = await c.query('insert into discount_datasets (pulled_by, site_total, partner_stations) values ($1, $2, $3) returning id', [pulledBy, x.siteTotal, rows.length]);
    const id = ds[0].id as number;
    if (rows.length) {
      await c.query(
        `insert into discount_stations (dataset_id, station_id, brand, name, raw_name, state, city, address, route_exit, retail, discounted, price_updated_at, broken)
         select $1, * from unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::numeric[], $11::numeric[], $12::timestamptz[], $13::boolean[])`,
        [
          id,
          rows.map((r) => r.s.id),
          rows.map((r) => r.brand),
          rows.map((r) => displayName(r.s, r.brand)),
          rows.map((r) => r.s.station),
          rows.map((r) => r.s.state?.toUpperCase() ?? null),
          rows.map((r) => r.s.city),
          rows.map((r) => r.s.address),
          rows.map((r) => r.s.routeExit),
          rows.map((r) => r.s.retailPrice),
          rows.map((r) => r.s.discountedPrice),
          rows.map((r) => r.s.updatedAt?.toISOString() ?? null),
          rows.map((r) => r.s.broken),
        ],
      );
    }
    await c.query('delete from discount_datasets where id not in (select id from discount_datasets order by id desc limit $1)', [KEEP_DATASETS]);
    return { id, partnerStations: rows.length };
  });
}

export interface DiscountSettings {
  /** Taken off the cabinet's discount for agents (added to the discounted price), in dollars per gallon. */
  margin: number;
  /** Show agents stations the cabinet has no discounted price for (at retail). */
  showNoPrice: boolean;
  /** Show agents stations the cabinet flags as broken. */
  showBroken: boolean;
}

export async function discountSettings(db: Db): Promise<DiscountSettings> {
  const { rows } = await db.query('select agent_margin, agents_show_no_price, agents_show_broken from app_settings where id = 1');
  const r = rows[0];
  return { margin: r ? Number(r.agent_margin) : 0.2, showNoPrice: !!r?.agents_show_no_price, showBroken: !!r?.agents_show_broken };
}

export async function saveDiscountSettings(db: Db, s: DiscountSettings): Promise<DiscountSettings> {
  await db.query('update app_settings set agent_margin = $1, agents_show_no_price = $2, agents_show_broken = $3, updated_at = now() where id = 1', [s.margin, s.showNoPrice, s.showBroken]);
  return discountSettings(db);
}

export interface DatasetInfo {
  id: number;
  pulledAt: Date;
  pulledBy: number | null;
  siteTotal: number;
  partnerStations: number;
  withDiscount: number;
  broken: number;
  /** Stations whose discount is no bigger than the margin, so agents don't see them. */
  smallDiscount: number;
  byBrand: Record<PartnerBrand, number>;
  states: number;
}

/** The live dataset's figures, or null before the first pull. */
export async function liveDataset(db: Db): Promise<DatasetInfo | null> {
  const { margin } = await discountSettings(db);
  const { rows } = await db.query(
    `select d.id, d.pulled_at, d.pulled_by, d.site_total, d.partner_stations,
            count(s.*) filter (where s.discounted is not null)::int as with_discount,
            count(s.*) filter (where s.broken)::int as broken,
            count(s.*) filter (where s.discounted is not null and s.retail is not null and s.retail - s.discounted <= $1)::int as small_discount,
            count(distinct s.state)::int as states,
            count(s.*) filter (where s.brand = 'pilot')::int as pilot, count(s.*) filter (where s.brand = 'loves')::int as loves,
            count(s.*) filter (where s.brand = 'ta')::int as ta, count(s.*) filter (where s.brand = 'speedway')::int as speedway
       from (select * from discount_datasets order by id desc limit 1) d
       left join discount_stations s on s.dataset_id = d.id
      group by d.id, d.pulled_at, d.pulled_by, d.site_total, d.partner_stations`,
    [margin],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, pulledAt: r.pulled_at, pulledBy: r.pulled_by, siteTotal: r.site_total, partnerStations: r.partner_stations,
    withDiscount: r.with_discount, broken: r.broken, smallDiscount: r.small_discount, states: r.states,
    byBrand: { pilot: r.pilot, loves: r.loves, ta: r.ta, speedway: r.speedway },
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The live dataset as agents see it: the agent's discount is the cabinet's discount minus the margin
 * (so the agent price is the cabinet's discounted price plus the margin); the real discounted price
 * never leaves this function. Stations whose discount is no bigger than the margin are left out;
 * stations without a discounted price and broken ones too, unless admins chose to show them.
 */
export async function agentStations(db: Db): Promise<{ pulledAt: Date | null; stations: AgentStation[] }> {
  const settings = await discountSettings(db);
  const { rows } = await db.query(
    `select d.pulled_at, s.station_id, s.brand, s.name, s.state, s.city, s.address, s.route_exit, s.retail, s.discounted, s.price_updated_at, s.broken
       from (select id, pulled_at from discount_datasets order by id desc limit 1) d
       left join discount_stations s on s.dataset_id = d.id`,
  );
  if (!rows[0]) return { pulledAt: null, stations: [] };
  const stations: AgentStation[] = [];
  for (const r of rows) {
    if (r.station_id == null || !r.state) continue;
    if (r.broken && !settings.showBroken) continue;
    const retail = r.retail == null ? null : Number(r.retail);
    let price: number;
    let saving: number | null = null;
    if (r.discounted != null) {
      // The agent's discount is the cabinet's discount minus the margin: their price is the
      // cabinet's discounted price plus the margin. A discount the margin eats up is not shown.
      price = round3(Number(r.discounted) + settings.margin);
      if (retail != null) {
        saving = round3(retail - price);
        if (saving <= 0) continue;
      }
    } else {
      if (!settings.showNoPrice || retail == null) continue;
      price = retail;
    }
    stations.push({
      id: r.station_id, brand: r.brand, name: r.name, state: r.state, city: r.city, address: r.address, exit: r.route_exit,
      price, retail, saving, updatedAt: r.price_updated_at?.toISOString() ?? null,
    });
  }
  return { pulledAt: rows[0].pulled_at, stations };
}
