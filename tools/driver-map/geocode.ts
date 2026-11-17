import type { PartnerBrand } from '../../shared/discounts.js';
import { US_STATES } from '../../shared/discounts.js';
import { env } from '../../core/env.js';
import type { Db } from '../../db_storage/db.js';

// Map points for partner stations. Accuracy first: a pin in the wrong place is worse than no pin.
// Each station is looked up once and the answer is kept in station_geo (migration 0009). In order:
//   1. chain   The chain's own store locator, via All The Places (a free dataset rebuilt weekly from
//              the Pilot / Flying J, Love's, TA / Petro and Speedway locators): the same store number
//              in the same state, or else the only store of that brand in that city.
//   2. census  The US Census Bureau's address service (free, no key) for the street address.
//   3. search  OpenRouteService's address search, only when it lands in the same state and is sure.
// A station none of them places gets no pin (it still shows in "By state"); it is tried again a week later.

export interface Coords {
  lat: number;
  lng: number;
}
export type GeoSource = 'chain' | 'census' | 'search';
export interface Located extends Coords {
  source: GeoSource;
}

/** What a lookup needs to know about a station. */
export interface GeoStation {
  brand: PartnerBrand;
  name: string;
  address: string | null;
  city: string | null;
  state: string;
}

const PARALLEL = 6;
const RETRY_NOT_FOUND_DAYS = 7;
const norm = (t: string | null | undefined) => (t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const STATE_CODES = new Map(Object.entries(US_STATES).map(([code, name]) => [norm(name), code]));
const stateCode = (s: unknown) => {
  const t = String(s ?? '').trim();
  return t.length === 2 ? t.toUpperCase() : STATE_CODES.get(norm(t)) ?? '';
};

/** The store number in a station name ("Pilot 1549" → "1549", "TA 0045" → "45"), or null. */
export function storeNo(name: string): string | null {
  const all = name.match(/\d{1,6}/g);
  return all ? String(Number(all[all.length - 1])) : null;
}

/** The cache key: brand, store number and address, lower case. Changes when any of them changes. */
export function geoKey(s: GeoStation): string | null {
  if (!s.state || (!s.city && !s.address)) return null;
  return [s.brand, storeNo(s.name) ?? '', norm(s.address), norm(s.city), s.state.toLowerCase()].join('|').slice(0, 400);
}

// ---- 1. The chains' own locators (All The Places) ------------------------------------------------

const ATP_LATEST = 'https://data.alltheplaces.xyz/runs/latest.json';
const SPIDERS: Record<PartnerBrand, string> = { pilot: 'pilot_flying_j', loves: 'loves_us', ta: 'travelcenters_of_america_us', speedway: 'speedway_us' };

interface ChainStore extends Coords {
  ref: string | null;
  state: string;
  city: string;
}
export type ChainIndex = Record<PartnerBrand, ChainStore[]>;

/** Reads one chain's GeoJSON from All The Places into stores (US only, with a state). */
export function chainStores(geojson: unknown): ChainStore[] {
  const features = (geojson as { features?: unknown[] })?.features ?? [];
  const out: ChainStore[] = [];
  for (const f of features as { geometry?: { coordinates?: number[] }; properties?: Record<string, unknown> }[]) {
    const [lng, lat] = f.geometry?.coordinates ?? [];
    const p = f.properties ?? {};
    const state = stateCode(p['addr:state']);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !state || (p['addr:country'] && p['addr:country'] !== 'US')) continue;
    const ref = p.ref != null && /^\d+$/.test(String(p.ref).trim()) ? String(Number(p.ref)) : null;
    out.push({ lat, lng, ref, state, city: norm(String(p['addr:city'] ?? '')) });
  }
  return out;
}

let chainCache: { at: number; index: ChainIndex } | null = null;

