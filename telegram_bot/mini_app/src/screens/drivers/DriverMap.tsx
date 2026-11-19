import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DriverPlace, DriverRoute, DriverStation, TruckProfile } from '../../../../../support/common/types';
import { afterDriving, BRAND_ORDER, BRANDS, milesBetween, payPrice, rangeNow, reachable, type DriverBrand, type FuelRange, type LatLng, type Placed } from '../../../../../support/common/driver-route';
import { DRIVER_MAP } from '../../../../../support/common/driver-config';
import { driverApi, type ApiError } from '../../lib/api';
import { reportMapError } from '../../lib/report';
import { haptic, openTelegramLocationSettings, telegramLocationRefused, useBackButton } from '../../lib/telegram';
import { ByState } from './ByState';
import {
  ALL_STATION_LAYERS, createMap, drawDriven, drawRoute, drawTurn, driverMarker, filterStations, fitPath, fitPoints, ll, onStationTap, revealRoute, routeEnds, setRouteStations, setStations,
  showLayers, type MlMap,
} from './map';
import { drivenPath, locate, navOf, pointAt, speedLimitAt, stepsAt, unwrap, type Nav } from './nav';
import { DEFAULT_TRUCK, LOCATE, MUTE, NAV, SOUND, StationCard, Svg, TruckSheet, X, dist, firstPart, fullAddress, money, placeOf, store, stored } from './pieces';
import { hush, LEAD_INS, leadIn, packForSteps, packTurn, prefetchPack, prefetchVoice, sentence, speak, unlockVoice, voiceKind } from './voice';
import { startRecording, type TripRecorder } from './trip-recorder';
import { SHOWS, type Field, type Fix, type Mode, type Note, type Show, type Trip } from './drive-shared';
import { useStations } from './use-stations';
import { usePanelSizes } from './use-panel-sizes';
import { useLocation } from './use-location';
import { usePlaceSearch } from './use-place-search';
import { useRoutePicks } from './use-route-picks';
import { TopPanel, type Banner } from './TopPanel';
import { RouteCard } from './RouteCard';
import { BuildingCard, DoneCard, DrivingCard, StopCard, TripNotice } from './TripCards';
import './driver.css';

// The drivers' route map (/route). A clear map with every CFT station; tap one, or type where you are
// going, for a truck route (TomTom with live traffic, else OpenRouteService) with the stations on it,
// the cheapest picked; then turn-by-turn navigation with street names, speed limits, the natural voice
// and re-routing. The map fills the screen, cards appear only when there is something to show, and the
// driver arrow and camera move every frame outside React.
// Data: GET /api/driver/stations, POST /api/driver/route, GET /api/driver/places, GET /api/driver/voice.
//
// This file holds the map, the driving (camera, arrivals, re-routing, the voice) and the trip record,
// and ties the parts together. The parts beside it:
//   use-stations.ts      the station list          use-location.ts    where the driver is (GPS)
//   use-place-search.ts  From / To suggestions     use-route-picks.ts the stations along a route
//   use-panel-sizes.ts   the panels' heights       drive-shared.ts    shared types
//   TopPanel.tsx         turn banner, trip fields  RouteCard.tsx      the planned route's card
//   TripCards.tsx        building, notice, driving, arrived, trip complete

const wide = () => window.matchMedia('(min-width: 900px)').matches;
const ARRIVE_MI = 0.12;
const OFF_ROUTE_MI = 0.12;
/** /route?simulate drives the route without moving (about three minutes for any trip). */
const SIMULATE = /simulate/.test(location.search + location.hash);
const inUS = (p: LatLng) => p.lat > 24 && p.lat < 50 && p.lng > -125.5 && p.lng < -66;
const RANGE_KEY = 'cft.range.v2';

