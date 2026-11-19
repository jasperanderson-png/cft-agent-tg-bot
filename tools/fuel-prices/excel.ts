import { excelSerial, fmtDMYHM } from '../../support/common/time.js';
import { buildXlsx, type Cell, type SheetSpec, type Style } from '../../support/helpers/xlsx.js';
import type { Extraction, Station } from './cabinet.js';
import { fuelInsights, where } from './insights.js';

export const FUEL_FILENAME = 'fuel_prices.xlsx';
export const FUEL_HEADERS = ['Station', 'Retail price', 'Discounted price', 'Updated time', 'State', 'City', 'Address'] as const;
const SOURCE = 'https://cabinet.united-fuel.com/dashboard/station';

const COLUMNS: { style?: Style; value: (s: Station, tz: string) => Cell; width: (s: Station) => number }[] = [
  { value: (s) => s.station, width: (s) => s.station.length },
  { style: 'price', value: (s) => s.retailPrice, width: (s) => priceWidth(s.retailPrice) },
  { style: 'price', value: (s) => s.discountedPrice, width: (s) => priceWidth(s.discountedPrice) },
  { style: 'datetime', value: (s, tz) => (s.updatedAt ? excelSerial(s.updatedAt, tz) : null), width: () => 16 },
  { style: 'center', value: (s) => s.state, width: (s) => s.state?.length ?? 0 },
  { value: (s) => s.city, width: (s) => s.city?.length ?? 0 },
  { value: (s) => s.address, width: (s) => s.address?.length ?? 0 },
];
/** "$5.099": the dollar sign, at least two decimals, and every decimal the cabinet sent. */
const priceWidth = (p: number | null) => (p == null ? 0 : Math.max(5, String(p).length) + 2);

/** Column widths that fit the longest value (within reason), like Excel's "AutoFit". */
function autoWidths(stations: Station[]): number[] {
  return COLUMNS.map((c, i) => {
    let w = FUEL_HEADERS[i].length;
    for (const s of stations) w = Math.max(w, c.width(s));
    return Math.min(60, Math.max(8, w + 2));
  });
}

const price = (p: number | null): Cell => (p == null ? null : { v: p, s: 'price' });
const count = (n: number): Cell => ({ v: n, s: 'int' });
const label = (t: string): Cell => ({ v: t, s: 'bold' });
const section = (t: string): Cell[] => [{ v: t.toUpperCase(), s: 'note' }];
/** Grey text on one line; it runs on into the empty cells beside it. */
const note = (t: string): Cell => ({ v: t, s: 'note' });

/**
 * The workbook:
 *   Stations   one row per station, the columns the cabinet's list shows (filters, frozen header, total under it)
 *   By state   stations and prices per state
 *   Summary    the figures at a glance, how the download was checked, and how to read the file
 */
export function fuelPricesXlsx(x: Extraction, tz: string, now = new Date()): Uint8Array {
  const widths = autoWidths(x.stations);
  const f = fuelInsights(x.stations);
  const complete = x.stations.length === x.siteTotal;

  const stations: SheetSpec = {
    name: 'Stations',
    columns: FUEL_HEADERS.map((header, i) => ({ header, width: widths[i], style: COLUMNS[i].style })),
    rows: x.stations.map((s) => COLUMNS.map((c) => c.value(s, tz))),
    footer: [[{ v: 'Total stations', s: 'bold' }, count(x.stations.length)]],
  };

  const byState: SheetSpec = {
    name: 'By state',
    columns: [
      { header: 'State', width: 8, style: 'center' },
      { header: 'Stations', width: 10, style: 'int' },
      { header: 'Cheapest discounted', width: 20, style: 'price' },
      { header: 'Average discounted', width: 19, style: 'price' },
      { header: 'Average retail', width: 15, style: 'price' },
      { header: 'Average saving', width: 15, style: 'price' },
    ],
    rows: f.byState.map((s) => [s.state, s.stations, s.cheapestDiscounted, s.avgDiscounted, s.avgRetail, s.avgSaving]),
    footer: [[{ v: 'All states', s: 'bold' }, count(f.stations), price(f.cheapest?.price ?? null), price(f.avgDiscounted), price(f.avgRetail), price(f.avgSaving)]],
  };

  const summary: SheetSpec = {
    name: 'Summary',
    table: false,
    columns: [{ header: '', width: 30 }, { header: '', width: 14 }, { header: '', width: 100 }],
    rows: [
      [{ v: '⛽ Fuel prices — all stations', s: 'title' }],
      [note(`Downloaded ${fmtDMYHM(now, tz)} (${tz} time) from the United Fuel cabinet`)],
      [],
      section('At a glance'),
      [label('Stations'), count(f.stations), note(`in ${f.states} state${f.states === 1 ? '' : 's'}`)],
      [label('With a discounted price'), count(f.withDiscount)],
      [label('Retail price only'), count(f.retailOnly), note('The cabinet shows no discounted price for these stations')],
      [label('Cheapest discounted price'), price(f.cheapest?.price ?? null), note(f.cheapest ? where(f.cheapest.station) : '')],
      [label('Average discounted price'), price(f.avgDiscounted), note('Per gallon, stations with a discounted price')],
      [label('Average retail price'), price(f.avgRetail), note('Per gallon, all stations')],
      [label('Average saving'), price(f.avgSaving), note('Retail minus discounted, per gallon')],
      [label('Biggest saving'), price(f.biggestSaving?.saving ?? null), note(f.biggestSaving ? where(f.biggestSaving.station) : '')],
      [],
      section('Checks'),
      [label('Stations the cabinet reports'), count(x.siteTotal)],
      [label('Stations in this file'), count(x.stations.length), note(complete ? '✓ Complete: every station, each one once' : 'Incomplete')],
      [label('Requests to the cabinet'), count(x.pagesRead)],
      [],
      section('How to read this file'),
      [label('Stations sheet'), null, note('One row per station. Use the arrows in the header row to sort or filter by state, city or price.')],
      [label('By state sheet'), null, note('How many stations each state has, and its cheapest and average prices.')],
      [label('Prices'), null, note('US dollars per gallon, exactly as the cabinet shows them. Averages are rounded to a tenth of a cent.')],
      [label('Discounted price'), null, note('The discounted price the cabinet shows for your account. An empty cell means it shows none.')],
      [label('Updated time'), null, note(`When the station's price last changed, in ${tz} time.`)],
      [label('Source'), null, note(SOURCE)],
    ],
  };
  return buildXlsx([stations, byState, summary], 'Fuel prices');
}
