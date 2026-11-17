import { useEffect, useState } from 'react';
import type { AcademySummary, AgentsList, DiscountsAdmin, DriverWithTrips, LeadsSummary } from '../../../../../shared/types';
import { driversApi, hubApi, teamApi, type ApiError } from '../../lib/api';
import { backToChat, haptic, loadSetting, routePageUrl, saveSetting, tg, useBackButton } from '../../lib/telegram';
import { fmtDay, Icon, type IconName } from '../../components/ui';
import { InviteSheet } from './Team';

// The admins' home in the Mini App (design: AdminHome). Up to four tools the admin picked sit on top as
// big tiles with a live figure; the rest are in a short "More" list. "Customize home" picks and orders
// the tiles; the choice is saved per admin (Telegram CloudStorage, see lib/telegram.ts → saveSetting).
// New driver leads show as one strip on top, since they are the thing that needs action.

const num = (n: number) => n.toLocaleString('en-US');
const SETTING = 'admin_home_tiles_v1';
const MAX_TILES = 4;

type ToolId = 'team' | 'data' | 'drivers' | 'academy' | 'leads' | 'find' | 'map';
const DEFAULT_TILES: ToolId[] = ['team', 'data', 'drivers', 'academy'];
const ALL: ToolId[] = ['team', 'data', 'drivers', 'academy', 'leads', 'find', 'map'];

/** A figure that loads in the background; each tile shows its own state. */
function useLoad<T>(load: () => Promise<T>) {
  const [s, setS] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    let live = true;
    load().then((data) => live && setS({ data }), (e: ApiError) => live && setS({ error: e.message }));
    return () => {
      live = false;
    };
  }, [load]);
  return s;
}

const go = (hash: string) => () => {
  haptic.tap();
  location.hash = hash;
};

interface Tool {
  icon: IconName;
  title: string;
  /** Big figure on the tile ('' = none), its unit, and the line under the title. */
  big: string;
  unit: string;
  sub: string;
  open: () => void;
}

function parseTiles(raw: string | null): ToolId[] {
  try {
    const v = JSON.parse(raw ?? '');
    if (Array.isArray(v)) {
      const ids = v.filter((x): x is ToolId => ALL.includes(x)).slice(0, MAX_TILES);
      return [...new Set(ids)];
    }
  } catch {
    /* not set yet */
  }
  return DEFAULT_TILES;
}