export function DriverMap({ onExit }: { onExit: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>('route');
  // The driver's station choice on a route, remembered on the phone: brands (none = all) and ranking.
  const [brandSel, setBrandSel] = useState<DriverBrand[]>(() => stored<DriverBrand[]>('cft.brands', []).filter((b) => b in BRANDS));
  const [rankBy, setRankBy] = useState<Show>(() => { const r = stored<Show>('cft.rankBy', 'rec'); return SHOWS.includes(r) ? r : 'rec'; });
  const [rank, setRank] = useState(0);
  const bestRef = useRef<Placed<DriverStation>[]>([]);
  const [statesOpen, setStatesOpen] = useState<number | null>(null);

  // ---- stations
  const { data, loadErr, load, byId } = useStations();

  // ---- refs the map callbacks read (they are set up once)
  const tripRef = useRef<Trip | null>(null);
  /** Trip history (drivers only): the recorder of the trip being driven. */
  const rec = useRef<TripRecorder | null>(null);
  const baseRef = useRef<DriverRoute | null>(null);
  const following = useRef(true);
  const [followUi, setFollowUi] = useState(true);
  const [tapped, setTapped] = useState<number | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [detail, setDetail] = useState(false);
  /** A tap on a station: on a planned route it becomes the stop; otherwise its card opens. */
  const modeRef = useRef<Mode>('route');
  const [mapTap, setMapTap] = useState<{ id: number; n: number } | null>(null);
  const pickStation = useRef((id: number) => {
    if (modeRef.current === 'states') { setMapTap((t) => ({ id, n: (t?.n ?? 0) + 1 })); return; }
    if (tripRef.current) return;
    if (baseRef.current) {
      // The tapped station stays the stop (a late detour answer must not take it away); one of the
      // best three also moves the ‹ 1/3 › pager to it.
      const i = bestRef.current.findIndex((p) => p.item.id === id);
      if (i >= 0) setRank(i);
      target.current = id;
      setSel(id);
      setDetail(true);
      return;
    }
    setTapped(id);
    setDetail(false);
  }).current;

  // ---- the map
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const puck = useRef<ReturnType<typeof driverMarker> | null>(null);
  const ends = useRef<ReturnType<typeof routeEnds> | null>(null);
  const [ready, setReady] = useState(false);
  const [mapErr, setMapErr] = useState('');
  useEffect(() => {
    let dead = false;
    createMap(mapEl.current!).then((m) => {
      if (dead) { m.remove(); return; }
      mapRef.current = m;
      puck.current = driverMarker(m);
      ends.current = routeEnds(m);
      if (m.getLayer('st-icon')) setReady(true);
      else m.once('style.load', () => setReady(true));
      m.on('dragstart', () => { following.current = false; setFollowUi(false); });
      // The driver moves the map: the panels step aside, and come back when the map stops.
      let idle = 0;
      m.on('movestart', (ev: { originalEvent?: Event }) => {
        if (!ev.originalEvent || (document.activeElement as HTMLElement | null)?.tagName === 'INPUT') return;
        clearTimeout(idle);
        rootRef.current?.classList.add('dm-moving');
        setEditing(false);
      });
      m.on('moveend', () => { clearTimeout(idle); idle = window.setTimeout(() => rootRef.current?.classList.remove('dm-moving'), 450); });
      // A pinch or wheel by the driver: their zoom wins until they recentre.
      m.on('zoomstart', (ev: { originalEvent?: Event }) => { if (ev.originalEvent) engine.current.autoZoom = false; });
      m.on('error', (e: { error?: Error }) => { if (!m.loaded()) { setMapErr('The map could not load. Check the connection.'); reportMapError(`map: ${e.error?.message ?? 'error'}`); } });
      onStationTap(m, (id) => { haptic.select(); pickStation(id); });
    }, (e: Error) => { setMapErr('The map could not load. Check the connection.'); reportMapError(`map style: ${e.message}`); });
    return () => { dead = true; mapRef.current?.remove(); mapRef.current = null; };
  }, [pickStation]);

  // ---- sizes of the top panel and the bottom card: map framing and the button column follow them
  const { topRef, sizes, measure, sheetCb } = usePanelSizes(rootRef);

  // ---- where the driver is (the arrow moves straight from the GPS; React hears only big moves)
  /** Miles driven while navigating, counted down from the fuel range (set further below). */
  const onDriven = useRef<(mi: number) => void>(() => {});
  const onFix = useRef<(f: Fix, prev: Fix | null) => void>(() => {});
  const { fix, myPos, myAcc, posErr, locateNow } = useLocation(onFix);
  onFix.current = (f, prev) => {
    if (!tripRef.current) puck.current?.set(f, f.speed != null && f.speed > 1 ? f.heading : null);
    else {
      rec.current?.point(f);
      if (prev) onDriven.current(milesBetween(prev, f));
    }
  };
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const noteTimer = useRef(0);
  const flash = useCallback((text: string, action?: Note['action'], ms = 3200) => {
    setNote({ text, action });
    clearTimeout(noteTimer.current);
    if (ms) noteTimer.current = window.setTimeout(() => setNote(null), ms);
  }, []);
  /** No location: says why, with a button to Telegram's settings when Telegram was refused access. */
  const noLocation = useCallback(() => {
    if (telegramLocationRefused()) flash('Location is off for this app.', { label: 'Turn on', run: openTelegramLocationSettings }, 8000);
    else flash('Could not find your location. Turn on location for Telegram in the phone settings, or type a place.', undefined, 6000);
  }, [flash]);
  useEffect(() => { if (ready && fix.current && !tripRef.current) puck.current?.set(fix.current, null); }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the truck and the voice switch
  const [truck, setTruck] = useState<TruckProfile>(() => ({ ...DEFAULT_TRUCK, ...stored<Partial<TruckProfile>>('cft.truck', {}) }));
  const [truckOpen, setTruckOpen] = useState(false);
  /** Miles until empty (optional): the pick prefers stations the truck can reach. */
  // It counts down with the miles driven while navigating, and is forgotten after
  // DRIVER_MAP.range.forgetHours and when a trip ends or is cancelled.
  const [range, setRange] = useState<FuelRange | null>(() => rangeNow(stored<FuelRange | null>(RANGE_KEY, null)));
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const saveRange = useCallback((r: FuelRange | null) => { setRange(r); store(RANGE_KEY, r); }, []);
  const rangeMi = rangeNow(range)?.mi ?? null;
  const drivenAcc = useRef(0);
  onDriven.current = (mi: number) => {
    if (!(mi > 0) || mi > DRIVER_MAP.range.maxJumpMi) return; // a GPS jump is not driving
    const r = rangeNow(rangeRef.current);
    if (!r) return;
    drivenAcc.current += mi;
    if (drivenAcc.current < 0.5) return; // saved every half mile, not on every fix
    saveRange(afterDriving(r, drivenAcc.current));
    drivenAcc.current = 0;
  };
  const [muted, setMuted] = useState(() => stored('cft.voiceOff', false));
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  /** Speaks `parts`; `pack` is the same message from the built-in voice pack (phones with no voice). */
  const say = useCallback((parts: string[], pack: string[] = []) => { if (!mutedRef.current) void speak(parts, pack); }, []);

  // ---- planning
  const [from, setFrom] = useState<Field>({ text: '', place: null });
  const [to, setTo] = useState<Field>({ text: '', place: null });
  const [focus, setFocus] = useState<'from' | 'to' | null>(null);
  const [base, setBase] = useState<DriverRoute | null>(null);
  baseRef.current = base;
  const [via, setVia] = useState<DriverRoute | null>(null);
  const [routeErr, setRouteErr] = useState('');
  const [routing, setRouting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [buildStep, setBuildStep] = useState(0);
  const planSeq = useRef(0);
  const target = useRef<number | null>(null);
  const myPosRef = useRef(myPos);
  myPosRef.current = myPos;

  const { sugg, setSugg } = usePlaceSearch(focus, from, to, data, myPosRef);

  const plan = useCallback((fromF: Field, toF: Field, tr: TruckProfile) => {
    const dest = toF.place ?? toF.text.trim();
    if (!dest) { setBase(null); setVia(null); setRouteErr(''); return; }
    const here = fix.current ? { lat: fix.current.lat, lng: fix.current.lng } : myPosRef.current;
    const origin = fromF.place ?? (fromF.text.trim() || here);
    if (!origin) { setBase(null); setRouteErr(posErr || 'Finding your location… or type where you start from.'); return; }
    const seq = ++planSeq.current;
    setRouting(true);
    setRouteErr('');
    // While the route is built, the camera already shows both ends.
    const m = mapRef.current;
    if (m && typeof origin === 'object' && typeof dest === 'object') fitPath(m, [origin, dest], { top: sizes.current.top, bottom: 260 });
    driverApi.route({ from: origin, to: dest, truck: tr }).then(
      (r) => { if (seq === planSeq.current) { setBase(r); setVia(null); setTapped(null); } },
      (e: ApiError) => { if (seq === planSeq.current) { setBase(null); setRouteErr(e.message); } },
    ).finally(() => { if (seq === planSeq.current) setRouting(false); });
  }, [posErr]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const cancelPlan = () => { haptic.tap(); planSeq.current++; setRouting(false); };
  /** From: back to the driver's own location, freshly and precisely located. */
  const toMyLocation = async () => {
    haptic.tap();
    setSugg([]);
    setFocus(null);
    (document.activeElement as HTMLElement | null)?.blur();
    const nf = { text: '', place: null };
    setFrom(nf);
    setLocating(true);
    flash('Finding your location…', undefined, 0);
    const f = await locateNow();
    setLocating(false);
    if (!f) { noLocation(); return; }
    flash(f.accuracy != null ? `You are here (within ${dist(f.accuracy / 1609.34)})` : 'You are here');
    if (to.text.trim()) plan(nf, to, truck);
  };
  // The route-building screen: its steps tick on while the route is worked out.
  useEffect(() => {
    if (!routing) return;
    setBuildStep(0);
    const a = setTimeout(() => setBuildStep(1), 900), b = setTimeout(() => setBuildStep(2), 2200);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [routing]);
  useEffect(() => setEditing(false), [base]);

  // ---- the stations along the route, and the one picked as the stop
  const { placed, detours, pool, top } = useRoutePicks(base, data, rangeMi, brandSel, rankBy);
  bestRef.current = top;
  useEffect(() => setRank(0), [top]);
  useEffect(() => {
    // A tapped station or "Route here": it stays the stop until the driver picks another.
    const t = target.current != null ? pool.find((p) => p.item.id === target.current) : undefined;
    setSel(t?.item.id ?? top[Math.min(rank, top.length - 1)]?.item.id ?? null);
  }, [top, rank, pool]);
  const selPlaced = pool.find((p) => p.item.id === sel) ?? null;
  const selRank = selPlaced ? top.indexOf(selPlaced) : -1;
  /** Next / previous of the best three; the map follows. */
  const page = (step: number) => {
    if (top.length < 2) return;
    haptic.select();
    target.current = null;
    setDetail(false);
    const i = ((selRank < 0 ? 0 : selRank + step) + top.length) % top.length;
    setRank(i);
    const s = top[i].item;
    const m = mapRef.current;
    if (m && s.lat != null) m.easeTo({ center: [s.lng!, s.lat!], zoom: Math.min(Math.max(m.getZoom(), 7), 10), padding: { top: sizes.current.top, bottom: sizes.current.bottom, left: 0, right: 0 }, duration: 450 });
  };
  const pickBrand = (b: DriverBrand | null) => {
    haptic.select();
    target.current = null;
    const next = b == null ? [] : brandSel.includes(b) ? brandSel.filter((x) => x !== b) : [...brandSel, b];
    const all = next.length === BRAND_ORDER.length ? [] : next;
    setBrandSel(all);
    store('cft.brands', all);
  };
  const pickRank = (r: Show) => { haptic.select(); target.current = null; setRankBy(r); store('cft.rankBy', r); };
  const brandText = !brandSel.length ? 'CFT' : brandSel.map((b) => BRANDS[b].short).join(' / ');
  const selOn = !!selPlaced && placed.onRoute.includes(selPlaced);
  /** Under the picked station: its real detour, and whether the truck gets there before empty. */
  const selNote = useMemo(() => {
    if (!selPlaced) return null;
    const parts: string[] = [];
    const d = detours.get(selPlaced.item.id);
    if (d != null) parts.push(d < 1 ? 'Right off your route' : `+${Math.round(d)} min off your route`);
    let warn = false;
    if (rangeMi != null) {
      const mi = Math.round(selPlaced.alongMi + selPlaced.offMi);
      if (reachable(selPlaced, rangeMi)) parts.push(`Reachable before empty (${mi} of ${rangeMi} mi)`);
      else { warn = true; parts.push(`Beyond your range: ${mi} mi away, ${rangeMi} mi left`); }
    }
    return parts.length ? { text: parts.join(' · '), warn } : null;
  }, [selPlaced, detours, rangeMi]);
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
      rec.current?.stopReached();
      setTrip({ ...trip, phase: 'stop' });
      say([`You have arrived at ${stopStation.station}.`, `Your CFT price is ${money(payPrice(stopStation))} a gallon.`], ['arrived_stop']);
    } else if (trip.phase === 'go2' && nav.route.totalMi - along < ARRIVE_MI) {
      haptic.success();
      rec.current?.end('arrived');
      setTrip({ ...trip, phase: 'done' });
      say([`You have arrived at ${dest}.`], ['arrived']);
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
    prefetchPack(packForSteps(r.steps));
  };

  // Off the route for about two seconds: plan again from here (real GPS only).
  useEffect(() => {
    const e = engine.current;
    if (SIMULATE || !trip || !nav || !fix.current || (trip.phase !== 'go1' && trip.phase !== 'go2')) { e.offCount = 0; return; }
    e.offCount = ui.off > OFF_ROUTE_MI ? e.offCount + 1 : 0;
    if (e.offCount < 8 || Date.now() - e.lastReroute < 20_000) return;
    e.lastReroute = Date.now();
    e.offCount = 0;
    say(['Rerouting.'], ['rerouting']);
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
    say([leadIn(toTurn), sentence(next.text)], [packTurn(toTurn, next.type, next.text)]);
  }, [along]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the screen on while driving.
  useEffect(() => {
    if (!trip || trip.phase === 'done') return;
    let lock: { release?: () => Promise<void> } | null = null;
    (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release?: () => Promise<void> }> } }).wakeLock?.request('screen').then((l) => { lock = l; }, () => {});
    return () => { lock?.release?.().catch(() => {}); };
  }, [trip?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the map ends the trip's record (closing the app is caught by the recorder itself).
  useEffect(() => () => { rec.current?.end('ended'); rec.current = null; }, []);
  // Trip history: drivers are told once, before their first navigation, that trips are recorded.
  const [noticeOpen, setNoticeOpen] = useState(false);
  const recording = !!data?.trips?.record && !SIMULATE;
  const startTrip = (noticeOk = false) => {
    if (!route) return;
    if (recording && !noticeOk && !data?.trips?.noticeSeen && !stored('cft.tripNotice', false)) { haptic.tap(); setNoticeOpen(true); return; }
    haptic.tap();
    unlockVoice();
    said.current.clear();
    following.current = true;
    setFollowUi(true);
    const stopId = sel != null && (selOn || via) ? sel : null;
    startNav(route, true);
    setTrip({ phase: stopId != null ? 'go1' : 'go2', stopId });
    const s = stopId != null ? byId.get(stopId) : null;
    rec.current?.end('ended');
    if (recording) {
      const step = Math.max(1, Math.ceil(route.path.length / 1400));
      rec.current = startRecording({
        from: { label: route.from.label || from.text.trim() || 'My location', lat: route.from.lat, lng: route.from.lng },
        to: { label: route.to.label || to.text.trim() || 'Destination', lat: route.to.lat, lng: route.to.lng },
        stop: s && s.lat != null && s.lng != null ? { id: s.id, name: s.station, brand: s.brand, price: payPrice(s), lat: s.lat, lng: s.lng } : null,
        plannedMi: route.totalMi, plannedS: route.durationS, source: route.source ?? null,
        path: route.path.filter((_p, i) => i % step === 0 || i === route.path.length - 1).map((p) => [p.lng, p.lat] as [number, number]),
        truck, noticeSeen: true,
      });
      if (fix.current) rec.current.point(fix.current);
    } else rec.current = null;
    say([s ? `Starting the route to ${s.station}.` : 'Starting the route.', sentence(route.steps[0]?.text ?? 'Start driving')], [s ? 'starting_stop' : 'starting']);
    if (!muted && voiceKind() === 'none') flash('This phone cannot play spoken directions. Follow the arrows on the screen.');
  };
  const endTrip = () => {
    const m = mapRef.current;
    rec.current?.end(tripRef.current?.phase === 'done' ? 'arrived' : 'ended');
    rec.current = null;
    setTrip(null);
    setNav(null);
    // The trip is over (arrived, ended or cancelled): the fuel range typed for it no longer holds.
    saveRange(null);
    drivenAcc.current = 0;
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
  const revealed = useRef(false);
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !ready || !data) return;
    setStations(m, data.stations.map((s) => ({ id: s.id, brand: s.brand, lat: s.lat, lng: s.lng, price: payPrice(s) })), !revealed.current);
    revealed.current = true;
  }, [ready, data]);
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !ready) return;
    showLayers(m, ALL_STATION_LAYERS, mode === 'states' || (!base && !trip));
    const shown = trip ? nav?.route ?? null : route;
    drawRoute(m, shown?.path ?? null, !trip && via && base ? base.path : null, shown?.traffic ?? []);
  }, [ready, base, via, trip, nav, route, mode]);
  // The route's ends: a green start (only when it is not the driver's own location, which is the blue
  // dot) and a red finish flag, both pulsing, so start, finish and "me" are told apart at a glance.
  useEffect(() => {
    if (!ready) return;
    const shown = trip ? nav?.route ?? null : route;
    const p = shown?.path;
    ends.current?.set(p && !trip && from.text.trim() ? p[0] : null, p && p.length > 1 ? p[p.length - 1] : null);
  }, [ready, route, trip, nav, from.text]);
  // A new route draws itself on.
  useEffect(() => { if (ready && base && !trip && mapRef.current) revealRoute(mapRef.current); }, [base]); // eslint-disable-line react-hooks/exhaustive-deps
  // By state on a wide screen: the map beside the list shows the stations picked.
  const [picked, setPicked] = useState<number[] | null>(null);
  modeRef.current = mode;
  // The station whose card is open in By state: highlighted, and brought into view beside the panel.
  useEffect(() => {
    const m = mapRef.current;
    const s = statesOpen != null ? byId.get(statesOpen) : null;
    if (!m || !s || s.lat == null || !wide()) return;
    m.easeTo({ center: [s.lng!, s.lat!], zoom: Math.max(m.getZoom(), 9), padding: { left: 420, top: 0, bottom: 0, right: 0 }, duration: 500 });
  }, [statesOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !ready) return;
    if (mode !== 'states') { filterStations(m, null); return; }
    filterStations(m, picked);
    if (!picked || !wide()) return;
    const t = setTimeout(() => {
      const pts = picked.map((id) => byId.get(id)).filter((s): s is DriverStation => s?.lat != null).map((s) => ({ lat: s.lat!, lng: s.lng! }));
      fitPoints(m, pts, { left: 440, top: 0, bottom: 0 });
    }, 250);
    return () => clearTimeout(t);
  }, [mode, picked, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !ready) return;
    if (mode === 'states') {
      const s = statesOpen != null ? byId.get(statesOpen) : null;
      setRouteStations(m, s ? [{ id: s.id, brand: s.brand, lat: s.lat, lng: s.lng, price: payPrice(s), sel: true, tag: true, near: false }] : []);
      return;
    }
    // The best three (numbered price tags) and the chosen one; while driving, only the stop.
    const chosen = selPlaced && !top.includes(selPlaced) ? [selPlaced] : [];
    const list = trip ? pool.filter((p) => p.item.id === trip.stopId) : [...top, ...chosen];
    setRouteStations(m, list.map((p) => ({
      id: p.item.id, brand: p.item.brand, lat: p.item.lat, lng: p.item.lng, price: payPrice(p.item),
      sel: p.item.id === (trip ? trip.stopId : sel), tag: !trip && (rankBy !== 'all' || p.item.id === sel), near: !placed.onRoute.includes(p),
      rank: !trip && rankBy !== 'all' && top.includes(p) ? top.indexOf(p) : undefined,
    })));
  }, [ready, pool, top, sel, trip, mode, statesOpen, rankBy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const m = mapRef.current;
    if (m && ready) drawTurn(m, trip && next && next.type !== 10 ? next.at : null);
  }, [ready, trip?.phase, nextIdx]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new route: framed between the search box and the card.
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !ready || !route || trip) return;
    // After the card below has its final height (the cheapest station is picked a moment later), with
    // room for the "Nearby stations" button above it.
    const id = setTimeout(() => { measure(); fitPath(m, route.path, { top: sizes.current.top, bottom: sizes.current.bottom + 46 }); }, 90);
    return () => clearTimeout(id);
  }, [ready, route, trip, measure]); // eslint-disable-line react-hooks/exhaustive-deps
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
    if (!m) return;
    const go = (p: LatLng) => m.easeTo({ center: ll(p), zoom: Math.max(m.getZoom(), 12), padding: { top: sizes.current.top, bottom: sizes.current.bottom, left: 0, right: 0 }, duration: 500 });
    // At once to the last known place, then to the fresh one.
    if (fix.current) go(fix.current);
    else flash('Finding your location…', undefined, 0);
    setLocating(true);
    void locateNow().then((f) => {
      setLocating(false);
      if (!f) { noLocation(); return; }
      go(f);
      flash(f.accuracy != null ? `You are here (within ${dist(f.accuracy / 1609.34)})` : 'You are here');
    });
  };

  // ---- Telegram's back button (By state has its own)
  useBackButton(mode === 'states' ? null : () => {
    if (noticeOpen) setNoticeOpen(false);
    else if (truckOpen) setTruckOpen(false);
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

  let banner: Banner | null = null;
  if (trip && nav) {
    if ((phase === 'go1' || phase === 'go2') && next) {
      const arriving = next.type === 10;
      banner = { big: dist(toTurn), text: arriving ? `Arrive at ${phase === 'go1' && stopStation ? stopStation.station : dest}` : next.text, sub: cur?.street ? `on ${cur.street}` : '', type: arriving ? 'ok' : next.type };
    } else if (phase === 'go1' || phase === 'go2') banner = { big: dist(leftMi), text: `Continue to ${phase === 'go1' && stopStation ? stopStation.station : dest}`, sub: '', type: 6 };
    else if (phase === 'stop' && stopStation) banner = { big: "You've arrived", text: `${stopStation.station} · ${placeOf(stopStation)}`, sub: '', type: 'ok' };
    else banner = { big: dest, text: 'Trip complete', sub: '', type: 'ok' };
  }

  const showSheet = mode === 'route' && !!(trip || base || tappedStation || (!routing && routeErr && to.text.trim()));

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
        <TopPanel
          topRef={topRef} banner={banner} limit={limit} driving={phase === 'go1' || phase === 'go2'} onStates={() => setMode('states')}
          base={base} focus={focus} setFocus={setFocus} editing={editing} setEditing={setEditing}
          from={from} to={to} setFrom={setFrom} setTo={setTo} sugg={sugg}
          locating={locating} hasPos={!!(fix.current || myPos)} myAcc={myAcc} posErr={posErr} routingOff={!!data && !data.routing}
          pickPlace={pickPlace} plan={(f, t) => plan(f, t, truck)} toMyLocation={toMyLocation} clearRoute={clearRoute}
          truck={truck} rangeMi={rangeMi} onTruck={() => setTruckOpen(true)}
        />
      )}

      {mode === 'route' && (
        <div className="dm-fabs">
          {trip && (
            <button type="button" className="dm-fab" aria-label={muted ? 'Turn the voice on' : 'Turn the voice off'} aria-pressed={!muted}
              onClick={() => { const v = !muted; setMuted(v); store('cft.voiceOff', v); if (v) hush(); else { unlockVoice(); say(['Voice on.'], ['voice_on']); } }}>
              <Svg d={muted ? MUTE : SOUND} size={20} />
            </button>
          )}
          {(!trip || !followUi) && (
            <button type="button" className={'dm-fab' + (locating && !trip ? ' busy' : '')} aria-label={trip ? 'Follow the truck again' : 'Show my location'} onClick={locateMe}>
              <Svg d={trip ? NAV : LOCATE} size={20} />
            </button>
          )}
        </div>
      )}

      {note && (
        <div className={'dm-toast' + (note.action ? ' act' : '')} role="status">
          {note.text}
          {note.action && <button type="button" onClick={() => { haptic.tap(); note.action!.run(); setNote(null); }}>{note.action.label}</button>}
        </div>
      )}

      {mode === 'route' && routing && !trip && <BuildingCard fromText={from.text} toText={to.text} step={buildStep} onCancel={cancelPlan} />}

      {showSheet && (
        <section className="dm-sheet" ref={sheetCb} aria-live="polite">
          {!trip && !base && tappedStation && (
            <>
              <button type="button" className="dm-close" aria-label="Close" onClick={() => setTapped(null)}><Svg d={X} size={16} /></button>
              <StationCard s={tappedStation} badge={BRANDS[tappedStation.brand].label.toUpperCase()} near={false} detail={detail} onToggle={() => setDetail((v) => !v)}
                primary={data?.routing ? 'Route here' : 'Routes are not on yet'} onPrimary={() => { if (data?.routing) routeTo(tappedStation); }} />
            </>
          )}
          {!trip && !base && !tappedStation && !routing && <p className="dm-note">{routeErr}</p>}
          {!trip && base && route && (
            <RouteCard
              route={route} top={top} selRank={selRank} page={page} rankBy={rankBy} pickRank={pickRank}
              brandSel={brandSel} pickBrand={pickBrand} brandText={brandText}
              selPlaced={selPlaced} selOn={selOn} extraMi={extraMi} selNote={selNote}
              detail={detail} toggleDetail={() => setDetail((v) => !v)}
              canGo={selOn || !!via} startTrip={() => startTrip()} anyStations={pool.length > 0}
            />
          )}
          {trip && (phase === 'go1' || phase === 'go2') && nav && (
            <DrivingCard toStop={phase === 'go1'} stop={stopStation} dest={dest} leftMi={leftMi} avgMph={avgMph} along={along} totalMi={nav.route.totalMi} stopAlong={stopAlong} onEnd={endTrip} />
          )}
          {trip && phase === 'stop' && stopStation && (
            <StopCard stop={stopStation} dest={dest} onEnd={endTrip}
              onContinue={() => { said.current.clear(); setTrip({ ...trip, phase: 'go2' }); say([`Continuing to ${dest}.`], ['continuing']); }} />
          )}
          {trip && phase === 'done' && nav && <DoneCard dest={dest} onNewTrip={() => { endTrip(); clearRoute(); }} />}
        </section>
      )}

      {noticeOpen && <TripNotice onClose={() => setNoticeOpen(false)} onStart={() => { store('cft.tripNotice', true); setNoticeOpen(false); startTrip(true); }} />}
      {truckOpen && <TruckSheet truck={truck} rangeMi={rangeMi} onClose={() => setTruckOpen(false)} onSave={(t, r) => {
        const truckChanged = t.heightIn !== truck.heightIn || t.weightLb !== truck.weightLb || t.hazmat !== truck.hazmat;
        setTruck(t); store('cft.truck', t); setTruckOpen(false); haptic.success();
        // A newly typed range starts its 12 hours now; the same number saved again keeps its time.
        if (r !== rangeMi) { saveRange(r != null ? { mi: r, setAt: Date.now() } : null); drivenAcc.current = 0; }
        // Only the truck changes the way; the range only changes which station is picked.
        if (base && truckChanged) plan(from, to, t);
      }} />}

      {mode === 'states' && (
        <ByState stations={data?.stations ?? null} fetchedAt={data?.fetchedAt ?? null} routing={!!data?.routing} onRouteTo={routeTo} onMyRoute={() => setMode('route')} onPicked={setPicked}
          mapTap={mapTap} onOpenChange={setStatesOpen} />
      )}
    </div>
  );
}
