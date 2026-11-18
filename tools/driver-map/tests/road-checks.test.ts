// The route map's road checks: per-user request limits, how old a price is, the daily station
// location job, real detour time, the fuel range, live location alerts and the shared thresholds.
// No network and no database: outside services, Telegram and the database are faked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  afterDriving, applyDetours, bestChecked, bestStop, cumulativeMiles, detourAsks, milesBetween, nextDetourRound, priceAge, projectOnPath, rangeNow, rangeOf, reachable,
  simplifyPath, stationsAlongRoute, type LatLng, type Placed,
} from '../../../shared/driver-route.js';
import { DRIVER_MAP } from '../../../shared/driver-config.js';
import type { DriverStation } from '../../../shared/types.js';
import { env } from '../../../core/env.js';
import { firstTime, rateLimit, spendCapped } from '../../../core/kv.js';
import type { Db } from '../../../db_storage/db.js';
import { detourMinutes, matrixRequest, readAsks, readDetours } from '../detours.js';
import { activeTripPath, alertText, liveLocationAlert, nextStationAhead, nextStationOnRoute, travelHeading } from '../alerts.js';
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

describe('limits · requests are limited per Telegram user, with or without Redis', () => {
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

describe('prices · how old a price is', () => {
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

describe('stations · the daily station location job', () => {
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

describe('detours · real detour time for the cheapest corridor stations', () => {
  const placed = [placedAt(1, 30, 0.2, 3.9), placedAt(2, 60, 1.2, 3.1), placedAt(3, 90, 0.4, 3.4)];

  // What the server knows: where each station is (the Mini App sends only ids and route points).
  const WHERE = new Map([[1, { lat: 41, lng: -96 }], [2, { lat: 41.1, lng: -96.2 }], [3, { lat: 40.9, lng: -97 }]]);
  const withAt = (asks: ReturnType<typeof detourAsks>) => asks.map((a) => ({ ...a, at: WHERE.get(a.id)! }));

  it('asks about the cheapest few by id, with a route point before and after each (no station coordinates)', () => {
    const asks = detourAsks(PATH, placed, 2, 15);
    expect(asks.map((a) => a.id)).toEqual([2, 3]); // cheapest first, only 2
    expect(asks[0].before).not.toEqual(asks[0].after);
    expect(Object.keys(asks[0]).sort()).toEqual(['after', 'before', 'id']);
  });

  it('builds one truck matrix call and reads the extra minutes per station', () => {
    const asks = withAt(detourAsks(PATH, placed, 2, 15));
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

  it('calls OpenRouteService once with the stations where WE know they are, and gives no answer (not an error) when routes are off', async () => {
    const asks = detourAsks(PATH, placed, 1, 15);
    expect(await detourMinutes(asks, WHERE)).toEqual([{ id: 2, detourMin: null }]);
    process.env.ORS_API_KEY = 'ors-key';
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.openrouteservice.org/v2/matrix/driving-hgv');
      const body = JSON.parse(String(init!.body));
      expect(body.metrics).toEqual(['duration']);
      expect(body.locations[1]).toEqual([-96.2, 41.1]); // station 2 from our list
      return json({ durations: [[300, 1000], [0, 900]] });
    });
    expect(await detourMinutes(asks, WHERE, fetchStub as unknown as typeof fetch)).toEqual([{ id: 2, detourMin: 3.3 }]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('a station we do not know (or without a map point) is not measured, and alone costs no call', async () => {
    process.env.ORS_API_KEY = 'ors-key';
    const fetchStub = vi.fn();
    const asks = [{ id: 999, before: PATH[0], after: PATH[1] }];
    expect(await detourMinutes(asks, WHERE, fetchStub as unknown as typeof fetch)).toEqual([{ id: 999, detourMin: null }]);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('accepts only station ids and route points from the Mini App, a few at a time', () => {
    const ok = { id: 1, before: PATH[0], after: PATH[1] };
    expect(readAsks({ stops: [ok] })).toEqual([ok]);
    // Coordinates for the station itself are ignored: the server looks them up.
    expect(readAsks({ stops: [{ ...ok, at: { lat: 1, lng: 2 } }] })).toEqual([ok]);
    expect(() => readAsks({ stops: [] })).toThrow();
    expect(() => readAsks({ stops: [{ ...ok, before: { lat: 200, lng: 0 } }] })).toThrow();
    expect(() => readAsks({ stops: [{ id: 'x', before: PATH[0], after: PATH[1] }] })).toThrow();
    expect(() => readAsks({ stops: Array(DRIVER_MAP.detour.candidates + 1).fill(ok) })).toThrow(/At most/);
  });

  it('stops calling the matrix service at the daily cap (the map keeps the straight-line view)', async () => {
    process.env.ORS_API_KEY = 'ors-key';
    let calls = 0;
    const fetchStub = vi.fn(async () => { calls++; return json({ durations: [[300, 1000], [0, 900]] }); });
    const asks = detourAsks(PATH, placed, 1, 15);
    vi.useFakeTimers({ now: Date.parse('2031-01-01T10:00:00Z'), toFake: ['Date'] }); // a fresh day for the counter
    const results = [];
    for (let i = 0; i < DRIVER_MAP.detour.matrixPerDay + 3; i++) results.push((await detourMinutes(asks, WHERE, fetchStub as unknown as typeof fetch))[0].detourMin);
    expect(calls).toBe(DRIVER_MAP.detour.matrixPerDay);
    expect(results.slice(-3)).toEqual([null, null, null]);
    vi.setSystemTime(Date.parse('2031-01-02T10:00:00Z')); // next day: allowed again
    expect((await detourMinutes(asks, WHERE, fetchStub as unknown as typeof fetch))[0].detourMin).toBe(3.3);
  });

  it('counts the monthly budget too (and a refused call is not counted)', async () => {
    vi.useFakeTimers({ now: Date.parse('2031-03-01T10:00:00Z'), toFake: ['Date'] });
    for (let i = 0; i < 4; i++) await spendCapped('t-month', 1, { perDay: 100, perMonth: 4 });
    await expect(spendCapped('t-month', 1, { perDay: 100, perMonth: 4 })).rejects.toMatchObject({ status: 503, code: 'allowance' });
    vi.setSystemTime(Date.parse('2031-03-02T10:00:00Z')); // a new day, same month: still refused
    await expect(spendCapped('t-month', 1, { perDay: 100, perMonth: 4 })).rejects.toMatchObject({ code: 'allowance' });
    vi.setSystemTime(Date.parse('2031-04-01T10:00:00Z')); // a new month
    await expect(spendCapped('t-month', 1, { perDay: 100, perMonth: 4 })).resolves.toBeUndefined();
  });

  it('moves a station with a long detour off "on your route"; unmeasured ones stay', () => {
    const r = applyDetours({ onRoute: placed, nearby: [] }, new Map([[2, 14], [3, 2]]), 10);
    expect(r.onRoute.map((p) => p.item.id)).toEqual([1, 3]);
    expect(r.nearby.map((p) => p.item.id)).toEqual([2]);
    expect(applyDetours({ onRoute: placed, nearby: [] }, new Map())).toEqual({ onRoute: placed, nearby: [] });
  });
});

describe('range · miles until empty', () => {
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

describe('alerts · live location alerts', () => {
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

describe('config · thresholds live in one config', () => {
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
    expect(DRIVER_MAP.relocateBudgetS).toBeLessThan(60); // a request may take 60 s at most
  });
});

describe('detours · the recommended station is always one that was checked', () => {
  // Corridor stations by price: 5 → $3.00, 6 → $3.05, 1..4 → $3.20..$3.50, 7 → $3.60.
  const onRoute = [
    placedAt(1, 20, 0.3, 3.2), placedAt(2, 40, 0.3, 3.3), placedAt(3, 60, 0.3, 3.4), placedAt(4, 80, 0.3, 3.5),
    placedAt(5, 100, 0.3, 3.0), placedAt(6, 120, 0.3, 3.05), placedAt(7, 140, 0.3, 3.6),
  ];

  it('first round: the cheapest five', () => {
    expect(nextDetourRound(PATH, onRoute, new Map(), null, 5).map((a) => a.id)).toEqual([5, 6, 1, 2, 3]);
  });

  it('another round while the best pick is unchecked: the next cheapest unchecked ones', () => {
    // 5 and 6 turned out to need long detours and left the corridor (applyDetours); 1..3 are fine.
    const detours = new Map<number, number | null>([[5, 25], [6, 30], [1, 2], [2, 3], [3, 1]]);
    const left = applyDetours({ onRoute, nearby: [] }, detours, 10).onRoute;
    // Best is 1 ($3.20), checked: no more rounds needed.
    expect(nextDetourRound(PATH, left, detours, null, 5)).toEqual([]);
    expect(bestChecked(left, detours, null)!.item.id).toBe(1);

    // Same, but station 1 has no answer yet (not checked) and is the cheapest left: check it and the next.
    const partial = new Map<number, number | null>([[5, 25], [6, 30]]);
    const left2 = applyDetours({ onRoute, nearby: [] }, partial, 10).onRoute;
    expect(nextDetourRound(PATH, left2, partial, null, 2).map((a) => a.id)).toEqual([1, 2]);
  });

  it('never recommends an unchecked station once measurements exist', () => {
    // Only 3 was checked (fine); the cheaper 1, 2, 5 and 6 were never checked (e.g. the rounds ran out).
    expect(bestChecked(onRoute, new Map([[3, 2]]), null)!.item.id).toBe(3);
    // A "no road" answer does not count as checked-and-fine.
    expect(bestChecked(onRoute, new Map([[3, null], [4, 1]]), null)!.item.id).toBe(4);
    // No measurements at all (service off): the plain cheapest.
    expect(bestChecked(onRoute, new Map(), null)!.item.id).toBe(5);
  });

  it('with a fuel range: checks the reachable ones first and recommends a checked reachable one', () => {
    // Range 90 mi: only 1..4 (20–80 mi) are reachable; 5 and 6 are cheaper but too far.
    expect(nextDetourRound(PATH, onRoute, new Map(), 90, 2).map((a) => a.id)).toEqual([1, 2]);
    expect(bestChecked(onRoute, new Map([[1, 2], [2, 1]]), 90)!.item.id).toBe(1);
  });
});

describe('range · the fuel range counts down and is forgotten', () => {
  const t0 = Date.parse('2026-11-17T08:00:00Z');
  it('is forgotten 12 hours after it was typed', () => {
    const r = { mi: 450, setAt: t0 };
    expect(rangeNow(r, t0 + 11.9 * 3_600_000)).toEqual(r);
    expect(rangeNow(r, t0 + 12 * 3_600_000)).toBeNull();
    expect(rangeNow(null, t0)).toBeNull();
    expect(rangeNow({ mi: Number.NaN, setAt: t0 }, t0)).toBeNull();
  });
  it('subtracts the miles driven, never below zero, keeping when it was typed', () => {
    const r = { mi: 450, setAt: t0 };
    expect(afterDriving(r, 120.25)).toEqual({ mi: 329.8, setAt: t0 });
    expect(afterDriving(r, 600)).toEqual({ mi: 0, setAt: t0 });
    expect(afterDriving(r, -5)).toEqual(r);
  });
  it('with less range left, a station drops out of reach', () => {
    const p = placedAt(1, 200, 0.5);
    expect(reachable(p, 450)).toBe(true);
    expect(reachable(p, afterDriving({ mi: 450, setAt: t0 }, 300).mi)).toBe(false);
  });
});

describe('alerts · they follow the trip route when there is one', () => {
  const trip = PATH;
  /** The point `mi` miles into the trip route. */
  const pointOn = (mi: number): LatLng => {
    let left = mi;
    for (let i = 0; i < trip.length - 1; i++) {
      const seg = milesBetween(trip[i], trip[i + 1]);
      if (left <= seg) {
        const t = left / seg;
        return { lat: trip[i].lat + (trip[i + 1].lat - trip[i].lat) * t, lng: trip[i].lng + (trip[i + 1].lng - trip[i].lng) * t };
      }
      left -= seg;
    }
    return trip[trip.length - 1];
  };
  const here = pointOn(10); // 10 mi into the trip
  // On the route 30 mi ahead; on the route behind; 40 mi ahead but 8 mi off the route.
  const onAhead = station(21, pointOn(40).lat, pointOn(40).lng);
  const onBehind = station(22, pointOn(5).lat, pointOn(5).lng);
  const offRoute = station(23, pointOn(50).lat + 8 / 69, pointOn(50).lng);

  it('finds the next station along the route, ahead of the driver, and measures miles along it', () => {
    const r = nextStationOnRoute([onBehind, offRoute, onAhead], trip, here)!;
    expect(r.station.id).toBe(21);
    expect(r.mi).toBeGreaterThan(29);
    expect(r.mi).toBeLessThan(31);
    expect(nextStationOnRoute([onBehind, offRoute], trip, here)).toBeNull(); // on the route, nothing ahead on it
  });

  it('gives way to the cone when the driver is far off the trip route', () => {
    expect(nextStationOnRoute([onAhead], trip, { lat: here.lat + 10 / 69, lng: here.lng })).toBeUndefined();
    expect(nextStationOnRoute([onAhead], [], here)).toBeUndefined();
  });

  it('uses the trip route for a driver with a trip, the cone otherwise', async () => {
    const db = {} as Db;
    const load = async () => [onAhead, offRoute];
    // With a trip: the station on the route, "along your route", even with no heading at all.
    const withTrip = await liveLocationAlert(db, 601, here, load, async () => trip);
    expect(withTrip).toContain('Next CFT station on your route: Pilot #21');
    expect(withTrip).toContain('along your route');
    // No trip (agents, admins, drivers not navigating): the cone, heading west → the nearest ahead.
    const cone = await liveLocationAlert(db, 602, { ...here, heading: 270 }, load, async () => null);
    expect(cone).toContain('CFT station ahead: Pilot #21');
    expect(cone).not.toContain('along your route');
  });

  it('reads the active trip route from the database, and treats a trip quiet for 45 minutes as over', async () => {
    const queries: [string, unknown[]][] = [];
    const db = { query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push([sql, params]);
      return { rows: [{ planned_path: [[-95.93, 41.25], [-96.70, 40.81], ['bad'], [-99.08, 40.70]] }] };
    }) } as unknown as Db;
    expect(await activeTripPath(db, 7)).toEqual([{ lat: 41.25, lng: -95.93 }, { lat: 40.81, lng: -96.70 }, { lat: 40.70, lng: -99.08 }]);
    const [sql, params] = queries[0];
    expect(sql).toContain("status = 'driving'");
    expect(sql).toContain('coalesce(last_point_at, started_at) > now() - make_interval(mins => $2)');
    expect(params).toEqual([7, 45]);
    // No trip, or no trip tables yet: null (the cone is used).
    expect(await activeTripPath({ query: async () => ({ rows: [] }) } as unknown as Db, 7)).toBeNull();
    expect(await activeTripPath({ query: async () => { throw new Error('relation "driver_trips" does not exist'); } } as unknown as Db, 7)).toBeNull();
  });
});

describe('matching · the route line is simplified to find stations; miles come from the full line', () => {
  // A long, dense line: 2,001 points from Omaha to Kearney with tiny (~4 m) wiggles.
  const dense: LatLng[] = [];
  for (let i = 0; i <= 2000; i++) {
    const t = i / 2000;
    const [a, b, u] = t < 0.5 ? [PATH[0], PATH[1], t * 2] : [PATH[1], PATH[2], (t - 0.5) * 2];
    dense.push({ lat: a.lat + (b.lat - a.lat) * u + (i % 2 ? 0.00004 : 0), lng: a.lng + (b.lng - a.lng) * u });
  }

  it('keeps the ends and few points, and no original point is more than the tolerance away', () => {
    const s = simplifyPath(dense, 20);
    expect(s[0]).toEqual(dense[0]);
    expect(s.at(-1)).toEqual(dense.at(-1));
    expect(s.length).toBeLessThan(20);
    const tolMi = 20 / 1609.344;
    for (let i = 0; i < dense.length; i += 37) expect(projectOnPath(dense[i], s).offMi).toBeLessThanOrEqual(tolMi + 1e-9);
    expect(simplifyPath(dense.slice(0, 2), 20)).toHaveLength(2);
  });

  it('finds the same stations, with miles along the route measured on the full line', () => {
    const stations = [
      { id: 1, ...dense[700] },
      { id: 2, lat: dense[1500].lat + 1 / 69, lng: dense[1500].lng },
      { id: 3, lat: dense[1200].lat - 10 / 69, lng: dense[1200].lng },
    ].map((s) => ({ ...s, retail: 4, discounted: 3.5 }));
    const fast = stationsAlongRoute(dense, stations);
    const exact = stationsAlongRoute(dense, stations, { simplifyM: 0 });
    expect(fast.onRoute.map((p) => p.item.id)).toEqual([1, 2]);
    expect(fast.nearby.map((p) => p.item.id)).toEqual([3]);
    expect(fast.onRoute.map((p) => p.item.id)).toEqual(exact.onRoute.map((p) => p.item.id));
    const cum = cumulativeMiles(dense);
    for (const p of [...fast.onRoute, ...fast.nearby]) {
      expect(p.alongMi).toBeCloseTo(projectOnPath(p.item, dense, cum).alongMi, 6); // the full line, exactly
    }
  });
});
