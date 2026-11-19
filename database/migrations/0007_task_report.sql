-- Work reports (tools/task-report/): shifts, the work log, and the daily, weekly and monthly reports the
-- bot posts to a Telegram channel.

-- Someone whose work is reported. A row appears the first time they start a shift.
create table report_staff (
  telegram_user_id   bigint primary key,
  name               text not null,
  channel_id         bigint,          -- the channel their reports go to (null: their private chat)
  channel_title      text,
  status_message_id  bigint,          -- the channel's live "on shift / off shift" message, edited silently
  created_at         timestamptz not null default now()
);

create table work_shifts (
  id          uuid primary key default gen_random_uuid(),
  staff_id    bigint not null references report_staff(telegram_user_id) on delete cascade,
  work_date   date not null,          -- the day the shift started, in the report time zone
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  end_reason  text check (end_reason in ('manual', 'auto')),
  check (ended_at is null or ended_at >= started_at),
  check ((ended_at is null) = (end_reason is null))
);
-- One open shift per person.
create unique index work_shifts_one_open on work_shifts(staff_id) where ended_at is null;
create index work_shifts_day on work_shifts(staff_id, work_date);

-- The work log: what was done, what got better, what was learned, plans and problems. Written in
-- plain words for people who are not programmers.
create table work_entries (
  id           uuid primary key default gen_random_uuid(),
  staff_id     bigint not null references report_staff(telegram_user_id) on delete cascade,
  work_date    date not null,
  kind         text not null check (kind in ('done', 'improved', 'learned', 'plan', 'blocker')),
  text         text not null check (length(text) between 1 and 400),
  detail       text check (length(detail) <= 300),        -- the "before", or why it matters
  area         text check (length(area) <= 40),           -- Топливо, Лиды, Академия, Агенты, Бот, Отчёты…
  size         text not null default 'm' check (size in ('s', 'm', 'l')),
  highlight    boolean not null default false,            -- worth a place in the weekly and monthly highlights
  source       text not null check (source in ('claude', 'bot')),
  external_id  text check (length(external_id) <= 100),   -- lets a sender retry without duplicates
  created_at   timestamptz not null default now(),
  unique (staff_id, external_id)
);
create index work_entries_day on work_entries(staff_id, work_date);

-- Every report posted: one per person, period and start day, so a report can never go out twice.
-- A second shift on the same day edits that day's post instead of sending a new one.
create table report_posts (
  staff_id      bigint not null references report_staff(telegram_user_id) on delete cascade,
  period        text not null check (period in ('daily', 'weekly', 'monthly')),
  period_start  date not null,
  chat_id       bigint not null,
  message_id    bigint,
  sent_at       timestamptz not null default now(),
  primary key (staff_id, period, period_start)
);

do $$
declare t text;
begin
  foreach t in array array['report_staff','work_shifts','work_entries','report_posts'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table report_staff, work_shifts, work_entries, report_posts from anon, authenticated';
  end if;
end $$;
