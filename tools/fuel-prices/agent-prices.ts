import { BRAND_IDS, brandLabel, byPrice, parseQuery, stateName, storeNumberOf, titleCase, usd, type AgentStation, type PartnerBrand } from '../../support/common/discounts.js';
import { escHtml as esc } from '../../support/common/html.js';
import { excelSerial, fmtDMY, fmtDMYHM } from '../../support/common/time.js';
import type { Db } from '../../database/db.js';
import { env } from '../../support/helpers/env.js';
import { botApi, botSendDocument, botSendPhoto } from '../../support/helpers/telegram.js';
import { reportTimeZone } from '../../support/helpers/updates.js';
import { buildXlsx, type SheetSpec } from '../../support/helpers/xlsx.js';
import { agentStations, discountSettings } from './dataset.js';
import { cheapestByState, header, stateMessages, stationCard } from './driver-message.js';
import { cheapestImages, stateImages } from './table-image.js';

// The agents' fuel discount prices in a chat: answers to typed searches as clean tables to forward to
// a driver, "All N" and Excel files. Admins can search too and see exactly what agents see. Who may
// search is decided in telegram_bot/cftagents/handlers/<role>/.

/** Rows per state in a quick answer; "All N" sends the rest. */
export const QUICK_ROWS = 15;
const MAX_STATES = 10;
/** Inline buttons under price answers start with this (telegram_bot/cftagents/handlers/agents/fuel-search.ts answers them). */
export const DISCOUNT_CALLBACK = 'disc:';
const CALLBACK = DISCOUNT_CALLBACK;

const send = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

export const SEARCH_HELP = [
  '🔎 <b>How to search</b>',
  'Type a state, a station brand or both, for example:',
  '• <code>nebraska</code>',
  '• <code>texas pilot</code>',
  "• <code>loves iowa</code>",
  "• <code>north carolina love's 697</code> (one station by its number)",
  '• <code>pilot flying j loves</code> (cheapest in each state)',
  '',
  'Spelling mistakes and short names (TX, Cali, Penn) are fine. Put several states on separate lines to get them all at once.',
  '',
  'Partner stations: Pilot / Flying J, Love’s, TA / Petro, Speedway.',
].join('\n');

export const NO_DATA = '⛽ Fuel discounts are not loaded yet. An admin needs to update the prices first.';

const openApp = () => (env.appUrl ? [[{ text: '⛽ Open Discounts', web_app: { url: `${env.appUrl}/#/discounts` } }]] : []);

// ---- Choosing stations ----------------------------------------------------------------------------

export interface Selection {
  states: string[];
  brands: PartnerBrand[];
  cities?: string[];
  /** Only these stations (a search for a store number). */
  ids?: number[];
}

export function select(stations: AgentStation[], sel: Selection): AgentStation[] {
  const brands = new Set(sel.brands.length ? sel.brands : BRAND_IDS);
  const states = new Set(sel.states);
  const cities = new Set(sel.cities ?? []);
  const ids = sel.ids ? new Set(sel.ids) : null;
  return stations.filter((s) => brands.has(s.brand) && (!states.size || states.has(s.state)) && (!cities.size || (s.city != null && cities.has(s.city.toUpperCase()))) && (!ids || ids.has(s.id)));
}

/** Brands as one number for button data: Pilot 1, Love's 2, TA 4, Speedway 8. */
export const brandMask = (brands: PartnerBrand[]) => (brands.length ? brands : BRAND_IDS).reduce((m, b) => m | (1 << BRAND_IDS.indexOf(b)), 0);
export const maskBrands = (m: number) => BRAND_IDS.filter((_b, i) => m & (1 << i));

const groupByState = (stations: AgentStation[], order: string[]) => {
  const m = new Map<string, AgentStation[]>(order.map((s) => [s, []]));
  for (const s of stations) {
    if (!m.has(s.state)) m.set(s.state, []);
    m.get(s.state)!.push(s);
  }
  return [...m.entries()].map(([state, list]) => ({ state, stations: list }));
};

const brandNote = (brands: PartnerBrand[]) => (brands.length && brands.length < BRAND_IDS.length ? `\n<i>${brands.map(brandLabel).join(', ')} only</i>` : '');

