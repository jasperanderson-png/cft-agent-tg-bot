-- Driver access requests (fuel.cftransportllc.com, and every agent's and admin's two personal links): a
-- driver asks in the bot, an admin approves, and the driver gets the route map in the Mini App and on
-- the website. Also the website's sign-in, confirmed in the bot. See support/helpers/driver-requests.ts
-- and support/helpers/web-login.ts.

-- Each agent's and admin's personal code. It is in both of their links (t.me/<bot>?start=req_<code> and
-- https://fuel.cftransportllc.com/?ref=<code>) and tells who brought a driver. An agent's link makes a
-- request an admin approves; an admin's own link gives access at once.
create table referral_codes (
  code        text primary key check (code ~ '^[a-z0-9]{6,16}$'),
  agent_id    bigint unique references agents(telegram_user_id) on delete cascade,
  admin_id    uuid unique references admins(id) on delete cascade,
  created_at  timestamptz not null default now(),
  check ((agent_id is null) <> (admin_id is null))
);
alter table referral_codes enable row level security;

create table driver_requests (
  id                uuid primary key default gen_random_uuid(),
  telegram_user_id  bigint not null,
  -- asking: the bot is still asking its questions (step); pending: waiting for an admin.
  status            text not null default 'asking' check (status in ('asking','pending','approved','declined')),
  step              text check (step in ('phone','company','source')),
  phone             text check (phone is null or length(phone) <= 32),
  company           text check (company is null or length(company) <= 120),
  source            text check (source is null or length(source) <= 200),
  -- Who brought them (copied from the code, so it stays when the agent or admin is removed; both null:
  -- they came by themselves) and which link they used.
  ref_agent         bigint,
  ref_admin         uuid references admins(id) on delete set null,
  via               text not null check (via in ('bot','website')),
  -- The admins' messages about it, updated once someone decides: [{ "chat": 1, "message": 2 }].
  admin_messages    jsonb not null default '[]',
  created_at        timestamptz not null default now(),
  submitted_at      timestamptz,
  decided_at        timestamptz,
  decided_by        uuid references admins(id) on delete set null
);
-- One open request per person at a time.
create unique index driver_requests_open on driver_requests (telegram_user_id) where status in ('asking', 'pending');
create index driver_requests_pending on driver_requests (submitted_at) where status = 'pending';
alter table driver_requests enable row level security;

-- Where a driver's access came from: the approved request (new) or the driver link (before requests).
alter table map_drivers add column request_id uuid references driver_requests(id) on delete set null;

-- The website's sign-in, confirmed in the bot: the page asks for a code, the person confirms it in the
-- bot, and the page exchanges the code for a session (30 days, renewed while used).
create table web_logins (
  code_hash         text primary key,
  telegram_user_id  bigint,
  created_at        timestamptz not null default now(),
  confirmed_at      timestamptz,
  used_at           timestamptz
);
alter table web_logins enable row level security;

create table web_sessions (
  token_hash        text primary key,
  telegram_user_id  bigint not null,
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  expires_at        timestamptz not null
);
create index web_sessions_person on web_sessions (telegram_user_id);
alter table web_sessions enable row level security;
