// The drivers' route map: route geometry (which stations lie on the way), finding each station's
// map point, and reading truck routes. No network: every outside service is stubbed.
import { describe, expect, it, vi } from 'vitest';
import {
  cheapest, milesBetween, payPrice, pointAlong, projectOnPath, stationsAlongRoute, type LatLng,
} from '../../../shared/driver-route.js';
import { censusLookup, chainMatch, chainStores, geoKey, orsLookup, storeNo, type GeoStation } from '../geocode.js';
import { planRoute, readRoute, truckOf } from '../routing.js';
import { readTomTom } from '../tomtom.js';
import { voiceClip } from '../voice.js';
import { DRIVER_MAP } from '../../../shared/driver-config.js';

// Omaha → Lincoln → Kearney along I-80, roughly.
const PATH: LatLng[] = [
  { lat: 41.2565, lng: -95.9345 },
  { lat: 40.8136, lng: -96.7026 },
  { lat: 40.6993, lng: -99.0832 },
];

const st = (id: number, lat: number, lng: number, retail: number | null, discounted: number | null) =>
  ({ id, lat, lng, retail, discounted });

describe('route geometry', () => {
  it('measures miles', () => {
    const d = milesBetween(PATH[0], PATH[1]);
    expect(d).toBeGreaterThan(45);
    expect(d).toBeLessThan(55);
  });
  it('projects a point onto the path', () => {
    const r = projectOnPath(PATH[1], PATH);
    expect(r.offMi).toBeLessThan(0.01);
    expect(r.alongMi).toBeCloseTo(milesBetween(PATH[0], PATH[1]), 0);
  });
  it('walks along the path and points the right way', () => {
    const start = pointAlong(PATH, 0);
    expect(start.point.lat).toBeCloseTo(PATH[0].lat, 4);
    expect(start.heading).toBeGreaterThan(180); // heading south-west
    const end = pointAlong(PATH, 10_000);
    expect(end.point.lat).toBeCloseTo(PATH[2].lat, 4);
  });
});

