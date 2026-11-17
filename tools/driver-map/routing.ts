import type { DriverPlace, DriverRoute, DriverRouteStep, TruckProfile } from '../../shared/types.js';
import { env } from '../../core/env.js';
import { HttpError } from '../../core/http.js';
import { tomtomReady, tomtomRoute } from './tomtom.js';

// Truck routes and place search for the drivers' route map, through OpenRouteService (free plan:
// about 2,000 routes and 1,000 searches a day). The key stays on the server; the Mini App asks us.
// Routes use the "heavy vehicle" profile, so they respect the truck's height, weight and hazmat
// limits where OpenStreetMap knows them.

export const ORS = 'https://api.openrouteservice.org';
const MI_PER_M = 1 / 1609.344;

export interface Point {
  lat: number;
  lng: number;
}

/** The truck the driver set, made safe: 10'–15' high, 10,000–120,000 lb; default 13'6" and 80,000 lb. */
export function truckOf(input: unknown): TruckProfile {
  const t = (input ?? {}) as Record<string, unknown>;
  const clamp = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return { heightIn: Math.round(clamp(t.heightIn, 120, 180, 162)), weightLb: Math.round(clamp(t.weightLb, 10_000, 120_000, 80_000)), hazmat: t.hazmat === true };
}

export const asPoint = (v: unknown): Point | null => {
  const p = v as Point | null;
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 ? { lat: p.lat, lng: p.lng } : null;
};

export function key(): string {
  const k = env.orsKey;
  if (!k) throw new HttpError(503, 'Routes are not set up yet (ORS_API_KEY).', 'routing_off');
  return k;
}

export async function orsFetch(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new HttpError(502, 'The route service did not answer. Try again in a moment.', 'routing_down');
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string } | string };
  if (res.status === 429) throw new HttpError(429, 'Too many route requests today. Try again later.', 'routing_quota');
  if (!res.ok) {
    const err = typeof body.error === 'object' ? body.error : { message: body.error };
    // 2004: too long, 2009/2010: no road near a point.
    if (err?.code === 2010 || err?.code === 2009) throw new HttpError(422, 'No truck road near one of the points. Pick a place on or near a road.', 'no_route');
    if (err?.code === 2004) throw new HttpError(422, 'This trip is too long for one route. Split it into parts.', 'no_route');
    if (res.status === 404) throw new HttpError(422, 'No truck route found between these places.', 'no_route');
    console.error('OpenRouteService', res.status, err?.message);
    throw new HttpError(502, 'The route service could not plan this trip. Try again.', 'routing_down');
  }
  return body;
}

/** Place suggestions for what the driver types (US only, near them when we know where they are). */
export async function searchPlaces(text: string, near: Point | null, fetchImpl: typeof fetch = fetch): Promise<DriverPlace[]> {
  const q = text.trim().slice(0, 120);
  if (q.length < 3) return [];
  const params = new URLSearchParams({ api_key: key(), text: q, 'boundary.country': 'US', size: '6', layers: 'venue,address,street,locality,county,region,postalcode' });
  if (near) {
    params.set('focus.point.lat', String(near.lat));
    params.set('focus.point.lon', String(near.lng));
  }
  const body = (await orsFetch(`${ORS}/geocode/autocomplete?${params}`, {}, fetchImpl)) as { features?: { geometry?: { coordinates?: number[] }; properties?: { label?: string } }[] };
  const seen = new Set<string>();
  return (body.features ?? []).flatMap((f) => {
    const [lng, lat] = f.geometry?.coordinates ?? [];
    const label = f.properties?.label?.replace(/, (United States|USA)$/, '');
    // The same name twice (a city and its county) is shown once.
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !label || seen.has(label)) return [];
    seen.add(label);
    return [{ label, lat, lng }];
  });
}

