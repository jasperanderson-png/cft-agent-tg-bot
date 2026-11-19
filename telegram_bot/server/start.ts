// Production server on the VM (npm start): the bot's API on 127.0.0.1:8787. Caddy (deploy/Caddyfile)
// sits in front: HTTPS, the built Mini App from dist/, and /api/* handed to this process.
import { createServer } from 'node:http';
import { nodeHandler } from './node-adapter.js';

const PORT = Number(process.env.API_PORT ?? 8787);
const HOST = process.env.API_HOST ?? '127.0.0.1';

// Every request is answered within 60 s: past that, the caller gets 504 and the log names the slow route.
// Node cannot stop the handler itself, so the long jobs keep their own shorter budgets
// (support/common/driver-config.ts) and stop on time; this is the ceiling behind those budgets.
const REQUEST_DEADLINE_MS = 60_000;

const server = createServer((req, res) => {
  const deadline = setTimeout(() => {
    console.error(`Over ${REQUEST_DEADLINE_MS / 1000} s, answered 504: ${req.method} ${(req.url ?? '').split('?')[0]}`);
    if (res.headersSent) return void res.destroy();
    res.statusCode = 504;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ error: 'The server took too long. Please try again.' }));
  }, REQUEST_DEADLINE_MS);
  res.on('close', () => clearTimeout(deadline));
  nodeHandler(req, res).catch((e) => {
    console.error(e);
    if (res.writableEnded) return;
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  });
});
// Receiving a request (headers and body) may take at most 60 s too; slow uploads are cut off.
server.requestTimeout = REQUEST_DEADLINE_MS;
server.listen(PORT, HOST, () => console.log(`CFT Agent API → http://${HOST}:${PORT}/api`));

// systemd stops the service with SIGTERM on every deploy: finish the requests in flight first.
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
});
