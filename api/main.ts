import type { IncomingMessage, ServerResponse } from 'node:http';
import { nodeHandler } from '../telegram_bot/server/node-adapter.js';

// Vercel requires functions in /api at the project root. This one file serves the whole bot side:
// vercel.json rewrites /api/* here, and telegram_bot/server/router.ts takes it from there.
export default function handler(req: IncomingMessage, res: ServerResponse) {
  return nodeHandler(req, res);
}
