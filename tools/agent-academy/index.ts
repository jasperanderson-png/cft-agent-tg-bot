import { rangeFor, type RangeKey } from '../../shared/time.js';
import type { AcademySummary } from '../../shared/types.js';
import { asAdmin, storeExport } from '../../core/admins.js';
import { getPool } from '../../db_storage/db.js';
import { bodyObject, HttpError, ok, requireCron, type ApiRequest } from '../../core/http.js';
import type { Tool } from '../../core/tool.js';
import { XLSX_TYPE } from '../../core/xlsx.js';
import * as cand from './candidate.js';
import * as console_ from './console.js';
import * as notify from './notify.js';
import { summarize } from './reports.js';
import * as sheets from './sheets.js';

// Agent Academy: the Sales Agent knowledge test (Mini App), its results, reports and admin console.

const RANGES: RangeKey[] = ['week', 'last_week', '30d', 'all'];
const attemptToken = (req: ApiRequest) => req.headers['x-attempt-token'];

export const academy: Tool = {
  id: 'agent-academy',
  routes(route) {
    // The test, for candidates
    route('GET', 'config', async () => ok(await cand.publicConfig()));
    route('POST', 'session', async (req) => ok(await cand.telegramSession(bodyObject(req))));
    route('POST', 'attempts', async (req) => ok(await cand.startAttempt(bodyObject(req)), 201));
    route('GET', 'attempts/:id', async (req, [id]) => ok(await cand.getAttempt(id, attemptToken(req))));
    route('PUT', 'attempts/:id/answers', async (req, [id]) => ok(await cand.saveAnswers(id, attemptToken(req), bodyObject(req))));
    route('POST', 'attempts/:id/submit', async (req, [id]) => ok(await cand.submitAttempt(id, attemptToken(req), bodyObject(req))));

    // The admin console
    route('GET', 'admin/data', asAdmin((a) => console_.adminData(a)));
    route('GET', 'admin/attempts/:id', asAdmin((_a, _r, [id]) => console_.attemptReview(id)));
    route('PUT', 'admin/questions/:id', asAdmin((a, req, [id]) => console_.updateQuestion(a, id, bodyObject(req))));
    route('PUT', 'admin/settings', asAdmin((a, req) => console_.updateSettings(a, bodyObject(req))));
    route('POST', 'admin/reports', asAdmin(async (a, req) => {
      const b = bodyObject(req);
      const key = RANGES.includes(b.range as RangeKey) ? (b.range as RangeKey) : 'all';
      if (b.deliver === 'telegram') {
        if (!a.telegramUserId) throw new HttpError(400, 'Your admin account is not linked to Telegram. Use Download instead.');
        await notify.sendReportToChat(getPool(), a.telegramUserId, key);
        return { sent: true };
      }
      const { bytes, filename } = await notify.makeReport(getPool(), key);
      return storeExport(a, filename, XLSX_TYPE, bytes);
    }));
    route('POST', 'admin/weekly/send', asAdmin(() => notify.sendWeeklyReport(true)));
    route('POST', 'admin/sheets/link', asAdmin((_a, req) => sheets.linkSheet(bodyObject(req).url)));
    route('POST', 'admin/sheets/create', asAdmin((a) => {
      if (!a.email) throw new HttpError(400, 'A new sheet is shared with your email, and your admin account has none. Link an existing sheet instead.');
      return sheets.createSheet(a.email);
    }));
    route('POST', 'admin/sheets/sync', asAdmin(() => sheets.syncNow()));
    route('PUT', 'admin/sheets/auto', asAdmin((_a, req) => sheets.setAutoSync(bodyObject(req).on)));
    route('DELETE', 'admin/sheets', asAdmin(() => sheets.disconnectSheet()));

    // The Hub tile: this week so far
    route('GET', 'academy/summary', asAdmin(async (): Promise<AcademySummary> => {
      const input = await notify.reportInput(getPool());
      const s = summarize(input, rangeFor('week', input.settings.timezone));
      return { week: { started: s.started, completed: s.completed, passed: s.passed } };
    }));

    // Monday summary (Vercel Cron)
    route('GET', 'cron/weekly', async (req) => {
      requireCron(req);
      return ok(await notify.sendWeeklyReport(false));
    });
  },
};
