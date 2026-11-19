export const OPTION_KEYS = ['A', 'B', 'C', 'D'] as const;
export type OptionKey = (typeof OPTION_KEYS)[number];

export interface QuestionOption {
  key: OptionKey;
  text: string;
}

/** What a candidate may see before submitting: no answer key, no explanations. */
export interface PublicQuestion {
  n: number;
  text: string;
  options: QuestionOption[];
}

/** Shown to the candidate only after their attempt is graded. */
export interface ReviewQuestion extends PublicQuestion {
  idx: number;
  correct: OptionKey;
  explanation: string;
  whyCorrect: string;
  why: Partial<Record<OptionKey, string>>;
  basis: string;
  topic: string;
  edited: boolean;
}

/** Admin-only view of a question bank entry. */
export interface BankQuestion extends PublicQuestion {
  id: number;
  correct: OptionKey;
  explanation: string;
  whyCorrect: string;
  why: Partial<Record<OptionKey, string>>;
  basis: string;
  topic: string;
  topicInferred: boolean;
  active: boolean;
  revision: number;
  edited: boolean;
}

export interface Topic {
  id: string;
  name: string;
}

export interface Settings {
  passMark: number;
  minSample: number;
  allowRetakes: boolean;
  /** IANA time zone used for report dates and week boundaries. */
  timezone: string;
}

export type Answers = Partial<Record<number, OptionKey>>;

export interface PublicConfig {
  total: number;
  passMark: number;
  timeLimitMinutes: null;
  allowRetakes: boolean;
  requireTelegram: boolean;
  botUsername: string | null;
}

export interface InProgressAttempt {
  state: 'in_progress';
  attemptId: string;
  token?: string;
  name: string;
  startedAt: string;
  questions: PublicQuestion[];
  answers: Answers;
}

export interface AttemptResult {
  state: 'completed';
  attemptId: string;
  token?: string;
  name: string;
  startedAt: string;
  submittedAt: string;
  correct: number;
  total: number;
  unanswered: number;
  pct: number;
  passMark: number;
  passed: boolean;
  answers: Answers;
  questions: ReviewQuestion[];
  topics: Topic[];
  /** Set when the server returned a result that already existed (duplicate submit or revisit). */
  alreadyCompleted?: boolean;
}

export type AttemptState = InProgressAttempt | AttemptResult;

/** One attempt as the admin dashboard sees it. Answers are included only for graded attempts. */
export interface AdminAttempt {
  id: string;
  candidateId: string;
  name: string;
  channel: 'telegram' | 'web';
  telegramUsername: string | null;
  tokenTail: string;
  status: 'completed' | 'in_progress';
  startedAt: string;
  submittedAt: string | null;
  durationSec: number | null;
  total: number;
  correct: number | null;
  pct: number | null;
  unanswered: number | null;
  passMark: number | null;
  answeredCount: number;
  answers: Answers;
  /** Correctness recorded at grading time, keyed by question number (graded attempts only). */
  correctness: Partial<Record<number, boolean>>;
}

export interface SheetsStatus {
  configured: boolean;
  serviceAccountEmail: string | null;
  connected: boolean;
  url: string | null;
  name: string | null;
  autoSync: boolean;
  rowsSynced: number;
  lastSyncAt: string | null;
}

export interface AdminMe {
  id: string;
  email: string | null;
  name: string | null;
  role: 'owner' | 'admin';
  telegramUserId: number | null;
  notifyResults: boolean;
  weeklyReport: boolean;
}

export interface AdminData {
  questions: BankQuestion[];
  topics: Topic[];
  settings: Settings;
  attempts: AdminAttempt[];
  sheets: SheetsStatus;
  me: AdminMe | null;
}

/** A Telegram account that has used the bot or Mini App, as listed on the admin Users page. */
export interface AdminUser {
  telegramUserId: number;
  name: string | null;
  username: string | null;
  candidateName: string | null;
  startedBot: boolean;
  blockedBot: boolean;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  admin: { id: string; role: 'owner' | 'admin'; name: string | null; since: string; addedBy: string | null } | null;
  attempts: number;
  latest: { id: string; status: 'completed' | 'in_progress'; correct: number | null; total: number; pct: number | null; passed: boolean | null; at: string } | null;
}

