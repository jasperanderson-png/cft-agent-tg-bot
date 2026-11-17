import type { DetourAsk, DetourResult, LatLng } from '../../shared/driver-route.js';
import { DRIVER_MAP } from '../../shared/driver-config.js';
import { env } from '../../core/env.js';
import { HttpError } from '../../core/http.js';
import { spendCapped } from '../../core/kv.js';
import { asPoint, key, ORS, orsFetch } from './routing.js';

// Real detour time for the cheapest stations near a route (POST /api/driver/detours). Straight-line
// distance from the route is only the first filter: a station 1 mile away can sit across a divided
// highway or far from an exit. For each candidate, one OpenRouteService truck matrix call measures
//   (a point before the station → station → a point after it) − (before → after)
// i.e. the extra driving the stop costs.
// The Mini App sends station ids and the two route points around each; where each station is comes
// from our own station list (so the call can't be used to route between arbitrary places). Matrix
// calls are capped per day and per month (DRIVER_MAP.detour), on top of the per-user rate limit.

/** A station to measure: its own map point and the route points before and after it. */
export interface DetourPoint {
  id: number;
  at: LatLng;
  before: LatLng;
  after: LatLng;
}

/** The asks the Mini App may send: a station id and two route points, at most DRIVER_MAP.detour.candidates. */
export function readAsks(body: unknown): DetourAsk[] {
  const list = (body as { stops?: unknown })?.stops;
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Send the stations to check.');
  if (list.length > DRIVER_MAP.detour.candidates) throw new HttpError(400, `At most ${DRIVER_MAP.detour.candidates} stations at a time.`);
  return list.map((v) => {
    const o = (v ?? {}) as Record<string, unknown>;
    const id = Number(o.id);
    const before = asPoint(o.before), after = asPoint(o.after);
    if (!Number.isSafeInteger(id) || !before || !after) throw new HttpError(400, 'Each station needs an id and two route points.');
    return { id, before, after };
  });
}

/**
 * The matrix request: locations [B1..Bn, S1..Sn, A1..An]; sources B and S; destinations S and A.
 * Then B→S is durations[i][i], S→A is durations[n+i][n+i] and B→A is durations[i][n+i].
 */
export function matrixRequest(points: DetourPoint[]) {
  const n = points.length;
  const ll = (p: LatLng) => [p.lng, p.lat];
  const idx = (from: number) => Array.from({ length: n }, (_v, i) => from + i);
  return {
    locations: [...points.map((a) => ll(a.before)), ...points.map((a) => ll(a.at)), ...points.map((a) => ll(a.after))],
    sources: [...idx(0), ...idx(n)],
    destinations: [...idx(n), ...idx(2 * n)],
    metrics: ['duration'],
  };
}

/** Reads the matrix answer into minutes of extra driving per station (null: no road found). */
export function readDetours(body: unknown, points: DetourPoint[]): DetourResult[] {
  const d = (body as { durations?: (number | null)[][] }).durations ?? [];
  const n = points.length;
  return points.map((a, i) => {
    const toStop = d[i]?.[i], onward = d[n + i]?.[n + i], direct = d[i]?.[n + i];
    if (toStop == null || onward == null || direct == null) return { id: a.id, detourMin: null };
    return { id: a.id, detourMin: Math.max(0, Math.round(((toStop + onward - direct) / 60) * 10) / 10) };
  });
}

/**
 * Extra driving minutes for each asked station. `stations` says where each station is (our list);
 * an unknown station, routes not set up, or the allowance used up give null (the map then keeps
 * the straight-line view for it).
 */
export async function detourMinutes(asks: DetourAsk[], stations: ReadonlyMap<number, LatLng>, fetchImpl: typeof fetch = fetch): Promise<DetourResult[]> {
  const none = asks.map((a) => ({ id: a.id, detourMin: null }));
  const points: DetourPoint[] = asks.flatMap((a) => {
    const at = stations.get(a.id);
    return at ? [{ ...a, at }] : [];
  });
  if (!env.orsKey || !points.length) return none;
  try {
    await spendCapped('ors-matrix', 1, { perDay: DRIVER_MAP.detour.matrixPerDay, perMonth: DRIVER_MAP.detour.matrixPerMonth });
  } catch (e) {
    if (e instanceof HttpError && e.code === 'allowance') return none;
    throw e;
  }
  const answer = await orsFetch(`${ORS}/v2/matrix/driving-hgv`, {
    method: 'POST',
    headers: { authorization: key(), 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(matrixRequest(points)),
  }, fetchImpl);
  const got = new Map(readDetours(answer, points).map((r) => [r.id, r.detourMin]));
  return asks.map((a) => ({ id: a.id, detourMin: got.get(a.id) ?? null }));
}
