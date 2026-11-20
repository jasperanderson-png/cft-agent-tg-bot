import { getPool } from '../../database/db.js';
import { env } from '../../support/helpers/env.js';
import { HttpError, ok, requireCron, secretMatches, type ApiRequest } from '../../support/helpers/http.js';
import type { Tool } from '../../support/helpers/tool.js';
import { reportTimeZone } from '../../support/helpers/updates.js';
import { runEvening } from './cron.js';
import { dayOf } from './periods.js';
import { currentDay } from './shifts.js';
import { addEntries, checkEntry, entriesBetween, getStaff, listStaff, type Staff } from './store.js';

// Task report: shifts, the work log and the daily / weekly / monthly reports posted to a Telegram
// channel. In the chat it is the admins' ⏱ Shift section (telegram_bot/cftagents/handlers/admins/shift.ts).
//
// The API below lets Claude Code (or any trusted script) add log entries:
//   POST /api/task-report/entries   Authorization: Bearer <TASK_REPORT_TOKEN>
//   { "staff": 9447180 (optional when only one person reports),
//     "entries": [{ "kind": "done" | "improved" | "learned" | "plan" | "blocker", "text": "…",
//                   "detail"?: "…", "area"?: "Топливо", "size"?: "s" | "m" | "l", "highlight"?: true,
//                   "id"?: "unique-id-for-retries", "date"?: "2026-11-14" }] }
//   GET  /api/task-report/entries?from=2026-11-10&to=2026-11-14   the log, to check what is in it

function requireToken(req: ApiRequest) {
  const given = (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '');
  if (!env.taskReportToken || !secretMatches(given, env.taskReportToken)) throw new HttpError(401, 'Unauthorized.');
}

async function staffFor(raw: unknown): Promise<Staff> {
  const db = getPool();
  if (raw !== undefined && raw !== null) {
    const s = env.taskReportUserIds.includes(Number(raw)) ? await getStaff(db, Number(raw)) : null;
    if (!s) throw new HttpError(404, 'Nobody with this Telegram id has started a shift yet.');
    return s;
  }
  const all = await listStaff(db);
  if (all.length === 1) return all[0];
  throw new HttpError(400, all.length ? 'Several people report: say whose entries these are ("staff": <telegram id>).' : 'Nobody reports yet: start a shift in the bot first (⏱ Shift).');
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const taskReport: Tool = {
  id: 'task-report',
  routes(route) {
    route('POST', 'task-report/entries', async (req) => {
      requireToken(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const list = Array.isArray(b.entries) ? b.entries : b.kind ? [b] : [];
      if (!list.length || list.length > 50) throw new HttpError(400, 'Send 1 to 50 entries in "entries".');
      const entries = list.map((e, i) => checkEntry(e, i));
      const staff = await staffFor(b.staff);
      const db = getPool();
      const { added, skipped } = await addEntries(db, staff.id, await currentDay(db, staff.id), entries, 'claude');
      return ok({ added: added.length, skipped, days: [...new Set(added.map((e) => e.workDate))] }, 201);
    });
    route('GET', 'task-report/entries', async (req) => {
      requireToken(req);
      const db = getPool();
      const staff = await staffFor(req.query.get('staff') ?? undefined);
      const today = dayOf(new Date(), await reportTimeZone(db));
      const from = req.query.get('from') ?? today;
      const to = req.query.get('to') ?? from;
      if (!DAY_RE.test(from) || !DAY_RE.test(to)) throw new HttpError(400, 'from and to look like 2026-11-14.');
      return ok({ staff: staff.id, entries: await entriesBetween(db, staff.id, from, to) });
    });
    route('GET', 'cron/task-report', async (req) => {
      requireCron(req);
      return ok({ staff: await runEvening(getPool()) });
    });
  },
};