/** The four chains' stores, downloaded at most every 6 hours per server instance. */
export async function loadChainIndex(fetchImpl: typeof fetch = fetch): Promise<ChainIndex | null> {
  if (chainCache && Date.now() - chainCache.at < 6 * 3600_000) return chainCache.index;
  try {
    const run = (await (await fetchImpl(ATP_LATEST, { signal: AbortSignal.timeout(10_000) })).json()) as { output_url?: string };
    const base = String(run.output_url ?? '').replace(/\/output\.zip$/, '');
    if (!base.startsWith('https://')) return null;
    const entries = await Promise.all(
      (Object.keys(SPIDERS) as PartnerBrand[]).map(async (b) => {
        const res = await fetchImpl(`${base}/output/${SPIDERS[b]}.geojson`, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`All The Places ${SPIDERS[b]}: HTTP ${res.status}`);
        return [b, chainStores(await res.json())] as const;
      }),
    );
    const index = Object.fromEntries(entries) as ChainIndex;
    chainCache = { at: Date.now(), index };
    return index;
  } catch (e) {
    console.warn('chain locations not loaded', (e as Error).message);
    return null;
  }
}

/** The chain's own point for a station: same store number and state, or the only store of the brand in that city. */
export function chainMatch(index: ChainIndex, s: GeoStation): Coords | null {
  const stores = index[s.brand]?.filter((x) => x.state === s.state) ?? [];
  const n = storeNo(s.name);
  if (n) {
    const byRef = stores.filter((x) => x.ref === n);
    if (byRef.length === 1) return { lat: byRef[0].lat, lng: byRef[0].lng };
  }
  const city = norm(s.city);
  const inCity = city ? stores.filter((x) => x.city === city) : [];
  // With a store number that the chain does not list, a lone store in the city is still the one only
  // when the chain lists no numbers at all there.
  if (inCity.length === 1 && (!n || !inCity[0].ref)) return { lat: inCity[0].lat, lng: inCity[0].lng };
  return null;
}

// ---- 2. US Census address service ----------------------------------------------------------------

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/address';

