import type { DriverBrand } from '../../shared/driverRoute.js';
import type { PartnerBrand } from '../../shared/discounts.js';
import type { DriverStation, DriverStations } from '../../shared/types.js';
import { env } from '../../core/env.js';
import type { Db } from '../../db_storage/db.js';
import { kv, kvReady } from '../../core/kv.js';
import { agentStations } from './dataset.js';
import { cachedCoords, geoKey, locateMissing } from './geocode.js';

// The drivers' route map (Mini App page /route): partner stations with map points and the price a
// driver pays with CFT. The prices are the agents' prices (the cabinet's discounted price plus the
// CFT margin, from the latest saved pull), so the cabinet's own price never reaches the map.
// Map points: geocode.ts. Truck routes and place search: routing.ts.

const BRAND: Record<PartnerBrand, DriverBrand> = { pilot: 'p', loves: 'l', ta: 't', speedway: 's' };

async function hasGeoCache(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ t: string | null }>("select to_regclass('public.station_geo')::text as t");
  return !!rows[0]?.t;
}

/** The stations, their geocode keys, and the map points already cached (no lookups: answers at once). */
async function load(db: Db) {
  const { pulledAt, stations } = await agentStations(db);
  const keyed = stations.map((s) => ({ s, key: geoKey(s) }));
  const keys = [...new Set(keyed.map((k) => k.key).filter((k): k is string => !!k))];
  // Before migration 0009 the cache table is missing: the stations come without map points.
  const ready = await hasGeoCache(db);
  const coords = ready ? await cachedCoords(db, keys) : new Map<string, null>();
  return { pulledAt, keyed, keys, ready, coords };
}

let locating: Promise<number> | null = null;

/**
 * Looks up map points for stations that have none yet (POST /api/driver/locate). The map page calls it
 * in the background when the list says some are pending, so opening the map never waits for lookups;
 * one pass at a time per server, and at most one every few minutes across servers (shared Redis).
 */
export async function locateStations(db: Db, locate = locateMissing): Promise<{ placed: number; pending: number }> {
  const { keyed, keys, ready, coords } = await load(db);
  if (!ready) return { placed: 0, pending: 0 };
  const seen = new Set<string>();
  const missing = keyed.filter((k) => k.key && !coords.has(k.key) && !seen.has(k.key) && seen.add(k.key));
  if (!missing.length) return { placed: 0, pending: 0 };
  if (!locating) {
    const free = !kvReady() || (await kv('SET', 'cft:geocode:lock', '1', 'NX', 'EX', 180).catch(() => 'OK')) === 'OK';
    if (!free) return { placed: 0, pending: missing.length };
    locating = locate(db, missing.map((k) => ({ key: k.key!, station: k.s }))).finally(() => { locating = null; });
  }
  const placed = await locating;
  const after = await cachedCoords(db, keys);
  return { placed, pending: keys.filter((k) => !after.has(k)).length };
}

/** Partner stations with their cached map points (stations still without one come with lat/lng null). */
export async function driverStations(db: Db): Promise<DriverStations> {
  const { pulledAt, keyed, keys, ready, coords } = await load(db);
  const out: DriverStation[] = keyed.map(({ s, key }) => {
    const c = key ? coords.get(key) : null;
    return {
      id: s.id, station: s.name, brand: BRAND[s.brand],
      retail: s.retail, discounted: s.saving != null ? s.price : null, updatedAt: s.updatedAt,
      state: s.state, city: s.city, address: s.address,
      lat: c?.lat ?? null, lng: c?.lng ?? null,
    };
  });
  return {
    stations: out,
    fetchedAt: (pulledAt ?? new Date()).toISOString(),
    pendingGeocode: ready ? keys.filter((k) => !coords.has(k)).length : 0,
    routing: !!env.orsKey,
  };
}