async function context(db: Db) {
  const [{ pulledAt, stations }, tz] = await Promise.all([agentStations(db), reportTimeZone(db)]);
  return { pulledAt, stations, fmt: (d: Date | string) => fmtDMY(d, tz), tz };
}

async function adminNote(db: Db, admin: boolean): Promise<string> {
  if (!admin) return '';
  const s = await discountSettings(db);
  return `\n<i>Admin view: these are the agents’ prices (cabinet discount − ${usd(s.margin)}; smaller discounts are hidden).</i>`;
}

/**
 * Sends the tables for a selection. `quick` keeps each state to its cheapest few and adds "All N"
 * buttons; otherwise every station is listed. Returns how many stations were sent.
 */
export async function sendSelection(db: Db, chat_id: number, sel: Selection, opts: { quick?: boolean; admin?: boolean } = {}): Promise<number> {
  const { pulledAt, stations, fmt } = await context(db);
  if (!pulledAt) {
    await send(chat_id, NO_DATA);
    return 0;
  }
  const head = header(pulledAt, fmt) + brandNote(sel.brands) + (await adminNote(db, !!opts.admin));
  const picked = select(stations, sel);
  const order = sel.states.slice(0, MAX_STATES);
  const blocks = groupByState(picked.filter((s) => !order.length || order.includes(s.state)), order);
  const empty = blocks.filter((b) => !b.stations.length).map((b) => stateName(b.state));
  const full = blocks.filter((b) => b.stations.length);
  const mask = brandMask(sel.brands);

  if (!full.length) {
    const what = sel.cities?.length ? sel.cities.map(titleCase).join(', ') : empty.join(', ');
    await send(chat_id, `⛽ No ${sel.brands.length && sel.brands.length < 4 ? sel.brands.map(brandLabel).join(' / ') + ' ' : 'partner '}stations with a CFT discount in ${esc(what || 'this area')}.\n\n${SEARCH_HELP}`);
    return 0;
  }
  const notes = [
    empty.length ? `<i>No partner stations in ${esc(empty.join(', '))}.</i>` : null,
    sel.states.length > MAX_STATES ? `<i>Showing the first ${MAX_STATES} states. Send the rest in another message.</i>` : null,
  ].filter(Boolean).join('\n');

  const buttons: { text: string; callback_data?: string; web_app?: { url: string } }[][] = [];
  const narrowed = !!sel.cities?.length || !!sel.ids;
  if (opts.quick && !narrowed) {
    for (const b of full) if (b.stations.length > QUICK_ROWS) buttons.push([{ text: `All ${b.stations.length} in ${stateName(b.state)}`, callback_data: `${CALLBACK}all:${b.state}:${mask}` }]);
  }
  const codes = full.map((b) => b.state).join('');
  if (!narrowed && codes.length <= 48) buttons.push([{ text: '📥 Excel file', callback_data: `${CALLBACK}x:${codes}:${mask}` }]);
  if (opts.quick) buttons.push(...openApp());

  const markup = buttons.length ? { inline_keyboard: buttons } : undefined;
  const limit = opts.quick ? QUICK_ROWS : undefined;
  const date = fmt(pulledAt);
  const extra = brandNote(sel.brands) + (await adminNote(db, !!opts.admin));

  // The tables as pictures (Station · City · State · Retail Price · Discount · Discounted Price · Discounted Percent).
  let pictures: { png: Uint8Array; caption: string }[] | null = null;
  try {
    pictures = full.flatMap((b) => {
      const imgs = stateImages(b.stations, stateName(b.state), `Prices of ${date}`, limit);
      return imgs.map((png, i) => ({ png, caption: i === 0 ? stateCaption(b.state, b.stations, limit, date) + extra : '' }));
    });
  } catch (e) {
    console.error('[discounts] drawing the price table failed, sending text instead:', (e as Error).message);
  }
  if (pictures) {
    pictures[pictures.length - 1].caption = [pictures[pictures.length - 1].caption, notes].filter(Boolean).join('\n\n');
    for (const [i, p] of pictures.entries()) await botSendPhoto(chat_id, p.png, p.caption || undefined, { replyMarkup: i === pictures.length - 1 ? markup : undefined });
  } else {
    const messages = stateMessages(full, head, limit);
    if (notes) messages[messages.length - 1] += '\n\n' + notes;
    for (const [i, m] of messages.entries()) await send(chat_id, m, i === messages.length - 1 && markup ? { reply_markup: markup } : {});
  }
  // One station asked for by number: its address, exit and map link too.
  if (sel.ids && picked.length === 1) await send(chat_id, stationCard(picked[0], pulledAt, fmt), { disable_web_page_preview: true });
  return full.reduce((n, b) => n + (limit ? Math.min(limit, b.stations.length) : b.stations.length), 0);
}

