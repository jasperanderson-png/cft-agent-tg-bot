import { useMemo, useRef, useState } from 'react';
import type { DriverStation } from '../../../../../shared/types';
import { BRAND_ORDER, BRANDS, payPrice, STATE_NAMES, type DriverBrand } from '../../../../../shared/driverRoute';
import { Icon } from '../../components/ui';
import { haptic, useBackButton } from '../../lib/telegram';
import { money, placeOf, StationCard, updated } from './pieces';

// "By state" on the drivers' map: the same picker and result list as the agents' Find discounts
// (built from the same .d-* parts), with "Route here" on a station.

export function ByState({ stations, fetchedAt, routing, onRouteTo, onMyRoute }: {
  stations: DriverStation[] | null;
  fetchedAt: string | null;
  routing: boolean;
  onRouteTo: (s: DriverStation) => void;
  onMyRoute: () => void;
}) {
  const [q, setQ] = useState('');
  const [br, setBr] = useState<DriverBrand[]>([]);
  const [picks, setPicks] = useState<string[]>([]);
  const [showRes, setShowRes] = useState(false);
  const [resView, setResView] = useState<'state' | 'cheap' | 'discount'>('state');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [stSel, setStSel] = useState<number | null>(null);
  const [showTop, setShowTop] = useState(false);
  const scrollRef = useRef<HTMLElement>(null);
  const states = useMemo(() => {
    const all = [...new Set((stations ?? []).map((s) => s.state).filter((s): s is string => !!s && !!STATE_NAMES[s]))];
    return all.sort((a, b) => STATE_NAMES[a].localeCompare(STATE_NAMES[b]));
  }, [stations]);
  const brandsOn = br.length ? br : BRAND_ORDER;
  const inStates = picks.length ? picks : states;
  const rows = useMemo(() => (stations ?? []).filter((s) => brandsOn.includes(s.brand) && s.state && inStates.includes(s.state)), [stations, brandsOn, inStates]);
  const total = rows.length;
  const saves = rows.filter((x) => x.retail != null && x.discounted != null).map((x) => x.retail! - x.discounted!);
  const avgSave = saves.length ? saves.reduce((t, v) => t + v, 0) / saves.length : null;
  const minPrice = rows.reduce<number | null>((m, s) => { const p = payPrice(s); return p == null ? m : m == null ? p : Math.min(m, p); }, null);
  const countFor = (codes: string[], brands: DriverBrand[]) => (stations ?? []).filter((s) => s.state && codes.includes(s.state) && brands.includes(s.brand)).length;
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const stSelStation = stSel != null ? stations?.find((s) => s.id === stSel) ?? null : null;

  // Telegram's back button: the open station, then the results, then back to the map.
  useBackButton(() => {
    if (stSel != null) setStSel(null);
    else if (showRes) setShowRes(false);
    else onMyRoute();
  });

  return (
        <div className="d-screen dm-bystate">
    <header className="d-head">
      {!showRes ? (
        <>
          <div className="d-tabs" role="tablist" aria-label="Find fuel">
            <button type="button" role="tab" aria-selected={false} onClick={() => { haptic.select(); onMyRoute(); }}>My route</button>
            <button type="button" role="tab" aria-selected>By state</button>
          </div>
          <form className="d-search" onSubmit={(e) => { e.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); }}>
            <label>
              <span className="sr-only">Search states</span>
              <Icon name="search" />
              <input type="text" enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search states" autoComplete="off" />
            </label>
            <button type="button" className={'d-sq' + (q ? ' on' : '')} aria-label="Clear search" onClick={() => setQ('')}><Icon name="x" size={18} /></button>
          </form>
        </>
      ) : (
        <>
          <div className="d-head-row">
            <button type="button" className="d-back" aria-label="Back to the picker" onClick={() => { setShowRes(false); setStSel(null); }}><Icon name="left" /></button>
            <div className="d-title">
              <h1>{total.toLocaleString('en-US')} stations</h1>
              <span>{minPrice != null ? `from ${money(minPrice)}` : ''}{avgSave != null ? ` · avg saving ${money(avgSave)} / gal` : ''}</span>
            </div>
            <button type="button" className="d-edit" onClick={() => { setShowRes(false); setStSel(null); }}>Edit</button>
          </div>
          <div className="d-tabs" role="tablist" aria-label="Order">
            {([['state', 'By state'], ['cheap', 'Cheapest'], ['discount', 'Biggest discount']] as const).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={resView === k} onClick={() => { haptic.select(); setResView(k); scrollRef.current?.scrollTo({ top: 0 }); }}>{label}</button>
            ))}
          </div>
        </>
      )}
    </header>

    <main className={showRes ? 'd-results' : 'd-main'} ref={scrollRef} onScroll={(e) => setShowTop(e.currentTarget.scrollTop > 220)}>
      {!stations && <div className="d-empty">Loading stations…</div>}
      {stations && !showRes && (
        <>
          <section className="d-sec">
            <div className="d-sec-head"><Icon name="fuel" /><h2>Stations</h2><span>{br.length ? `${br.length} of 4` : 'All 4'}</span></div>
            <div className="d-brands">
              {BRAND_ORDER.map((k) => {
                const on = br.includes(k);
                return (
                  <button key={k} type="button" className={'d-brand' + (on ? ' on' : '')} aria-pressed={on} onClick={() => { haptic.select(); setBr((v) => toggle(v, k)); }}>
                    <span className="d-brand-icon dm-brand-letter" style={{ background: BRANDS[k].color }}>{BRANDS[k].letter}</span>
                    <span className="d-brand-text"><b>{BRANDS[k].label}</b><span>{countFor(inStates, [k]).toLocaleString('en-US')} stations</span></span>
                    <span className={'d-check' + (on ? ' on' : '')}>{on && <Icon name="tick" />}</span>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="d-sec">
            <div className="d-sec-head">
              <Icon name="map" /><h2>States</h2>
              {picks.length > 0 && <button type="button" className="d-pill-sm" onClick={() => setPicks([])}>Clear {picks.length}</button>}
            </div>
            {orderedStates(states, picks, q).length ? (
              <ul className="d-list">
                {orderedStates(states, picks, q).map((c) => {
                  const on = picks.includes(c);
                  return (
                    <li key={c}>
                      <button type="button" className={'d-state' + (on ? ' on' : '')} aria-pressed={on} onClick={() => { haptic.select(); setPicks((v) => toggle(v, c)); }}>
                        <span className="d-state-icon"><Icon name="pin" /></span>
                        <span className="d-state-name">{STATE_NAMES[c]} <span>({c})</span></span>
                        <span className="d-state-count">{countFor([c], brandsOn)}</span>
                        <span className={'d-check' + (on ? ' on' : '')}>{on && <Icon name="tick" />}</span>
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
      {stations && showRes && <Results rows={rows} picks={inStates} view={resView} open={open} setOpen={setOpen} onOpen={(id) => { haptic.tap(); setStSel(id); }} />}
      {stations && showRes && <p className="d-hint" style={{ padding: '18px 0 4px' }}>Prices per gallon with the CFT discount · updated {updated(fetchedAt)}. Tap a station for the address and a route.</p>}
    </main>

    {!showRes && (
      <div className="d-foot">
        <div className="d-total">
          <b>{total.toLocaleString('en-US')} stations</b>
          <span>{minPrice != null ? `from ${money(minPrice)} / gal` : '—'}</span>
        </div>
        <button type="button" className="d-cta" data-sheen disabled={!total} onClick={() => { haptic.tap(); setShowRes(true); setOpen({}); scrollRef.current?.scrollTo({ top: 0 }); }}>
          Show<Icon name="right" />
        </button>
      </div>
    )}
    {showTop && <button type="button" className="d-top dm-bystate-top" data-up aria-label="Back to top" onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}><Icon name="up" /></button>}

    {stSelStation && (
      <>
        <button type="button" className="d-scrim" aria-label="Close station details" onClick={() => setStSel(null)} />
        <section className="dm-sheet dm-sheet-over">
          <button className="dm-handle" aria-label="Close station details" onClick={() => setStSel(null)}><i /></button>
          <StationCard
            s={stSelStation}
            badge={BRANDS[stSelStation.brand].label.toUpperCase()}
            near={false}
            detail
            onToggle={() => setStSel(null)}
            primary={routing ? 'Route here' : 'Routes are not on yet'}
            onPrimary={() => routing && onRouteTo(stSelStation)}
          />
        </section>
      </>
    )}
  </div>
  );
}

export function Results({ rows, picks, view, open, setOpen, onOpen }: {
  rows: DriverStation[]; picks: string[]; view: 'state' | 'cheap' | 'discount';
  open: Record<string, boolean>; setOpen: (o: Record<string, boolean>) => void; onOpen: (id: number) => void;
}) {
  const save = (s: DriverStation) => (s.retail != null && s.discounted != null ? s.retail - s.discounted : null);
  const byPrice = (a: DriverStation, b: DriverStation) => (payPrice(a) ?? 99) - (payPrice(b) ?? 99) || a.station.localeCompare(b.station);
  const bySave = (a: DriverStation, b: DriverStation) => (save(b) ?? -1) - (save(a) ?? -1) || byPrice(a, b);
  const row = (s: DriverStation) => {
    const sv = save(s);
    return (
      <li key={s.id}>
        <button type="button" className="d-row" onClick={() => onOpen(s.id)}>
          <span className="d-row-text"><b>{s.station}</b><span>{[placeOf(s), s.address].filter(Boolean).join(' · ')}</span></span>
          <span className="d-row-price">
            <span><b>{money(payPrice(s))}</b>{sv != null ? <s>{money(s.retail)}</s> : <s style={{ textDecoration: 'none' }}>retail</s>}</span>
            <span className={'d-save' + (sv == null ? ' none' : '')}>{sv != null ? `−${money(sv)}` : 'no disc.'}</span>
          </span>
        </button>
      </li>
    );
  };
  if (view !== 'state') {
    const list = rows.slice().sort(view === 'discount' ? bySave : byPrice);
    const full = !!open[view];
    return (
      <section className="d-group">
        <ul className="d-rows" data-rows>{(full ? list : list.slice(0, 12)).map(row)}</ul>
        {list.length > 12 && <button type="button" className="d-more" onClick={() => setOpen({ ...open, [view]: !full })}>{full ? 'Show less' : `Show all ${list.length.toLocaleString('en-US')} stations`}</button>}
      </section>
    );
  }
  const groups = picks
    .map((c) => ({ c, list: rows.filter((s) => s.state === c).sort(byPrice) }))
    .filter((g) => g.list.length)
    .sort((a, b) => STATE_NAMES[a.c].localeCompare(STATE_NAMES[b.c]));
  return (
    <>
      {groups.map(({ c, list }) => {
        const isOpen = !!open[c];
        const sv = list.map(save).filter((x): x is number => x != null);
        const avg = sv.length ? sv.reduce((t, v) => t + v, 0) / sv.length : null;
        return (
          <section key={c} className="d-group">
            <div className="d-group-head">
              <span className="d-code">{c}</span>
              <b>{STATE_NAMES[c]}</b>
              <span>{list.length} station{list.length === 1 ? '' : 's'}{avg != null ? ` · avg −${money(avg)}` : ''}</span>
            </div>
            <ul className="d-rows" data-rows>{(isOpen ? list : list.slice(0, 3)).map(row)}</ul>
            {list.length > 3 && <button type="button" className="d-more" onClick={() => setOpen({ ...open, [c]: !isOpen })}>{isOpen ? 'Show less' : `Show all ${list.length} in ${STATE_NAMES[c]}`}</button>}
          </section>
        );
      })}
    </>
  );
}

function orderedStates(states: string[], picks: string[], q: string) {
  const qq = q.trim().toLowerCase();
  const vis = qq ? states.filter((c) => STATE_NAMES[c].toLowerCase().includes(qq) || c.toLowerCase() === qq) : states;
  return [...vis.filter((c) => picks.includes(c)), ...vis.filter((c) => !picks.includes(c))];
}


