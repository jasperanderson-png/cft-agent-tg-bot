#!/bin/bash
# Puts the latest code from GitHub live on the VM. Run as the cft user (the GitHub "Deploy to VM"
# button does it over SSH): deploy/update.sh [branch] [--migrate]   (default branch: main)
# New database migrations are applied only with --migrate, and then BEFORE the new code goes live
# (the old code ignores new tables; the new code needs them). Without --migrate, a deploy that brings
# new migrations stops and changes nothing, so the live bot never runs code its database lacks.
# Only added files count: an applied migration is never run again, so editing one needs no --migrate.
set -euo pipefail
cd "$(dirname "$0")/.."
branch=main
migrate=0
for arg in "$@"; do
  case "$arg" in
    --migrate) migrate=1 ;;
    -*) echo "Unknown option: $arg" >&2; exit 1 ;;
    *) branch="$arg" ;;
  esac
done

before=$(git rev-parse HEAD)
git fetch --quiet origin "$branch"
git checkout --quiet -B "$branch" "origin/$branch"
after=$(git rev-parse HEAD)
echo "Code: ${before:0:7} -> ${after:0:7} ($branch)"

new_migrations=""
if [ "$before" != "$after" ]; then
  new_migrations=$(git diff --name-only --diff-filter=A "$before" "$after" -- db_storage/migrations)
fi
if [ -n "$new_migrations" ] && [ "$migrate" -eq 0 ]; then
  git checkout --quiet -B "$branch" "$before"
  echo "!! New database migrations arrived:" >&2
  echo "$new_migrations" | sed 's/^/!!   /' >&2
  echo "!! Nothing was changed; the bot still runs ${before:0:7}." >&2
  echo "!! After checking them, deploy with: deploy/update.sh $branch --migrate" >&2
  exit 1
fi

npm ci --no-audit --no-fund
npm run build

if [ -n "$new_migrations" ]; then
  echo "Applying database migrations (the old code keeps running meanwhile)"
  npm run --silent db:migrate
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
