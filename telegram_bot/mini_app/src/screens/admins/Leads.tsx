import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { LeadsAppData, LeadsFile } from '../../../../../support/common/types';
import { leadsApi, type ApiError } from '../../lib/api';
import { canTelegramDownload, haptic, telegramDownload, tg, useBackButton } from '../../lib/telegram';
import { Icon, Spinner, useToast } from '../../components/ui';

// Driver Leads in the Mini App and on the website, for admins: the same leads and files as the bot's
// buttons (tools/driver-leads/app.ts), downloaded straight from our server instead of sent to the chat,
// so they keep working when Telegram can't deliver files. Every new lead still goes out once.

const num = (n: number) => n.toLocaleString('en-US');
type Next = { label: string; run: () => Promise<LeadsFile> } | null;

/** Saves a file: Telegram's download sheet inside the Mini App, a normal download in a browser. */
function save(f: NonNullable<LeadsFile['file']>) {
  if (canTelegramDownload()) return telegramDownload(location.origin + f.path, f.filename);
  const a = document.createElement('a');
  a.href = f.path;
  a.download = f.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function Leads({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<LeadsAppData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [next, setNext] = useState<Next>(null);
  const [toastNode, toast] = useToast();
  const load = useCallback(() => {
    setError('');
    leadsApi.data().then(setData, (e: ApiError) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useBackButton(onBack);

  /** Runs one download; offers the next part when there is one. */
  const get = async (id: string, run: () => Promise<LeadsFile>, empty: string, nextOf?: (r: LeadsFile) => Next) => {
    setBusy(id);
    setNext(null);
    try {
      const r = await run();
      if (!r.file) { toast(empty); return; }
      save(r.file);
      haptic.success();
      toast(`${num(r.count)} ${r.count === 1 ? 'lead' : 'leads'} · ${r.file.filename}`);
      if (r.more && nextOf) setNext(nextOf(r));
      if (id === 'recent') load();
    } catch (e) {
      haptic.error();
      toast((e as ApiError).message);
    } finally {
      setBusy('');
    }
  };
  const recent = () => get('recent', leadsApi.recent, 'No new driver leads at the moment. Check again later.', () => ({ label: 'Get the next new leads', run: leadsApi.recent }));
  const file = (id: string, kind: string, filter?: string, from?: { after: number; part: number } | null) =>
    get(id, () => leadsApi.file(kind, filter, from), 'Nothing to download here yet.', (r) => (r.next ? { label: `Next file (part ${r.next.part})`, run: () => leadsApi.file(kind, filter, r.next) } : null));

  const s = data?.stats;
  const spin = (id: string, label: ReactNode) => (busy === id ? <Spinner /> : label);

  return (
    <div className="d-screen">
      <header className="d-head" data-enter>
        <div className="d-head-row">
          {!tg && <button type="button" className="d-back" aria-label="Back to admin home" onClick={onBack}><Icon name="left" /></button>}
          <h1 className="d-h1" style={{ flex: 1 }}>Driver leads</h1>
        </div>
      </header>
      <main className="d-main" data-stagger>
        {error ? (
          <div className="d-empty"><span>{error}</span><button type="button" className="d-pill-sm" onClick={load}>Try again</button></div>
        ) : !s || !data ? (
          <div className="d-sec">{[0, 1, 2].map((i) => <div key={i} data-skel style={{ height: 80, borderRadius: 12 }} />)}</div>
        ) : (
          <>
            <section className="t-card">
              <div className="t-row">
                <div>
                  <b style={{ fontSize: 26, fontFamily: 'var(--cond)' }}>{num(s.waiting)} new</b>
                  <span>never sent before · {num(s.today)} added today</span>
                </div>
              </div>
              <button type="button" className="d-cta" disabled={!!busy} onClick={recent}>{spin('recent', <><Icon name="download" size={18} />Get new leads</>)}</button>
              {next && <button type="button" className="d-ghost" disabled={!!busy} onClick={() => get('next', next.run, 'That was the last file.', () => next)}>{spin('next', next.label)}</button>}
              <button type="button" className="d-pill-sm" style={{ alignSelf: 'flex-start' }} disabled={!!busy}
                onClick={() => get('last', leadsApi.last, 'You have not got any new leads yet.')}>{spin('last', 'Download my last file again')}</button>
              <p className="d-hint" style={{ margin: 0 }}>Each new lead is sent once, to whoever asks first, here or in the bot. The file has a Delivery column.</p>
            </section>

            <section className="d-sec">
              <span className="d-eyebrow">STATISTICS</span>
              <div className="t-figs">
                <div><b>{num(s.total)}</b><span>leads in total</span></div>
                <div><b>{num(s.week)}</b><span>added this week</span></div>
                <div><b>{num(s.delivered)}</b><span>already sent</span></div>
                <div><b>{num(s.verified)}</b><span>verified</span></div>
                <div><b>{num(s.duplicates)}</b><span>duplicates merged</span></div>
                <div><b>{num(s.noConsent + s.optedOut)}</b><span>can’t be contacted</span></div>
              </div>
              {s.bySource.length > 0 && <p className="d-hint" style={{ margin: 0 }}>By source: {s.bySource.map((x) => `${x.key} ${num(x.n)}`).join(' · ')}</p>}
            </section>

            <section className="d-sec">
              <span className="d-eyebrow">DOWNLOADS</span>
              <div className="d-stack">
                <button type="button" className="d-ghost" disabled={!!busy} onClick={() => file('today', 'today')}>{spin('today', '📅 Today’s leads')}</button>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="d-ghost" style={{ flex: 1 }} disabled={!!busy} onClick={() => file('excel', 'excel')}>{spin('excel', '📊 All as Excel')}</button>
                  <button type="button" className="d-ghost" style={{ flex: 1 }} disabled={!!busy} onClick={() => file('csv', 'csv')}>{spin('csv', '📄 All as CSV')}</button>
                </div>
                <button type="button" className="d-ghost" disabled={!!busy} onClick={() => file('full', 'full')}>{spin('full', '🗄 Full database (with a Summary sheet)')}</button>
              </div>
            </section>

            {data.states.length > 0 && (
              <section className="d-sec">
                <span className="d-eyebrow">BY STATE · TAP TO DOWNLOAD</span>
                <div className="d-chips" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
                  {data.states.map((x) => (
                    <button key={x.key} type="button" className="d-chip plain" disabled={!!busy} onClick={() => file('st' + x.key, 'state', x.key)}>
                      {busy === 'st' + x.key ? <Spinner size={12} /> : `${x.key} · ${num(x.n)}`}
                    </button>
                  ))}
                </div>
              </section>
            )}
            {data.cdls.length > 0 && (
              <section className="d-sec">
                <span className="d-eyebrow">BY CDL CLASS</span>
                <div className="d-chips" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
                  {data.cdls.map((x) => (
                    <button key={x.key} type="button" className="d-chip plain" disabled={!!busy} onClick={() => file('cdl' + x.key, 'cdl', x.key)}>
                      {busy === 'cdl' + x.key ? <Spinner size={12} /> : `${x.key === 'NA' ? 'Not given' : 'Class ' + x.key} · ${num(x.n)}`}
                    </button>
                  ))}
                </div>
              </section>
            )}
            <p className="d-hint">Lead sources, the FMCSA sync, opt-outs and CSV imports are in the bot (/leadsource, /leadsync, /optout).</p>
          </>
        )}
      </main>
      {toastNode}
    </div>
  );
}
