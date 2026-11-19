import type { TripPoint, TripPointsBody, TripStartBody } from '../../../../../support/common/types';
import { milesBetween } from '../../../../../support/common/driver-route';
import { driverApi, ApiError } from '../../lib/api';

// Trip history for drivers (server: tools/driver-map/trips.ts). One recorder per navigated trip: it
// tells the server the trip started, keeps a point about every 15 s (sooner after a quarter mile),
// sends them every minute, when the app is hidden or closed, and at the stop and the end. A batch
// that fails is kept and sent again with the same number, so the server never counts it twice.
// Only the real GPS is recorded (never /route?simulate).

const EVERY_MS = 15_000;
const OR_MI = 0.25;
const SEND_MS = 60_000;

export interface TripRecorder {
  point(f: { lat: number; lng: number; speed: number | null; accuracy: number | null }): void;
  stopReached(): void;
  end(status: 'arrived' | 'ended'): void;
}

export function startRecording(body: TripStartBody): TripRecorder {
  const id = driverApi.tripStart(body).then((r) => r.id, () => null);
  let buf: TripPoint[] = [];
  let last: TripPoint | null = null;
  let seq = 0;
  let ended = false;
  let sending = false;
  const queue: TripPointsBody[] = [];

  const drain = async (keepalive = false) => {
    if (sending) return;
    sending = true;
    try {
      const tripId = await id;
      if (!tripId) { queue.length = 0; return; }
      while (queue.length) {
        try {
          await driverApi.tripPoints(tripId, queue[0], keepalive);
          queue.shift();
        } catch (e) {
          // Refused (the trip is gone, or bad data): drop it. No connection: keep it for the next try.
          if (e instanceof ApiError && e.status >= 400 && e.status < 500) queue.shift();
          else break;
        }
      }
    } finally {
      sending = false;
    }
  };
  const flush = (status?: TripPointsBody['status'], keepalive = false) => {
    if (buf.length || status) {
      queue.push({ seq: seq++, points: buf, ...(status ? { status } : {}) });
      buf = [];
    }
    return drain(keepalive);
  };

  const timer = window.setInterval(() => void flush(), SEND_MS);
  const onHide = () => { if (document.visibilityState === 'hidden') void flush(undefined, true); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onHide);

  return {
    point(f) {
      if (ended) return;
      const t = Date.now();
      if (last && t - last[0] < EVERY_MS && milesBetween({ lat: last[1], lng: last[2] }, f) < OR_MI) return;
      last = [t, Math.round(f.lat * 1e6) / 1e6, Math.round(f.lng * 1e6) / 1e6, f.speed != null ? Math.round(f.speed * 10) / 10 : null, f.accuracy != null ? Math.round(f.accuracy) : null];
      buf.push(last);
      if (buf.length >= 200) void flush();
    },
    stopReached() {
      if (!ended) void flush('stop');
    },
    end(status) {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      // One more try a little later for anything a bad connection held back.
      void flush(status).then(() => { if (queue.length) window.setTimeout(() => void drain(), 15_000); });
    },
  };
}
