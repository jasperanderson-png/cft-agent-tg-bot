import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';
import { HttpError } from './http.js';

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface VerifiedInitData {
  user: TelegramUser;
  authDate: number;
  startParam: string | null;
}

/**
 * Validates Mini App initData as described in https://core.telegram.org/bots/webapps
 * (HMAC-SHA256 with key HMAC_SHA256("WebAppData", bot_token)). Returns null when invalid.
 */
export function verifyInitData(initData: string, botToken: string, maxAgeSec: number, now = Date.now()): VerifiedInitData | null {
  if (!initData || !botToken || initData.length > 8192) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = createHmac('sha256', secret).update(dataCheck).digest();
  if (!timingSafeEqual(calc, Buffer.from(hash, 'hex'))) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  const age = now / 1000 - authDate;
  if (age > maxAgeSec || age < -300) return null;

  let user: TelegramUser;
  try {
    user = JSON.parse(params.get('user') ?? '');
  } catch {
    return null;
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return null;
  return { user, authDate, startParam: params.get('start_param') };
}

/** The Mini App sends Telegram's signed initData in this header on agent and driver calls. */
export const INIT_HEADER = 'x-telegram-init-data';

export function requireInitData(initData: unknown): VerifiedInitData {
  if (!env.botToken) throw new HttpError(503, 'The server is not configured yet (TELEGRAM_BOT_TOKEN is missing).');
  const v = typeof initData === 'string' ? verifyInitData(initData, env.botToken, env.initDataMaxAgeSec) : null;
  if (!v) throw new HttpError(401, 'Your Telegram session could not be verified. Close the app and open it again from the bot.', 'telegram_auth');
  return v;
}

/**
 * Calls Telegram that are safe to send twice: setting a menu, editing or answering does the same
 * thing again. When one of them times out or the network drops, it is tried once more. Sending a
 * new message is not retried: the first one may have arrived, and the person would get it twice.
 */
const SAFE_TO_REPEAT = new Set(['setChatMenuButton', 'setMyCommands', 'deleteMyCommands', 'getChatMenuButton', 'getMe', 'answerCallbackQuery', 'editMessageText', 'editMessageReplyMarkup', 'editMessageCaption', 'sendChatAction', 'setWebhook']);

export async function botApi(method: string, payload: Record<string, unknown>): Promise<unknown> {
  const call = () =>
    fetch(`https://api.telegram.org/bot${env.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
  let res: Response;
  try {
    res = await call();
  } catch (e) {
    if (!SAFE_TO_REPEAT.has(method)) throw e;
    console.warn(`Telegram ${method} did not answer (${(e as Error).message}); trying once more`);
    res = await call();
  }
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown };
  if (!j.ok) throw new Error(`Telegram ${method} failed: ${j.description ?? res.status}`);
  return j.result;
}

export interface TelegramMessage {
  chat?: { id: number; type?: string; title?: string };
  /** A group became a supergroup with this new id. */
  migrate_to_chat_id?: number;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  /** Where a forwarded message came from (a channel post forwarded to the bot, for example). */
  forward_origin?: { type?: string; chat?: { id: number; title?: string; type?: string } };
  /** A shared location. With live_period it is a live location: its updates arrive as edited_message. */
  location?: { latitude: number; longitude: number; live_period?: number; heading?: number; horizontal_accuracy?: number };
}

/** A message in a private chat with a known sender: the only kind the products handle. */
export type PrivateMessage = TelegramMessage & { chat: { id: number }; from: TelegramUser };

/** A tap on an inline button under one of the bot's messages, in a private chat. */
export interface TelegramCallback {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: { message_id: number; chat: { id: number; type?: string } };
}
/** A callback with the message it came from, in a private chat: the only kind the products handle. */
export type PrivateCallback = TelegramCallback & { data: string; message: { message_id: number; chat: { id: number } } };

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  /** An edited message; for a live location, each new position. */
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallback;
  my_chat_member?: ChatMemberUpdate;
}

/** The bot was added to, changed in or removed from a chat (a private chat, a channel…). */
export interface ChatMemberUpdate {
  chat?: { id?: number; type?: string; title?: string };
  from?: TelegramUser;
  new_chat_member?: { status?: string; can_post_messages?: boolean; can_edit_messages?: boolean };
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Telegram answered and refused the request, so nothing was sent. Any other error from a send
 * (a timeout, a dropped connection) leaves the outcome unknown: the message may have arrived.
 */
export class TelegramRejected extends Error {}

/** Sends a file (multipart upload) to a chat. Throws TelegramRejected when Telegram refused it. */
export async function botSendDocument(
  chatId: number,
  filename: string,
  bytes: Uint8Array,
  caption?: string,
  opts: { contentType?: string; replyMarkup?: unknown } = {},
): Promise<void> {
  const fd = new FormData();
  fd.set('chat_id', String(chatId));
  fd.set('document', new Blob([new Uint8Array(bytes)], { type: opts.contentType ?? XLSX_MIME }), filename);
  if (caption) {
    fd.set('caption', caption);
    fd.set('parse_mode', 'HTML');
  }
  if (opts.replyMarkup) fd.set('reply_markup', JSON.stringify(opts.replyMarkup));
  const res = await fetch(`https://api.telegram.org/bot${env.botToken}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (j.ok) return;
  if (!res.ok || j.ok === false) throw new TelegramRejected(`Telegram sendDocument failed: ${j.description ?? res.status}`);
  throw new Error('Telegram sendDocument gave no readable answer.');
}

/**
 * Sends a picture (multipart upload) to a chat or channel and returns the new message's id (null if
 * Telegram didn't say). Throws TelegramRejected when Telegram refused it.
 */
export async function botSendPhoto(
  chatId: number,
  png: Uint8Array,
  caption?: string,
  opts: { replyMarkup?: unknown; silent?: boolean; filename?: string } = {},
): Promise<number | null> {
  const fd = new FormData();
  fd.set('chat_id', String(chatId));
  fd.set('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), opts.filename ?? 'prices.png');
  if (caption) {
    fd.set('caption', caption);
    fd.set('parse_mode', 'HTML');
  }
  if (opts.replyMarkup) fd.set('reply_markup', JSON.stringify(opts.replyMarkup));
  if (opts.silent) fd.set('disable_notification', 'true');
  return (await multipart('sendPhoto', fd)) ?? null;
}

/** Replaces the picture and caption of a message the bot sent earlier (no new notification). */
export async function botEditPhoto(chatId: number, messageId: number, png: Uint8Array, caption: string, filename = 'report.png'): Promise<void> {
  const fd = new FormData();
  fd.set('chat_id', String(chatId));
  fd.set('message_id', String(messageId));
  fd.set('media', JSON.stringify({ type: 'photo', media: 'attach://card', caption, parse_mode: 'HTML' }));
  fd.set('card', new Blob([new Uint8Array(png)], { type: 'image/png' }), filename);
  await multipart('editMessageMedia', fd);
}

async function multipart(method: string, fd: FormData): Promise<number | undefined> {
  const res = await fetch(`https://api.telegram.org/bot${env.botToken}/${method}`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: { message_id?: number } };
  if (j.ok) return j.result?.message_id;
  if (!res.ok || j.ok === false) throw new TelegramRejected(`Telegram ${method} failed: ${j.description ?? res.status}`);
  throw new Error(`Telegram ${method} gave no readable answer.`);
}

/** Downloads a file a user sent to the bot (Telegram serves files up to 20 MB to bots). */
export async function botDownloadFile(fileId: string, maxBytes: number): Promise<Uint8Array> {
  const f = (await botApi('getFile', { file_id: fileId })) as { file_path?: string; file_size?: number };
  if (!f.file_path) throw new Error('Telegram did not return a file path.');
  if ((f.file_size ?? 0) > maxBytes) throw new Error('The file is too large.');
  const res = await fetch(`https://api.telegram.org/file/bot${env.botToken}/${f.file_path}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error('The file is too large.');
  return bytes;
}
