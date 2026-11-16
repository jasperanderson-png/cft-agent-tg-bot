import { useEffect, useState } from 'react';
import type { AcademySummary, AgentsList, DiscountsAdmin, LeadsSummary } from '../../../../../shared/types';
import { hubApi, teamApi, type ApiError } from '../../lib/api';
import { backToChat, haptic, routePageUrl, tg } from '../../lib/telegram';
import { fmtDay, Icon, type IconName } from '../../components/ui';
import { InviteSheet } from './Team';

// The admins' home in the Mini App (design: AdminHome): agents and candidates at a glance, the invite
// button, and one row per section.

const num = (n: number) => n.toLocaleString('en-US');

/** A figure that loads in the background; each card shows its own state. */
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

function NavLink({ icon, title, sub, onClick }: { icon: IconName; title: string; sub: string; onClick: () => void }) {
  return (
    <button type="button" className="a-link" onClick={onClick}>
      <span className="a-link-icon"><Icon name={icon} size={18} /></span>
      <span className="a-link-text"><b>{title}</b><span>{sub}</span></span>
      <Icon name="right" />
    </button>
  );
}

export function Hub({ name }: { name: string }) {
  const agents = useLoad<AgentsList>(teamApi.agents);
  const academy = useLoad<AcademySummary>(hubApi.academy);
  const leads = useLoad<LeadsSummary>(hubApi.leads);
  const discounts = useLoad<DiscountsAdmin>(teamApi.discounts);
  const [inviting, setInviting] = useState(false);

  const weekAgo = Date.now() - 7 * 86_400_000;
  const joinedThisWeek = agents.data?.agents.filter((a) => Date.parse(a.joinedAt) > weekAgo).length ?? 0;
  const d = discounts.data?.dataset;
  const dash = (s: { error?: string }) => (s.error ? '—' : '…');

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
          <button type="button" className="a-invite" onClick={() => { haptic.tap(); setInviting(true); }}><Icon name="userplus" size={15} />Invite agent</button>
        </div>
        <div className="a-stats">
          <button type="button" className="a-stat" onClick={go('#/team')}>
            <span className="a-stat-top"><span className="d-eyebrow">AGENTS</span><span><Icon name="users" /></span></span>
            <b>{agents.data ? num(agents.data.agents.length) : dash(agents)}</b>
            <span>{agents.data ? `${joinedThisWeek} joined this week` : agents.error ?? 'Loading…'}</span>
          </button>
          <button type="button" className="a-stat" onClick={go('#/admin')}>
            <span className="a-stat-top"><span className="d-eyebrow">CANDIDATES</span><span><Icon name="grad" /></span></span>
            <b>{academy.data ? num(academy.data.week.completed) : dash(academy)}</b>
            <span>{academy.data ? `tests this week · ${academy.data.week.passed} passed` : academy.error ?? 'Loading…'}</span>
          </button>
        </div>
        <span className="a-label">MANAGE</span>
        <nav className="a-nav" aria-label="Admin sections">
          <NavLink icon="users" title="Team & access" sub="Agents, invite links, admins" onClick={go('#/team')} />
          <NavLink
            icon="database" title="Fuel discounts data"
            sub={d ? `${num(d.partnerStations)} partner stations · updated ${fmtDay(d.pulledAt)}` : discounts.data ? 'Not loaded yet — update the prices' : 'What agents see'}
            onClick={go('#/data')}
          />
          <NavLink icon="fuel" title="Find discounts" sub="The agents’ screen, with their prices" onClick={go('#/discounts')} />
          <NavLink icon="pin" title="Driver route map" sub="Route, partner stations on the way, navigation" onClick={() => { haptic.tap(); location.assign(routePageUrl()); }} />
          <NavLink icon="grad" title="CFT Academy console" sub="Attempts, analytics, question bank, reports" onClick={go('#/admin')} />
          <NavLink
            icon="truck" title="Driver leads"
            sub={leads.data ? `${num(leads.data.waiting)} new leads waiting · get them in the chat` : 'Recent leads in the chat'}
            onClick={() => (tg ? backToChat() : undefined)}
          />
        </nav>
      </main>
      {inviting && <InviteSheet onClose={() => setInviting(false)} />}
    </div>
  );
}
