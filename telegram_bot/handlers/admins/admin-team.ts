import { fmtDMY, fmtDMYHM } from '../../../shared/time.js';
import { ADMIN_INVITE_HOURS, createAdminInvite, listAdmins, revokeAdminInvite } from '../../../core/admin-invites.js';
import { removeAdmin, telegramAdmin, type Admin } from '../../../core/admins.js';
import type { Db } from '../../../db_storage/db.js';
import { HttpError, UUID_RE } from '../../../core/http.js';
import { botApi, type PrivateCallback, type PrivateMessage } from '../../../core/telegram.js';
import { firstSight, reportTimeZone } from '../../../core/updates.js';
import { commandOf, type Viewer } from '../viewer.js';

// Admins, for owners: send an invite link (it works for one person, until it expires or is turned
// off), see who the admins are, remove one. Every admin can see the list; only owners change it.

export const ADD_ADMIN_COMMAND = { command: 'addadmin', description: 'Admins: invite an admin (owners)' };
export const ADMINS_COMMAND = { command: 'admins', description: 'Admins: list and remove admins' };
export const ADMIN_TEAM_HELP =
  '🛡 <b>Admins</b>\n/addadmin — a link that makes one person an admin (owners only; add a name: /addadmin Aziz)\n/admins — see the admins; owners can remove one';
export const ADMIN_TEAM_CALLBACK = 'adm:';

const CB = ADMIN_TEAM_CALLBACK;
const HOURS_LABEL: Record<number, string> = { 1: '1 hour', 24: '1 day', 72: '3 days', 168: '7 days' };
const OWNERS_ONLY = 'Only owners can add or remove admins.';
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const send = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const edit = (cb: PrivateCallback, text: string, extra: Record<string, unknown> = {}) =>
  botApi('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }).catch(() => {});

/** Keeps a name short enough to ride in the button data (Telegram allows 64 bytes). */
function shortLabel(label: string, maxBytes = 40): string {
  let s = label.replace(/:/g, ' ').trim();
  while (Buffer.byteLength(s, 'utf8') > maxBytes) s = s.slice(0, -1);
  return s;
}

const askExpiry = (chat_id: number, label: string) =>
  send(chat_id, `🛡 <b>Invite an admin</b>${label ? ` · ${esc(label)}` : ''}\n\nHow long should the link work? It makes <b>one person</b> an admin (Academy, Driver Leads, fuel prices, agents), then stops working.`, {
    reply_markup: { inline_keyboard: [ADMIN_INVITE_HOURS.map((h) => ({ text: HOURS_LABEL[h], callback_data: `${CB}inv:${h}:${shortLabel(label)}` }))] },
  });

async function adminsView(db: Db, owner: boolean) {
  const tz = await reportTimeZone(db);
  const { admins, links } = await listAdmins(db);
  const lines = [`🛡 <b>Admins</b> · ${admins.length}`];
  admins.forEach((a, i) =>
    lines.push(`${i + 1}. ${esc(a.name ?? 'Telegram user')}${a.username ? ' @' + esc(a.username) : ''}${a.role === 'owner' ? ' · <i>owner</i>' : ` · since ${fmtDMY(a.since, tz)}`}`),
  );
  if (links.length) lines.push('', `🔗 ${links.length} unused link${links.length === 1 ? '' : 's'}: ${links.slice(0, 5).map((l) => `${esc(l.label ?? 'no name')} (until ${fmtDMYHM(l.expiresAt, tz)})`).join(', ')}`);
  if (!owner) return { text: [...lines, '', '<i>Only owners can add or remove admins.</i>'].join('\n') };
  const buttons = [
    [{ text: '➕ Invite admin', callback_data: `${CB}new` }],
    ...links.slice(0, 5).map((l) => [{ text: `Turn off link ${(l.label ?? '').slice(0, 24)}`.trim(), callback_data: `${CB}off:${l.id}` }]),
    ...admins.filter((a) => a.role !== 'owner').slice(0, 20).map((a) => [{ text: `Remove ${(a.name ?? 'admin').slice(0, 30)}`, callback_data: `${CB}rm:${a.id}` }]),
  ];
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: buttons } };
}

