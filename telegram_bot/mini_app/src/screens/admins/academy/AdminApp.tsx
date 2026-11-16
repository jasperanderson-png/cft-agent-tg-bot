import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminData } from '../../../../../../shared/types';
import { ApiError, adminApi, hasAdminToken, setAdminToken } from '../../../lib/api';
import { initData, tg, useBackButton } from '../../../lib/telegram';
import { Icon, useToast, useWidth, type IconName } from '../../../components/ui';
import { Questions, Topics } from './Analytics';
import { AttemptDetail, Attempts } from './Attempts';
import { Bank, SettingsPage } from './Bank';
import { FILTERS0, type AttemptFilters, type Ctx, type Page } from './common';
import { Login } from './Login';
import { Overview } from './Overview';
import { Reports } from './Reports';
import { Users } from './Users';
import { SheetsDialog } from './Sheets';

const NAV: [Exclude<Page, 'attempt'>, string, string][] = [
  ['overview', 'Overview', 'Overview'], ['attempts', 'Attempts', 'Attempts'], ['questions', 'Questions', 'Questions'],
  ['topics', 'Topics & gaps', 'Topics'], ['reports', 'Reports', 'Reports'], ['users', 'Users', 'Users'], ['bank', 'Question bank', 'Bank'],
  ['settings', 'Settings', 'Settings'],
];

