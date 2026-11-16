import { cumulativeMiles, headingDeg, type LatLng } from '../../../../../shared/driverRoute';
import type { DriverRoute, DriverRouteStep } from '../../../../../shared/types';

// Driving along a route: where the truck is on it, how far off it, which turn is next, and the road's
// heading there. Pure functions, called every animation frame, so they look only near the last known
// position (a route that loops back on itself never makes the truck jump).

export interface Nav {
  route: DriverRoute;
  cum: number[];
}
export const navOf = (route: DriverRoute): Nav => ({ route, cum: cumulativeMiles(route.path) });

const rad = (d: number) => (d * Math.PI) / 180;

/** Where p falls on the path, searching the segments around `hintMi` first (then everywhere if far off). */
export function locate(nav: Nav, p: LatLng, hintMi: number | null): { alongMi: number; offMi: number; seg: number } {
  const { path } = nav.route;
  const { cum } = nav;
  const scan = (from: number, to: number) => {
    let best = { alongMi: 0, offMi: Infinity, seg: 0 };
    const kx = Math.cos(rad(p.lat)) * 69.172, ky = 69.0;
    for (let i = Math.max(0, from); i < Math.min(path.length - 1, to); i++) {
      const a = path[i], b = path[i + 1];
      const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky, bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const off = Math.hypot(ax + t * dx, ay + t * dy);
      if (off < best.offMi) best = { alongMi: cum[i] + t * (cum[i + 1] - cum[i]), offMi: off, seg: i };
    }
    return best;
  };
  if (hintMi != null) {
    const i = segAt(cum, hintMi);
    let lo = i, hi = i;
    while (lo > 0 && hintMi - cum[lo] < 3) lo--;
    while (hi < cum.length - 1 && cum[hi] - hintMi < 6) hi++;
    const near = scan(lo, hi);
    if (near.offMi < 0.5) return near;
  }
  return scan(0, path.length - 1);
}

/** The segment index that contains `mi`. */
export function segAt(cum: number[], mi: number): number {
  let lo = 0, hi = cum.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= mi) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** The point `mi` along the route and the road's heading there (looking ~80 m ahead, so it is steady). */
export function pointAt(nav: Nav, mi: number): { point: LatLng; heading: number } {
  const { path } = nav.route;
  const { cum } = nav;
  if (path.length < 2) return { point: path[0], heading: 0 };
  const m = Math.max(0, Math.min(mi, cum[cum.length - 1]));
  const i = segAt(cum, m);
  const span = cum[i + 1] - cum[i] || 1e-9;
  const t = (m - cum[i]) / span;
  const a = path[i], b = path[i + 1];
  const point = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  const j = segAt(cum, Math.min(m + 0.05, cum[cum.length - 1]));
  const ahead = path[Math.min(j + 1, path.length - 1)];
  return { point, heading: headingDeg(point, ahead.lat === point.lat && ahead.lng === point.lng ? b : ahead) };
}

/** The step being driven and the next manoeuvre. */
export function stepsAt(steps: DriverRouteStep[], mi: number): { cur: DriverRouteStep | undefined; next: DriverRouteStep | undefined; nextIdx: number } {
  let i = steps.findIndex((s) => s.endMi > mi + 0.01);
  if (i < 0) i = steps.length - 1;
  return { cur: steps[i], next: steps[i + 1], nextIdx: i + 1 };
}

/** The speed limit at `mi`, when the route has them (TomTom). */
export function speedLimitAt(nav: Nav, mi: number): number | null {
  const lim = nav.route.speedLimits;
  if (!lim?.length) return null;
  const i = segAt(nav.cum, mi);
  return lim.find((s) => i >= s.from && i < s.to)?.mph ?? null;
}

/** The path already driven, up to `mi`, ending exactly at `at`. */
export function drivenPath(nav: Nav, mi: number, at: LatLng): LatLng[] {
  const i = segAt(nav.cum, mi);
  return [...nav.route.path.slice(0, i + 1), at];
}

/** Turns the short way: the new heading unwrapped next to the previous one. */
export const unwrap = (prev: number | null, next: number) => (prev == null ? next : prev + ((((next - prev) % 360) + 540) % 360) - 180);
