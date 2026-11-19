import { useRef, useState, type ReactNode } from 'react';
import type { DriverStation, TruckProfile } from '../../../../../support/common/types';
import { BRANDS, payPrice, priceAge, rangeOf, savingOf } from '../../../../../support/common/driver-route';
import { titleCase } from '../../../../../support/common/discounts';
import { fmtDate } from '../../components/ui';

// The drivers' map: small shared parts (cards, sheets, icons, formatting), used by DriverMap.tsx and
// ByState.tsx.

export const DEFAULT_TRUCK: TruckProfile = { heightIn: 162, weightLb: 80_000, hazmat: false };

export const money = (n: number | null | undefined) => (n == null ? '—' : '$' + n.toFixed(2));
export const placeOf = (s: DriverStation) => [titleCase(s.city ?? ''), s.state].filter(Boolean).join(', ');
export const fullAddress = (s: DriverStation) => [s.address, titleCase(s.city ?? ''), s.state].filter(Boolean).join(', ');
export const firstPart = (s: string) => s.split(',')[0].trim();
export const dist = (mi: number) => (mi < 0.1 ? `${Math.max(50, Math.round((mi * 5280) / 50) * 50)} ft` : mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`);
export const truckText = (t: TruckProfile) => `${Math.floor(t.heightIn / 12)}'${t.heightIn % 12}" · ${t.weightLb.toLocaleString('en-US')} lb${t.hazmat ? ' · hazmat' : ''}`;
export const pct = (v: number, total?: number) => (total ? `${Math.max(0, Math.min(100, (v / total) * 100)).toFixed(1)}%` : '0%');

/** Per-viewer conveniences only (the truck, the voice switch); the page works without them. */
export function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: not remembered */
  }
}


export function TruckSheet({ truck, rangeMi, onClose, onSave }: { truck: TruckProfile; rangeMi: number | null; onClose: () => void; onSave: (t: TruckProfile, rangeMi: number | null) => void }) {
  const [ft, setFt] = useState(Math.floor(truck.heightIn / 12));
  const [inch, setInch] = useState(truck.heightIn % 12);
  const [lb, setLb] = useState(String(truck.weightLb));
  const [hz, setHz] = useState(truck.hazmat);
  const [range, setRange] = useState(rangeMi != null ? String(rangeMi) : '');
  const weight = Number(lb.replace(/[^\d]/g, ''));
  const okWeight = weight >= 10_000 && weight <= 120_000;
  const okRange = !range.trim() || rangeOf(range) != null;
  return (
    <>
      <button className="dm-scrim" aria-label="Close truck settings" onClick={onClose} />
      <section className="dm-sheet dm-trucksheet" role="dialog" aria-label="Your truck">
        <div className="dm-swap">
          <div>
            <span className="dm-eyebrow">YOUR TRUCK</span>
            <p style={{ margin: '6px 0 0', fontSize: 14, color: '#aaa', lineHeight: 1.4 }}>Routes avoid low bridges, weight limits and roads closed to trucks where the map knows them. Always follow road signs.</p>
          </div>
          <div className="dm-grid2">
            <label className="dm-cell dm-field"><span>Height</span>
              <span style={{ display: 'flex', gap: 6 }}>
                <select value={ft} onChange={(e) => setFt(Number(e.target.value))} aria-label="Feet">{[10, 11, 12, 13, 14].map((v) => <option key={v} value={v}>{v}′</option>)}</select>
                <select value={inch} onChange={(e) => setInch(Number(e.target.value))} aria-label="Inches">{Array.from({ length: 12 }, (_v, i) => <option key={i} value={i}>{i}″</option>)}</select>
              </span>
            </label>
            <label className="dm-cell dm-field"><span>Weight, lb</span>
              <input inputMode="numeric" value={lb} onChange={(e) => setLb(e.target.value)} aria-invalid={!okWeight} />
            </label>
          </div>
          <button className="dm-cell dm-switch" role="switch" aria-checked={hz} onClick={() => setHz((v) => !v)}>
            <span><b>Hazardous materials</b><span>Avoid roads and tunnels closed to hazmat</span></span><i />
          </button>
          <label className="dm-cell dm-field"><span>Miles until empty (optional)</span>
            <input inputMode="numeric" placeholder="e.g. 450" value={range} onChange={(e) => setRange(e.target.value)} aria-invalid={!okRange} />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="dm-primary" disabled={!okWeight || !okRange} onClick={() => onSave({ heightIn: ft * 12 + inch, weightLb: weight, hazmat: hz }, rangeOf(range))}>Save</button>
            <button className="dm-soft" onClick={() => onSave(DEFAULT_TRUCK, null)}>Standard</button>
          </div>
          {!okWeight && <span style={{ fontSize: 13, color: '#f28b82' }}>Weight: 10,000 to 120,000 lb.</span>}
          {!okRange && <span style={{ fontSize: 13, color: '#f28b82' }}>Miles until empty: a number from 1 to 3,000, or leave it empty.</span>}
        </div>
      </section>
    </>
  );
}