export function Hub({ name }: { name: string }) {
  const agents = useLoad<AgentsList>(teamApi.agents);
  const academy = useLoad<AcademySummary>(hubApi.academy);
  const leads = useLoad<LeadsSummary>(hubApi.leads);
  const discounts = useLoad<DiscountsAdmin>(teamApi.discounts);
  const drivers = useLoad<{ drivers: DriverWithTrips[] }>(driversApi.list);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [leadsHidden, setLeadsHidden] = useState(false);
  const [tiles, setTiles] = useState<ToolId[] | null>(null);

  useEffect(() => {
    let live = true;
    loadSetting(SETTING).then((raw) => live && setTiles(parseTiles(raw)));
    return () => {
      live = false;
    };
  }, []);
  const pick = (next: ToolId[]) => {
    setTiles(next);
    saveSetting(SETTING, JSON.stringify(next));
  };
  useBackButton(editing ? () => setEditing(false) : null);

  const weekAgo = Date.now() - 7 * 86_400_000;
  const joinedThisWeek = agents.data?.agents.filter((a) => Date.parse(a.joinedAt) > weekAgo).length ?? 0;
  const d = discounts.data?.dataset;
  const activeDrivers = drivers.data?.drivers.filter((x) => !x.removed) ?? [];
  const tripsThisWeek = activeDrivers.filter((x) => x.lastTripAt && Date.parse(x.lastTripAt) > weekAgo).length;
  const fig = (s: { error?: string }) => (s.error ? '—' : '…');
  const waiting = leads.data?.waiting ?? 0;

  const tools: Record<ToolId, Tool> = {
    team: {
      icon: 'users', title: 'Team & access',
      big: agents.data ? num(agents.data.agents.length) : fig(agents), unit: 'agents',
      sub: agents.data ? `${joinedThisWeek} joined this week` : agents.error ?? 'Agents, invite links, admins',
      open: go('#/team'),
    },
    data: {
      icon: 'database', title: 'Fuel discounts',
      big: d ? num(d.partnerStations) : fig(discounts), unit: 'stations',
      sub: d ? `updated ${fmtDay(d.pulledAt)}` : discounts.data ? 'Not loaded yet — update the prices' : discounts.error ?? 'What agents see',
      open: go('#/data'),
    },
    drivers: {
      icon: 'truck', title: 'Drivers',
      big: drivers.data ? num(activeDrivers.length) : fig(drivers), unit: 'drivers',
      sub: drivers.data ? `${tripsThisWeek} drove this week` : drivers.error ?? 'Trips, fuel stops, proof',
      open: go('#/drivers'),
    },
    academy: {
      icon: 'grad', title: 'Academy',
      big: academy.data ? num(academy.data.week.completed) : fig(academy), unit: 'tests',
      sub: academy.data ? `this week · ${academy.data.week.passed} passed` : academy.error ?? 'Attempts, analytics, reports',
      open: go('#/admin'),
    },
    leads: {
      icon: 'send', title: 'Driver leads',
      big: leads.data ? num(waiting) : fig(leads), unit: 'new',
      sub: 'waiting in the chat',
      open: () => (tg ? backToChat() : undefined),
    },
    find: { icon: 'fuel', title: 'Find discounts', big: '', unit: '', sub: 'The agents’ screen, with their prices', open: go('#/discounts') },
    map: {
      icon: 'pin', title: 'Route map', big: '', unit: '', sub: 'The drivers’ screen',
      open: () => { haptic.tap(); location.assign(routePageUrl()); },
    },
  };

  if (editing && tiles) {
    return <Customize tiles={tiles} tools={tools} onChange={pick} onDone={() => { haptic.tap(); setEditing(false); }} />;
  }

  const pinned = tiles ?? [];
  const rest = ALL.filter((id) => !pinned.includes(id));

  return (
    <div className="d-screen">
      <img src="/assets/glow-blue.png" alt="" data-glow className="a-glow" />
      <div className="a-bar-wrap">
        <div className="a-bar">
          <img src="/assets/cft-primary.svg" alt="CF Transport" className="d-logo" />
          <span className="a-badge"><Icon name="shield" size={14} />Admin</span>
        </div>
      </div>
      <main className="a-main" data-stagger>
        <div className="a-hello">
          <h1>Hi, {name}</h1>
          <button type="button" className="a-invite" onClick={() => { haptic.tap(); setInviting(true); }}><Icon name="userplus" size={15} />Invite</button>
        </div>

        {waiting > 0 && !leadsHidden && (
          <div className="a-alert" role="status">
            <Icon name="send" size={18} />
            <span><b>{num(waiting)} new driver {waiting === 1 ? 'lead' : 'leads'}</b> waiting in the chat</span>
            {tg && <button type="button" className="a-alert-go" onClick={() => backToChat()}>Open</button>}
            <button type="button" className="a-alert-x" aria-label="Hide" onClick={() => setLeadsHidden(true)}><Icon name="x" size={14} /></button>
          </div>
        )}

        {tiles === null ? (
          <div className="a-tiles" aria-busy="true">{DEFAULT_TILES.map((id) => <div key={id} className="a-tile skel" />)}</div>
        ) : pinned.length ? (
          <div className="a-tiles">
            {pinned.map((id) => {
              const t = tools[id];
              return (
                <button key={id} type="button" className="a-tile" onClick={t.open}>
                  <span className="a-tile-icon"><Icon name={t.icon} size={18} /></span>
                  {t.big ? (
                    <span className="a-tile-fig"><b>{t.big}</b><span>{t.unit}</span></span>
                  ) : (
                    <span className="a-tile-fig"><Icon name="arrow" size={22} /></span>
                  )}
                  <b className="a-tile-title">{t.title}</b>
                  <span className="a-tile-sub">{t.sub}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <button type="button" className="a-tiles-empty" onClick={() => setEditing(true)}>Nothing pinned. Tap to choose your shortcuts.</button>
        )}

        {tiles !== null && rest.length > 0 && (
          <>
            <span className="a-label">MORE</span>
            <nav className="a-nav" aria-label="More admin sections">
              {rest.map((id) => {
                const t = tools[id];
                return (
                  <button key={id} type="button" className="a-link" onClick={t.open}>
                    <span className="a-link-icon"><Icon name={t.icon} size={18} /></span>
                    <span className="a-link-text"><b>{t.title}</b><span>{t.big && t.big !== '…' && t.big !== '—' ? `${t.big} ${t.unit} · ` : ''}{t.sub}</span></span>
                    <Icon name="right" />
                  </button>
                );
              })}
            </nav>
          </>
        )}

        {tiles !== null && (
          <button type="button" className="a-customize" onClick={() => { haptic.tap(); setEditing(true); }}><Icon name="settings" size={15} />Customize home</button>
        )}
      </main>
      {inviting && <InviteSheet onClose={() => setInviting(false)} />}
    </div>
  );
}

function Customize({ tiles, tools, onChange, onDone }: { tiles: ToolId[]; tools: Record<ToolId, Tool>; onChange: (t: ToolId[]) => void; onDone: () => void }) {
  const full = tiles.length >= MAX_TILES;
  const order = [...tiles, ...ALL.filter((id) => !tiles.includes(id))];
  const toggle = (id: ToolId) => {
    haptic.select();
    if (tiles.includes(id)) onChange(tiles.filter((x) => x !== id));
    else if (!full) onChange([...tiles, id]);
  };
  const move = (id: ToolId, by: -1 | 1) => {
    const i = tiles.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= tiles.length) return;
    haptic.select();
    const next = tiles.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="d-screen">
      <main className="a-main a-custom" data-stagger>
        <div>
          <h1 className="a-custom-h">Customize home</h1>
          <p className="a-custom-p">Pick up to {MAX_TILES} tools for the big tiles and put them in order. Everything else goes under “More”.</p>
        </div>
        <span className="a-label">{tiles.length} OF {MAX_TILES} ON YOUR HOME</span>
        <div className="a-nav a-custom-list">
          {order.map((id) => {
            const on = tiles.includes(id);
            const pos = tiles.indexOf(id);
            const t = tools[id];
            return (
              <div key={id} className={'a-custom-row' + (on ? '' : full ? ' off full' : ' off')}>
                <button type="button" role="switch" aria-checked={on} className="a-custom-pick" onClick={() => toggle(id)}
                  aria-label={`${on ? 'Remove' : 'Add'} ${t.title} ${on ? 'from' : 'to'} your home`}>
                  <span className="a-custom-box">{on && <Icon name="tick" size={13} />}</span>
                  <span className="a-custom-icon"><Icon name={t.icon} size={16} /></span>
                  <span className="a-link-text"><b>{t.title}</b><span>{on ? `On home · position ${pos + 1}` : full ? 'Home is full — remove one first' : 'In “More”'}</span></span>
                </button>
                {on && (
                  <>
                    <button type="button" className="a-custom-move" aria-label={`Move ${t.title} up`} disabled={pos === 0} onClick={() => move(id, -1)}><Icon name="up" size={16} /></button>
                    <button type="button" className="a-custom-move" aria-label={`Move ${t.title} down`} disabled={pos === tiles.length - 1} onClick={() => move(id, 1)}><Icon name="down" size={16} /></button>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div className="a-custom-foot">
          <button type="button" className="a-custom-reset" onClick={() => { haptic.tap(); onChange(DEFAULT_TILES); }}>Reset</button>
          <button type="button" className="a-custom-done" onClick={onDone}>Done</button>
        </div>
        <p className="a-custom-note">Saved for you only. Other admins keep their own home.</p>
      </main>
    </div>
  );
}
