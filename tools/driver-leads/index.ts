import type { LeadsSummary } from '../../support/common/types.js';
import { asAdmin } from '../../support/helpers/admins.js';
import { getPool } from '../../database/db.js';
import { reportTimeZone } from '../../support/helpers/updates.js';
import { bodyObject, ok, requireCron } from '../../support/helpers/http.js';
import type { Tool } from '../../support/helpers/tool.js';
import { runPullSources } from './fmcsa.js';
import * as app from './app.js';
import * as leads from './ingest.js';
import { leadStats } from './store.js';

// Driver Leads: the driver-lead database, the public sign-up page, vendor webhooks and the daily FMCSA
// sync. What it does in the chat is in actions.ts; the admins' buttons are in telegram_bot/handlers/admins/leads.ts.

export const driverLeads: Tool = {
  id: 'driver-leads',
  routes(route) {
    // The sign-up page (/drivers/), opt-outs and vendor webhooks
    route('GET', 'leads/form-config', async () => ok(leads.formConfig()));
    route('POST', 'leads/register', async (req) => ok(await leads.registerDriver(req, bodyObject(req)), 201));
    route('POST', 'leads/optout', async (req) => ok(await leads.publicOptOut(req, bodyObject(req))));
    route('POST', 'leads/ingest/:source', async (req, [source]) => ok(await leads.webhookIngest(req, source)));
    // The Hub tile (admins only, like the rest of Driver Leads)
    route('GET', 'leads/summary', asAdmin(async (): Promise<LeadsSummary> => {
      const db = getPool();
      const s = await leadStats(db, await reportTimeZone(db));
      return { waiting: s.undelivered, today: s.today, total: s.total };
    }));
    // Driver Leads in the Mini App and on the website (app.ts): statistics, new leads and the files,
    // as downloads instead of chat messages. Admins only, like the bot's Driver Leads.
    route('GET', 'leads/app', asAdmin(() => app.leadsApp(getPool())));
    route('POST', 'leads/app/recent', asAdmin((a) => app.recentFile(getPool(), a)));
    route('POST', 'leads/app/last', asAdmin((a) => app.lastFile(getPool(), a)));
    route('POST', 'leads/app/export', asAdmin((a, req) => app.exportFile(getPool(), a, bodyObject(req))));
    // Daily FMCSA sync (scheduled job)
    route('GET', 'cron/leads', async (req) => {
      requireCron(req);
      return ok({ sources: await runPullSources(getPool(), 'schedule') });
    });
  },
};
