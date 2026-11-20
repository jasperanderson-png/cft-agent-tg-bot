import { env } from './env.js';

/**
 * The admins' home keyboard: one entry button per product, plus 🏠 Home to come back to it.
 *
 *   🎓 Agent Academy              tools/agent-academy/   the Sales Agent test, results, reports
 *   🚚 Driver Leads               tools/driver-leads/    the driver-lead database and its files
 *   📋 Indeed Applicants          tools/indeed-applicants/   people who applied on Indeed; their import file
 *   📥 Download All Fuel Prices   tools/fuel-prices/     every station's fuel prices
 *   ➕ Invite                     tools/agents/, support/helpers/admin-invites.ts   an invite link for a new agent or admin
 *   👥 Team                       tools/agents/, support/helpers/admin-invites.ts   who the agents and admins are; remove one
 *   ⏱ Shift                       tools/task-report/           shifts and work reports (only TASK_REPORT_USER_IDS)
 *
 * What each button does for admins is in telegram_bot/handlers/admins/.
 *
 * Candidates never see this keyboard: they only have the test. Agents get no keyboard: they type
 * searches and have the Discounts menu button.
 */
export const SECTION = { academy: '🎓 Agent Academy', leads: '🚚 Driver Leads', indeed: '📋 Indeed Applicants', home: '🏠 Home', fuel: '📥 Download All Fuel Prices', invite: '➕ Invite', team: '👥 Team', shift: '⏱ Shift', design: '🧩 System Design' } as const;

/** The chat menu button: admins get the CFT Hub; agents get Discounts; candidates keep the bot's default (Start test). */
export const hubMenuButton = (appUrl: string) => ({ type: 'web_app', text: 'CFT Hub', web_app: { url: `${appUrl}/#/hub` } });

/** The button older keyboards still show (before ➕ Invite and 👥 Team); it opens 👥 Team. */
export const OLD_AGENTS_BUTTON = '👥 Agents';

const SECTION_ROWS = [[{ text: SECTION.academy }, { text: SECTION.leads }], [{ text: SECTION.indeed }, { text: SECTION.fuel }], [{ text: SECTION.invite }, { text: SECTION.team }]];

/** The admins' home keyboard, without ⏱ Shift. */
export const homeKeyboard = { keyboard: SECTION_ROWS, resize_keyboard: true, is_persistent: true };

/** Whether this Telegram account has shifts and work reports (TASK_REPORT_USER_IDS). */
export const hasWorkReports = (telegramUserId: number) => env.taskReportUserIds.includes(telegramUserId);

/** The home keyboard of one admin's chat: ⏱ Shift and 🧩 System Design only for the developer (TASK_REPORT_USER_IDS). */
export const homeKeyboardFor = (chatId: number) =>
  hasWorkReports(chatId) ? { ...homeKeyboard, keyboard: [...SECTION_ROWS, [{ text: SECTION.shift }, { text: SECTION.design }]] } : homeKeyboard;
