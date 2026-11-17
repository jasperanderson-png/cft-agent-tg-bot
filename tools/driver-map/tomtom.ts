import type { DriverRoute, DriverRouteStep, TruckProfile } from '../../shared/types.js';
import { env } from '../../core/env.js';
import { HttpError } from '../../core/http.js';
import { kvReady, spend } from '../../core/kv.js';

// Truck routes with live traffic from TomTom: the truck's height, weight, length and hazmat, live
// traffic in the travel time, the slow stretches on the route, speed limits, and turn-by-turn steps
// with street names and exit numbers. Every call spends one unit of our daily and monthly allowance
// (core/kv.ts, shared/driver-config.ts); when TomTom is not set up, over its allowance or failing,
// routing.ts falls back to OpenRouteService.

const MI_PER_M = 1 / 1609.344;
const LEVEL: Record<string, 'slow' | 'jam' | 'closed' | 'roadwork'> = { JAM: 'jam', ROAD_WORK: 'roadwork', ROAD_CLOSURE: 'closed', OTHER: 'slow' };

/** TomTom manoeuvres as the turn types the app draws (the OpenRouteService numbering). */
const TYPE: Record<string, number> = {
  TURN_LEFT: 0, TURN_RIGHT: 1, SHARP_LEFT: 2, SHARP_RIGHT: 3, BEAR_LEFT: 4, BEAR_RIGHT: 5,
  STRAIGHT: 6, FOLLOW: 6, SWITCH_PARALLEL_ROAD: 6, SWITCH_MAIN_ROAD: 6, TAKE_FERRY: 6,
  ROUNDABOUT_CROSS: 7, ROUNDABOUT_RIGHT: 7, ROUNDABOUT_LEFT: 7, ROUNDABOUT_BACK: 7,
  MAKE_UTURN: 9, TRY_MAKE_UTURN: 9,
  ARRIVE: 10, ARRIVE_LEFT: 10, ARRIVE_RIGHT: 10, WAYPOINT_REACHED: 10, WAYPOINT_LEFT: 10, WAYPOINT_RIGHT: 10,
  DEPART: 11,
  KEEP_LEFT: 12, MOTORWAY_EXIT_LEFT: 12,
  KEEP_RIGHT: 13, MOTORWAY_EXIT_RIGHT: 13, TAKE_EXIT: 13,
  ENTER_MOTORWAY: 5, ENTER_FREEWAY: 5, ENTER_HIGHWAY: 5, ENTRANCE_RAMP: 5,
};

interface TtInstruction {
  routeOffsetInMeters: number;
  point: { latitude: number; longitude: number };
  pointIndex?: number;
  maneuver?: string;
  message?: string;
  street?: string;
  roadNumbers?: string[];
  exitNumber?: string;
}
interface TtRoute {
  summary: { lengthInMeters: number; travelTimeInSeconds: number; trafficDelayInSeconds?: number };
  legs: { points: { latitude: number; longitude: number }[] }[];
  sections?: { sectionType: string; startPointIndex: number; endPointIndex: number; simpleCategory?: string; delayInSeconds?: number; maxSpeedLimitInKmh?: number }[];
  guidance?: { instructions: TtInstruction[] };
}

/** A short plain-English instruction (TomTom's own text when it gives one). */
export function instructionText(i: TtInstruction): string {
  if (i.message) return i.message.replace(/<[^>]+>/g, '').trim();
  const road = i.roadNumbers?.[0] || i.street || '';
  const onto = road ? ` onto ${road}` : '';
  const m = i.maneuver ?? '';
  if (m === 'DEPART') return road ? `Head out on ${road}` : 'Start driving';
  if (m.startsWith('ARRIVE') || m.startsWith('WAYPOINT')) return 'Arrive at the stop';
  if (/LEFT$/.test(m) && /TURN|SHARP/.test(m)) return `Turn left${onto}`;
  if (/RIGHT$/.test(m) && /TURN|SHARP/.test(m)) return `Turn right${onto}`;
  if (m === 'KEEP_LEFT' || m === 'BEAR_LEFT') return `Keep left${onto}`;
  if (m === 'KEEP_RIGHT' || m === 'BEAR_RIGHT') return `Keep right${onto}`;
  if (m.includes('UTURN')) return 'Make a U-turn';
  if (m.includes('EXIT')) return `Take the exit${i.exitNumber ? ` ${i.exitNumber}` : ''}${onto}`;
  if (/MOTORWAY|FREEWAY|HIGHWAY|RAMP/.test(m)) return `Take the ramp${onto}`;
  return road ? `Continue on ${road}` : 'Continue';
}

