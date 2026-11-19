import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { DriverPlace, DriverStations } from '../../../../../support/common/types';
import type { LatLng } from '../../../../../support/common/driver-route';
import { US_STATES as STATE_NAMES } from '../../../../../support/common/states';
import { titleCase } from '../../../../../support/common/discounts';
import { driverApi } from '../../lib/api';
import type { Field } from './drive-shared';

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Suggestions for the From / To field being typed in: towns with CFT stations and states at once (from
 * the station list on the phone), then the place search joins in; answers are remembered for the session.
 */
export function usePlaceSearch(focus: 'from' | 'to' | null, from: Field, to: Field, data: DriverStations | null, myPosRef: MutableRefObject<LatLng | null>) {
  const [sugg, setSugg] = useState<DriverPlace[]>([]);
  const towns = useMemo(() => {
    const acc = new Map<string, { label: string; key: string; lat: number; lng: number; n: number }>();
    const add = (label: string, key: string, lat: number, lng: number) => {
      const a = acc.get(key);
      if (a) { a.lat += lat; a.lng += lng; a.n++; } else acc.set(key, { label, key, lat, lng, n: 1 });
    };
    for (const st of data?.stations ?? []) {
      if (st.lat == null || st.lng == null || !st.state) continue;
      if (st.city) add(`${titleCase(st.city)}, ${st.state}`, norm(`${st.city} ${st.state}`), st.lat, st.lng!);
      if (STATE_NAMES[st.state]) add(STATE_NAMES[st.state], norm(STATE_NAMES[st.state]), st.lat, st.lng!);
    }
    return [...acc.values()].map((t) => ({ label: t.label, key: t.key, lat: t.lat / t.n, lng: t.lng / t.n, n: t.n }));
  }, [data]);
  const placeCache = useRef(new Map<string, DriverPlace[]>());
  useEffect(() => {
    const f = focus === 'from' ? from : focus === 'to' ? to : null;
    const q = f?.text.trim() ?? '';
    if (!f || f.place || q.length < 2 || (data && !data.routing)) { setSugg([]); return; }
    const nq = norm(q);
    const local = towns.filter((t) => t.key.startsWith(nq) || t.key.includes(` ${nq}`)).sort((a, b) => b.n - a.n).slice(0, 4).map(({ label, lat, lng }) => ({ label, lat, lng }));
    const merge = (remote: DriverPlace[]) => {
      const seen = new Set<string>();
      return [...local, ...remote].filter((p) => { const k = norm(p.label); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
    };
    const cached = placeCache.current.get(nq);
    setSugg(merge(cached ?? []));
    if (cached || q.length < 3) return;
    let live = true;
    const t = setTimeout(() => driverApi.places(q, myPosRef.current).then((r) => {
      placeCache.current.set(nq, r.places);
      if (live) setSugg(merge(r.places));
    }, () => {}), 150);
    return () => { live = false; clearTimeout(t); };
  }, [focus, from, to, data?.routing, towns]); // eslint-disable-line react-hooks/exhaustive-deps
  return { sugg, setSugg };
}
