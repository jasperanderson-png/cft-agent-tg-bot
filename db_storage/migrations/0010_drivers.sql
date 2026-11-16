-- Drivers: truck drivers who joined through a driver invite link. They can open the route map (/route)
-- and nothing else. Admins make driver links; so can agents an admin allowed to ('drivers' in
-- agents.permissions). A link works for anyone until it expires or is turned off, like agent links.
--
--   driver_invites  only a SHA-256 of the token is stored; made by an admin or by an agent
--   map_drivers     who joined, and through which link (not `drivers`: that is the Driver Leads database)
--   telegram_users.menu_role
--                   which role's menu button and commands Telegram was last told to show this person.
--                   When it differs from their role, the bot sets them again (a change Telegram missed
--                   is redone on the next message: agents were left with "Start test").

create table driver_invites (
  id                uuid primary key default gen_random_uuid(),
  token_hash        text not null unique,
  label             text check (label is null or length(label) <= 80),
  created_by_admin  uuid references admins(id) on delete set null,
  created_by_agent  bigint references agents(telegram_user_id) on delete set null,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  revoked_at        timestamptz,
  uses              int not null default 0 check (uses >= 0)
);
alter table driver_invites enable row level security;

create table map_drivers (
  telegram_user_id  bigint primary key,
  name              text check (name is null or length(name) <= 80),
  username          text,
  invite_id         uuid references driver_invites(id) on delete set null,
  joined_at         timestamptz not null default now()
);
alter table map_drivers enable row level security;

alter table telegram_users add column menu_role text;
