import { timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface ApiRequest {
  method: string;
  /** Path below /api, without leading slash, e.g. "attempts/abc/submit" */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: unknown;
  ip: string | null;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  /** Non-JSON payload (file downloads). */
  file?: {
    contentType: string; filename: string; content: string | Uint8Array;
    /** Shown in the page (audio) instead of downloaded. */
    inline?: boolean;
    /** Cache-Control; default no-store. */
    cacheControl?: string;
  };
}

export const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });

/** Answers one API route. `params` are the :placeholders of its path, in order. */
export type Handler = (req: ApiRequest, params: string[]) => Promise<ApiResponse>;
/** Adds a route, e.g. route('GET', 'attempts/:id', handler). Paths are below /api. */
export type AddRoute = (method: string, pattern: string, h: Handler) => void;

export function bodyObject(req: ApiRequest): Record<string, unknown> {
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Expected a JSON object body.');
  return b as Record<string, unknown>;
}

export function bearer(req: ApiRequest): string | null {
  const h = req.headers['authorization'];
  const m = h && /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(h.trim());
  return m ? m[1] : null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Compares a secret someone sent with the expected one, in constant time. */
export function secretMatches(given: string | undefined, want: string): boolean {
  if (!want || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Scheduled jobs (deploy/cron.sh) send "Authorization: Bearer <CRON_SECRET>". */
export function requireCron(req: ApiRequest) {
  const h = req.headers['authorization'] ?? '';
  if (!env.cronSecret || !secretMatches(h.replace(/^Bearer\s+/i, ''), env.cronSecret)) throw new HttpError(401, 'Unauthorized.');
}