/** A street address through the Census service; null when it has no match. Throws on network trouble. */
export async function censusLookup(s: GeoStation, fetchImpl: typeof fetch = fetch): Promise<Coords | null> {
  // A street address starts with a house number; "I-80, Exit 305 & US 6" is not one.
  if (!s.address || !/^\s*\d+[A-Za-z]?\s+\S/.test(s.address)) return null;
  const q = new URLSearchParams({ street: s.address, city: s.city ?? '', state: s.state, benchmark: 'Public_AR_Current', format: 'json' });
  const res = await fetchImpl(`${CENSUS_URL}?${q}`, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Census HTTP ${res.status}`);
  const m = ((await res.json()) as { result?: { addressMatches?: { coordinates?: { x: number; y: number } }[] } }).result?.addressMatches?.[0]?.coordinates;
  return m && Number.isFinite(m.x) && Number.isFinite(m.y) ? { lat: m.y, lng: m.x } : null;
}

// ---- 3. OpenRouteService address search ----------------------------------------------------------

const ORS_SEARCH = 'https://api.openrouteservice.org/geocode/search';
const BRAND_WORDS: Record<PartnerBrand, string> = { pilot: 'Pilot Flying J', loves: "Love's Travel Stop", ta: 'TravelCenters of America', speedway: 'Speedway' };

/** ORS search, kept only when it lands in the station's state with high confidence. Throws on network or quota trouble. */
export async function orsLookup(s: GeoStation, key: string, fetchImpl: typeof fetch = fetch): Promise<Coords | null> {
  const text = [BRAND_WORDS[s.brand], s.address, s.city, s.state].filter(Boolean).join(', ');
  const q = new URLSearchParams({ api_key: key, text, 'boundary.country': 'US', size: '1', layers: 'venue,address' });
  const res = await fetchImpl(`${ORS_SEARCH}?${q}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`OpenRouteService search HTTP ${res.status}`);
  const f = ((await res.json()) as { features?: { geometry?: { coordinates?: number[] }; properties?: { region_a?: string; confidence?: number } }[] }).features?.[0];
  const [lng, lat] = f?.geometry?.coordinates ?? [];
  if (!f || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (stateCode(f.properties?.region_a) !== s.state || (f.properties?.confidence ?? 0) < 0.8) return null;
  return { lat, lng };
}

// ---- The cache -----------------------------------------------------------------------------------

/** Cached points for these keys. Stations no source could place map to null; keys never tried (or due a retry) are absent. */
export async function cachedCoords(db: Db, keys: string[]): Promise<Map<string, Coords | null>> {
  const out = new Map<string, Coords | null>();
  if (!keys.length) return out;
  const { rows } = await db.query<{ key: string; lat: number | null; lng: number | null; status: string }>(
    `select key, lat, lng, status from station_geo
      where key = any($1::text[])
        and (status = 'ok' or (status = 'zero_results' and geocoded_at > now() - make_interval(days => $2)))`,
    [keys, RETRY_NOT_FOUND_DAYS],
  );
  for (const r of rows) out.set(r.key, r.status === 'ok' && r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : null);
  return out;
}

export interface LocateDeps {
  fetchImpl?: typeof fetch;
  /** Stop starting new lookups after this many milliseconds (the rest wait for the next request). */
  budgetMs?: number;
  /** Most street/search lookups per request (chain matches are free and not counted). */
  limit?: number;
}

/**
 * Finds points for stations that have none cached and stores every answer. Returns how many got a point.
 * Network trouble is stored as 'error' and tried again on a later request.
 */
export async function locateMissing(db: Db, items: { key: string; station: GeoStation }[], deps: LocateDeps = {}): Promise<number> {
  if (!items.length) return 0;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const started = Date.now();
  const budget = deps.budgetMs ?? 20_000;
  const limit = deps.limit ?? env.geocodeBatch;
  const save = (key: string, c: Located | null, status: 'ok' | 'zero_results' | 'error') =>
    db.query(
      `insert into station_geo (key, lat, lng, status, source, geocoded_at) values ($1, $2, $3, $4, $5, now())
       on conflict (key) do update set lat = excluded.lat, lng = excluded.lng, status = excluded.status, source = excluded.source, geocoded_at = now()`,
      [key, c?.lat ?? null, c?.lng ?? null, status, c?.source ?? null],
    );

  let placed = 0;
  const index = await loadChainIndex(fetchImpl);
  const rest: typeof items = [];
  const chain: { key: string; c: Coords }[] = [];
  for (const it of items) {
    const c = index ? chainMatch(index, it.station) : null;
    if (c) chain.push({ key: it.key, c });
    else rest.push(it);
  }
  // Chain matches all at once: on the first opening that is well over a thousand stations.
  for (let i = 0; i < chain.length; i += 500) {
    const part = chain.slice(i, i + 500);
    await db.query(
      `insert into station_geo (key, lat, lng, status, source, geocoded_at)
       select k, la, ln, 'ok', 'chain', now() from unnest($1::text[], $2::float8[], $3::float8[]) as t(k, la, ln)
       on conflict (key) do update set lat = excluded.lat, lng = excluded.lng, status = 'ok', source = 'chain', geocoded_at = now()`,
      [part.map((x) => x.key), part.map((x) => x.c.lat), part.map((x) => x.c.lng)],
    );
    placed += part.length;
  }
  // Without the chain list (download failed) the others wait: the chain list is the most exact source.
  if (!index) return placed;

  const orsKey = env.orsKey;
  const todo = rest.slice(0, Math.max(0, limit));
  for (let i = 0; i < todo.length && Date.now() - started < budget; i += PARALLEL) {
    const answers = await Promise.all(
      todo.slice(i, i + PARALLEL).map(async ({ key, station }) => {
        try {
          const census = await censusLookup(station, fetchImpl);
          if (census) return { key, c: { ...census, source: 'census' as const }, status: 'ok' as const };
          const search = orsKey ? await orsLookup(station, orsKey, fetchImpl) : null;
          if (search) return { key, c: { ...search, source: 'search' as const }, status: 'ok' as const };
          return { key, c: null, status: 'zero_results' as const };
        } catch {
          return { key, c: null, status: 'error' as const };
        }
      }),
    );
    for (const a of answers) {
      await save(a.key, a.c, a.status);
      if (a.c) placed++;
    }
    if (answers.every((a) => a.status === 'error')) break; // services down or over quota: stop for now
  }
  return placed;
}
