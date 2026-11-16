import { SECTION } from '../../../core/home.js';
import { botApi, type PrivateMessage } from '../../../core/telegram.js';
import { showAcademy } from '../../../tools/agent-academy/chat.js';
import { ACADEMY_ADMIN_ONLY } from '../admins/academy.js';
import { commandOf } from '../viewer.js';

// Agent Academy for candidates: open the test. The admin commands are refused politely.

export async function academyMessage(msg: PrivateMessage): Promise<boolean> {
  const text = msg.text?.trim() ?? '';
  const cmd = text === SECTION.academy ? '/academy' : commandOf(text);
  if (ACADEMY_ADMIN_ONLY.includes(cmd)) {
    await botApi('sendMessage', { chat_id: msg.chat.id, text: 'This command is for CFT administrators. Use /start to open the assessment.', parse_mode: 'HTML' });
    return true;
  }
  if (cmd !== '/academy' && cmd !== '/test') return false;
  await showAcademy(msg.chat.id, false);
  return true;
}
