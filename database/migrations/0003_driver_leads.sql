-- Driver leads: a master database that only grows, plus a delivery ledger so the bot hands out
-- each eligible lead exactly once.
--
--   lead_sources      where records come from (own form, vendor webhooks, CSV imports, pull connectors)
--   drivers           the master table, one row per person (or per carrier, for public-registry sources)
--   driver_identities every key that identifies a driver (phone, email, source record id) — the dedupe authority
--   consent_records   append-only proof of consent and opt-outs
--   lead_suppressions do-not-contact list (opt-outs stick even if a provider sends the person again)
--   delivery_batches  every file the bot sent (audit) and the claim state of "GET RECENT LEADS"
--   delivery_history  one row per driver ever delivered — UNIQUE(driver_id) is the "never twice" guarantee
--   ingestion_logs    one row per import run
--   user_access       Telegram users (besides the owners) allowed to use the leads feature

create table lead_sources (
  id                text primary key check (id ~ '^[a-z][a-z0-9_-]{1,40}$'),
  name              text not null check (length(name) between 1 and 80),
  kind              text not null check (kind in ('form','webhook','import','api')),
  -- What one record of this source is. FMCSA data is about carriers (companies), never individual driver sign-ups.
  record_kind       text not null default 'driver' check (record_kind in ('driver','carrier')),
  -- per_record: each record must carry its own consent flag.  attested: the provider contract guarantees
  -- every record is opt-in.  public_record: public business registry data, no individual consent exists.
  consent_mode      text not null default 'per_record' check (consent_mode in ('per_record','attested','public_record')),
  active            boolean not null default true,
  token_hash        text unique,                      -- webhook sources: sha256 of the secret
  cursor            jsonb not null default '{}'::jsonb,
  notes             text,
  created_by        bigint,
  created_at        timestamptz not null default now(),
  last_ingested_at  timestamptz
);

insert into lead_sources (id, name, kind, record_kind, consent_mode, notes) values
  ('web-form',     'Driver registration page', 'form',   'driver',  'per_record',    'Drivers who signed up on /drivers and ticked the consent box.'),
  ('csv-import',   'CSV import',               'import', 'driver',  'per_record',    'CSV files an owner sends to the bot. Rows need consent=yes to be deliverable.'),
  ('fmcsa-census', 'FMCSA new registrations',  'api',    'carrier', 'public_record', 'Newly registered small carriers from the public FMCSA Company Census File. Carrier business records, not driver opt-ins.');

create table drivers (
  id                      uuid primary key default gen_random_uuid(),
  lead_no                 bigint generated always as identity unique,   -- short, stable, human-readable ID
  record_kind             text not null default 'driver' check (record_kind in ('driver','carrier')),
  full_name               text not null check (length(full_name) between 2 and 80),
  phone                   text check (phone ~ '^\+1[2-9][0-9]{9}$'),
  email                   text check (email = lower(email) and position('@' in email) > 1),
  state                   text check (state ~ '^[A-Z]{2}$'),
  city                    text check (length(city) <= 80),
  zip                     text check (zip ~ '^[0-9]{5}$'),
  cdl_class               text check (cdl_class in ('A','B','C')),
  years_experience        numeric(4,1) check (years_experience between 0 and 70),
  endorsements            text[] not null default '{}',
  driver_types            text[] not null default '{}',
  equipment               text[] not null default '{}',
  employment_preferences  text check (length(employment_preferences) <= 300),
  availability            text check (length(availability) <= 80),
  company_name            text check (length(company_name) <= 120),
  usdot_number            text check (usdot_number ~ '^[0-9]{1,9}$'),
  extra                   jsonb not null default '{}'::jsonb,
  source_id               text not null references lead_sources(id),
  source_record_id        text check (length(source_record_id) <= 120),
  first_added_at          timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  update_count            int  not null default 0,          -- later records that matched this driver
  verification_status     text not null default 'unverified' check (verification_status in ('verified','unverified','invalid')),
  consent_status          text not null default 'unknown' check (consent_status in ('granted','public_record','unknown','revoked')),
  consent_at              timestamptz,
  delivery_status         text not null default 'pending' check (delivery_status in ('pending','claimed','delivered')),
  delivery_batch_id       uuid,
  claimed_at              timestamptz,
  delivered_at            timestamptz,
  delivered_to            bigint,
  constraint drivers_has_contact check (phone is not null or email is not null),
  constraint drivers_delivery_consistent check ((delivery_status = 'delivered') = (delivered_at is not null))
);
-- The delivery queue: undelivered rows in arrival order.
create index drivers_queue_idx on drivers(lead_no) where delivery_status = 'pending';
create index drivers_claimed_idx on drivers(delivery_batch_id) where delivery_status = 'claimed';
create index drivers_added_idx on drivers(first_added_at desc);
create index drivers_state_idx on drivers(state);
create index drivers_cdl_idx on drivers(cdl_class);
create index drivers_source_idx on drivers(source_id);

