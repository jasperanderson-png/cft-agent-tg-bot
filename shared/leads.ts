/**
 * Driver leads: the field vocabulary plus validation and normalisation shared by every ingestion path
 * (registration page, vendor webhooks, CSV imports, pull connectors). Pure functions, no I/O.
 */

export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};
const STATE_BY_NAME = new Map(Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]));

export const CDL_CLASSES = ['A', 'B', 'C'] as const;
export type CdlClass = (typeof CDL_CLASSES)[number];

export const DRIVER_TYPES: Record<string, string> = {
  otr: 'OTR', regional: 'Regional', local: 'Local', owner_operator: 'Owner-operator', company: 'Company driver',
  team: 'Team', lease_purchase: 'Lease purchase', new_graduate: 'New CDL graduate',
};
export const EQUIPMENT: Record<string, string> = {
  dry_van: 'Dry van', reefer: 'Reefer', flatbed: 'Flatbed', tanker: 'Tanker', step_deck: 'Step deck', car_hauler: 'Car hauler',
  box_truck: 'Box truck', dump: 'Dump', intermodal: 'Intermodal', hotshot: 'Hotshot', power_only: 'Power only',
};
export const ENDORSEMENTS: Record<string, string> = { H: 'Hazmat', N: 'Tanker', P: 'Passenger', S: 'School bus', T: 'Doubles/Triples', X: 'Hazmat + Tanker' };

const DRIVER_TYPE_RULES: [RegExp, string][] = [
  [/\botr\b|over[\s-]*the[\s-]*road|long[\s-]*haul/i, 'otr'],
  [/\bregional\b/i, 'regional'],
  [/\blocal\b/i, 'local'],
  [/owner[\s/_-]*op|\bo\/o\b/i, 'owner_operator'],
  [/\bcompany\b/i, 'company'],
  [/\bteam\b/i, 'team'],
  [/\blease\b/i, 'lease_purchase'],
  [/(new|recent)[\s_-]*(cdl[\s_-]*)?grad|\bstudent\b|\btrainee\b/i, 'new_graduate'],
];
const EQUIPMENT_RULES: [RegExp, string][] = [
  [/dry[\s_-]*van/i, 'dry_van'],
  [/reefer|refrigerat/i, 'reefer'],
  [/flat[\s_-]*bed/i, 'flatbed'],
  [/\btank(er)?s?\b/i, 'tanker'],
  [/step[\s_-]*deck/i, 'step_deck'],
  [/(car|auto)[\s_-]*haul/i, 'car_hauler'],
  [/(box|straight)[\s_-]*truck/i, 'box_truck'],
  [/\bdump\b/i, 'dump'],
  [/intermodal|container|drayage/i, 'intermodal'],
  [/hot[\s_-]*shot/i, 'hotshot'],
  [/power[\s_-]*only/i, 'power_only'],
];
/** Endorsements are written as words or as CDL letter codes; `codes` below reads the letters. */
const ENDORSEMENT_RULES: [RegExp, string][] = [
  [/haz[\s-]*mat|hazardous/i, 'H'],
  [/tank/i, 'N'],
  [/passenger/i, 'P'],
  [/school/i, 'S'],
  [/double|triple/i, 'T'],
];

export interface NormalizedLead {
  full_name: string;
  phone: string | null; // E.164, +1XXXXXXXXXX
  email: string | null; // lower case
  state: string | null;
  city: string | null;
  zip: string | null;
  cdl_class: CdlClass | null;
  years_experience: number | null;
  endorsements: string[];
  driver_types: string[];
  equipment: string[];
  employment_preferences: string | null;
  availability: string | null;
  company_name: string | null;
  usdot_number: string | null;
  /** How many trucks (power units) the driver or carrier runs. */
  trucks: number | null;
  source_record_id: string | null;
  /** What the record says about consent: true, false, or null when it says nothing. */
  consent: boolean | null;
  consent_at: string | null;
  consent_text: string | null;
  consent_proof: string | null;
  /** false when the provider marks the contact as not verified yet. */
  verified: boolean | null;
  /** The record is a do-not-contact request, not a lead. */
  opt_out: boolean;
}

