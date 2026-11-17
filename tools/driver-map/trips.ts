import type { DriverWithTrips, TripDetail, TripPoint, TripSummary } from '../../shared/types.js';
import { milesBetween } from '../../shared/driver-route.js';
import { HttpError, UUID_RE } from '../../core/http.js';
import { botSendDocument } from '../../core/telegram.js';
import { tx, type Db } from '../../db_storage/db.js';
import { truckOf } from './routing.js';

// Trip history (migration 0011): every trip a driver navigates on the route map, kept 12 months as
// proof. The map sends the start (from, to, the fuel stop and its CFT price, the planned route), then
// the driven track in batches (a point about every 15 s while the map is open), then the stop and
// the end. Nothing is recorded while the app is closed: those stretches are reported as gaps, never
// filled in. Only drivers' trips are recorded (not admins' or agents' test drives). Admins read them.

const KEEP_MONTHS = 12;
/** A pause longer than this between two points is a gap: no driving is counted across it. */
const GAP_S = 90;
/** A trip still "driving" with nothing heard for this long: the app was closed. */
const STALE_MIN = 15;
const MAX_BATCH = 400;
const MAX_PATH = 1500;

const num = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};
const text = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) || null : null);
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const place = (v: unknown) => {
  const p = obj(v);
  return { label: text(p.label, 160), lat: num(p.lat, -90, 90), lng: num(p.lng, -180, 180) };
};

