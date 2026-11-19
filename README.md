# CFT Agent

One Telegram bot, [@cft_Agentbot](https://t.me/cft_Agentbot), with its Mini App, for everyone around CFT: admins, sales agents, truck drivers and agent candidates. Live at **https://209-97-132-149.sslip.io**, on our own server (DigitalOcean, [docs/VM_DEPLOY.md](docs/VM_DEPLOY.md)).

- **Candidates** take the official 30-question **Agent Academy** test and see their score, the correct answers and explanations only after they submit.
- **Agents** (joined through an invite link) look up **CFT fuel discount prices** at partner stations and send them to drivers, and **invite drivers** to the route map: every agent can, and sees all drivers or only their own.
- **Drivers** (joined through a driver link) get the **route map**: truck routes with live traffic, the CFT stations on the way with their CFT price, turn-by-turn navigation with voice. Their navigated **trips are recorded** (with a notice) and kept 12 months as proof.
- **Admins** sign in with one tap. The **CFT Hub** has the Academy console (attempts, analytics, question bank, Excel reports), team & access, **Drivers and their trip history**, fuel discounts data and fuel prices. In the chat: **driver leads** ([docs/DRIVER_LEADS.md](docs/DRIVER_LEADS.md)), the full fuel price file, pass/fail alerts and a Monday summary.
- **Work reports:** daily, weekly and monthly reports of finished work in a Telegram channel, in plain Russian.

The app runs fullscreen on phones and respects the device safe areas (notch, home indicator) and the area covered by Telegram's own controls.

---

## Contents

1. [How it works](#how-it-works)
2. [Project layout](#project-layout)
3. [Run it locally](#run-it-locally)
4. [Deploy: our server + Telegram](#deploy)
5. [Environment variables](#environment-variables)
6. [Admins, users and notifications](#admins-users-and-notifications)
7. [Reports](#reports)
8. [Security](#security)
9. [Database](#database)
10. [Tests](#tests)
11. [Content sources](#content-sources)
12. [Limitations and manual steps](#limitations-and-manual-steps)
13. [CFT Hub (the admins' Mini App)](#cft-hub-the-admins-mini-app)
14. [Fuel prices](#fuel-prices)
15. [Driver route map](#driver-route-map)
16. [Drivers and trip history](#drivers-and-trip-history)
17. [Driver leads](#driver-leads)
18. [Work reports](#work-reports)

---

## How it works

```
Telegram (phone / desktop)
  └─ Mini App (React + Vite, static files served by Caddy on our server)
        │  initData signed by Telegram, sent with every candidate/admin login
        ▼
  /api/*  → the bot service (telegram_bot/server/start.ts → router.ts)
        │  verifies Telegram signatures, grades attempts, enforces admin access
        ▼
  PostgreSQL 17 + Redis on the same server (only reachable from the server)

Telegram → /api/telegram/webhook   bot commands (/start, /admin, /report, /stats …)
Timer (Mon 04:00 UTC) → /api/cron/weekly        weekly summary + Excel to admins
Timer (daily 14:30 UTC) → /api/cron/leads       driver-lead pull sources (FMCSA, when enabled)
Timer (daily 18:00 UTC) → /api/cron/task-report  forgotten shifts, weekly (Sat) and monthly reports
Timer (daily 11:00 UTC) → /api/cron/fuel        fresh fuel discount prices from the cabinet (what agents and drivers see)
Timer (daily 11:30 UTC) → /api/cron/stations    map points for new stations
/route (Mini App page)  → /api/driver/*          the drivers' route map, trips; /route?trip=<id> a recorded trip (admins)
/drivers/ (static page) → /api/leads/register    driver sign-ups with consent
Lead vendors → /api/leads/ingest/<source>        leads pushed by providers and ad platforms
```

- The browser never talks to the database: only the bot, on the same server, can reach it. Every table also has Row Level Security enabled with no policies.
- Candidates are identified by their **Telegram account**, verified on the server from the Mini App's signed `initData`. That gives you one attempt per person, and a candidate who closes the app resumes where they left off.
- Grading happens on the server and records the question revision each candidate saw, so later edits never rewrite past results.

## Project layout

One bot, one Mini App, one database and one deployment. The code is split two ways:
**what** the business can do (`tools/`, `task_report/`) and **who** can do it in the chat
(`telegram_bot/handlers/<role>/`).

```
telegram_bot/                THE BOT: talks to Telegram, decides who may do what
  webhook.ts                 Front door: checks the update, works out the sender's role, hands it over
  handlers/
    viewer.ts                Who is writing (admin / agent / driver / candidate) and what a role folder provides
    admins/                  Admins and owners: home screen, /help, command menu, and per section:
                             academy.ts, leads.ts, fuel.ts (📥 button), shift.ts, system-design.ts (/design)
      team/                  👥 Team and ➕ Invite: menu.ts (the buttons), agents.ts (/invite, /agents),
                             admins.ts (/addadmin, /admins)
    agents/                  Agents: home screen and the fuel price search (fuel-search.ts)
    candidates/              Candidates: the test only
    drivers/                 Drivers: the route map button
    invite.ts                Agent invite links, which anyone may open
    driver-invites.ts        Driver links (/invitedriver, /drivers), made by admins and every agent
    channel.ts               The reports chat: the bot added to a group or channel
    not-allowed.ts           Polite refusals for buttons and commands someone's role doesn't have
  mini_app/                  The Mini App (React + Vite)
    src/                     App.tsx, lib/, components/, styles.css
    src/screens/             Screens by role: admins/ (Hub, Academy console, Team, fuel), agents/
                             (Discounts), candidates/ (the test), drivers/ (the route map), shared/
  server/                    router.ts (every /api route), tools.ts (the list of tools), node-adapter.ts, dev.ts
tools/                       THE BUSINESS: one folder per tool, never imports telegram_bot/
  agent-academy/             🎓 The test: candidate.ts, console.ts, notify.ts, reports.ts, sheets.ts,
                             chat.ts (what it sends in a chat), index.ts (its API), tests/
  driver-leads/              🚚 Leads (see docs/DRIVER_LEADS.md): actions.ts (what it does in a chat),
                             messages.ts (every text), ingest.ts, store.ts, files.ts, fmcsa.ts, signup-page/
  fuel-prices/               ⛽ Cabinet prices: cabinet.ts, export.ts (📥 Excel), dataset.ts and
                             agent-prices.ts (the agents' prices), driver-message.ts, table-image.ts, excel.ts
  driver-map/                🗺 The drivers' route map: stations.ts (partner stations, read from fuel-prices),
                             geocode.ts, routing.ts + tomtom.ts (truck routes), voice.ts
  agents/                    👥 Invite links and the agent list (API for the Team screen)
task_report/                 Work reports (shifts, daily/weekly/monthly reports to a channel)
db_storage/                  THE DATABASE: db.ts (connection), migrate.ts, migrations/, seeds/academy/
core/                        Plumbing everyone uses: env, http, telegram (Bot API client), admins, agents
                             and drivers (who is who), home.ts (section names, home keyboard), tool.ts, xlsx,
                             brand/ (fonts and logo for server-drawn pictures)
shared/                      Code server and browser both use: types, grading, analytics, CSV, dates
scripts/                     Things you run by hand: telegram-setup.ts (npm run telegram:setup),
                             create-admin.ts (npm run admin:create), worklog.ts (npm run worklog)
deploy/                      Our server (guide: docs/VM_DEPLOY.md): setup-server.sh, update.sh,
                             Caddyfile (website, HTTPS, security headers), the bot service, scheduled jobs
.github/workflows/           deploy-vm.yml: the "Deploy to VM" button on GitHub
```

The rule that keeps it expandable: imports only go **down**:
`telegram_bot` → `tools` / `task_report` → `core` / `db_storage` / `shared`.
A tool may read another tool's data in one direction only (today: `driver-map` reads `fuel-prices`).
`core` and `db_storage` count as one level; the Mini App uses only `shared`. `scripts/`
sits on top and may use anything. Tests are exempt (they drive the whole bot through the router).
`core/tests/layers.test.ts` checks all of this, so `npm test` fails on an upward import.

Where new work goes:
- **A new tool:** `tools/<name>/` with an `index.ts` (see `core/tool.ts`), added to `telegram_bot/server/tools.ts`.
- **What a role can do in the chat:** that role's folder in `telegram_bot/handlers/`. A new role is a new folder plus a line in `webhook.ts` and `handlers/viewer.ts`.
- **An API endpoint:** the tool's `index.ts` `routes`.
- **A Mini App screen:** `telegram_bot/mini_app/src/screens/<role>/`.
- **A type both sides need:** `shared/types.ts`.
- **A database change:** the next numbered file in `db_storage/migrations/`.

The server side and the browser side each have their own TypeScript config, so browser code cannot import server code by accident.

## Run it locally

Requirements: **Node 22+** and a PostgreSQL database (local Postgres 14+ works).

```bash
npm install
cp .env.example .env.local        # then fill in the values (see below)
#   for local work set:  DATABASE_URL=postgres://…/cft_academy   ALLOW_WEB_CANDIDATES=true
npm run db:migrate
npm run db:seed                   # loads the 30 official questions, pass mark 21/30
ADMIN_PASSWORD='choose-a-long-password' npm run admin:create -- --email you@company.com
npm run dev                       # http://localhost:5173  (admin: http://localhost:5173/#/admin)
```

To preview fullscreen safe areas in a desktop browser, add `?insets=59,34,46` to the URL (device top, device bottom, Telegram controls).

To test inside Telegram before deploying, expose port 5173 over HTTPS (for example with `cloudflared tunnel --url http://localhost:5173`), set `APP_URL` to that URL and run `npm run telegram:setup`.

## Deploy

The bot runs on our own server (DigitalOcean): the website, the bot, the database (PostgreSQL 17), the
cache (Redis) and the scheduled jobs. Setting it up, deploying, backups and restoring:
**[docs/VM_DEPLOY.md](docs/VM_DEPLOY.md)**.

Deploying a change: push to `main`, then GitHub → Actions → **Deploy to VM** (or on the server, as `cft`:
`cd ~/app && deploy/update.sh main`). A change that brings database migrations is deployed with
`deploy/update.sh main --migrate` (or **migrate** ticked in the workflow), which applies them before the new
code goes live; without it, such a deploy stops and changes nothing.

### Settings files

| File | What it is for |
|---|---|
| `.env.example` | The list of every setting, with explanations. Copy it to start the others. |
| `/home/cft/app/.env` (on the server) | The live bot's settings. |
| `.env.local` | Local development and tests (`npm run dev`, `npm test`, and the `db:*` commands). |
| `.env.production.local` | A copy of the live settings on your machine, for `npm run worklog` (it posts to `APP_URL`). It has no `DATABASE_URL` on purpose: the database is only reachable from the server. |

Files with real values are never committed (`.gitignore`).

### Telegram bot

1. Run the bot setup on the server, as `cft`:
   ```bash
   cd ~/app && npm run telegram:setup
   ```
   It sets the webhook (with a secret), the commands, the menu button ("Start test") and the bot descriptions, and points them at `APP_URL`.
2. In **@BotFather**, open `/mybots` → **@cft_Agentbot** → **Bot Settings** → **Configure Mini App** → **Enable Mini App**. Set the URL to your `APP_URL` and, where offered, choose the **fullscreen** launch mode. This makes it the bot's Main Mini App, which also gives you a shareable fullscreen link:
   `https://t.me/cft_Agentbot?startapp&mode=fullscreen`
3. Each admin must open the bot and press **Start** once. Telegram doesn't let a bot message someone who hasn't started it.

The app also requests fullscreen itself on iOS and Android (`requestFullscreen`, Bot API 8.0+), disables swipe-to-close while scrolling, and paints the Telegram header and bottom bar black. Desktop Telegram keeps its normal window.

## Environment variables

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL URI. On the server: `postgresql://cft:…@127.0.0.1:5432/cft_agent` (no TLS needed on the same machine). |
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather. Server-only. |
| `TELEGRAM_BOT_USERNAME` | yes | `cft_Agentbot` |
| `TELEGRAM_WEBHOOK_SECRET` | yes | Random 32+ chars (`openssl rand -hex 24`). Telegram sends it with every webhook call. |
| `APP_URL` | yes | Your deployment's https URL, no trailing slash. |
| `ADMIN_TELEGRAM_IDS` | yes | Owner Telegram IDs, comma-separated: `9447180,1270439555`. |
| `CRON_SECRET` | yes | Random 32+ chars. The scheduled jobs (`deploy/cron.sh`) send it to `/api/cron/*`. |
| `TASK_REPORT_USER_IDS` | for work reports | Telegram IDs (comma-separated) of the people who have ⏱ Shift and work reports. Nobody else, not even other admins, sees them. |
| `TASK_REPORT_TOKEN` | for work reports | Random 32+ chars. The key `npm run worklog` (Claude Code) uses to add work-log entries. |
| `ALLOW_WEB_CANDIDATES` | no | `true` lets candidates take the test in a normal browser. Keep `false` in production. |
| `DATABASE_CA_CERT` | no | For a database on another machine: its CA (PEM), to verify the certificate. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | no | Service-account key to enable the Google Sheets sync button. |
| `TELEGRAM_INITDATA_MAX_AGE_SEC` | no | How old a Telegram session may be (default 86400). |
| `LEADS_COMPANY_NAME` | no | Company named in the driver registration page's consent wording (default `CFT`). |
| `LEADS_FMCSA_ENABLED` | no | `true` imports newly registered owner-operator carriers from the public FMCSA registry every day. Off by default. |
| `ORS_API_KEY` | for routes | OpenRouteService key (free plan, no card: openrouteservice.org → Dashboard → token). Server only: truck routes, place search, last-resort station lookup. Without it the map and *By state* work, but no routes. |
| `DRIVER_GEOCODE_BATCH` | no | Stations looked up by street address per request (default 60; 0 turns it off). Chain matches are not counted. |
| `FUEL_CABINET_EMAIL`, `FUEL_CABINET_PASSWORD` | for fuel prices | The United Fuel customer cabinet account the bot reads prices from (the fuel price file, the daily pull). |
| `TOMTOM_API_KEY` | no | Truck routes with live traffic and speed limits (shared monthly cap). Without it, OpenRouteService routes. |
| `GOOGLE_TTS_KEY` | no | The natural voice for directions (Google Cloud Text-to-Speech; its project needs billing on). Without it, the phone's voice or the built-in voice pack. |
| `REDIS_URL` | no | Our Redis on the server (`redis://:…@127.0.0.1:6379`): monthly caps, rate limits, cached voice clips, the station lookup lock. Without it, counted in memory (reset on restart). |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | no | Upstash Redis (REST) instead, when `REDIS_URL` is not set. |

More driver-leads settings are listed in [docs/DRIVER_LEADS.md](docs/DRIVER_LEADS.md#settings).

None of these are exposed to the browser. There are no `VITE_` variables.

## Admins, users and notifications

**Owners** are the Telegram IDs in `ADMIN_TELEGRAM_IDS`. They are admins automatically the first time they open the bot, and they can't be removed from inside the app.

**Adding an admin** (owners): send `/addadmin [name]` in the bot (or tap ➕ Invite → 🛡 Admin on the home keyboard), pick how long the link works, and send it. The person opens it, taps Start and is an admin; you get a message. Each admin link works for **one person** (agent links work for anyone until they expire), and an owner can turn it off. `/admins` (or 👥 Team → 🛡 Admins) lists the admins; owners can remove one there. Code: `core/admin-invites.ts`, `telegram_bot/handlers/admins/team/admins.ts`; the ➕ Invite and 👥 Team buttons are in `telegram_bot/handlers/admins/team/menu.ts`.

**Signing in.** Inside Telegram, admins tap **Admin console** (or send `/admin`) and are signed in by their Telegram account, with no password. Email and password sign-in exists for opening the console in a normal browser. Create those accounts with `npm run admin:create -- --email … [--telegram-id …]`.

**Users page** lists everyone who has started the bot or opened the app, with their test status and latest score.

- **Make admin** promotes a user. Any admin can add admins, either from this list or by Telegram ID with **Add admin**.
- **Remove admin** is available to owners only.

**Bot commands for admins:**

| Command | What it does |
|---|---|
| `/admin` | Opens the console. |
| `/stats` | This week so far. |
| `/weekly` | Last week's summary. |
| `/report` | All-time Excel report. Add `week`, `lastweek` or `30d` for other periods. |

| `/leads` | Driver Leads keyboard and help. |

Admins see these commands in their command menu after pressing Start, each labelled with its section ("Academy: …", "Driver Leads: …").

**Two sections.** The bot keeps the test and the driver leads apart. For administrators, `/start` is a home screen with two buttons, **🎓 Agent Academy** and **🚚 Driver Leads**; each section has its own keyboard, its own commands and its own message titles, and **🏠 Home** switches back. Driver Leads is for administrators only: candidates go straight to the test and never see the other section.

**Notifications.** Each admin can switch these on or off under Settings → My Telegram notifications.

- **Pass/fail alert:** sent the moment a candidate submits, with score, duration and an **Open attempt** button.
- **Weekly summary:** every Monday at 09:00 Tashkent time (cron `0 4 * * 1` UTC). It covers last week's started, completed, passed and failed counts, pass rate, average, change vs the previous week and the most-missed questions, with the week's Excel file attached. You can also send it any time from Reports → **Send summary to admins now**.

## Reports

**Reports page:** pick This week, Last week, Last 30 days or All time, then **Download Excel** or **Send to my chat**. Inside Telegram, downloads use Telegram's native download sheet.

The workbook has these sheets:

- **Summary:** totals, pass rate, average, high/low and pass mark.
- **Results:** one row per graded attempt. The Date column is `dd/mm/yyyy` and Time is `hh:mm` (rounded to the minute). Percentages are whole numbers, and the PASS/FAIL cell is coloured.
- **In progress:** attempts not yet submitted.
- **Answers:** candidate × Q1–Q30, green for correct and red for wrong.
- **Questions:** sorted by error rate, with the most-chosen wrong answer.
- **Topics:** accuracy per (inferred) topic.

Every sheet has a frozen, filterable header. Dates use the **report time zone** under Settings (default `Asia/Tashkent`).

The Attempts, Questions and Topics pages also export CSV, with formula-injection protection.

## Security

What is protected and how:

- **Answer key.** Before submission, candidates receive only question text and options. The correct answers, explanations and topics are sent only in the graded result. An integration test checks the payload for leaks.
- **Grading.** The server grades and ignores any score sent by the client. Submitting locks the attempt row, so a duplicate or concurrent submit returns the stored result instead of grading twice.
- **Candidate identity.** The Telegram `initData` HMAC is verified on the server with the bot token, with an age limit. Each attempt also has a 256-bit bearer token, stored only as a SHA-256 hash. The token rotates whenever the attempt is resumed, and a candidate can only read their own attempt.
- **Admin access.** Every `/api/admin/*` route checks a server-side session: random token, hash stored, 12-hour expiry, revocable on sign-out. Passwords use scrypt. Sign-in is rate-limited per email and IP, unknown emails take the same time as known ones, and only owners can remove admins. Hiding UI elements is never the protection.
- **Database.** RLS is enabled on every table with no policies. The database only listens inside the server, and only the bot, holding its password, can read or write.
- **Webhook and cron.** Both require secrets, compared in constant time.
- **Inputs.** Every input is validated on the server. Names, question edits and settings share their validation rules with the browser.
- **Exports.** CSV cells are escaped against spreadsheet formulas. Excel cells are written as plain text, never as formulas. Download links are unguessable and expire after 10 minutes.
- **Headers.** The deployment sends a strict Content-Security-Policy (only Telegram embedding allowed), `nosniff` and a referrer policy.

**Not production-hardened yet:**

- Web (non-Telegram) candidates are limited to one attempt per browser, not per person. Keep `ALLOW_WEB_CANDIDATES=false`.
- Admin login rate limiting is stored in the database. There is no CAPTCHA.
- Backups: a database copy every night on the server (14 days) and DigitalOcean Backups of the whole server ([docs/VM_DEPLOY.md](docs/VM_DEPLOY.md#the-database)).

## Database

Migrations are in `db_storage/migrations/`. The driver-leads tables from the third and fourth are described in [docs/DRIVER_LEADS.md](docs/DRIVER_LEADS.md#database).

| Table | Purpose |
|---|---|
| `topics` | Topic list (inferred). |
| `questions` | Number, topic, active flag, current revision. |
| `question_revisions` | Append-only text, options, correct answer, explanation, why-wrong notes and basis. Edits add a revision. |
| `candidates` | Name, plus Telegram ID and username when known. |
| `assessment_attempts` | Status, timestamps, score, pass mark used, duration and token hash. At most one open attempt per candidate. |
| `attempt_answers` | One row per question per attempt: revision shown, selected option, correctness set at grading. |
| `telegram_users` | Everyone who used the bot or app, and whether the bot can message them. |
| `admins` | Admin accounts (Telegram ID and/or email + scrypt hash), role, notification preferences. |
| `admin_sessions` | Admin sessions. |
| `admin_login_failures` | Failed sign-ins, for rate limiting. |
| `audit_events` | Admin changes. |
| `app_settings` | Pass mark, minimum sample, retakes, report time zone, Sheets link. |
| `export_files` | Short-lived downloads. |
| `agents`, `agent_invites` | Agents and their invite links (only a hash of each link's token is kept). |
| `admin_invites` | One-time links that make someone an admin. |
| `discount_datasets`, `discount_stations` | Each saved pull of fuel discount prices (daily, or the admin's Refresh). |
| `station_geo` | Map points for partner stations, looked up once (chain locator, Census, search). |
| `driver_invites`, `map_drivers` | Driver links (made by admins or agents) and the drivers who joined. `map_drivers.trip_notice_at`: when they were told trips are recorded. |
| `driver_trips`, `driver_trip_points` | Trip history: one row per navigated trip (from / to, fuel stop and price, planned route, recorded miles) and the driven track in batches. Kept 12 months. |
| `task_report_*` | Work log, shifts and sent reports (migration 0007). |

## Tests

```bash
npm run typecheck
npm test            # unit tests + API tests against TEST_DATABASE_URL (wiped and rebuilt each run)
npm run build
```

Set `TEST_DATABASE_URL` to an **empty, disposable** database. The API tests drop and recreate its schema. Without it, the database tests are skipped. The Excel tests also read the generated files with Python's `openpyxl` when it's installed.

Coverage:

- Grading, percentages and unanswered questions.
- Answer-key non-exposure.
- Duplicate and concurrent submits.
- Telegram signature checks.
- Resume and one-attempt rules.
- Admin-only routes, brute-force lockout and owner/admin permissions.
- Question versioning.
- Analytics and observed patterns.
- CSV escaping.
- Excel structure and formats.
- Pass/fail notifications and preferences.
- Weekly cron (auth and once-per-week), bot commands, and handling of users who blocked the bot.
- Driver leads: validation, duplicate merging, exactly-once delivery under simultaneous clicks, recovery after a refused or unanswered send, opt-outs and their undo, access control, exports, CSV import (separators, encodings) and the FMCSA sync.
- The two bot sections: who sees the home screen, what each section's keyboard and command menu contain.
- Drivers: driver links from admins and every agent, the agents' home buttons and menu, All drivers / My drivers, agents removing only their own drivers, the route map refused to non-drivers.
- Trip history: only drivers' trips recorded, a resent batch counted once, no miles across a gap, the stop and arrival marked, admins only.
- Layers: `core/tests/layers.test.ts` fails on an import that goes upward.

## Content sources

- The 30 questions, options, correct answers, explanations, "why the other options are incorrect" notes and basis lines come from `CFT_New_Agent_Test.pdf` and `CFT_Detailed_Answer_Key.pdf`. They were checked field by field against both PDFs with no differences.
- **Pass mark 21/30 (70%).** The test instructions state "Passing score: 21/30 (70%)"; the answer key calls it the suggested pass mark. It can be changed under Settings.
- **Time limit: none.** The materials don't set one.
- **Topics are inferred** from the question content; the PDFs don't define topics. They are labelled "inferred" everywhere and admins can change them in the question bank.

## Limitations and manual steps

1. Set up the server ([docs/VM_DEPLOY.md](docs/VM_DEPLOY.md)), then run `db:migrate` and `db:seed` there.
2. Fill in the server's `.env` and set `APP_URL`.
3. Run `npm run telegram:setup`, then enable the Main Mini App (fullscreen) in @BotFather.
4. Owners and admins press **Start** in the bot once, so it can message them.
5. Google Sheets sync is optional and needs a Google Cloud service account (`GOOGLE_SERVICE_ACCOUNT_JSON`). It was unit-tested but not run against Google.
6. The bot token was shared in a chat during development. Consider issuing a new one with @BotFather → `/revoke` and updating `TELEGRAM_BOT_TOKEN`.

## CFT Hub (the admins' Mini App)

Admins' chat menu button opens the **CFT Hub** (`/#/hub`); candidates keep **Start test**. The bot sets it per chat when someone sends `/start`, and resets it to the default for anyone who is not an admin. The Hub has one tile per product:

- **Agent Academy:** tests finished and passed this week; opens the admin console or the test.
- **Driver Leads:** new leads waiting and added today; goes back to the chat to collect them.
- **Team & access:** agents, their invite links, candidates and admins.
- **Drivers:** everyone who joined through a driver link, who invited them, and their trip history (see [Drivers and trip history](#drivers-and-trip-history)).
- **Fuel discounts data / Find discounts:** what agents see, the CFT margin, and the agents' own screen.
- **Driver route map:** the drivers' map, for trying routes.
- **Fuel prices:** station count and the cheapest discounted price; opens the **Fuel prices** screen (`/#/fuel`): search by station, city or address, filter by state, sort by cheapest discounted, cheapest retail or biggest saving, tap a station to open it in Google Maps, and **Excel to chat** to get `fuel_prices.xlsx` in Telegram. The list is read from the cabinet at most every 10 minutes; the Excel file is always read fresh.

The Hub is `telegram_bot/mini_app/src/screens/admins/Hub.tsx`; the Fuel prices screen is `telegram_bot/mini_app/src/screens/admins/FuelPrices.tsx`. Anyone who is not an admin and opens the Hub's link gets the test.

## Fuel prices

Admins have a **📥 Download All Fuel Prices** button on their home keyboard (also `/fuelprices`). It signs in to the United Fuel customer cabinet (https://cabinet.united-fuel.com, Stations → List), reads every station and sends `fuel_prices.xlsx`: a **Stations** sheet with Station, Retail price, Discounted price, Updated time, State, City and Address (filters on, header frozen, prices exactly as the cabinet shows them, the total under the table) and a **Summary** sheet.

**Every day at 11:00 UTC** the prices agents and drivers see are pulled again by themselves (`/api/cron/fuel`, the same save as the admin's Refresh button on the Fuel discounts data screen).

How it works: the cabinet is a web app over a JSON API, so the bot calls that API directly instead of driving a browser (which would need a whole browser on the server). It signs in with `FUEL_CABINET_EMAIL` and `FUEL_CABINET_PASSWORD`, reads `cabinet/station` page by page, keeps each station once, and sends the file only if the number of stations equals the total the cabinet reports. Otherwise it says what went wrong and sends nothing. One status message shows the progress. Code: `tools/fuel-prices/` (`cabinet.ts` reads the cabinet, `excel.ts` builds the file, `dataset.ts` saves the prices agents and drivers see, `index.ts` the routes and the daily pull).

A station without a discounted price in the cabinet (about 230, mostly Casey's) has an empty cell, not 0. Times are in the report time zone (Settings).

## Menu buttons (why agents saw "Start test")

Each role has its own Telegram menu button: admins **CFT Hub**, agents **Discounts**, drivers **Route map**, everyone else the default **Start test**. Telegram sometimes misses the change (a timeout), and a person kept the old button. Now:
- calls that are safe to repeat (setting menus, editing, answering taps) are tried once more after a timeout (`core/telegram.ts`); new messages never are, so nobody gets one twice;
- `telegram_users.menu_role` records what each person was last given; when it differs from their role's key (`menuKey` in `telegram_bot/handlers/viewer.ts`), the bot sets it again after its next answer (`ensureMenu` in `telegram_bot/webhook.ts`). Changing a role's key gives everyone with that role the new menu (agents are on `agents.2`: the driver commands);
- `scripts/telegram-setup.ts` (run after each deploy) sets every admin's, agent's and driver's menu at once.

## Driver route map

A Mini App page at **`/route`** for drivers (Route map menu button), agents (📍 on Find discounts) and admins (Hub). The map fills the screen, cards appear only when there is something to show, and the driver arrow and camera move every frame outside React.

- **The map:** MapLibre with the CF Transport night style (OpenFreeMap's Liberty, recoloured for the brand: calm grey roads, highways a little brighter, shops and clutter hidden). Every station is a brand-coloured fuel-pump icon (no numbered groups): zoomed out, icons that would overlap are hidden and the cheaper one stays; zooming in shows more, and from zoom 7.5 their prices. Tap a station for its card and *Route here*. Everything is drawn by the map engine (GPU), including price tags; the only HTML marker is the driver arrow. Panels are solid, not blurred, so panning and pinching stay smooth on phones.
- **Opening fast:** the station list from the last visit is kept on the phone and shows at once; the fresh list replaces it. `GET /api/driver/stations` never waits for address lookups: stations without a map point come without one, and the page then calls `POST /api/driver/locate` in the background (one lookup pass at a time across servers, a Redis lock released when the pass ends) and reloads the list. The first time, stations appear as a wave from the middle of the screen.
- **Layout:** the map fills the screen; with nothing selected there is no bottom card (a clear map). Cards appear only for a tapped station, a planned route or a trip; the round buttons on the right always sit just above the card. While the driver moves the map, the top panel and the card step aside and come back when it stops. With a route planned, From / To shrink to one line (tap to change). Phones: search on top, card at the bottom. From 720 px wide (tablets, Telegram Desktop): both in a 380 px column on the left, the map beside them.
- **By state** is the agents' own Find discounts screen (`Picker`, `Results`, `StationSheet` exported from `screens/agents/Discounts.tsx`), with the My route / By state switch on top and *Route here* on a station. Phones: full screen, like the agents'. From 900 px wide: a 420 px panel on the left, and the map beside it shows and frames the stations picked. Tapping a station on that map opens its card in the panel (the picks stay), and the open station is highlighted on the map.
- **Building a route** takes the screen: a card with the steps (roads for the truck, live traffic, stations on the way) and *Cancel*, while the camera already shows both ends; the route then draws itself on. On the route, the bottom card has, top to bottom: the trip time with **‹ 1/3 ›** (swipe the station row too; the map follows); a one-row switch **All | Recommended | Cheapest | Biggest discount**; a one-row brand filter **All | Pilot | Love's | TA | Speedway** (several allowed); then the station with a compact **Go** (tap its name for the address and savings in one line). *All* = every station on and near the route (20 mi), cheapest first. The others = the **best 3**, numbered on the map ("1 · $4.53"): *Recommended* = price plus the detour there and back at about $2 a truck mile over a 150 gal fill; *Cheapest* and *Biggest discount* within 5 mi of the route. Choices are remembered on the phone. Ranking: `rankStations()` in `shared/driver-route.ts`.
- **My location:** From empty = the driver's location, with its accuracy (±ft). *Use my current location* (in From's suggestions, or the target button in From) and the locate button ask for a fresh, precise fix: the button flies to the last known place at once, says "Finding your location…", and asks the phone and Telegram's own location together (`telegramLocation()` in `lib/telegram.ts`; Telegram after 1.5 s or the phone's refusal, 10 s at most; Telegram's is also asked when the phone stays silent for 4 s, which happens inside Telegram). When Telegram was refused access, the message has a **Turn on** button that opens Telegram's settings.
- **Markers:** the driver is a pulsing **blue** dot (an arrow while driving; always on top), the route's start a pulsing **green** dot (only when it is not the driver's own location) and the finish a pulsing **red** flag, so they stand out on the light-blue route line.
- **Suggestions:** typing in From / To shows towns with CFT stations and states at once (from the station list already on the phone), then OpenRouteService places join in; answers are remembered for the session.
- **Truck routes:** **TomTom** truck routing with live traffic (height, weight, length, hazmat; traffic delay, slow stretches coloured on the route, speed limits, street names and exit numbers). When TomTom is not set up, its allowance is used up or it fails, **OpenRouteService** (heavy vehicle, no traffic) answers instead. Place search: OpenRouteService.
- **Navigation:** turn banner with the street being driven and the speed limit, the natural voice (Google Chirp 3 HD "Fenrir"; fixed lead-ins "In 1 mile, / In a quarter mile, / In 500 feet, / Now," fetched ahead), re-routing after ~2 s off the route, auto-zoom by distance to the next turn (until the driver pinches), the screen kept on. `/route?simulate` drives any trip in about three minutes. Until the natural voice works, the phone's own voice reads the same sentences (its best English voice, never a novelty one); after one "not available" answer the page stops asking for 30 minutes, so there is no wait before each phrase. A phone with no voice of its own (Telegram on Android) uses the **built-in voice pack**: 60 natural recorded phrases in `telegram_bot/mini_app/public/voice/` (4 distances × 13 manoeuvres, e.g. "In a quarter mile, take the exit on the right.", plus start / arrive / rerouting), made once with the open Piper voice *LJ Speech* (public domain) through sherpa-onnx; phrase list in `pack.json`. No street names, no billing, works offline once fetched; a route fetches only the phrases it needs. Order: natural cloud voice → phone voice → pack.
- **Paid services and their caps:** `TOMTOM_API_KEY`, `GOOGLE_TTS_KEY` and our Redis on the server (`REDIS_URL`). Each paid service has a daily and a monthly cap of our own, kept a little under its free plan, in `shared/driver-config.ts` → `budgets` (TomTom routes 2,400 a day / 72,000 a month, under its 2,500 free requests a day; Google voice 60,000 characters a day / 900,000 a month, under Chirp 3 HD's 1 million free a month), counted across all users in Redis (`core/kv.ts`). All our Redis keys start with `cft:` (`cft:budget:*`, `cft:rate:*`, `cft:voice:*`). Past a cap the app falls back (OpenRouteService, phone voice): nothing is ever charged. **Google Text-to-Speech needs billing turned on in its Google Cloud project** (free tier still applies); until then `/api/driver/voice` answers 503 and the phone voice is used.
- **Station points:** each station is placed once and cached in `station_geo` with its source: the chain's own store locator via **All The Places** (same store number in the same state, or the only store of the brand in that city), then the **US Census** address service, then OpenRouteService search only when it lands in the same state with high confidence; otherwise no pin (still in *By state*), tried again after a week.
- **Prices** are the agents' prices (cabinet discounted price + the margin), never the cabinet's own price. Each card shows how old its price is ("5 h ago"); past 24 hours it is marked **Old price** in amber.
- **Stations on the route, by real detour:** the corridor (1.5 mi of the route line) is only the first filter; stations are found on the route line simplified to 20 m, and their miles along the route are then measured on the full line. The 5 cheapest corridor stations (reachable ones first when a range is set) get a real truck driving-time check (`POST /api/driver/detours`: one OpenRouteService matrix call, from 15 mi before each station to 15 mi after it); a station that costs more than 10 extra minutes (across a divided highway, far from an exit) moves to *Nearby stations*. While the best pick is still unchecked, up to 2 more rounds check the next cheapest, and the station recommended is always a checked one. The Mini App sends only station ids and the two route points; the server looks up where each station is. Matrix calls are capped at 480 a day and 14,000 a month (OpenRouteService free plan: 500 a day). The card says "+4 min off your route". Without OpenRouteService, or past the caps, the straight-line view stays.
- **Miles until empty** (optional, in the truck settings): the pick becomes the cheapest station the truck can reach, and the card says "Reachable before empty" or warns "Beyond your range". It counts down with the miles driven while navigating, and is forgotten 12 hours after it was typed and when a trip ends or is cancelled.
- **Alerts on the road:** a driver (or agent / admin) shares their **live location** in the bot chat; when the next CFT station is ≤ 50 mi ahead the bot sends it: for a driver with a trip in progress (`driver_trips`, status driving, a point within the last 45 minutes) the next station **along the trip route** (in the corridor, ahead of where the driver is on it); otherwise (agents, admins, no trip, or more than 5 mi off the route) the nearest station within 45° of the direction of travel. With the price, the bot sends it with the price, once per station per driver (not again for 24 h). `telegram_bot/handlers/live-location.ts`, `tools/driver-map/alerts.ts`. Needs `edited_message` in the webhook's allowed updates: **run `npm run telegram:setup` once after deploying this**.
- **Daily station job** (`/api/cron/stations`, 11:30 UTC, after the price pull): map points for new stations, and points older than 90 days checked again.
- **Request limits** are per Telegram user (not per IP), for routes (20/min), place search (60/min) and detour checks (10/min), whichever map service answers; without Redis the count is kept per server. Override with `DRIVER_RATE_ROUTE`, `DRIVER_RATE_PLACES`, `DRIVER_RATE_DETOURS`.
- **All thresholds** above (corridor, detour, stale price, alerts, limits, the daily job) are in one file: `shared/driver-config.ts`.
- **Who can open it:** admins, agents and drivers (see [Drivers and trip history](#drivers-and-trip-history)). Errors on the page are shown on screen and reported to the server log (`[route page error]`, `POST /api/driver/log`).
- **Its own address** (`/route`) because the map needs a looser security policy (map tiles, web workers, location): `deploy/Caddyfile`.
- **Limits:** TomTom's truck data is good but not perfect: drivers still follow road signs. On Android Telegram, until Google billing is on, directions are spoken from the voice pack (no street names).
- Code: `tools/driver-map/stations.ts`, `geocode.ts`, `routing.ts`, `tomtom.ts`, `voice.ts`, `detours.ts`, `alerts.ts`; `core/kv.ts`; `shared/driver-route.ts`, `shared/driver-config.ts`; `telegram_bot/mini_app/src/screens/drivers/` (`DriverMap.tsx` the screen, `map.ts` + `map-style.ts` the map, `nav.ts` driving, `voice.ts` the voice, `ByState.tsx`, `pieces.tsx`); migrations `0009_station_geo.sql`, `0010_drivers.sql`.

## Drivers and trip history

**Who adds drivers.** Admins and **every agent** (no admin switch). A driver link works for anyone who opens it until it expires (1 hour to 30 days) or is turned off; whoever opens it and presses Start becomes a driver and gets the **Route map** menu button, nothing else.

- **Agents in the bot:** their home has **🚚 Invite a driver** (a link in two taps) and **👤 My drivers**; their command menu has `/invitedriver` (add a name: `/invitedriver Night shift`) and `/drivers`; `/help` explains both. `/drivers` lists **all drivers** with the agent's own marked *yours*, and one button switches to **My drivers** and back, in place. Agents remove only drivers who joined through **their own** links (anyone else's: "ask your CFT admin"; the database refuses it too).
- **Admins in the bot:** `/invitedriver`, and `/drivers` with every driver, who invited them, a remove button for each, and **🗺 Trip history** (opens the Drivers screen).
- **When a driver joins**, whoever made the link gets a message with a **My drivers** button. Agents' menus were updated for everyone at once (`menuKey` "agents.2", see [Menu buttons](#menu-buttons-why-agents-saw-start-test)). The old per-agent `drivers` permission is no longer read.

**Trip history (proof).** Every trip a **driver** navigates on the route map is recorded; admins' and agents' drives are not.

- **What:** from **Navigate** to arrival or **End**: from / to, the fuel stop with its CFT price at that moment and when it was reached, the planned route (simplified) and its miles and time, the truck, and the **driven track**: a point about every 15 s (sooner after a quarter mile) with time, position, speed and GPS accuracy.
- **How it is sent:** batches every minute, when the app is hidden or closed (a call the browser finishes after the page is gone), at the fuel stop and at the end. A failed batch is sent again with the same number, so a retry is never counted twice.
- **What it cannot see:** a Telegram Mini App only knows the location while the map is open on screen. When the app is closed or the phone sleeps nothing is recorded; those stretches are shown as **gaps** and no miles are counted across a gap of over 90 s. Recorded miles are therefore *at most* the real miles. A trip still "driving" with nothing heard for 15 min shows as *Recording stopped (app closed)*.
- **Telling drivers:** before their first navigation a driver sees, once, that CFT keeps a record of the trips they navigate, what is recorded, and that it is kept 12 months (`map_drivers.trip_notice_at`).
- **Keeping:** 12 months (older trips are deleted when a new one starts). Trips stay when a driver is removed.
- **Admins:** **CFT Hub → Drivers** (`#/drivers`): drivers (and removed ones whose trips are kept) with trips, miles and last trip; a driver's trips (date, from → to, status, fuel stop and price, planned vs recorded miles, time); **Map** opens the trip at `/route?trip=<id>` (planned route dashed, driven track orange, gaps dotted red, green start, red finish, the fuel stop); **File to chat** sends a CSV (trip details, gaps, every point in UTC) to the admin's chat with the bot.
- **Before migration 0011** the map keeps working and nothing is recorded.
- Code: `tools/driver-map/trips.ts` (server), `screens/drivers/trip-recorder.ts` (the phone), `screens/drivers/TripReplay.tsx` (a trip on the map), `screens/admins/Drivers.tsx` (the admins' screen), `core/drivers.ts` and `telegram_bot/handlers/driver-invites.ts` (links and lists); migrations `0010_drivers.sql`, `0011_driver_trips.sql`.

## Driver leads

Owners open the **🚚 Driver Leads** section of the bot (`/leads`) and get a keyboard with GET RECENT LEADS, TODAY'S LEADS, filters by state and CDL class, CSV and Excel downloads, the full database and statistics.

Leads arrive from the driver registration page at `/drivers/`, from vendor webhooks, from CSV files sent to the bot and, when switched on, from the public FMCSA carrier registry. Every record goes into one master table (FMCSA carrier records are replaced with the current set on each sync). A lead is delivered once: an update to a driver who was already delivered is merged into their record and never sent again.

Its tables arrive with a database migration: deploy with `--migrate` (docs/VM_DEPLOY.md, "Deploying").

Full guide: [docs/DRIVER_LEADS.md](docs/DRIVER_LEADS.md).

## Work reports

`task_report/` posts the user's work reports to a Telegram channel, for readers who are not programmers.
The reports are in **Russian**; the bot's buttons and replies stay in English.

- **Shifts:** admins tap **⏱ Shift** (or `/shift`, `/startshift`, `/endshift`). Ending a shift posts the
  day's report. A second shift on the same day replaces that day's picture in place, so nothing is posted twice.
- **The work log:** Claude Code adds entries after finished work (`npm run worklog`, see `CLAUDE.md`);
  the user can add their own with `/done`, `/better`, `/learned`, `/plan`, `/blocker` (add `#Area`).
  `/worklog` lists today's entries with delete buttons; `/preview [week|month]` shows a report without sending it.
- **Reports:** a picture card in the CFT look (`task_report/card.ts`, Fira Sans because Barlow has no Cyrillic)
  plus a short caption. Daily when a shift ends; weekly (Sunday–Saturday) on Saturday evening; monthly on the
  last day of the month, followed by the full list of solved tasks. `report_posts` lets each report out once.
- **The evening job** (23:00–23:59 Tashkent): reminds about an open shift, closes one open for more than 16 hours
  at its last log entry, re-sends a daily report that failed, then the weekly and monthly reports.
- **The reports chat (a group or a channel):** for a group, add @cft_Agentbot (as an admin, so it can pin) and send
  `/reports@cft_Agentbot` in the group. For a channel, add the bot as an administrator (post, edit and pin messages).
  Either way, adding the bot makes it ask the admin in private whether their reports should go there. Until then
  reports come to the admin's private chat. The chat gets a status message ("на смене / не на смене"), edited
  silently and pinned when the bot may pin. The bot ignores everything else said in the group.
