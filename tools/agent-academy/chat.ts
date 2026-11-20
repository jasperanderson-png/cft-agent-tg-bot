import type { RangeKey } from '../../support/common/time.js';
import type { Db } from '../../database/db.js';
import { env } from '../../support/helpers/env.js';
import { homeKeyboardFor } from '../../support/helpers/home.js';
import { academyApi, botApi } from '../../support/helpers/telegram.js';
import { sendReportToChat, statsText } from './notify.js';

// What the Agent Academy sends in a chat: the test's front page, the admin console link, statistics
// and the Excel report. Who may ask for which is decided in telegram_bot/cftagents/handlers/<role>/academy.ts.

const WELCOME =
  '🎓 <b>CFT Agent Academy</b>\n\n' +
  'A 30-question knowledge test for Sales Agent candidates: trucking basics, compliance terms and the CFT fuel-card offer.\n\n' +
  'Tap the button below to start. You will see your score and the correct answers after you submit.';

export const ADMIN_HELP =
  '🎓 <b>Agent Academy · Admin commands</b>\n' +
  '/admin — open the admin console\n' +
  '/stats — this week so far\n' +
  '/weekly — last week\'s summary\n' +
  '/report — Excel report (all time)\n' +
  '/report week · /report lastweek · /report 30d\n\n' +
  'You get a message whenever a candidate passes or fails, and a summary every Monday. Turn these off in the console under Settings.';

export const CANDIDATE_HELP = 'Use /start to open the assessment. Questions about the role? Contact your CFT recruiter.';
const APP_URL_MISSING = 'The app URL is not configured yet (APP_URL).';

const webApp = (text: string, hash = '') => ({ text, web_app: { url: env.appUrl + (hash ? '/' + hash : '') } });
const send = (chatId: number, text: string, extra: Record<string, unknown> = {}) => botApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

/**
 * The test's front page in the Academy's own bot (@cftacademybot): the button that opens the test.
 * The main bot (@cft_Agentbot) never shows it.
 */
export async function academyWelcome(chatId: number): Promise<void> {
  if (!env.appUrl) {
    await academyApi('sendMessage', { chat_id: chatId, text: APP_URL_MISSING });
    return;
  }
  await academyApi('sendMessage', { chat_id: chatId, text: WELCOME, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[webApp('Open CFT Agent Academy')]] } });
}

/**
 * The Academy section for admins in @cft_Agentbot: where candidates take the test (the Academy bot),
 * the console and their commands, with the section switcher back as their keyboard.
 */
export async function showAcademy(chatId: number): Promise<void> {
  if (!env.appUrl) {
    await send(chatId, APP_URL_MISSING);
    return;
  }
  const bot = env.academyBotUsername;
  const text = bot
    ? `🎓 <b>CFT Agent Academy</b>\n\nCandidates take the test in @${bot}: send them that link. Results arrive here and in the console.`
    : '🎓 <b>CFT Agent Academy</b>\n\nThe Academy bot is not set up yet (ACADEMY_BOT_TOKEN, ACADEMY_BOT_USERNAME).';
  const rows = bot ? [[{ text: `Open @${bot}`, url: `https://t.me/${bot}` }], [webApp('Admin console', '#/admin')]] : [[webApp('Admin console', '#/admin')]];
  await send(chatId, text, { reply_markup: { inline_keyboard: rows } });
  await send(chatId, ADMIN_HELP, { reply_markup: homeKeyboardFor(chatId) });
}

export async function sendConsoleLink(chatId: number): Promise<void> {
  if (!env.appUrl) await send(chatId, APP_URL_MISSING);
  else await send(chatId, '🎓 Academy admin console — you are signed in automatically with your Telegram account.', { reply_markup: { inline_keyboard: [[webApp('Open admin console', '#/admin')]] } });
}

export async function sendStats(db: Db, chatId: number, key: 'week' | 'last_week'): Promise<void> {
  if (key === 'week') await send(chatId, await statsText(db, 'week'), { reply_markup: { inline_keyboard: [[webApp('Open dashboard', '#/admin')]] } });
  else await send(chatId, await statsText(db, 'last_week'));
}

export async function sendExcelReport(db: Db, chatId: number, key: RangeKey): Promise<void> {
  await botApi('sendChatAction', { chat_id: chatId, action: 'upload_document' }).catch(() => {});
  await sendReportToChat(db, chatId, key);
}
