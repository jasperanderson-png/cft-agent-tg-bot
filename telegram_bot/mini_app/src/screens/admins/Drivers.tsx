import { useCallback, useEffect, useState } from 'react';
import type { DriverRequestCard, DriverWithTrips, TripSummary } from '../../../../../support/common/types';
import { driversApi, type ApiError } from '../../lib/api';
import { haptic, routePageUrl, tg, useBackButton } from '../../lib/telegram';
import { fmtDate, fmtDay, fmtDuration, Icon, Spinner, useToast } from '../../components/ui';

// Drivers, for admins: everyone who joined through a driver link (and removed drivers whose trips
// are kept), then one driver's trip history: where they went, the fuel stop and its price, planned
// against recorded miles. A trip opens on the map (/route?trip=<id>) or comes as a CSV file in the
// admin's chat, as proof. Trips are recorded only while the driver's map is open (gaps are shown).

const initials = (name: string | null) => (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
const mi = (n: number | null) => (n == null ? '—' : `${n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString('en-US')} mi`);
const STATUS: Record<TripSummary['status'], { text: string; color: string }> = {
  arrived: { text: 'Arrived', color: '#7fe0a4' },
  ended: { text: 'Ended', color: '#a0dcff' },
  driving: { text: 'Driving now', color: '#ff9f1a' },
  stale: { text: 'Recording stopped', color: '#ff8a8a' },
};

/** Where a driver came from: "invited by Aziz · website link · approved by Jasper". */
function origin(d: DriverWithTrips): string {
  const link = d.via === 'website' ? 'website link' : d.via === 'bot' ? 'bot link' : d.via === 'link' ? 'driver link' : null;
  return [
    d.invitedBy ? `invited by ${d.invitedBy}` : d.via === 'bot' || d.via === 'website' ? 'came by themselves' : null,
    link,
    d.approvedBy && `approved by ${d.approvedBy}${d.ownLink ? ' (own link)' : ''}`,
  ].filter(Boolean).join(' · ');
}

export function Drivers({ onBack }: { onBack: () => void }) {
  const [list, setList] = useState<DriverWithTrips[] | null>(null);
  const [requests, setRequests] = useState<DriverRequestCard[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [driver, setDriver] = useState<DriverWithTrips | null>(null);
  const [toastNode, toast] = useToast();
  const load = useCallback(() => {
    setError('');
    driversApi.list().then((r) => setList(r.drivers), (e: ApiError) => setError(e.message));
    driversApi.requests().then((r) => setRequests(r.pending), () => setRequests([]));
  }, []);
  useEffect(load, [load]);
  useBackButton(driver ? () => setDriver(null) : onBack);

  /** Approve or decline, as the buttons in the admins' chat do (the first decision wins). */
  const decide = async (r: DriverRequestCard, action: 'approve' | 'decline') => {
    setBusy(r.id);
    try {
      const next = await driversApi.decide(r.id, action);
      setRequests(next.pending);
      haptic.success();
      toast(action === 'approve' ? `${r.name} approved: they have the route map now` : `${r.name} declined`);
      driversApi.list().then((x) => setList(x.drivers), () => {});
    } catch (e) {
      haptic.error();
      toast((e as ApiError).message);
      load();
    } finally {
      setBusy('');
    }
  };

  if (driver) return <DriverTrips d={driver} onBack={() => setDriver(null)} />;
  const current = list?.filter((d) => !d.removed) ?? [];
  const removed = list?.filter((d) => d.removed) ?? [];

  const row = (d: DriverWithTrips) => (
    <button key={d.telegramUserId} type="button" className="t-person" onClick={() => { haptic.tap(); setDriver(d); }}>
      <span className="d-avatar">{initials(d.name)}</span>
      <span className="t-person-text">
        <b>{d.name ?? 'Telegram user'}</b>
        <span>{[d.username && '@' + d.username, d.removed ? 'removed' : `joined ${fmtDay(d.joinedAt)}`].filter(Boolean).join(' · ')}</span>
        {!d.removed && origin(d) && <span>{origin(d)}</span>}
        <span>{d.trips ? `${d.trips} trip${d.trips === 1 ? '' : 's'} · ${mi(d.drivenMi)} · last ${fmtDay(d.lastTripAt)}` : 'No trips yet'}</span>
      </span>
      <Icon name="right" style={{ color: '#666' }} />
    </button>
  );

  const requestCard = (r: DriverRequestCard) => (
    <div key={r.id} className="t-card">
      <div className="t-row">
        <span className="d-avatar">{initials(r.name)}</span>
        <div>
          <b>{r.name}{r.username ? ` @${r.username}` : ''}</b>
          <span>{[r.phone, r.company].filter(Boolean).join(' · ') || '—'}</span>
        </div>
      </div>
      <span className="d-hint" style={{ margin: 0 }}>
        {r.invitedBy ? `Invited by ${r.invitedBy}` : 'Came by themselves'} · via {r.via === 'website' ? 'website' : 'bot'}{r.invitedBy ? ' link' : ''}
        {r.source ? ` · heard about us: ${r.source}` : ''} · asked {fmtDay(r.submittedAt)}
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="d-cta wide" disabled={!!busy} onClick={() => decide(r, 'approve')}>{busy === r.id ? <Spinner /> : 'Approve'}</button>
        <button type="button" className="t-danger" style={{ flex: 1 }} disabled={!!busy} onClick={() => decide(r, 'decline')}>Decline</button>
      </div>
    </div>
  );

  return (
    <div className="d-screen">
      <header className="d-head" data-enter>
        <div className="d-head-row">
          {!tg && <button type="button" className="d-back" aria-label="Back to admin home" onClick={onBack}><Icon name="left" /></button>}
          <h1 className="d-h1" style={{ flex: 1 }}>Drivers</h1>
        </div>
      </header>
      <main className="d-main" data-stagger>
        {error ? (
          <div className="d-empty"><span>{error}</span><button type="button" className="d-pill-sm" onClick={load}>Try again</button></div>
        ) : !list ? (
          <div className="d-sec">{[0, 1, 2, 3].map((i) => <div key={i} data-skel style={{ height: 64, borderRadius: 12 }} />)}</div>
        ) : (
          <>
            {requests.length > 0 && (
              <section className="d-sec">
                <span className="d-eyebrow">WAITING FOR APPROVAL · {requests.length}</span>
                <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))' }}>{requests.map(requestCard)}</div>
              </section>
            )}
            <section className="d-sec">
              <span className="d-eyebrow">DRIVERS · {current.length}</span>
              {current.length ? <div className="t-people" data-rows>{current.map(row)}</div> : (
                <div className="d-empty"><Icon name="truck" size={22} /><span>No drivers yet. Send your driver links from the bot: /invitedriver. Agents have their own links too.</span></div>
              )}
            </section>
            {removed.length > 0 && (
              <section className="d-sec">
                <span className="d-eyebrow">REMOVED · TRIPS KEPT · {removed.length}</span>
                <div className="t-people" data-rows>{removed.map(row)}</div>
              </section>
            )}
            <p className="d-hint">Trips are recorded from <b>Navigate</b> to arrival, only while the driver’s map is open, and kept for 12 months. Drivers are told before their first trip.</p>
          </>
        )}
      </main>
      {toastNode}
    </div>
  );
}

