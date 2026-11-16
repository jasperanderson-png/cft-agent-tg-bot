import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DriverPlace, DriverRoute, DriverStation, DriverStations, TruckProfile } from '../../../../../shared/types';
import { BRANDS, cheapest, payPrice, STATE_NAMES, stationsAlongRoute, type LatLng, type Placed } from '../../../../../shared/driverRoute';
import { titleCase } from '../../../../../shared/discounts';
import { driverApi, type ApiError } from '../../lib/api';
import { reportMapError } from '../../lib/report';
import { haptic, useBackButton } from '../../lib/telegram';
import { ByState } from './ByState';
import {
  ALL_STATION_LAYERS, createMap, drawDriven, drawRoute, drawTurn, driverMarker, fitPath, ll, onStationTap, setRouteStations, setStations, showLayers, type MlMap,
} from './map';
import { drivenPath, locate, navOf, pointAt, speedLimitAt, stepsAt, unwrap, type Nav } from './nav';
import {
  CHECK, DEFAULT_TRUCK, EDIT, LAYERS, LOCATE, MUTE, NAV, PIN, PriceBox, SOUND, StationCard, Svg, Truck, TruckSheet, X,
  fullAddress, hm, money, placeOf, truckText, turnIcon,
} from './pieces';
import { hush, LEAD_INS, leadIn, prefetchVoice, sentence, speak, unlockVoice } from './voice';
import './driver.css';

// The drivers' route map (/route). A clear map with every CFT station; tap one, or type where you are
// going, for a truck route (TomTom with live traffic, else OpenRouteService) with the stations on it,
// the cheapest picked; then turn-by-turn navigation with street names, speed limits, the natural voice
// and re-routing. Built like the United Fuel app's map: the map fills the screen, cards appear only
// when there is something to show, and the driver arrow and camera move every frame outside React.
// Data: GET /api/driver/stations, POST /api/driver/route, GET /api/driver/places, GET /api/driver/voice.

type Mode = 'route' | 'states';
type Phase = 'go1' | 'stop' | 'go2' | 'done';
interface Trip { phase: Phase; stopId: number | null }
interface Field { text: string; place: DriverPlace | null }
interface Fix extends LatLng { heading: number | null; speed: number | null }

