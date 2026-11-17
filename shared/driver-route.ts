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
 * Splits stations into those on the route (within corridorMi of the line) and nearby ones (within
 * nearbyMi), each sorted by how far along the route they are.
 */
export function stationsAlongRoute<T extends { lat?: number | null; lng?: number | null }>(
  path: LatLng[],
  stations: T[],
  { corridorMi = DRIVER_MAP.corridorMi, nearbyMi = DRIVER_MAP.nearbyMi }: { corridorMi?: number; nearbyMi?: number } = {},
): { onRoute: Placed<T>[]; nearby: Placed<T>[] } {
  const onRoute: Placed<T>[] = [];
  const nearby: Placed<T>[] = [];
  if (path.length < 2) return { onRoute, nearby };
  const cum = cumulativeMiles(path);
  // A cheap bounding box first, so a cross-country route doesn't project every station in the country.
  const pad = nearbyMi / 55;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of path) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
  }
  for (const s of stations) {
    if (s.lat == null || s.lng == null) continue;
    if (s.lat < minLat - pad || s.lat > maxLat + pad || s.lng < minLng - pad * 1.4 || s.lng > maxLng + pad * 1.4) continue;
    const pr = projectOnPath({ lat: s.lat, lng: s.lng }, path, cum);
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
export const savingOf = (s: { retail: number | null; discounted: number | null }) => (s.retail != null && s.discounted != null ? s.retail - s.discounted : null);

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

// ---- real detour time (tools/driver-map/detours.ts measures it)

/** A station to check, with a route point before it and one after it. */
export interface DetourAsk {
  id: number;
  at: LatLng;
  before: LatLng;
  after: LatLng;
}
export interface DetourResult {
  id: number;
  /** Extra minutes of driving to stop there; null when no road was found. */
  detourMin: number | null;
}

/** The cheapest `n` corridor stations to check, each with the route `aroundMi` before and after it. */
export function detourAsks<T extends { id: number; lat?: number | null; lng?: number | null; retail: number | null; discounted: number | null }>(
  path: LatLng[],
  onRoute: Placed<T>[],
  n: number = DRIVER_MAP.detour.candidates,
  aroundMi: number = DRIVER_MAP.detour.aroundMi,
): DetourAsk[] {
  const cum = cumulativeMiles(path);
  return onRoute
    .filter((p) => p.item.lat != null && p.item.lng != null && payPrice(p.item) != null)
    .sort((a, b) => payPrice(a.item)! - payPrice(b.item)!)
    .slice(0, n)
    .map((p) => ({
      id: p.item.id,
      at: { lat: p.item.lat!, lng: p.item.lng! },
      before: pointAlong(path, p.alongMi - aroundMi, cum).point,
      after: pointAlong(path, p.alongMi + aroundMi, cum).point,
    }));
}

/**
 * Applies measured detours: a corridor station that costs more than `maxMin` extra minutes is not
 * "on the route" any more (it moves to the nearby list). Unmeasured stations stay where they are.
 */
export function applyDetours<T extends { id: number }>(
  placed: { onRoute: Placed<T>[]; nearby: Placed<T>[] },
  detours: Map<number, number | null>,
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
