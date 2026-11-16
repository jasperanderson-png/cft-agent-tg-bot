import { useCallback, useEffect, useState } from 'react';
import type { AdminUser, AgentInvite, AgentsList } from '../../../../../shared/types';
import { teamApi, type ApiError } from '../../lib/api';
import { haptic, tg, useBackButton } from '../../lib/telegram';
import { fmtDate, fmtDay, Icon, Spinner, useToast } from '../../components/ui';

// Team & access (design: Team, AgentAccess, InviteSheet): agents, candidates and admins; one agent's
// details and removal; single-use invite links with a lifetime the admin picks.

const HOURS: [number, string][] = [[1, '1 hour'], [24, '1 day'], [72, '3 days'], [168, '7 days'], [720, '30 days']];
const initials = (name: string | null) => (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
const mask = (id: number) => { const s = String(id); return s.length > 6 ? `${s.slice(0, 2)}…${s.slice(-4)}` : s; };

type Agent = AgentsList['agents'][number];
type Tab = 'agents' | 'candidates' | 'admins';

export function Team({ onBack }: { onBack: () => void }) {
  const [list, setList] = useState<AgentsList | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('agents');
  const [agent, setAgent] = useState<Agent | null>(null);
  const [inviting, setInviting] = useState(false);
  const [toastNode, toast] = useToast();

  const load = useCallback(() => {
    setError('');
    Promise.all([teamApi.agents(), teamApi.users()]).then(([a, u]) => {
      setList(a);
      setUsers(u);
    }, (e: ApiError) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useBackButton(inviting ? () => { setInviting(false); load(); } : agent ? () => setAgent(null) : onBack);

  if (agent) return <><AgentDetail a={agent} onBack={() => setAgent(null)} onRemoved={() => { setAgent(null); load(); toast('Agent removed'); }} toast={toast} />{toastNode}</>;

  const agentIds = new Set(list?.agents.map((a) => a.telegramUserId));
  const admins = users?.filter((u) => u.admin) ?? [];
  const candidates = users?.filter((u) => !u.admin && !agentIds.has(u.telegramUserId) && (u.candidateName || u.attempts > 0)) ?? [];
  const tabs: [Tab, string][] = [['agents', `Agents ${list?.agents.length ?? ''}`], ['candidates', `Candidates ${users ? candidates.length : ''}`], ['admins', `Admins ${users ? admins.length : ''}`]];

  const revoke = async (id: string) => {
    try {
      await teamApi.revokeInvite(id);
      haptic.success();
      toast('Link turned off');
      load();
    } catch (e) {
      toast((e as ApiError).message);
    }
  };

  return (
    <div className="d-screen">
      <header className="d-head" data-enter>
        <div className="d-head-row">
          {!tg && <button type="button" className="d-back" aria-label="Back to admin home" onClick={onBack}><Icon name="left" /></button>}
          <h1 className="d-h1" style={{ flex: 1 }}>Team &amp; access</h1>
          <button type="button" className="d-back" aria-label="Invite an agent" onClick={() => setInviting(true)}><Icon name="userplus" /></button>
        </div>
        <div className="d-tabs" role="tablist" aria-label="People">
          {tabs.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => { haptic.select(); setTab(k); }}>{label}</button>)}
        </div>
      </header>
      <main className="d-main" data-stagger>
        {error ? (
          <div className="d-empty"><span>{error}</span><button type="button" className="d-pill-sm" onClick={load}>Try again</button></div>
        ) : !list || !users ? (
          <div className="d-sec">{[0, 1, 2, 3, 4].map((i) => <div key={i} data-skel style={{ height: 56, borderRadius: 12 }} />)}</div>
        ) : tab === 'agents' ? (
          <>
            {list.invites.length > 0 && (
              <section className="d-sec">
                <span className="d-eyebrow">ACTIVE INVITE LINKS · {list.invites.length}</span>
                <div className="t-people">
                  {list.invites.map((i) => (
                    <div key={i.id} className="t-person" style={{ cursor: 'default' }}>
                      <span className="d-avatar"><Icon name="link" size={16} /></span>
                      <span className="t-person-text"><b>{i.label ?? 'Invite link'}</b><span>{i.uses} joined · works until {fmtDate(i.expiresAt)}</span></span>
                      <button type="button" className="d-pill-sm" onClick={() => revoke(i.id)}>Turn off</button>
                    </div>
                  ))}
                </div>
              </section>
            )}
            <section className="d-sec">
              <span className="d-eyebrow">AGENTS</span>
              {list.agents.length ? (
                <div className="t-people" data-rows>
                  {list.agents.map((a) => (
                    <button key={a.telegramUserId} type="button" className="t-person" onClick={() => { haptic.tap(); setAgent(a); }}>
                      <span className="d-avatar">{initials(a.name)}</span>
                      <span className="t-person-text"><b>{a.name ?? 'Telegram user'}</b><span>{[a.username && '@' + a.username, `joined ${fmtDay(a.joinedAt)}`].filter(Boolean).join(' · ')}</span></span>
                      <span className="t-tag" title="Fuel discounts">D</span>
                      <Icon name="right" style={{ color: '#666' }} />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="d-empty"><Icon name="userplus" size={22} /><span>No agents yet. Make an invite link and share it: everyone who opens it becomes an agent.</span><button type="button" className="d-cta" onClick={() => setInviting(true)}>Invite agent</button></div>
              )}
              <p className="d-hint">D = Fuel discounts. Agents can only see fuel discounts.</p>
            </section>
          </>
        ) : (
          <section className="d-sec">
            <span className="d-eyebrow">{tab === 'admins' ? 'ADMINS' : 'CANDIDATES'}</span>
            <div className="t-people" data-rows>
              {(tab === 'admins' ? admins : candidates).map((u) => (
                <div key={u.telegramUserId} className="t-person" style={{ cursor: 'default' }}>
                  <span className="d-avatar">{initials(u.name)}</span>
                  <span className="t-person-text">
                    <b>{u.name ?? u.candidateName ?? 'Telegram user'}</b>
                    <span>
                      {tab === 'admins'
                        ? (u.admin!.role === 'owner' ? 'Owner' : 'Admin') + (u.username ? ` · @${u.username}` : '')
                        : u.latest
                          ? u.latest.status === 'completed' ? `${u.latest.passed ? 'Test passed' : 'Below pass mark'} · ${u.latest.correct}/${u.latest.total}` : 'Test in progress'
                          : 'No test yet'}
                    </span>
                  </span>
                </div>
              ))}
              {(tab === 'admins' ? admins : candidates).length === 0 && <div className="d-empty">Nobody here yet.</div>}
            </div>
            {tab === 'candidates' && <p className="d-hint">Results and reviews are in the CFT Academy console.</p>}
          </section>
        )}
      </main>
      {inviting && <InviteSheet onClose={() => { setInviting(false); load(); }} />}
      {toastNode}
    </div>
  );
}

function AgentDetail({ a, onBack, onRemoved, toast }: { a: Agent; onBack: () => void; onRemoved: () => void; toast: (m: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await teamApi.removeAgent(a.telegramUserId);
      haptic.success();
      onRemoved();
    } catch (e) {
      haptic.error();
      toast((e as ApiError).message);
      setBusy(false);
    }
  };
  return (
    <div className="d-screen">
      <header className="d-head" data-enter style={{ borderBottom: 0 }}>
        <div className="d-head-row" style={{ justifyContent: 'flex-start' }}>
          <button type="button" className="d-back" aria-label="Back to team" onClick={onBack}><Icon name="left" /></button>
          <span className="d-eyebrow">AGENT</span>
        </div>
      </header>
      <main className="d-main" data-stagger>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span className="d-avatar lg">{initials(a.name)}</span>
          <div style={{ minWidth: 0 }}>
            <h1 className="d-h1" style={{ fontSize: 30 }}>{a.name ?? 'Telegram user'}</h1>
            <p className="d-hint" style={{ marginTop: 8 }}>{[a.username && '@' + a.username, `Telegram ID ${mask(a.telegramUserId)}`].filter(Boolean).join(' · ')}</p>
          </div>
        </div>
        <div className="t-card">
          <dl className="t-dl">
            <dt>Joined</dt><dd>{fmtDate(a.joinedAt)} · invite link{a.inviteLabel ? ` “${a.inviteLabel}”` : ''}</dd>
            {a.invitedBy && <><dt>Invited by</dt><dd>{a.invitedBy}</dd></>}
            <dt>Last opened</dt><dd>{a.lastSeenAt ? fmtDate(a.lastSeenAt) : '—'}</dd>
          </dl>
        </div>
        <section className="d-sec">
          <span className="d-eyebrow">WHAT THEY CAN USE</span>
          <div className="t-card">
            <div className="t-row">
              <span className="a-link-icon"><Icon name="fuel" size={18} /></span>
              <div><b>Fuel discounts</b><span>Partner-station prices with the CFT discount, in the bot and the app</span></div>
              <span className="t-tag">ON</span>
            </div>
          </div>
        </section>
        <section className="d-sec">
          <span className="d-eyebrow">ROLE</span>
          {confirm ? (
            <div className="t-card">
              <span style={{ fontSize: 14, lineHeight: 1.45 }}>Remove <b>{a.name ?? 'this agent'}</b>? They lose fuel discounts at once. You can invite them again later.</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="t-danger" style={{ flex: 1 }} disabled={busy} onClick={remove}>{busy ? <Spinner size={14} /> : 'Yes, remove'}</button>
                <button type="button" className="d-ghost" style={{ flex: 1 }} onClick={() => setConfirm(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="t-danger" onClick={() => setConfirm(true)}>Remove access</button>
          )}
        </section>
      </main>
    </div>
  );
}

/** Invite to CFT: pick how long the link works, then copy or share it. Anyone with the link can join until then. */
export function InviteSheet({ onClose }: { onClose: () => void }) {
  const [hours, setHours] = useState(168);
  const [label, setLabel] = useState('');
  const [made, setMade] = useState<AgentInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      setMade(await teamApi.invite(hours, label));
      haptic.success();
    } catch (e) {
      haptic.error();
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.link);
      setCopied(true);
      haptic.success();
    } catch {
      setError('Copy did not work here. Long-press the link to copy it.');
    }
  };
  const share = () => {
    if (!made) return;
    const url = `https://t.me/share/url?url=${encodeURIComponent(made.link)}&text=${encodeURIComponent('Join CFT as an agent to see fuel discount prices:')}`;
    if (tg) tg.openTelegramLink(url);
    else window.open(url, '_blank', 'noopener');
  };

  return (
    <>
      <button type="button" className="d-scrim" data-scrim aria-label="Close" onClick={onClose} />
      <section className="d-sheet" data-sheet role="dialog" aria-label="Invite to CFT">
        <span className="d-grip" aria-hidden="true" />
        <div className="d-sheet-head">
          <span className="d-pin"><Icon name="userplus" size={18} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>Invite an agent</h2>
            <p>Anyone who opens this link in Telegram becomes an agent, until it expires or you turn it off.</p>
          </div>
          <button type="button" className="d-back" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        {!made ? (
          <>
            <div className="t-card" style={{ padding: 14 }}>
              <span className="d-eyebrow">ACCESS</span>
              <div className="t-row">
                <span className="a-link-icon"><Icon name="fuel" size={18} /></span>
                <div><b>Fuel discounts</b><span>Agents get this, always on</span></div>
                <span className="t-tag">ON</span>
              </div>
            </div>
            <label className="t-field">
              <span className="d-eyebrow">NAME (OPTIONAL)</span>
              <input className="ctl" value={label} maxLength={80} placeholder="Who is it for? e.g. Sales team" onChange={(e) => setLabel(e.target.value)} />
            </label>
            <div className="t-field">
              <span className="d-eyebrow">LINK WORKS FOR</span>
              <div className="t-seg" role="radiogroup" aria-label="Link works for">
                {HOURS.map(([h, l]) => <button key={h} type="button" role="radio" aria-checked={hours === h} onClick={() => { haptic.select(); setHours(h); }}>{l}</button>)}
              </div>
            </div>
            {error && <p className="err" style={{ margin: 0 }}>{error}</p>}
            <button type="button" className="d-cta" data-sheen disabled={busy} onClick={create}>{busy ? <Spinner size={16} /> : <Icon name="link" />}Create link</button>
          </>
        ) : (
          <>
            <div className="t-link">
              <code>{made.link}</code>
              <button type="button" className="d-back" aria-label="Copy link" onClick={copy}><Icon name={copied ? 'tick' : 'copy'} /></button>
            </div>
            <p className="d-hint">Anyone can join with it{made.label ? ` · ${made.label}` : ''} · until {fmtDate(made.expiresAt)}. You get a message in the bot when someone joins. Turn it off any time in Team &amp; access.</p>
            {error && <p className="err" style={{ margin: 0 }}>{error}</p>}
            <div className="d-stack">
              <button type="button" className="d-cta" onClick={share}><Icon name="send" />Share in Telegram</button>
              <button type="button" className="d-ghost" onClick={() => { setMade(null); setCopied(false); setLabel(''); }}>Make another link</button>
            </div>
          </>
        )}
      </section>
    </>
  );
}