/** The arrow for an OpenRouteService maneuver type. */
export function turnIcon(type: number): string {
  switch (type) {
    case 0: case 2: return TURN_LEFT;
    case 1: case 3: return TURN_RIGHT;
    case 4: case 12: return SLIGHT_LEFT;
    case 5: case 13: return SLIGHT_RIGHT;
    case 7: case 8: return ROUNDABOUT;
    case 9: return UTURN;
    default: return STRAIGHT;
  }
}

// ---- pieces

/** How old the price is: "5 h ago", and an amber "Old price" tag past DRIVER_MAP.stalePriceHours. */
export function PriceAge({ at }: { at: string | null }) {
  const age = priceAge(at);
  if (!age) return null;
  return (
    <span className={'dm-age' + (age.stale ? ' old' : '')} title={fmtDate(at)}>
      {age.stale && <b>Old price · </b>}{age.text}
    </span>
  );
}

export function StationCard({ s, badge, near, detail, onToggle, primary, onPrimary, note }: { s: DriverStation; badge: string; near: boolean; detail: boolean; onToggle: () => void; primary: string; onPrimary: () => void; note?: { text: string; warn?: boolean } | null }) {
  const save = savingOf(s);
  return (
    <div className="dm-swap" key={s.id}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span className={'dm-badge' + (near ? ' near' : '')}>{badge}</span>
          <b className="num" style={{ display: 'block', marginTop: 6, fontSize: 21, lineHeight: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.station}</b>
          <span style={{ display: 'block', marginTop: 4, fontSize: 14, color: '#ccc' }}>{placeOf(s)}</span>
        </div>
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <b className="num" style={{ fontSize: 34, lineHeight: 0.85, color: '#a0dcff' }}>{money(payPrice(s))}</b>
          {s.discounted != null && s.retail != null && <s style={{ marginTop: 4, fontSize: 13, color: '#999' }}>{money(s.retail)}</s>}
          <PriceAge at={s.updatedAt} />
        </span>
      </div>
      {note && <span className={'dm-cardnote' + (note.warn ? ' warn' : '')}>{note.text}</span>}
      <Collapse open={detail}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, fontSize: 15, lineHeight: 1.4, color: '#ddd' }}><Svg d={PIN} size={18} color="#a0dcff" />{fullAddress(s)}</div>
          <dl className="dm-grid2" style={{ margin: 0 }}>
            <div className="dm-cell"><dt>You save</dt><dd className="num" style={{ fontSize: 20, color: '#a0dcff' }}>{save != null ? `${money(save)} / gal` : 'No discount'}</dd></div>
            <div className="dm-cell"><dt>On 150 gal</dt><dd className="num" style={{ fontSize: 20 }}>{save != null ? money(save * 150) : '—'}</dd></div>
            <div className="dm-cell"><dt>Brand</dt><dd style={{ fontSize: 16, fontWeight: 600 }}>{BRANDS[s.brand].label}</dd></div>
            <div className="dm-cell"><dt>Price updated</dt><dd style={{ fontSize: 16, fontWeight: 600 }}>{fmtDate(s.updatedAt)}<br /><PriceAge at={s.updatedAt} /></dd></div>
          </dl>
        </div>
      </Collapse>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="dm-primary" onClick={onPrimary}><Svg d={NAV} size={20} />{primary}</button>
        <button className="dm-soft" aria-label={detail ? 'Hide station details' : 'Show station details'} onClick={onToggle}>
          <span style={{ display: 'grid', transition: 'transform .3s', transform: `rotate(${detail ? 180 : 0}deg)` }}><Svg d="m18 15-6-6-6 6" size={20} w={2.2} /></span>
        </button>
      </div>
    </div>
  );
}

/**
 * One of the best stations on a planned route (the card's main row): rank, name, price and a compact Go.
 * Tap the name for the address and savings; swipe sideways (or ‹ ›) for the next best.
 */
