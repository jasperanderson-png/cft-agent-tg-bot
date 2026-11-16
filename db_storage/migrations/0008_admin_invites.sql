-- Admin invite links: an owner sends a link, the person taps Start and is an admin. Unlike agent
-- links, each admin link works ONCE (admins see every lead and the real fuel prices), and only until
-- it expires or an owner turns it off. Only a SHA-256 of the token is stored.
create table admin_invites (
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

do $$
begin
  execute 'alter table public.admin_invites enable row level security';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table admin_invites from anon, authenticated';
  end if;
end $$;
