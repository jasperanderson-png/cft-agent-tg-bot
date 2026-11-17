import type { DetourAsk, DetourResult } from '../../shared/driver-route.js';
import { DRIVER_MAP } from '../../shared/driver-config.js';
import { env } from '../../core/env.js';
import { HttpError } from '../../core/http.js';
import { asPoint, key, ORS, orsFetch, type Point } from './routing.js';

// Real detour time for the cheapest stations near a route (POST /api/driver/detours). Straight-line
// distance from the route is only the first filter: a station 1 mile away can sit across a divided
// highway or far from an exit. For each candidate, one OpenRouteService truck matrix call measures
//   (a point before the station → station → a point after it) − (before → after)
// i.e. the extra driving the stop costs. The points come from the Mini App (they are only used to
// measure driving time, nothing is saved); at most DRIVER_MAP.detour.candidates per call.

/** The asks the Mini App may send: a station and two route points around it, all valid coordinates. */
export function readAsks(body: unknown): DetourAsk[] {
  const list = (body as { stops?: unknown })?.stops;
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Send the stations to check.');
  if (list.length > DRIVER_MAP.detour.candidates) throw new HttpError(400, `At most ${DRIVER_MAP.detour.candidates} stations at a time.`);
  return list.map((v) => {
    const o = (v ?? {}) as Record<string, unknown>;
    const id = Number(o.id);
    const at = asPoint(o.at), before = asPoint(o.before), after = asPoint(o.after);
    if (!Number.isSafeInteger(id) || !at || !before || !after) throw new HttpError(400, 'Each station needs an id and three points.');
    return { id, at, before, after };
  });
}

/**
 * The matrix request: locations [B1..Bn, S1..Sn, A1..An]; sources B and S; destinations S and A.
 * Then B→S is durations[i][i], S→A is durations[n+i][n+i] and B→A is durations[i][n+i].
 */
export function matrixRequest(asks: DetourAsk[]) {
  const n = asks.length;
  const ll = (p: Point) => [p.lng, p.lat];
  const idx = (from: number) => Array.from({ length: n }, (_v, i) => from + i);
  return {
    locations: [...asks.map((a) => ll(a.before)), ...asks.map((a) => ll(a.at)), ...asks.map((a) => ll(a.after))],
    sources: [...idx(0), ...idx(n)],
    destinations: [...idx(n), ...idx(2 * n)],
    metrics: ['duration'],
  };
}

/** Reads the matrix answer into minutes of extra driving per station (null: no road found). */
export function readDetours(body: unknown, asks: DetourAsk[]): DetourResult[] {
  const d = (body as { durations?: (number | null)[][] }).durations ?? [];
  const n = asks.length;
  return asks.map((a, i) => {
    const toStop = d[i]?.[i], onward = d[n + i]?.[n + i], direct = d[i]?.[n + i];
    if (toStop == null || onward == null || direct == null) return { id: a.id, detourMin: null };
    return { id: a.id, detourMin: Math.max(0, Math.round(((toStop + onward - direct) / 60) * 10) / 10) };
  });
}

/** Extra driving minutes for each station; all null when routes are not set up (the map then keeps the straight-line view). */
export async function detourMinutes(asks: DetourAsk[], fetchImpl: typeof fetch = fetch): Promise<DetourResult[]> {
  if (!env.orsKey) return asks.map((a) => ({ id: a.id, detourMin: null }));
  const answer = await orsFetch(`${ORS}/v2/matrix/driving-hgv`, {
    method: 'POST',
    headers: { authorization: key(), 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(matrixRequest(asks)),
  }, fetchImpl);
  return readDetours(answer, asks);
}
