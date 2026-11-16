import type { Station } from './cabinet.js';

// Figures about one download, shared by the Telegram caption and the Excel file's Summary and By state sheets.

export interface StateFigures {
  state: string;
  stations: number;
  cheapestDiscounted: number | null;
  avgDiscounted: number | null;
  avgRetail: number | null;
  avgSaving: number | null;
}

export interface FuelInsights {
  stations: number;
  states: number;
  withDiscount: number;
  retailOnly: number;
  cheapest: { price: number; station: Station } | null;
  biggestSaving: { saving: number; station: Station } | null;
  avgDiscounted: number | null;
  avgRetail: number | null;
  avgSaving: number | null;
  byState: StateFigures[];
}

/** Averages are calculated figures, so they are rounded to a tenth of a cent; prices themselves never are. */
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null);
const saving = (s: Station) => (s.retailPrice != null && s.discountedPrice != null ? Math.round((s.retailPrice - s.discountedPrice) * 10_000) / 10_000 : null);

function figures(list: Station[]) {
  const disc = list.flatMap((s) => (s.discountedPrice == null ? [] : [s.discountedPrice]));
  return {
    cheapestDiscounted: disc.length ? Math.min(...disc) : null,
    avgDiscounted: avg(disc),
    avgRetail: avg(list.flatMap((s) => (s.retailPrice == null ? [] : [s.retailPrice]))),
    avgSaving: avg(list.flatMap((s) => (saving(s) == null ? [] : [saving(s)!]))),
  };
}

export function fuelInsights(stations: Station[]): FuelInsights {
  let cheapest: FuelInsights['cheapest'] = null;
  let biggest: FuelInsights['biggestSaving'] = null;
  const byState = new Map<string, Station[]>();
  for (const s of stations) {
    if (s.discountedPrice != null && (!cheapest || s.discountedPrice < cheapest.price)) cheapest = { price: s.discountedPrice, station: s };
    const sv = saving(s);
    if (sv != null && sv > 0 && (!biggest || sv > biggest.saving)) biggest = { saving: sv, station: s };
    if (s.state) byState.set(s.state, [...(byState.get(s.state) ?? []), s]);
  }
  const all = figures(stations);
  return {
    stations: stations.length,
    states: byState.size,
    withDiscount: stations.filter((s) => s.discountedPrice != null).length,
    retailOnly: stations.filter((s) => s.discountedPrice == null).length,
    cheapest,
    biggestSaving: biggest,
    avgDiscounted: all.avgDiscounted,
    avgRetail: all.avgRetail,
    avgSaving: all.avgSaving,
    byState: [...byState.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([state, list]) => ({ state, stations: list.length, ...figures(list) })),
  };
}

/** "$5.099": at least two decimals, and every decimal the value has. */
export const usd = (p: number) => '$' + p.toFixed(Math.max(2, (String(p).split('.')[1] ?? '').length));
const title = (s: string) => s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
/** "Speedway-46161, Cicero, IL" */
export const where = (s: Station) => [s.station, s.city ? title(s.city) : null, s.state].filter(Boolean).join(', ');
