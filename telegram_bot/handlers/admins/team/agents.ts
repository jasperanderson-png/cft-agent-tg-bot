import { escHtml as esc } from '../../../../shared/html.js';
import { fmtDMY, fmtDMYHM } from '../../../../shared/time.js';
import { createInvite, INVITE_HOURS, listAgents, removeAgent, revokeInvite } from '../../../../core/agents.js';
import { telegramAdmin } from '../../../../core/admins.js';
import type { Db } from '../../../../db_storage/db.js';
import { HttpError, UUID_RE } from '../../../../core/http.js';
import { botApi, type PrivateCallback, type PrivateMessage } from '../../../../core/telegram.js';
import { firstSight, reportTimeZone } from '../../../../core/updates.js';

// Agents, for admins: share an invite link (anyone with it can join until it expires or is turned
// off), see who joined, remove an agent. The same actions are in the Mini App (Team screen, whose API
// is tools/agents/).

export const TEAM_HELP =
  '👥 <b>Agents</b>\n/invite — make an invite link anyone can join with (add a name: /invite Drivers team)\n/agents — see agents and remove one\nAgents can type a state or station to get discount prices; you can too, to see what they see.';

export const INVITE_COMMAND = { command: 'invite', description: 'Agents: invite an agent (add a name)' };
export const AGENTS_COMMAND = { command: 'agents', description: 'Agents: list and remove agents' };
export const TEAM_CALLBACK = 'team:';
const CB = TEAM_CALLBACK;
const HOURS_LABEL: Record<number, string> = { 1: '1 hour', 24: '1 day', 72: '3 days', 168: '7 days', 720: '30 days' };

const send = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const edit = (cb: PrivateCallback, text: string, extra: Record<string, unknown> = {}) =>
  botApi('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }).catch(() => {});

/** Keeps a name short enough to ride in the button data (Telegram allows 64 bytes). */
function shortLabel(label: string, maxBytes = 44): string {
  let s = label.replace(/:/g, ' ').trim();
  while (Buffer.byteLength(s, 'utf8') > maxBytes) s = s.slice(0, -1);
  return s;
}

function expiryButtons(label: string) {
  const l = shortLabel(label);
  return { inline_keyboard: [INVITE_HOURS.slice(0, 3), INVITE_HOURS.slice(3)].map((row) => row.map((h) => ({ text: HOURS_LABEL[h], callback_data: `${CB}inv:${h}:${l}` }))) };
}

const askExpiry = (chat_id: number, label: string) =>
  send(chat_id, `🔗 <b>Invite an agent</b>${label ? ` · ${esc(label)}` : ''}\n\nHow long should the link work? <b>Anyone</b> who opens it before then becomes an agent with access to fuel discounts. You can turn it off at any time.`, { reply_markup: expiryButtons(label) });

export async function agentsText(db: Db) {
  const tz = await reportTimeZone(db);
  const { agents, invites } = await listAgents(db);
  const lines = [`👥 <b>Agents</b> · ${agents.length}`];
  if (!agents.length) lines.push('', 'No agents yet. Tap ➕ Invite agent to make a link.');
  agents.slice(0, 40).forEach((a, i) => lines.push(`${i + 1}. ${esc(a.name ?? 'Telegram user')}${a.username ? ' @' + esc(a.username) : ''} · joined ${fmtDMY(a.joinedAt, tz)}`));
  if (agents.length) lines.push('', '<i>Every agent can also invite drivers to the route map (/drivers shows who invited whom).</i>');
  if (agents.length > 40) lines.push(`…and ${agents.length - 40} more (see the Team screen in the CFT Hub).`);
  if (invites.length) lines.push('', `🔗 ${invites.length} active link${invites.length === 1 ? '' : 's'}: ${invites.slice(0, 5).map((v) => `${esc(v.label ?? 'no name')} (${v.uses} joined, until ${fmtDMYHM(v.expiresAt, tz)})`).join(', ')}`);
  const buttons = [[{ text: '➕ Invite agent', callback_data: `${CB}new` }, { text: '🛡 Admins', callback_data: 'adm:list' }], ...agents.slice(0, 20).map((a) => {
    const n = (a.name ?? String(a.telegramUserId)).slice(0, 30);
    return [{ text: `Remove ${n}`, callback_data: `${CB}rm:${a.telegramUserId}` }];
  })];
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: buttons } };
}

