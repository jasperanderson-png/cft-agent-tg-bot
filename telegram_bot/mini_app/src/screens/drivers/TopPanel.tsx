import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { DriverPlace, DriverRoute, TruckProfile } from '../../../../../support/common/types';
import { haptic } from '../../lib/telegram';
import { CHECK, EDIT, LOCATE, PIN, Svg, Truck, X, dist, firstPart, truckText, turnIcon } from './pieces';
import type { Field } from './drive-shared';

/** The turn banner while driving: the distance (big), the instruction, and the street. */
export interface Banner { big: string; text: string; sub: string; type: number | 'ok' }

interface Props {
  topRef: RefObject<HTMLDivElement | null>;
  banner: Banner | null;
  /** The speed limit, shown while driving. */
  limit: number | null;
  driving: boolean;
  onStates: () => void;
  base: DriverRoute | null;
  focus: 'from' | 'to' | null;
  setFocus: Dispatch<SetStateAction<'from' | 'to' | null>>;
  editing: boolean;
  setEditing: (v: boolean) => void;
  from: Field;
  to: Field;
  setFrom: (f: Field) => void;
  setTo: (f: Field) => void;
  sugg: DriverPlace[];
  locating: boolean;
  /** Whether a location is known (the From field then says "My location"). */
  hasPos: boolean;
  myAcc: number | null;
  posErr: string;
  /** Routes are off on the server: the fields are disabled. */
  routingOff: boolean;
  pickPlace: (which: 'from' | 'to', p: DriverPlace) => void;
  plan: (from: Field, to: Field) => void;
  toMyLocation: () => void;
  clearRoute: () => void;
  truck: TruckProfile;
  rangeMi: number | null;
  onTruck: () => void;
}

/** The top of the route map: the turn banner while driving, otherwise the tabs and the trip fields. */
export function TopPanel(p: Props) {
  const { banner, from, to, focus } = p;

  const field = (which: 'from' | 'to') => {
    const f = which === 'from' ? from : to;
    const set = which === 'from' ? p.setFrom : p.setTo;
    return (
      <div className={'dm-input' + (focus === which ? ' on' : '')}>
        {which === 'from' ? <span className="dm-trip-ico truck"><Truck size={14} /></span> : <span className="dm-trip-ico pin"><Svg d={PIN} size={18} /></span>}
        <input
          className={which === 'from' && !f.text ? 'me' : ''}
          aria-label={which === 'from' ? 'From' : 'To'}
          value={f.text}
          placeholder={which === 'from' ? (p.locating ? 'Finding your location…' : p.hasPos ? 'My location' : p.posErr ? 'Type where you start from' : 'Finding your location…') : 'Where are you going?'}
          enterKeyHint="go"
          autoComplete="off"
          disabled={p.routingOff}
          onFocus={() => { p.setFocus(which); p.setEditing(true); }}
          onBlur={() => setTimeout(() => p.setFocus((x) => (x === which ? null : x)), 150)}
          onChange={(e) => set({ text: e.target.value, place: null })}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            (e.target as HTMLInputElement).blur();
            if (p.sugg[0] && !f.place) p.pickPlace(which, p.sugg[0]);
            else p.plan(which === 'from' ? f : from, which === 'to' ? f : to);
          }}
        />
        {which === 'from' && !f.text && p.myAcc != null && focus !== 'from' && <span className="dm-acc">±{dist(p.myAcc / 1609.34)}</span>}
        {which === 'from' && f.text ? (
          <button type="button" className="dm-x me" aria-label="Use my location" onClick={p.toMyLocation}><Svg d={LOCATE} size={16} /></button>
        ) : f.text ? (
          <button type="button" className="dm-x" aria-label="Clear destination" onClick={p.clearRoute}><Svg d={X} size={15} /></button>
        ) : null}
      </div>
    );
  };

  return (
    <div className="dm-top" ref={p.topRef}>
      {banner ? (
        <div className={'dm-banner' + (banner.type === 'ok' ? ' ok' : '')} role="status">
          <span className="dm-banner-ico">{banner.type === 'ok' ? <Svg d={CHECK} size={26} w={2.8} /> : <Svg d={turnIcon(banner.type)} size={28} w={2.6} />}</span>
          <span className="dm-banner-text"><b>{banner.big}</b><span className="t">{banner.text}</span>{banner.sub && <span className="dm-banner-sub">{banner.sub}</span>}</span>
          {p.limit != null && p.driving && <span className="dm-limit" aria-label={`Speed limit ${p.limit} mph`}><small>LIMIT</small>{p.limit}</span>}
        </div>
      ) : (
        <>
          <div className="dm-tabs" role="tablist" aria-label="Find fuel">
            <button type="button" className="dm-tab" role="tab" aria-selected>My route</button>
            <button type="button" className="dm-tab" role="tab" aria-selected={false} onClick={() => { haptic.select(); p.onStates(); }}>By state</button>
          </div>
          {p.base && !focus && !p.editing ? (
            <div className="dm-trip dm-mini">
              <button type="button" className="dm-mini-main" aria-label="Change the trip" onClick={() => { haptic.tap(); p.setEditing(true); }}>
                <span className="dm-trip-ico truck"><Truck size={13} /></span>
                <span className="dm-mini-text">
                  <small>{from.text ? firstPart(from.text) : 'My location'}</small>
                  <b>{firstPart(to.text || p.base.to.label)}</b>
                </span>
                <Svg d={EDIT} size={15} />
              </button>
              <button type="button" className="dm-x" aria-label="Clear the route" onClick={() => { haptic.tap(); p.clearRoute(); }}><Svg d={X} size={15} /></button>
            </div>
          ) : (
            <div className="dm-trip">
              {field('from')}
              {field('to')}
              {focus && (p.sugg.length > 0 || focus === 'from') ? (
                <ul className="dm-sugg" role="listbox" aria-label="Places">
                  {focus === 'from' && (
                    <li>
                      <button type="button" role="option" aria-selected={!from.text} className="dm-sugg-me" onPointerDown={(e) => e.preventDefault()} onClick={p.toMyLocation}>
                        <Svg d={LOCATE} size={16} color="#a0dcff" />
                        <span>Use my current location</span>
                        <small>{p.locating ? 'locating…' : p.myAcc != null ? `±${dist(p.myAcc / 1609.34)}` : p.posErr ? 'off' : ''}</small>
                      </button>
                    </li>
                  )}
                  {p.sugg.map((pl) => (
                    <li key={`${pl.lat},${pl.lng},${pl.label}`}>
                      <button type="button" role="option" aria-selected={false} onPointerDown={(e) => e.preventDefault()} onClick={() => p.pickPlace(focus, pl)}>
                        <Svg d={PIN} size={16} color="#a0dcff" /><span>{pl.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <button type="button" className="dm-truckrow" onClick={() => { haptic.tap(); p.onTruck(); }} aria-label={`Truck: ${truckText(p.truck)}. Change`}>
                  <Truck size={13} /><span>{truckText(p.truck)}{p.rangeMi != null ? ` · ${p.rangeMi} mi left` : ''}</span><Svg d={EDIT} size={13} />
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
