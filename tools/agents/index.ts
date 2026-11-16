import { createInvite, listAgents, removeAgent, revokeInvite } from '../../core/agents.js';
import { asAdmin } from '../../core/admins.js';
import { getPool } from '../../db_storage/db.js';
import { bodyObject, HttpError, UUID_RE } from '../../core/http.js';
import type { Tool } from '../../core/tool.js';

// Agents: invite links (anyone with one can join until it expires or is turned off), the agent list
// and removing an agent. The Team screen of the Mini App uses this API; the bot's /invite and /agents
// are in telegram_bot/handlers/admins/team.ts.

export const agents: Tool = {
  id: 'agents',
  routes(route) {
    route('GET', 'admin/agents', asAdmin(() => listAgents(getPool())));
    route('POST', 'admin/agents/invites', asAdmin((a, req) => {
      const b = bodyObject(req);
      return createInvite(getPool(), a.id, b.hours, b.label);
    }));
    route('DELETE', 'admin/agents/invites/:id', asAdmin((a, _r, [id]) => {
      if (!UUID_RE.test(id)) throw new HttpError(404, 'Link not found.');
      return revokeInvite(a, id);
    }));
    route('DELETE', 'admin/agents/:tg', asAdmin((a, _r, [tg]) => removeAgent(a, Number(tg))));
  },
};