describe('stationsAlongRoute', () => {
  it('splits on-route, nearby and far stations, ordered along the route', () => {
    const list = [
      st(1, 40.75, -98.0, 4.0, 3.5), // on I-80 between Lincoln and Kearney
      st(2, 41.046, -96.3, 4.0, 3.2), // on the Omaha–Lincoln leg
      st(3, 40.95, -98.0, 4.0, 3.0), // ~13 mi north: nearby
      st(4, 39.0, -98.0, 4.0, 2.0), // Kansas: far
      { id: 5, lat: null, lng: null, retail: 4, discounted: 1 }, // no coordinates yet
    ];
    const { onRoute, nearby } = stationsAlongRoute(PATH, list, { corridorMi: 1.5, nearbyMi: 20 });
    expect(onRoute.map((p) => p.item.id)).toEqual([2, 1]);
    expect(nearby.map((p) => p.item.id)).toEqual([3]);
    expect(cheapest(onRoute)?.item.id).toBe(2);
  });
  it('pays the discounted price, else retail', () => {
    expect(payPrice({ retail: 4, discounted: 3.5 })).toBe(3.5);
    expect(payPrice({ retail: 4, discounted: null })).toBe(4);
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const station = (over: Partial<GeoStation> = {}): GeoStation => ({ brand: 'pilot', name: 'Pilot 497', address: '130 Honda Drive', city: 'LINCOLN', state: 'AL', ...over });

describe('station map points', () => {
  // As All The Places publishes them (the chains' own store locators).
  const pilot = chainStores({
    features: [
      { geometry: { coordinates: [-86.159239, 33.593045] }, properties: { ref: '497', 'addr:city': 'Lincoln', 'addr:state': 'AL' } },
      { geometry: { coordinates: [-86.121727, 33.593729] }, properties: { ref: '1549', 'addr:city': 'Lincoln', 'addr:state': 'AL' } },
      { geometry: { coordinates: [-111.916, 40.727] }, properties: { ref: '746', 'addr:city': 'Salt Lake City', 'addr:state': 'UT' } },
      { geometry: { coordinates: [-120.2, 55.7] }, properties: { ref: '830', 'addr:city': 'Dawson Creek', 'addr:state': 'BC', 'addr:country': 'CA' } },
    ],
  });
  const ta = chainStores({ features: [{ geometry: { coordinates: [-104.68, 34.94] }, properties: { ref: '0023', 'addr:city': 'Santa Rosa', 'addr:state': 'New Mexico' } }] });
  const index = { pilot, loves: [], ta, speedway: [] };

  it('reads store numbers and keys', () => {
    expect(storeNo('Pilot 1549')).toBe('1549');
    expect(storeNo('TA 0045')).toBe('45');
    expect(storeNo('TA Express')).toBeNull();
    expect(geoKey(station())).toBe('pilot|497|130 honda drive|lincoln|al');
    expect(geoKey(station({ address: null, city: null }))).toBeNull();
    expect(pilot).toHaveLength(3); // the Canadian one is left out
    expect(ta[0]).toMatchObject({ ref: '23', state: 'NM' }); // zeros and full state names are evened out
  });
  it('takes the chain\'s own point by store number and state, never from another state', () => {
    expect(chainMatch(index, station())).toEqual({ lat: 33.593045, lng: -86.159239 });
    expect(chainMatch(index, station({ name: 'Flying J 746', state: 'NE', city: 'LINCOLN' }))).toBeNull(); // 746 is in Utah
    // No number in the cabinet: the only store of the brand in that city.
    expect(chainMatch(index, station({ brand: 'ta', name: 'TA', city: 'SANTA ROSA', state: 'NM' }))).toEqual({ lat: 34.94, lng: -104.68 });
    // Two Pilots in Lincoln and a number the chain does not list: no guess.
    expect(chainMatch(index, station({ name: 'Pilot 9999' }))).toBeNull();
  });
  it('asks the Census only for street addresses, and reads its answer', async () => {
    const census = vi.fn(async () => json({ result: { addressMatches: [{ coordinates: { x: -86.12, y: 33.59 } }] } }));
    expect(await censusLookup(station(), census as unknown as typeof fetch)).toEqual({ lat: 33.59, lng: -86.12 });
    expect(String((census.mock.calls[0] as unknown[])[0])).toContain('street=130+Honda+Drive');
    expect(await censusLookup(station({ address: 'I-80, Exit 305 & US 6' }), census as unknown as typeof fetch)).toBeNull();
    expect(census).toHaveBeenCalledTimes(1);
    const none = vi.fn(async () => json({ result: { addressMatches: [] } }));
    expect(await censusLookup(station(), none as unknown as typeof fetch)).toBeNull();
  });
  it('keeps an address search only when it is sure and in the same state', async () => {
    const answer = (region_a: string, confidence: number) => vi.fn(async () => json({ features: [{ geometry: { coordinates: [-86.1, 33.6] }, properties: { region_a, confidence } }] })) as unknown as typeof fetch;
    expect(await orsLookup(station(), 'k', answer('AL', 0.9))).toEqual({ lat: 33.6, lng: -86.1 });
    expect(await orsLookup(station(), 'k', answer('GA', 1))).toBeNull();
    expect(await orsLookup(station(), 'k', answer('AL', 0.5))).toBeNull();
  });
});

describe('truck routes', () => {
  const from = { label: 'Omaha, NE', lat: 41.2565, lng: -95.9345 };
  const to = { label: 'Kearney, NE', lat: 40.6993, lng: -99.0832 };
  const ors = {
    features: [{
      geometry: { coordinates: PATH.map((p) => [p.lng, p.lat]) },
      properties: {
        summary: { distance: 160934.4, duration: 7200 },
        segments: [{ steps: [
          { distance: 80467.2, duration: 3600, type: 11, instruction: 'Head west on I-80 W', name: 'I-80 W', way_points: [0, 1] },
          { distance: 80467.2, duration: 3600, type: 1, instruction: 'Turn right onto 2nd Ave', name: '2nd Ave', way_points: [1, 2], exit_number: 272 },
          { distance: 0, duration: 0, type: 10, instruction: 'Arrive at Kearney', name: '-', way_points: [2, 2] },
        ] }],
      },
    }],
  };
  it('reads miles, street names and where each turn is', () => {
    const r = readRoute(ors, from, to);
    expect(r.totalMi).toBeCloseTo(100, 5);
    expect(r.durationS).toBe(7200);
    expect(r.path).toHaveLength(3);
    expect(r.steps.map((s) => [s.street, Math.round(s.startMi), s.type])).toEqual([['I-80 W', 0, 11], ['2nd Ave', 50, 1], ['', 100, 10]]);
    expect(r.steps[1]).toMatchObject({ at: PATH[1], exit: 272, text: 'Turn right onto 2nd Ave' });
  });
  it('keeps the truck within sane limits', () => {
    expect(truckOf(undefined)).toEqual({ heightIn: 162, weightLb: 80000, hazmat: false });
    expect(truckOf({ heightIn: 400, weightLb: 5, hazmat: true })).toEqual({ heightIn: 180, weightLb: 10000, hazmat: true });
  });
  it('asks for a heavy-vehicle route with the truck in metric units, through the fuel stop', async () => {
    process.env.ORS_API_KEY = 'ors-key';
    try {
      const calls: { url: string; init?: RequestInit }[] = [];
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, init }); return json(ors); }) as unknown as typeof fetch;
      const r = await planRoute({ from, to, via: { lat: 40.8, lng: -96.7 }, truck: { heightIn: 162, weightLb: 80000, hazmat: true } }, fetchImpl);
      expect(r.to.label).toBe('Kearney, NE');
      expect(calls).toHaveLength(1); // both ends were points: no place search
      expect(calls[0].url).toBe('https://api.openrouteservice.org/v2/directions/driving-hgv/geojson');
      expect((calls[0].init!.headers as Record<string, string>).authorization).toBe('ors-key');
      const body = JSON.parse(String(calls[0].init!.body));
      expect(body.coordinates).toEqual([[-95.9345, 41.2565], [-96.7, 40.8], [-99.0832, 40.6993]]);
      expect(body.options).toEqual({ vehicle_type: 'hgv', profile_params: { restrictions: { height: 4.11, weight: 36.3, hazmat: true } } });

      // Typed text is found first; "no road near the point" becomes a clear message.
      const typed = vi.fn(async (url: string) => (url.includes('/geocode/search')
        ? json({ features: [{ geometry: { coordinates: [-99.08, 40.7] }, properties: { label: 'Kearney, NE, United States' } }] })
        : json({ error: { code: 2010, message: 'Could not find routable point' } }, 404))) as unknown as typeof fetch;
      await expect(planRoute({ from, to: 'Kearney NE' }, typed)).rejects.toMatchObject({ status: 422, message: expect.stringContaining('No truck road near') });
    } finally {
      delete process.env.ORS_API_KEY;
    }
  });
  it('says so when routes are not switched on', async () => {
    await expect(planRoute({ from, to })).rejects.toMatchObject({ status: 503 });
  });
});

