import type { Db } from '../../../../database/db.js';
import { SECTION } from '../../../../support/helpers/home.js';
import type { PrivateMessage } from '../../../../support/helpers/telegram.js';
import { sendConsoleLink, sendExcelReport, sendStats, showAcademy } from '../../../../tools/agent-academy/chat.js';
import { commandOf } from '../viewer.js';

// Agent Academy for admins: a link to the Academy bot, the console, statistics and reports. The test
// itself is only in the Academy's own bot (telegram_bot/cftacademy/).

export const ACADEMY_COMMAND = { command: 'academy', description: 'Academy: the test bot and console' };
export const ACADEMY_ADMIN_COMMANDS = [
  { command: 'admin', description: 'Academy: admin console' },
  { command: 'stats', description: 'Academy: this week so far' },
  { command: 'weekly', description: "Academy: last week's summary" },
  { command: 'report', description: 'Academy: Excel report (add: week, lastweek, 30d)' },
];
/** Commands only admins have (visitors are told so; see ../visitors/index.ts). */
export const ACADEMY_ADMIN_ONLY = ACADEMY_ADMIN_COMMANDS.map((c) => '/' + c.command);

const REPORT_RANGES = { week: 'week', lastweek: 'last_week', last_week: 'last_week', '30d': '30d', month: '30d' } as const;

export async function academyMessage(db: Db, msg: PrivateMessage): Promise<boolean> {
  const text = msg.text?.trim() ?? '';
  const cmd = text === SECTION.academy ? '/academy' : commandOf(text);
  const chatId = msg.chat.id;
  switch (cmd) {
    case '/academy':
    case '/test':
      await showAcademy(chatId);
      return true;
    case '/admin':
      await sendConsoleLink(chatId);
      return true;
    case '/stats':
      await sendStats(db, chatId, 'week');
      return true;
    case '/weekly':
      await sendStats(db, chatId, 'last_week');
      return true;
    case '/report': {
      const arg = (text.split(/\s+/)[1] ?? '').toLowerCase();
      await sendExcelReport(db, chatId, REPORT_RANGES[arg as keyof typeof REPORT_RANGES] ?? 'all');
      return true;
    }
    default:
      return false;
  }
}
