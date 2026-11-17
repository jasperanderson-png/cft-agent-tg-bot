import type { AcademySummary, AdminData, AdminMe, AdminUser, AgentInvite, AgentsList, AttemptResult, AttemptState, BankQuestion, DiscountsAdmin, FuelStations, LeadsSummary, PublicConfig, ReportRange, Settings, SheetsStatus, DriverPlace, DriverRoute, DriverStations, TruckProfile, DriverWithTrips, TripDetail, TripPointsBody, TripStartBody, TripSummary } from '../../../../shared/types';
import type { AgentDiscounts, PartnerBrand } from '../../../../shared/discounts';
import { initData } from './telegram';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public data?: Record<string, unknown>) {
    super(message);
  }
  get isNetwork() {
    return this.status === 0;
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api/' + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ApiError(0, "We couldn't reach the server. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status}).`, data.code, data);
  return data as T;
}

const att = (token: string) => ({ 'x-attempt-token': token });

export const candidateApi = {
  config: () => request<PublicConfig>('GET', 'config'),
  session: (initData: string) =>
    request<AttemptState | { state: 'none'; suggestedName: string; isAdmin: boolean }>('POST', 'session', { initData }),
  start: (name: string, initData: string) => request<AttemptState>('POST', 'attempts', { name, initData: initData || undefined }),
  get: (id: string, token: string) => request<AttemptState>('GET', `attempts/${id}`, undefined, att(token)),
  save: (id: string, token: string, answers: Record<number, string>) => request<{ saved: number }>('PUT', `attempts/${id}/answers`, { answers }, att(token)),
  submit: (id: string, token: string, answers: Record<number, string>) => request<AttemptResult>('POST', `attempts/${id}/submit`, { answers }, att(token)),
};

let adminToken = '';
try {
  adminToken = sessionStorage.getItem('cft_admin') ?? '';
} catch {
  /* storage blocked */
}
export function setAdminToken(t: string) {
  adminToken = t;
  try {
    if (t) sessionStorage.setItem('cft_admin', t);
    else sessionStorage.removeItem('cft_admin');
  } catch {
    /* storage blocked */
  }
}
export const hasAdminToken = () => !!adminToken;
/** A call only signed-in admins may make. */
const authed = <T>(method: string, path: string, body?: unknown) => request<T>(method, path, body, { authorization: 'Bearer ' + adminToken });
const adm = <T>(method: string, path: string, body?: unknown) => authed<T>(method, 'admin/' + path, body);

type Session = { token: string; email: string; expiresAt: string };
export const adminApi = {
  login: (email: string, password: string) => request<Session>('POST', 'admin/login', { email, password }),
  telegramLogin: (initData: string) => request<Session>('POST', 'admin/telegram-login', { initData }),
  logout: () => adm<{ ok: true }>('POST', 'logout', {}),
  me: () => adm<AdminMe>('GET', 'me'),
  savePrefs: (p: { notifyResults: boolean; weeklyReport: boolean }) => adm<AdminMe>('PUT', 'me', p),
  users: () => adm<AdminUser[]>('GET', 'users'),
  addAdmin: (telegramUserId: string, name: string) => adm<{ ok: true; id: string }>('POST', 'admins', { telegramUserId, name }),
  removeAdmin: (id: string) => adm<{ ok: true }>('DELETE', `admins/${id}`),
  reportDownload: (range: ReportRange) => adm<{ path: string; filename: string }>('POST', 'reports', { range, deliver: 'download' }),
  reportToTelegram: (range: ReportRange) => adm<{ sent: true }>('POST', 'reports', { range, deliver: 'telegram' }),
  sendWeekly: () => adm<{ sent: number; skipped?: string }>('POST', 'weekly/send', {}),
  data: () => adm<AdminData>('GET', 'data'),
  attempt: (id: string) => adm<AttemptResult>('GET', `attempts/${id}`),
  saveQuestion: (q: BankQuestion) => adm<BankQuestion>('PUT', `questions/${q.id}`, q),
  saveSettings: (s: Settings) => adm<Settings>('PUT', 'settings', s),
  exportFile: (filename: string, content: string) => adm<{ path: string }>('POST', 'exports', { filename, content }),
  sheetsLink: (url: string) => adm<SheetsStatus>('POST', 'sheets/link', { url }),
  sheetsCreate: () => adm<SheetsStatus>('POST', 'sheets/create', {}),
  sheetsSync: () => adm<SheetsStatus>('POST', 'sheets/sync', {}),
  sheetsAuto: (on: boolean) => adm<SheetsStatus>('PUT', 'sheets/auto', { on }),
  sheetsDisconnect: () => adm<SheetsStatus>('DELETE', 'sheets'),
};

/** The CFT Hub: each product's summary and the Fuel prices screen. Admins only. */
export const hubApi = {
  academy: () => authed<AcademySummary>('GET', 'academy/summary'),
  leads: () => authed<LeadsSummary>('GET', 'leads/summary'),
  fuelStations: () => authed<FuelStations>('GET', 'fuel/stations'),
  fuelSend: () => authed<{ sent: true; stations: number }>('POST', 'fuel/send', {}),
};


/** Team & access and the Fuel discounts data screen. Admins only. */
export const teamApi = {
  agents: () => authed<AgentsList>('GET', 'admin/agents'),
  invite: (hours: number, label: string) => authed<AgentInvite>('POST', 'admin/agents/invites', { hours, label }),
  revokeInvite: (id: string) => authed<{ ok: true }>('DELETE', `admin/agents/invites/${id}`),
  removeAgent: (telegramUserId: number) => authed<{ ok: true }>('DELETE', `admin/agents/${telegramUserId}`),
  users: () => authed<AdminUser[]>('GET', 'admin/users'),
  discounts: () => authed<DiscountsAdmin>('GET', 'admin/discounts'),
  saveDiscounts: (s: DiscountsAdmin['settings']) => authed<DiscountsAdmin>('PUT', 'admin/discounts/settings', s),
  refreshDiscounts: () => authed<DiscountsAdmin>('POST', 'admin/discounts/refresh', {}),
};

/** Drivers and their trip history. Admins only. */
export const driversApi = {
  list: () => authed<{ drivers: DriverWithTrips[] }>('GET', 'admin/drivers'),
  trips: (telegramUserId: number) => authed<{ trips: TripSummary[] }>('GET', `admin/drivers/${telegramUserId}/trips`),
  trip: (id: string) => authed<TripDetail>('GET', `admin/trips/${id}`),
  sendTrip: (id: string) => authed<{ sent: true }>('POST', `admin/trips/${id}/send`, {}),
};

/** Find discounts, for agents (and admins). Signed in by Telegram's initData on every call. */
const viewer = <T>(method: string, path: string, body?: unknown) => request<T>(method, path, body, { 'x-telegram-init-data': initData });
type Picks = { states: string[]; brands: PartnerBrand[] };
/** The drivers' fuel map (/route). Signed in like Find discounts. */
export const driverApi = {
  stations: () => viewer<DriverStations>('GET', 'driver/stations'),
  /** Looks up map points for stations that have none yet (in the background). */
  locate: () => viewer<{ placed: number; pending: number }>('POST', 'driver/locate'),
  /** A truck route. Places are points (a picked suggestion, the GPS fix) or typed text. */
  route: (b: { from: unknown; to: unknown; via?: { lat: number; lng: number }; truck: TruckProfile }) => viewer<DriverRoute>('POST', 'driver/route', b),
  places: (q: string, near: { lat: number; lng: number } | null) =>
    viewer<{ places: DriverPlace[] }>('GET', `driver/places?q=${encodeURIComponent(q)}${near ? `&lat=${near.lat.toFixed(4)}&lng=${near.lng.toFixed(4)}` : ''}`),
  /** Trip history: a driver starts navigating (others get id null: nothing is recorded). */
  tripStart: (b: TripStartBody) => viewer<{ id: string | null }>('POST', 'driver/trips', b),
  /**
   * A batch of the driven track. `keepalive`: the page is being hidden or closed, so the browser
   * finishes the call even after the page is gone.
   */
  tripPoints: async (id: string, b: TripPointsBody, keepalive = false): Promise<void> => {
    if (!keepalive) { await viewer<{ saved: number }>('POST', `driver/trips/${id}/points`, b); return; }
    const res = await fetch(`/api/driver/trips/${id}/points`, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', 'x-telegram-init-data': initData }, body: JSON.stringify(b) });
    if (!res.ok) throw new ApiError(res.status, `Trip points not saved (${res.status}).`);
  },
};

export const discountsApi = {
  load: () => viewer<AgentDiscounts>('GET', 'discounts'),
  sendList: (p: Picks) => viewer<{ sent: number }>('POST', 'discounts/send', p),
  sendStation: (id: number) => viewer<{ sent: number }>('POST', 'discounts/send-station', { id }),
  excel: (p: Picks) => viewer<{ sent: number }>('POST', 'discounts/excel', p),
};
