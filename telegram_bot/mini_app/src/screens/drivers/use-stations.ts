import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DriverStations } from '../../../../../support/common/types';
import { driverApi, type ApiError } from '../../lib/api';
import { reportMapError } from '../../lib/report';
import { store, stored } from './pieces';

const STATIONS_KEY = 'cft.stations.v1';

/**
 * The CFT stations for the map. The list from the last visit shows at once (from the phone) and the
 * fresh one replaces it. Stations still without a map point are looked up in the background, then the
 * list is loaded again.
 */
export function useStations() {
  const cachedAtStart = useRef(stored<DriverStations | null>(STATIONS_KEY, null));
  const [data, setData] = useState<DriverStations | null>(cachedAtStart.current);
  const [loadErr, setLoadErr] = useState('');
  const fresh = useCallback((d: DriverStations) => { setData(d); store(STATIONS_KEY, d); }, []);
  const load = useCallback(() => {
    setLoadErr('');
    driverApi.stations().then(fresh, (e: ApiError) => { if (!cachedAtStart.current) setLoadErr(e.message); reportMapError(`stations: ${e.message}`); });
  }, [fresh]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!data?.pendingGeocode || data === cachedAtStart.current) return;
    let live = true;
    driverApi.locate().then((r) => { if (live && r.placed > 0) driverApi.stations().then(fresh, () => {}); }, () => {});
    return () => { live = false; };
  }, [data, fresh]);
  const byId = useMemo(() => new Map((data?.stations ?? []).map((s) => [s.id, s])), [data]);
  return { data, loadErr, load, byId };
}
