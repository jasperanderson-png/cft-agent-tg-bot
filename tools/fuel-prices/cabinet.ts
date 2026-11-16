import { env } from '../../core/env.js';

/**
 * Client for the United Fuel customer cabinet (https://cabinet.united-fuel.com, "Stations → List").
 *
 * The cabinet is a web app over a JSON API, so this reads the same API the web page uses instead of
 * driving a browser: sign in with the account's email and password, then page through
 * GET cabinet/station until every station the API reports has been read.
 *
 * Nothing here is ever logged or returned that could expose the password or the access token.
 */

const AUTH_API = 'https://auth.production.united-fuel.com/api/';
const CABINET_API = 'https://cmp-backend.production.united-fuel.com/api/v1/';
const SITE = 'https://cabinet.united-fuel.com';
/** Stations per request. Today one request returns every station (about 2,200). */
export const PAGE_SIZE = 2500;
const TIMEOUT_MS = 25_000;
const MAX_PAGES = 100;

/** One station as the cabinet's station list shows it. Missing values are null, never 0 or "". */
export interface Station {
  id: number;
  station: string;
  /** Prices exactly as the cabinet sends them (US dollars per gallon), not rounded. */
  retailPrice: number | null;
  discountedPrice: number | null;
  /** When the station's price was last updated. */
  updatedAt: Date | null;
  state: string | null;
  city: string | null;
  address: string | null;
  /** The station's name in EFS (often carries the store number drivers know, e.g. "Speedway #4638"). */
  efsName: string | null;
  /** The cabinet's chain, e.g. "PILOT/J", "LOVES", "TA/PETRO", "7Eleven" (Speedway is part of it). */
  chain: string | null;
  /** Highway and exit, e.g. "I-15/I-80, Exit 305". */
  routeExit: string | null;
  /** The cabinet flags this station as broken. */
  broken: boolean;
}

export interface Extraction {
  stations: Station[];
  /** How many stations the cabinet itself reports. */
  siteTotal: number;
  /** Requests it took, and whether a second full read was needed. */
  pagesRead: number;
  reread: boolean;
  /** Same station id returned more than once (kept once). */
  duplicatesDropped: number;
}

export type Stage = { step: 'login' } | { step: 'page'; page: number; pages: number; read: number; total: number } | { step: 'reread'; read: number; total: number };

/** A failure the person pressing the button should be told about, in plain words. */
export class FuelError extends Error {
  constructor(
    public kind: 'config' | 'auth' | 'network' | 'site' | 'incomplete',
    message: string,
  ) {
    super(message);
  }
}

const headers = { accept: 'application/json', 'content-type': 'application/json', origin: SITE, referer: SITE + '/' };

async function call(url: string, init: RequestInit, what: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timeout = (e as Error).name === 'TimeoutError';
    throw new FuelError('network', timeout ? `The fuel cabinet did not answer within ${TIMEOUT_MS / 1000} seconds (${what}).` : `The fuel cabinet could not be reached (${what}).`);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, body };
}

/** Signs in and returns a short-lived access token (it lasts about 10 minutes, enough for one export). */
export async function login(): Promise<string> {
  const email = env.fuelCabinetEmail;
  const password = env.fuelCabinetPassword;
  if (!email || !password) throw new FuelError('config', 'The fuel cabinet login is not set up. Add FUEL_CABINET_EMAIL and FUEL_CABINET_PASSWORD to the deployment settings.');
  const { status, body } = await call(AUTH_API + 'auth/login', { method: 'POST', headers, body: JSON.stringify({ email, password }) }, 'sign-in');
  const data = body?.data as { accessToken?: string; user?: { mustChangePassword?: boolean } } | undefined;
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    throw new FuelError('auth', 'The fuel cabinet did not accept the login. Check FUEL_CABINET_EMAIL and FUEL_CABINET_PASSWORD (the password may have been changed).');
  }
  if (status >= 500 || !data?.accessToken) throw new FuelError('site', `The fuel cabinet sign-in failed (HTTP ${status}). Try again later.`);
  if (data.user?.mustChangePassword) throw new FuelError('auth', 'The fuel cabinet asks for a new password for this account. Change it on the website, then update FUEL_CABINET_PASSWORD.');
  return data.accessToken;
}

interface Page {
  rows: Record<string, unknown>[];
  totalItems: number;
  totalPages: number;
}

async function readPage(token: string, page: number, limit: number): Promise<Page> {
  const url = `${CABINET_API}cabinet/station?${new URLSearchParams({ page: String(page), limit: String(limit) })}`;
  const { status, body } = await call(url, { headers: { ...headers, authorization: 'Bearer ' + token } }, `stations page ${page}`);
  if (status === 401 || status === 403) throw new FuelError('auth', 'The fuel cabinet refused access to the station list for this account.');
  if (status !== 200) throw new FuelError('site', `The fuel cabinet answered HTTP ${status} for stations page ${page}. Try again later.`);
  const p = body?.pagination as { totalItems?: unknown; totalPages?: unknown } | undefined;
  if (!Array.isArray(body?.data) || !Number.isInteger(p?.totalItems) || !Number.isInteger(p?.totalPages)) {
    throw new FuelError('site', `The fuel cabinet sent stations page ${page} in a form this bot does not recognise. The website may have changed.`);
  }
  return { rows: body.data as Record<string, unknown>[], totalItems: p!.totalItems as number, totalPages: p!.totalPages as number };
}

