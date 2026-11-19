-- Driver trips: a record of every trip a driver navigates on the route map, kept as proof for 12
-- months. A trip starts when the driver taps Navigate and ends on arrival or End. While the map is
-- open the phone sends where the truck is (a point about every 15 s); when the app is closed or the
-- phone sleeps nothing is recorded, and those gaps show as gaps, never as invented points.
-- Admins only: the Drivers screen in the CFT Hub. Trips stay when a driver is removed (proof).
--
--   driver_trips        one row per trip: who, from / to, the fuel stop and its CFT price at the time,
--                       the planned route (simplified), and what was driven
--   driver_trip_points  the driven track, in batches as the phone sends them; (trip_id, seq) makes a
--                       batch sent twice (a retry) count once
--   map_drivers.trip_notice_at  when the driver was told trips are recorded

create table driver_trips (
  id                uuid primary key default gen_random_uuid(),
  telegram_user_id  bigint not null,
  driver_name       text check (driver_name is null or length(driver_name) <= 80),
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  status            text not null default 'driving' check (status in ('driving', 'arrived', 'ended')),
  from_label        text check (from_label is null or length(from_label) <= 160),
  from_lat          float8,
  from_lng          float8,
  to_label          text check (to_label is null or length(to_label) <= 160),
  to_lat            float8,
  to_lng            float8,
  stop_station_id   bigint,
  stop_name         text check (stop_name is null or length(stop_name) <= 160),
  stop_brand        text,
  stop_price        numeric(8, 3),
  stop_lat          float8,
  stop_lng          float8,
  stop_reached_at   timestamptz,
  planned_mi        float8,
  planned_s         int,
  route_source      text,
  planned_path      jsonb,
  truck             jsonb,
  driven_mi         float8 not null default 0,
  points            int not null default 0,
  last_lat          float8,
  last_lng          float8,
  last_point_at     timestamptz
);
create index driver_trips_driver on driver_trips (telegram_user_id, started_at desc);
create index driver_trips_started on driver_trips (started_at);
alter table driver_trips enable row level security;

create table driver_trip_points (
  trip_id      uuid not null references driver_trips(id) on delete cascade,
  seq          int not null check (seq >= 0),
  points       jsonb not null,
  received_at  timestamptz not null default now(),
  primary key (trip_id, seq)
);
alter table driver_trip_points enable row level security;

alter table map_drivers add column trip_notice_at timestamptz;