export type NormalizeResult = { ok: true; lead: NormalizedLead } | { ok: false; reason: string };

const clean = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined || typeof v === 'object') return null;
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/[\u0000-\u001F\u007F<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());

/** A person's name, tidied. All-caps or all-lowercase input is title-cased. Null when it isn't a name. */
export function normalizePersonName(v: unknown): string | null {
  const s = clean(v, 80);
  if (!s || s.length < 2 || !/\p{L}{2}/u.test(s) || /https?:|www\.|@/i.test(s)) return null;
  return s === s.toUpperCase() || s === s.toLowerCase() ? titleCase(s) : s;
}

/** US phone number as +1XXXXXXXXXX, or null when it can't be a real NANP number. */
export function normalizePhone(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  let d = String(v).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10 || !/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return null;
  if (/^(\d)\1{9}$/.test(d) || d[1] === d[2] && d[1] === '1') return null; // 2222222222, N11 area codes
  if (d.slice(3, 6) === '555' && d.slice(6, 8) === '01') return null; // 555-01xx is reserved for fiction
  return '+1' + d;
}

export const formatPhone = (e164: string | null): string => {
  const m = e164 && /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : '';
};

const JUNK_EMAIL_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'test.com', 'testing.com', 'mailinator.com', 'noemail.com', 'none.com']);

export function normalizeEmail(v: unknown): string | null {
  const s = clean(v, 254)?.toLowerCase() ?? null;
  if (!s || !/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(s)) return null;
  return JUNK_EMAIL_DOMAINS.has(s.split('@')[1]) ? null : s;
}

/** USPS code from a code or a full state name. */
export function normalizeState(v: unknown): string | null {
  const s = clean(v, 40);
  if (!s) return null;
  const up = s.toUpperCase();
  return US_STATES[up] ? up : STATE_BY_NAME.get(s.toLowerCase()) ?? null;
}

export function normalizeZip(v: unknown): string | null {
  const m = /^\s*(\d{5})(?:-?\d{4})?\s*$/.exec(String(v ?? ''));
  return m && m[1] !== '00000' ? m[1] : null;
}

export function normalizeCdlClass(v: unknown): CdlClass | null {
  const s = clean(v, 40)?.toUpperCase();
  if (!s) return null;
  const m = /^([ABC])$/.exec(s) ?? /\b(?:CLASS|CDL)[\s:_-]*([ABC])\b/.exec(s) ?? /\b([ABC])[\s_-]*(?:CDL|CLASS)\b/.exec(s);
  return m ? (m[1] as CdlClass) : null;
}

/**
 * Years of experience from "5", "5+ years", "2-5 yrs" (the lower bound), "18 months",
 * "10 years, 6 months", "less than 1 year", "none". "Under 5 years" has no usable number: null.
 */
