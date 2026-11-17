#!/bin/bash
# Puts the latest code from GitHub live on the VM. Run as the cft user (the GitHub "Deploy to VM"
# button does it over SSH): deploy/update.sh [branch]   (default: main)
# Database changes are NOT applied here: run `npm run db:migrate` by hand after checking them.
set -euo pipefail
cd "$(dirname "$0")/.."
branch="${1:-main}"

before=$(git rev-parse HEAD)
git fetch --quiet origin "$branch"
git checkout --quiet -B "$branch" "origin/$branch"
after=$(git rev-parse HEAD)
echo "Code: ${before:0:7} -> ${after:0:7} ($branch)"

npm ci --no-audit --no-fund
npm run build

# New migration files since the last deploy? Say so loudly; applying them is a separate, deliberate step.
if [ "$before" != "$after" ] && git diff --name-only "$before" "$after" -- db_storage/migrations | grep -q .; then
  echo "!! New database migrations arrived:"
  git diff --name-only "$before" "$after" -- db_storage/migrations | sed 's/^/!!   /'
  echo "!! Apply them with: npm run db:migrate   (after checking them)"
fi

sudo /usr/bin/systemctl restart cft-agent
sleep 3
if systemctl is-active --quiet cft-agent; then
  echo "Live: cft-agent restarted on ${after:0:7}"
else
  echo "cft-agent did not start. Last log lines:" >&2
  journalctl -u cft-agent -n 30 --no-pager >&2 || true
  exit 1
fi