/** `onExit` is set when the console was opened from the CFT Hub: Telegram's back button returns there. */
export function AdminApp({ onExit }: { onExit?: () => void } = {}) {
  const [phase, setPhase] = useState<'checking' | 'login' | 'ready'>('checking');
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [data, setDataState] = useState<AdminData | null>(null);
  const [loadErr, setLoadErr] = useState('');
  // Deep link from bot notifications: #/admin/attempt/<id>
  const deep = /^#\/admin\/attempt\/([0-9a-f-]{36})$/i.exec(location.hash)?.[1] ?? null;
  const [page, setPage] = useState<Page>(deep ? 'attempt' : 'overview');
  const [sel, setSel] = useState<string | null>(deep);
  const [filters, setFiltersState] = useState<AttemptFilters>(FILTERS0);
  const [navOpen, setNavOpen] = useState(false);
  const [sheetsOpen, setSheetsOpen] = useState(false);
  const [toastNode, toast] = useToast();
  const w = useWidth();
  const main = useRef<HTMLElement>(null);

  const signOutLocal = useCallback((msg = '') => {
    setAdminToken('');
    setDataState(null);
    setNotice(msg);
    setPhase('login');
  }, []);

  const onError = useCallback((e: unknown) => {
    const err = e as ApiError;
    if (err.status === 401) signOutLocal('Your session has expired. Sign in again.');
    else toast(err.message);
  }, [signOutLocal, toast]);

  const load = useCallback(async () => {
    try {
      setDataState(await adminApi.data());
      setLoadErr('');
    } catch (e) {
      if ((e as ApiError).status === 401) return signOutLocal('Your session has expired. Sign in again.');
      setLoadErr((e as ApiError).message);
    }
  }, [signOutLocal]);

  // Restore a session, or sign in silently with a linked Telegram account.
  useEffect(() => {
    (async () => {
      if (hasAdminToken()) {
        try {
          const me = await adminApi.me();
          setEmail(me.email ?? me.name ?? 'Telegram admin');
          setPhase('ready');
          return load();
        } catch {
          setAdminToken('');
        }
      }
      if (tg) {
        try {
          const s = await adminApi.telegramLogin(initData);
          setAdminToken(s.token);
          setEmail(s.email || tg.initDataUnsafe.user?.first_name || 'Telegram admin');
          setPhase('ready');
          return load();
        } catch {
          /* not a linked admin: fall through to the form */
        }
      }
      setPhase('login');
    })();
  }, [load]);

  // Keep figures fresh while the console is open.
  useEffect(() => {
    if (phase !== 'ready') return;
    const t = window.setInterval(() => document.visibilityState === 'visible' && load(), 60_000);
    const vis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', vis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [phase, load]);

  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [page, sel]);

  const go = useCallback((p: Page, f?: Partial<AttemptFilters>) => {
    if (f) setFiltersState({ ...FILTERS0, ...f });
    setPage(p);
    setSel(null);
    setNavOpen(false);
  }, []);

  useBackButton(phase !== 'ready' ? null : navOpen ? () => setNavOpen(false) : page === 'attempt' ? () => go('attempts') : page !== 'overview' ? () => go('overview') : onExit ?? null);

  if (phase === 'checking') return <div className="center-msg">Loading…</div>;
  if (phase === 'login') {
    return (
      <div className="scroll">
        <Login notice={notice || (tg ? 'Your Telegram account is not an admin. Ask an owner to add you, or sign in with email.' : '')} onSignedIn={(t, e) => { setAdminToken(t); setEmail(e); setNotice(''); setPhase('ready'); setPage('overview'); load(); }} />
      </div>
    );
  }

  const narrow = w < 760;
  const side = w >= 900;
  const current = page === 'attempt' ? 'attempts' : page;
  const signOut = async () => {
    setNavOpen(false);
    await adminApi.logout().catch(() => {});
    signOutLocal('');
  };

  const ctx: Ctx | null = data && {
    data,
    setData: (f) => setDataState((d) => (d ? f(d) : d)),
    w, narrow, go, toast, onError,
    openAttempt: (id) => { setSel(id); setPage('attempt'); setNavOpen(false); },
    openSheets: () => setSheetsOpen(true),
    filters,
    setFilters: (f) => setFiltersState((x) => ({ ...x, ...f })),
  };

  return (
    <div className="shell">
      <div className="liquid" aria-hidden="true">
        <i style={{ left: '-14%', top: '-22%', width: '56%', background: 'radial-gradient(circle,rgba(160,220,255,.16),rgba(160,220,255,0) 66%)' }} />
        <i style={{ right: '-16%', top: '24%', width: '50%', background: 'radial-gradient(circle,rgba(160,220,255,.1),rgba(160,220,255,0) 66%)' }} />
        <i style={{ left: '26%', bottom: '-34%', width: '60%', background: 'radial-gradient(circle,rgba(32,44,51,.9),rgba(32,44,51,0) 66%)' }} />
      </div>
      {side ? (
        <header className="topnav" style={{ position: 'relative' }}>
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 14 }}>
            <img src="/assets/cft-primary.svg" alt="CF Transport" style={{ height: 17, width: 'auto', display: 'block' }} />
            {w >= 1320 && <><span style={{ width: 1, height: 20, background: 'rgba(255,255,255,.14)' }} /><span className="eyebrow nowrap">AGENT ACADEMY · ADMIN</span></>}
          </div>
          <nav aria-label="Admin">
            {NAV.map(([id, label]) => {
              const on = current === id;
              return (
                <button key={id} className="navbtn" aria-current={on ? 'page' : undefined} title={label} aria-label={label} onClick={() => go(id)} style={{ padding: w >= 1180 ? '0 16px' : '0 11px' }}>
                  <Icon name={id as IconName} />
                  {(on || w >= 1440) && <span>{label}</span>}
                </button>
              );
            })}
          </nav>
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 12 }}>
            {w >= 1320 && <span className="muted" style={{ fontSize: 13, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</span>}
            <button className="pill" style={{ height: 38, padding: '0 14px', background: 'transparent' }} onClick={signOut}>Sign out</button>
          </div>
        </header>
      ) : (
        <>
          <div className="mobilebar-wrap">
            <div className="mobilebar">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <img src="/assets/cft-primary.svg" alt="CF Transport" style={{ flex: 'none', height: 14, width: 'auto' }} />
                <span style={{ width: 1, height: 16, background: 'rgba(255,255,255,.14)' }} />
                <span className="eyebrow" style={{ color: 'var(--blue)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', letterSpacing: '.08em' }}>{NAV.find((n) => n[0] === current)?.[2].toUpperCase()}</span>
              </div>
              <button className="burger" onClick={() => setNavOpen(!navOpen)} aria-expanded={navOpen} aria-label={navOpen ? 'Close menu' : 'Open menu'}>
                <span>
                  <i style={{ top: navOpen ? 6 : 0, transform: navOpen ? 'rotate(45deg)' : 'none' }} />
                  <i style={{ top: 6, opacity: navOpen ? 0 : 1, transform: navOpen ? 'scaleX(.2)' : 'none' }} />
                  <i style={{ top: navOpen ? 6 : 12, transform: navOpen ? 'rotate(-45deg)' : 'none' }} />
                </span>
              </button>
            </div>
          </div>
          {navOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setNavOpen(false)} />
              <div className="menu-pop">
                <nav aria-label="Admin" className="stagger" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {NAV.map(([id, label]) => (
                    <button key={id} className="menu-item" aria-current={current === id ? 'page' : undefined} onClick={() => go(id)}>
                      <span className="ib"><Icon name={id as IconName} /></span>
                      <span style={{ flex: 1 }}>{label}</span>
                      <Icon name="right" style={{ opacity: 0.5 }} />
                    </button>
                  ))}
                  <div style={{ height: 1, margin: '6px 8px', background: 'var(--line-2)' }} />
                  <button className="menu-item" style={{ color: 'var(--bad)', fontSize: 14, height: 46 }} onClick={signOut}>
                    <span className="ib" style={{ background: 'rgba(242,139,130,.1)' }}><Icon name="out" /></span>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Sign out · {email}</span>
                  </button>
                </nav>
              </div>
            </>
          )}
        </>
      )}
      <main ref={main} className="admin-main" key={page + (sel ?? '')}>
        {!ctx ? (
          <div className="center-msg">
            {loadErr ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
                <span role="alert" style={{ color: '#fff' }}>{loadErr}</span>
                <button className="pill" onClick={load}>Try again</button>
              </div>
            ) : 'Loading dashboard…'}
          </div>
        ) : (
          <div className="fade-in" style={{ display: 'contents' }}>
            {page === 'overview' && <Overview ctx={ctx} />}
            {page === 'attempts' && <Attempts ctx={ctx} />}
            {page === 'attempt' && sel && <AttemptDetail ctx={ctx} id={sel} />}
            {page === 'questions' && <Questions ctx={ctx} />}
            {page === 'topics' && <Topics ctx={ctx} />}
            {page === 'reports' && <Reports ctx={ctx} />}
            {page === 'users' && <Users ctx={ctx} />}
            {page === 'bank' && <Bank ctx={ctx} />}
            {page === 'settings' && <SettingsPage ctx={ctx} />}
          </div>
        )}
      </main>
      {ctx && sheetsOpen && <SheetsDialog ctx={ctx} onClose={() => setSheetsOpen(false)} />}
      {toastNode}
    </div>
  );
}
