-- Indeed applicants: people who applied to our jobs on Indeed. A small script on the US office computer
-- reads the employer account's candidate list (the account stays signed in there) and posts what it
-- sees to /api/indeed/report. The bot posts a card per new applicant to the hiring chat and sends the
-- lead-import Excel file once a day and on request. For hiring only: never mixed into Driver Leads.
-- See tools/indeed-applicants/ and docs/INDEED_APPLICANTS.md.

create table indeed_applicants (
  -- Indeed's id of the application (one person applying to two jobs is two applications).
  submission_id  text primary key check (length(submission_id) between 1 and 120),
  name           text not null check (length(name) <= 120),
  phone          text check (phone is null or phone ~ '^\+1\d{10}$'),
  location       text check (location is null or length(location) <= 120),
  state          text check (state is null or state ~ '^[A-Z]{2}$'),
  job_title      text check (job_title is null or length(job_title) <= 200),
  -- The latest jobs on the applicant's profile: ["Title — Company", …].
  experience     jsonb not null default '[]',
  applied_at     timestamptz,
  received_at    timestamptz not null default now(),
  -- Seen in the first report, before the bot was connected: no card, and not in the next Excel file.
  baseline       boolean not null default false,
  -- The card in the hiring chat (null: not posted yet, or Telegram refused it; it is tried again).
  posted_at      timestamptz,
  -- Included in a lead-import Excel file (daily file or the 📥 button).
  exported_at    timestamptz
);
create index indeed_applicants_unexported on indeed_applicants (received_at) where exported_at is null;
create index indeed_applicants_unposted on indeed_applicants (received_at) where posted_at is null;
alter table indeed_applicants enable row level security;

-- The office script's last report: when it last reported and what it said, and the problem the chat
-- was last told about (so each problem is announced once, and its end once).
create table indeed_collector (
  id             int primary key default 1 check (id = 1),
  last_seen_at   timestamptz,
  last_ok_at     timestamptz,
  last_status    text,
  last_detail    text check (last_detail is null or length(last_detail) <= 300),
  alert          text
);
insert into indeed_collector (id) values (1);
alter table indeed_collector enable row level security;