describe('TomTom truck routes and the natural voice, within our free allowances', () => {
  // A fake Upstash Redis: the daily and monthly counters, rate limits and the voice cache.
  function fakeRedis() {
    const kv = new Map<string, string>();
    const calls: unknown[][] = [];
    const handle = (cmd: unknown[]) => {
      calls.push(cmd);
      const [op, key, val] = cmd as [string, string, string | number];
      if (op === 'INCRBY' || op === 'INCR') { const n = Number(kv.get(key) ?? 0) + Number(op === 'INCR' ? 1 : val); kv.set(key, String(n)); return n; }
      if (op === 'DECRBY') { const n = Number(kv.get(key) ?? 0) - Number(val); kv.set(key, String(n)); return n; }
      if (op === 'GET') return kv.get(key) ?? null;
      if (op === 'SET') { kv.set(key, String(val)); return 'OK'; }
      return 1;
    };
    return { kv, calls, handle };
  }
  const tt = {
    routes: [{
      summary: { lengthInMeters: 160934.4, travelTimeInSeconds: 7200, trafficDelayInSeconds: 300 },
      legs: [{ points: [{ latitude: 41.2565, longitude: -95.9345 }, { latitude: 40.8136, longitude: -96.7026 }] }, { points: [{ latitude: 40.8136, longitude: -96.7026 }, { latitude: 40.6993, longitude: -99.0832 }] }],
      sections: [{ sectionType: 'TRAFFIC', startPointIndex: 0, endPointIndex: 1, simpleCategory: 'JAM', delayInSeconds: 300 }, { sectionType: 'SPEED_LIMIT', startPointIndex: 1, endPointIndex: 2, maxSpeedLimitInKmh: 120 }],
      guidance: { instructions: [
        { routeOffsetInMeters: 0, point: { latitude: 41.2565, longitude: -95.9345 }, maneuver: 'DEPART', message: 'Leave from Dodge St', street: 'Dodge St' },
        { routeOffsetInMeters: 80467.2, point: { latitude: 40.8136, longitude: -96.7026 }, maneuver: 'MOTORWAY_EXIT_RIGHT', exitNumber: '305', street: 'US-6', roadNumbers: ['US-6'] },
        { routeOffsetInMeters: 160934.4, point: { latitude: 40.6993, longitude: -99.0832 }, maneuver: 'ARRIVE', message: 'You have arrived' },
      ] },
    }],
  };
  const env = (on: boolean) => {
    for (const [k, v] of Object.entries({ TOMTOM_API_KEY: 'tt-key', GOOGLE_TTS_KEY: 'g-key', KV_REST_API_URL: 'https://redis.example', KV_REST_API_TOKEN: 'kv-token', ORS_API_KEY: 'ors-key' })) {
      if (on) process.env[k] = v;
      else delete process.env[k];
    }
  };

  it('reads TomTom: the legs joined, traffic, speed limits, exits and our turn types', () => {
    const r = readTomTom(tt.routes[0] as never);
    expect(r.path).toHaveLength(3); // the stop point is not doubled
    expect(r).toMatchObject({ source: 'tomtom', delayMin: 5, durationS: 7200, traffic: [{ from: 0, to: 1, level: 'jam', delayMin: 5 }], speedLimits: [{ from: 1, to: 2, mph: 75 }] });
    expect(r.totalMi).toBeCloseTo(100, 5);
    expect(r.steps.map((s) => [s.type, s.text, Math.round(s.startMi), Math.round(s.endMi)])).toEqual([[11, 'Leave from Dodge St', 0, 50], [13, 'Take the exit 305 onto US-6', 50, 100], [10, 'You have arrived', 100, 100]]);
    expect(r.steps[1]).toMatchObject({ exit: 305, street: 'US-6' });
  });

  it('routes with TomTom first, counting our daily and monthly allowance; OpenRouteService when TomTom fails', async () => {
    env(true);
    try {
      const redis = fakeRedis();
      let tomtomUp = true;
      const urls: string[] = [];
      const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
        urls.push(url);
        if (url === 'https://redis.example') return json({ result: redis.handle(JSON.parse(String(init!.body))) });
        if (url.startsWith('https://api.tomtom.com/')) return tomtomUp ? json(tt) : json({ error: 'down' }, 500);
        if (url.includes('openrouteservice')) return json({ features: [{ geometry: { coordinates: PATH.map((p) => [p.lng, p.lat]) }, properties: { summary: { distance: 1000, duration: 60 }, segments: [] } }] });
        throw new Error('unexpected ' + url);
      });
      vi.stubGlobal('fetch', fetchStub);
      const from = { label: 'Omaha', lat: 41.2565, lng: -95.9345 }, to = { label: 'Kearney', lat: 40.6993, lng: -99.0832 };
      const r = await planRoute({ from, to, truck: { heightIn: 162, weightLb: 80000, hazmat: true } }, fetchStub as unknown as typeof fetch);
      expect(r.source).toBe('tomtom');
      const q = new URL(urls.find((u) => u.startsWith('https://api.tomtom.com/'))!).searchParams;
      expect(Object.fromEntries(['travelMode', 'traffic', 'vehicleHeight', 'vehicleWeight', 'vehicleLoadType'].map((k) => [k, q.get(k)]))).toEqual({ travelMode: 'truck', traffic: 'true', vehicleHeight: '4.11', vehicleWeight: '36287', vehicleLoadType: 'USHazmatClass3' });
      const day = new Date().toISOString().slice(0, 10), month = day.slice(0, 7);
      expect(redis.kv.get(`cft:budget:route:${day}`)).toBe('1');
      expect(redis.kv.get(`cft:budget:route:${month}`)).toBe('1');
      tomtomUp = false;
      expect((await planRoute({ from, to }, fetchStub as unknown as typeof fetch)).source).toBe('ors');
      // Today's allowance used up: TomTom is not asked at all, the route still comes (OpenRouteService).
      redis.kv.set(`cft:budget:route:${day}`, String(DRIVER_MAP.budgets.route.perDay));
      tomtomUp = true;
      const before = urls.filter((u) => u.startsWith('https://api.tomtom.com/')).length;
      expect((await planRoute({ from, to }, fetchStub as unknown as typeof fetch)).source).toBe('ors');
      expect(urls.filter((u) => u.startsWith('https://api.tomtom.com/')).length).toBe(before);
    } finally {
      env(false);
      vi.unstubAllGlobals();
    }
  });

  it('speaks with Google once per phrase (then from our cache), within the character allowance', async () => {
    await expect(voiceClip('Now, turn left.', 'fenrir', null)).rejects.toMatchObject({ status: 503 }); // not configured
    env(true);
    try {
      const redis = fakeRedis();
      let google = 0;
      const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === 'https://redis.example') return json({ result: redis.handle(JSON.parse(String(init!.body))) });
        if (url.startsWith('https://texttospeech.googleapis.com/')) {
          google++;
          const body = JSON.parse(String(init!.body));
          expect(body.voice.name).toBe('en-US-Chirp3-HD-Fenrir');
          return json({ audioContent: Buffer.from('ID3-fake-mp3').toString('base64') });
        }
        throw new Error('unexpected ' + url);
      });
      vi.stubGlobal('fetch', fetchStub);
      const a = await voiceClip('Now,  turn left.', 'fenrir', '1.2.3.4', fetchStub as unknown as typeof fetch);
      const b = await voiceClip('Now, turn left.', 'fenrir', '1.2.3.4', fetchStub as unknown as typeof fetch);
      expect(Buffer.from(a).toString()).toBe('ID3-fake-mp3');
      expect(Buffer.from(b).toString()).toBe('ID3-fake-mp3');
      expect(google).toBe(1); // the second time from the cache
      expect(redis.kv.get(`cft:budget:voice:${new Date().toISOString().slice(0, 7)}`)).toBe(String('Now, turn left.'.length));
      expect([...redis.kv.keys()].every((k) => k.startsWith('cft:'))).toBe(true); // only our own keys
      await expect(voiceClip('x'.repeat(241), 'fenrir', null, fetchStub as unknown as typeof fetch)).rejects.toMatchObject({ status: 400 });
      await expect(voiceClip('Hi', 'robot', null, fetchStub as unknown as typeof fetch)).rejects.toMatchObject({ status: 400 });
    } finally {
      env(false);
      vi.unstubAllGlobals();
    }
  });
});
