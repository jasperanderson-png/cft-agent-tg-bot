import { byPrice, stateName, titleCase, usd, type AgentStation } from '../../shared/discounts.js';

// The messages agents forward to drivers: one clean table per state, cheapest first. Tables are
// monospace (<pre>) and at most 32 characters wide, so they line up on a phone without wrapping.

export const TABLE_WIDTH = 32;
/** Telegram allows 4,096 characters per message; leave room for the tags. */
const MESSAGE_LIMIT = 3800;

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cut = (s: string, w: number) => (s.length <= w ? s : s.slice(0, Math.max(1, w - 1)).trimEnd() + '…');
const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
const padStart = (s: string, w: number) => ' '.repeat(Math.max(0, w - s.length)) + s;

/** Station · City · Price, with widths that fit the content and the phone. */
export function stationTable(rows: AgentStation[]): string {
  const prices = rows.map((r) => usd(r.price));
  const priceW = Math.max(5, ...prices.map((p) => p.length));
  // Station names keep their store number whole; the city column gives way.
  const nameW = Math.min(15, Math.max(7, ...rows.map((r) => r.name.length)));
  const cityW = TABLE_WIDTH - nameW - priceW - 2;
  const line = (a: string, b: string, c: string) => `${pad(cut(a, nameW), nameW)} ${pad(cut(b, cityW), cityW)} ${padStart(c, priceW)}`.trimEnd();
  const out = [line('Station', 'City', 'Price'), '─'.repeat(TABLE_WIDTH)];
  rows.forEach((r, i) => out.push(line(r.name, titleCase(r.city) || '—', prices[i])));
  return `<pre>${esc(out.join('\n'))}</pre>`;
}

export const pricesOf = (pulledAt: Date | string | null, fmtDate: (d: Date | string) => string) => (pulledAt ? `Prices of ${fmtDate(pulledAt)}` : '');

export function header(pulledAt: Date | string | null, fmtDate: (d: Date | string) => string): string {
  const when = pricesOf(pulledAt, fmtDate);
  return ['⛽ <b>CFT fuel discounts</b>', `<i>Per gallon, with the CFT discount${when ? ' · ' + when : ''}</i>`].join('\n');
}

function stateTitle(code: string, rows: AgentStation[], total: number): string {
  const best = Math.max(0, ...rows.map((r) => r.saving ?? 0));
  const count = total === rows.length ? `${total} station${total === 1 ? '' : 's'}` : `cheapest ${rows.length} of ${total}`;
  return `📍 <b>${esc(stateName(code))}</b> · ${count}${best > 0 ? ` · save up to ${usd(best)}` : ''}`;
}

export interface StateBlock {
  state: string;
  /** Every matching station in the state, any order. */
  stations: AgentStation[];
}

/**
 * The tables for some states, split into as few messages as Telegram allows. `limit` shows only the
 * cheapest few per state (the bot's quick answer); without it every station is listed.
 */
export function stateMessages(blocks: StateBlock[], head: string, limit?: number): string[] {
  const messages: string[] = [];
  let current = head;
  const push = (part: string) => {
    if (current && (current + '\n\n' + part).length > MESSAGE_LIMIT) {
      messages.push(current);
      current = part;
    } else current = current ? current + '\n\n' + part : part;
  };
  for (const b of blocks) {
    const sorted = [...b.stations].sort(byPrice);
    const shown = limit ? sorted.slice(0, limit) : sorted;
    // A state too long for one message continues in the next, title repeated.
    const perMessage = 95;
    for (let i = 0; i < shown.length; i += perMessage) {
      const chunk = shown.slice(i, i + perMessage);
      const title = i === 0 ? stateTitle(b.state, shown, sorted.length) : `📍 <b>${esc(stateName(b.state))}</b> (continued)`;
      push(`${title}\n${stationTable(chunk)}`);
    }
  }
  if (current) messages.push(current);
  return messages;
}

/** No state given ("pilot loves"): the cheapest station of each state. */
export function cheapestByState(stations: AgentStation[], head: string): string[] {
  const best = new Map<string, AgentStation>();
  const counts = new Map<string, number>();
  for (const s of stations) {
    counts.set(s.state, (counts.get(s.state) ?? 0) + 1);
    const b = best.get(s.state);
    if (!b || byPrice(s, b) < 0) best.set(s.state, s);
  }
  const rows = [...best.values()].sort((a, b) => a.state.localeCompare(b.state));
  const prices = rows.map((r) => usd(r.price));
  const priceW = Math.max(5, ...prices.map((p) => p.length));
  const nameW = Math.min(13, Math.max(7, ...rows.map((r) => r.name.length)));
  const cityW = TABLE_WIDTH - 2 - nameW - priceW - 3;
  const line = (st: string, p: string, n: string, c: string) => `${pad(st, 2)} ${padStart(p, priceW)} ${pad(cut(n, nameW), nameW)} ${cut(c, cityW)}`.trimEnd();
  const lines = [line('St', 'Price', 'Station', 'City'), '─'.repeat(TABLE_WIDTH), ...rows.map((r, i) => line(r.state, prices[i], r.name, titleCase(r.city)))];
  const intro = `🗺 <b>Cheapest in each state</b> · ${stations.length.toLocaleString('en-US')} stations in ${rows.length} states`;
  const tip = '<i>Type a state (for example “texas”) to see all its stations.</i>';
  const messages: string[] = [];
  for (let i = 2, first = true; i < lines.length || first; first = false) {
    const part = lines.slice(i, i + 90);
    i += 90;
    const table = `<pre>${esc([...lines.slice(0, 2), ...part].join('\n'))}</pre>`;
    messages.push(first ? `${head}\n\n${intro}\n${table}` : table);
  }
  messages[messages.length - 1] += `\n${tip}`;
  return messages;
}

export const mapsUrl = (s: AgentStation) =>
  'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([s.name, s.address, titleCase(s.city), s.state].filter(Boolean).join(', '));

/** One station, for "Send to a driver". */
export function stationCard(s: AgentStation, pulledAt: Date | string | null, fmtDate: (d: Date | string) => string): string {
  const where = [s.address, titleCase(s.city), s.state].filter(Boolean).join(', ');
  const price = s.saving != null && s.retail != null
    ? `💲 <b>${usd(s.price)}</b> per gallon with CFT · retail ${usd(s.retail)} · <b>save ${usd(s.saving)}</b>`
    : `💲 <b>${usd(s.price)}</b> per gallon (retail, no discount)`;
  return [
    `⛽ <b>${esc(s.name)}</b> · ${esc(titleCase(s.city) || stateName(s.state))}, ${s.state}`,
    `📍 ${esc(where)}`,
    s.exit ? `🛣 ${esc(s.exit)}` : null,
    price,
    `🗺 <a href="${mapsUrl(s)}">Open in Google Maps</a>`,
    pulledAt ? `<i>${pricesOf(pulledAt, fmtDate)}</i>` : null,
  ].filter((l) => l !== null).join('\n');
}
