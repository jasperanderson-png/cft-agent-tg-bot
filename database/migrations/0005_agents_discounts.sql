-- Agents and the fuel-discount dataset they search.
--
--   agents             Telegram users who joined through an invite link. They can search fuel discounts
--                      (the only permission today; `permissions` leaves room for more later).
--   agent_invites      single-use invite links. Only a SHA-256 of the token is stored.
--   discount_datasets  one row per successful pull of the United Fuel cabinet by an admin. Agents always
--                      search the newest one; the last few are kept.
--   discount_stations  the partner stations (Pilot / Flying J, Love's, TA / Petro, Speedway) of each pull,
--                      with the cabinet's real prices. The agent price (discounted minus the CFT margin)
--                      is worked out when agents read it, so a new margin applies at once.
--
-- user_access (from 0003) was never used and is dropped.

create table agent_invites (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,
  label       text check (label is null or length(label) <= 80),
  created_by  uuid references admins(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by     bigint,
  revoked_at  timestamptz
);

create table agents (
  telegram_user_id  bigint primary key,
  name              text check (name is null or length(name) <= 80),
  username          text,
  permissions       text[] not null default '{discounts}',
  invite_id         uuid references agent_invites(id) on delete set null,
  invited_by        uuid references admins(id) on delete set null,
  joined_at         timestamptz not null default now()
);

create table discount_datasets (
  id                 bigint generated always as identity primary key,
  pulled_at          timestamptz not null default now(),
  pulled_by          bigint,                 -- the admin's Telegram ID, when known
  site_total         int not null check (site_total >= 0),   -- every station the cabinet reports
  partner_stations   int not null check (partner_stations >= 0)
);

create table discount_stations (
  dataset_id        bigint not null references discount_datasets(id) on delete cascade,
  station_id        int not null,
  brand             text not null check (brand in ('pilot','loves','ta','speedway')),
  name              text not null,           -- as the agent sees it, e.g. "Flying J 746"
  raw_name          text not null,           -- as the cabinet names it, e.g. "PILOT_J 746"
  state             text,
  city              text,
  address           text,
  route_exit        text,
  retail            numeric(8,4),
  discounted        numeric(8,4),
  price_updated_at  timestamptz,
  broken            boolean not null default false,
  primary key (dataset_id, station_id)
);

alter table app_settings
  add column agent_margin numeric(5,3) not null default 0.20 check (agent_margin between 0 and 2),
  add column agents_show_no_price boolean not null default false,
  add column agents_show_broken boolean not null default false;

drop table if exists user_access;

do $$
declare t text;
begin
  foreach t in array array['agent_invites','agents','discount_datasets','discount_stations'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table agent_invites, agents, discount_datasets, discount_stations from anon, authenticated';
  end if;
end $$;