function DriverTrips({ d, onBack }: { d: DriverWithTrips; onBack: () => void }) {
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const [toastNode, toast] = useToast();
  useEffect(() => {
    driversApi.trips(d.telegramUserId).then((r) => setTrips(r.trips), (e: ApiError) => setError(e.message));
  }, [d.telegramUserId]);

  const send = async (id: string) => {
    haptic.tap();
    setSending(id);
    try {
      await driversApi.sendTrip(id);
      haptic.success();
      toast('Trip file sent to your chat');
    } catch (e) {
      haptic.error();
      toast((e as ApiError).message);
    } finally {
      setSending(null);
    }
  };

  return (
    <div className="d-screen">
      <header className="d-head" data-enter style={{ borderBottom: 0 }}>
        <div className="d-head-row" style={{ justifyContent: 'flex-start' }}>
          <button type="button" className="d-back" aria-label="Back to drivers" onClick={onBack}><Icon name="left" /></button>
          <span className="d-eyebrow">DRIVER</span>
        </div>
      </header>
      <main className="d-main" data-stagger>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span className="d-avatar lg">{initials(d.name)}</span>
          <div style={{ minWidth: 0 }}>
            <h1 className="d-h1" style={{ fontSize: 30 }}>{d.name ?? 'Telegram user'}</h1>
            <p className="d-hint" style={{ marginTop: 8 }}>
              {[d.username && '@' + d.username, d.removed ? 'Removed (trips kept)' : `Joined ${fmtDay(d.joinedAt)}`, d.invitedBy && `invited by ${d.invitedBy}`].filter(Boolean).join(' · ')}
            </p>
          </div>
        </div>
        <section className="d-sec">
          <span className="d-eyebrow">TRIPS{trips ? ` · ${trips.length}` : ''}</span>
          {error ? <div className="d-empty"><span>{error}</span></div>
            : !trips ? [0, 1, 2].map((i) => <div key={i} data-skel style={{ height: 120, borderRadius: 12 }} />)
            : !trips.length ? <div className="d-empty"><Icon name="map" size={22} /><span>No trips yet. A trip is recorded when the driver taps Navigate on the route map.</span></div>
            : trips.map((t) => {
              const took = (Date.parse(t.endedAt ?? t.lastPointAt ?? t.startedAt) - Date.parse(t.startedAt)) / 1000;
              const st = STATUS[t.status];
              return (
                <div key={t.id} className="t-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                    <b style={{ fontSize: 15 }}>{fmtDate(t.startedAt)}</b>
                    <span className="t-tag" style={{ background: 'transparent', color: st.color, border: `1px solid ${st.color}` }}>{st.text}</span>
                  </div>
                  <dl className="t-dl">
                    <dt>From</dt><dd>{t.fromLabel ?? '—'}</dd>
                    <dt>To</dt><dd>{t.toLabel ?? '—'}</dd>
                    {t.stop && <><dt>Fuel stop</dt><dd>{t.stop.name}{t.stop.price != null ? ` · $${t.stop.price.toFixed(3)}/gal` : ''} · {t.stop.reachedAt ? `reached ${fmtDate(t.stop.reachedAt).slice(11)}` : 'not reached'}</dd></>}
                    <dt>Miles</dt><dd>{mi(t.plannedMi)} planned · {mi(t.drivenMi)} recorded</dd>
                    <dt>Time</dt><dd>{fmtDuration(took)}{t.endedAt ? '' : ' so far'} · {t.points} points</dd>
                  </dl>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className="d-cta" style={{ flex: 1 }} onClick={() => { haptic.tap(); location.assign(routePageUrl(t.id)); }}><Icon name="map" size={16} />Map</button>
                    <button type="button" className="d-ghost" style={{ flex: 1 }} disabled={sending === t.id} onClick={() => send(t.id)}>{sending === t.id ? <Spinner size={14} /> : <Icon name="download" size={16} />}File to chat</button>
                  </div>
                </div>
              );
            })}
        </section>
      </main>
      {toastNode}
    </div>
  );
}
