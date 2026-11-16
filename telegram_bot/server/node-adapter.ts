import type { IncomingMessage, ServerResponse } from 'node:http';
import { handle } from './router.js';

const MAX_BODY = 2.5 * 1024 * 1024; // CSV exports can be large

const isForm = (req: IncomingMessage) => /^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] ?? '');
const formObject = (raw: string) => Object.fromEntries(new URLSearchParams(raw));

async function readBody(req: IncomingMessage & { body?: unknown }): Promise<unknown> {
  const form = isForm(req);
  // Vercel's Node runtime may have parsed the body already.
  if (req.body !== undefined) return typeof req.body === 'string' ? (form ? formObject(req.body) : JSON.parse(req.body || 'null')) : req.body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (form) return formObject(raw);
  return raw ? JSON.parse(raw) : null;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}

/** Adapts Node's http request/response (Vercel functions, local dev server) to the router. */
export async function nodeHandler(req: IncomingMessage & { body?: unknown }, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local');
  // vercel.json rewrites /api/<path> to /api/main?__path=<path>
  const path = (url.searchParams.get('__path') ?? url.pathname.replace(/^\/api\/?/, '')).replace(/^\/+|\/+$/g, '');
  url.searchParams.delete('__path');

  let body: unknown = null;
  const len = req.headers['content-length'];
  const hasBody = len !== undefined ? len !== '0' : !!req.headers['transfer-encoding'];
  if (req.method !== 'GET' && req.method !== 'HEAD' && hasBody) {
    // Lead vendors commonly post form-encoded bodies; everything else must be JSON.
    const formOk = isForm(req) && path.startsWith('leads/ingest/');
    if (!formOk && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return send(res, 415, { error: 'Send JSON with Content-Type: application/json.' });
    }
    try {
      body = await readBody(req);
    } catch (e) {
      return send(res, (e as { status?: number }).status ?? 400, { error: 'The request body is not valid JSON.' });
    }
  }
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0].trim() || req.socket?.remoteAddress || null;
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;

  const out = await handle({ method: req.method ?? 'GET', path, query: url.searchParams, headers, body, ip });
  if (out.file) {
    res.statusCode = out.status;
    res.setHeader('content-type', out.file.contentType);
    res.setHeader('content-disposition', `${out.file.inline ? 'inline' : 'attachment'}; filename="${out.file.filename}"`);
    res.setHeader('cache-control', out.file.cacheControl ?? 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    return void res.end(out.file.content);
  }
  send(res, out.status, out.body);
}
