import { escHtml as esc } from '../../shared/html.js';
import { fmtDMYHM } from '../../shared/time.js';
import type { Db } from '../../db_storage/db.js';
import { botApi, botSendDocument } from '../../core/telegram.js';
import { reportTimeZone } from '../../core/updates.js';
import { homeKeyboardFor } from '../../core/home.js';
import { fetchAllStations, FuelError, type Stage } from './cabinet.js';
import { saveDataset } from './dataset.js';
import { FUEL_FILENAME, fuelPricesXlsx } from './excel.js';
import { fuelInsights, usd, where, type FuelInsights } from './insights.js';

// The full fuel price export: reads every station's prices from the United Fuel cabinet and sends
// them to a chat as one Excel file. Used by the admins' 📥 button (telegram_bot/handlers/admins/fuel.ts)
// and by "Send Excel to my chat" in the Mini App.

const num = (n: number) => n.toLocaleString('en-US');
const TITLE = '⛽ <b>Fuel prices</b>';

/** The message sent with fuel_prices.xlsx: what is in it, the figures worth knowing, and when it was read. */
export function fuelCaption(f: FuelInsights, when: string, tz: string): string {
  return [
    '⛽ <b>Fuel prices · all stations</b>',
    '',
    `📍 <b>${num(f.stations)}</b> station${f.stations === 1 ? '' : 's'} in <b>${f.states}</b> state${f.states === 1 ? '' : 's'}`,
    f.cheapest ? `💲 Cheapest discounted: <b>${usd(f.cheapest.price)}</b> · ${esc(where(f.cheapest.station))}` : null,
    f.avgSaving != null ? `📉 Average saving: <b>${usd(f.avgSaving)}</b> per gallon` : null,
    f.biggestSaving ? `🏆 Biggest saving: <b>${usd(f.biggestSaving.saving)}</b> · ${esc(where(f.biggestSaving.station))}` : null,
    `🕐 Downloaded ${when} (${tz.split('/').pop()!.replace(/_/g, ' ')} time)`,
    '',
    '📊 <b>Stations</b> sheet: every station, with filters · <b>By state</b> · <b>Summary</b>',
    f.retailOnly === 1 ? '<i>ℹ️ 1 station has only a retail price in the cabinet, so its discounted cell is empty.</i>' : null,
    f.retailOnly > 1 ? `<i>ℹ️ ${num(f.retailOnly)} stations have only a retail price in the cabinet, so their discounted cell is empty.</i>` : null,
  ].filter((l) => l !== null).join('\n');
}
const NOTHING_SENT = 'No file was sent, because it would not be complete.';

const stageText = (s: Stage) =>
  s.step === 'login' ? '⏳ Signing in to the fuel cabinet…'
  : s.step === 'page' ? `⏳ Reading stations: page ${s.page} of ${s.pages} · ${num(s.read)} of ${num(s.total)} stations`
  : `⏳ The list shifted while it was read (${num(s.read)} of ${num(s.total)}). Reading it again in one go…`;

/**
 * Reads every station fresh from the cabinet and sends fuel_prices.xlsx to the chat, showing progress
 * in one status message. Used by the 📥 button and by "Send Excel to my chat" in the Mini App.
 * Never sends an incomplete file: on any problem the status message says what happened.
 */
export async function sendFuelPrices(db: Db, chat_id: number): Promise<{ ok: true; stations: number } | { ok: false; error: string }> {
  const say = (text: string, extra: Record<string, unknown> = {}) => botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra });
  const tz = await reportTimeZone(db);
  const started = Date.now();
  console.log(`[fuel] export started for chat ${chat_id}`);

  // One status message, edited as the export moves on.
  const status = (await say(`${TITLE}\n⏳ Starting…`)) as { message_id?: number };
  let shown = '';
  const show = async (line: string) => {
    if (line === shown || !status?.message_id) return;
    shown = line;
    await botApi('editMessageText', { chat_id, message_id: status.message_id, text: `${TITLE}\n${line}`, parse_mode: 'HTML' }).catch(() => {});
  };

  try {
    const x = await fetchAllStations((s) => show(stageText(s)));
    console.log(`[fuel] read ${x.stations.length} of ${x.siteTotal} stations in ${x.pagesRead} request(s)${x.reread ? ' (re-read)' : ''}, ${x.duplicatesDropped} duplicate(s) dropped`);
    // Every complete pull becomes what agents search.
    const saved = await saveDataset(x, chat_id).catch((e: Error) => {
      console.error('[fuel] saving the agents’ dataset failed:', e.message);
      return null;
    });
    await show(`✔️ All ${num(x.stations.length)} stations read and checked against the cabinet's total. Building the Excel file…`);
    const now = new Date();
    const caption = fuelCaption(fuelInsights(x.stations), fmtDMYHM(now, tz), tz);
    await botApi('sendChatAction', { chat_id, action: 'upload_document' }).catch(() => {});
    await botSendDocument(chat_id, FUEL_FILENAME, fuelPricesXlsx(x, tz, now), caption, { replyMarkup: homeKeyboardFor(chat_id) });
    await show(
      `✅ Done: ${num(x.stations.length)} of ${num(x.siteTotal)} stations, sent below.\n` +
        (saved ? `👥 Agents now see these prices (${num(saved.partnerStations)} partner stations).` : '⚠️ Agents still see the previous prices: saving the new ones failed.'),
    );
    console.log(`[fuel] export sent: ${x.stations.length} stations in ${Date.now() - started} ms`);
    return { ok: true, stations: x.stations.length };
  } catch (e) {
    const known = e instanceof FuelError;
    console.error(`[fuel] export failed after ${Date.now() - started} ms:`, known ? `${(e as FuelError).kind}: ${(e as Error).message}` : (e as Error).message);
    const why = known ? (e as Error).message : /sendDocument/.test((e as Error).message) ? 'The Excel file could not be sent through Telegram.' : 'Something went wrong while preparing the file.';
    await show(`❌ ${why}\n${NOTHING_SENT} Press the button again to retry.`);
    return { ok: false, error: why };
  }
}
