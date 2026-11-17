// Live location in the bot chat (handlers/live-location.ts): who gets alerts, the "live location on"
// reply, the hint for a plain location, and alerts on each position update. Telegram, the database
// lookup of who is writing and the alert logic itself (tested in tools/driver-map) are stubbed.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db_storage/db.js';

const role = vi.hoisted(() => ({ current: { admin: false, owner: false, agent: false, driver: true } }));
const alert = vi.hoisted(() => ({ text: null as string | null, calls: [] as unknown[][] }));
vi.mock('../handlers/viewer.js', () => ({ viewerOf: async () => ({ ...role.current, updateId: 1 }) }));
vi.mock('../../tools/driver-map/alerts.js', () => ({
  liveLocationAlert: async (...args: unknown[]) => { alert.calls.push(args); return alert.text; },
}));
const { liveLocation } = await import('../handlers/live-location.js');

describe('live location in the bot chat', () => {
  const sent: { chat_id: number; text: string }[] = [];
  const db = {} as Db;
  const from = { id: 700, first_name: 'Dan' };
  const loc = (extra: Record<string, unknown> = {}) => ({ latitude: 40.81, longitude: -96.7, ...extra });
  const start = (extra = {}) => ({ update_id: 1, message: { chat: { id: 700, type: 'private' }, from, location: loc(extra) } });
  const move = (extra = {}) => ({ update_id: 2, edited_message: { chat: { id: 700, type: 'private' }, from, location: loc(extra) } });

  beforeAll(() => {
    process.env.TELEGRAM_BOT_TOKEN = '777000:TEST';
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? '{}'));
      sent.push({ chat_id: b.chat_id, text: b.text });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  afterAll(() => vi.unstubAllGlobals());
  beforeEach(() => {
    sent.length = 0;
    alert.calls.length = 0;
    alert.text = null;
    role.current = { admin: false, owner: false, agent: false, driver: true };
  });

  it('turns alerts on when a driver starts sharing live location', async () => {
    expect(await liveLocation(db, start({ live_period: 3600 }))).toBe(true);
    expect(sent[0].text).toContain('Live location on');
    expect(alert.calls[0][1]).toBe(700); // checked at once too
  });

  it('sends an alert on a position update when a station is ahead, and nothing otherwise', async () => {
    await liveLocation(db, move({ heading: 270 }));
    expect(sent).toHaveLength(0);
    alert.text = '⛽ CFT station ahead: Pilot #11';
    await liveLocation(db, move({ heading: 270 }));
    expect(sent.map((m) => m.text)).toEqual(['⛽ CFT station ahead: Pilot #11']);
    expect(alert.calls.at(-1)![2]).toEqual({ lat: 40.81, lng: -96.7, heading: 270 });
  });

  it('explains how to share live location when a plain location is sent', async () => {
    await liveLocation(db, start());
    expect(sent[0].text).toContain('Share My Live Location');
    expect(alert.calls).toHaveLength(0);
  });

  it('ignores people who may not use the route map, and anything that is not a location', async () => {
    role.current = { admin: false, owner: false, agent: false, driver: false };
    expect(await liveLocation(db, start({ live_period: 3600 }))).toBe(true);
    expect(sent).toHaveLength(0);
    expect(await liveLocation(db, { update_id: 3, message: { chat: { id: 700, type: 'private' }, from, text: 'hi' } })).toBe(false);
    expect(await liveLocation(db, { update_id: 4, edited_message: { chat: { id: 700, type: 'private' }, from, text: 'edited' } })).toBe(false);
  });
});
