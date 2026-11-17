import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DriverPlace, DriverRoute, DriverStation, DriverStations, TruckProfile } from '../../../../../shared/types';
import { applyDetours, bestStop, BRANDS, detourAsks, payPrice, rangeOf, reachable, stationsAlongRoute, type LatLng, type Placed } from '../../../../../shared/driver-route';
import { DRIVER_MAP } from '../../../../../shared/driver-config';
import { US_STATES as STATE_NAMES } from '../../../../../shared/states';
import { titleCase } from '../../../../../shared/discounts';
import { driverApi, type ApiError } from '../../lib/api';
import { reportMapError } from '../../lib/report';
import { fmtDuration as hm } from '../../components/ui';
import { haptic, openTelegramLocationSettings, telegramLocation, telegramLocationRefused, useBackButton } from '../../lib/telegram';
import { ByState } from './ByState';
import {
  ALL_STATION_LAYERS, createMap, drawDriven, drawRoute, drawTurn, driverMarker, filterStations, fitPath, fitPoints, ll, onStationTap, revealRoute, routeEnds, setRouteStations, setStations,
  showLayers, type MlMap,
} from './map';
import { drivenPath, locate, navOf, pointAt, speedLimitAt, stepsAt, unwrap, type Nav } from './nav';
import {
  CHECK, DEFAULT_TRUCK, EDIT, LAYERS, LOCATE, MUTE, NAV, PIN, PriceBox, SOUND, StationCard, Svg, Truck, TruckSheet, X,
  dist, firstPart, fullAddress, money, pct, placeOf, store, stored, truckText, turnIcon,
} from './pieces';
import { hush, LEAD_INS, leadIn, packForSteps, packTurn, prefetchPack, prefetchVoice, sentence, speak, unlockVoice, voiceKind } from './voice';
import { startRecording, type TripRecorder } from './trip-recorder';
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
interface Fix extends LatLng { heading: number | null; speed: number | null; accuracy: number | null }

