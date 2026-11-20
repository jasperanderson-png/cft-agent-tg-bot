// Moves the Sales Agent test into the Academy's own bot (@cftacademybot) without touching the main
// bot's webhook: sets up the Academy bot, and takes the test off @cft_Agentbot's default menu.
// Usage: npm run academy:setup   (needs ACADEMY_BOT_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, APP_URL)
import { env } from '../helpers/env.js';
import { setMainBotDefaults, setupAcademyBot } from './bot-profiles.js';

async function main() {
  if (!/^https:\/\//.test(env.appUrl)) throw new Error('APP_URL must be the https:// URL of your deployment.');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(env.webhookSecret)) throw new Error('TELEGRAM_WEBHOOK_SECRET must be 16–256 characters of A–Z, a–z, 0–9, _ or -.');
  await setupAcademyBot();
  await setMainBotDefaults();
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
