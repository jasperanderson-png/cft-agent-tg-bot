// Points the bot at the deployed app: webhook, commands, menu button and descriptions.
// Usage: npm run telegram:setup   (needs TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, APP_URL)
import { adminMenu, setAdminMenu } from '../telegram_bot/handlers/admins/index.js';
import { setAgentMenu } from '../telegram_bot/handlers/agents/fuel-search.js';
import { menuKey, type Role } from '../telegram_bot/handlers/viewer.js';
import { setDriverMenu } from '../telegram_bot/handlers/drivers/index.js';
import { closePool, getPool } from '../db_storage/db.js';
import { CANDIDATE_COMMANDS } from '../telegram_bot/handlers/candidates/index.js';
import { env } from '../core/env.js';
import { botApi } from '../core/telegram.js';
import { hubMenuButton } from '../core/home.js';

async function main() {
  if (!env.botToken) throw new Error('TELEGRAM_BOT_TOKEN is not set.');
  if (!/^https:\/\//.test(env.appUrl)) throw new Error('APP_URL must be the https:// URL of your deployment.');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(env.webhookSecret)) throw new Error('TELEGRAM_WEBHOOK_SECRET must be 16–256 characters of A–Z, a–z, 0–9, _ or -.');

  const me = (await botApi('getMe', {})) as { username: string };
  console.log(`Bot: @${me.username}`);

  await botApi('setWebhook', {
    url: `${env.appUrl}/api/telegram/webhook`,
    secret_token: env.webhookSecret,
    allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'], // edited_message: live location updates
    drop_pending_updates: true,
  });
  console.log(`Webhook → ${env.appUrl}/api/telegram/webhook`);

  await botApi('setMyCommands', { commands: CANDIDATE_COMMANDS });
  // Owners see every section's commands in their own chats.
  for (const id of env.ownerTelegramIds) {
    await botApi('setChatMenuButton', { chat_id: id, menu_button: hubMenuButton(env.appUrl) }).catch(() => {});
    await botApi('setMyCommands', { commands: adminMenu(id), scope: { type: 'chat', chat_id: id } }).catch((e) =>
      console.warn(`Admin commands for ${id} not set yet (${e.message}). They appear after that admin presses Start.`),
    );
  }
  await botApi('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Start test', web_app: { url: env.appUrl } } });
  await botApi('setMyShortDescription', { short_description: 'CFT Agent Academy — the Sales Agent knowledge test.' });
  await botApi('setMyDescription', {
    description: 'A 30-question knowledge test for CFT Sales Agent candidates. Tap Start to open the assessment.',
  });
  console.log('Commands, menu button and descriptions set.');
  if (env.databaseUrl) await refreshPeopleMenus().finally(() => closePool());
  console.log(`\nDirect fullscreen link: https://t.me/${me.username}?startapp&mode=fullscreen`);
  console.log('(Requires the Main Mini App to be enabled in @BotFather — see README.)');
}

/**
 * Sets every admin's, agent's and driver's own menu button and commands now (Telegram can miss a
 * change, and agents were left with "Start test"), and records it so the bot doesn't redo it.
 */
async function refreshPeopleMenus() {
  const db = getPool();
  const { rows } = await db.query(
    `select telegram_user_id as id, 'admins' as role from admins where telegram_user_id is not null
     union all select a.telegram_user_id, 'agents' from agents a where not exists (select 1 from admins ad where ad.telegram_user_id = a.telegram_user_id)
     union all select d.telegram_user_id, 'drivers' from map_drivers d
       where not exists (select 1 from admins ad where ad.telegram_user_id = d.telegram_user_id)
         and not exists (select 1 from agents a where a.telegram_user_id = d.telegram_user_id)`,
  );
  let ok = 0;
  const failed: string[] = [];
  for (const r of rows as { id: string; role: string }[]) {
    const id = Number(r.id);
    try {
      if (r.role === 'admins') await setAdminMenu(id);
      else if (r.role === 'drivers') await setDriverMenu(id);
      else await setAgentMenu(id);
      await db.query('update telegram_users set menu_role = $2 where id = $1', [id, menuKey(r.role as Role)]);
      ok++;
    } catch (e) {
      failed.push(`${r.role} ${id}: ${(e as Error).message}`);
    }
  }
  console.log(`Menus set for ${ok} of ${rows.length} admins, agents and drivers.`);
  for (const f of failed) console.warn('  not set:', f);
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