/** "📍 Nebraska · 16 stations · save up to $1.71" and the line saying what the prices are. */
export function stateCaption(state: string, stations: AgentStation[], limit: number | undefined, date: string): string {
  const best = Math.max(0, ...stations.map((s) => s.saving ?? 0));
  const n = stations.length;
  const count = limit && n > limit ? `cheapest ${limit} of ${n} stations` : `${n} station${n === 1 ? '' : 's'}`;
  return `⛽ <b>${esc(stateName(state))}</b> · ${count}${best > 0 ? ` · save up to ${usd(best)}` : ''}\n<i>Per gallon with the CFT discount · prices of ${date}</i>`;
}

/** One station's card, for "Send to a driver" in the Mini App. */
export async function sendStation(db: Db, chat_id: number, id: number): Promise<boolean> {
  const { pulledAt, stations, fmt } = await context(db);
  const s = stations.find((x) => x.id === id);
  if (!s) return false;
  await send(chat_id, stationCard(s, pulledAt, fmt), { disable_web_page_preview: true });
  return true;
}

// ---- The Excel file -----------------------------------------------------------------------------

export function agentXlsx(stations: AgentStation[], pulledAt: Date | string, tz: string): Uint8Array {
  const rows = [...stations].sort((a, b) => a.state.localeCompare(b.state) || byPrice(a, b));
  const sheet: SheetSpec = {
    name: 'Discounts',
    columns: [
      { header: 'Station', width: 16 },
      { header: 'Brand', width: 16 },
      { header: 'CFT price', width: 11, style: 'price' },
      { header: 'Retail price', width: 12, style: 'price' },
      { header: 'Saving', width: 9, style: 'price' },
      { header: 'State', width: 7, style: 'center' },
      { header: 'City', width: 20 },
      { header: 'Address', width: 34 },
      { header: 'Highway / exit', width: 30 },
      { header: 'Price updated', width: 17, style: 'datetime' },
    ],
    rows: rows.map((s) => [
      s.name, brandLabel(s.brand), s.price, s.retail, s.saving, s.state, titleCase(s.city), s.address, s.exit,
      s.updatedAt ? excelSerial(s.updatedAt, tz) : null,
    ]),
    footer: [[{ v: `Prices of ${fmtDMYHM(pulledAt, tz)} · per gallon, with the CFT discount`, s: 'note' }]],
  };
  return buildXlsx([sheet], 'CFT fuel discounts');
}

export async function sendAgentExcel(db: Db, chat_id: number, sel: Selection): Promise<number> {
  const { pulledAt, stations, tz, fmt } = await context(db);
  if (!pulledAt) {
    await send(chat_id, NO_DATA);
    return 0;
  }
  const picked = select(stations, sel);
  if (!picked.length) {
    await send(chat_id, '⛽ No stations match, so there is no file to send.');
    return 0;
  }
  const part = sel.states.length && sel.states.length <= 4 ? sel.states.join('_') : sel.states.length ? `${sel.states.length}_states` : 'all_states';
  await botApi('sendChatAction', { chat_id, action: 'upload_document' }).catch(() => {});
  await botSendDocument(chat_id, `cft_discounts_${part}.xlsx`, agentXlsx(picked, pulledAt, tz), `⛽ <b>CFT fuel discounts</b> · ${picked.length} stations\n<i>${brandNote(sel.brands).trim() ? brandNote(sel.brands).trim().replace(/<\/?i>/g, '') + ' · ' : ''}Prices of ${fmt(pulledAt)}</i>`);
  return picked.length;
}