/**
 * Reads every station. The cabinet does not keep a fixed order between requests, so when it takes
 * several pages the result is checked against the site's own total and, if a station went missing
 * between pages, read again in one request. Anything still missing is an error: an incomplete
 * list is never returned.
 */
export async function fetchAllStations(onStage: (s: Stage) => unknown = () => {}, pageSize = PAGE_SIZE): Promise<Extraction> {
  await onStage({ step: 'login' });
  const token = await login();
  const byId = new Map<number, Station>();
  let duplicates = 0;
  const keep = (rows: Record<string, unknown>[]) => {
    for (const raw of rows) {
      const s = toStation(raw);
      if (!s) throw new FuelError('site', 'The fuel cabinet sent a station without an id. The website may have changed.');
      if (byId.has(s.id)) duplicates++;
      else byId.set(s.id, s);
    }
  };

  const first = await readPage(token, 1, pageSize);
  const total = first.totalItems;
  const pages = first.totalPages;
  if (pages > MAX_PAGES) throw new FuelError('site', `The fuel cabinet reports ${pages} pages of stations, more than this bot reads in one go.`);
  keep(first.rows);
  await onStage({ step: 'page', page: 1, pages, read: byId.size, total });
  for (let page = 2; page <= pages; page++) {
    const next = await readPage(token, page, pageSize);
    keep(next.rows);
    await onStage({ step: 'page', page, pages, read: byId.size, total });
  }
  let pagesRead = Math.max(1, pages);
  let reread = false;
  if (byId.size < total && pages > 1) {
    // Rows moved between pages while they were read. Read the whole list in one request instead.
    console.warn(`[fuel] ${byId.size} of ${total} stations after ${pages} pages; reading all at once`);
    reread = true;
    await onStage({ step: 'reread', read: byId.size, total });
    const all = await readPage(token, 1, total);
    keep(all.rows);
    pagesRead++;
  }

  if (total === 0) throw new FuelError('incomplete', 'The fuel cabinet reported no stations at all, so there is nothing reliable to export.');
  if (byId.size !== total) {
    throw new FuelError('incomplete', `Only ${byId.size.toLocaleString('en-US')} of the ${total.toLocaleString('en-US')} stations the cabinet reports could be read.`);
  }
  const stations = [...byId.values()].sort(
    (a, b) => (a.state ?? '~').localeCompare(b.state ?? '~') || (a.city ?? '~').localeCompare(b.city ?? '~') || a.station.localeCompare(b.station) || a.id - b.id,
  );
  return { stations, siteTotal: total, pagesRead, reread, duplicatesDropped: duplicates };
}

/**
 * The station list for the Mini App, reused for up to 10 minutes so opening the app does not sign
 * in to the cabinet every time. The 📥 button and "Send Excel" always read the cabinet fresh.
 */
let cached: { at: Date; x: Extraction } | null = null;
let reading: Promise<{ at: Date; x: Extraction }> | null = null;
export async function recentStations(maxAgeMs = 10 * 60_000, load: () => Promise<Extraction> = () => fetchAllStations()): Promise<{ at: Date; x: Extraction }> {
  if (cached && Date.now() - cached.at.getTime() < maxAgeMs) return cached;
  // Requests that arrive while the cabinet is being read wait for that same read.
  reading ??= load()
    .then((x) => (cached = { at: new Date(), x }))
    .finally(() => {
      reading = null;
    });
  return reading;
}

// ---- Turning the cabinet's record into a row ----------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Text as a person would read it: HTML codes decoded, spaces tidied. Null when empty. */
function text(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v)
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m,
    )
    .replace(/\s+/g, ' ')
    .trim();
  return s || null;
}

/**
 * A price exactly as sent. The cabinet sends most prices as numbers and some (Casey's, among others)
 * as text such as "5.099"; both become the same number, with no rounding. Anything else is missing.
 */
export function price(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

/** "I-15/I-80, Exit 305 &amp;; UT 201" → "I-15/I-80, Exit 305 & UT 201". */
function routeExit(v: unknown): string | null {
  const t = text(v);
  if (!t) return null;
  return t.replace(/\s*&\s*;\s*/g, ' & ').replace(/\s*;\s*/g, ', ').replace(/[\s,&]+$/, '').replace(/\s+/g, ' ').trim() || null;
}

function date(v: unknown): Date | null {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * One cabinet record as a row, using the same fields the cabinet's own Stations → List table shows:
 * the station name from the price file (or its EFS name), the first price entry, the first address.
 */
export function toStation(raw: Record<string, unknown>): Station | null {
  const id = raw.id;
  if (!Number.isSafeInteger(id)) return null;
  const fuel = (Array.isArray(raw.fuelPrices) ? raw.fuelPrices[0] : null) as Record<string, unknown> | null;
  const addr = (Array.isArray(raw.addresses) ? raw.addresses[0] : null) as Record<string, unknown> | null;
  return {
    id: id as number,
    station: text(raw.nameInFile) ?? text(raw.nameInEfs) ?? `Station ${id}`,
    retailPrice: price(fuel?.retailPrice),
    discountedPrice: price(fuel?.discountedPrice),
    updatedAt: date(fuel?.updatedAt),
    state: text(addr?.state),
    city: text(addr?.city),
    address: text(addr?.street),
    efsName: text(raw.nameInEfs),
    chain: text((raw.chain as Record<string, unknown> | null | undefined)?.name),
    routeExit: routeExit(addr?.routeExit),
    broken: raw.isBroken === true,
  };
}