export type ReportRange = 'week' | 'last_week' | '30d' | 'all';

export function isOptionKey(v: unknown): v is OptionKey {
  return typeof v === 'string' && (OPTION_KEYS as readonly string[]).includes(v);
}

/* ---------- CFT Hub (the admins' home in the Mini App) ---------- */

/** One fuel station as the Hub's Fuel prices screen shows it. Prices are exact; null means the cabinet has none. */
export interface FuelStationRow {
  id: number;
  station: string;
  retail: number | null;
  discounted: number | null;
  updatedAt: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
}

export interface FuelStations {
  stations: FuelStationRow[];
  /** How many stations the cabinet reports; always equal to stations.length. */
  siteTotal: number;
  /** When the bot read the cabinet (the list is reused for up to 10 minutes). */
  fetchedAt: string;
}

/** The discounts dataset agents search, as admins see it (Fuel discounts data screen). */
export interface DiscountsAdmin {
  settings: { margin: number; showNoPrice: boolean; showBroken: boolean };
  /** The live pull, or null before the first one. */
  dataset: {
    pulledAt: string;
    /** Every station the cabinet reported in that pull. */
    siteTotal: number;
    /** Pilot / Flying J, Love's, TA / Petro and Speedway stations in it. */
    partnerStations: number;
    withDiscount: number;
    /** Partner stations the cabinet has no discounted price for. */
    noPrice: number;
    broken: number;
    /** Partner stations whose discount is no bigger than the margin: hidden from agents. */
    smallDiscount: number;
    states: number;
    byBrand: Record<'pilot' | 'loves' | 'ta' | 'speedway', number>;
  } | null;
}

export interface AgentsList {
  agents: { telegramUserId: number; name: string | null; username: string | null; joinedAt: string; invitedBy: string | null; inviteLabel: string | null; lastSeenAt: string | null }[];
  invites: { id: string; label: string | null; createdAt: string; expiresAt: string; createdBy: string | null; uses: number }[];
}

export interface AgentInvite {
  id: string;
  link: string;
  expiresAt: string;
  label: string | null;
  hours: number;
}

export interface AcademySummary {
  week: { started: number; completed: number; passed: number };
}

export interface LeadsSummary {
  waiting: number;
  today: number;
  total: number;
}

/** A partner station on the drivers' fuel map (tools/driver-map/stations.ts). */
export interface DriverStation {
  id: number;
  station: string;
  /** p Pilot / Flying J, l Love's, t TA / Petro, s Speedway (support/common/driver-route.ts). */
  brand: 'p' | 'l' | 't' | 's';
  retail: number | null;
  /** The driver's price with the CFT discount: the same price agents see (never the cabinet's own price). Null without a discount. */
  discounted: number | null;
  updatedAt: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
  /** From Google geocoding, cached in station_geo. Null until the address has been geocoded. */
  lat: number | null;
  lng: number | null;
}

export interface DriverStations {
  stations: DriverStation[];
  fetchedAt: string;
  /** Stations still waiting for a map point; they show in "By state" but not on the map yet. */
  pendingGeocode: number;
  /** Whether truck routes can be planned (ORS_API_KEY is set on the server). */
  routing: boolean;
  /** Set for drivers: their navigated trips are recorded; `noticeSeen` once they were told so. */
  trips?: { record: true; noticeSeen: boolean } | null;
}

// ---- Driver trips (tools/driver-map/trips.ts; migration 0011) ---------------------------------------

/** A point the phone recorded on a trip: [time in ms, lat, lng, speed m/s or null, accuracy m or null]. */
export type TripPoint = [number, number, number, number | null, number | null];

