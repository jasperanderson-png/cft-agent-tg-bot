// What each bot shows people who have just opened it: commands, menu button and descriptions.
// Used by npm run telegram:setup and npm run academy:setup.
import { ACADEMY_BOT_COMMANDS } from '../../telegram_bot/cftacademy/webhook.js';
import { VISITOR_COMMANDS } from '../../telegram_bot/cftagents/handlers/visitors/index.js';
import { env } from '../helpers/env.js';
import { academyApi, botApi } from '../helpers/telegram.js';

/** @cft_Agentbot for newcomers: no test, a command menu, and what the bot is for. */
export async function setMainBotDefaults(): Promise<void> {
  await botApi('setMyCommands', { commands: VISITOR_COMMANDS });
  await botApi('setChatMenuButton', { menu_button: { type: 'commands' } });
  await botApi('setMyShortDescription', { short_description: 'CFT Transport: the bot for CFT agents and drivers.' });
  await botApi('setMyDescription', {
    description: 'The CFT Transport bot for agents and drivers: fuel discounts, the truck route map and partner stations. Drivers can request access here.',
  });
  console.log('@cft_Agentbot: visitor commands, command menu button and descriptions set.');
}

/** @cftacademybot: its webhook, the "Start test" button, commands and descriptions. */
export async function setupAcademyBot(): Promise<void> {
  if (!env.academyBotToken) throw new Error('ACADEMY_BOT_TOKEN is not set.');
  const me = (await academyApi('getMe', {})) as { username: string };
  await academyApi('setWebhook', {
    url: `${env.appUrl}/api/telegram/academy-webhook`,
    secret_token: env.webhookSecret,
    allowed_updates: ['message'],
  });
  await academyApi('setMyCommands', { commands: ACADEMY_BOT_COMMANDS });
  await academyApi('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Start test', web_app: { url: env.appUrl } } });
  await academyApi('setMyShortDescription', { short_description: 'CFT Agent Academy: the Sales Agent knowledge test.' });
  await academyApi('setMyDescription', { description: 'A 30-question knowledge test for CFT Sales Agent candidates. Tap Start to open the assessment.' });
  console.log(`@${me.username}: webhook → ${env.appUrl}/api/telegram/academy-webhook, menu button, commands and descriptions set.`);
}
