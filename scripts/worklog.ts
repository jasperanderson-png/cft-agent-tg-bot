// Adds work-log entries to the live bot, the way Claude Code logs finished work.
// Usage: npm run worklog -- entries.json        (or pipe the JSON in)
// The file holds { "entries": [ … ] } or just the array; see task_report/index.ts for the fields.
// Needs APP_URL and TASK_REPORT_TOKEN (read from .env.production.local).
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const raw = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
const parsed = JSON.parse(raw);
const body = Array.isArray(parsed) ? { entries: parsed } : parsed;
const url = (process.env.APP_URL ?? '').replace(/\/+$/, '');
const token = process.env.TASK_REPORT_TOKEN ?? '';
if (!url || !token) {
  console.error('APP_URL and TASK_REPORT_TOKEN must be set (.env.production.local).');
  process.exit(1);
}
const res = await fetch(`${url}/api/task-report/entries`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log(res.status, text);
if (!res.ok) process.exitCode = 1;