const CORRIDOR_MI = 1.5;
const NEARBY_MI = 20;
const NEARBY_MAX = 30;
const ARRIVE_MI = 0.12;
const OFF_ROUTE_MI = 0.12;
/** /route?simulate drives the route without moving (about three minutes for any trip). */
const SIMULATE = /simulate/.test(location.search + location.hash);
const inUS = (p: LatLng) => p.lat > 24 && p.lat < 50 && p.lng > -125.5 && p.lng < -66;
const dist = (mi: number) => (mi < 0.1 ? `${Math.max(50, Math.round((mi * 5280) / 50) * 50)} ft` : mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`);
const firstPart = (s: string) => s.split(',')[0].trim();
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const pct = (v: number, total?: number) => (total ? `${Math.max(0, Math.min(100, (v / total) * 100)).toFixed(1)}%` : '0%');

function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: not remembered */
  }
}

export function DriverMap({ onExit }: { onExit: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>('route');

  // ---- stations
  const [data, setData] = useState<DriverStations | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const load = useCallback(() => {
    setLoadErr('');
    driverApi.stations().then(setData, (e: ApiError) => { setLoadErr(e.message); reportMapError(`stations: ${e.message}`); });
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (!data?.pendingGeocode) return;
    const t = setTimeout(() => driverApi.stations().then(setData, () => {}), 40_000);
    return () => clearTimeout(t);
  }, [data]);
  const byId = useMemo(() => new Map((data?.stations ?? []).map((s) => [s.id, s])), [data]);

  // ---- refs the map callbacks read (they are set up once)
  const tripRef = useRef<Trip | null>(null);
  const baseRef = useRef<DriverRoute | null>(null);
  const following = useRef(true);
  const [followUi, setFollowUi] = useState(true);
  const [tapped, setTapped] = useState<number | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [detail, setDetail] = useState(false);
  /** A tap on a station: on a planned route it becomes the stop; otherwise its card opens. */
  const pickStation = useRef((id: number) => {
    if (tripRef.current) return;
    if (baseRef.current) { setSel(id); setDetail(true); return; }
    setTapped(id);
    setDetail(false);
  }).current;

  // ---- the map
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const puck = useRef<ReturnType<typeof driverMarker> | null>(null);
  const [ready, setReady] = useState(false);
  const [mapErr, setMapErr] = useState('');
  useEffect(() => {
    let dead = false;
    createMap(mapEl.current!).then((m) => {
      if (dead) { m.remove(); return; }
      mapRef.current = m;
      puck.current = driverMarker(m);
      m.on('load', () => setReady(true));
      m.on('dragstart', () => { following.current = false; setFollowUi(false); });
      // A pinch or wheel by the driver: their zoom wins until they recentre.
      m.on('zoomstart', (ev: { originalEvent?: Event }) => { if (ev.originalEvent) engine.current.autoZoom = false; });
      m.on('error', (e: { error?: Error }) => { if (!m.loaded()) { setMapErr('The map could not load. Check the connection.'); reportMapError(`map: ${e.error?.message ?? 'error'}`); } });
      onStationTap(m, (id) => { haptic.select(); pickStation(id); });
    }, (e: Error) => { setMapErr('The map could not load. Check the connection.'); reportMapError(`map style: ${e.message}`); });
    return () => { dead = true; mapRef.current?.remove(); mapRef.current = null; };
  }, [pickStation]);

  // ---- sizes of the top panel and the bottom card: map framing and the button column follow them
  const topRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement | null>(null);
  const sizes = useRef({ top: 150, bottom: 0, h: 800 });
  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const r = root.getBoundingClientRect();
    const top = topRef.current ? topRef.current.getBoundingClientRect().bottom - r.top : 0;
    const bottom = sheetRef.current ? r.bottom - sheetRef.current.getBoundingClientRect().top : 0;
    sizes.current = { top, bottom: Math.max(0, bottom), h: r.height };
    root.style.setProperty('--sheet-h', `${Math.max(0, bottom)}px`);
  }, []);
  const ro = useMemo(() => (typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure())), [measure]);
  const sheetCb = useCallback((el: HTMLElement | null) => {
    if (sheetRef.current && ro) ro.unobserve(sheetRef.current);
    sheetRef.current = el;
    if (el && ro) ro.observe(el);
    measure();
  }, [ro, measure]);
  useEffect(() => {
    if (!ro) return;
    if (rootRef.current) ro.observe(rootRef.current);
    if (topRef.current) ro.observe(topRef.current);
    return () => ro.disconnect();
  }, [ro]);

  // ---- where the driver is (the arrow moves straight from the GPS; React hears only big moves)
  const fix = useRef<Fix | null>(null);
  const [myPos, setMyPos] = useState<LatLng | null>(null);
  const [posErr, setPosErr] = useState('');
  useEffect(() => {
    if (!navigator.geolocation) { setPosErr('This device cannot share its location. Type where you start from.'); return; }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const f: Fix = { lat: p.coords.latitude, lng: p.coords.longitude, heading: p.coords.heading ?? null, speed: p.coords.speed ?? null };
        const prev = fix.current;
        fix.current = f;
        setPosErr('');
        if (!prev || Math.abs(prev.lat - f.lat) + Math.abs(prev.lng - f.lng) > 0.003) setMyPos({ lat: f.lat, lng: f.lng });
        if (!tripRef.current) puck.current?.set(f, f.speed != null && f.speed > 1 ? f.heading : null);
      },
      () => setPosErr('Location is off. Allow it, or type where you start from.'),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);
  useEffect(() => { if (ready && fix.current && !tripRef.current) puck.current?.set(fix.current, null); }, [ready]);

  // ---- the truck and the voice switch
  const [truck, setTruck] = useState<TruckProfile>(() => ({ ...DEFAULT_TRUCK, ...stored<Partial<TruckProfile>>('cft.truck', {}) }));
  const [truckOpen, setTruckOpen] = useState(false);
  const [muted, setMuted] = useState(() => stored('cft.voiceOff', false));
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const say = useCallback((parts: string[]) => { if (!mutedRef.current) void speak(parts); }, []);

  // ---- planning
  const [from, setFrom] = useState<Field>({ text: '', place: null });
  const [to, setTo] = useState<Field>({ text: '', place: null });
  const [focus, setFocus] = useState<'from' | 'to' | null>(null);
  const [sugg, setSugg] = useState<DriverPlace[]>([]);
  const [base, setBase] = useState<DriverRoute | null>(null);
  baseRef.current = base;
  const [via, setVia] = useState<DriverRoute | null>(null);
  const [routeErr, setRouteErr] = useState('');
  const [routing, setRouting] = useState(false);
  const planSeq = useRef(0);
  const target = useRef<number | null>(null);
  const myPosRef = useRef(myPos);
  myPosRef.current = myPos;

  // Suggestions: towns with CFT stations and states at once (from the station list on the phone),
  // then the place search joins in; answers are remembered for the session.
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
  }, [focus, from, to, data?.routing, towns]);

  const plan = useCallback((fromF: Field, toF: Field, tr: TruckProfile) => {
    const dest = toF.place ?? toF.text.trim();
    if (!dest) { setBase(null); setVia(null); setRouteErr(''); return; }
    const origin = fromF.place ?? (fromF.text.trim() || myPosRef.current);
    if (!origin) { setBase(null); setRouteErr(posErr || 'Finding your location… or type where you start from.'); return; }
    const seq = ++planSeq.current;
    setRouting(true);
    setRouteErr('');
    driverApi.route({ from: origin, to: dest, truck: tr }).then(
      (r) => { if (seq === planSeq.current) { setBase(r); setVia(null); setTapped(null); } },
      (e: ApiError) => { if (seq === planSeq.current) { setBase(null); setRouteErr(e.message); } },
    ).finally(() => { if (seq === planSeq.current) setRouting(false); });
  }, [posErr]);
  // The location arrived after a route from it was asked for.
  const hadPos = useRef(false);
  useEffect(() => {
    if (!myPos || hadPos.current) return;
    hadPos.current = true;
    if (!base && !routing && !from.text.trim() && to.text.trim()) plan(from, to, truck);
  }, [myPos]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickPlace = (which: 'from' | 'to', p: DriverPlace) => {
    haptic.select();
    const f = { text: p.label, place: p };
    setSugg([]);
    setFocus(null);
    (document.activeElement as HTMLElement | null)?.blur();
    if (which === 'from') { setFrom(f); plan(f, to, truck); } else { target.current = null; setTo(f); plan(from, f, truck); }
  };
  const routeTo = (s: DriverStation) => {
    const label = `${s.station}, ${placeOf(s)}`;
    const f: Field = s.lat != null ? { text: label, place: { label, lat: s.lat, lng: s.lng! } } : { text: fullAddress(s), place: null };
    target.current = s.id;
    setTo(f);
    setTapped(null);
    setMode('route');
    plan(from, f, truck);
  };
  const clearRoute = () => { planSeq.current++; setRouting(false); setTo({ text: '', place: null }); setBase(null); setVia(null); setRouteErr(''); target.current = null; };

  // ---- the stations along the route
  const placed = useMemo(() => {
    if (!base || !data) return { onRoute: [] as Placed<DriverStation>[], nearby: [] as Placed<DriverStation>[] };
    const r = stationsAlongRoute(base.path, data.stations, { corridorMi: CORRIDOR_MI, nearbyMi: NEARBY_MI });
    return { onRoute: r.onRoute, nearby: r.nearby.slice().sort((a, b) => (payPrice(a.item) ?? 99) - (payPrice(b.item) ?? 99)).slice(0, NEARBY_MAX) };
  }, [base, data]);
  const best = useMemo(() => cheapest(placed.onRoute), [placed]);
  const [nearbyOn, setNearbyOn] = useState(false);
  useEffect(() => {
    const t = target.current != null ? placed.onRoute.find((p) => p.item.id === target.current) : undefined;
    setSel(t?.item.id ?? best?.item.id ?? null);
  }, [best, placed]);
  const selPlaced = placed.onRoute.find((p) => p.item.id === sel) ?? placed.nearby.find((p) => p.item.id === sel) ?? null;
  const selOn = !!selPlaced && placed.onRoute.includes(selPlaced);
  useEffect(() => setDetail(false), [base]);
  // A station off the route changes the way: route through it.
  useEffect(() => {
    if (!base || !selPlaced || selOn) { setVia(null); return; }
    const s = selPlaced.item;
    let live = true;
    driverApi.route({ from: base.from, to: base.to, via: { lat: s.lat!, lng: s.lng! }, truck }).then((r) => live && setVia(r), () => live && setVia(null));
    return () => { live = false; };
  }, [base, selPlaced, selOn, truck]);
  const route = via ?? base;

  // ---- driving
  const [trip, setTrip] = useState<Trip | null>(null);
  tripRef.current = trip;
  const [nav, setNav] = useState<Nav | null>(null);
  const navId = useRef(0);
  const engine = useRef({ along: 0, shown: 0, heading: null as number | null, sim: 0, offCount: 0, lastReroute: 0, zoom: 15, autoZoom: true, toTurn: 99 });
  const [ui, setUi] = useState({ along: 0, off: 0 });
  const stopStation = trip?.stopId != null ? byId.get(trip.stopId) ?? null : null;
  const stopAlong = useMemo(() => (nav && stopStation?.lat != null ? locate(nav, { lat: stopStation.lat, lng: stopStation.lng! }, null).alongMi : null), [nav, stopStation]);

  // Every frame while driving: the arrow glides, the camera follows, the driven part greys out.
  useEffect(() => {
    if (!trip || !nav || !ready) return;
    const m = mapRef.current!;
    const e = engine.current;
    let raf = 0, last = performance.now(), lastUi = 0, lastDriven = 0;
    const simSpeed = Math.max(nav.route.totalMi / 180, (65 * 20) / 3600); // miles per second
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t = tripRef.current;
      const moving = !!t && (t.phase === 'go1' || t.phase === 'go2');
      let point: LatLng, off = 0;
      if (SIMULATE) {
        if (moving) e.sim = Math.min(nav.route.totalMi, e.sim + simSpeed * dt);
        e.along = e.sim;
        e.shown = e.sim;
        point = pointAt(nav, e.shown).point;
      } else {
        const f = fix.current;
        if (f) {
          const loc = locate(nav, f, e.along);
          e.along = loc.alongMi;
          off = loc.offMi;
        }
        // Glide towards the latest fix instead of jumping once a second.
        e.shown += (e.along - e.shown) * Math.min(1, dt * 4);
        point = off < 0.03 || !f ? pointAt(nav, e.shown).point : f;
      }
      const h = pointAt(nav, e.shown).heading;
      e.heading = e.heading == null ? h : e.heading + (unwrap(e.heading, h) - e.heading) * Math.min(1, dt * 5);
      puck.current?.set(point, e.heading);
      if (following.current && t?.phase !== 'done') {
        const { h: H, bottom } = sizes.current;
        // Wide on long stretches, close as a turn comes, changing gently.
        if (e.autoZoom) e.zoom += ((e.toTurn < 0.4 ? 16.5 : e.toTurn < 2 ? 15.2 : 13.8) - e.zoom) * Math.min(1, dt * 1.5);
        m.jumpTo({ center: ll(point), bearing: e.heading, pitch: 50, ...(e.autoZoom ? { zoom: e.zoom } : {}), padding: { top: Math.max(120, H * 0.42), bottom: bottom + 10, left: 0, right: 0 } });
      }
      if (now - lastDriven > 500) { lastDriven = now; drawDriven(m, drivenPath(nav, e.shown, point)); }
      if (now - lastUi > 250) { lastUi = now; setUi({ along: e.shown, off }); }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [trip?.phase, nav, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const along = ui.along;
  const steps = nav?.route.steps ?? [];
  const { cur, next, nextIdx } = stepsAt(steps, along);
  const toTurn = next ? Math.max(0, next.startMi - along) : 0;
  engine.current.toTurn = next ? toTurn : 99;
  const limit = nav ? speedLimitAt(nav, along) : null;
  const dest = firstPart((nav?.route ?? route)?.to.label || to.text || 'destination');

  // Arrivals.
  useEffect(() => {
    if (!trip || !nav) return;
    if (trip.phase === 'go1' && stopAlong != null && stopAlong - along < ARRIVE_MI && stopStation) {
      haptic.success();
      setTrip({ ...trip, phase: 'stop' });
      say([`You have arrived at ${stopStation.station}.`, `Your CFT price is ${money(payPrice(stopStation))} a gallon.`]);
    } else if (trip.phase === 'go2' && nav.route.totalMi - along < ARRIVE_MI) {
      haptic.success();
      setTrip({ ...trip, phase: 'done' });
      say([`You have arrived at ${dest}.`]);
    }
  }, [along]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Starts (or, after a reroute, continues) driving a route. */
  const startNav = (r: DriverRoute, fresh: boolean) => {
    const n = navOf(r);
    navId.current++;
    const e = engine.current;
    e.along = fix.current && !SIMULATE ? locate(n, fix.current, null).alongMi : 0;
    if (fresh) { e.sim = 0; e.shown = e.along; e.heading = null; e.zoom = 15; e.autoZoom = true; } else e.shown = e.along;
    setNav(n);
    prefetchVoice([...LEAD_INS, ...r.steps.map((s) => sentence(s.text)), 'Rerouting.']);
  };

  // Off the route for about two seconds: plan again from here (real GPS only).
  useEffect(() => {
    const e = engine.current;
    if (SIMULATE || !trip || !nav || !fix.current || (trip.phase !== 'go1' && trip.phase !== 'go2')) { e.offCount = 0; return; }
    e.offCount = ui.off > OFF_ROUTE_MI ? e.offCount + 1 : 0;
    if (e.offCount < 8 || Date.now() - e.lastReroute < 20_000) return;
    e.lastReroute = Date.now();
    e.offCount = 0;
    say(['Rerouting.']);
    const viaStop = trip.phase === 'go1' && stopStation?.lat != null ? { lat: stopStation.lat, lng: stopStation.lng! } : undefined;
    driverApi.route({ from: { lat: fix.current.lat, lng: fix.current.lng }, to: nav.route.to, via: viaStop, truck }).then((r) => startNav(r, false), () => {});
  }, [ui.off]); // eslint-disable-line react-hooks/exhaustive-deps

  // The voice: each turn at about a mile (long stretches), a quarter mile and at the turn.
  const said = useRef(new Set<string>());
  useEffect(() => {
    if (!trip || !nav || !next || (trip.phase !== 'go1' && trip.phase !== 'go2') || next.type === 10) return;
    const stretch = next.startMi - (cur?.startMi ?? 0);
    const stage = toTurn <= 0.05 ? 'now' : toTurn <= 0.3 ? 'near' : toTurn <= 1.05 && toTurn > 0.7 && stretch > 1.5 ? 'far' : null;
    if (!stage) return;
    const key = `${navId.current}:${nextIdx}:${stage}`;
    if (said.current.has(key)) return;
    said.current.add(key);
    if (stage === 'now') said.current.add(`${navId.current}:${nextIdx}:near`);
    say([leadIn(toTurn), sentence(next.text)]);
  }, [along]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the screen on while driving.
  useEffect(() => {
    if (!trip || trip.phase === 'done') return;
    let lock: { release?: () => Promise<void> } | null = null;
    (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release?: () => Promise<void> }> } }).wakeLock?.request('screen').then((l) => { lock = l; }, () => {});
    return () => { lock?.release?.().catch(() => {}); };
  }, [trip?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const startTrip = () => {
    if (!route) return;
    haptic.tap();
    unlockVoice();
    said.current.clear();
    following.current = true;
    setFollowUi(true);
    const stopId = sel != null && (selOn || via) ? sel : null;
    startNav(route, true);
    setTrip({ phase: stopId != null ? 'go1' : 'go2', stopId });
    const s = stopId != null ? byId.get(stopId) : null;
    say([s ? `Starting the route to ${s.station}.` : 'Starting the route.', sentence(route.steps[0]?.text ?? 'Start driving')]);
  };
  const endTrip = () => {
    const m = mapRef.current;
    setTrip(null);
    setNav(null);
    hush();
    if (!m) return;
    drawDriven(m, null);
    drawTurn(m, null);
    // Back to an overview of the area, where the stations show again.
    m.easeTo({ pitch: 0, bearing: 0, zoom: Math.min(m.getZoom(), 9), duration: 500 });
    if (fix.current) puck.current?.set(fix.current, null);
    else puck.current?.hide();
  };

  // ---- draw on the map
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !ready || !data) return;
    setStations(m, data.stations.map((s) => ({ id: s.id, brand: s.brand, lat: s.lat, lng: s.lng, price: payPrice(s) })));
  }, [ready, data]);
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !ready) return;
    showLayers(m, ALL_STATION_LAYERS, !base && !trip);
    const shown = trip ? nav?.route ?? null : route;
    drawRoute(m, shown?.path ?? null, !trip && via && base ? base.path : null, shown?.traffic ?? []);
  }, [ready, base, via, trip, nav, route]);
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !ready) return;
    const cheap = new Set(placed.onRoute.slice().sort((a, b) => (payPrice(a.item) ?? 99) - (payPrice(b.item) ?? 99)).slice(0, 5).map((p) => p.item.id));
    const list = trip
      ? [...placed.onRoute, ...placed.nearby].filter((p) => p.item.id === trip.stopId)
      : [...placed.onRoute, ...(nearbyOn ? placed.nearby : [])];
    setRouteStations(m, list.map((p) => ({
      id: p.item.id, brand: p.item.brand, lat: p.item.lat, lng: p.item.lng, price: payPrice(p.item),
      sel: p.item.id === (trip ? trip.stopId : sel), tag: !trip && cheap.has(p.item.id), near: !placed.onRoute.includes(p),
    })));
  }, [ready, placed, sel, nearbyOn, trip]);
  useEffect(() => {
    const m = mapRef.current;
    if (m && ready) drawTurn(m, trip && next && next.type !== 10 ? next.at : null);
  }, [ready, trip?.phase, nextIdx]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new route: framed between the search box and the card.
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !ready || !route || trip) return;
    const id = requestAnimationFrame(() => { measure(); fitPath(m, route.path, sizes.current); });
    return () => cancelAnimationFrame(id);
  }, [ready, route, trip, measure]);
  // Once: the stations around the driver (in the US) when nothing is planned.
  const centered = useRef(false);
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !ready || !myPos || base || centered.current || !inUS(myPos)) return;
    centered.current = true;
    m.easeTo({ center: ll(myPos), zoom: 8, duration: 700 });
  }, [ready, myPos, base]);
  // A tapped station comes into view above its card.
  useEffect(() => {
    const m = mapRef.current;
    const s = tapped != null ? byId.get(tapped) : null;
    if (!m || !s || s.lat == null) return;
    const id = requestAnimationFrame(() => { measure(); m.easeTo({ center: [s.lng!, s.lat!], zoom: Math.max(m.getZoom(), 10), padding: { top: sizes.current.top, bottom: sizes.current.bottom, left: 0, right: 0 }, duration: 400 }); });
    return () => cancelAnimationFrame(id);
  }, [tapped]); // eslint-disable-line react-hooks/exhaustive-deps

  const locateMe = () => {
    haptic.tap();
    const m = mapRef.current;
    if (trip) { following.current = true; engine.current.autoZoom = true; setFollowUi(true); return; }
    const p = fix.current;
    if (!m) return;
    if (!p) { setRouteErr(posErr || 'Finding your location…'); return; }
    m.easeTo({ center: ll(p), zoom: Math.max(m.getZoom(), 11), padding: { top: sizes.current.top, bottom: sizes.current.bottom, left: 0, right: 0 }, duration: 500 });
  };

  // ---- Telegram's back button (By state has its own)
  useBackButton(mode === 'states' ? null : () => {
    if (truckOpen) setTruckOpen(false);
    else if (trip) endTrip();
    else if (tapped != null) setTapped(null);
    else if (base) clearRoute();
    else onExit();
  });

  const extraMi = via && base ? Math.max(0, Math.round(via.totalMi - base.totalMi)) : null;
  const phase = trip?.phase;
  const avgMph = nav && nav.route.durationS ? nav.route.totalMi / (nav.route.durationS / 3600) : 55;
  const tappedStation = tapped != null ? byId.get(tapped) ?? null : null;
  const leftMi = nav ? Math.max(0, (phase === 'go1' && stopAlong != null ? stopAlong : nav.route.totalMi) - along) : 0;

  let banner: { big: string; text: string; sub: string; type: number | 'ok' } | null = null;
  if (trip && nav) {
    if ((phase === 'go1' || phase === 'go2') && next) {
      const arriving = next.type === 10;
      banner = { big: dist(toTurn), text: arriving ? `Arrive at ${phase === 'go1' && stopStation ? stopStation.station : dest}` : next.text, sub: cur?.street ? `on ${cur.street}` : '', type: arriving ? 'ok' : next.type };
    } else if (phase === 'go1' || phase === 'go2') banner = { big: dist(leftMi), text: `Continue to ${phase === 'go1' && stopStation ? stopStation.station : dest}`, sub: '', type: 6 };
    else if (phase === 'stop' && stopStation) banner = { big: "You've arrived", text: `${stopStation.station} · ${placeOf(stopStation)}`, sub: '', type: 'ok' };
    else banner = { big: dest, text: 'Trip complete', sub: '', type: 'ok' };
  }

  const field = (which: 'from' | 'to') => {
    const f = which === 'from' ? from : to;
    const set = which === 'from' ? setFrom : setTo;
    return (
      <div className={'dm-input' + (focus === which ? ' on' : '')}>
        {which === 'from' ? <span className="dm-trip-ico truck"><Truck size={14} /></span> : <span className="dm-trip-ico pin"><Svg d={PIN} size={18} /></span>}
        <input
          className={which === 'from' && !f.text ? 'me' : ''}
          aria-label={which === 'from' ? 'From' : 'To'}
          value={f.text}
          placeholder={which === 'from' ? 'My location' : 'Where are you going?'}
          enterKeyHint="go"
          autoComplete="off"
          disabled={!!data && !data.routing}
          onFocus={() => setFocus(which)}
          onBlur={() => setTimeout(() => setFocus((x) => (x === which ? null : x)), 150)}
          onChange={(e) => set({ text: e.target.value, place: null })}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            (e.target as HTMLInputElement).blur();
            if (sugg[0] && !f.place) pickPlace(which, sugg[0]);
            else plan(which === 'from' ? f : from, which === 'to' ? f : to, truck);
          }}
        />
        {f.text && (
          <button type="button" className="dm-x" aria-label={which === 'from' ? 'Back to my location' : 'Clear destination'}
            onClick={() => { if (which === 'from') { const nf = { text: '', place: null }; setFrom(nf); plan(nf, to, truck); } else clearRoute(); }}>
            <Svg d={X} size={15} />
          </button>
        )}
      </div>
    );
  };

  const showSheet = mode === 'route' && !!(trip || base || tappedStation || routing || (routeErr && to.text.trim()));

  return (
    <div className="dm" ref={rootRef}>
      <div ref={mapEl} className="dm-map" />
      {mapErr && <div className="dm-map-msg">{mapErr}</div>}
      {loadErr && (
        <div className="dm-error" role="alert">
          <b>The stations could not load</b>
          <span>{loadErr}</span>
          <button type="button" className="d-cta" onClick={load}>Try again</button>
        </div>
      )}

      {mode === 'route' && (
        <div className="dm-top" ref={topRef}>
          {banner ? (
            <div className={'dm-banner' + (banner.type === 'ok' ? ' ok' : '')} role="status">
              <span className="dm-banner-ico">{banner.type === 'ok' ? <Svg d={CHECK} size={26} w={2.8} /> : <Svg d={turnIcon(banner.type)} size={28} w={2.6} />}</span>
              <span className="dm-banner-text"><b>{banner.big}</b><span className="t">{banner.text}</span>{banner.sub && <span className="dm-banner-sub">{banner.sub}</span>}</span>
              {limit != null && (phase === 'go1' || phase === 'go2') && <span className="dm-limit" aria-label={`Speed limit ${limit} mph`}><small>LIMIT</small>{limit}</span>}
            </div>
          ) : (
            <>
              <div className="dm-tabs" role="tablist" aria-label="Find fuel">
                <button type="button" className="dm-tab" role="tab" aria-selected>My route</button>
                <button type="button" className="dm-tab" role="tab" aria-selected={false} onClick={() => { haptic.select(); setMode('states'); }}>By state</button>
              </div>
              <div className="dm-trip">
                {field('from')}
                {field('to')}
                {focus && sugg.length > 0 ? (
                  <ul className="dm-sugg" role="listbox" aria-label="Places">
                    {sugg.map((p) => (
                      <li key={`${p.lat},${p.lng},${p.label}`}>
                        <button type="button" role="option" aria-selected={false} onPointerDown={(e) => e.preventDefault()} onClick={() => pickPlace(focus, p)}>
                          <Svg d={PIN} size={16} color="#a0dcff" /><span>{p.label}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <button type="button" className="dm-truckrow" onClick={() => { haptic.tap(); setTruckOpen(true); }} aria-label={`Truck: ${truckText(truck)}. Change`}>
                    <Truck size={13} /><span>{truckText(truck)}</span><Svg d={EDIT} size={13} />
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {mode === 'route' && (
        <div className="dm-fabs">
          {trip && (
            <button type="button" className="dm-fab" aria-label={muted ? 'Turn the voice on' : 'Turn the voice off'} aria-pressed={!muted}
              onClick={() => { const v = !muted; setMuted(v); store('cft.voiceOff', v); if (v) hush(); else { unlockVoice(); say(['Voice on.']); } }}>
              <Svg d={muted ? MUTE : SOUND} size={20} />
            </button>
          )}
          {!trip && base && placed.nearby.length > 0 && (
            <button type="button" className="dm-fab" aria-pressed={nearbyOn} aria-label={nearbyOn ? 'Hide stations near the route' : 'Show stations near the route'} onClick={() => { haptic.tap(); setNearbyOn((v) => !v); }}>
              <Svg d={LAYERS} size={20} />
            </button>
          )}
          {(!trip || !followUi) && (
            <button type="button" className="dm-fab" aria-label={trip ? 'Follow the truck again' : 'Show my location'} onClick={locateMe}>
              <Svg d={trip ? NAV : LOCATE} size={20} />
            </button>
          )}
        </div>
      )}

      {showSheet && (
        <section className="dm-sheet" ref={sheetCb} aria-live="polite">
          {!trip && !base && tappedStation && (
            <>
              <button type="button" className="dm-close" aria-label="Close" onClick={() => setTapped(null)}><Svg d={X} size={16} /></button>
              <StationCard s={tappedStation} badge={BRANDS[tappedStation.brand].label.toUpperCase()} near={false} detail={detail} onToggle={() => setDetail((v) => !v)}
                primary={data?.routing ? 'Route here' : 'Routes are not on yet'} onPrimary={() => { if (data?.routing) routeTo(tappedStation); }} />
            </>
          )}
          {!trip && !base && !tappedStation && <p className="dm-note">{routing ? 'Finding a truck route…' : routeErr}</p>}
          {!trip && base && route && (
            <>
              <div className="dm-summary">
                <b>{hm(route.durationS)}</b>
                <span>{Math.round(route.totalMi).toLocaleString('en-US')} mi{route.delayMin ? ` · ${route.delayMin} min traffic` : ''}{route.source === 'tomtom' ? ' · live traffic' : ''}</span>
                {routing && <span className="dm-spin" aria-label="Updating" />}
              </div>
              {selPlaced ? (
                <StationCard
                  s={selPlaced.item}
                  badge={selPlaced === best ? 'CHEAPEST ON YOUR ROUTE' : selOn ? `ON YOUR ROUTE · ${Math.round(selPlaced.alongMi)} MI` : extraMi != null ? `NEW ROUTE · +≈ ${extraMi} MI` : 'NEAR YOUR ROUTE'}
                  near={!selOn} detail={detail} onToggle={() => setDetail((v) => !v)}
                  primary={selOn || via ? 'Navigate' : 'Finding the way…'} onPrimary={() => { if (selOn || via) startTrip(); }}
                />
              ) : (
                <>
                  <p className="dm-note">No CFT stations along this route.</p>
                  <button type="button" className="dm-primary" onClick={startTrip}><Svg d={NAV} size={20} />Navigate</button>
                </>
              )}
            </>
          )}

          {trip && (phase === 'go1' || phase === 'go2') && nav && (
            <div className="dm-swap">
              <div className="dm-tripline">
                {phase === 'go1' && stopStation
                  ? <span className="dm-tile" style={{ background: BRANDS[stopStation.brand].color }}>{BRANDS[stopStation.brand].letter}</span>
                  : <span className="dm-tile" style={{ background: '#7fe0a4' }}><Svg d={CHECK} size={22} w={2.6} /></span>}
                <span className="dm-tripline-text">
                  <span className="dm-eyebrow">{phase === 'go1' ? 'NEXT FUEL STOP' : 'DESTINATION'}</span>
                  <b>{phase === 'go1' && stopStation ? stopStation.station : dest}</b>
                  <span>{dist(leftMi)} · {hm((leftMi / avgMph) * 3600)}</span>
                </span>
                {phase === 'go1' && stopStation && <span className="dm-tripline-price"><b>{money(payPrice(stopStation))}</b><small>/gal</small></span>}
              </div>
              <div className="dm-prog" aria-hidden="true">
                <i className="pg-track" />
                <i className="pg-fill" style={{ width: pct(along, nav.route.totalMi) }} />
                {stopAlong != null && stopStation && <span className="pg-stop" style={{ left: pct(stopAlong, nav.route.totalMi), background: BRANDS[stopStation.brand].color }}>{BRANDS[stopStation.brand].letter}</span>}
                <span className="pg-me" style={{ left: pct(along, nav.route.totalMi) }}><Truck size={12} /></span>
                <span className="pg-end" />
              </div>
              <div className="dm-tripfoot">
                <span>{hm(((nav.route.totalMi - along) / avgMph) * 3600)} to {dest}</span>
                <button type="button" className="dm-soft dm-danger" onClick={endTrip}>End</button>
              </div>
            </div>
          )}
          {trip && phase === 'stop' && stopStation && (
            <div className="dm-swap">
              <div className="dm-tripline">
                <span className="dm-tile" style={{ background: BRANDS[stopStation.brand].color }}>{BRANDS[stopStation.brand].letter}</span>
                <span className="dm-tripline-text"><span className="dm-eyebrow ok">YOU'VE ARRIVED</span><b>{stopStation.station}</b><span>{fullAddress(stopStation)}</span></span>
              </div>
              <PriceBox s={stopStation} />
              <div className="dm-row-btns">
                <button type="button" className="dm-primary" onClick={() => { said.current.clear(); setTrip({ ...trip, phase: 'go2' }); say([`Continuing to ${dest}.`]); }}><Svg d={NAV} size={18} />Continue to {dest}</button>
                <button type="button" className="dm-soft dm-danger" onClick={endTrip}>End</button>
              </div>
            </div>
          )}
          {trip && phase === 'done' && nav && (
            <div className="dm-swap">
              <div><span className="dm-eyebrow ok">TRIP COMPLETE</span><b className="dm-done-title">You've arrived in {dest}</b></div>
              <button type="button" className="dm-primary" onClick={() => { endTrip(); clearRoute(); }}>Plan a new trip</button>
            </div>
          )}
        </section>
      )}

      {truckOpen && <TruckSheet truck={truck} onClose={() => setTruckOpen(false)} onSave={(t) => { setTruck(t); store('cft.truck', t); setTruckOpen(false); haptic.success(); if (base) plan(from, to, t); }} />}

      {mode === 'states' && (
        <ByState stations={data?.stations ?? null} fetchedAt={data?.fetchedAt ?? null} routing={!!data?.routing} onRouteTo={routeTo} onMyRoute={() => setMode('route')} />
      )}
    </div>
  );
}
