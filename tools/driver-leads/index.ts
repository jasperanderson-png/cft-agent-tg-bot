import type { LeadsSummary } from '../../shared/types.js';
import { asAdmin } from '../../core/admins.js';
import { getPool } from '../../db_storage/db.js';
import { reportTimeZone } from '../../core/updates.js';
import { bodyObject, ok, requireCron } from '../../core/http.js';
import type { Tool } from '../../core/tool.js';
import { runPullSources } from './fmcsa.js';
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
    // Daily FMCSA sync (scheduled job)
    route('GET', 'cron/leads', async (req) => {
      requireCron(req);
      return ok({ sources: await runPullSources(getPool(), 'schedule') });
    });
  },
};
