import type { DriverBrand } from '../../shared/driverRoute.js';
import type { PartnerBrand } from '../../shared/discounts.js';
import type { DriverStation, DriverStations } from '../../shared/types.js';
import { env } from '../../core/env.js';
import type { Db } from '../../db_storage/db.js';
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

/** Partner stations with their cached map points; looks up a batch of stations that have none yet. */
export async function driverStations(db: Db, locate = locateMissing): Promise<DriverStations> {
  const { pulledAt, stations } = await agentStations(db);
  const keyed = stations.map((s) => ({ s, key: geoKey(s) }));
  const keys = [...new Set(keyed.map((k) => k.key).filter((k): k is string => !!k))];
  // Before migration 0009 the cache table is missing: the stations come without map points.
  const ready = await hasGeoCache(db);
  let coords = ready ? await cachedCoords(db, keys) : new Map<string, null>();
  if (ready) {
    const seen = new Set<string>();
    const missing = keyed.filter((k) => k.key && !coords.has(k.key) && !seen.has(k.key) && seen.add(k.key));
    if (missing.length && (await locate(db, missing.map((k) => ({ key: k.key!, station: k.s }))))) coords = await cachedCoords(db, keys);
  }
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
