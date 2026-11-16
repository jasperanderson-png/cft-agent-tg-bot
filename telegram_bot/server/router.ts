import * as admins from '../../core/admins.js';
import { getPool } from '../../db_storage/db.js';
import { bodyObject, HttpError, ok, type AddRoute, type ApiRequest, type ApiResponse, type Handler } from '../../core/http.js';
import { TOOLS } from './tools.js';
import { handleWebhook } from '../webhook.js';

// Every API route (/api/*): the app's own (Telegram webhook, admin sign-in, users, downloads), then
// each tool's from its index.ts (see tools.ts).

const routes: [method: string, pattern: RegExp, handler: Handler][] = [];
const route: AddRoute = (method, pattern, h) => routes.push([method, new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '/?$'), h]);
const { asAdmin } = admins;

// Telegram
route('POST', 'telegram/webhook', async (req) => ok(await handleWebhook(req)));

// Admins: sign-in, sessions, the Users and Admins screens, downloads
route('POST', 'admin/login', async (req) => ok(await admins.login(bodyObject(req), req.ip)));
route('POST', 'admin/telegram-login', async (req) => ok(await admins.telegramLogin(bodyObject(req))));
route('POST', 'admin/logout', asAdmin((a) => admins.logout(a)));
route('GET', 'admin/me', asAdmin((a) => admins.adminMe(getPool(), a)));
route('PUT', 'admin/me', asAdmin((a, req) => admins.updatePrefs(a, bodyObject(req))));
route('GET', 'admin/users', asAdmin(() => admins.listUsers()));
route('POST', 'admin/admins', asAdmin((a, req) => admins.addAdmin(a, bodyObject(req))));
route('DELETE', 'admin/admins/:id', asAdmin((a, _r, [id]) => admins.removeAdmin(a, id)));
route('POST', 'admin/exports', asAdmin((a, req) => admins.createExport(a, bodyObject(req))));
route('GET', 'exports/:token', async (_req, [token]) => ({ status: 200, body: null, file: await admins.downloadExport(token) }));

for (const t of TOOLS) t.routes?.(route);

route('GET', 'health', async () => ok({ ok: true }));

export async function handle(req: ApiRequest): Promise<ApiResponse> {
  try {
    let pathMatched = false;
    for (const [method, re, h] of routes) {
      const m = re.exec(req.path);
      if (!m) continue;
      pathMatched = true;
      if (method !== req.method) continue;
      return await h(req, m.slice(1).map(decodeURIComponent));
    }
    throw pathMatched ? new HttpError(405, 'Method not allowed.') : new HttpError(404, 'Not found.');
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.message, code: e.code, ...e.extra } };
    console.error('Unhandled API error', req.method, req.path, e);
    return { status: 500, body: { error: 'Something went wrong on our side. Please try again.' } };
  }
}
