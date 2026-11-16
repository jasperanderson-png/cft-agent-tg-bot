import { useEffect, useMemo, useState } from 'react';
import type { DriverStation } from '../../../../../shared/types';
import { byPrice, type AgentStation, type PartnerBrand } from '../../../../../shared/discounts';
import { payPrice, savingOf } from '../../../../../shared/driverRoute';
import { Icon, useToast } from '../../components/ui';
import { haptic, useBackButton } from '../../lib/telegram';
import { Picker, Results, StationSheet } from '../agents/Discounts';

// "By state" on the drivers' route map: the agents' own Find discounts picker, result list and
// station sheet (screens/agents/Discounts.tsx), so the two screens are the same. Drivers get the
// My route / By state switch on top and "Route here" on a station instead of the agents' sharing.
// Phones: a full screen, like the agents'. Wide screens: a panel on the left; the map stays visible
// and shows the stations picked (DriverMap draws them from `onPicked`).

const BRAND: Record<DriverStation['brand'], PartnerBrand> = { p: 'pilot', l: 'loves', t: 'ta', s: 'speedway' };

/** A driver-map station in the agents' shape (same prices: the agents' prices). */
const asAgent = (s: DriverStation): AgentStation => ({
  id: s.id, brand: BRAND[s.brand], name: s.station, state: s.state ?? '', city: s.city, address: s.address, exit: null,
  price: payPrice(s) ?? 0, retail: s.retail, saving: round3(savingOf(s)), updatedAt: s.updatedAt,
});
const round3 = (n: number | null) => (n == null ? null : Math.round(n * 1000) / 1000);

export function ByState({ stations, fetchedAt, routing, onRouteTo, onMyRoute, onPicked, mapTap, onOpenChange }: {
  stations: DriverStation[] | null;
  fetchedAt: string | null;
  routing: boolean;
  onRouteTo: (s: DriverStation) => void;
  onMyRoute: () => void;
  /** The stations picked, for the map on wide screens. */
  onPicked: (ids: number[]) => void;
  /** A station tapped on the map beside the panel (wide screens): its card opens here. */
  mapTap: { id: number; n: number } | null;
  /** The station whose card is open, for the map to highlight. */
  onOpenChange: (id: number | null) => void;
}) {
  const [states, setStates] = useState<string[]>([]);
  const [brands, setBrands] = useState<PartnerBrand[]>([]);
  const [text, setText] = useState('');
  const [view, setView] = useState<'pick' | 'results'>('pick');
  const [open, setOpen] = useState<AgentStation | null>(null);
  const [toastNode, toast] = useToast();

  const all = useMemo(() => (stations ?? []).filter((s) => s.state).map(asAgent), [stations]);
  const cities = useMemo(() => [...new Set(all.map((s) => s.city?.toUpperCase()).filter((c): c is string => !!c))], [all]);
  const picked = useMemo(
    () => all.filter((s) => (!brands.length || brands.includes(s.brand)) && (!states.length || states.includes(s.state))).sort(byPrice),
    [all, brands, states],
  );
  useEffect(() => onPicked(picked.map((s) => s.id)), [picked]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const s = mapTap ? all.find((x) => x.id === mapTap.id) : undefined;
    if (s) setOpen(s);
  }, [mapTap]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onOpenChange(open?.id ?? null), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onOpenChange(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  useBackButton(open ? () => setOpen(null) : view === 'results' ? () => setView('pick') : onMyRoute);

  const tabs = (
    <div className="d-tabs" role="tablist" aria-label="Find fuel">
      <button type="button" role="tab" aria-selected={false} onClick={() => { haptic.select(); onMyRoute(); }}>My route</button>
      <button type="button" role="tab" aria-selected>By state</button>
    </div>
  );
  const routeHere = (s: AgentStation) => {
    const d = stations?.find((x) => x.id === s.id);
    if (d && routing) { haptic.tap(); onRouteTo(d); }
  };

  return (
    <div className="dm-bystate">
      {view === 'results' ? (
        <Results
          stations={picked} states={states} brands={brands} pulledAt={fetchedAt}
          onEdit={() => setView('pick')} onOpen={setOpen} toast={toast} foot={null} hint="Tap a station for its address and a truck route."
        />
      ) : (
        <Picker
          ready={!!stations} pulledAt={fetchedAt} head={tabs}
          all={all} cities={cities} states={states} brands={brands} text={text} picked={picked}
          setStates={setStates} setBrands={setBrands} setText={setText}
          onShow={() => setView('results')} toast={toast}
        />
      )}
      {open && (
        <StationSheet
          s={open} pulledAt={fetchedAt} onClose={() => setOpen(null)} toast={toast}
          actions={(
            <button type="button" className="d-cta" disabled={!routing} onClick={() => routeHere(open)}>
              <Icon name="pin" />{routing ? 'Route here' : 'Routes are not on yet'}
            </button>
          )}
        />
      )}
      {toastNode}
    </div>
  );
}
