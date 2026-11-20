import { env } from '../../support/helpers/env.js';
import { HttpError, secretMatches, type ApiRequest } from '../../support/helpers/http.js';
import { academyApi, type TelegramUpdate } from '../../support/helpers/telegram.js';
import { academyWelcome, CANDIDATE_HELP } from '../../tools/agent-academy/chat.js';

// @cftacademybot's front door: the Agent Academy's own bot, for Sales Agent candidates only. It has one
// thing, the test (its menu button and /start open it); nothing about drivers, agents or admins. The
// test's results go to the same database, so admins see them in @cft_Agentbot and the console.

/** The Academy bot's command menu (set by npm run academy:setup). */
export const ACADEMY_BOT_COMMANDS = [
  { command: 'start', description: 'Open the Sales Agent assessment' },
  { command: 'help', description: 'How this bot works' },
];

/** Telegram webhook of the Academy bot. Answers 200 for every authentic call so Telegram doesn't retry. */
export async function handleAcademyWebhook(req: ApiRequest) {
  if (!secretMatches(req.headers['x-telegram-bot-api-secret-token'], env.webhookSecret)) throw new HttpError(401, 'Bad webhook secret.');
  if (!env.academyBotToken) return { ok: true };
  const msg = (req.body as TelegramUpdate | null)?.message;
  if (!msg?.chat?.id || msg.chat.type !== 'private' || typeof msg.text !== 'string') return { ok: true };
  try {
    if (msg.text.trim().split(/[\s@]/)[0].toLowerCase() === '/help') await academyApi('sendMessage', { chat_id: msg.chat.id, text: CANDIDATE_HELP, parse_mode: 'HTML' });
    else await academyWelcome(msg.chat.id); // /start, or anything typed: the test's front page
  } catch (e) {
    console.error('academy bot update failed', (e as Error).message);
  }
  return { ok: true };
}
