// The route map's road checks: per-user request limits, how old a price is, the daily station
// location job, real detour time, the fuel range, live location alerts and the shared thresholds.
// No network and no database: outside services, Telegram and the database are faked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyDetours, bestStop, detourAsks, priceAge, rangeOf, reachable, stationsAlongRoute, type LatLng, type Placed } from '../../../shared/driver-route.js';
import { DRIVER_MAP } from '../../../shared/driver-config.js';
import type { DriverStation } from '../../../shared/types.js';
import { env } from '../../../core/env.js';
import { firstTime, rateLimit } from '../../../core/kv.js';
import type { Db } from '../../../db_storage/db.js';
import { detourMinutes, matrixRequest, readAsks, readDetours } from '../detours.js';
import { alertText, liveLocationAlert, nextStationAhead, travelHeading } from '../alerts.js';
import { refreshStationLocations } from '../stations.js';
import { handle } from '../../../telegram_bot/server/router.js';

// Omaha → Lincoln → Kearney along I-80, roughly (heading west).
const PATH: LatLng[] = [{ lat: 41.2565, lng: -95.9345 }, { lat: 40.8136, lng: -96.7026 }, { lat: 40.6993, lng: -99.0832 }];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const station = (id: number, lat: number | null, lng: number | null, over: Partial<DriverStation> = {}): DriverStation => ({
  id, station: `Pilot #${id}`, brand: 'p', retail: 4, discounted: 3.5, updatedAt: null, state: 'NE', city: 'LINCOLN', address: '1 Main St', lat, lng, ...over,
});
const placedAt = (id: number, alongMi: number, offMi: number, price = 3.5): Placed<DriverStation> => ({ item: station(id, 41, -96, { discounted: price }), alongMi, offMi });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.ORS_API_KEY;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.DRIVER_RATE_ROUTE;
});

describe('12 · requests are limited per Telegram user, with or without Redis', () => {
  it('counts each user separately and refuses the call over the limit', async () => {
    for (let i = 0; i < 3; i++) await rateLimit('t-route', 'tg:1', 3);
    await expect(rateLimit('t-route', 'tg:1', 3)).rejects.toMatchObject({ status: 429 });
    await expect(rateLimit('t-route', 'tg:2', 3)).resolves.toBeUndefined(); // another driver is not affected
    await expect(rateLimit('t-places', 'tg:1', 3)).resolves.toBeUndefined(); // another kind of request neither
  });
  it('still limits when Redis is set up but does not answer', async () => {
    Object.assign(process.env, { KV_REST_API_URL: 'https://redis.example', KV_REST_API_TOKEN: 't' });
    vi.stubGlobal('fetch', async () => { throw new Error('down'); });
    for (let i = 0; i < 2; i++) await rateLimit('t-down', 'tg:9', 2);
    await expect(rateLimit('t-down', 'tg:9', 2)).rejects.toMatchObject({ status: 429 });
  });
  it('takes the limit from DRIVER_RATE_* when set, else from the config', () => {
    expect(env.driverRate('route', DRIVER_MAP.ratePerMinute.route)).toBe(20);
    process.env.DRIVER_RATE_ROUTE = '5';
    expect(env.driverRate('route', DRIVER_MAP.ratePerMinute.route)).toBe(5);
    process.env.DRIVER_RATE_ROUTE = 'lots';
    expect(env.driverRate('route', DRIVER_MAP.ratePerMinute.route)).toBe(20);
  });
});

