import { createHmac } from 'node:crypto';

/** Builds Mini App initData signed the way Telegram signs it. */
export function signInitData(user: Record<string, unknown>, botToken: string, authDate = Math.floor(Date.now() / 1000), extra: Record<string, string> = {}) {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAH-test', user: JSON.stringify(user), ...extra });
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  p.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}
