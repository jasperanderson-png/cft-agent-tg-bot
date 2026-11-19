# Driver leads

A lead database inside [@cft_Agentbot](https://t.me/cft_Agentbot). Records flow in from several sources into one master table. Sign-ups, vendor leads and imports are kept permanently; FMCSA carrier records are replaced with the current set on each sync. The **GET RECENT LEADS** button sends only the leads that have never been sent before, each one once.

## Contents

1. [Using it in the bot](#using-it-in-the-bot)
2. [How it works](#how-it-works)
3. [Where leads come from](#where-leads-come-from)
4. [Data providers: what was checked](#data-providers-what-was-checked)
5. [Fresh-only delivery](#fresh-only-delivery)
6. [Duplicates and updates](#duplicates-and-updates)
7. [Consent, verification and opt-outs](#consent-verification-and-opt-outs)
8. [Database](#database)
9. [Vendor webhook reference](#vendor-webhook-reference)
10. [Settings](#settings)
11. [Deploying](#deploying)
12. [Calling and texting rules](#calling-and-texting-rules)
13. [How this differs from the original brief](#how-this-differs-from-the-original-brief)

---

## Using it in the bot

The bot has two separate sections: **🎓 Agent Academy** (the Sales Agent test and its reports) and **🚚 Driver Leads**. `/start` shows both as buttons to administrators. Tap **🚚 Driver Leads** (or send `/leads`) to get the keyboard below; **🏠 Home** goes back to the choice. Every Driver Leads message starts with a title that says so, and the command menu labels each command with its section.

Everyone else sees only the test and is never shown this section.

The keyboard has two rows: **🆕 GET RECENT LEADS**, then **📈 STATISTICS**, **📂 DOWNLOADS** and **🏠 Home**. 📂 DOWNLOADS opens a small menu of buttons under one message; choosing a state or CDL class changes that message in place, and each file arrives as a new message.

| Button | What it sends |
|---|---|
| 🆕 **GET RECENT LEADS** | Every eligible lead that was never delivered before, as an Excel file. The leads are then marked delivered. Ten or fewer are also shown as text with tap-to-call numbers. If nothing is new: "No new driver leads available at the moment. Check again later." |
| 📈 **STATISTICS** | Totals, new and sent, added today and this week, what can't be delivered and why, by state, by CDL class, by source, duplicates. |
| 📂 **DOWNLOADS** → 📅 Today's leads | Everything added today (report time zone), delivered or not. |
| 📂 → 📍 By state / 🪪 By CDL class | A list of states (or classes A, B, C, "not given") with counts; tap one to get its leads. Also `/state TX`, `/cdl A`. |
| 📂 → 📊 All as Excel / 📄 All as CSV | All contactable leads. |
| 📂 → 🗄 Full database | Every record, including ones that can't be contacted (their phone and email are left out), plus a Summary sheet. |
| `/resend` | Sends your last GET RECENT LEADS file again. The leads stay delivered; nothing is queued twice. |

The buttons of the earlier, bigger keyboard still work for anyone who has it open.

Only GET RECENT LEADS changes anything. The other buttons are read-only copies, and each file has a **Delivery** column showing which rows are still "New".

Delivery is shared: once anyone with access receives a lead, it is delivered for everyone.

There is no cap on how many leads one click returns. Large results are split into files of 5,000 leads (10,000 rows for exports). If a click runs out of time, the bot says so and one more tap continues.

**Who can use it.** Academy administrators, and nobody else. Making someone an admin in the Academy console (Users → Make admin) gives them Driver Leads, including the drivers' contact details; removing them takes it away at once. There is no separate access list. Owners (`ADMIN_TELEGRAM_IDS`) additionally get the owner commands below.

**Owner commands**

| Command | What it does |
|---|---|
| `/leadsource` | List sources. `/leadsource add vendor-id Vendor name` creates a vendor webhook and shows its token once. `/leadsource attest vendor-id`, `/leadsource off vendor-id`, `/leadsource on vendor-id`. |
| `/leadsync` | Run the pull sources now instead of waiting for the daily schedule. |
| `/optout (214) 555-7890` | Never deliver this phone number or email again. `/optout undo (214) 555-7890` takes an opt-out back. |
| Send a `.csv` file | Imports it. Put a source id in the caption, or leave it empty for `csv-import`. Up to 5,000 rows per file. Comma, semicolon or tab separated; UTF-8, UTF-16 or a Windows code page (as Excel saves them). |

## How it works

```
 Driver registration page ──┐  (push, real time)
 Vendor webhooks ───────────┤
 CSV sent to the bot ───────┼──► validate ──► ingest_driver() ──► drivers (master table)
 FMCSA census (daily pull) ─┘     reject        new │ duplicate            │
                                  invalid           │ → merged             │
                                                    ▼                      ▼
                                              ingestion_logs      GET RECENT LEADS
                                                                  claim → send file → confirm
                                                                           │
                                                                  delivery_history (one row per driver, ever)
```

Everything runs in the existing bot and database on our server. No new services or paid tiers.

| File | Purpose |
|---|---|
| `shared/leads.ts` | Field names providers use, validation and normalisation. Pure functions. |
| `tools/driver-leads/ingest.ts` | Import pipeline, registration and opt-out endpoints, vendor webhook, suppression list. |
| `tools/driver-leads/store.ts` | Claim, confirm and release for fresh-only delivery; export queries; statistics; access. |
| `tools/driver-leads/messages.ts` | **Every text the bot sends in this section.** Change the wording here. |
| `tools/driver-leads/files.ts` | Excel and CSV files. |
| `tools/driver-leads/actions.ts` | What each action does: new leads once, files, statistics, owner tools. |
| `telegram_bot/handlers/admins/leads.ts` | Which button, command or uploaded file asks for which action, and who may. |
| `tools/driver-leads/fmcsa.ts` | The FMCSA pull source and the daily sync. |
| `tools/driver-leads/index.ts` | Driver Leads' API routes. `telegram_bot/handlers/admins/index.ts` and `core/home.ts` hold the home screen that switches between sections. |
| `tools/driver-leads/signup-page/` | The registration page, published at `/drivers/`. |
| `db_storage/migrations/0003_driver_leads.sql` | Schema and the `ingest_driver` function. |

## Where leads come from

| Source | Kind of record | Consent basis | Arrives | Status |
|---|---|---|---|---|
| **Registration page** `/drivers/` | Driver sign-ups | The driver ticks a consent box; the wording, time, IP address and browser are stored | Instantly | On |
| **Vendor webhooks** `/api/leads/ingest/<id>` | Whatever a provider or ad platform posts | Each record must carry `consent: true`, unless you attest the source | Instantly | Create one per vendor with `/leadsource add` |
| **CSV import** | Lists you send to the bot | A `consent` column, or the source's attestation | When you send a file | On |
| **FMCSA new registrations** | **Carrier** records: newly registered one-truck carriers | None. Public business registry | Daily | **Off** until `LEADS_FMCSA_ENABLED=true` |

The registration page is the only source of real, consented, individual driver sign-ups that works without a provider contract. It needs traffic: link it from ads, QR codes at truck stops, social posts and your agents' messages.

Meta (Facebook/Instagram), Google and TikTok lead-form ads can all post to a webhook, so they fit the vendor webhook. Google posts the lead itself. Meta's webhook sends only IDs and the fields must then be fetched from its Graph API, so Meta needs either a small adapter or a connector such as Zapier or Make posting to the vendor webhook.

### About the FMCSA source

FMCSA publishes **carrier** data. It has no public database of individual drivers. This connector reads the public Company Census File and keeps active US carriers registered in the last 10 days with one power unit and "authorized for hire": in practice, owner-operators who just got their own authority.

These records are stored and shown as **Carrier (owner-operator)** with the contact basis **Public FMCSA business record**. They are never presented as driver sign-ups: the file columns say so, the delivery caption counts them separately, and the statistics list them on their own line. CDL class, experience, endorsements and equipment stay empty because the registry doesn't contain them.

**Old FMCSA data is replaced.** Each daily sync adds the newly registered carriers and deletes the FMCSA carrier records whose registration date is more than 10 days old. Details:

- A carrier still in the window is left untouched, so one that was already delivered is not delivered again.
- A carrier whose registration date leaves the window is deleted whether or not it was ever delivered. Press GET RECENT LEADS at least once every 10 days, or raise `LEADS_FMCSA_LOOKBACK_DAYS`, so none is deleted unseen.
- A deleted carrier leaves its USDOT numbers in `lead_tombstones` and can never return as a "new" lead. That includes a second USDOT number of the same owner that was merged into the record.
- Deletion goes by each record's own registration date, not by what FMCSA answers that day. An empty, short or broken answer deletes nothing.
- A carrier who also signed up on the registration page is a consented driver and is kept.
- Leads from other sources are never deleted.
- Set `LEADS_FMCSA_REPLACE_OLD=false` to keep every FMCSA record instead.

A live run on 12/11/2026 returned 1,154 carriers for the 10-day window (about 115 a day), nearly all with a phone number and an email address.

Nobody in this file asked to be contacted. Read [Calling and texting rules](#calling-and-texting-rules) before switching it on.

## Data providers: what was checked

Researched on 12/11/2026 from the providers' own pages where they could be read. "Not confirmed" means the page blocked automated reading or doesn't publish the detail; ask the provider.

**Bottom line.** No source was found that legitimately supplies a continuous feed of individual truck-driver contact records for sales outreach. Individual driver data sits in two places: government systems that are closed to the public, and recruiting platforms whose terms tie the data to hiring. What works is the public carrier registry, commercial products built on it, and leads you capture yourself with consent.

| Provider | Drivers or carriers | Access | Price | Usable for sales outreach? |
|---|---|---|---|---|
| **FMCSA Company Census File** | Carriers, including owner-operators with their own USDOT number | Public API, no key | Free | Yes, as business prospecting, subject to the calling rules below. **Integrated.** |
| FMCSA QCMobile API | Carriers | Free key | Free | Lookup of a known carrier only; no feed of new registrations |
| CDLIS, Drug & Alcohol Clearinghouse, Training Provider Registry | Individual drivers | Closed to the public by regulation (49 CFR 384.225) | — | No |
| **Indeed** (Indeed Apply) | Job applicants | Employers and ATS partners | Not published | **No.** Its rules bar calls and texts unrelated to hiring, and unsolicited commercial messages |
| **ZipRecruiter** | Job applicants | ATS partners | Not published | **No** (terms seen only second-hand) |
| **Tenstreet** | Job applicants, held for carrier clients | Carrier clients only | Pulse Match from $30 per application; API fee not confirmed | **No.** Shares data only with employers the driver chooses |
| **CDLjobs.com** | Driver job applications | Advertising carriers; real-time delivery | Rate card exists; numbers not confirmed | Not confirmed. A recruiting product; ask for the consent wording |
| CDL training schools | Students | No public channel. Only a direct partnership with student consent | — | Only through your own partnership |
| Lanefinder, Drive My Way, JobsInTrucks | Driver applications or matches | Hiring carriers | Not published | Not confirmed. Recruiting products |
| AlphaLoops | Carriers plus decision-maker contacts | SaaS, CSV, API on Enterprise | $1,200–$4,000 a month | Yes. Built for selling to carriers |
| CarrierOk | Carriers | Web app, API, bulk feeds | $149–$499 a month | Yes for carrier-level prospecting; contact coverage not confirmed |
| Fusable RigDig (ex Randall-Reilly) | Fleets and owner-operators | Subscription | Not published | Likely. Get the terms in writing |
| **Meta, Google, TikTok lead-form ads** | People who fill in your own form | Webhook | Ad spend only | **Yes.** Your own consent wording |
| Trucker media (for example CDLLife) | An audience, not a list | Advertising | Not published | Yes, as a way to send drivers to your registration page |

Any recruiting vendor can be connected through a vendor webhook if it gives you, in writing, consent wording that covers contact by your company for your purpose. Without that, treat its leads as not usable.

## Fresh-only delivery

Each driver has a `delivery_status`: `pending`, `claimed` or `delivered`.

1. **Claim.** One statement moves every eligible `pending` driver to `claimed` under row locks (`FOR UPDATE SKIP LOCKED`). Two clicks at the same instant cannot claim the same driver.
2. **Send.** The bot builds the Excel file from the claimed rows and sends it.
3. **Confirm.** After the file is sent, the rows become `delivered` with a timestamp, and one row per driver goes into `delivery_history`. That table has a unique constraint on the driver, so a second delivery is impossible at the database level. The confirm step is tried up to three times.
4. **If Telegram refuses the file,** the rows go back to `pending` and the bot says they were not marked as sent. The next click sends them.
5. **If Telegram does not answer** (a timeout or a dropped connection), nobody knows whether the file arrived. The leads are marked delivered so they can never go out twice, and the bot says so. `/resend` sends that file again to the person it was meant for.
6. **If the function dies mid-way,** rows left `claimed` for more than 5 minutes return to the queue on the next click.

One case can still repeat a file: Telegram accepts it and the database stays unreachable through all three confirm attempts. The bot says the leads may appear once more, and they return to the queue after 5 minutes.

Telegram retries a webhook call that is slow to answer. Each update id runs once (`bot_updates`).

**Eligible** means all of: never delivered; consent is `granted` or the record is a `public_record`; verification is `verified`.

## Duplicates and updates

A record is matched to an existing driver by, in order: the source's own record id, then phone number, then email address. All three live in `driver_identities`, where each key can belong to only one driver. Rows of an imported CSV file are matched by phone and email only: an `id` column in a list is a row number that repeats from file to file.

- **No match:** a new driver is added and becomes a new lead.
- **Match:** the record is merged into the existing driver. New values fill in or replace the profile, lists such as equipment are combined, `updated_at` and `update_count` change, and the import is counted as a duplicate. **Delivery state is not touched**, so an updated profile of a delivered driver is never sent again.
- A stored driver who had no consent and later gains it becomes eligible and is delivered then, for the first time.

Two imports of the same person at the same moment wait for each other (advisory locks on the identity keys) instead of creating two rows.

## Consent, verification and opt-outs

- **Consent status:** `granted`, `public_record` (FMCSA only), `unknown`, or `revoked`. Every grant and every opt-out is written to `consent_records` with its method, source, wording, IP address and time.
- **Attested sources.** `/leadsource attest <id>` records, under your Telegram ID, that every record from that provider is opt-in under your contract. From then on its records count as consented.
- **Verification** is automatic format validation: a possible US phone number (correct length, valid area code and exchange, not a placeholder such as 222-222-2222) or a well-formed email address that isn't on a throwaway domain. It does not confirm that the number is live or belongs to the person; that needs a paid lookup service. A provider can send `verified: false` to hold a record back.
- **Opt-outs stick.** `/optout`, the "Stop being contacted" link on the registration page, or `optout: true` from a vendor all put the contact on `lead_suppressions`. The person is never delivered, even if a provider sends them again later, and exports leave out their contact details. An opt-out covers the contact that was given: opting out an email address does not touch a phone number.
- **Two things end an opt-out.** The driver signs up again on the registration page and ticks the consent box (the new consent is recorded like any other). Or an owner sends `/optout undo <contact>`, which gives each record back the consent status it had before the opt-out and writes that to `consent_records`.
- Records without consent are still stored (so they are recognised as duplicates later) but their phone and email never leave the database.

## Database

| Table | Purpose |
|---|---|
| `drivers` | Master table. Lead ID, record type, name, phone, email, number of trucks (in `extra.power_units`), state, city, ZIP, CDL class, years of experience, endorsements, driver types, equipment, employment preferences, availability, company, USDOT number, source, source record id, first added, last updated, verification, consent and delivery status, delivered at. |
| `lead_sources` | Sources, their consent mode, webhook token hash and on/off switch. |
| `driver_identities` | Phone, email and source-record keys; the dedupe authority. |
| `consent_records` | Append-only proof of consent and opt-outs. |
| `lead_suppressions` | Do-not-contact list. |
| `delivery_batches` | Every file sent (audit) and the claim state of GET RECENT LEADS. |
| `delivery_history` | One row per driver ever delivered. |
| `ingestion_logs` | One row per import: received, new, duplicates, rejected, errors. |
| `user_access` | Dropped in migration 0005 (it was never used after access was tied to the Academy admin list). |
| `lead_tombstones` | USDOT keys of FMCSA records deleted as old, so they never return as new leads. |
| `bot_updates`, `lead_rate_hits` | Retry protection and form throttling. |

Row Level Security is on for all of them with no policies, and the `ingest_driver` function is not callable by the `public` role, only by the owner the server connects as.

## Vendor webhook reference

```
POST https://<app>/api/leads/ingest/<source-id>
Authorization: Bearer <token>          (or header X-Lead-Token, or ?token=<token>)
Content-Type: application/json         (or application/x-www-form-urlencoded for a single lead)
```

Body: one lead, a list, or `{"leads": [...]}`. Up to 500 per request.

```json
{
  "lead_id": "abc-123",
  "first_name": "John", "last_name": "Smith",
  "phone": "(214) 555-2368", "email": "john@mail.com",
  "state": "TX", "city": "Dallas", "zip": "75001",
  "cdl_class": "A", "years_experience": 7, "trucks": 2,
  "endorsements": "Hazmat, Tanker",
  "driver_type": "OTR owner operator",
  "equipment": "Dry van, Reefer",
  "availability": "Immediately",
  "consent": true,
  "consent_text": "…the wording the driver agreed to…",
  "trusted_form_cert_url": "https://cert.trustedform.com/…"
}
```

Field names are matched loosely (`Phone Number`, `phone_number` and `phoneNumber` are the same; `name` or first and last name; `cdl`, `cdl_class` or `license_class`). A lead needs a name and a valid US phone number or email address.

Response:

```json
{ "received": 3, "processed": 3, "inserted": 2, "duplicates": 1, "rejected": 0, "opted_out": 0, "errors": [] }
```

To pass on an opt-out: `{"phone": "…", "optout": true}`.

**Adding a pull provider later:** write a module that fetches the provider's new records and passes them to `ingestRecords()` as `runFmcsa()` does in `tools/driver-leads/fmcsa.ts`, add its row to `lead_sources`, and call it from `runPullSources()` in the same file.

## Settings

| Variable | Default | What it is |
|---|---|---|
| `LEADS_COMPANY_NAME` | `CFT` | Company named on the registration page and in the consent wording. Use the legal name. |
| `LEADS_CONSENT_TEXT` | built-in wording | Replaces the consent wording. |
| `LEADS_FMCSA_ENABLED` | `false` | `true` turns on the daily FMCSA carrier import. |
| `LEADS_FMCSA_MAX_POWER_UNITS` | `1` | Largest fleet still imported. |
| `LEADS_FMCSA_FOR_HIRE_ONLY` | `true` | Only carriers registered as authorized for hire. |
| `LEADS_FMCSA_LOOKBACK_DAYS` | `10` | Days of registrations kept and re-checked on each run. |
| `LEADS_FMCSA_REPLACE_OLD` | `true` | Each sync deletes FMCSA carrier records registered before the window. `false` keeps them all. |
| `SOCRATA_APP_TOKEN` | — | Optional token for data.transportation.gov. Not needed at this volume. |

`CRON_SECRET`, `APP_URL` and `ADMIN_TELEGRAM_IDS` are reused from the existing setup.

**Schedule.** The server runs `/api/cron/leads` once a day at 14:30 UTC (19:30 Tashkent), after FMCSA's daily refresh (`cft-cron-leads.timer`, times in `deploy/setup-server.sh`). Once a day matches how often FMCSA updates. The registration page, webhooks and CSV imports don't wait for any schedule. `/leadsync` runs the pull sources on demand.

## Deploying

```bash
npm run typecheck && npm test && npm run build

# On the server, as cft (docs/VM_DEPLOY.md). Push to main, then deploy with --migrate:
# it adds the new tables first (the old code ignores them) and only then puts the new code live.
cd ~/app && deploy/update.sh main --migrate
# (or GitHub → Actions → Deploy to VM with "migrate" ticked)

# 2. Optional: in ~/app/.env set LEADS_COMPANY_NAME, and LEADS_FMCSA_ENABLED=true if you
#    decide to use the FMCSA source, then: sudo systemctl restart cft-agent

# 3. Add /leads to the owners' command menu (optional; the buttons work without it)
npm run telegram:setup
```

Then send `/start` to the bot. Owners get the home screen with the two sections.

The tables must exist before the new code runs: the new code expects them, the old code ignores them. A deploy without `--migrate` that brings these migrations stops and changes nothing.

## Calling and texting rules

This is a summary for orientation, not legal advice. Have counsel review the consent wording and your outreach process before agents start dialling.

- **Automated calls and texts.** Marketing calls or texts to mobile phones using an autodialer or a prerecorded voice need the person's prior express written consent (TCPA, 47 CFR 64.1200). Leads from your registration page have it, provided the wording names your company. FMCSA records do not.
- **National Do Not Call Registry.** Calls to a business to sell to that business are mostly exempt, but an owner-operator's number is often a personal mobile, and courts treat that case by case. Scrub against the registry and keep your own do-not-call list (`/optout`).
- **State laws.** Florida and Oklahoma, among others, restrict automated sales calls and texts without written consent and allow private lawsuits.
- **Email.** CAN-SPAM needs no opt-in but does require honest headers and subject, your postal address, and a working unsubscribe honoured within 10 business days. It has no exception for business email.
- **Lead ads.** Lead data from Meta, Google and TikTok may be used only as your own form and privacy policy describe.

The practical line: for FMCSA records, email and manually dialled calls after a registry scrub are the defensible channels. Automated texting or dialling should go only to people who signed up through your own form.

## How this differs from the original brief

- **Stack.** The brief suggested Python, aiogram, FastAPI, APScheduler and Docker. This bot already runs as a TypeScript webhook with PostgreSQL, and Telegram allows only one receiver per bot token, so the feature was built into the existing code. PostgreSQL is used as asked. Docker isn't involved: the bot runs as a service on our server (docs/VM_DEPLOY.md).
- **Schedule.** The server's scheduled jobs (systemd timers) replace APScheduler.
- **Providers.** Indeed, ZipRecruiter, Tenstreet and CDLjobs are not integrated, because their data is restricted to hiring or their terms could not be confirmed. The vendor webhook accepts any of them the day you have a contract and consent wording that allow your use.