export function normalizeYears(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v <= 70 ? Math.round(v * 10) / 10 : null;
  const upTo = /<|less than|fewer than|under|below/i.test(String(v ?? '')); // read before clean() drops "<"
  const s = clean(v, 60)?.toLowerCase();
  if (!s) return null;
  if (/^(none|no experience|0)$/.test(s)) return 0;
  const months = /(\d+(?:\.\d+)?)\s*(?:months?|mos?)\b/.exec(s);
  const years = /(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\b/.exec(s);
  const first = /\d+(?:\.\d+)?/.exec(s);
  if (!first) return null;
  let n = months ? (years ? Number(years[1]) : 0) + Number(months[1]) / 12 : Number(first[0]);
  if (upTo) {
    if (n > 1) return null;
    n = 0;
  }
  return n >= 0 && n <= 70 ? Math.round(n * 10) / 10 : null;
}

/** The vocabulary ids a free-text or list value mentions. `codes` also accepts stand-alone letter codes ("H, N"). */
function tokens(v: unknown, rules: [RegExp, string][], codes = ''): string[] {
  const s = (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').join(', ') : clean(v, 400))?.replace(/\bn\s*\/\s*a\b/gi, ' ');
  if (!s) return [];
  // A letter counts only as a whole word of its own, so "N/A", "don't" and "driver's" are not endorsements.
  const letters = s.split(/[^A-Za-z']+/).filter((t) => t.length === 1 && codes.includes(t.toUpperCase())).map((t) => t.toUpperCase());
  return [...new Set([...rules.filter(([re]) => re.test(s)).map(([, id]) => id), ...letters])].sort();
}

export function normalizeBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  const s = clean(v, 20)?.toLowerCase();
  if (!s) return null;
  if (['true', 'yes', 'y', '1', 'on', 'granted', 'opt-in', 'optin', 'opted in'].includes(s)) return true;
  if (['false', 'no', 'n', '0', 'off', 'denied', 'none'].includes(s)) return false;
  return null;
}

/** A number of trucks from 3, "3" or "3 trucks". Null for anything that is not a whole number up to 9,999. */
export function normalizeTrucks(v: unknown): number | null {
  const m = /^(\d{1,4})(?:\s*(?:trucks?|power\s*units?|units?))?$/i.exec(clean(v, 40) ?? '');
  return m ? Number(m[1]) : null;
}

function normalizeTimestamp(v: unknown): string | null {
  const s = clean(v, 40);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) && t > Date.UTC(2000, 0, 1) && t < Date.now() + 86_400_000 ? new Date(t).toISOString() : null;
}

/** Field names providers use, keyed by the name with everything but letters and digits removed. */
const ALIASES = {
  name: ['fullname', 'name', 'drivername', 'contactname', 'applicantname'],
  first: ['firstname', 'fname', 'first', 'givenname'],
  last: ['lastname', 'lname', 'last', 'surname', 'familyname'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilephone', 'cell', 'cellphone', 'primaryphone', 'telephone', 'tel'],
  email: ['email', 'emailaddress', 'mail'],
  state: ['state', 'st', 'statecode', 'region', 'province'],
  city: ['city', 'town'],
  zip: ['zip', 'zipcode', 'postalcode', 'postal', 'postcode'],
  cdl: ['cdlclass', 'cdl', 'licenseclass', 'cdltype', 'class', 'license'],
  years: ['yearsexperience', 'yearsofexperience', 'yearsdrivingexperience', 'experience', 'experienceyears', 'drivingexperience', 'exp'],
  endorsements: ['endorsements', 'endorsement', 'cdlendorsements'],
  types: ['drivertype', 'drivertypes', 'type', 'position', 'jobtype', 'routetype', 'haultype'],
  equipment: ['equipment', 'equipmentexperience', 'equipmenttype', 'trailertype', 'trailer', 'freighttype'],
  prefs: ['employmentpreferences', 'preferences', 'jobpreferences', 'preference', 'lookingfor', 'notes', 'comments'],
  availability: ['availability', 'available', 'availabledate', 'startdate', 'canstart'],
  company: ['companyname', 'company', 'legalname', 'carrier', 'carriername', 'business'],
  usdot: ['usdotnumber', 'usdot', 'dotnumber', 'dot'],
  trucks: ['trucks', 'numberoftrucks', 'truckcount', 'numtrucks', 'nooftrucks', 'trucksowned', 'powerunits', 'fleetsize', 'fleet'],
  recordId: ['sourcerecordid', 'recordid', 'leadid', 'id', 'externalid', 'applicationid', 'applicantid', 'uuid'],
  consent: ['consent', 'tcpaconsent', 'tcpa', 'optin', 'contactconsent', 'consentgiven', 'agreetocontact'],
  consentAt: ['consentat', 'consentdate', 'consenttimestamp', 'optindate', 'submittedat', 'timestamp'],
  consentText: ['consenttext', 'tcpatext', 'consentlanguage', 'disclosure'],
  consentProof: ['consentproof', 'trustedformcerturl', 'xxtrustedformcerturl', 'trustedform', 'certificateurl', 'jornayaleadid', 'universalleadid'],
  verified: ['verified', 'phoneverified', 'isverified', 'contactverified'],
  optOut: ['optout', 'unsubscribe', 'unsubscribed', 'donotcontact', 'dnc'],
} as const;

/**
 * Turns one provider record into the shape the database stores, or says why it can't be a lead.
 * A lead needs a person (or company) name and at least one valid way to reach them.
 */
export function normalizeLead(raw: unknown): NormalizeResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not a record' };
  const flat = new Map<string, unknown>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key && !flat.has(key) && v !== null && v !== undefined && v !== '') flat.set(key, v);
  }
  const pick = (names: readonly string[]) => {
    for (const n of names) if (flat.has(n)) return flat.get(n);
    return undefined;
  };

  const phone = normalizePhone(pick(ALIASES.phone));
  const email = normalizeEmail(pick(ALIASES.email));
  const optOut = normalizeBool(pick(ALIASES.optOut)) === true;
  const company = clean(pick(ALIASES.company), 120);
  const name =
    normalizePersonName(pick(ALIASES.name)) ??
    normalizePersonName([clean(pick(ALIASES.first), 40), clean(pick(ALIASES.last), 40)].filter(Boolean).join(' ')) ??
    (company ? company.slice(0, 80) : null);

  if (!phone && !email) {
    const gave = pick(ALIASES.phone) !== undefined || pick(ALIASES.email) !== undefined;
    return { ok: false, reason: gave ? 'phone and email are not valid' : 'no phone or email' };
  }
  if (!name && !optOut) return { ok: false, reason: 'no name' };

  const usdot = String(pick(ALIASES.usdot) ?? '').replace(/\D/g, '');
  const years = normalizeYears(pick(ALIASES.years));
  const types = tokens(pick(ALIASES.types), DRIVER_TYPE_RULES);
  return {
    ok: true,
    lead: {
      full_name: name ?? 'Unknown',
      phone,
      email,
      state: normalizeState(pick(ALIASES.state)),
      city: clean(pick(ALIASES.city), 80),
      zip: normalizeZip(pick(ALIASES.zip)),
      cdl_class: normalizeCdlClass(pick(ALIASES.cdl)),
      years_experience: years,
      endorsements: tokens(pick(ALIASES.endorsements), ENDORSEMENT_RULES, 'HNPSTX'),
      driver_types: types,
      equipment: tokens(pick(ALIASES.equipment), EQUIPMENT_RULES),
      employment_preferences: clean(pick(ALIASES.prefs), 300),
      availability: clean(pick(ALIASES.availability), 80),
      company_name: company,
      usdot_number: usdot.length >= 1 && usdot.length <= 9 ? usdot : null,
      trucks: normalizeTrucks(pick(ALIASES.trucks)),
      source_record_id: clean(pick(ALIASES.recordId), 120),
      consent: normalizeBool(pick(ALIASES.consent)),
      consent_at: normalizeTimestamp(pick(ALIASES.consentAt)),
      consent_text: clean(pick(ALIASES.consentText), 1000),
      consent_proof: clean(pick(ALIASES.consentProof), 300),
      verified: normalizeBool(pick(ALIASES.verified)),
      opt_out: optOut,
    },
  };
}

/** A phone number or email typed by a person, as the identity keys the database uses. */
export function contactKeys(input: unknown): string[] {
  // Anything with an @ is an email address; the digits inside it are not a phone number.
  if (String(input ?? '').includes('@')) return identityKeys(null, normalizeEmail(input));
  return identityKeys(normalizePhone(input), null);
}

/** The keys that identify a person in driver_identities and lead_suppressions. */
export const identityKeys = (phone: string | null, email: string | null): string[] =>
  [phone ? 'phone:' + phone : null, email ? 'email:' + email : null].filter((k): k is string => !!k);

export const leadId = (leadNo: number) => 'D-' + String(leadNo).padStart(6, '0');
export const labels = (ids: string[], dict: Record<string, string>) => ids.map((i) => dict[i] ?? i).join(', ');

/** Default consent wording shown on the registration page and stored with every sign-up. */
export function defaultConsentText(company: string): string {
  return (
    `By submitting this form I agree that ${company} and its agents may contact me by phone call, text message and email ` +
    'at the number and address I provided, including with automated technology, about its trucking products, services and offers. ' +
    'Consent is not a condition of any purchase. Message and data rates may apply. I can opt out at any time.'
  );
}
