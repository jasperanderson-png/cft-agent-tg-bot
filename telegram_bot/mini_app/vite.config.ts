// Build of the browser side: the Telegram Mini App (index.html + src/, with the screens of every role
// in src/screens/) and the Driver Leads sign-up page.
// Output goes to dist/ at the project root, which Caddy serves as the website (deploy/Caddyfile).
import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const DRIVERS_PAGE = resolve(import.meta.dirname, '../../tools/driver-leads/signup-page');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

/**
 * The driver sign-up page belongs to Driver Leads, not to the Mini App. It is plain HTML + JS with no
 * build step, published as-is at /drivers/ (and served there by the dev server too).
 */
function driversPage(): Plugin {
  return {
    name: 'drivers-page',
    configureServer(server) {
      server.middlewares.use('/drivers', (req, res, next) => {
        let file = join(DRIVERS_PAGE, decodeURIComponent((req.url ?? '/').split('?')[0]));
        if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
        if (!file.startsWith(DRIVERS_PAGE + sep) || !existsSync(file)) return next();
        res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    writeBundle({ dir }) {
      cpSync(DRIVERS_PAGE, join(dir ?? resolve(import.meta.dirname, '../../dist'), 'drivers'), { recursive: true });
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), driversPage()],
  build: { target: 'es2020', sourcemap: false, outDir: '../../dist', emptyOutDir: true },
});