describe('7 · how old a price is', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  it('says it in plain words', () => {
    expect(priceAge('2026-11-17T11:59:30Z', now)).toEqual({ text: 'just now', stale: false });
    expect(priceAge('2026-11-17T11:35:00Z', now)).toEqual({ text: '25 min ago', stale: false });
    expect(priceAge('2026-11-17T07:00:00Z', now)).toEqual({ text: '5 h ago', stale: false });
    expect(priceAge('2026-11-14T12:00:00Z', now)).toEqual({ text: '3 days ago', stale: true });
  });
  it('marks prices older than 24 hours as old', () => {
    expect(priceAge('2026-11-16T12:01:00Z', now)!.stale).toBe(false);
    expect(priceAge('2026-11-16T12:00:00Z', now)).toEqual({ text: '24 h ago', stale: true });
  });
  it('has nothing to say without a date', () => {
    expect(priceAge(null, now)).toBeNull();
    expect(priceAge('not a date', now)).toBeNull();
  });
});

describe('9 · the daily station location job', () => {
  // A fake database: the latest price pull with three stations, and the map point cache.
  function fakeDb(geo: Map<string, { lat: number; lng: number; old: boolean }>) {
    const pull = [1, 2, 3].map((n) => ({
      pulled_at: new Date(), station_id: n, brand: 'pilot', name: `PILOT #${n}`, state: 'NE', city: 'LINCOLN', address: `${n} Main St`,
      route_exit: null, retail: 4, discounted: 3.5, price_updated_at: new Date(), broken: false,
    }));
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('discount_datasets')) return { rows: pull };
      if (sql.includes('to_regclass')) return { rows: [{ t: 'station_geo' }] };
      if (sql.includes('geocoded_at < now()')) return { rows: [...geo].filter(([, v]) => v.old).map(([key]) => ({ key })) };
      if (sql.includes('from station_geo')) {
        const keys = params[0] as string[];
        return { rows: keys.filter((k) => geo.has(k)).map((k) => ({ key: k, lat: geo.get(k)!.lat, lng: geo.get(k)!.lng, status: 'ok' })) };
      }
      return { rows: [] };
    });
    return { query } as unknown as Db;
  }

  it('looks up new stations first, then re-checks old points, within its time budget', async () => {
    const geo = new Map<string, { lat: number; lng: number; old: boolean }>();
    const db = fakeDb(geo);
    // First run: nothing cached; every station is looked up.
    const seen: string[][] = [];
    const locate = vi.fn(async (_db: Db, items: { key: string }[], deps?: { budgetMs?: number; limit?: number }) => {
      seen.push(items.map((i) => i.key));
      expect(deps).toEqual({ budgetMs: DRIVER_MAP.relocateBudgetS * 1000, limit: DRIVER_MAP.relocateMax });
      for (const it of items) geo.set(it.key, { lat: 40.8, lng: -96.7, old: false });
      return items.length;
    });
    expect(await refreshStationLocations(db, locate as never)).toEqual({ placed: 3, rechecked: 0, pending: 0 });
    const keys = seen[0];
    expect(keys).toHaveLength(3);

    // Later: one point is older than relocateDays → only that one is checked again.
    geo.get(keys[1])!.old = true;
    await new Promise((r) => setTimeout(r, 0));
    // (the lock from the first run is still on: a second pass within 3 minutes does nothing)
    expect(await refreshStationLocations(db, locate as never)).toEqual({ placed: 0, rechecked: 0, pending: 0 });
    vi.useFakeTimers({ now: Date.now() + 181_000 });
    expect(await refreshStationLocations(db, locate as never)).toMatchObject({ rechecked: 1, pending: 0 });
    expect(seen.at(-1)).toEqual([keys[1]]);
  });

  it('is a scheduled job: refuses calls without the cron secret', async () => {
    const res = await handle({ method: 'GET', path: 'cron/stations', query: new URLSearchParams(), headers: {}, body: null, ip: null });
    expect(res.status).toBe(401);
  });
});