/** What the map sends when a driver taps Navigate. */
export interface TripStartBody {
  from: { label: string; lat: number; lng: number };
  to: { label: string; lat: number; lng: number };
  stop: { id: number; name: string; brand: string; price: number | null; lat: number; lng: number } | null;
  plannedMi: number;
  plannedS: number;
  source: string | null;
  /** The planned route, simplified: [lng, lat] pairs. */
  path: [number, number][];
  truck: TruckProfile;
  noticeSeen: boolean;
}

/** A batch of the driven track. `seq` makes a batch sent twice count once; `status` marks the stop or the end. */
export interface TripPointsBody {
  seq: number;
  points: TripPoint[];
  status?: 'stop' | 'arrived' | 'ended';
}

export interface TripSummary {
  id: string;
  driverId: number;
  driverName: string | null;
  startedAt: string;
  endedAt: string | null;
  /** driving: still going; stale: still "driving" but nothing heard for 15 min (the app was closed). */
  status: 'driving' | 'stale' | 'arrived' | 'ended';
  fromLabel: string | null;
  toLabel: string | null;
  stop: { name: string; brand: string | null; price: number | null; reachedAt: string | null } | null;
  plannedMi: number | null;
  plannedS: number | null;
  drivenMi: number;
  points: number;
  lastPointAt: string | null;
}

export interface TripDetail extends TripSummary {
  from: { lat: number; lng: number } | null;
  to: { lat: number; lng: number } | null;
  stopAt: { lat: number; lng: number } | null;
  plannedPath: [number, number][];
  track: TripPoint[];
  /** Stretches with no points for over 90 s (the app closed, the phone asleep, no signal). */
  gaps: { from: string; to: string; min: number }[];
  /** Minutes the app was really recording (gaps left out). */
  recordedMin: number;
}

export interface DriverWithTrips {
  telegramUserId: number;
  name: string | null;
  username: string | null;
  joinedAt: string | null;
  invitedBy: string | null;
  /** No longer a driver (removed); their trips are kept as proof. */
  removed: boolean;
  trips: number;
  lastTripAt: string | null;
  drivenMi: number;
}

/** The truck the route is planned for (OpenRouteService "heavy vehicle"). */
export interface TruckProfile {
  /** Height in inches (13'6" = 162). */
  heightIn: number;
  /** Gross weight in pounds. */
  weightLb: number;
  /** Carries hazardous materials. */
  hazmat: boolean;
}

/** One instruction of a route: "Turn right onto Main St", where it starts and the street it is on. */
export interface DriverRouteStep {
  startMi: number;
  endMi: number;
  /** OpenRouteService maneuver type: 0 left, 1 right, 2 sharp left, 3 sharp right, 4 slight left, 5 slight right,
   * 6 straight, 7 roundabout, 8 exit roundabout, 9 U-turn, 10 arrive, 11 depart, 12 keep left, 13 keep right. */
  type: number;
  text: string;
  /** The street this step drives on ("I-80 W"), or "" when it has no name. */
  street: string;
  /** Where the maneuver happens. */
  at: { lat: number; lng: number };
  exit?: number;
}

export interface DriverRoute {
  path: { lat: number; lng: number }[];
  totalMi: number;
  durationS: number;
  steps: DriverRouteStep[];
  /** Where the route really starts and ends (the places typed, found on the map). */
  from: { lat: number; lng: number; label: string };
  to: { lat: number; lng: number; label: string };
  /** Minutes lost to traffic now (TomTom only). */
  delayMin?: number;
  /** Slow stretches on the route, as point indexes into `path` (TomTom only). */
  traffic?: { from: number; to: number; level: 'slow' | 'jam' | 'closed' | 'roadwork'; delayMin: number }[];
  /** Speed limits along the route, as point indexes into `path` (TomTom only). */
  speedLimits?: { from: number; to: number; mph: number }[];
  /** tomtom: truck route with live traffic; ors: OpenRouteService heavy vehicle, no traffic. */
  source?: 'tomtom' | 'ors';
}

/** A place suggestion for the From / To fields. */
export interface DriverPlace {
  label: string;
  lat: number;
  lng: number;
}