/** TomTom's route as the app's route (without the from / to labels). */
export function readTomTom(r: TtRoute): Omit<DriverRoute, 'from' | 'to'> {
  const pts = r.legs.flatMap((leg, i) => (i ? leg.points.slice(1) : leg.points));
  const path = pts.map((p) => ({ lat: p.latitude, lng: p.longitude }));
  if (path.length < 2) throw new HttpError(422, 'No truck route found between these places.', 'no_route');
  const total = r.summary.lengthInMeters;
  const ins = r.guidance?.instructions ?? [];
  const steps: DriverRouteStep[] = ins.map((i, k) => {
    const end = ins[k + 1]?.routeOffsetInMeters ?? total;
    const street = i.street || i.roadNumbers?.[0] || '';
    return {
      startMi: i.routeOffsetInMeters * MI_PER_M, endMi: end * MI_PER_M,
      type: TYPE[i.maneuver ?? ''] ?? 6, text: instructionText(i), street,
      at: { lat: i.point.latitude, lng: i.point.longitude },
      ...(i.exitNumber && Number.isFinite(Number(i.exitNumber)) ? { exit: Number(i.exitNumber) } : {}),
    };
  });
  const traffic: NonNullable<DriverRoute['traffic']> = [];
  const speedLimits: NonNullable<DriverRoute['speedLimits']> = [];
  for (const s of r.sections ?? []) {
    if (s.sectionType === 'TRAFFIC') traffic.push({ from: s.startPointIndex, to: s.endPointIndex, level: LEVEL[s.simpleCategory ?? ''] ?? 'slow', delayMin: Math.round((s.delayInSeconds ?? 0) / 6) / 10 });
    else if (s.sectionType === 'SPEED_LIMIT' && Number.isFinite(s.maxSpeedLimitInKmh)) speedLimits.push({ from: s.startPointIndex, to: s.endPointIndex, mph: Math.round(s.maxSpeedLimitInKmh! / 1.609344 / 5) * 5 });
  }
  return {
    path, totalMi: total * MI_PER_M, durationS: r.summary.travelTimeInSeconds, steps,
    delayMin: Math.round((r.summary.trafficDelayInSeconds ?? 0) / 60), traffic, speedLimits, source: 'tomtom',
  };
}

export const tomtomReady = () => !!env.tomtomKey && kvReady();

/** A truck route through the points (2–5), with live traffic. Throws HttpError; the caller falls back. */
export async function tomtomRoute(points: { lat: number; lng: number }[], truck: TruckProfile, fetchImpl: typeof fetch = fetch) {
  await spend('route', 1);
  const params = new URLSearchParams({
    key: env.tomtomKey, traffic: 'true', travelMode: 'truck', vehicleCommercial: 'true', routeType: 'fastest',
    vehicleHeight: (truck.heightIn * 0.0254).toFixed(2), vehicleWeight: String(Math.round(truck.weightLb * 0.453592)),
    vehicleLength: '21.9', vehicleWidth: '2.6', vehicleAxleWeight: '9071',
    computeTravelTimeFor: 'all', instructionsType: 'text', language: 'en-US',
  });
  // Hazmat: class 3 (flammable liquids, what fuel tankers carry) is the common case for our drivers.
  if (truck.hazmat) params.set('vehicleLoadType', 'USHazmatClass3');
  params.append('sectionType', 'traffic');
  params.append('sectionType', 'speedLimit');
  const where = points.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join(':');
  let res: Response;
  try {
    res = await fetchImpl(`https://api.tomtom.com/routing/1/calculateRoute/${where}/json?${params}`, { signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new HttpError(503, 'The traffic service did not answer in time.', 'tomtom_down');
  }
  const body = (await res.json().catch(() => null)) as { routes?: TtRoute[] } | null;
  if (!res.ok || !body?.routes?.length) throw new HttpError(res.status === 400 ? 422 : 503, 'No truck route was found.', 'tomtom_failed');
  return readTomTom(body.routes[0]);
}