create table driver_identities (
  key         text primary key,     -- 'phone:+1…' | 'email:…' | 'src:<source>:<record id>'
  driver_id   uuid not null references drivers(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index driver_identities_driver_idx on driver_identities(driver_id);

create table lead_suppressions (
  key         text primary key,     -- 'phone:+1…' | 'email:…'
  reason      text,
  created_by  bigint,
  created_at  timestamptz not null default now()
);

create table consent_records (
  id            bigint generated always as identity primary key,
  driver_id     uuid references drivers(id) on delete cascade,
  status        text not null check (status in ('granted','public_record','revoked')),
  method        text not null,       -- web_form | source_record | source_attestation | public_record | opt_out_admin | opt_out_self | opt_out_source
  source_id     text references lead_sources(id),
  consent_text  text,
  proof_url     text,
  ip            text,
  user_agent    text,
  contact_key   text,                -- opt-outs for a contact that is not in the database yet
  recorded_by   bigint,
  recorded_at   timestamptz not null default now()
);
create index consent_records_driver_idx on consent_records(driver_id);

create table delivery_batches (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('recent','today','full','csv','excel','state','cdl')),
  filter        text,
  format        text not null check (format in ('xlsx','csv')),
  requested_by  bigint not null,
  chat_id       bigint not null,
  status        text not null default 'claimed' check (status in ('claimed','delivered','failed')),
  lead_count    int  not null default 0,
  filename      text,
  error         text,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index delivery_batches_created_idx on delivery_batches(created_at desc);

create table delivery_history (
  id                bigint generated always as identity primary key,
  driver_id         uuid not null unique references drivers(id) on delete cascade,
  batch_id          uuid not null references delivery_batches(id),
  telegram_user_id  bigint not null,
  delivered_at      timestamptz not null default now()
);
create index delivery_history_batch_idx on delivery_history(batch_id);

create table ingestion_logs (
  id           bigint generated always as identity primary key,
  source_id    text not null references lead_sources(id),
  trigger      text not null check (trigger in ('form','webhook','import','schedule','manual')),
  status       text not null default 'ok' check (status in ('ok','partial','error')),
  received     int not null default 0,
  inserted     int not null default 0,     -- genuinely new drivers
  updated      int not null default 0,     -- duplicates: matched an existing driver, merged, not re-added
  rejected     int not null default 0,     -- failed validation, never stored
  opted_out    int not null default 0,
  error        text,
  details      jsonb not null default '{}'::jsonb,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index ingestion_logs_source_idx on ingestion_logs(source_id, started_at desc);

create table user_access (
  telegram_user_id  bigint primary key,
  role              text not null default 'member' check (role in ('member')),
  name              text check (length(name) <= 80),
  granted_by        bigint,
  granted_at        timestamptz not null default now(),
  revoked_at        timestamptz
);

-- Telegram retries a webhook call that takes too long; long-running lead actions run once per update.
create table bot_updates (
  update_id    bigint primary key,
  received_at  timestamptz not null default now()
);

-- Public form / opt-out throttling.
create table lead_rate_hits (
  id          bigint generated always as identity primary key,
  bucket      text not null,
  created_at  timestamptz not null default now()
);
create index lead_rate_hits_bucket_idx on lead_rate_hits(bucket, created_at desc);

-- Adds one validated record to the master database, or merges it into the driver it duplicates.
-- Runs as one statement, so the whole decision is atomic; advisory locks on every identity key make
-- two simultaneous imports of the same person wait for each other instead of creating two rows.
--
-- A match never touches delivery state: an updated profile of a delivered driver is not a new lead.
create function ingest_driver(p_source text, r jsonb)
returns table (o_id uuid, o_outcome text)
language plpgsql
as $$
declare
  v_phone    text := nullif(r->>'phone', '');
  v_email    text := nullif(r->>'email', '');
  v_srcid    text := nullif(r->>'source_record_id', '');
  v_consent  text := coalesce(nullif(r->>'consent_status', ''), 'unknown');
  v_verif    text := coalesce(nullif(r->>'verification_status', ''), 'unverified');
  v_keys     text[] := array_remove(array[
                 case when v_srcid is not null then 'src:' || p_source || ':' || v_srcid end,
                 case when v_phone is not null then 'phone:' || v_phone end,
                 case when v_email is not null then 'email:' || v_email end], null);
  v_id       uuid;
  v_prev     text;
  v_supp     boolean;
  v_phone_ok boolean;
  v_email_ok boolean;
  k          text;
begin
  if cardinality(v_keys) = 0 then
    raise exception 'record has no identity (phone, email or source record id)';
  end if;
  if v_consent not in ('granted', 'public_record', 'unknown') then
    raise exception 'bad consent_status %', v_consent;
  end if;

  for k in select x from unnest(v_keys) as x order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended(k, 7));
  end loop;

  -- Stable identity: the source's own record id first, then phone, then email.
  select i.driver_id into v_id
    from driver_identities i
   where i.key = any(v_keys)
   order by array_position(v_keys, i.key)
   limit 1;

  v_supp := exists (select 1 from lead_suppressions s where s.key = any(v_keys));
  if v_supp then v_consent := 'revoked'; end if;

  if v_id is null then
    insert into drivers (record_kind, full_name, phone, email, state, city, zip, cdl_class, years_experience,
                         endorsements, driver_types, equipment, employment_preferences, availability,
                         company_name, usdot_number, extra, source_id, source_record_id,
                         verification_status, consent_status, consent_at)
    values (coalesce(nullif(r->>'record_kind', ''), 'driver'), r->>'full_name', v_phone, v_email,
            nullif(r->>'state', ''), nullif(r->>'city', ''), nullif(r->>'zip', ''), nullif(r->>'cdl_class', ''),
            (r->>'years_experience')::numeric,
            array(select jsonb_array_elements_text(coalesce(r->'endorsements', '[]'::jsonb))),
            array(select jsonb_array_elements_text(coalesce(r->'driver_types', '[]'::jsonb))),
            array(select jsonb_array_elements_text(coalesce(r->'equipment', '[]'::jsonb))),
            nullif(r->>'employment_preferences', ''), nullif(r->>'availability', ''),
            nullif(r->>'company_name', ''), nullif(r->>'usdot_number', ''), coalesce(r->'extra', '{}'::jsonb),
            p_source, v_srcid, v_verif, v_consent,
            case when v_consent = 'granted' then coalesce((r->>'consent_at')::timestamptz, now()) end)
    returning id into v_id;

    insert into driver_identities (key, driver_id) select x, v_id from unnest(v_keys) as x on conflict do nothing;

    if v_consent in ('granted', 'public_record') then
      insert into consent_records (driver_id, status, method, source_id, consent_text, proof_url, ip, user_agent)
      values (v_id, v_consent, coalesce(nullif(r->>'consent_method', ''), 'source_record'), p_source,
              r->>'consent_text', r->>'consent_proof', r->>'consent_ip', r->>'consent_user_agent');
    end if;
    return query select v_id, 'inserted'::text;
    return;
  end if;

  select d.consent_status into v_prev from drivers d where d.id = v_id for update;

  -- A new phone or email becomes this driver's only if nobody else already owns it.
  insert into driver_identities (key, driver_id) select x, v_id from unnest(v_keys) as x on conflict do nothing;
  v_phone_ok := v_phone is not null and exists (select 1 from driver_identities i where i.key = 'phone:' || v_phone and i.driver_id = v_id);
  v_email_ok := v_email is not null and exists (select 1 from driver_identities i where i.key = 'email:' || v_email and i.driver_id = v_id);

  update drivers d set
    record_kind = case when r->>'record_kind' = 'driver' then 'driver' else d.record_kind end,
    phone = case when v_phone_ok then v_phone else d.phone end,
    email = case when v_email_ok then v_email else d.email end,
    state = coalesce(nullif(r->>'state', ''), d.state),
    city = coalesce(nullif(r->>'city', ''), d.city),
    zip = coalesce(nullif(r->>'zip', ''), d.zip),
    cdl_class = coalesce(nullif(r->>'cdl_class', ''), d.cdl_class),
    years_experience = coalesce((r->>'years_experience')::numeric, d.years_experience),
    endorsements = array(select distinct e from unnest(d.endorsements || array(select jsonb_array_elements_text(coalesce(r->'endorsements', '[]'::jsonb)))) as e order by 1),
    driver_types = array(select distinct e from unnest(d.driver_types || array(select jsonb_array_elements_text(coalesce(r->'driver_types', '[]'::jsonb)))) as e order by 1),
    equipment = array(select distinct e from unnest(d.equipment || array(select jsonb_array_elements_text(coalesce(r->'equipment', '[]'::jsonb)))) as e order by 1),
    employment_preferences = coalesce(nullif(r->>'employment_preferences', ''), d.employment_preferences),
    availability = coalesce(nullif(r->>'availability', ''), d.availability),
    company_name = coalesce(nullif(r->>'company_name', ''), d.company_name),
    usdot_number = coalesce(nullif(r->>'usdot_number', ''), d.usdot_number),
    extra = d.extra || coalesce(r->'extra', '{}'::jsonb),
    verification_status = case when d.verification_status = 'unverified' and v_verif = 'verified' then 'verified' else d.verification_status end,
    consent_status = case
      when d.consent_status = 'revoked' or v_consent = 'revoked' then 'revoked'   -- an opt-out sticks
      when d.consent_status = 'granted' or v_consent = 'granted' then 'granted'
      when d.consent_status = 'public_record' or v_consent = 'public_record' then 'public_record'
      else 'unknown' end,
    consent_at = case when d.consent_status in ('unknown', 'public_record') and v_consent = 'granted'
                      then coalesce((r->>'consent_at')::timestamptz, now()) else d.consent_at end,
    updated_at = now(),
    update_count = d.update_count + 1
  where d.id = v_id;

  if v_consent = 'granted' and v_prev in ('unknown', 'public_record') then
    insert into consent_records (driver_id, status, method, source_id, consent_text, proof_url, ip, user_agent)
    values (v_id, 'granted', coalesce(nullif(r->>'consent_method', ''), 'source_record'), p_source,
            r->>'consent_text', r->>'consent_proof', r->>'consent_ip', r->>'consent_user_agent');
  elsif v_consent = 'revoked' and v_prev <> 'revoked' then
    insert into consent_records (driver_id, status, method, source_id) values (v_id, 'revoked', 'suppression_list', p_source);
  end if;
  return query select v_id, 'updated'::text;
end $$;

-- Row Level Security on the new tables; the function is not public. The anon/authenticated revokes only
-- run where those roles exist (they did on Supabase); our own PostgreSQL has neither.
do $$
declare t text;
begin
  foreach t in array array['lead_sources','drivers','driver_identities','lead_suppressions','consent_records','delivery_batches',
                           'delivery_history','ingestion_logs','user_access','bot_updates','lead_rate_hits'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  revoke all on function ingest_driver(text, jsonb) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table lead_sources, drivers, driver_identities, lead_suppressions, consent_records, delivery_batches,
                                 delivery_history, ingestion_logs, user_access, bot_updates, lead_rate_hits from anon, authenticated';
    execute 'revoke all on all sequences in schema public from anon, authenticated';
    execute 'revoke all on function ingest_driver(text, jsonb) from anon, authenticated';
  end if;
end $$;