// ---- Typed searches ------------------------------------------------------------------------------

/**
 * Answers a typed search ("nebraska", "texas pilot", "loves 697") with price tables. `admin` adds a
 * line saying these are the agents' prices.
 */
export async function answerSearch(db: Db, chat_id: number, text: string, admin: boolean): Promise<void> {
  const { pulledAt, stations } = await agentStations(db);
  if (!pulledAt) {
    await send(chat_id, NO_DATA);
    return;
  }
  const cities = [...new Set(stations.map((s) => s.city?.toUpperCase()).filter((c): c is string => !!c))];
  const q = parseQuery(text, cities);

  if (q.ambiguous && !q.states.length && !q.cities.length) {
    const mask = brandMask(q.brands);
    await send(chat_id, `Which one do you mean by “${esc(q.ambiguous.word)}”?`, {
      reply_markup: { inline_keyboard: [q.ambiguous.states.map((s) => ({ text: stateName(s), callback_data: `${CALLBACK}s:${s}:${mask}` }))] },
    });
    return;
  }
  // Store numbers ("north carolina love's 697"): just those stations.
  if (q.numbers.length) {
    const hits = select(stations, { states: q.states, brands: q.brands, cities: q.cities }).filter((s) => q.numbers.includes(storeNumberOf(s.name) ?? ''));
    if (!hits.length) {
      const what = [q.brands.length ? q.brands.map(brandLabel).join(' / ') : 'station', q.numbers.map((n) => '#' + n).join(', ')].join(' ');
      const where = q.states.length ? ` in ${q.states.map(stateName).join(', ')}` : q.cities.length ? ` in ${q.cities.map(titleCase).join(', ')}` : '';
      await send(chat_id, `⛽ No ${esc(what)}${esc(where)} in the agents’ price list. It may not be a partner station, or its discount is 20¢ or less.\n\nTry the state on its own (for example “${q.states[0] ? stateName(q.states[0]).toLowerCase() : 'texas'}”) to see every station there.`);
      return;
    }
    await sendSelection(db, chat_id, { states: [...new Set(hits.map((s) => s.state))], brands: [], ids: hits.map((s) => s.id) }, { quick: true, admin });
    return;
  }
  if (!q.states.length && !q.cities.length && !q.brands.length) {
    await send(chat_id, `I couldn’t find a state or station in “${esc(text.slice(0, 60))}”.\n\n${SEARCH_HELP}`);
    return;
  }
  if (!q.states.length && !q.cities.length) {
    const { fmt } = await context(db);
    const chosen = select(stations, { states: [], brands: q.brands });
    const markup = { inline_keyboard: openApp() };
    try {
      const imgs = cheapestImages(chosen, `Prices of ${fmt(pulledAt)}`);
      const states = new Set(chosen.map((s) => s.state)).size;
      const caption = `⛽ <b>Cheapest in each state</b> · ${chosen.length.toLocaleString('en-US')} stations in ${states} states${brandNote(q.brands)}${await adminNote(db, admin)}\n<i>Type a state (for example “texas”) to see all its stations.</i>`;
      for (const [i, png] of imgs.entries()) await botSendPhoto(chat_id, png, i === 0 ? caption : undefined, { replyMarkup: i === imgs.length - 1 ? markup : undefined });
    } catch (e) {
      console.error('[discounts] drawing the price table failed, sending text instead:', (e as Error).message);
      const msgs = cheapestByState(chosen, header(pulledAt, fmt) + brandNote(q.brands) + (await adminNote(db, admin)));
      for (const [i, m] of msgs.entries()) await send(chat_id, m, i === msgs.length - 1 ? { reply_markup: markup } : {});
    }
    return;
  }
  // A city with no state: the states that city is in.
  const states = q.states.length ? q.states : [...new Set(select(stations, { states: [], brands: q.brands, cities: q.cities }).map((s) => s.state))];
  await sendSelection(db, chat_id, { states: states.length ? states : q.states, brands: q.brands, cities: q.cities }, { quick: true, admin });
}

