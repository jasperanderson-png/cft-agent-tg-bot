import { useEffect, useRef, useState } from 'react';
import type { TripDetail } from '../../../../../shared/types';
import { BRANDS, type DriverBrand } from '../../../../../shared/driver-route';
import { driversApi, type ApiError } from '../../lib/api';
import { useAdminSession } from '../../lib/session';
import { haptic, useBackButton } from '../../lib/telegram';
import { fmtDate, fmtDuration } from '../../components/ui';
import { createMap, drawRoute, fitPath, routeEnds, setRouteStations, type MlMap } from './map';
import { dist, money } from './pieces';
import './driver.css';

// One recorded trip on the map, for admins (/route?trip=<id>; opened from the Drivers screen). The
// planned route is dashed, the driven track solid orange, and the stretches with nothing recorded
// (the app closed, the phone asleep, no signal) are dotted red: shown as gaps, never filled in.
// It lives on /route because only that page may load the map (deploy/Caddyfile).

const GAP_MS = 90_000;
export const STATUS_TEXT: Record<TripDetail['status'], string> = {
  arrived: 'Arrived', ended: 'Ended by the driver', driving: 'Driving now', stale: 'Recording stopped (app closed)',
};

export function TripReplay({ id, onExit }: { id: string; onExit: () => void }) {
  const session = useAdminSession();
  const [trip, setTrip] = useState<TripDetail | null>(null);
  const [err, setErr] = useState('');
  const [sent, setSent] = useState<'' | 'sending' | 'sent' | 'failed'>('');
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  useBackButton(onExit);

  useEffect(() => {
    if (session.phase !== 'ready') return;
    driversApi.trip(id).then(setTrip, (e: ApiError) => setErr(e.message));
  }, [session.phase, id]);

  useEffect(() => {
    if (!trip || !mapEl.current) return;
    let dead = false;
    createMap(mapEl.current).then((m) => {
      if (dead) { m.remove(); return; }
      mapRef.current = m;
      const draw = () => {
        const planned = trip.plannedPath.map(([lng, lat]) => ({ lat, lng }));
        drawRoute(m, null, planned, []);
        // The driven track, split where nothing was recorded; the gaps drawn apart.
        const runs: [number, number][][] = [];
        const gaps: [number, number][][] = [];
        let run: [number, number][] = [];
        trip.track.forEach((p, i) => {
          const at: [number, number] = [p[2], p[1]];
          if (i && p[0] - trip.track[i - 1][0] > GAP_MS) {
            gaps.push([run[run.length - 1], at]);
            if (run.length > 1) runs.push(run);
            run = [];
          }
          run.push(at);
        });
        if (run.length > 1) runs.push(run);
        const line = (coordinates: [number, number][]) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates } });
        m.addSource('track', { type: 'geojson', data: { type: 'FeatureCollection', features: runs.map(line) } });
        m.addSource('gaps', { type: 'geojson', data: { type: 'FeatureCollection', features: gaps.map(line) } });
        m.addLayer({ id: 'gaps', type: 'line', source: 'gaps', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ff3b4e', 'line-width': 3, 'line-dasharray': [0.5, 2] } });
        m.addLayer({ id: 'track-casing', type: 'line', source: 'track', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#05080c', 'line-width': 9 } });
        m.addLayer({ id: 'track', type: 'line', source: 'track', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ff9f1a', 'line-width': 5 } });
        routeEnds(m).set(trip.from, trip.to);
        if (trip.stopAt && trip.stop) {
          const brand = (Object.keys(BRANDS) as DriverBrand[]).includes(trip.stop.brand as DriverBrand) ? trip.stop.brand! : 'p';
          setRouteStations(m, [{ id: 0, brand, lat: trip.stopAt.lat, lng: trip.stopAt.lng, price: trip.stop.price, sel: true, tag: true, near: false }]);
        }
        const all = [...planned, ...trip.track.map((p) => ({ lat: p[1], lng: p[2] }))];
        if (all.length > 1) fitPath(m, all, { top: 20, bottom: 300 });
      };
      if (m.getLayer('st-icon')) draw();
      else m.once('style.load', () => requestAnimationFrame(draw));
    }, () => setErr('The map could not load. Check the connection.'));
    return () => { dead = true; mapRef.current?.remove(); mapRef.current = null; };
  }, [trip]);

  const send = async () => {
    haptic.tap();
    setSent('sending');
    try {
      await driversApi.sendTrip(id);
      haptic.success();
      setSent('sent');
    } catch {
      setSent('failed');
    }
  };

  if (session.phase === 'checking') return <div className="center-msg">Loading…</div>;
  if (session.phase === 'denied') return <div className="center-msg">{session.message}</div>;
  if (err) return <div className="center-msg" style={{ flexDirection: 'column', gap: 12 }}><span>{err}</span><button type="button" className="d-cta" onClick={onExit}>Back</button></div>;
  if (!trip) return <div className="center-msg">Loading the trip…</div>;

  const took = (Date.parse(trip.endedAt ?? trip.lastPointAt ?? trip.startedAt) - Date.parse(trip.startedAt)) / 1000;
  return (
    <div className="dm">
      <div ref={mapEl} className="dm-map" />
      <section className="dm-sheet" aria-label="Trip">
        <div className="dm-swap">
          <div>
            <span className={'dm-eyebrow' + (trip.status === 'arrived' ? ' ok' : '')}>{STATUS_TEXT[trip.status].toUpperCase()}</span>
            <b className="dm-done-title">{trip.driverName ?? 'Driver'} · {fmtDate(trip.startedAt)}</b>
            <p className="dm-trip-lines">
              <span><i className="dot start" />{trip.fromLabel ?? 'Start'}</span>
              <span><i className="dot finish" />{trip.toLabel ?? 'Destination'}</span>
              {trip.stop && <span><i className="dot stop" />Fuel stop: {trip.stop.name}{trip.stop.price != null ? ` · ${money(trip.stop.price)}/gal` : ''} · {trip.stop.reachedAt ? `reached ${fmtDate(trip.stop.reachedAt).slice(11)}` : 'not reached'}</span>}
            </p>
          </div>
          <div className="dm-trip-figs">
            <span><b>{trip.plannedMi != null ? dist(trip.plannedMi) : '—'}</b>planned</span>
            <span><b>{dist(trip.drivenMi)}</b>recorded</span>
            <span><b>{fmtDuration(took)}</b>{trip.endedAt ? 'trip' : 'so far'}</span>
            <span><b>{trip.gaps.length}</b>gap{trip.gaps.length === 1 ? '' : 's'}</span>
          </div>
          <p className="dm-trip-legend"><i className="ln planned" />planned <i className="ln driven" />driven <i className="ln gap" />not recorded</p>
          <button type="button" className="dm-primary" disabled={sent === 'sending'} onClick={send}>
            {sent === 'sending' ? 'Sending…' : sent === 'sent' ? 'Sent to your chat ✓' : sent === 'failed' ? 'Not sent — try again' : 'Send the trip file (CSV) to my chat'}
          </button>
        </div>
      </section>
    </div>
  );
}
