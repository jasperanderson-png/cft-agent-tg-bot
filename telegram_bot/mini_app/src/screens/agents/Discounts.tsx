import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BRANDS, byPrice, normalize, parseQuery, stateName, titleCase, usd, type AgentDiscounts, type AgentStation, type PartnerBrand } from '../../../../../shared/discounts';
import { discountsApi, type ApiError } from '../../lib/api';
import { haptic, openExternal, routePageUrl, useBackButton } from '../../lib/telegram';
import { fmtDay, Icon, Spinner, useToast } from '../../components/ui';

// Find discounts (agents' home), the results for their picks, a station's details and their profile.
// Ported from the cft-miniapp-design screens DiscountStates, StateStations, StationSheet and Profile.

const MAX_SEND_STATES = 10;
const PER_STATE = 3;
const CHEAPEST_FIRST = 12;
/** Biggest saving first; stations without a discount last; equal savings: the cheaper one first. */
const byDiscount = (a: AgentStation, b: AgentStation) => (b.saving ?? -1) - (a.saving ?? -1) || byPrice(a, b);
const p2 = (n: number) => String(n).padStart(2, '0');
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || 'A';
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const where = (s: AgentStation) => [titleCase(s.city) ? `${titleCase(s.city)}, ${s.state}` : s.state, s.address].filter(Boolean).join(' · ');
const mapsUrl = (s: AgentStation) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([s.name, s.address, titleCase(s.city), s.state].filter(Boolean).join(', '));

function Check({ on }: { on: boolean }) {
  return <span className={'d-check' + (on ? ' on' : '')}>{on && <Icon name="tick" />}</span>;
}

/** The "back to top" button: three chevrons rising. */
function ToTop({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="d-top" data-up aria-label="Back to top" onClick={onClick}>
      <i><Icon name="chevup" /></i><i><Icon name="chevup" /></i><i><Icon name="chevup" /></i>
    </button>
  );
}

function useScrollTop() {
  const ref = useRef<HTMLElement>(null);
  const [show, setShow] = useState(false);
  const onScroll = useCallback((e: React.UIEvent<HTMLElement>) => setShow(e.currentTarget.scrollTop > 220), []);
  const toTop = useCallback(() => ref.current?.scrollTo({ top: 0, behavior: 'smooth' }), []);
  return { ref, show, onScroll, toTop, reset: () => setShow(false) };
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading stations" className="d-sec">
      <div data-skel style={{ width: 120, height: 22, borderRadius: 6 }} />
      <div className="d-brands">{[0, 1, 2, 3].map((i) => <div key={i} data-skel style={{ height: 64, borderRadius: 14 }} />)}</div>
      <div data-skel style={{ width: 100, height: 22, borderRadius: 6, marginTop: 12 }} />
      {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} data-skel style={{ height: 56, borderRadius: 12 }} />)}
    </div>
  );
}

type View = 'pick' | 'results' | 'profile';

