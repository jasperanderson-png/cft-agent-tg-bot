#!/bin/bash
# One-time setup of a fresh Ubuntu VM for the bot (safe to run again). Run as root:
#   [BRANCH=<branch>] bash setup-server.sh [domain]
# Without a domain the site is https://<ip-with-dashes>.sslip.io (a free name that points at the IP,
# good enough for Telegram and HTTPS). Guide: docs/VM_DEPLOY.md
#
# It installs Node, Caddy (HTTPS) and a firewall, makes the `cft` user that runs the bot, gets the
# code from GitHub into /home/cft/app, and installs the bot service and the scheduled jobs.
# It does NOT start the scheduled jobs or point Telegram at this server: that is the switch-over.
set -euo pipefail

REPO="${REPO:-git@github.com:jasperanderson-png/cft-agent-tg-bot.git}"
BRANCH="${BRANCH:-main}"   # the branch to run; deploy/update.sh <branch> switches later
NODE_MAJOR="${NODE_MAJOR:-24}"
APP_USER=cft
APP_DIR=/home/$APP_USER/app
IP=$(hostname -I | awk '{print $1}')   # the public address comes first (Hetzner, DigitalOcean)
DOMAIN="${1:-${IP//./-}.sslip.io}"

# Same schedules as "crons" in vercel.json (UTC).
declare -A JOBS=(
  [weekly]="Mon *-*-* 04:00:00 UTC"
  [leads]="*-*-* 14:30:00 UTC"
  [task-report]="*-*-* 18:00:00 UTC"
  [fuel]="*-*-* 11:00:00 UTC"
  [stations]="*-*-* 11:30:00 UTC"
)

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo bash $0)"; exit 1; }
say() { printf '\n== %s\n' "$*"; }

say "System updates and basic tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq git curl ca-certificates gnupg ufw debian-keyring debian-archive-keyring apt-transport-https

say "Node.js $NODE_MAJOR"
if ! node -v 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -yq nodejs
fi
node -v

say "Caddy (web server, HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi

say "Firewall: only SSH and the website"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable

say "The $APP_USER user"
id "$APP_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "CFT Agent bot" "$APP_USER"
usermod -aG systemd-journal "$APP_USER"
install -d -m 700 -o "$APP_USER" -g "$APP_USER" /home/$APP_USER/.ssh
# Whoever may log in as root (your key) may also log in as cft; GitHub's deploy key is added later.
if [ -f /root/.ssh/authorized_keys ]; then
  touch /home/$APP_USER/.ssh/authorized_keys
  sort -u /root/.ssh/authorized_keys /home/$APP_USER/.ssh/authorized_keys -o /home/$APP_USER/.ssh/authorized_keys
  chown "$APP_USER:$APP_USER" /home/$APP_USER/.ssh/authorized_keys
  chmod 600 /home/$APP_USER/.ssh/authorized_keys
fi
# deploy/update.sh restarts the bot; that one command needs no password.
echo "$APP_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart cft-agent" > /etc/sudoers.d/cft-agent
chmod 440 /etc/sudoers.d/cft-agent

say "Access to the code on GitHub (read-only deploy key)"
KEY=/home/$APP_USER/.ssh/github_deploy
if [ ! -f "$KEY" ]; then
  sudo -u "$APP_USER" ssh-keygen -t ed25519 -N "" -C "cft-vm-deploy" -f "$KEY" -q
  sudo -u "$APP_USER" tee /home/$APP_USER/.ssh/config >/dev/null <<EOF
Host github.com
  IdentityFile $KEY
  IdentitiesOnly yes
EOF
  sudo -u "$APP_USER" sh -c 'ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null'
fi

if [ ! -d "$APP_DIR/.git" ]; then
  if ! sudo -u "$APP_USER" git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR" 2>/dev/null; then
    cat <<EOF

!! GitHub refused: the server's key is not on the repository yet. Add it once:
!!   GitHub → the repository → Settings → Deploy keys → Add deploy key
!!   Title: CFT VM     Key (one line):
$(cat "$KEY.pub")
!!   Leave "Allow write access" OFF. Then run this script again.
EOF
    exit 2
  fi
fi
echo "Code is in $APP_DIR"

say "Settings file (.env)"
if [ ! -f "$APP_DIR/.env" ]; then
  sudo -u "$APP_USER" cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  ENV_NEW=1
fi
chmod 600 "$APP_DIR/.env"
sudo -u "$APP_USER" sed -i "s#^APP_URL=.*#APP_URL=https://$DOMAIN#" "$APP_DIR/.env"
grep -q '^APP_URL=' "$APP_DIR/.env" || echo "APP_URL=https://$DOMAIN" | sudo -u "$APP_USER" tee -a "$APP_DIR/.env" >/dev/null

say "Bot service, website and scheduled jobs"
chmod +x "$APP_DIR"/deploy/*.sh
install -m 644 "$APP_DIR/deploy/cft-agent.service" /etc/systemd/system/cft-agent.service
install -m 644 "$APP_DIR/deploy/cft-cron@.service" /etc/systemd/system/cft-cron@.service
for job in "${!JOBS[@]}"; do
  cat > "/etc/systemd/system/cft-cron-$job.timer" <<EOF
[Unit]
Description=CFT Agent scheduled job: $job

[Timer]
OnCalendar=${JOBS[$job]}
Unit=cft-cron@$job.service

[Install]
WantedBy=timers.target
EOF
done
sed -e "s#__DOMAIN__#$DOMAIN#" -e "s#__APP_DIR__#$APP_DIR#" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
chmod 711 /home/$APP_USER   # Caddy may read dist/, nothing else
systemctl daemon-reload
systemctl enable cft-agent >/dev/null
systemctl reload caddy || systemctl restart caddy

cat <<EOF

== Done. The site will be https://$DOMAIN
Next (docs/VM_DEPLOY.md):
EOF
[ "${ENV_NEW:-}" = 1 ] && echo "  1. Fill in $APP_DIR/.env (the same values as on Vercel)."
cat <<EOF
  2. As cft: cd ~/app && deploy/update.sh $BRANCH   (installs, builds, starts the bot)
  3. Check: curl -s https://$DOMAIN/api/health
  4. Switch-over (ask first): Telegram webhook + scheduled jobs, see the guide.
EOF
