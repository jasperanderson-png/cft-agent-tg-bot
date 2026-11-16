-- Short-lived report downloads (CSV / Excel). Telegram's in-app browser can't save blob: downloads,
-- so the server keeps the file briefly behind an unguessable URL for Telegram.WebApp.downloadFile.
create table export_files (
  id            uuid primary key default gen_random_uuid(),
  admin_id      uuid not null references admins(id) on delete cascade,
  token_hash    text not null unique,
  filename      text not null check (filename ~ '^[A-Za-z0-9._-]{1,120}$'),
  content_type  text not null,
  content       bytea not null check (octet_length(content) <= 5000000),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);
create index export_files_expires_idx on export_files(expires_at);
alter table export_files enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table export_files from anon, authenticated';
  end if;
end $$;
