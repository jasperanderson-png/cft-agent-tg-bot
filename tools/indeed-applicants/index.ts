import { getPool } from '../../database/db.js';
import { env } from '../../support/helpers/env.js';
import { ok, requireCron } from '../../support/helpers/http.js';
import type { Tool } from '../../support/helpers/tool.js';
import { handleReport, parseReport, requireCollector, sendImportFile, watch } from './report.js';

// Indeed Applicants: the hiring pipeline from Indeed. The office script posts what it sees; the bot
// posts a card per new applicant to the hiring chat (INDEED_CHAT_ID), warns when the script stops,
// and sends the lead-import Excel file daily. Kept apart from Driver Leads: Indeed's data is for
// hiring only. Admins' buttons: telegram_bot/handlers/admins/indeed.ts. Docs: docs/INDEED_APPLICANTS.md.

export const indeedApplicants: Tool = {
  id: 'indeed-applicants',
  routes(route) {
    // The office script (Authorization: Bearer <INDEED_COLLECTOR_TOKEN>)
    route('POST', 'indeed/report', async (req) => {
      requireCollector(req);
      return ok(await handleReport(getPool(), parseReport(req.body)));
    });
    // Scheduled jobs: the silence watch (every 30 minutes) and the daily import file
    route('GET', 'cron/indeed-watch', async (req) => {
      requireCron(req);
      return ok(await watch(getPool()));
    });
    route('GET', 'cron/indeed-excel', async (req) => {
      requireCron(req);
      const chat = env.indeedChatId;
      if (!chat || !env.indeedCollectorToken) return ok({ skipped: 'INDEED_CHAT_ID or INDEED_COLLECTOR_TOKEN is not set' });
      return ok(await sendImportFile(getPool(), chat, 'daily'));
    });
  },
};