/** /addadmin and /admins. */
export async function adminTeamMessage(db: Db, msg: PrivateMessage, who: Viewer): Promise<boolean> {
  const text = msg.text?.trim() ?? '';
  const cmd = commandOf(text);
  if (cmd !== '/addadmin' && cmd !== '/admins') return false;
  if (cmd === '/addadmin') {
    if (!who.owner) await send(msg.chat.id, OWNERS_ONLY);
    else await askExpiry(msg.chat.id, text.replace(/^\S+\s*/, '').slice(0, 80));
  } else {
    const v = await adminsView(db, who.owner);
    await send(msg.chat.id, v.text, v.reply_markup ? { reply_markup: v.reply_markup } : {});
  }
  return true;
}

export async function adminTeamCallback(db: Db, cb: PrivateCallback, who: Viewer): Promise<boolean> {
  if (!cb.data.startsWith(CB)) return false;
  const answer = (text?: string) => botApi('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});
  const [kind, arg = '', ...labelParts] = cb.data.slice(CB.length).split(':');
  if (kind === 'list') {
    await answer();
    const v = await adminsView(db, who.owner);
    await send(cb.message.chat.id, v.text, v.reply_markup ? { reply_markup: v.reply_markup } : {});
    return true;
  }
  if (!who.owner) {
    await answer(OWNERS_ONLY);
    return true;
  }
  if (!(await firstSight(db, who.updateId))) return true;
  const me = await telegramAdmin(db, cb.from);
  if (!me) {
    await answer(OWNERS_ONLY);
    return true;
  }
  try {
    if (kind === 'new') {
      await answer();
      await askExpiry(cb.message.chat.id, '');
    } else if (kind === 'inv') {
      const label = labelParts.join(':');
      const inv = await createAdminInvite(db, me.id, Number(arg), label);
      const tz = await reportTimeZone(db);
      await answer('Link ready');
      const share = `https://t.me/share/url?url=${encodeURIComponent(inv.link)}&text=${encodeURIComponent('Join CFT as an admin:')}`;
      await edit(
        cb,
        [
          `🛡 <b>Admin invite link</b>${label ? ` for ${esc(label)}` : ''}`,
          '',
          `<code>${inv.link}</code>`,
          '',
          `Send it to the new admin. When they open it and press Start, they are an admin and you get a message here. It works for <b>one person</b>, until ${fmtDMYHM(inv.expiresAt, tz)} (${HOURS_LABEL[inv.hours]}).`,
        ].join('\n'),
        { reply_markup: { inline_keyboard: [[{ text: '📤 Share link', url: share }], [{ text: 'Turn this link off', callback_data: `${CB}off:${inv.id}` }]] } },
      );
    } else if (kind === 'off' && UUID_RE.test(arg)) {
      const done = await revokeAdminInvite(db, me.id, arg);
      await answer(done ? 'Link turned off' : 'This link was already used, expired or turned off');
      if (done) await edit(cb, '🛡 This admin invite link was turned off. Nobody can join with it.');
    } else if (kind === 'rm' && UUID_RE.test(arg)) {
      const { admins } = await listAdmins(db);
      const a = admins.find((x) => x.id === arg);
      await answer();
      if (!a || a.role === 'owner') await send(cb.message.chat.id, 'This person is not an admin you can remove.');
      else await send(cb.message.chat.id, `Remove <b>${esc(a.name ?? 'this admin')}</b> as an admin? They lose access to the Academy console, Driver Leads, fuel prices and agents at once.`, {
        reply_markup: { inline_keyboard: [[{ text: 'Yes, remove', callback_data: `${CB}rmy:${a.id}` }, { text: 'Cancel', callback_data: `${CB}no` }]] },
      });
    } else if (kind === 'rmy' && UUID_RE.test(arg)) {
      const { admins } = await listAdmins(db);
      const target = admins.find((x) => x.id === arg);
      await removeAdmin({ ...me, name: null, telegramUserId: cb.from.id, sessionId: '' } as Admin, arg);
      if (target?.telegramUserId) {
        // Back to what everyone else has: the default menu button and commands.
        await botApi('setChatMenuButton', { chat_id: target.telegramUserId, menu_button: { type: 'default' } }).catch(() => {});
        await botApi('deleteMyCommands', { scope: { type: 'chat', chat_id: target.telegramUserId } }).catch(() => {});
      }
      await answer('Removed');
      await edit(cb, '✅ Admin removed.');
    } else if (kind === 'no') {
      await answer();
      await edit(cb, 'Nothing changed.');
    } else await answer();
  } catch (e) {
    await answer(e instanceof HttpError ? e.message.slice(0, 190) : 'Something went wrong. Try again.');
    if (!(e instanceof HttpError)) console.error('admin team action failed', kind, (e as Error).message);
  }
  return true;
}
