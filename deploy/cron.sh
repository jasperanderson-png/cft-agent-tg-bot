#!/bin/sh
# Runs one scheduled job on the VM: deploy/cron.sh <name> calls /api/cron/<name> with CRON_SECRET,
# the call a scheduled job makes. Started by systemd (deploy/cft-cron@.service).
set -eu
cd "$(dirname "$0")/.."
secret=$(sed -n 's/^CRON_SECRET=//p' .env | tail -n 1 | sed "s/^[\"']//; s/[\"']\$//")
[ -n "$secret" ] || { echo "CRON_SECRET is missing in .env" >&2; exit 1; }
curl -fsS --max-time 120 -H "Authorization: Bearer $secret" "http://127.0.0.1:8787/api/cron/$1"
echo
