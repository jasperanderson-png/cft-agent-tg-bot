-- Drivers' route map: a map point for each partner station, looked up once (tools/fuel-prices/geocode.ts).
--   key     brand|store number|street|city|state, lower case: a station that changes address is looked up again
--   status  ok; zero_results (no source could place it: no pin, tried again after a week); error (tried again on the next request)
--   source  where the point came from: chain (the chain's own store locator), census (US Census address service),
--           search (OpenRouteService address search)
create table station_geo (
  key          text primary key check (length(key) between 3 and 400),
  lat          double precision,
  lng          double precision,
  status       text not null check (status in ('ok','zero_results','error')),
  source       text check (source in ('chain','census','search')),
  geocoded_at  timestamptz not null default now()
);
alter table station_geo enable row level security;