export function PickRow({ s, rank, count, sub, detail, onToggle, onPrev, onNext, go, onGo, showSave = false, note }: {
  s: DriverStation; rank: number | null; count: number; sub: string; detail: boolean; showSave?: boolean;
  /** Under the row: the real detour and whether the truck gets there before empty. */
  note?: { text: string; warn?: boolean } | null;
  onToggle: () => void; onPrev: () => void; onNext: () => void; go: string | null; onGo: () => void;
}) {
  const save = savingOf(s);
  const x0 = useRef<number | null>(null);
  return (
    <div
      className="dm-swap"
      key={s.id}
      onTouchStart={(e) => { x0.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        const from = x0.current;
        x0.current = null;
        if (from == null || count < 2) return;
        const dx = e.changedTouches[0].clientX - from;
        if (dx < -45) onNext();
        else if (dx > 45) onPrev();
      }}
    >
      <div className="dm-pick">
        <button type="button" className="dm-pick-main" aria-expanded={detail} aria-label={`${s.station}, ${placeOf(s)}. ${detail ? 'Hide' : 'Show'} details`} onClick={onToggle}>
          {rank != null ? <span className="dm-rank">{rank + 1}</span> : <span className="dm-rank off" style={{ background: BRANDS[s.brand].color }}>{BRANDS[s.brand].letter}</span>}
          <span className="dm-pick-text"><b>{s.station}</b><span>{sub}</span></span>
        </button>
        <span className="dm-pick-price">
          <b className="num">{money(payPrice(s))}</b>
          {showSave && save != null ? <small className="save">save {money(save)}</small> : save != null && s.retail != null ? <s>{money(s.retail)}</s> : <small>retail</small>}
        </span>
        <button type="button" className="dm-go" disabled={!go} onClick={onGo} aria-label={go ? `Navigate to ${s.station}` : 'Finding the way'}>
          {go ? <><Svg d={NAV} size={16} />{go}</> : <span className="dm-spin" />}
        </button>
      </div>
      {note && <span className={"dm-cardnote" + (note.warn ? " warn" : "")}>{note.text}</span>}
      <Collapse open={detail}>
        <div className="dm-pick-more">
          <span><Svg d={PIN} size={15} color="#a0dcff" />{fullAddress(s)}</span>
          <span>{save != null ? `Save ${money(save)}/gal · ${money(save * 150)} on 150 gal` : 'No CFT discount here'}</span>
          <PriceAge at={s.updatedAt} />
        </div>
      </Collapse>
    </div>
  );
}

export function PriceBox({ s }: { s: DriverStation }) {
  const save = savingOf(s);
  return (
    <div className="dm-cell" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14 }}>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', fontSize: 12, color: '#999' }}>Your price</span>
        <b className="num" style={{ fontSize: 34, lineHeight: 1, color: '#a0dcff' }}>{money(payPrice(s))}</b><span style={{ fontSize: 12, color: '#8aa3ae' }}> /gal</span>
        <PriceAge at={s.updatedAt} />
      </span>
      {save != null && (
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <s style={{ fontSize: 13, color: '#999' }}>retail {money(s.retail)}</s>
          <span className="dm-save" style={{ height: 24, fontSize: 12, padding: '0 8px' }}>Save {money(save)} / gal</span>
        </span>
      )}
    </div>
  );
}

export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return <div className={'dm-collapse' + (open ? '' : ' shut')}><div><div>{children}</div></div></div>;
}


// ---- icons (stroke paths in a 24×24 box)
export const X = 'M18 6 6 18 M6 6l12 12';
export const CHECK = 'M20 6 9 17l-5-5';
export const PIN = 'M20 10c0 4.99-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0 M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0';
export const NAV = 'M3 11 22 2l-9 19-2-8-8-2z';
export const LOCATE = 'M2 12h3 M19 12h3 M12 2v3 M12 19v3 M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0';
export const STRAIGHT = 'M12 20V4 M5 11l7-7 7 7';
export const TURN_RIGHT = 'M6 20v-7a4 4 0 0 1 4-4h9 M15 5l4 4-4 4';
export const TURN_LEFT = 'M18 20v-7a4 4 0 0 0-4-4H5 M9 5 5 9l4 4';
export const SLIGHT_RIGHT = 'M8 20v-6l8-8 M10 6h6v6';
export const SLIGHT_LEFT = 'M16 20v-6L8 6 M14 6H8v6';
export const UTURN = 'M7 20V10a5 5 0 0 1 10 0v8 M13 14l4 4 4-4';
export const ROUNDABOUT = 'M12 21v-6 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M14.1 9.9 18 6 M14 6h4v4';
export const SOUND = 'M11 5 6 9H2v6h4l5 4V5z M15.54 8.46a5 5 0 0 1 0 7.07 M19.07 4.93a10 10 0 0 1 0 14.14';
export const MUTE = 'M11 5 6 9H2v6h4l5 4V5z M22 9l-6 6 M16 9l6 6';
export const EDIT = 'M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z';
export const TRUCK_PATH = 'M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2 M15 18H9 M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62L18.3 9.38a1 1 0 0 0-.78-.38H14 M19 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M9 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0';

export function Svg({ d, size = 18, w = 2, color }: { d: string; size?: number; w?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? 'currentColor'} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d={d} />
    </svg>
  );
}

export function Truck({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: 'scaleX(-1)' }}><path d={TRUCK_PATH} /></svg>;
}
