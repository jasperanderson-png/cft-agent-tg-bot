// Drivers' fuel map: which stations are CFT partners, and which of them lie along a route.
// Pure functions, used by the server (tools/driver-map/stations.ts) and the Mini App
// (telegram_bot/mini_app/src/screens/drivers/). Thresholds: shared/driver-config.ts.
import { DRIVER_MAP } from './driver-config.js';

/** The four partner networks drivers see. Every other station in the cabinet is left out. */
export type DriverBrand = 'p' | 'l' | 't' | 's';

export const BRANDS: Record<DriverBrand, { label: string; short: string; letter: string; color: string }> = {
  p: { label: 'Pilot / Flying J', short: 'Pilot', letter: 'P', color: '#ff9f7a' },
  l: { label: "Love's", short: "Love's", letter: 'L', color: '#ffd166' },
  t: { label: 'TA / Petro', short: 'TA', letter: 'T', color: '#7fe0a4' },
  s: { label: 'Speedway', short: 'Speedway', letter: 'S', color: '#c9b0ff' },
};
/** The brands in the order drivers see them (the route card's filter). */
export const BRAND_ORDER: DriverBrand[] = ['p', 'l', 't', 's'];


export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_MI = 3958.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in miles. */
export function milesBetween(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass heading from a to b, degrees clockwise from north. */
export function headingDeg(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Cumulative miles at each vertex of a path (first entry 0). */
export function cumulativeMiles(path: LatLng[]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) out.push(out[i - 1] + milesBetween(path[i - 1], path[i]));
  return out;
}

/**
 * Where a point falls on a path: how far along it (miles from the start) and how far off it (miles).
 * Uses a local flat projection per segment, which is accurate to well under a mile at route scale.
 */
export function projectOnPath(p: LatLng, path: LatLng[], cum = cumulativeMiles(path)): { alongMi: number; offMi: number; segment: number } {
  let best = { alongMi: 0, offMi: Infinity, segment: 0 };
  const kx = Math.cos(rad(p.lat)) * 69.172;
  const ky = 69.0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky;
    const bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const cx = ax + t * dx, cy = ay + t * dy;
    const off = Math.hypot(cx, cy);
    if (off < best.offMi) best = { alongMi: cum[i] + t * (cum[i + 1] - cum[i]), offMi: off, segment: i };
  }
  return best;
}

/** The point a given number of miles along a path, with the heading of the road there. */
export function pointAlong(path: LatLng[], miles: number, cum = cumulativeMiles(path)): { point: LatLng; heading: number } {
  if (path.length < 2) return { point: path[0] ?? { lat: 0, lng: 0 }, heading: 0 };
  const m = Math.max(0, Math.min(miles, cum[cum.length - 1]));
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < m) i++;
  const seg = cum[i + 1] - cum[i] || 1;
  const t = (m - cum[i]) / seg;
  const a = path[i], b = path[i + 1];
  return { point: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }, heading: headingDeg(a, b) };
}

export interface Placed<T> {
  item: T;
  /** Miles from the start of the route to where the station meets it. */
  alongMi: number;
  /** How far the station is from the route line. */
  offMi: number;
}

/**
 * The path with fewer points (Douglas–Peucker): no point of the original is more than `toleranceM`
 * meters from the result. The first and last points are always kept. A long truck route has
 * thousands of points; the simplified line is enough to find which stations are near it.
 */