// Thresholds: shared/driver-config.ts. On a planned route the map shows only the cheapest few
// (cheapShown); "Nearby stations" shows the rest.
const { corridorMi: CORRIDOR_MI, nearbyMi: NEARBY_MI, nearbyMax: NEARBY_MAX, cheapShown: CHEAP_SHOWN } = DRIVER_MAP;
const STATIONS_KEY = 'cft.stations.v1';
const BUILD_STEPS = ['Finding roads for your truck', 'Checking live traffic', 'Finding CFT stations on the way'];
const toFix = (p: GeolocationPosition): Fix => ({ lat: p.coords.latitude, lng: p.coords.longitude, heading: p.coords.heading ?? null, speed: p.coords.speed ?? null, accuracy: p.coords.accuracy ?? null });
const byPay = (a: Placed<DriverStation>, b: Placed<DriverStation>) => (payPrice(a.item) ?? 99) - (payPrice(b.item) ?? 99);
const wide = () => window.matchMedia('(min-width: 900px)').matches;
const ARRIVE_MI = 0.12;
const OFF_ROUTE_MI = 0.12;
/** /route?simulate drives the route without moving (about three minutes for any trip). */
const SIMULATE = /simulate/.test(location.search + location.hash);
const inUS = (p: LatLng) => p.lat > 24 && p.lat < 50 && p.lng > -125.5 && p.lng < -66;
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function DriverMap({ onExit }: { onExit: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>('route');
  const [statesOpen, setStatesOpen] = useState<number | null>(null);

  // ---- stations
  // The list from the last visit shows at once (from the phone), the fresh one replaces it.
  const cachedAtStart = useRef(stored<DriverStations | null>(STATIONS_KEY, null));
  const [data, setData] = useState<DriverStations | null>(cachedAtStart.current);
  const [loadErr, setLoadErr] = useState('');
  const fresh = useCallback((d: DriverStations) => { setData(d); store(STATIONS_KEY, d); }, []);
  const load = useCallback(() => {
    setLoadErr('');
    driverApi.stations().then(fresh, (e: ApiError) => { if (!cachedAtStart.current) setLoadErr(e.message); reportMapError(`stations: ${e.message}`); });
  }, [fresh]);
  useEffect(load, [load]);
  // Stations still without a map point: looked up in the background, then the list again.
  useEffect(() => {
    if (!data?.pendingGeocode || data === cachedAtStart.current) return;
    let live = true;
    driverApi.locate().then((r) => { if (live && r.placed > 0) driverApi.stations().then(fresh, () => {}); }, () => {});
    return () => { live = false; };
  }, [data, fresh]);
  const byId = useMemo(() => new Map((data?.stations ?? []).map((s) => [s.id, s])), [data]);

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
    if (baseRef.current) { userPicked.current = true; setSel(id); setDetail(true); return; }
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
  const [myAcc, setMyAcc] = useState<number | null>(null);
  const [posErr, setPosErr] = useState('');
  const accept = useCallback((f: Fix) => {
    const prev = fix.current;
    fix.current = f;
    setPosErr('');
    if (!prev || Math.abs(prev.lat - f.lat) + Math.abs(prev.lng - f.lng) > 0.003) setMyPos({ lat: f.lat, lng: f.lng });
    setMyAcc(f.accuracy != null ? Math.round(f.accuracy / 5) * 5 : null);
    if (!tripRef.current) puck.current?.set(f, f.speed != null && f.speed > 1 ? f.heading : null);
    else rec.current?.point(f);
  }, []);
  useEffect(() => {
    let poll = 0;
    let id: number | null = null;
    // The page's own location is blocked (some Telegram apps): Telegram's location instead.
    const viaTelegram = () => {
      if (poll) return;
      const tick = () => telegramLocation().then((f) => {
        if (f) accept(f);
        else if (!fix.current) setPosErr('Location is off. Allow it, or type where you start from.');
      });
      void tick();
      poll = window.setInterval(tick, 3000);
    };
    if (!navigator.geolocation) viaTelegram();
    else id = navigator.geolocation.watchPosition((p) => accept(toFix(p)), viaTelegram, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    // Inside Telegram the page's own location can stay silent (no answer, no error): Telegram's too.
    const late = window.setTimeout(() => { if (!fix.current) viaTelegram(); }, 4000);
    return () => { if (id != null) navigator.geolocation.clearWatch(id); clearInterval(poll); clearTimeout(late); };
  }, [accept]);
  /**
   * A fresh, precise fix now (the "use my location" and locate buttons): the phone's location, and
   * Telegram's as soon as the phone's fails or is slow (1.5 s); the first answer wins, 10 s at most.
   */
  const locateNow = useCallback(() => new Promise<Fix | null>((resolve) => {
    let done = false, waiting = 0, tgAsked = false;
    const end = (f: Fix | null) => { if (done) return; done = true; clearTimeout(cap); clearTimeout(slow); if (f) accept(f); resolve(f ?? fix.current); };
    const answer = (f: Fix | null) => { if (f) end(f); else if (--waiting <= 0 && (tgAsked || !navigator.geolocation)) end(null); };
    const askTelegram = () => { if (tgAsked || done) return; tgAsked = true; waiting++; void telegramLocation().then(answer, () => answer(null)); };
    const cap = window.setTimeout(() => end(null), 10_000);
    const slow = window.setTimeout(askTelegram, 1500);
    if (!navigator.geolocation) { askTelegram(); return; }
    waiting++;
    navigator.geolocation.getCurrentPosition((p) => answer(toFix(p)), () => { askTelegram(); answer(null); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10_000 });
  }), [accept]);
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(null);
  const noteTimer = useRef(0);
  const flash = useCallback((text: string, action?: { label: string; run: () => void }, ms = 3200) => {
    setNote({ text, action });
    clearTimeout(noteTimer.current);
    if (ms) noteTimer.current = window.setTimeout(() => setNote(null), ms);
  }, []);
  /** No location: says why, with a button to Telegram's settings when Telegram was refused access. */
  const noLocation = useCallback(() => {
    if (telegramLocationRefused()) flash('Location is off for this app.', { label: 'Turn on', run: openTelegramLocationSettings }, 8000);
    else flash('Could not find your location. Turn on location for Telegram in the phone settings, or type a place.', undefined, 6000);
  }, [flash]);
  useEffect(() => { if (ready && fix.current && !tripRef.current) puck.current?.set(fix.current, null); }, [ready]);

  // ---- the truck and the voice switch
  const [truck, setTruck] = useState<TruckProfile>(() => ({ ...DEFAULT_TRUCK, ...stored<Partial<TruckProfile>>('cft.truck', {}) }));
  const [truckOpen, setTruckOpen] = useState(false);
  /** Miles until empty (optional): the pick prefers stations the truck can reach. */
  const [rangeMi, setRangeMi] = useState<number | null>(() => rangeOf(stored<number | null>('cft.rangeMi', null)));
  const [muted, setMuted] = useState(() => stored('cft.voiceOff', false));
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  /** Speaks `parts`; `pack` is the same message from the built-in voice pack (phones with no voice). */
  const say = useCallback((parts: string[], pack: string[] = []) => { if (!mutedRef.current) void speak(parts, pack); }, []);

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
  const [editing, setEditing] = useState(false);
  const [buildStep, setBuildStep] = useState(0);
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

  // ---- the stations along the route
  // First filter: straight-line distance from the route (the corridor).
  const straight = useMemo(() => {
    if (!base || !data) return { onRoute: [] as Placed<DriverStation>[], nearby: [] as Placed<DriverStation>[] };
    return stationsAlongRoute(base.path, data.stations, { corridorMi: CORRIDOR_MI, nearbyMi: NEARBY_MI });
  }, [base, data]);
  // Then the cheapest few get a real driving-time check: one across a divided highway or far from an
  // exit costs real minutes and is moved to "nearby" (tools/driver-map/detours.ts).
  const asks = useMemo(() => (base ? detourAsks(base.path, straight.onRoute) : []), [base, straight]);
  const asksKey = asks.map((a) => a.id).join(',');
  const [detours, setDetours] = useState<Map<number, number | null>>(() => new Map());
  useEffect(() => {
    setDetours(new Map());
    if (!asks.length) return;
    let live = true;
    driverApi.detours(asks).then((r) => { if (live) setDetours(new Map(r.detours.map((d) => [d.id, d.detourMin]))); }, () => {});
    return () => { live = false; };
  }, [base, asksKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const placed = useMemo(() => {
    const r = applyDetours(straight, detours);
    return { onRoute: r.onRoute, nearby: r.nearby.slice().sort((a, b) => (payPrice(a.item) ?? 99) - (payPrice(b.item) ?? 99)).slice(0, NEARBY_MAX) };
  }, [straight, detours]);
  // The pick: the cheapest the truck can reach before empty (when the driver gave a range).
  const best = useMemo(() => bestStop(placed.onRoute, rangeMi), [placed, rangeMi]);
  const [nearbyOn, setNearbyOn] = useState(false);
  useEffect(() => setNearbyOn(false), [base]);
  const cheapIds = useMemo(() => new Set(placed.onRoute.slice().sort(byPay).slice(0, CHEAP_SHOWN).map((p) => p.item.id)), [placed]);
  /** The driver picked a station on this route: a late detour answer must not take it away. */
  const userPicked = useRef(false);
  useEffect(() => { userPicked.current = false; }, [base]);
  useEffect(() => {
    if (userPicked.current && sel != null && [...placed.onRoute, ...placed.nearby].some((p) => p.item.id === sel)) return;
    const t = target.current != null ? placed.onRoute.find((p) => p.item.id === target.current) : undefined;
    setSel(t?.item.id ?? best?.item.id ?? null);
  }, [best, placed]); // eslint-disable-line react-hooks/exhaustive-deps
  const selPlaced = placed.onRoute.find((p) => p.item.id === sel) ?? placed.nearby.find((p) => p.item.id === sel) ?? null;
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
    // The cheapest few on the route (and the chosen one); all of them, and those near it, on request.
    const list = trip
      ? [...placed.onRoute, ...placed.nearby].filter((p) => p.item.id === trip.stopId)
      : nearbyOn ? [...placed.onRoute, ...placed.nearby] : [...placed.onRoute, ...placed.nearby].filter((p) => cheapIds.has(p.item.id) || p.item.id === sel);
    setRouteStations(m, list.map((p) => ({
      id: p.item.id, brand: p.item.brand, lat: p.item.lat, lng: p.item.lng, price: payPrice(p.item),
      sel: p.item.id === (trip ? trip.stopId : sel), tag: !trip && cheapIds.has(p.item.id), near: !placed.onRoute.includes(p),
    })));
  }, [ready, placed, sel, nearbyOn, trip, cheapIds, mode, statesOpen]); // eslint-disable-line react-hooks/exhaustive-deps
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
          placeholder={which === 'from' ? (locating ? 'Finding your location…' : fix.current || myPos ? 'My location' : posErr ? 'Type where you start from' : 'Finding your location…') : 'Where are you going?'}
          enterKeyHint="go"
          autoComplete="off"
          disabled={!!data && !data.routing}
          onFocus={() => { setFocus(which); setEditing(true); }}
          onBlur={() => setTimeout(() => setFocus((x) => (x === which ? null : x)), 150)}
          onChange={(e) => set({ text: e.target.value, place: null })}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            (e.target as HTMLInputElement).blur();
            if (sugg[0] && !f.place) pickPlace(which, sugg[0]);
            else plan(which === 'from' ? f : from, which === 'to' ? f : to, truck);
          }}
        />
        {which === 'from' && !f.text && myAcc != null && focus !== 'from' && <span className="dm-acc">±{dist(myAcc / 1609.34)}</span>}
        {which === 'from' && f.text ? (
          <button type="button" className="dm-x me" aria-label="Use my location" onClick={toMyLocation}><Svg d={LOCATE} size={16} /></button>
        ) : f.text ? (
          <button type="button" className="dm-x" aria-label="Clear destination" onClick={clearRoute}><Svg d={X} size={15} /></button>
        ) : null}
      </div>
    );
  };

  const showSheet = mode === 'route' && !!(trip || base || tappedStation || (!routing && routeErr && to.text.trim()));
  const shownOnRoute = placed.onRoute.filter((p) => cheapIds.has(p.item.id) || p.item.id === sel).length;
  const moreCount = placed.onRoute.length - shownOnRoute + placed.nearby.length;

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
              {base && !focus && !editing ? (
                <div className="dm-trip dm-mini">
                  <button type="button" className="dm-mini-main" aria-label="Change the trip" onClick={() => { haptic.tap(); setEditing(true); }}>
                    <span className="dm-trip-ico truck"><Truck size={13} /></span>
                    <span className="dm-mini-text">
                      <small>{from.text ? firstPart(from.text) : 'My location'}</small>
                      <b>{firstPart(to.text || base.to.label)}</b>
                    </span>
                    <Svg d={EDIT} size={15} />
                  </button>
                  <button type="button" className="dm-x" aria-label="Clear the route" onClick={() => { haptic.tap(); clearRoute(); }}><Svg d={X} size={15} /></button>
                </div>
              ) : (
              <div className="dm-trip">
                {field('from')}
                {field('to')}
                {focus && (sugg.length > 0 || focus === 'from') ? (
                  <ul className="dm-sugg" role="listbox" aria-label="Places">
                    {focus === 'from' && (
                      <li>
                        <button type="button" role="option" aria-selected={!from.text} className="dm-sugg-me" onPointerDown={(e) => e.preventDefault()} onClick={toMyLocation}>
                          <Svg d={LOCATE} size={16} color="#a0dcff" />
                          <span>Use my current location</span>
                          <small>{locating ? 'locating…' : myAcc != null ? `±${dist(myAcc / 1609.34)}` : posErr ? 'off' : ''}</small>
                        </button>
                      </li>
                    )}
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
                    <Truck size={13} /><span>{truckText(truck)}{rangeMi != null ? ` · ${rangeMi} mi left` : ''}</span><Svg d={EDIT} size={13} />
                  </button>
                )}
              </div>
              )}
            </>
          )}
        </div>
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

      {mode === 'route' && !trip && base && !routing && moreCount > 0 && (
        <button key={`${base.totalMi}`} type="button" className={'dm-more' + (nearbyOn ? ' on' : '')} aria-pressed={nearbyOn} onClick={() => { haptic.tap(); setNearbyOn((v) => !v); }}>
          <Svg d={LAYERS} size={15} />{nearbyOn ? 'Only the cheapest' : `Nearby stations · ${moreCount}`}
        </button>
      )}
      {note && (
        <div className={'dm-toast' + (note.action ? ' act' : '')} role="status">
          {note.text}
          {note.action && <button type="button" onClick={() => { haptic.tap(); note.action!.run(); setNote(null); }}>{note.action.label}</button>}
        </div>
      )}

      {mode === 'route' && routing && !trip && (
        <div className="dm-building" role="status" aria-live="polite">
          <div className="dm-build-card">
            <div className="dm-build-road" aria-hidden="true"><i /><span><Truck size={15} /></span></div>
            <b>Building your truck route</b>
            <span className="dm-build-to">{from.text ? firstPart(from.text) : 'My location'} → {firstPart(to.text) || 'destination'}</span>
            <ul className="dm-build-steps">
              {BUILD_STEPS.map((t, i) => <li key={t} className={i < buildStep ? 'done' : i === buildStep ? 'now' : ''}><i>{i < buildStep && <Svg d={CHECK} size={12} w={3} />}</i>{t}</li>)}
            </ul>
            <button type="button" className="dm-soft" onClick={cancelPlan}>Cancel</button>
          </div>
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
          {!trip && !base && !tappedStation && !routing && <p className="dm-note">{routeErr}</p>}
          {!trip && base && route && (
            <>
              <div className="dm-summary">
                <b>{hm(route.durationS)}</b>
                <span>{Math.round(route.totalMi).toLocaleString('en-US')} mi{route.delayMin ? ` · ${route.delayMin} min traffic` : ''}{route.source === 'tomtom' ? ' · live traffic' : ''}</span>

              </div>
              {selPlaced ? (
                <StationCard
                  s={selPlaced.item}
                  badge={selPlaced === best ? (rangeMi != null && reachable(selPlaced, rangeMi) ? 'CHEAPEST YOU CAN REACH' : 'CHEAPEST ON YOUR ROUTE') : selOn ? `ON YOUR ROUTE · ${Math.round(selPlaced.alongMi)} MI` : extraMi != null ? `NEW ROUTE · +≈ ${extraMi} MI` : 'NEAR YOUR ROUTE'}
                  near={!selOn} detail={detail} onToggle={() => setDetail((v) => !v)} note={selNote}
                  primary={selOn || via ? 'Navigate' : 'Finding the way…'} onPrimary={() => { if (selOn || via) startTrip(); }}
                />
              ) : (
                <>
                  <p className="dm-note">No CFT stations along this route.</p>
                  <button type="button" className="dm-primary" onClick={() => startTrip()}><Svg d={NAV} size={20} />Navigate</button>
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
                <button type="button" className="dm-primary" onClick={() => { said.current.clear(); setTrip({ ...trip, phase: 'go2' }); say([`Continuing to ${dest}.`], ['continuing']); }}><Svg d={NAV} size={18} />Continue to {dest}</button>
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

      {noticeOpen && (
        <>
          <button className="dm-scrim" aria-label="Close" onClick={() => setNoticeOpen(false)} />
          <section className="dm-sheet dm-trucksheet" role="dialog" aria-labelledby="dm-notice-title">
            <div className="dm-swap">
              <div>
                <span className="dm-eyebrow" id="dm-notice-title">YOUR TRIPS ARE RECORDED</span>
                <p style={{ margin: '8px 0 0', fontSize: 14.5, color: '#c8d0d6', lineHeight: 1.45 }}>
                  CFT keeps a record of the trips you navigate here: where you start and go, your fuel stop and its price, and where the truck drives while this map is open. Nothing is recorded when the map is closed. Records are kept for 12 months.
                </p>
              </div>
              <button type="button" className="dm-primary" onClick={() => { store('cft.tripNotice', true); setNoticeOpen(false); startTrip(true); }}><Svg d={NAV} size={20} />OK, start the route</button>
            </div>
          </section>
        </>
      )}
      {truckOpen && <TruckSheet truck={truck} rangeMi={rangeMi} onClose={() => setTruckOpen(false)} onSave={(t, r) => {
        const truckChanged = t.heightIn !== truck.heightIn || t.weightLb !== truck.weightLb || t.hazmat !== truck.hazmat;
        setTruck(t); store('cft.truck', t); setRangeMi(r); store('cft.rangeMi', r); setTruckOpen(false); haptic.success();
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
