import { useCallback, useEffect, useState } from 'react';
import type { DiscountsAdmin } from '../../../../../support/common/types';
import { hubApi, teamApi, type ApiError } from '../../lib/api';
import { haptic, tg, useBackButton } from '../../lib/telegram';
import { fmtDate, Icon, Spinner, useToast } from '../../components/ui';

// Fuel discounts data (design: DiscountsUpdate): what every agent sees, updating it from the cabinet,
// and the agent-price settings (the CFT margin, stations without a discount, broken stations).

const num = (n: number) => n.toLocaleString('en-US');

function Switch({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button type="button" role="switch" className="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => { haptic.select(); onChange(!on); }}><i /></button>;
}

export function DiscountsData({ onBack }: { onBack: () => void }) {
  const [d, setD] = useState<DiscountsAdmin | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'refresh' | 'save' | 'excel'>('');
  const [margin, setMargin] = useState('');
  const [toastNode, toast] = useToast();
  useBackButton(onBack);

  const take = (x: DiscountsAdmin) => {
    setD(x);
    setMargin(x.settings.margin.toFixed(2));
  };
  const load = useCallback(() => {
    setError('');
    teamApi.discounts().then(take, (e: ApiError) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const act = async (kind: 'refresh' | 'save' | 'excel', fn: () => Promise<unknown>, ok: string) => {
    setBusy(kind);
    try {
      await fn();
      haptic.success();
      toast(ok);
    } catch (e) {
      haptic.error();
      toast((e as ApiError).message);
    } finally {
      setBusy('');
    }
  };
  const save = (patch: Partial<DiscountsAdmin['settings']>) =>
    d && act('save', async () => take(await teamApi.saveDiscounts({ ...d.settings, ...patch })), 'Saved — agents see it now');
  const saveMargin = () => {
    const m = Number(margin.replace(/[$\s]/g, ''));
    if (!Number.isFinite(m) || m < 0 || m > 2) {
      toast('Enter an amount from 0.00 to 2.00');
      return;
    }
    if (d && Math.abs(m - d.settings.margin) > 0.0005) save({ margin: m });
  };

  const ds = d?.dataset;
  return (
    <div className="d-screen">
      <header className="d-head" data-enter>
        <div className="d-head-row" style={{ justifyContent: 'flex-start' }}>
          {!tg && <button type="button" className="d-back" aria-label="Back to admin home" onClick={onBack}><Icon name="left" /></button>}
          <div className="d-title"><span className="d-eyebrow">FUEL DISCOUNTS DATA</span><h1 style={{ fontSize: 22, marginTop: 4 }}>What every agent sees</h1></div>
        </div>
      </header>
      <main className="d-main" data-stagger>
        {error ? (
          <div className="d-empty"><span>{error}</span><button type="button" className="d-pill-sm" onClick={load}>Try again</button></div>
        ) : !d ? (
          <div className="d-sec">{[0, 1, 2].map((i) => <div key={i} data-skel style={{ height: 90, borderRadius: 16 }} />)}</div>
        ) : (
          <>
            <div className="t-live">
              <img src="/assets/glow-blue.png" alt="" data-glow />
              <span className="d-eyebrow">LIVE NOW</span>
              <h1>{ds ? fmtDate(ds.pulledAt) : 'Not loaded yet'}</h1>
              <p>{ds ? 'From the United Fuel cabinet · your time' : 'Agents see nothing until the prices are pulled once.'}</p>
            </div>

            {ds && (
              <section className="d-sec">
                <span className="d-eyebrow">PUBLISHED</span>
                <div className="t-figs">
                  <div><b>{num(ds.partnerStations)}</b><span>partner stations in {ds.states} states</span></div>
                  <div><b>{num(ds.withDiscount)}</b><span>with a discounted price</span></div>
                  <div><b>{num(ds.byBrand.pilot)}</b><span>Pilot / Flying J</span></div>
                  <div><b>{num(ds.byBrand.loves)}</b><span>Love’s</span></div>
                  <div><b>{num(ds.byBrand.ta)}</b><span>TA / Petro</span></div>
                  <div><b>{num(ds.byBrand.speedway)}</b><span>Speedway</span></div>
                </div>
                <div className="t-note"><Icon name="check" /><span>Complete: all {num(ds.siteTotal)} stations the cabinet reports were read; the {num(ds.partnerStations)} at partner brands are kept.</span></div>
                {ds.smallDiscount > 0 && <div className="t-note"><Icon name="info" /><span>{num(ds.smallDiscount)} partner stations have a discount of {`$${d.settings.margin.toFixed(2)}`} or less — hidden from agents.</span></div>}
                {ds.noPrice > 0 && <div className="t-note"><Icon name="info" /><span>{num(ds.noPrice)} partner stations have no discounted price — {d.settings.showNoPrice ? 'shown to agents at retail' : 'hidden from agents'}.</span></div>}
                {ds.broken > 0 && <div className="t-note"><Icon name="alert" /><span>{num(ds.broken)} are flagged “broken” in the cabinet — {d.settings.showBroken ? 'shown to agents' : 'hidden from agents'}.</span></div>}
              </section>
            )}

            <section className="d-sec">
              <span className="d-eyebrow">UPDATE THE PRICES</span>
              <button type="button" className="d-cta" data-sheen disabled={!!busy} onClick={() => act('refresh', async () => take(await teamApi.refreshDiscounts()), 'Prices updated — agents see them now')}>
                {busy === 'refresh' ? <><Spinner size={16} />Reading the cabinet…</> : <><Icon name="sync" />Pull the latest prices</>}
              </button>
              <p className="d-hint">Reads every station from the United Fuel cabinet (about 10 seconds). The 📥 button in the bot does the same and also sends you the Excel file.</p>
            </section>

            <section className="d-sec">
              <span className="d-eyebrow">AGENT PRICES</span>
              <div className="t-card">
                <div className="t-row">
                  <div><b>CFT margin</b><span>Taken off the cabinet’s discount for agents, per gallon. Smaller discounts are hidden.</span></div>
                  <span className="t-money">$<input inputMode="decimal" aria-label="CFT margin in dollars" value={margin} onChange={(e) => setMargin(e.target.value)} onBlur={saveMargin} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} /></span>
                </div>
                <div className="t-row">
                  <div><b>Stations without a discount</b><span>Show them to agents at the retail price</span></div>
                  <Switch on={d.settings.showNoPrice} label="Show stations without a discount" disabled={!!busy} onChange={(v) => save({ showNoPrice: v })} />
                </div>
                <div className="t-row">
                  <div><b>“Broken” stations</b><span>Show stations the cabinet flags as broken</span></div>
                  <Switch on={d.settings.showBroken} label="Show broken stations" disabled={!!busy} onChange={(v) => save({ showBroken: v })} />
                </div>
              </div>
            </section>

            <nav className="a-nav" aria-label="More">
              <button type="button" className="a-link" disabled={!!busy} onClick={() => act('excel', async () => { await hubApi.fuelSend(); load(); }, 'fuel_prices.xlsx is in your chat')}>
                <span className="a-link-icon">{busy === 'excel' ? <Spinner size={16} /> : <Icon name="download" size={18} />}</span>
                <span className="a-link-text"><b>Send Excel to my chat</b><span>Every station, real prices (also updates agents)</span></span>
                <Icon name="right" />
              </button>
              <button type="button" className="a-link" onClick={() => { location.hash = '#/fuel'; }}>
                <span className="a-link-icon"><Icon name="search" size={18} /></span>
                <span className="a-link-text"><b>Browse all prices</b><span>Every station, real cabinet prices</span></span>
                <Icon name="right" />
              </button>
              <button type="button" className="a-link" onClick={() => { location.hash = '#/discounts'; }}>
                <span className="a-link-icon"><Icon name="fuel" size={18} /></span>
                <span className="a-link-text"><b>See what agents see</b><span>Find discounts, with agent prices</span></span>
                <Icon name="right" />
              </button>
            </nav>
          </>
        )}
      </main>
      {toastNode}
    </div>
  );
}
