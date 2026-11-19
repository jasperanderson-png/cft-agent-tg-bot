import type { DriverRoute, DriverStation } from '../../../../../support/common/types';
import { BRAND_ORDER, BRANDS, type DriverBrand, type Placed } from '../../../../../support/common/driver-route';
import { fmtDuration as hm } from '../../components/ui';
import { haptic } from '../../lib/telegram';
import { NAV, PickRow, placeOf, Svg } from './pieces';
import { SHOW_LABEL, SHOWS, type Show } from './drive-shared';

interface Props {
  route: DriverRoute;
  /** The stations the card offers (the best three, or all) and the position of the chosen one in it. */
  top: Placed<DriverStation>[];
  selRank: number;
  page: (step: number) => void;
  rankBy: Show;
  pickRank: (r: Show) => void;
  brandSel: DriverBrand[];
  pickBrand: (b: DriverBrand | null) => void;
  brandText: string;
  selPlaced: Placed<DriverStation> | null;
  /** The chosen station is on the route (not only near it). */
  selOn: boolean;
  /** Miles a stop off the route adds, when known. */
  extraMi: number | null;
  selNote: { text: string; warn: boolean } | null;
  detail: boolean;
  toggleDetail: () => void;
  /** Navigation can start through the chosen station. */
  canGo: boolean;
  startTrip: () => void;
  /** Stations on or near the route at all. */
  anyStations: boolean;
}

/** The planned route: time and miles, the station choice (ranking, brands, the chosen one) and Go. */
export function RouteCard(p: Props) {
  const { route, top, selRank, selPlaced } = p;
  return (
    <>
      <div className="dm-summary">
        <b>{hm(route.durationS)}</b>
        <span>{Math.round(route.totalMi).toLocaleString('en-US')} mi{route.delayMin ? ` · ${route.delayMin} min traffic` : ''}{route.source === 'tomtom' && !route.delayMin ? ' · live traffic' : ''}</span>
        {top.length > 1 && (
          <span className="dm-pager">
            <button type="button" aria-label="Previous station" onClick={() => p.page(-1)}><Svg d="m15 18-6-6 6-6" size={15} w={2.4} /></button>
            <span>{(selRank < 0 ? 0 : selRank) + 1}/{top.length}</span>
            <button type="button" aria-label="Next station" onClick={() => p.page(1)}><Svg d="m9 18 6-6-6-6" size={15} w={2.4} /></button>
          </span>
        )}
      </div>
      <div className="dm-seg" role="radiogroup" aria-label="Show stations">
        {SHOWS.map((r) => (
          <button key={r} type="button" role="radio" aria-checked={p.rankBy === r} onClick={() => p.pickRank(r)}>{SHOW_LABEL[r]}</button>
        ))}
      </div>
      <div className="dm-brands" role="group" aria-label="Brands">
        <button type="button" className="dm-opt" aria-pressed={!p.brandSel.length} onClick={() => p.pickBrand(null)}>All</button>
        {BRAND_ORDER.map((b) => (
          <button key={b} type="button" className="dm-opt" aria-pressed={p.brandSel.includes(b)} aria-label={BRANDS[b].label} onClick={() => p.pickBrand(b)}>
            <i style={{ background: BRANDS[b].color }} />{BRANDS[b].short}
          </button>
        ))}
      </div>
      {selPlaced ? (
        <PickRow
          s={selPlaced.item}
          rank={selRank >= 0 && p.rankBy !== 'all' ? selRank : null}
          count={top.length}
          sub={[
            placeOf(selPlaced.item),
            p.selOn ? 'on your route' : p.extraMi != null ? `+${p.extraMi} mi` : `${Math.round(selPlaced.offMi)} mi off`,
          ].join(' · ')}
          showSave={p.rankBy === 'disc'}
          note={p.selNote}
          detail={p.detail} onToggle={() => { haptic.tap(); p.toggleDetail(); }}
          onPrev={() => p.page(-1)} onNext={() => p.page(1)}
          go={p.canGo ? 'Go' : null} onGo={() => { if (p.canGo) p.startTrip(); }}
        />
      ) : (
        <div className="dm-pick">
          <p className="dm-note" style={{ flex: 1, fontSize: 14 }}>{p.anyStations ? `No ${p.brandText} stations on or near this route.` : 'No CFT stations along this route.'}</p>
          <button type="button" className="dm-go" onClick={() => p.startTrip()}><Svg d={NAV} size={16} />Go</button>
        </div>
      )}
    </>
  );
}
