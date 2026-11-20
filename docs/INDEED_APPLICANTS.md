# Indeed applicants

People who apply to our jobs on Indeed reach the hiring chat in Telegram: a card for each new applicant, a warning when the collection stops, and the lead-import Excel file once a day. Admins also have **📋 Indeed Applicants** (`/indeed`) in the bot.

**For hiring only.** Indeed's rules allow using applicants' details to hire, not for other outreach. That is why this is its own section and never feeds Driver Leads (see [DRIVER_LEADS.md](DRIVER_LEADS.md#data-providers-what-was-checked)).

## How it works

```
 US office computer (Windows)                          Our server (the bot)
 ┌─────────────────────────────┐   HTTPS, every 30 min   ┌──────────────────────────────────────┐
 │ "Chrome - Indeed Bot" window │                        │ POST /api/indeed/report               │
 │  signed in to Indeed         │                        │  what's new? → indeed_applicants      │
 │ indeed_collector.py ─────────┼───────────────────────►│  card per new applicant → hiring chat │
 │  (Task Scheduler)            │  status + applicants   │  problem / back to normal → hiring chat│
 └─────────────────────────────┘                        │ cron indeed-watch: silent > 2 h → ⚠️  │
                                                        │ cron indeed-excel: daily import file   │
                                                        └──────────────────────────────────────┘
```

- The office computer is the only place signed in to the employer account, so a small script there reads the candidate list (the data Indeed's own page loads, not the page layout) and posts it to the bot. It keeps no state, sends nothing to Telegram itself and never clicks anything in Indeed.
- The bot decides what is new. The **first** report is taken as "already there": those applicants get no card and stay out of the import files, and the chat gets one "connected" message.
- **Cards**: one per new applicant, oldest first, at most 15 per report (the rest in one line). A card Telegram refuses is tried again on the next report.
- **Alerts**, each problem once and its end once: Chrome window closed, Indeed signed out, page loaded without applicants (Indeed changed something), a read error, and no report at all for 2 hours (the computer is off, asleep or offline).
- **Import file** (`CFT_Indeed_Leads_Import_MM_DD_YY.xlsx`), columns as the CRM import takes them: First Name, Last Name, Phone (`18459038077`), Email (Indeed hides it), State, Lead Source `STB`, Lead Status `New Lead`, CDL A, OTR, Experience (empty: the candidate list doesn't say), Lead Created, Lead Owner (`INDEED_LEAD_OWNER`). Each applicant is in **one** file only: the daily file in the hiring chat, or an admin's 📥.
- **📋 Indeed Applicants** for admins: whether the office computer is reporting, today's count, **📥 New applicants** (the not-yet-exported ones, marked sent) and **🗂 Last 7 days** (a read-only copy).

| File | Purpose |
|---|---|
| `tools/indeed-applicants/report.ts` | The office script's reports, cards, alerts, the silence watch, the files. |
| `tools/indeed-applicants/store.ts` | The database: new or known, the once-per-file claim, the script's last report. |
| `tools/indeed-applicants/messages.ts` | **Every text.** Change the wording here. |
| `tools/indeed-applicants/files.ts` | The import Excel layout. |
| `tools/indeed-applicants/index.ts` | API routes: `indeed/report`, `cron/indeed-watch`, `cron/indeed-excel`. |
| `tools/indeed-applicants/office-script/indeed_collector.py` | The script for the office computer. |
| `telegram_bot/handlers/admins/indeed.ts` | The admins' section and its buttons. |
| `database/migrations/0013_indeed_applicants.sql` | `indeed_applicants`, `indeed_collector`. |

## Settings

| Variable | What it is |
|---|---|
| `INDEED_COLLECTOR_TOKEN` | The office script's key. Empty: the feature is off. Make one with `openssl rand -hex 32`. |
| `INDEED_CHAT_ID` | The hiring chat (a group the bot is in), e.g. `-5311699263`. If Telegram turns the group into a supergroup, the id changes (it then starts with `-100`); update it. |
| `INDEED_LEAD_OWNER` | Lead Owner in the file. Default `james.c@cftransportllc.com`. |

**Schedule** (`deploy/setup-server.sh`): `indeed-watch` every 30 minutes, `indeed-excel` daily at 13:30 UTC (8:30 in New York in winter, 18:30 in Tashkent).

## Turning it on

1. **Deploy** with the migration: `deploy/update.sh main --migrate` (or GitHub → Actions → Deploy to VM with "migrate" ticked).
2. **Settings**: in `~/app/.env` add `INDEED_COLLECTOR_TOKEN`, `INDEED_CHAT_ID` (and `INDEED_LEAD_OWNER` if different), then `sudo systemctl restart cft-agent`.
3. **The two timers** (`update.sh` doesn't create timers). As root, either run `deploy/setup-server.sh` again, or create `cft-cron-indeed-watch.timer` (`OnCalendar=*:0/30`) and `cft-cron-indeed-excel.timer` (`OnCalendar=*-*-* 13:30:00 UTC`) like the others, then `systemctl daemon-reload && systemctl enable --now cft-cron-indeed-watch.timer cft-cron-indeed-excel.timer`.
4. **The office computer** (through AnyDesk):
   - Python with `python -m pip install playwright requests`, and the "Chrome - Indeed Bot" shortcut (`--remote-debugging-port=9222 --user-data-dir="C:\IndeedBot\chrome-profile"`), signed in to employers.indeed.com, in the Startup folder.
   - Copy `indeed_collector.py` to `C:\IndeedBot\`, fill in `BOT_URL` (the bot's `APP_URL`) and `COLLECTOR_KEY` (`INDEED_COLLECTOR_TOKEN`).
   - Test: `python C:\IndeedBot\indeed_collector.py now`. The hiring chat gets "✅ Indeed applicants are connected".
   - Schedule it every 30 minutes (one line in `cmd`):
     `schtasks /Create /TN "Indeed Bot" /TR "pythonw C:\IndeedBot\indeed_collector.py" /SC MINUTE /MO 30 /F`
   - Settings → System → Power: never sleep when plugged in.
   - Remove any older Indeed script that sent to Telegram itself, so applicants don't arrive twice.

The script logs to `C:\IndeedBot\log.txt`.

## Limits

- The script reads the first page of the candidate list (20 applications) in the order Indeed shows it. That works when Indeed puts the newest first, and when fewer than 20 arrive between two runs. Check after the first day that every new applicant in Indeed also reached the chat.
- The job title comes from the jobs Indeed loads on that page (the first 10). An applicant to another job gets no 💼 line, and their row in the file is unaffected.
- Indeed signs the session out every few weeks; the chat is told, and someone signs in again in the "Chrome - Indeed Bot" window.
- Indeed's terms forbid automated collection. The script only reads, about twice an hour, like a person checking the page. Get the account owner's agreement before turning it on. If Indeed ever objects, turn it off by removing the scheduled task.