describe('2 · real detour time for the cheapest corridor stations', () => {
  const placed = [placedAt(1, 30, 0.2, 3.9), placedAt(2, 60, 1.2, 3.1), placedAt(3, 90, 0.4, 3.4)];

  it('asks about the cheapest few, with a route point before and after each', () => {
    const asks = detourAsks(PATH, placed, 2, 15);
    expect(asks.map((a) => a.id)).toEqual([2, 3]); // cheapest first, only 2
    expect(asks[0].before).not.toEqual(asks[0].after);
    expect(asks[0].at).toEqual({ lat: 41, lng: -96 });
  });

  it('builds one truck matrix call and reads the extra minutes per station', () => {
    const asks = detourAsks(PATH, placed, 2, 15);
    const req = matrixRequest(asks);
    expect(req.locations).toHaveLength(6); // before ×2, station ×2, after ×2
    expect(req.sources).toEqual([0, 1, 2, 3]);
    expect(req.destinations).toEqual([2, 3, 4, 5]);
    // durations[source][destination], seconds. Station 2: 600 + 700 − 1200 = 100 s; station 3: no road.
    const durations = [
      [600, 0, 1200, 0],
      [0, null, 0, 900],
      [0, 0, 700, 0],
      [0, 0, 0, 500],
    ];
    expect(readDetours({ durations }, asks)).toEqual([{ id: 2, detourMin: 1.7 }, { id: 3, detourMin: null }]);
  });

  it('calls OpenRouteService once, and gives no answer (not an error) when routes are off', async () => {
    const asks = detourAsks(PATH, placed, 1, 15);
    expect(await detourMinutes(asks)).toEqual([{ id: 2, detourMin: null }]);
    process.env.ORS_API_KEY = 'ors-key';
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.openrouteservice.org/v2/matrix/driving-hgv');
      expect(JSON.parse(String(init!.body)).metrics).toEqual(['duration']);
      return json({ durations: [[300, 1000], [0, 900]] });
    });
    expect(await detourMinutes(asks, fetchStub as unknown as typeof fetch)).toEqual([{ id: 2, detourMin: 3.3 }]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('accepts only a few well-formed stations from the Mini App', () => {
    const ok = { id: 1, at: PATH[0], before: PATH[0], after: PATH[1] };
    expect(readAsks({ stops: [ok] })).toHaveLength(1);
    expect(() => readAsks({ stops: [] })).toThrow();
    expect(() => readAsks({ stops: [{ ...ok, at: { lat: 200, lng: 0 } }] })).toThrow();
    expect(() => readAsks({ stops: Array(DRIVER_MAP.detour.candidates + 1).fill(ok) })).toThrow(/At most/);
  });

  it('moves a station with a long detour off "on your route"; unmeasured ones stay', () => {
    const r = applyDetours({ onRoute: placed, nearby: [] }, new Map([[2, 14], [3, 2]]), 10);
    expect(r.onRoute.map((p) => p.item.id)).toEqual([1, 3]);
    expect(r.nearby.map((p) => p.item.id)).toEqual([2]);
    expect(applyDetours({ onRoute: placed, nearby: [] }, new Map())).toEqual({ onRoute: placed, nearby: [] });
  });
});

describe('6 · miles until empty', () => {
  it('reads what the driver typed', () => {
    expect(rangeOf('450')).toBe(450);
    expect(rangeOf('450 mi')).toBe(450);
    expect(rangeOf('')).toBeNull();
    expect(rangeOf('0')).toBeNull();
    expect(rangeOf('99999')).toBeNull();
  });
  it('flags stations reachable before empty and picks the cheapest of those', () => {
    const near = placedAt(1, 100, 0.5, 3.6), far = placedAt(2, 400, 0.5, 3.1);
    expect(reachable(near, 300)).toBe(true);
    expect(reachable(far, 300)).toBe(false);
    expect(bestStop([near, far], null)!.item.id).toBe(2); // no range: simply the cheapest
    expect(bestStop([near, far], 300)!.item.id).toBe(1); // with a range: the cheapest you can reach
    expect(bestStop([far], 300)!.item.id).toBe(2); // none reachable: still show the cheapest (flagged on the card)
  });
});

describe('11 · live location alerts', () => {
  // Driving west on I-80 near Lincoln; one station 30 mi ahead, one 30 mi behind, one far ahead.
  const here = { lat: 40.81, lng: -96.70 };
  const ahead = station(11, 40.75, -97.27);
  const behind = station(12, 40.87, -96.13);
  const farAhead = station(13, 40.70, -99.08);

  it('takes the direction from the phone, else from the last position', () => {
    expect(travelHeading({ ...here, heading: 270 }, null)).toBe(270);
    expect(travelHeading(here, null)).toBeNull();
    expect(travelHeading(here, { lat: 40.8101, lng: -96.6999 })).toBeNull(); // barely moved
    const h = travelHeading(here, { lat: 40.82, lng: -96.40 })!;
    expect(h).toBeGreaterThan(260);
    expect(h).toBeLessThan(280);
  });

  it('finds the nearest station ahead within 50 mi, not behind or too far', () => {
    expect(nextStationAhead([behind, farAhead, ahead], here, 270)?.station.id).toBe(11);
    expect(nextStationAhead([behind, farAhead], here, 270)).toBeNull();
    expect(nextStationAhead([ahead], here, 90)).toBeNull(); // driving east: it's behind
  });

  it('writes a plain alert with the CFT price', () => {
    const t = alertText(ahead, 29.6);
    expect(t).toContain('CFT station ahead: Pilot #11');
    expect(t).toContain('about 30 mi');
    expect(t).toContain('$3.50/gal');
    expect(t).toContain('save $0.50');
  });

  it('alerts once per station per driver', async () => {
    const load = async () => [ahead, behind];
    const db = {} as Db;
    expect(await liveLocationAlert(db, 501, { ...here, heading: 270 }, load)).toContain('Pilot #11');
    expect(await liveLocationAlert(db, 501, { ...here, heading: 270 }, load)).toBeNull(); // already told
    expect(await liveLocationAlert(db, 502, { ...here, heading: 270 }, load)).toContain('Pilot #11'); // another driver
  });

  it('uses the previous position when the phone sends no heading', async () => {
    const load = async () => [ahead];
    const db = {} as Db;
    expect(await liveLocationAlert(db, 503, { lat: 40.82, lng: -96.40 }, load)).toBeNull(); // first point: no direction yet
    expect(await liveLocationAlert(db, 503, here, load)).toContain('Pilot #11');
  });

  it('remembers "already said" in Redis-less mode too', async () => {
    expect(await firstTime('t-once', 60)).toBe(true);
    expect(await firstTime('t-once', 60)).toBe(false);
  });
});

describe('14 · thresholds live in one config', () => {
  it('the route matching uses the configured corridor and nearby distances by default', () => {
    // Halfway between Lincoln and Kearney (that stretch runs east–west), moved south by `mi`.
    const p = { lat: (PATH[1].lat + PATH[2].lat) / 2, lng: (PATH[1].lng + PATH[2].lng) / 2 };
    const offBy = (mi: number) => ({ id: 1, lat: p.lat - mi / 69, lng: p.lng, retail: 4, discounted: 3.5 });
    const inside = stationsAlongRoute(PATH, [offBy(DRIVER_MAP.corridorMi - 0.2)]);
    expect(inside.onRoute).toHaveLength(1);
    const nearby = stationsAlongRoute(PATH, [offBy(DRIVER_MAP.corridorMi + 1)]);
    expect(nearby.onRoute).toHaveLength(0);
    expect(nearby.nearby).toHaveLength(1);
    expect(stationsAlongRoute(PATH, [offBy(DRIVER_MAP.nearbyMi + 2)]).nearby).toHaveLength(0);
  });
  it('has sane values', () => {
    expect(DRIVER_MAP.corridorMi).toBeLessThan(DRIVER_MAP.nearbyMi);
    expect(DRIVER_MAP.detour.candidates).toBeGreaterThan(0);
    expect(DRIVER_MAP.relocateBudgetS).toBeLessThan(60); // Vercel stops a request at 60 s
  });
});
