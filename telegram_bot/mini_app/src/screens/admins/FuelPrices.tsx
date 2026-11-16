import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FuelStationRow, FuelStations } from '../../../../../shared/types';
import { savingOf as saving } from '../../../../../shared/driverRoute';
import { hubApi, type ApiError } from '../../lib/api';
import { haptic, openExternal, tg, useBackButton } from '../../lib/telegram';
import { fmtDate, Icon, Spinner, useToast } from '../../components/ui';

/** "$5.099": every decimal the cabinet sent, at least two. */
function fmtPrice(p: number | null): string {
  if (p == null) return '—';
  const decimals = Math.max(2, (String(p).split('.')[1] ?? '').length);
  return '$' + p.toFixed(decimals);
}

type Sort = 'discounted' | 'retail' | 'saving' | 'name';
const SORTS: [Sort, string][] = [['discounted', 'Cheapest discounted'], ['retail', 'Cheapest retail'], ['saving', 'Biggest saving'], ['name', 'Name A–Z']];
const PAGE = 60;
/** Missing values sort last, whichever way the list is sorted. */
const byNumber = (a: number | null, b: number | null) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : a - b);

/** Every station's fuel prices from the United Fuel cabinet: search, filter by state, sort, open in Maps. */
export function FuelPrices({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<FuelStations | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [sort, setSort] = useState<Sort>('discounted');
  const [discountOnly, setDiscountOnly] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [sending, setSending] = useState(false);
  const [toastNode, toast] = useToast();
  useBackButton(onBack);

  const load = useCallback(() => {
    setError('');
    hubApi.fuelStations().then(setData, (e: ApiError) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => setShown(PAGE), [q, state, sort, discountOnly]);

  const states = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of data?.stations ?? []) if (s.state) m.set(s.state, (m.get(s.state) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = (data?.stations ?? []).filter((s) => {
      if (state && s.state !== state) return false;
      if (discountOnly && s.discounted == null) return false;
      if (!words.length) return true;
      const hay = [s.station, s.city, s.state, s.address].filter(Boolean).join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const cmp: Record<Sort, (a: FuelStationRow, b: FuelStationRow) => number> = {
      discounted: (a, b) => byNumber(a.discounted, b.discounted),
      retail: (a, b) => byNumber(a.retail, b.retail),
      saving: (a, b) => byNumber(saving(b), saving(a)) || byNumber(a.discounted, b.discounted),
      name: (a, b) => a.station.localeCompare(b.station),
    };
    return rows.sort((a, b) => cmp[sort](a, b) || a.station.localeCompare(b.station));
  }, [data, q, state, sort, discountOnly]);

  const send = async () => {
    setSending(true);
    try {
      const r = await hubApi.fuelSend();
      haptic.success();
      toast(`fuel_prices.xlsx with ${r.stations.toLocaleString('en-US')} stations is in your chat`);
    } catch (e) {
      haptic.error();
      toast((e as ApiError).message);
    } finally {
      setSending(false);
    }
  };

  const maps = (s: FuelStationRow) => openExternal('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([s.station, s.address, s.city, s.state].filter(Boolean).join(', ')));

  return (
    <div className="fill">
      <header className="fuel-head">
        <div className="fuel-head-row">
          {!tg && <button type="button" className="icon-btn" aria-label="Back to the Hub" onClick={onBack}><Icon name="left" /></button>}
          <div className="brand-mini">
            <div>
              <b>⛽ FUEL PRICES</b>
              <span>{data ? `${data.stations.length.toLocaleString('en-US')} stations · read ${fmtDate(data.fetchedAt)}` : 'United Fuel cabinet'}</span>
            </div>
          </div>
          <button type="button" className="pill" onClick={send} disabled={sending || !data}>
            {sending ? <Spinner size={14} /> : <Icon name="download" size={15} />}
            {sending ? 'Sending…' : 'Excel to chat'}
          </button>
        </div>
        <div className="fuel-controls">
          <label className="search">
            <span className="sr-only">Search stations</span>
            <Icon name="search" />
            <input className="ctl fuel-search" type="search" placeholder="Station, city or address" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="row-scroll">
            <select className="ctl" aria-label="State" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">All states</option>
              {states.map(([s, n]) => <option key={s} value={s}>{s} · {n}</option>)}
            </select>
            <select className="ctl" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <label className="check fuel-check">
              <input type="checkbox" checked={discountOnly} onChange={(e) => setDiscountOnly(e.target.checked)} />
              With discount
            </label>
          </div>
        </div>
      </header>

      <main className="page fuel-page">
        {error ? (
          <div className="empty">
            <p style={{ margin: 0 }}>{error}</p>
            <button type="button" className="pill" onClick={load}><Icon name="sync" size={15} /> Try again</button>
          </div>
        ) : !data ? (
          <div className="center-msg"><span><Spinner /> Reading prices from the cabinet…</span></div>
        ) : !list.length ? (
          <div className="empty">No station matches. Try another search or state.</div>
        ) : (
          <>
            <p className="fine">{list.length.toLocaleString('en-US')} of {data.stations.length.toLocaleString('en-US')} stations · tap a station to open it in Google Maps</p>
            <ul className="fuel-list">
              {list.slice(0, shown).map((s) => {
                const save = saving(s);
                return (
                  <li key={s.id}>
                    <button type="button" className="fuel-row" onClick={() => maps(s)}>
                      <div className="fuel-where">
                        <b>{s.station}</b>
                        <span>{[s.city, s.state].filter(Boolean).join(', ') || '—'}</span>
                        {s.address && <span className="muted">{s.address}</span>}
                      </div>
                      <div className="fuel-price">
                        <b className="num">{fmtPrice(s.discounted ?? s.retail)}</b>
                        {s.discounted != null && s.retail != null ? <s className="num muted">{fmtPrice(s.retail)}</s> : <span className="muted">retail</span>}
                        {save != null && save > 0 && <span className="chip chip-pass num">−{fmtPrice(Math.round(save * 1e4) / 1e4)}</span>}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
            {shown < list.length && (
              <button type="button" className="pill" style={{ alignSelf: 'center' }} onClick={() => setShown((n) => n + PAGE * 2)}>
                Show more ({(list.length - shown).toLocaleString('en-US')} left)
              </button>
            )}
          </>
        )}
      </main>
      {toastNode}
    </div>
  );
}