/** Records that a driver started navigating. Returns the trip's id for the points that follow. */
export async function startTrip(db: Db, driver: { id: number; name: string | null }, body: Record<string, unknown>): Promise<{ id: string }> {
  // Older than 12 months: gone (cheap, indexed; run on each start instead of a separate job).
  await db.query('delete from driver_trips where started_at < now() - make_interval(months => $1)', [KEEP_MONTHS]);
  const from = place(body.from);
  const to = place(body.to);
  if (to.lat == null || to.lng == null) throw new HttpError(400, 'A trip needs a destination.');
  const s = body.stop ? obj(body.stop) : null;
  const stop = s && num(s.lat, -90, 90) != null && num(s.lng, -180, 180) != null
    ? { id: num(s.id, 0, 1e12), name: text(s.name, 160), brand: text(s.brand, 8), price: num(s.price, 0, 100), lat: s.lat as number, lng: s.lng as number }
    : null;
  const path = (Array.isArray(body.path) ? body.path : [])
    .filter((p): p is [number, number] => Array.isArray(p) && num(p[0], -180, 180) != null && num(p[1], -90, 90) != null)
    .slice(0, MAX_PATH)
    .map(([lng, lat]) => [Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
  const { rows } = await db.query(
    `insert into driver_trips (telegram_user_id, driver_name, from_label, from_lat, from_lng, to_label, to_lat, to_lng,
        stop_station_id, stop_name, stop_brand, stop_price, stop_lat, stop_lng, planned_mi, planned_s, route_source, planned_path, truck)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) returning id`,
    [
      driver.id, driver.name?.slice(0, 80) ?? null, from.label, from.lat, from.lng, to.label, to.lat, to.lng,
      stop?.id ?? null, stop?.name ?? null, stop?.brand ?? null, stop?.price ?? null, stop?.lat ?? null, stop?.lng ?? null,
      num(body.plannedMi, 0, 10_000), Math.round(num(body.plannedS, 0, 1e7) ?? 0) || null, text(body.source, 20),
      JSON.stringify(path), JSON.stringify(truckOf(body.truck)),
    ],
  );
  if (body.noticeSeen === true) await db.query('update map_drivers set trip_notice_at = coalesce(trip_notice_at, now()) where telegram_user_id = $1', [driver.id]);
  return { id: rows[0].id as string };
}

/** Whether the driver was already told that trips are recorded. */
export async function tripNoticeSeen(db: Db, driverId: number): Promise<boolean> {
  const { rows } = await db.query('select trip_notice_at from map_drivers where telegram_user_id = $1', [driverId]);
  return !!rows[0]?.trip_notice_at;
}

/** Clean points, oldest first, with phone times kept within the trip (a wrong phone clock is clamped). */
function cleanPoints(raw: unknown, startedAt: number): TripPoint[] {
  const now = Date.now();
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_BATCH).flatMap((p): TripPoint[] => {
    if (!Array.isArray(p)) return [];
    const t = num(p[0], 0, 1e14), lat = num(p[1], -90, 90), lng = num(p[2], -180, 180);
    if (t == null || lat == null || lng == null) return [];
    return [[Math.round(Math.min(now + 60_000, Math.max(startedAt - 60_000, t))), lat, lng, num(p[3], 0, 100), num(p[4], 0, 100_000)]];
  }).sort((a, b) => a[0] - b[0]);
}

/** Adds a batch of the driven track, and marks the stop reached or the trip ended. */
export async function addTripPoints(driverId: number, tripId: string, body: Record<string, unknown>): Promise<{ saved: number }> {
  if (!UUID_RE.test(tripId)) throw new HttpError(404, 'Trip not found.');
  const seq = num(body.seq, 0, 1e6);
  const status = ['stop', 'arrived', 'ended'].includes(String(body.status)) ? (body.status as 'stop' | 'arrived' | 'ended') : null;
  return tx(async (c) => {
    const { rows } = await c.query(
      'select status, started_at, last_lat, last_lng, last_point_at from driver_trips where id = $1 and telegram_user_id = $2 for update',
      [tripId, driverId],
    );
    const trip = rows[0];
    if (!trip) throw new HttpError(404, 'Trip not found.');
    const pts = cleanPoints(body.points, (trip.started_at as Date).getTime());
    let saved = 0;
    if (pts.length && seq != null) {
      const ins = await c.query('insert into driver_trip_points (trip_id, seq, points) values ($1, $2, $3) on conflict do nothing', [tripId, Math.floor(seq), JSON.stringify(pts)]);
      if (ins.rowCount) {
        saved = pts.length;
        // Miles only between points close in time: across a gap nobody knows the way driven.
        let prev = trip.last_point_at ? { t: (trip.last_point_at as Date).getTime(), lat: trip.last_lat as number, lng: trip.last_lng as number } : null;
        let mi = 0;
        for (const [t, lat, lng] of pts) {
          if (prev && t >= prev.t && t - prev.t <= GAP_S * 1000) mi += milesBetween(prev, { lat, lng });
          if (!prev || t >= prev.t) prev = { t, lat, lng };
        }
        await c.query(
          `update driver_trips set driven_mi = driven_mi + $2, points = points + $3,
              last_lat = $4, last_lng = $5, last_point_at = greatest(last_point_at, to_timestamp($6 / 1000.0))
            where id = $1`,
          [tripId, mi, pts.length, prev!.lat, prev!.lng, prev!.t],
        );
      }
    }
    if (status === 'stop') await c.query('update driver_trips set stop_reached_at = coalesce(stop_reached_at, now()) where id = $1', [tripId]);
    else if (status && trip.status === 'driving') await c.query('update driver_trips set status = $2, ended_at = now() where id = $1', [tripId, status]);
    return { saved };
  });
}

// ---- For admins ----------------------------------------------------------------------------------

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function summary(r: Record<string, any>): TripSummary {
  const last = (r.last_point_at as Date | null) ?? (r.started_at as Date);
  const stale = r.status === 'driving' && Date.now() - last.getTime() > STALE_MIN * 60_000;
  return {
    id: r.id, driverId: Number(r.telegram_user_id), driverName: r.driver_name, startedAt: iso(r.started_at)!, endedAt: iso(r.ended_at),
    status: stale ? 'stale' : r.status, fromLabel: r.from_label, toLabel: r.to_label,
    stop: r.stop_name ? { name: r.stop_name, brand: r.stop_brand, price: r.stop_price != null ? Number(r.stop_price) : null, reachedAt: iso(r.stop_reached_at) } : null,
    plannedMi: r.planned_mi, plannedS: r.planned_s, drivenMi: Math.round(Number(r.driven_mi) * 10) / 10, points: r.points, lastPointAt: iso(r.last_point_at),
  };
}
const SUMMARY_COLS = `id, telegram_user_id, driver_name, started_at, ended_at, status, from_label, to_label, stop_name, stop_brand, stop_price,
  stop_reached_at, planned_mi, planned_s, driven_mi, points, last_point_at`;

/** Every driver (and every removed driver with trips), with their trip counts. */
export async function adminDrivers(db: Db): Promise<{ drivers: DriverWithTrips[] }> {
  const { rows } = await db.query(
    `with t as (select telegram_user_id, count(*)::int as trips, max(started_at) as last_trip, sum(driven_mi) as mi, max(driver_name) as name
                  from driver_trips group by telegram_user_id)
     select coalesce(d.telegram_user_id, t.telegram_user_id) as id,
            coalesce(nullif(trim(concat_ws(' ', tu.first_name, tu.last_name)), ''), d.name, t.name) as name,
            coalesce(tu.username, d.username) as username, d.joined_at, coalesce(ad.name, ag.name) as invited_by,
            d.telegram_user_id is null as removed, coalesce(t.trips, 0) as trips, t.last_trip, coalesce(t.mi, 0) as mi
       from map_drivers d
       full join t on t.telegram_user_id = d.telegram_user_id
       left join telegram_users tu on tu.id = coalesce(d.telegram_user_id, t.telegram_user_id)
       left join driver_invites i on i.id = d.invite_id
       left join admins ad on ad.id = i.created_by_admin
       left join agents ag on ag.telegram_user_id = i.created_by_agent
      order by t.last_trip desc nulls last, d.joined_at desc nulls last`,
  );
  return {
    drivers: rows.map((r) => ({
      telegramUserId: Number(r.id), name: r.name, username: r.username, joinedAt: iso(r.joined_at), invitedBy: r.invited_by,
      removed: r.removed, trips: r.trips, lastTripAt: iso(r.last_trip), drivenMi: Math.round(Number(r.mi)),
    })),
  };
}

/** One driver's trips, newest first (the last 200). */
export async function adminTrips(db: Db, driverId: number): Promise<{ trips: TripSummary[] }> {
  if (!Number.isSafeInteger(driverId)) throw new HttpError(400, 'Which driver?');
  const { rows } = await db.query(`select ${SUMMARY_COLS} from driver_trips where telegram_user_id = $1 order by started_at desc limit 200`, [driverId]);
  return { trips: rows.map(summary) };
}

/** One trip with its planned route, the driven track and the gaps in it. */
export async function adminTrip(db: Db, id: string): Promise<TripDetail> {
  if (!UUID_RE.test(id)) throw new HttpError(404, 'Trip not found.');
  const { rows } = await db.query(`select ${SUMMARY_COLS}, from_lat, from_lng, to_lat, to_lng, stop_lat, stop_lng, planned_path from driver_trips where id = $1`, [id]);
  const r = rows[0];
  if (!r) throw new HttpError(404, 'Trip not found.');
  const { rows: batches } = await db.query('select points from driver_trip_points where trip_id = $1 order by seq', [id]);
  const track = (batches.flatMap((b) => b.points) as TripPoint[]).sort((a, b) => a[0] - b[0]);
  const gaps: TripDetail['gaps'] = [];
  let recordedMs = 0;
  for (let i = 1; i < track.length; i++) {
    const dt = track[i][0] - track[i - 1][0];
    if (dt > GAP_S * 1000) gaps.push({ from: new Date(track[i - 1][0]).toISOString(), to: new Date(track[i][0]).toISOString(), min: Math.round(dt / 60_000) });
    else recordedMs += dt;
  }
  const at = (lat: number | null, lng: number | null) => (lat != null && lng != null ? { lat, lng } : null);
  return {
    ...summary(r), from: at(r.from_lat, r.from_lng), to: at(r.to_lat, r.to_lng), stopAt: at(r.stop_lat, r.stop_lng),
    plannedPath: r.planned_path ?? [], track, gaps, recordedMin: Math.round(recordedMs / 60_000),
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // Quote, and keep spreadsheet programs from running a cell as a formula.
  return /[",\n\r]|^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
};

/** The trip as a CSV file (trip details, then every recorded point) in the admin's chat with the bot. */
export async function sendTripFile(db: Db, chatId: number | null, id: string): Promise<{ sent: true }> {
  if (!chatId) throw new HttpError(400, 'Your admin account has no Telegram chat to send the file to.');
  const t = await adminTrip(db, id);
  const lines: unknown[][] = [
    ['CFT driver trip', t.id],
    ['Driver', t.driverName ?? '', 'Telegram ID', t.driverId],
    ['Started (UTC)', t.startedAt, 'Ended (UTC)', t.endedAt ?? '', 'Status', t.status],
    ['From', t.fromLabel ?? '', 'To', t.toLabel ?? ''],
    ['Fuel stop', t.stop?.name ?? '', 'CFT price', t.stop?.price ?? '', 'Reached (UTC)', t.stop?.reachedAt ?? ''],
    ['Planned miles', t.plannedMi != null ? Math.round(t.plannedMi * 10) / 10 : '', 'Driven miles (recorded)', t.drivenMi, 'Recorded minutes', t.recordedMin],
    ['Gaps (app closed or no signal)', t.gaps.length, ...t.gaps.map((g) => `${g.from} → ${g.to} (${g.min} min)`)],
    [],
    ['Time (UTC)', 'Latitude', 'Longitude', 'Speed (mph)', 'Accuracy (ft)', 'Gap before (min)'],
    ...t.track.map((p, i) => {
      const dt = i ? p[0] - t.track[i - 1][0] : 0;
      return [new Date(p[0]).toISOString(), p[1].toFixed(6), p[2].toFixed(6), p[3] != null ? Math.round(p[3] * 2.23694) : '', p[4] != null ? Math.round(p[4] * 3.28084) : '', dt > GAP_S * 1000 ? Math.round(dt / 60_000) : ''];
    }),
  ];
  const csv = '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n');
  const day = t.startedAt.slice(0, 10);
  const who = (t.driverName ?? String(t.driverId)).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'driver';
  await botSendDocument(chatId, `trip-${who}-${day}.csv`, new TextEncoder().encode(csv), `🚚 Trip of <b>${(t.driverName ?? 'driver').replace(/[<>&]/g, '')}</b>: ${t.track.length} points, ${t.drivenMi} mi recorded, ${t.gaps.length} gap${t.gaps.length === 1 ? '' : 's'}.`, { contentType: 'text/csv' });
  return { sent: true };
}
