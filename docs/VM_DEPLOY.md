# Running the bot on the VM (DigitalOcean)

**Vercel stays the live bot.** People use it, so nothing below touches it: Telegram keeps sending
updates to Vercel, and Vercel keeps running the scheduled jobs. The VM is a second copy, sharing the
same database, that you can open and test. Switching people over is a separate step (the end of this
guide), done only when you decide.

| | |
|---|---|
| Server | DigitalOcean Droplet `ubuntu-s-1vcpu-2gb-lon1` (London), 1 CPU, 2 GB RAM + 2 GB swap, 50 GB disk, Ubuntu 24.04 |
| Address | `209.97.132.149` |
| Website | `https://209-97-132-149.sslip.io` (sslip.io is a free name pointing at the IP; a real domain can replace it) |
| Code on the server | `/home/cft/app`, run by the `cft` user |
| Files | `deploy/` (setup, update, web server, service), `.github/workflows/deploy-vm.yml` (the GitHub button) |

How it fits together: **Caddy** (web server) holds the HTTPS certificate, serves the Mini App from
`dist/` and hands `/api/*` to the bot. The bot (`npm start`, `telegram_bot/server/start.ts`) is the
same code as the Vercel function, as a background service (`cft-agent`) that restarts by itself.
Vercel Cron's jobs become systemd timers (`cft-cron-*.timer`), installed **switched off**.

## 1. Access (once)

1. Your PC's key (`C:\Users\user\.ssh\id_ed25519.pub`) goes on GitHub: github.com → Settings → SSH and
   GPG keys → New SSH key.
2. The admin runs on the server, as root: `ssh-import-id gh:jasperanderson-png`
3. Check from your PC: `ssh root@209.97.132.149`

## 2. Set up the server (once)

```bash
scp deploy/setup-server.sh root@209.97.132.149:
ssh root@209.97.132.149 bash setup-server.sh
# until the deploy files are merged into main:
# ssh root@209.97.132.149 BRANCH=refactor/shrink-codebase bash setup-server.sh
```

The first run stops and prints the server's **deploy key**: add it on GitHub → the repository →
Settings → Deploy keys (read-only, leave write access off), then run the script again.

Then fill in `/home/cft/app/.env` with the same values as on Vercel (Vercel → Project → Settings →
Environment Variables), **except** `APP_URL`, which the script already set to the VM's address.

## 3. The "Deploy to VM" button on GitHub (once)

GitHub → the repository → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `VM_HOST` | `209.97.132.149` |
| `VM_USER` | `cft` |
| `VM_SSH_KEY` | the whole file `C:\Users\user\.ssh\cft_github_actions` (the private key, used only by this button) |
| `VM_HOST_KEY` | `209.97.132.149 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIcxuH1ClZLMUyNhNd4E70uGHDZwrBEimVIt2BV4pWcJ` |

And let that key in, on the server: append `C:\Users\user\.ssh\cft_github_actions.pub` to
`/home/cft/.ssh/authorized_keys`.

## Deploying

GitHub → Actions → **Deploy to VM** → Run workflow → pick the branch. Or on the server, as `cft`:
`cd ~/app && deploy/update.sh main`. It fetches the code, installs, builds and restarts the bot.

It never changes the database. If new migration files arrived, it says so; apply them by hand with
`npm run db:migrate` after checking them. Remember the database is shared with Vercel.

Check: `curl -s https://209-97-132-149.sslip.io/api/health` → `{"ok":true}`
Logs: `journalctl -u cft-agent -f` (the bot), `journalctl -u caddy` (the website).

## Switching people over (later, only when decided)

Do these together, then Vercel can be retired:

1. Turn on the VM's scheduled jobs:
   `systemctl enable --now cft-cron-weekly.timer cft-cron-leads.timer cft-cron-task-report.timer cft-cron-fuel.timer cft-cron-stations.timer`
2. Point Telegram at the VM: as `cft`, `cd ~/app && npm run telegram:setup`.
3. Remove the `crons` from `vercel.json` (or the Vercel project), or every job runs twice.

To go back: run `npm run telegram:setup` from a machine whose `APP_URL` is the Vercel address, and
turn the timers off again (`systemctl disable --now 'cft-cron-*.timer'`).
