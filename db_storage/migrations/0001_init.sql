-- CFT Agent Academy — initial schema.
-- All access goes through the server API, which connects as the database owner.
-- Row Level Security is enabled on every table with NO policies, so Supabase's public
-- `anon` / `authenticated` roles (the browser-facing REST API) can read or write nothing.

create table topics (
  id          text primary key check (id ~ '^[a-z][a-z0-9_-]{1,40}$'),
  name        text not null check (length(name) between 1 and 80),
  sort_order  int  not null default 0
);

-- Everyone who has started the bot or opened the Mini App (the admin "Users" list).
create table telegram_users (
  id             bigint primary key,               -- Telegram user ID
  first_name     text,
  last_name      text,
  username       text,
  language_code  text,
  started_bot    boolean not null default false,   -- has a private chat with the bot, so it can message them
  blocked_bot    boolean not null default false,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);

-- Admins sign in inside Telegram (telegram_user_id) and/or in a browser (email + password).
-- Owners come from the ADMIN_TELEGRAM_IDS environment variable and can't be removed in the app.
create table admins (
  id                uuid primary key default gen_random_uuid(),
  email             text unique check (email is null or (email = lower(email) and position('@' in email) > 1)),
  password_hash     text,
  telegram_user_id  bigint unique,
  name              text check (name is null or length(name) <= 80),
  role              text not null default 'admin' check (role in ('owner','admin')),
  notify_results    boolean not null default true,
  weekly_report     boolean not null default true,
  added_by          uuid references admins(id) on delete set null,
  created_at        timestamptz not null default now(),
  last_login_at     timestamptz,
  constraint admins_can_sign_in check (telegram_user_id is not null or (email is not null and password_hash is not null)),
  constraint admins_password_needs_email check (password_hash is null or email is not null)
);

create table questions (
  id                   int generated always as identity primary key,
  number               int  not null unique check (number > 0),
  topic_id             text not null references topics(id),
  topic_inferred       boolean not null default true,
  active               boolean not null default true,
  current_revision_id  bigint,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Question content is append-only: an admin edit adds a revision. Attempts point at the
-- revision the candidate actually saw, so edits apply to new attempts only.
create table question_revisions (
  id              bigint generated always as identity primary key,
  question_id     int    not null references questions(id) on delete cascade,
  revision        int    not null check (revision > 0),
  text            text   not null check (length(text) between 1 and 500),
  options         jsonb  not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) = 4),
  correct_option  char(1) not null check (correct_option in ('A','B','C','D')),
  explanation     text   not null check (length(explanation) between 1 and 2000),
  why_correct     text   not null default '',
  why_incorrect   jsonb  not null default '{}'::jsonb check (jsonb_typeof(why_incorrect) = 'object'),
  basis           text   not null default '',
  source          text   not null default 'official' check (source in ('official','admin_edit')),
  created_by      uuid   references admins(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (question_id, revision)
);

alter table questions
  add constraint questions_current_revision_fk
  foreign key (current_revision_id) references question_revisions(id) deferrable initially deferred;

create table candidates (
  id                 uuid primary key default gen_random_uuid(),
  full_name          text not null check (length(full_name) between 2 and 80),
  telegram_user_id   bigint,
  telegram_username  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
-- One candidate row per Telegram account.
create unique index candidates_telegram_user_uq on candidates(telegram_user_id) where telegram_user_id is not null;

create table assessment_attempts (
  id                uuid primary key default gen_random_uuid(),
  candidate_id      uuid not null references candidates(id) on delete cascade,
  token_hash        text not null unique,          -- sha256 of the candidate's bearer token
  status            text not null default 'in_progress' check (status in ('in_progress','completed')),
  channel           text not null check (channel in ('telegram','web')),
  started_at        timestamptz not null default now(),
  submitted_at      timestamptz,
  total_questions   int  not null check (total_questions > 0),
  correct_count     int  check (correct_count >= 0),
  unanswered_count  int  check (unanswered_count >= 0),
  score_pct         numeric(5,1) check (score_pct between 0 and 100),
  duration_seconds  int  check (duration_seconds >= 0),
  pass_mark         int,                            -- pass mark in force when graded
  constraint attempt_completed_consistent check (
    (status = 'in_progress' and submitted_at is null and correct_count is null)
    or (status = 'completed' and submitted_at is not null and correct_count is not null and score_pct is not null)
  )
);
create index attempts_candidate_idx on assessment_attempts(candidate_id);
create index attempts_status_idx on assessment_attempts(status, started_at desc);
-- A candidate can have at most one open attempt.
create unique index attempts_one_open_uq on assessment_attempts(candidate_id) where status = 'in_progress';

create table attempt_answers (
  id                    bigint generated always as identity primary key,
  attempt_id            uuid   not null references assessment_attempts(id) on delete cascade,
  question_id           int    not null references questions(id),
  question_revision_id  bigint not null references question_revisions(id),
  position              int    not null check (position > 0),
  selected_option       char(1) check (selected_option in ('A','B','C','D')),
  is_correct            boolean,                    -- set by the server at grading time only
  answered_at           timestamptz,
  graded_at             timestamptz,
  unique (attempt_id, question_id),
  unique (attempt_id, position)
);
create index attempt_answers_question_idx on attempt_answers(question_id);

create table app_settings (
  id                   int primary key default 1 check (id = 1),
  pass_mark            int not null check (pass_mark >= 1),
  min_sample           int not null default 10 check (min_sample between 1 and 500),
  allow_retakes        boolean not null default false,
  timezone             text not null default 'Asia/Tashkent',  -- for report dates and week boundaries
  last_weekly_report_at timestamptz,
  sheets_spreadsheet_id text,
  sheets_url           text,
  sheets_name          text,
  sheets_auto_sync     boolean not null default true,
  sheets_rows_synced   int not null default 0,
  sheets_last_sync_at  timestamptz,
  updated_at           timestamptz not null default now()
);

create table admin_sessions (
  id            uuid primary key default gen_random_uuid(),
  admin_id      uuid not null references admins(id) on delete cascade,
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_used_at  timestamptz not null default now(),
  revoked_at    timestamptz
);
create index admin_sessions_admin_idx on admin_sessions(admin_id);

create table admin_login_failures (
  id          bigint generated always as identity primary key,
  email       text not null,
  ip          text,
  created_at  timestamptz not null default now()
);
create index admin_login_failures_email_idx on admin_login_failures(email, created_at desc);
create index admin_login_failures_ip_idx on admin_login_failures(ip, created_at desc);

create table audit_events (
  id          bigint generated always as identity primary key,
  admin_id    uuid references admins(id) on delete set null,
  action      text not null,
  entity      text not null,
  entity_id   text,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- Lock the browser-facing Supabase roles out entirely.
do $$
declare t text;
begin
  foreach t in array array['topics','telegram_users','admins','questions','question_revisions','candidates','assessment_attempts',
                           'attempt_answers','app_settings','admin_sessions','admin_login_failures','audit_events'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'revoke all on all sequences in schema public from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on tables from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on sequences from anon, authenticated';
  end if;
end $$;
