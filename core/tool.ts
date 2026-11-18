import type { AddRoute } from './http.js';

/**
 * What a tool (tools/<name>/index.ts, task_report/index.ts) gives the app: its HTTP API, used by the
 * Mini App, scheduled jobs and outside services. telegram_bot/server/tools.ts lists them.
 *
 * A tool holds the business: its data, its rules and what it sends. It never decides who may ask
 * for something in the chat; that is the job of telegram_bot/handlers/<role>/.
 */
export interface Tool {
  id: string;
  /** Adds the tool's API routes (paths below /api). */
  routes?(route: AddRoute): void;
}
