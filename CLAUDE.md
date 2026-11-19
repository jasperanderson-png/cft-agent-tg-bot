# CFT Agent — notes for Claude Code

One Telegram bot (@cft_Agentbot) with its Mini App, one database, one server (DigitalOcean VM, docs/VM_DEPLOY.md). The layout
and its rules are in README.md ("Project layout"): `telegram_bot/` decides who may do what,
`tools/` does the work (one folder per feature), `database/` is the database, `support/` holds the helpers; imports only go downward.

- The bot's own texts (buttons, commands, replies) are in English. Work reports in the channel are in Russian.
- Dates are dd/mm/yyyy; the report time zone is Asia/Tashkent.
- Ask before every deploy (push to `main`, then `deploy/update.sh main` on the VM as `cft`, or GitHub → Actions → Deploy to VM) and before production migrations.

## Logging finished work (task report)

The bot posts the user's work reports (daily, weekly, monthly) to a Telegram channel, for readers who
are **not programmers**. Claude writes the entries. After finishing a piece of work the user asked
for (not after every small step), log it:

```bash
npm run worklog -- /path/to/entries.json
```

with a file like:

```json
{ "entries": [
  { "kind": "done", "text": "Агенты находят цены на топливо, даже если ошиблись в названии штата", "area": "Топливо", "size": "m", "id": "2026-11-14-fuel-typos" },
  { "kind": "improved", "text": "Меньше ошибок у агентов при поиске", "detail": "раньше бот отвечал «штат не найден»", "area": "Топливо", "id": "2026-11-14-fuel-typos-better" },
  { "kind": "plan", "text": "Сделать кнопку обновления цен для агентов", "id": "2026-11-14-plan-1" }
] }
```

How to write entries:
- **Russian, plain words, about the result for the business**: what people can now do, what got faster or
  safer. No code words (no "refactor", "API", "migration", "webhook", file names). One sentence each.
- `kind`: `done` (finished work), `improved` (what got better, with the "before" in `detail`),
  `learned` (a skill the user gained, as a programmer, in plain words), `plan` (next steps for tomorrow),
  `blocker` (what is in the way).
- `area`: one of Топливо, Лиды, Академия, Агенты, Бот, Отчёты, Другое.
- `size`: `s` small, `m` normal, `l` big; `"highlight": true` for something worth the weekly and monthly highlights.
- `id`: a unique, stable id per entry, so a retry never adds it twice.
- Write the file in the scratchpad, not in the project. Don't log work that was undone or not delivered.
- Check what is already logged today: `curl -s -H "Authorization: Bearer $TASK_REPORT_TOKEN" "$APP_URL/api/task-report/entries"`
  (values in `.env.production.local`).
