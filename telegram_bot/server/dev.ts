// Local development: the bot's API on :8787 (same router as the Vercel function) plus the Mini App
// on :5173 (Vite, which forwards /api to the API).
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createServer as createVite } from 'vite';
import { nodeHandler } from './node-adapter.js';

const API_PORT = Number(process.env.API_PORT ?? 8787);

createServer((req, res) => {
  nodeHandler(req, res).catch((e) => {
    console.error(e);
    res.statusCode = 500;
    res.end();
  });
}).listen(API_PORT, () => console.log(`API  → http://localhost:${API_PORT}/api`));

const vite = await createVite({
  configFile: join(import.meta.dirname, '../mini_app/vite.config.ts'),
  server: { host: true, port: 5173, proxy: { '/api': `http://localhost:${API_PORT}` } },
});
await vite.listen();
vite.printUrls();