/** /invite and /agents. */
export async function teamMessage(db: Db, msg: PrivateMessage): Promise<boolean> {
  const text = msg.text?.trim() ?? '';
  const [first, ...rest] = text.split(/\s+/);
  const cmd = first.split('@')[0].toLowerCase();
  if (cmd !== '/invite' && cmd !== '/agents') return false;
  if (cmd === '/invite') await askExpiry(msg.chat.id, rest.join(' ').slice(0, 80));
  else {
    const t = await agentsText(db);
    await send(msg.chat.id, t.text, { reply_markup: t.reply_markup });
  }
  return true;
}

/** Taps on the invite and agent-list buttons. */
export async function teamCallback(db: Db, cb: PrivateCallback, updateId: number | undefined): Promise<boolean> {
  if (!cb.data.startsWith(TEAM_CALLBACK)) return false;
  const answer = (text?: string) => botApi('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});
  const [kind, arg = '', ...labelParts] = cb.data.slice(CB.length).split(':');
  if (!(await firstSight(db, updateId))) return true;
  const chat = cb.message.chat.id;
  try {
    if (kind === 'new') {
      await answer();
      await askExpiry(chat, '');
    } else if (kind === 'inv') {
      const me = await telegramAdmin(db, cb.from);
      if (!me) throw new HttpError(403, 'For CFT administrators only.');
      const label = labelParts.join(':');
      const inv = await createInvite(db, me.id, Number(arg), label);
      const tz = await reportTimeZone(db);
      await answer('Link ready');
      const share = `https://t.me/share/url?url=${encodeURIComponent(inv.link)}&text=${encodeURIComponent('Join CFT as an agent to see fuel discount prices:')}`;
      await edit(
        cb,
        [
          `🔗 <b>Invite link</b>${label ? ` for ${esc(label)}` : ''}`,
          '',
          `<code>${inv.link}</code>`,
          '',
          `Anyone with this link can join until ${fmtDMYHM(inv.expiresAt, tz)} (${HOURS_LABEL[inv.hours]}). Share it with your agents: when they open it and press Start, they get fuel discounts and you get a message here.`,
        ].join('\n'),
        { reply_markup: { inline_keyboard: [[{ text: '📤 Share link', url: share }], [{ text: 'Turn this link off', callback_data: `${CB}off:${inv.id}` }]] } },
      );
    } else if (kind === 'off' && UUID_RE.test(arg)) {
      const me = await telegramAdmin(db, cb.from);
      await revokeInvite({ id: me!.id }, arg);
      await answer('Link turned off');
      await edit(cb, '🔗 This invite link was turned off. Nobody can join with it.');
    } else if (kind === 'rm') {
      const { agents } = await listAgents(db);
      const a = agents.find((x) => x.telegramUserId === Number(arg));
      await answer();
      if (!a) await send(chat, 'This person is no longer an agent.');
      else await send(chat, `Remove <b>${esc(a.name ?? 'this agent')}</b> as an agent? They lose access to fuel discounts at once.`, {
        reply_markup: { inline_keyboard: [[{ text: 'Yes, remove', callback_data: `${CB}rmy:${a.telegramUserId}` }, { text: 'Cancel', callback_data: `${CB}no` }]] },
      });
    } else if (kind === 'rmy') {
      const me = await telegramAdmin(db, cb.from);
      await removeAgent({ id: me!.id }, Number(arg));
      await answer('Removed');
      await edit(cb, '✅ Agent removed. They no longer see fuel discounts.');
    } else if (kind === 'no') {
      await answer();
      await edit(cb, 'Nothing changed.');
    } else await answer();
  } catch (e) {
    await answer(e instanceof HttpError ? e.message.slice(0, 190) : 'Something went wrong. Try again.');
    if (!(e instanceof HttpError)) console.error('agents action failed', kind, (e as Error).message);
  }
  return true;
}

