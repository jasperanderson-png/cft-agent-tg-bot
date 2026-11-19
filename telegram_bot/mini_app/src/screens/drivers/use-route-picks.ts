import { useEffect, useMemo, useRef, useState } from 'react';
import type { DriverRoute, DriverStation, DriverStations } from '../../../../../support/common/types';
import {
  applyDetours, bestChecked, nextDetourRound, payPrice, rankStations, reachable, stationsAlongRoute, type DriverBrand, type Placed,
} from '../../../../../support/common/driver-route';
import { DRIVER_MAP } from '../../../../../support/common/driver-config';
import { driverApi } from '../../lib/api';
import type { Show } from './drive-shared';

// Thresholds: support/common/driver-config.ts. On a planned route the map shows the best few (cheapShown),
// by the driver's choice of brands and ranking.
const { corridorMi: CORRIDOR_MI, nearbyMi: NEARBY_MI, nearbyMax: NEARBY_MAX, cheapShown: BEST_SHOWN } = DRIVER_MAP;
const byPay = (a: Placed<DriverStation>, b: Placed<DriverStation>) => (payPrice(a.item) ?? 99) - (payPrice(b.item) ?? 99) || a.offMi - b.offMi;
const NO_DETOURS: ReadonlyMap<number, number | null> = new Map();

/**
 * The CFT stations along a planned route: on it and near it (`placed`, `pool`), their real detours
 * (`detours`), and the ones the card offers (`top`: the best three by the driver's choice, or all).
 */
export function useRoutePicks(base: DriverRoute | null, data: DriverStations | null, rangeMi: number | null, brandSel: DriverBrand[], rankBy: Show) {
  // First filter: straight-line distance from the route (the corridor).
  const straight = useMemo(() => {
    if (!base || !data) return { onRoute: [] as Placed<DriverStation>[], nearby: [] as Placed<DriverStation>[] };
    return stationsAlongRoute(base.path, data.stations, { corridorMi: CORRIDOR_MI, nearbyMi: NEARBY_MI });
  }, [base, data]);
  // Then the cheapest few get a real driving-time check: one across a divided highway or far from an
  // exit costs real minutes and is moved to "nearby" (tools/driver-map/detours.ts). While the best
  // pick is still unchecked, the next cheapest unchecked ones are checked too (up to
  // DRIVER_MAP.detour.extraRounds more rounds), so the station recommended has always been checked.
  // The measurements belong to one route: a new route starts from nothing.
  const [det, setDet] = useState<{ route: DriverRoute | null; map: Map<number, number | null> }>(() => ({ route: null, map: new Map() }));
  const detours = det.route === base ? det.map : NO_DETOURS;
  const detourRun = useRef({ route: null as DriverRoute | null, rounds: 0, busy: false });
  const placed = useMemo(() => {
    const r = applyDetours(straight, detours);
    return { onRoute: r.onRoute, nearby: r.nearby.slice().sort(byPay).slice(0, NEARBY_MAX) };
  }, [straight, detours]);
  useEffect(() => {
    if (!base) return;
    if (detourRun.current.route !== base) detourRun.current = { route: base, rounds: 0, busy: false };
    const run = detourRun.current;
    if (run.busy || run.rounds > DRIVER_MAP.detour.extraRounds) return;
    const asks = nextDetourRound(base.path, placed.onRoute, detours, rangeMi);
    if (!asks.length) return;
    run.busy = true;
    run.rounds++;
    const done = (got: Map<number, number | null>) => {
      if (detourRun.current !== run) return; // another route by now
      run.busy = false;
      setDet((d) => {
        const map = new Map(d.route === base ? d.map : undefined);
        for (const a of asks) map.set(a.id, got.get(a.id) ?? null);
        return { route: base, map };
      });
    };
    driverApi.detours(asks).then(
      (r) => done(new Map(r.detours.map((d) => [d.id, d.detourMin]))),
      () => { run.rounds = Infinity; done(new Map()); }, // the check failed: keep the straight-line view
    );
  }, [base, placed, detours, rangeMi]);
  // The cheapest checked station the truck can reach before empty (when the driver gave a range).
  const best = useMemo(() => bestChecked(placed.onRoute, detours, rangeMi), [placed, detours, rangeMi]);
  const pool = useMemo(() => [...placed.onRoute, ...placed.nearby], [placed]);
  // The best three by the driver's choice (brands, ranking); the card shows one of them (‹ 1/3 ›).
  // With a fuel range, stations beyond it drop out (unless none is in reach). Cheapest leads with
  // the checked pick, so the station shown first has had its real detour measured.
  const top = useMemo(() => {
    const ok = (p: Placed<DriverStation>) => payPrice(p.item) != null && (!brandSel.length || brandSel.includes(p.item.brand));
    const inReach = rangeMi == null ? pool : pool.filter((p) => reachable(p, rangeMi));
    const cands = (inReach.some(ok) ? inReach : pool).filter(ok);
    if (rankBy === 'all') return cands.slice().sort(byPay);
    const ranked = rankStations(cands, rankBy, [], BEST_SHOWN);
    if (rankBy === 'cheap' && best && ok(best) && cands.includes(best)) return [best, ...ranked.filter((p) => p !== best)].slice(0, BEST_SHOWN);
    return ranked;
  }, [pool, rankBy, brandSel, best, rangeMi]);
  return { placed, detours, pool, top };
}
