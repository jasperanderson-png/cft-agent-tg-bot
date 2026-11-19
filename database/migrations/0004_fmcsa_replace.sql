-- FMCSA "replace" mode: each sync deletes carrier records that are no longer in the current FMCSA
-- window. A deleted record leaves its registry key here, so it can never come back as a "new" lead
-- (for example if the look-back window is widened later). Keys are public USDOT numbers only.
create table lead_tombstones (
  key         text primary key,     -- 'src:<source>:<record id>'
  deleted_at  timestamptz not null default now()
);
alter table lead_tombstones enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table lead_tombstones from anon, authenticated';
  end if;
end $$;
