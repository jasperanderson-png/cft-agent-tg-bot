// Drivers' fuel map: which stations are CFT partners, and which of them lie along a route.
// Pure functions, used by the server (tools/fuel-prices/driver-map.ts) and the Mini App
// (telegram_bot/mini_app/src/screens/drivers/).

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
  { corridorMi = 1.5, nearbyMi = 25 }: { corridorMi?: number; nearbyMi?: number } = {},
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