export function simplifyPath(path: LatLng[], toleranceM: number): LatLng[] {
  if (path.length < 3 || toleranceM <= 0) return path.slice();
  const tolMi = toleranceM / 1609.344;
  const keep = new Uint8Array(path.length);
  keep[0] = keep[path.length - 1] = 1;
  const stack: [number, number][] = [[0, path.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const seg = [path[a], path[b]];
    let far = -1, farOff = tolMi;
    for (let i = a + 1; i < b; i++) {
      const off = projectOnPath(path[i], seg).offMi;
      if (off > farOff) { farOff = off; far = i; }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([a, far], [far, b]);
  }
  return path.filter((_p, i) => keep[i]);
}

/**
 * Splits stations into those on the route (within corridorMi of the line) and nearby ones (within
 * nearbyMi), each sorted by how far along the route they are. Stations are found on a simplified
 * line (simplifyM, fast on long routes); the miles along the route and off it are then measured on
 * the full line, for the stations found only.
 */
export function stationsAlongRoute<T extends { lat?: number | null; lng?: number | null }>(
  path: LatLng[],
  stations: T[],
  { corridorMi = DRIVER_MAP.corridorMi, nearbyMi = DRIVER_MAP.nearbyMi, simplifyM = DRIVER_MAP.simplifyM }: { corridorMi?: number; nearbyMi?: number; simplifyM?: number } = {},
): { onRoute: Placed<T>[]; nearby: Placed<T>[] } {
  const onRoute: Placed<T>[] = [];
  const nearby: Placed<T>[] = [];
  if (path.length < 2) return { onRoute, nearby };
  const coarse = simplifyPath(path, simplifyM);
  const coarseCum = cumulativeMiles(coarse);
  const slack = simplifyM / 1609.344;
  let cum: number[] | null = null;
  // A cheap bounding box first, so a cross-country route doesn't project every station in the country.
  const pad = nearbyMi / 55;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of coarse) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
  }
  for (const s of stations) {
    if (s.lat == null || s.lng == null) continue;
    if (s.lat < minLat - pad || s.lat > maxLat + pad || s.lng < minLng - pad * 1.4 || s.lng > maxLng + pad * 1.4) continue;
    const p = { lat: s.lat, lng: s.lng };
    if (projectOnPath(p, coarse, coarseCum).offMi > nearbyMi + slack) continue;
    cum ??= cumulativeMiles(path);
    const pr = projectOnPath(p, path, cum);
    if (pr.offMi <= corridorMi) onRoute.push({ item: s, alongMi: pr.alongMi, offMi: pr.offMi });
    else if (pr.offMi <= nearbyMi) nearby.push({ item: s, alongMi: pr.alongMi, offMi: pr.offMi });
  }
  onRoute.sort((a, b) => a.alongMi - b.alongMi);
  nearby.sort((a, b) => a.alongMi - b.alongMi);
  return { onRoute, nearby };
}

/** The price a driver pays: the discounted price when there is one, otherwise retail. */
export const payPrice = (s: { retail: number | null; discounted: number | null }) => s.discounted ?? s.retail;

/** The money saved per gallon (retail minus discounted), or null when the station has no discount. */
export const savingOf = (s: { retail: number | null; discounted: number | null }) =>
  s.retail != null && s.discounted != null ? Math.round((s.retail - s.discounted) * 1000) / 1000 : null;

/** The cheapest station by pay price (ties go to the one reached first). */
export function cheapest<T extends { retail: number | null; discounted: number | null }>(list: Placed<T>[]): Placed<T> | null {
  let best: Placed<T> | null = null;
  for (const p of list) {
    const v = payPrice(p.item);
    if (v == null) continue;
    const bv = best ? payPrice(best.item) : null;
    if (best == null || bv == null || v < bv) best = p;
  }
  return best;
}

/**
 * The best stop: the cheapest station the truck can reach before empty when a range is given (and
 * at least one is reachable), else the cheapest on the route.
 */
export function bestStop<T extends { retail: number | null; discounted: number | null }>(list: Placed<T>[], rangeMi: number | null): Placed<T> | null {
  if (rangeMi != null) {
    const ok = cheapest(list.filter((p) => reachable(p, rangeMi)));
    if (ok) return ok;
  }
  return cheapest(list);
}

// ---- fuel range ("miles until empty", optional, set by the driver)

/** Can the truck get there before the tank is empty? Miles along the route plus the way off it. */
export const reachable = (p: { alongMi: number; offMi: number }, rangeMi: number) => p.alongMi + p.offMi <= rangeMi;

