import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { webApi, type ApiError, type WebRole } from '../../lib/api';
import { clearWebSession, routePageUrl, saveWebSession, signedIn, tg } from '../../lib/telegram';
import { Accent, Lines, Spinner } from '../../components/ui';

// The website (fuel.cftransportllc.com): the same app as the Telegram Mini App, for approved people only.
// Not signed in: the front page, with "Request access" (opens the bot, which asks the questions and
// sends the request to the admins) and "Log in" (the bot asks to confirm; support/helpers/web-login.ts).
// Signed in: their home screen, as their menu button opens in the bot. A personal link
// (fuel.cftransportllc.com/?ref=<code>) is remembered, so the request shows who invited them.
// Inside Telegram none of this runs: the Mini App is signed in by Telegram.

const REF_KEY = 'cft.ref';
const HOME: Record<Exclude<WebRole, 'candidates'>, string> = { admins: '#/hub', agents: '#/discounts', drivers: 'route' };
const onRoutePage = () => location.pathname.replace(/\/+$/, '') === '/route';

/** The personal code from ?ref=, kept on this browser (the latest link counts). */
function referral(): string {
  try {
    const fresh = new URLSearchParams(location.search).get('ref');
    if (fresh && /^[a-z0-9]{6,16}$/.test(fresh)) localStorage.setItem(REF_KEY, fresh);
    return localStorage.getItem(REF_KEY) ?? '';
  } catch {
    return '';
  }
}

type State = { k: 'ready' } | { k: 'checking' } | { k: 'front' } | { k: 'no-access'; name: string } | { k: 'home'; name: string; role: Exclude<WebRole, 'candidates'> };

export function WebGate({ children }: { children: ReactNode }) {
  const home = new URLSearchParams(location.search).has('home');
  const front = !onRoutePage() && !location.hash;
  const [state, setState] = useState<State>(() => (tg ? { k: 'ready' } : !signedIn ? { k: 'front' } : front || home ? { k: 'checking' } : { k: 'ready' }));
  useEffect(() => {
    if (state.k !== 'checking') return;
    webApi.me().then(
      ({ role, name }) => {
        if (role === 'candidates') return setState({ k: 'no-access', name });
        if (home) return setState({ k: 'home', name, role });
        if (role === 'drivers') return location.replace(routePageUrl());
        location.hash = HOME[role];
        setState({ k: 'ready' });
      },
      (e: ApiError) => {
        // The session expired or was ended: back to the front page.
        if (e.status === 401) { clearWebSession(); setState({ k: 'front' }); } else setState({ k: 'ready' });
      },
    );
  }, [state.k, home]);

  if (state.k === 'ready') return <>{children}</>;
  if (state.k === 'checking') return <div className="app"><div className="center-msg"><Spinner /></div></div>;
  return <div className="app"><FrontPage state={state} /></div>;
}

function FrontPage({ state }: { state: Exclude<State, { k: 'ready' } | { k: 'checking' }> }) {
  const [bot, setBot] = useState('');
  const ref = useRef(referral());
  useEffect(() => { webApi.info().then((i) => setBot(i.bot), () => setBot('')); }, []);
  const requestLink = bot ? `https://t.me/${bot}?start=req${ref.current ? `_${ref.current}` : ''}_w` : '';
  const logout = () => { void webApi.logout().catch(() => {}).finally(() => { clearWebSession(); location.assign('/'); }); };

  return (
    <div className="fill" style={{ overflow: 'hidden' }}>
      <img src="/assets/glow-blue.png" alt="" className="hero-glow" />
      <Lines />
      <header className="top-bar">
        <img src="/assets/cft-primary.svg" alt="CF Transport" />
        <span>Fuel prices &amp; truck navigation</span>
      </header>
      <main className="hero-main">
        <div className="hero-grid stagger">
          <div>
            <h1 className="h-hero">
              <span style={{ color: 'var(--blue)' }}>CFT</span>
              <br />
              FUEL
              <br />
              <span className="nowrap">PRICES<Accent /></span>
            </h1>
            <p className="hero-lede">For CFT drivers: partner stations with the CFT fuel price, truck routes, and turn-by-turn navigation. In Telegram or here in your browser. Access is by approval.</p>
          </div>
          <div className="form-card">
            {state.k === 'home' ? (
              <>
                <h2>HI, {state.name.toUpperCase()}</h2>
                <a className="btn btn-primary" href={state.role === 'drivers' ? routePageUrl() : `/${HOME[state.role]}`}>
                  {state.role === 'drivers' ? 'Open the route map' : 'Open CFT'}
                </a>
                <button type="button" className="btn btn-outline" onClick={logout}>Log out</button>
              </>
            ) : (
              <>
                <h2>{state.k === 'no-access' ? 'NOT APPROVED YET' : 'GET ACCESS'}</h2>
                <p className="soft" style={{ margin: 0, fontSize: 15, lineHeight: 1.5 }}>
                  {state.k === 'no-access'
                    ? `You are signed in as ${state.name}, but you don't have access yet. Request it, and you'll get a message in Telegram once a CFT admin approves it.`
                    : 'Request access in our Telegram bot: it takes a minute, and a CFT admin approves it. Already approved? Log in.'}
                </p>
                {requestLink ? <a className="btn btn-primary" href={requestLink}>Request access</a> : <Spinner />}
                {state.k === 'front' ? <LogIn bot={bot} /> : <button type="button" className="btn btn-outline" onClick={logout}>Log out</button>}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/** "I have access: log in": the bot asks to confirm; this page waits and signs in by itself. */
function LogIn({ bot }: { bot: string }) {
  const [login, setLogin] = useState<{ code: string; link: string } | null>(null);
  const [note, setNote] = useState('');
  const start = useCallback(() => {
    setNote('');
    // The new tab opens during the tap (browsers block it later), and goes to Telegram once the code is here.
    const tab = window.open('', '_blank');
    webApi.startLogin().then(
      (l) => { setLogin(l); if (tab) tab.location.href = l.link; },
      (e: ApiError) => { tab?.close(); setNote(e.message); },
    );
  }, []);
  useEffect(() => {
    if (!login) return;
    let live = true;
    const poll = () => webApi.pollLogin(login.code).then((r) => {
      if (!live) return;
      if (r.status === 'ok') { saveWebSession(r.session); location.assign('/'); }
      else if (r.status === 'expired') { setLogin(null); setNote('The login timed out. Tap Log in to try again.'); }
    }, () => {});
    const t = window.setInterval(poll, 2000);
    // Back from Telegram: check at once instead of waiting for the next tick.
    const back = () => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', back);
    return () => { live = false; clearInterval(t); document.removeEventListener('visibilitychange', back); };
  }, [login]);

  if (!login) {
    return (
      <>
        <button type="button" className="btn btn-outline" disabled={!bot} onClick={start}>I have access: log in</button>
        {note && <p className="soft" style={{ margin: 0, fontSize: 13 }}>{note}</p>}
      </>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p className="soft" style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
        Telegram opens with <b>@{bot}</b>. Tap <b>✅ Confirm login</b> there, then come back: this page signs you in by itself.
      </p>
      <a className="btn btn-outline" href={login.link} target="_blank" rel="noopener">Open Telegram again</a>
      <span className="soft" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}><Spinner /> Waiting for your confirmation…</span>
    </div>
  );
}
