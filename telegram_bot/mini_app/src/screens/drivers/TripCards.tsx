import type { DriverStation } from '../../../../../support/common/types';
import { BRANDS, payPrice } from '../../../../../support/common/driver-route';
import { fmtDuration as hm } from '../../components/ui';
import { CHECK, dist, firstPart, fullAddress, money, NAV, pct, PriceBox, Svg, Truck } from './pieces';

// The cards of a trip on the route map: building the route, the trip-recording notice, driving,
// arrived at the fuel stop, and trip complete.

const BUILD_STEPS = ['Finding roads for your truck', 'Checking live traffic', 'Finding CFT stations on the way'];

/** While the route is worked out: its steps tick on, and the driver can cancel. */
export function BuildingCard({ fromText, toText, step, onCancel }: { fromText: string; toText: string; step: number; onCancel: () => void }) {
  return (
    <div className="dm-building" role="status" aria-live="polite">
      <div className="dm-build-card">
        <div className="dm-build-road" aria-hidden="true"><i /><span><Truck size={15} /></span></div>
        <b>Building your truck route</b>
        <span className="dm-build-to">{fromText ? firstPart(fromText) : 'My location'} → {firstPart(toText) || 'destination'}</span>
        <ul className="dm-build-steps">
          {BUILD_STEPS.map((t, i) => <li key={t} className={i < step ? 'done' : i === step ? 'now' : ''}><i>{i < step && <Svg d={CHECK} size={12} w={3} />}</i>{t}</li>)}
        </ul>
        <button type="button" className="dm-soft" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** Before a driver's first navigation: what is recorded about their trips. */
export function TripNotice({ onClose, onStart }: { onClose: () => void; onStart: () => void }) {
  return (
    <>
      <button className="dm-scrim" aria-label="Close" onClick={onClose} />
      <section className="dm-sheet dm-trucksheet" role="dialog" aria-labelledby="dm-notice-title">
        <div className="dm-swap">
          <div>
            <span className="dm-eyebrow" id="dm-notice-title">YOUR TRIPS ARE RECORDED</span>
            <p style={{ margin: '8px 0 0', fontSize: 14.5, color: '#c8d0d6', lineHeight: 1.45 }}>
              CFT keeps a record of the trips you navigate here: where you start and go, your fuel stop and its price, and where the truck drives while this map is open. Nothing is recorded when the map is closed. Records are kept for 12 months.
            </p>
          </div>
          <button type="button" className="dm-primary" onClick={onStart}><Svg d={NAV} size={20} />OK, start the route</button>
        </div>
      </section>
    </>
  );
}

interface DrivingProps {
  /** Driving to the fuel stop (go1) or to the destination (go2). */
  toStop: boolean;
  stop: DriverStation | null;
  dest: string;
  leftMi: number;
  avgMph: number;
  along: number;
  totalMi: number;
  stopAlong: number | null;
  onEnd: () => void;
}

/** While driving: the next stop or the destination, the miles and time left, and the trip's progress. */
export function DrivingCard({ toStop, stop, dest, leftMi, avgMph, along, totalMi, stopAlong, onEnd }: DrivingProps) {
  return (
    <div className="dm-swap">
      <div className="dm-tripline">
        {toStop && stop
          ? <span className="dm-tile" style={{ background: BRANDS[stop.brand].color }}>{BRANDS[stop.brand].letter}</span>
          : <span className="dm-tile" style={{ background: '#7fe0a4' }}><Svg d={CHECK} size={22} w={2.6} /></span>}
        <span className="dm-tripline-text">
          <span className="dm-eyebrow">{toStop ? 'NEXT FUEL STOP' : 'DESTINATION'}</span>
          <b>{toStop && stop ? stop.station : dest}</b>
          <span>{dist(leftMi)} · {hm((leftMi / avgMph) * 3600)}</span>
        </span>
        {toStop && stop && <span className="dm-tripline-price"><b>{money(payPrice(stop))}</b><small>/gal</small></span>}
      </div>
      <div className="dm-prog" aria-hidden="true">
        <i className="pg-track" />
        <i className="pg-fill" style={{ width: pct(along, totalMi) }} />
        {stopAlong != null && stop && <span className="pg-stop" style={{ left: pct(stopAlong, totalMi), background: BRANDS[stop.brand].color }}>{BRANDS[stop.brand].letter}</span>}
        <span className="pg-me" style={{ left: pct(along, totalMi) }}><Truck size={12} /></span>
        <span className="pg-end" />
      </div>
      <div className="dm-tripfoot">
        <span>{hm(((totalMi - along) / avgMph) * 3600)} to {dest}</span>
        <button type="button" className="dm-soft dm-danger" onClick={onEnd}>End</button>
      </div>
    </div>
  );
}

/** Arrived at the fuel stop: its price, then on to the destination. */
export function StopCard({ stop, dest, onContinue, onEnd }: { stop: DriverStation; dest: string; onContinue: () => void; onEnd: () => void }) {
  return (
    <div className="dm-swap">
      <div className="dm-tripline">
        <span className="dm-tile" style={{ background: BRANDS[stop.brand].color }}>{BRANDS[stop.brand].letter}</span>
        <span className="dm-tripline-text"><span className="dm-eyebrow ok">YOU'VE ARRIVED</span><b>{stop.station}</b><span>{fullAddress(stop)}</span></span>
      </div>
      <PriceBox s={stop} />
      <div className="dm-row-btns">
        <button type="button" className="dm-primary" onClick={onContinue}><Svg d={NAV} size={18} />Continue to {dest}</button>
        <button type="button" className="dm-soft dm-danger" onClick={onEnd}>End</button>
      </div>
    </div>
  );
}

/** At the destination. */
export function DoneCard({ dest, onNewTrip }: { dest: string; onNewTrip: () => void }) {
  return (
    <div className="dm-swap">
      <div><span className="dm-eyebrow ok">TRIP COMPLETE</span><b className="dm-done-title">You've arrived in {dest}</b></div>
      <button type="button" className="dm-primary" onClick={onNewTrip}>Plan a new trip</button>
    </div>
  );
}