/** A driver's typed range made safe: whole miles from 1 to 3,000, or null (not set). */
export function rangeOf(v: unknown): number | null {
  const n = Math.round(Number(String(v ?? '').replace(/[^\d.]/g, '')));
  return Number.isFinite(n) && n >= 1 && n <= 3000 ? n : null;
}

/** The range as kept on the phone: how many miles, and when the driver typed it. */
export interface FuelRange {
  mi: number;
  setAt: number;
}

/** The range still in force: forgotten `forgetHours` after the driver typed it (else null). */
export function rangeNow(r: FuelRange | null | undefined, now = Date.now(), forgetHours: number = DRIVER_MAP.range.forgetHours): FuelRange | null {
  if (!r || !Number.isFinite(r.mi) || !Number.isFinite(r.setAt)) return null;
  return now - r.setAt < forgetHours * 3_600_000 ? r : null;
}

/** The range after driving `drivenMi` more (never below 0; when it was typed does not change). */
export const afterDriving = (r: FuelRange, drivenMi: number): FuelRange => ({ mi: Math.max(0, Math.round((r.mi - Math.max(0, drivenMi)) * 10) / 10), setAt: r.setAt });

// ---- real detour time (tools/driver-map/detours.ts measures it)

/**
 * A station to check, with a route point before it and one after it. Only the station's id is
 * sent: the server looks up where the station is.
 */
export interface DetourAsk {
  id: number;
  before: LatLng;
  after: LatLng;
}
export interface DetourResult {
  id: number;
  /** Extra minutes of driving to stop there; null when not measured (no road, or the allowance is used up). */
  detourMin: number | null;
}

type Priced = { id: number; lat?: number | null; lng?: number | null; retail: number | null; discounted: number | null };

/**
 * The next `n` corridor stations to check, each with the route `aroundMi` before and after it:
 * those not checked yet (`skip`), the ones the truck can reach first (when a range is given),
 * cheapest first.
 */
export function detourAsks<T extends Priced>(
  path: LatLng[],
  onRoute: Placed<T>[],
  n: number = DRIVER_MAP.detour.candidates,
  aroundMi: number = DRIVER_MAP.detour.aroundMi,
  { skip, rangeMi = null }: { skip?: ReadonlySet<number> | ReadonlyMap<number, unknown>; rangeMi?: number | null } = {},
): DetourAsk[] {
  const cum = cumulativeMiles(path);
  const can = (p: Placed<T>) => (rangeMi != null && reachable(p, rangeMi) ? 0 : rangeMi != null ? 1 : 0);
  return onRoute
    .filter((p) => p.item.lat != null && p.item.lng != null && payPrice(p.item) != null && !skip?.has(p.item.id))
    .sort((a, b) => can(a) - can(b) || payPrice(a.item)! - payPrice(b.item)!)
    .slice(0, n)
    .map((p) => ({
      id: p.item.id,
      before: pointAlong(path, p.alongMi - aroundMi, cum).point,
      after: pointAlong(path, p.alongMi + aroundMi, cum).point,
    }));
}

/**
 * The stop to recommend once detours are being measured: the best among the stations actually
 * checked and found fine (corridor stations with a long detour were already moved out by
 * applyDetours). Before any measurement arrives (or when the service gives none), the plain best.
 */
export function bestChecked<T extends { id: number; retail: number | null; discounted: number | null }>(
  onRoute: Placed<T>[],
  detours: ReadonlyMap<number, number | null>,
  rangeMi: number | null,
): Placed<T> | null {
  const checked = onRoute.filter((p) => detours.get(p.item.id) != null);
  return bestStop(checked, rangeMi) ?? bestStop(onRoute, rangeMi);
}

/**
 * The next round of detour checks: needed only while the plain best station (cheapest, reachable
 * first) has not been checked. Then the next cheapest unchecked stations are asked.
 */
