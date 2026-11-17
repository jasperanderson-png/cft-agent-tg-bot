// Production server on the VM (npm start): the bot's API on 127.0.0.1:8787. Caddy (deploy/Caddyfile)
// sits in front: HTTPS, the built Mini App from dist/, and /api/* handed to this process.
// On Vercel, api/main.ts does the same job; both use the same router.
import { createServer } from 'node:http';
import { nodeHandler } from './node-adapter.js';

const PORT = Number(process.env.API_PORT ?? 8787);
const HOST = process.env.API_HOST ?? '127.0.0.1';

const server = createServer((req, res) => {
  nodeHandler(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  });
});
// Vercel stopped a request after 60 s (vercel.json maxDuration); keep the same limit here.
server.requestTimeout = 60_000;
server.listen(PORT, HOST, () => console.log(`CFT Agent API → http://${HOST}:${PORT}/api`));

// systemd stops the service with SIGTERM on every deploy: finish the requests in flight first.
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
});