/** The first place the search finds for typed text (when the driver did not pick a suggestion). */
async function findPlace(text: string, near: Point | null, fetchImpl: typeof fetch): Promise<DriverPlace> {
  const params = new URLSearchParams({ api_key: key(), text: text.slice(0, 160), 'boundary.country': 'US', size: '1' });
  if (near) {
    params.set('focus.point.lat', String(near.lat));
    params.set('focus.point.lon', String(near.lng));
  }
  const body = (await orsFetch(`${ORS}/geocode/search?${params}`, {}, fetchImpl)) as { features?: { geometry?: { coordinates?: number[] }; properties?: { label?: string } }[] };
  const f = body.features?.[0];
  const [lng, lat] = f?.geometry?.coordinates ?? [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HttpError(422, `Could not find “${text}”. Try a city and state, like “Dallas, TX”.`, 'no_place');
  return { label: (f!.properties?.label ?? text).replace(/, (United States|USA)$/, ''), lat, lng };
}

/** A place given as a point (with an optional label) or as typed text. */
async function placeOf(v: unknown, near: Point | null, fetchImpl: typeof fetch): Promise<DriverPlace> {
  const p = asPoint(v);
  if (p) return { ...p, label: String((v as { label?: unknown }).label ?? '').slice(0, 160) };
  const text = typeof v === 'string' ? v.trim() : typeof (v as { text?: unknown })?.text === 'string' ? String((v as { text: string }).text).trim() : '';
  if (!text) throw new HttpError(400, 'Say where the trip starts and ends.');
  return findPlace(text, near, fetchImpl);
}

interface OrsStep {
  distance: number;
  duration: number;
  type: number;
  instruction: string;
  name?: string;
  exit_number?: number;
  way_points: [number, number];
}

/** Reads OpenRouteService's GeoJSON answer into our route (miles, plain steps, street names). */
export function readRoute(body: unknown, from: DriverPlace, to: DriverPlace): DriverRoute {
  const f = (body as { features?: { geometry?: { coordinates?: number[][] }; properties?: { summary?: { distance?: number; duration?: number }; segments?: { steps?: OrsStep[] }[] } }[] }).features?.[0];
  const coords = f?.geometry?.coordinates ?? [];
  if (coords.length < 2) throw new HttpError(422, 'No truck route found between these places.', 'no_route');
  const path = coords.map(([lng, lat]) => ({ lat, lng }));
  const steps: DriverRouteStep[] = [];
  let mi = 0;
  for (const seg of f!.properties?.segments ?? []) {
    for (const st of seg.steps ?? []) {
      const len = (st.distance ?? 0) * MI_PER_M;
      const at = path[Math.min(path.length - 1, st.way_points?.[0] ?? 0)];
      steps.push({
        startMi: mi, endMi: mi + len, type: st.type, text: st.instruction ?? '', street: st.name && st.name !== '-' ? st.name : '', at,
        ...(st.exit_number ? { exit: st.exit_number } : {}),
      });
      mi += len;
    }
  }
  const summary = f!.properties?.summary ?? {};
  return { path, totalMi: (summary.distance ?? 0) * MI_PER_M || mi, durationS: summary.duration ?? 0, steps, from, to, source: 'ors' };
}

/**
 * A truck route from one place to another, optionally through a fuel stop: TomTom with live traffic
 * first (shared monthly allowance), OpenRouteService when TomTom is not set up, used up or failing.
 * The per-user request limit is applied by the caller (index.ts), whichever service answers.
 */
export async function planRoute(body: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<DriverRoute> {
  const near = asPoint(body.from);
  const [from, to] = await Promise.all([placeOf(body.from, null, fetchImpl), placeOf(body.to, near, fetchImpl)]);
  const via = asPoint(body.via);
  const truck = truckOf(body.truck);
  if (tomtomReady()) {
    try {
      return { ...(await tomtomRoute([from, ...(via ? [via] : []), to], truck, fetchImpl)), from, to };
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 422)) console.warn('TomTom route failed, using OpenRouteService:', (e as Error).message);
    }
  }
  const coordinates = [from, ...(via ? [via] : []), to].map((p) => [p.lng, p.lat]);
  const req = {
    coordinates,
    instructions: true,
    units: 'm',
    language: 'en',
    // Look up to 2 km around each point for a road: a GPS fix in a parking lot is not on one.
    radiuses: coordinates.map(() => 2000),
    options: {
      vehicle_type: 'hgv',
      profile_params: { restrictions: { height: Math.round(truck.heightIn * 0.0254 * 100) / 100, weight: Math.round(truck.weightLb * 0.000453592 * 10) / 10, hazmat: truck.hazmat } },
    },
  };
  const answer = await orsFetch(`${ORS}/v2/directions/driving-hgv/geojson`, {
    method: 'POST',
    headers: { authorization: key(), 'content-type': 'application/json', accept: 'application/geo+json' },
    body: JSON.stringify(req),
  }, fetchImpl);
  return readRoute(answer, from, to);
}
