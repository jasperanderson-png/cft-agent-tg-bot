# Running the bot on the VM (DigitalOcean)

**The VM is the live bot** (since 18/11/2026): Telegram sends every update here, the scheduled jobs
run here, and so does the database. Vercel is no longer used (the project was deleted).

| | |
|---|---|
| Server | DigitalOcean Droplet `ubuntu-s-1vcpu-2gb-lon1` (London), 1 CPU, 2 GB RAM + 2 GB swap, 50 GB disk, Ubuntu 24.04 |
| Address | `209.97.132.149` |
| Website | `https://209-97-132-149.sslip.io` (sslip.io is a free name pointing at the IP; a real domain can replace it) |
| Code on the server | `/home/cft/app` (branch `main`), run by the `cft` user; settings in `/home/cft/app/.env` |
| Database | PostgreSQL 17 on the server itself (`cft_agent`, only reachable from the server) |
| Cache | Redis 7 on the server itself (only reachable from the server, with a password) |
| Files | `deploy/` (setup, update, web server, service), `.github/workflows/deploy-vm.yml` (the GitHub button) |

How it fits together: **Caddy** (web server) holds the HTTPS certificate, serves the Mini App from
`dist/` and hands `/api/*` to the bot. The bot (`npm start`, `telegram_bot/server/start.ts`) runs as a
background service (`cft-agent`) that restarts by itself. The scheduled jobs are systemd timers
(`cft-cron-*.timer`, the times are in `deploy/setup-server.sh`). Logins: SSH keys only, no passwords.

## Deploying

GitHub → Actions → **Deploy to VM** → Run workflow → `main`. Or on the server, as `cft`:
`cd ~/app && deploy/update.sh main`. It fetches the code, installs, builds and restarts the bot.

Database changes: if the new code brings migration files, a plain deploy stops before changing
anything and lists them (the bot keeps running the old code). Check them, then deploy again with
`deploy/update.sh main --migrate` (or tick **migrate** in the workflow): the migrations are applied
first, while the old code still runs, and only then does the new code go live.

Check: `curl -s https://209-97-132-149.sslip.io/api/health` → `{"ok":true}`
Logs: `journalctl -u cft-agent -f` (the bot), `journalctl -u 'cft-cron@*'` (the jobs), `journalctl -u caddy` (the website).

## The database

- PostgreSQL 17, listening on `127.0.0.1` only (and the firewall allows only SSH and the website).
  The bot's address is in `.env` (`DATABASE_URL`) and in `/home/cft/.local-db-url`.
- **Nightly backup** at 21:30 UTC (`cft-db-backup.timer` → `/usr/local/bin/cft-db-backup`): a full
  copy in `/var/backups/cft-db/`, kept 14 days. Make one now: `sudo -u cft /usr/local/bin/cft-db-backup`.
- **Restore** a copy (stops the bot first):
  ```bash
  systemctl stop cft-agent
  sudo -u cft pg_restore --clean --if-exists --no-owner -d "$(cat /home/cft/.local-db-url)" /var/backups/cft-db/<file>.dump
  systemctl start cft-agent
  ```
- Turn on **DigitalOcean Backups** for the Droplet too: the nightly copies live on the same server.
- Moved from Supabase on 18/11/2026; the copy taken then is kept in
  `/var/backups/cft-db/supabase-final-20261118.dump` (not cleaned up). The old Supabase database was
  emptied the same day.

## The cache (Redis)

- Redis 7 (`redis-server`), on `127.0.0.1` only, with a password; our settings are in
  `/etc/redis/cft.conf` (included from `/etc/redis/redis.conf`). It keeps its data on disk, so a restart
  keeps the counts.
- What it holds: the daily and monthly counts that keep TomTom routes, the Google voice and
  OpenRouteService inside their free allowances, rate limits, the voice clip cache and "say it once"
  markers (`support/helpers/kv.ts`, keys `cft:*`). The bot's address for it: `REDIS_URL` in `.env` (also in
  `/home/cft/.local-redis-url`). If Redis is down the bot keeps working, counting in memory.
- Look inside: `REDISCLI_AUTH=$(sed -E 's#redis://:([^@]+)@.*#\1#' /home/cft/.local-redis-url) redis-cli --scan --pattern 'cft:*'`
- Moved from Upstash on 18/11/2026. The `KV_REST_API_*` values in `.env` are no longer used while
  `REDIS_URL` is set.

## Setting up a new server

1. Your PC's key (`C:\Users\user\.ssh\id_ed25519.pub`) in the provider's "SSH key" box when creating
   the server, or `ssh-import-id gh:jasperanderson-png` on it.
2. Install:
   ```bash
   scp deploy/setup-server.sh root@<ip>:
   ssh root@<ip> bash setup-server.sh
   ```
   The first run stops and prints the server's **deploy key**: add it on GitHub → the repository →
   Settings → Deploy keys (read-only), then run the script again.
3. Fill in `/home/cft/app/.env` (copy the current server's, except `APP_URL`, which the script sets),
   then as `cft`: `cd ~/app && deploy/update.sh main`.
4. Database: install PostgreSQL 17 and restore the latest nightly copy (see above). Cache:
   `apt install redis-server`, copy `/etc/redis/cft.conf` (new password) and set `REDIS_URL`.
5. Move people: turn on the timers
   (`systemctl enable --now cft-cron-weekly.timer cft-cron-leads.timer cft-cron-task-report.timer cft-cron-fuel.timer cft-cron-stations.timer`),
   point Telegram at it (as `cft`: `cd ~/app && npm run telegram:setup`), change the Mini App URL in
   @BotFather (Bot Settings → Configure Mini App), and switch the old server's timers off, or every
   job runs twice.

## The "Deploy to VM" button on GitHub

Repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `VM_HOST` | `209.97.132.149` |
| `VM_USER` | `cft` |
| `VM_SSH_KEY` | the whole file `C:\Users\user\.ssh\cft_github_actions` (the private key, used only by this button) |
| `VM_HOST_KEY` | `209.97.132.149 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIcxuH1ClZLMUyNhNd4E70uGHDZwrBEimVIt2BV4pWcJ` |

The matching public key (`cft_github_actions.pub`) is in `/home/cft/.ssh/authorized_keys`.