export function Discounts({ onBack }: { onBack?: () => void }) {
  const [data, setData] = useState<AgentDiscounts | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('pick');
  const [states, setStates] = useState<string[]>([]);
  const [brands, setBrands] = useState<PartnerBrand[]>([]);
  const [text, setText] = useState('');
  const [station, setStation] = useState<AgentStation | null>(null);
  const [toastNode, toast] = useToast();

  const load = useCallback(() => {
    setError('');
    discountsApi.load().then(setData, (e: ApiError) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  useBackButton(station ? () => setStation(null) : view !== 'pick' ? () => setView('pick') : onBack ?? null);

  const all = data?.stations ?? [];
  const cities = useMemo(() => [...new Set(all.map((s) => s.city?.toUpperCase()).filter((c): c is string => !!c))], [all]);
  const inBrands = (s: AgentStation) => !brands.length || brands.includes(s.brand);
  const inStates = (s: AgentStation) => !states.length || states.includes(s.state);
  const picked = useMemo(() => all.filter((s) => inBrands(s) && inStates(s)).sort(byPrice), [all, brands, states]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="d-screen">
        <main className="d-main"><div className="d-empty"><Icon name="fuel" size={22} /><span>{error}</span><button type="button" className="d-pill-sm" onClick={load}>Try again</button></div></main>
      </div>
    );
  }

  if (view === 'profile' && data) return <Profile me={data.me} pulledAt={data.pulledAt} onBack={() => setView('pick')} />;
  if (view === 'results' && data) {
    return (
      <>
        <Results
          stations={picked} states={states} brands={brands} pulledAt={data.pulledAt}
          onEdit={() => setView('pick')} onOpen={setStation} toast={toast}
        />
        {station && <StationSheet s={station} pulledAt={data.pulledAt} onClose={() => setStation(null)} toast={toast} />}
        {toastNode}
      </>
    );
  }

  return (
    <>
      <Picker
        ready={!!data} pulledAt={data?.pulledAt ?? null} all={all} cities={cities} states={states} brands={brands} text={text} picked={picked}
        setStates={setStates} setBrands={setBrands} setText={setText}
        onShow={() => setView('results')} toast={toast}
        head={(
          <>
            <div className="d-head-row">
              <img src="/assets/cft-primary.svg" alt="CF Transport" className="d-logo" />
              <button type="button" className="d-sq" style={{ marginLeft: 'auto', marginRight: 8 }} aria-label="Driver route map" title="Route map" onClick={() => { haptic.tap(); location.assign(routePageUrl()); }}><Icon name="pin" size={18} /></button>
              {data && (
                <button type="button" className="d-me" aria-label="Your profile" onClick={() => setView('profile')}>
                  <span>{data.me.name}</span>
                  <span className="d-avatar">{initials(data.me.name)}</span>
                </button>
              )}
            </div>
            <h1 className="d-h1">Find discounts</h1>
          </>
        )}
      />
      {toastNode}
    </>
  );
}

// ---- Find discounts ------------------------------------------------------------------------------

/**
 * The state and brand picker (shared: agents' Find discounts, drivers' By state on the route map).
 * `head` is what sits above the search: the agents' logo, title and profile, or the drivers' tabs.
 */
export function Picker(p: {
  ready: boolean; pulledAt: string | null; head: ReactNode; className?: string;
  all: AgentStation[]; cities: string[]; states: string[]; brands: PartnerBrand[]; text: string; picked: AgentStation[];
  setStates: (f: (s: string[]) => string[]) => void; setBrands: (f: (b: PartnerBrand[]) => PartnerBrand[]) => void; setText: (t: string) => void;
  onShow: () => void; toast: (m: string) => void;
}) {
  const { all, states, brands, text } = p;
  const scroll = useScrollTop();
  const toggle = <T,>(set: (f: (x: T[]) => T[]) => void, v: T) => () => {
    haptic.select();
    set((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
  };

  const count = (f: (s: AgentStation) => boolean) => all.filter(f).length;
  const codes = useMemo(() => [...new Set(all.map((s) => s.state))].sort((a, b) => stateName(a).localeCompare(stateName(b))), [all]);
  const parsed = useMemo(() => (text.trim() ? parseQuery(text, p.cities) : null), [text, p.cities]);
  const q = normalize(text);
  const visible = q ? codes.filter((c) => normalize(stateName(c)).includes(q) || c.toLowerCase() === q || parsed?.states.includes(c)) : codes;
  const ordered = [...visible.filter((c) => states.includes(c)), ...visible.filter((c) => !states.includes(c))];
  const min = p.picked.length ? p.picked[0].price : null;

  /** Enter: every state and brand the text names is ticked ("calorado, yuta, pilot"). */
  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    if (!parsed) return;
    const st = parsed.states.filter((c) => codes.includes(c));
    if (!st.length && !parsed.brands.length) {
      p.toast(parsed.states.length ? `No partner stations in ${parsed.states.map(stateName).join(', ')}` : 'No state or station found in that text');
      haptic.error();
      return;
    }
    p.setStates((cur) => [...cur, ...st.filter((c) => !cur.includes(c))]);
    p.setBrands((cur) => [...cur, ...parsed.brands.filter((b) => !cur.includes(b))]);
    p.setText('');
    haptic.success();
  };

  return (
    <div className={'d-screen' + (p.className ? ' ' + p.className : '')}>
      <header className="d-head" data-enter>
        {p.head}
        <form className="d-search" onSubmit={apply}>
          <label>
            <span className="sr-only">Type states or stations</span>
            <Icon name="search" />
            <input type="text" enterKeyHint="done" value={text} onChange={(e) => p.setText(e.target.value)} placeholder="Type states or stations" autoComplete="off" />
          </label>
          <button type="button" className={'d-sq' + (text ? ' on' : '')} aria-label="Clear search and show all states" onClick={() => p.setText('')}><Icon name="x" size={18} /></button>
        </form>
      </header>

      <main className="d-main" data-stagger ref={scroll.ref} onScroll={scroll.onScroll}>
        {!p.ready ? <Skeleton /> : !p.pulledAt ? (
          <div className="d-empty"><Icon name="fuel" size={22} /><span>Fuel discounts are not loaded yet. An admin needs to update the prices first.</span></div>
        ) : (
          <>
            {parsed && (parsed.states.length > 0 || parsed.brands.length > 0) && (
              <p className="d-hint">Press <b>Enter</b> to tick {[...parsed.states.map(stateName), ...parsed.brands.map((b) => BRANDS.find((x) => x.id === b)!.label)].join(', ')}.</p>
            )}
            <section className="d-sec">
              <div className="d-sec-head">
                <Icon name="fuel" />
                <h2>Stations</h2>
                <span>{brands.length ? `${brands.length} of 4` : 'All 4'}</span>
              </div>
              <div className="d-brands" data-rows>
                {BRANDS.map((b) => {
                  const on = brands.includes(b.id);
                  return (
                    <button key={b.id} type="button" className={'d-brand' + (on ? ' on' : '')} aria-pressed={on} onClick={toggle(p.setBrands, b.id)}>
                      <span className="d-brand-icon"><Icon name="fuel" /></span>
                      <span className="d-brand-text"><b>{b.label}</b><span>{count((s) => s.brand === b.id && (!states.length || states.includes(s.state)))} stations</span></span>
                      <Check on={on} />
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="d-sec">
              <div className="d-sec-head">
                <Icon name="map" />
                <h2>States</h2>
                {states.length > 0 && <button type="button" className="d-pill-sm" onClick={() => p.setStates(() => [])}>Clear {states.length}</button>}
              </div>
              {ordered.length ? (
                <ul className="d-list" data-rows>
                  {ordered.map((c) => {
                    const on = states.includes(c);
                    return (
                      <li key={c}>
                        <button type="button" className={'d-state' + (on ? ' on' : '')} aria-pressed={on} onClick={toggle(p.setStates, c)}>
                          <span className="d-state-icon"><Icon name="pin" /></span>
                          <span className="d-state-name">{stateName(c)} <span>({c})</span></span>
                          <span className="d-state-count">{count((s) => s.state === c && (!brands.length || brands.includes(s.brand)))}</span>
                          <Check on={on} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="d-empty">No partner stations in a state named like that.</div>
              )}
            </section>
          </>
        )}
      </main>

      <div className="d-foot">
        <div className="d-total">
          <b>{p.picked.length.toLocaleString('en-US')} stations</b>
          <span>{min != null ? `from ${usd(min)} / gal` : '—'}</span>
        </div>
        <button type="button" className="d-cta" data-sheen disabled={!p.picked.length} onClick={() => { haptic.tap(); p.onShow(); }}>
          Show<Icon name="right" />
        </button>
        {scroll.show && <ToTop onClick={scroll.toTop} />}
      </div>
    </div>
  );
}

// ---- Results -------------------------------------------------------------------------------------

/** The result list (shared). `foot` replaces the agents' Send list / Excel buttons (drivers have none). */
export function Results(p: {
  stations: AgentStation[]; states: string[]; brands: PartnerBrand[]; pulledAt: string | null; className?: string;
  onEdit: () => void; onOpen: (s: AgentStation) => void; toast: (m: string) => void; foot?: ReactNode; hint?: string;
}) {
  const [tab, setTab] = useState<'state' | 'cheap' | 'discount'>('state');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<'' | 'send' | 'excel'>('');
  const scroll = useScrollTop();
  const savings = p.stations.map((s) => s.saving).filter((x): x is number => x != null);
  const avgSaving = avg(savings);
  const sendStates = [...new Set(p.stations.map((s) => s.state))];

  const groups = useMemo(() => {
    const m = new Map<string, AgentStation[]>();
    for (const s of p.stations) m.set(s.state, [...(m.get(s.state) ?? []), s]);
    const order = p.states.length ? p.states.filter((c) => m.has(c)) : [...m.keys()].sort((a, b) => stateName(a).localeCompare(stateName(b)));
    return order.map((code) => ({ code, rows: m.get(code)! }));
  }, [p.stations, p.states]);
  // p.stations already comes cheapest first (by the agent's price after the discount).
  const flat = useMemo(() => (tab === 'discount' ? [...p.stations].sort(byDiscount) : p.stations), [p.stations, tab]);

  const run = async (kind: 'send' | 'excel') => {
    if (kind === 'send' && sendStates.length > MAX_SEND_STATES) {
      haptic.error();
      p.toast(`Pick up to ${MAX_SEND_STATES} states to send the list to the chat`);
      return;
    }
    setBusy(kind);
    try {
      const picks = { states: sendStates, brands: p.brands };
      const r = kind === 'send' ? await discountsApi.sendList(picks) : await discountsApi.excel(picks);
      haptic.success();
      p.toast(kind === 'send' ? `Sent ${r.sent} stations to your chat — forward them to the driver` : 'Excel file sent to your chat');
    } catch (e) {
      haptic.error();
      p.toast((e as ApiError).message);
    } finally {
      setBusy('');
    }
  };

  const row = (s: AgentStation) => (
    <li key={s.id}>
      <button type="button" className="d-row" onClick={() => { haptic.tap(); p.onOpen(s); }}>
        <span className="d-row-text"><b>{s.name}</b><span>{where(s)}</span></span>
        <span className="d-row-price">
          <span><b>{usd(s.price)}</b>{s.saving != null && s.retail != null ? <s>{usd(s.retail)}</s> : <s style={{ textDecoration: 'none' }}>retail</s>}</span>
          <span className={'d-save' + (s.saving == null ? ' none' : '')}>{s.saving != null ? `−${usd(s.saving)}` : 'no disc.'}</span>
        </span>
      </button>
    </li>
  );

  return (
    <div className={'d-screen' + (p.className ? ' ' + p.className : '')}>
      <header className="d-head" data-enter>
        <div className="d-head-row">
          <button type="button" className="d-back" aria-label="Back to the picker" onClick={p.onEdit}><Icon name="left" /></button>
          <div className="d-title">
            <h1>{p.stations.length.toLocaleString('en-US')} stations</h1>
            <span>{p.stations.length ? `from ${usd(p.stations[0].price)}` : ''}{avgSaving != null ? ` · avg saving ${usd(Math.round(avgSaving * 1000) / 1000)} / gal` : ''}</span>
          </div>
          <button type="button" className="d-edit" onClick={p.onEdit}>Edit</button>
        </div>
        <div className="d-chips">
          {(p.brands.length ? BRANDS.filter((b) => p.brands.includes(b.id)) : [{ id: 'all', label: 'All partner brands' }]).map((b) => <span key={b.id} className="d-chip">{b.label}</span>)}
          <span className="d-chip plain">{p.states.length ? p.states.join(' · ') : 'All states'}</span>
        </div>
        <div className="d-tabs" role="tablist" aria-label="View">
          {([['state', 'By state'], ['cheap', 'Cheapest'], ['discount', 'Biggest discount']] as const).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => { haptic.select(); setTab(k); }}>{label}</button>
          ))}
        </div>
      </header>

      <main className="d-results" data-stagger ref={scroll.ref} onScroll={scroll.onScroll}>
        {tab === 'state'
          ? groups.map((g) => {
              const isOpen = !!open[g.code];
              const sv = avg(g.rows.map((r) => r.saving).filter((x): x is number => x != null));
              return (
                <section key={g.code} className="d-group">
                  <div className="d-group-head">
                    <span className="d-code">{g.code}</span>
                    <b>{stateName(g.code)}</b>
                    <span>{g.rows.length} station{g.rows.length === 1 ? '' : 's'}{sv != null ? ` · avg −${usd(Math.round(sv * 100) / 100)}` : ''}</span>
                  </div>
                  <ul className="d-rows" data-rows>{(isOpen ? g.rows : g.rows.slice(0, PER_STATE)).map(row)}</ul>
                  {g.rows.length > PER_STATE && (
                    <button type="button" className="d-more" onClick={() => setOpen({ ...open, [g.code]: !isOpen })}>
                      {isOpen ? 'Show less' : `Show all ${g.rows.length} in ${stateName(g.code)}`}
                    </button>
                  )}
                </section>
              );
            })
          : (
            <section className="d-group">
              <ul className="d-rows" data-rows>{(open[tab] ? flat : flat.slice(0, CHEAPEST_FIRST)).map(row)}</ul>
              {flat.length > CHEAPEST_FIRST && (
                <button type="button" className="d-more" onClick={() => setOpen({ ...open, [tab]: !open[tab] })}>
                  {open[tab] ? 'Show less' : `Show all ${p.stations.length.toLocaleString('en-US')} stations`}
                </button>
              )}
            </section>
          )}
        {p.pulledAt && <p className="d-hint" style={{ padding: '18px 0 4px' }}>Prices per gallon with the CFT discount · updated {fmtDay(p.pulledAt)}. {p.hint ?? 'Tap a station for the address and map.'}</p>}
      </main>

      {p.foot !== undefined ? (
        (p.foot || scroll.show) && <div className="d-foot">{p.foot}{scroll.show && <ToTop onClick={scroll.toTop} />}</div>
      ) : (
        <div className="d-foot">
          <button type="button" className="d-cta wide" data-sheen disabled={!!busy || !p.stations.length} onClick={() => run('send')}>
            {busy === 'send' ? <Spinner size={16} /> : <Icon name="send" />}Send list to chat
          </button>
          <button type="button" className="d-ghost" disabled={!!busy || !p.stations.length} onClick={() => run('excel')}>
            {busy === 'excel' ? <Spinner size={16} /> : <Icon name="download" size={15} />}Excel
          </button>
          {scroll.show && <ToTop onClick={scroll.toTop} />}
        </div>
      )}
    </div>
  );
}

// ---- Station details -----------------------------------------------------------------------------

/** A station's details (shared). `actions` replaces the agents' Google Maps / Send buttons. */
export function StationSheet({ s, onClose, toast, actions }: { s: AgentStation; pulledAt: string | null; onClose: () => void; toast: (m: string) => void; actions?: ReactNode }) {
  const [sending, setSending] = useState(false);
  const updated = s.updatedAt ? new Date(s.updatedAt) : null;
  const send = async () => {
    setSending(true);
    try {
      await discountsApi.sendStation(s.id);
      haptic.success();
      toast('Sent to your chat — forward it to the driver');
    } catch (e) {
      haptic.error();
      toast((e as ApiError).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <>
      <button type="button" className="d-scrim" data-scrim aria-label="Close details" onClick={onClose} />
      <section className="d-sheet" data-sheet role="dialog" aria-label={`${s.name}, ${titleCase(s.city)}`}>
        <span className="d-grip" aria-hidden="true" />
        <div className="d-sheet-head">
          <span className="d-pin"><Icon name="pin" size={18} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{s.name}</h2>
            <p>{[s.address, titleCase(s.city), s.state].filter(Boolean).join(', ')}{s.exit ? <><br />{s.exit}</> : null}</p>
          </div>
          <button type="button" className="d-back" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="d-pricecard">
          <img src="/assets/glow-blue.png" alt="" data-glow />
          <div>
            <span className="d-eyebrow">YOUR PRICE</span>
            <b className="d-bigprice">{usd(s.price)}</b>
            <span style={{ display: 'block', marginTop: 8, fontSize: 13, color: 'var(--muted)' }}>{s.saving != null ? 'per gallon, with CFT discount' : 'per gallon, retail (no discount)'}</span>
          </div>
          {s.saving != null && s.retail != null && (
            <dl>
              <dt>Retail</dt><dd><s>{usd(s.retail)}</s></dd>
              <dt>Saving</dt><dd style={{ color: 'var(--blue)', fontWeight: 600 }}>{usd(s.saving)}</dd>
            </dl>
          )}
        </div>
        <div className="d-tiles">
          <div className="d-tile">
            <b>{s.saving != null ? '$' + (s.saving * 150).toFixed(2) : '—'}</b>
            <span>saved on a 150 gal fill</span>
          </div>
          <div className="d-tile">
            <b>{updated ? `${p2(updated.getHours())}:${p2(updated.getMinutes())}` : '—'}</b>
            <span>{updated ? `price changed ${fmtDay(s.updatedAt)}` : 'price update time unknown'}</span>
          </div>
        </div>
        <div className="d-stack">
          {actions ?? (
            <>
              <button type="button" className="d-cta" onClick={() => openExternal(mapsUrl(s))}><Icon name="ext" />Open in Google Maps</button>
              <button type="button" className="d-ghost" disabled={sending} onClick={send}>{sending ? <Spinner size={16} /> : <Icon name="send" />}Send to a driver</button>
            </>
          )}
        </div>
      </section>
    </>
  );
}

// ---- Profile -------------------------------------------------------------------------------------

function Profile({ me, pulledAt, onBack }: { me: AgentDiscounts['me']; pulledAt: string | null; onBack: () => void }) {
  return (
    <div className="d-screen">
      <img src="/assets/glow-blue.png" alt="" data-glow className="a-glow" />
      <header className="d-head" data-enter style={{ position: 'relative', borderBottom: 0 }}>
        <div className="d-head-row" style={{ justifyContent: 'flex-start' }}>
          <button type="button" className="d-back" aria-label="Back to discounts" onClick={onBack}><Icon name="left" /></button>
          <span className="d-eyebrow">PROFILE</span>
        </div>
      </header>
      <main className="d-main" data-stagger style={{ position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span className="d-avatar lg">{initials(me.name)}</span>
          <div style={{ minWidth: 0 }}>
            <h1 className="d-h1" style={{ fontSize: 32 }}>{me.name}</h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 14, color: 'var(--soft)' }}>
              {me.username && <span>@{me.username}</span>}
              <span className="t-tag">{me.role === 'admin' ? 'ADMIN' : 'AGENT'}</span>
            </div>
          </div>
        </div>
        <div className="t-card">
          <dl className="t-dl">
            {me.since && <><dt>Member since</dt><dd>{fmtDay(me.since)}</dd></>}
            {me.invitedBy && <><dt>Invited by</dt><dd>{me.invitedBy}</dd></>}
            <dt>Prices updated</dt><dd>{pulledAt ? fmtDay(pulledAt) : '—'}</dd>
          </dl>
        </div>
        <div className="t-card">
          <div className="t-note"><Icon name="info" /><span>You can also search in the chat: type a state or a station (for example “nebraska” or “texas pilot”) and the bot answers with a table to forward to the driver.</span></div>
        </div>
      </main>
    </div>
  );
}
