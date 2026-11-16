import type { Tool } from '../../core/tool.js';
import { academy } from '../../tools/agent-academy/index.js';
import { agents } from '../../tools/agents/index.js';
import { driverLeads } from '../../tools/driver-leads/index.js';
import { fuelPrices } from '../../tools/fuel-prices/index.js';
import { taskReport } from '../../task_report/index.js';

/**
 * Every tool whose API the server serves (paths below /api). To add a tool: write
 * tools/<name>/index.ts (or task_report/index.ts) and add it here. What people can do with it in
 * the chat is wired separately, per role, in telegram_bot/handlers/<role>/.
 */
export const TOOLS: Tool[] = [academy, driverLeads, fuelPrices, agents, taskReport];