export function nextDetourRound<T extends Priced>(
  path: LatLng[],
  onRoute: Placed<T>[],
  detours: ReadonlyMap<number, number | null>,
  rangeMi: number | null,
  n: number = DRIVER_MAP.detour.candidates,
  aroundMi: number = DRIVER_MAP.detour.aroundMi,
): DetourAsk[] {
  const best = bestStop(onRoute.filter((p) => p.item.lat != null && p.item.lng != null), rangeMi);
  if (!best || detours.has(best.item.id)) return [];
  return detourAsks(path, onRoute, n, aroundMi, { skip: detours, rangeMi });
}

/**
 * Applies measured detours: a corridor station that costs more than `maxMin` extra minutes is not
 * "on the route" any more (it moves to the nearby list). Unmeasured stations stay where they are.
 */
export function applyDetours<T extends { id: number }>(
  placed: { onRoute: Placed<T>[]; nearby: Placed<T>[] },
  detours: ReadonlyMap<number, number | null>,
  maxMin: number = DRIVER_MAP.detour.maxMin,
): { onRoute: Placed<T>[]; nearby: Placed<T>[] } {
  const far = (p: Placed<T>) => { const d = detours.get(p.item.id); return d != null && d > maxMin; };
  const moved = placed.onRoute.filter(far);
  if (!moved.length) return placed;
  return { onRoute: placed.onRoute.filter((p) => !far(p)), nearby: [...placed.nearby, ...moved].sort((a, b) => a.alongMi - b.alongMi) };
}

// ---- how old a price is

/** "just now", "25 min ago", "5 h ago", "3 days ago", and whether it is older than `staleHours`. */
export function priceAge(updatedAt: string | null | undefined, now = Date.now(), staleHours: number = DRIVER_MAP.stalePriceHours): { text: string; stale: boolean } | null {
  const t = updatedAt ? Date.parse(updatedAt) : NaN;
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, Math.floor((now - t) / 60_000));
  const text = min < 2 ? 'just now' : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.floor(min / 60)} h ago` : `${Math.floor(min / 1440)} days ago`;
  return { text, stale: min >= staleHours * 60 };
}

/** How the driver ranks stations on a route (the ★ choice on the map's card). */
export type RankBy = 'rec' | 'cheap' | 'disc';
export const RANK_LABEL: Record<RankBy, string> = { rec: 'Recommended', cheap: 'Cheapest', disc: 'Biggest discount' };

/** What a truck mile costs (fuel, wear, the driver's time): about the US industry average. */
const COST_PER_MI = 2;
const FILL_GAL = 150;
/** Cheapest / Biggest discount only look this far off the route (a longer detour is not "best"). */
const PRICE_DETOUR_MI = 5;

/**
 * The best stations for a route, best first: of the chosen brands (none = all), ranked by
 * - `rec` Recommended: the price paid plus the detour there and back (about $2 a truck mile) spread
 *   over a 150-gallon fill, so a station 10 miles off must be about 27 cents cheaper to win;
 * - `cheap` the lowest price paid; `disc` the biggest CFT saving per gallon (both within 5 mi of the route).
 * Ties go to the station reached first.
 */
export function rankStations<T extends { brand: DriverBrand; retail: number | null; discounted: number | null }>(
  list: Placed<T>[], by: RankBy, brands: DriverBrand[] = [], n = 3,
): Placed<T>[] {
  const score = (p: Placed<T>) => {
    const v = payPrice(p.item)!;
    if (by === 'rec') return v + (2 * p.offMi * COST_PER_MI) / FILL_GAL;
    if (by === 'cheap') return v;
    return -(savingOf(p.item) ?? -1);
  };
  return list
    .filter((p) => payPrice(p.item) != null && (!brands.length || brands.includes(p.item.brand)) && (by === 'rec' || p.offMi <= PRICE_DETOUR_MI))
    .sort((a, b) => score(a) - score(b) || a.alongMi - b.alongMi)
    .slice(0, n);
}
