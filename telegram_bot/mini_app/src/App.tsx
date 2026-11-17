import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AdminApp } from './screens/admins/academy/AdminApp';
import { CandidateApp } from './screens/candidates/academy/CandidateApp';
import { Team } from './screens/admins/Team';
import { Discounts } from './screens/agents/Discounts';
import { DiscountsData } from './screens/admins/DiscountsData';
import { Drivers } from './screens/admins/Drivers';
import { FuelPrices } from './screens/admins/FuelPrices';
import { Hub } from './screens/admins/Hub';
import { useAdminSession } from './lib/session';
import { routePageUrl, startParam, tg } from './lib/telegram';
import { reportMapError } from './lib/report';

/**
 * Which screen the Mini App shows, from the URL hash:
 *   #/hub        the admins' home (their chat menu button opens it)
 *   #/discounts  Find discounts: the agents' home (their menu button opens it); admins can open it too
 *   #/team       Team & access: agents, invite links, admins (admins)
 *   #/data       Fuel discounts data: what agents see, the margin (admins)
 *   #/fuel       Fuel prices: every station, real prices (admins)
 *   #/drivers    Drivers and their trip history (admins); a trip's map opens on /route?trip=<id>
 *   /route       The drivers' route map: truck routes, partner stations, navigation (agents and admins for now). Its own address,
 *                because the map needs a looser security policy (vercel.json); #/driver and the
 *                start param "driver" are sent there.
 *   #/admin      Agent Academy admin console
 *   anything else: the Agent Academy test (what candidates open)
 */
type Screen = 'hub' | 'fuel' | 'admin' | 'test' | 'discounts' | 'team' | 'data' | 'drivers';
const SCREENS: Screen[] = ['admin', 'hub', 'fuel', 'discounts', 'team', 'data', 'drivers'];
const screenFor = (hash: string, param = ''): Screen =>
  SCREENS.find((s) => hash.startsWith('#/' + s) || param === s) ?? 'test';

// The map and its library load only on /route, so the rest of the app stays light.
const DriverMap = lazy(() => import('./screens/drivers/DriverMap').then((m) => ({ default: m.DriverMap })));
// A recorded trip on the map, for admins: /route?trip=<id> (the map may only load on /route).
const TripReplay = lazy(() => import('./screens/drivers/TripReplay').then((m) => ({ default: m.TripReplay })));
const tripId = new URLSearchParams(location.search).get('trip');

/** The drivers' map has its own page; links to #/driver (or startapp=driver) are sent there. */
const ROUTE_PAGE = '/route';
const onRoutePage = location.pathname.replace(/\/+$/, '') === ROUTE_PAGE;
if (!onRoutePage && (location.hash.startsWith('#/driver') || startParam === 'driver')) location.replace(routePageUrl());

/** Leaves the map: back where they came from; drivers (who open it from their menu button) close the app. */
const leaveMap = () => (history.length > 1 ? history.back() : tg ? tg.close() : location.assign('/#/discounts'));

export function App() {
  if (onRoutePage) {
    const page = tripId ? <TripReplay id={tripId} onExit={() => (history.length > 1 ? history.back() : location.assign('/#/drivers'))} /> : <DriverMap onExit={leaveMap} />;
    return <div className="app"><MapCrashGuard><Suspense fallback={<div className="center-msg">Loading the map…</div>}>{page}</Suspense></MapCrashGuard></div>;
  }
  return <MainApp />;
}

if (onRoutePage) {
  window.addEventListener('error', (e) => reportMapError(e.message, (e.error as Error | undefined)?.stack));
  window.addEventListener('unhandledrejection', (e) => reportMapError(String((e.reason as Error)?.message ?? e.reason), (e.reason as Error)?.stack));
}

/** If the map screen crashes: a message and a reload instead of a black page. */
class MapCrashGuard extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message || 'Something went wrong.' };
  }
  componentDidCatch(e: Error) {
    reportMapError(e.message, e.stack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="center-msg" style={{ flexDirection: 'column', gap: 14, padding: 24, textAlign: 'center' }}>
        <b>The map could not open.</b>
        <span style={{ color: '#999', fontSize: 14 }}>{this.state.error}</span>
        <button type="button" className="d-cta" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

function MainApp() {
  const [screen, setScreen] = useState<Screen>(() => screenFor(location.hash, startParam));
  const [fromHub, setFromHub] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const scrollTop = useCallback(() => scroller.current?.scrollTo({ top: 0 }), []);

  useEffect(() => {
    const on = () => {
      setScreen((prev) => {
        const next = screenFor(location.hash);
        if (prev === 'hub' && next !== 'hub') setFromHub(true);
        return next;
      });
      scroller.current?.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const toHub = useCallback(() => {
    location.hash = '#/hub';
  }, []);

  if (screen === 'admin') return <div className="app"><AdminApp onExit={fromHub ? toHub : undefined} /></div>;
  // The design's screens scroll inside themselves, with fixed headers and footers.
  if (screen === 'discounts') return <div className="app"><Discounts onBack={fromHub ? toHub : undefined} /></div>;
  if (screen === 'team') return <div className="app"><AdminGate><Team onBack={toHub} /></AdminGate></div>;
  if (screen === 'data') return <div className="app"><AdminGate><DiscountsData onBack={toHub} /></AdminGate></div>;
  if (screen === 'drivers') return <div className="app"><AdminGate><Drivers onBack={toHub} /></AdminGate></div>;
  if (screen === 'hub') return <div className="app"><HubGate scrollTop={scrollTop} /></div>;
  const page = screen === 'fuel' ? <AdminGate><FuelPrices onBack={toHub} /></AdminGate> : <CandidateApp scrollTop={scrollTop} />;
  return (
    <div className="app">
      <div className="scroll" ref={scroller}>{page}</div>
    </div>
  );
}

/** The Hub for admins. Anyone else who opens it (for example an old menu button) gets the test. */
function HubGate({ scrollTop }: { scrollTop: () => void }) {
  const s = useAdminSession();
  if (s.phase === 'checking') return <div className="center-msg">Loading…</div>;
  if (s.phase === 'denied') return <div className="scroll"><CandidateApp scrollTop={scrollTop} /></div>;
  return <Hub name={s.name} />;
}

function AdminGate({ children }: { children: React.ReactNode }) {
  const s = useAdminSession();
  if (s.phase === 'checking') return <div className="center-msg">Loading…</div>;
  if (s.phase === 'denied') return <div className="center-msg">{s.message}</div>;
  return <>{children}</>;
}
