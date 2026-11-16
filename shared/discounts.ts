// Fuel discounts for agents: the partner brands, US states, and the free-text search that turns
// "calorado", "yuta", "cansas" or "pilot flying love's" into states and brands. Used by the bot (typed
// messages) and by the Mini App (the search box), so both understand the same words.

export type PartnerBrand = 'pilot' | 'loves' | 'ta' | 'speedway';

/** The partner brands, in the order every screen and message lists them. */
export const BRANDS: { id: PartnerBrand; label: string }[] = [
  { id: 'pilot', label: 'Pilot / Flying J' },
  { id: 'loves', label: "Love's" },
  { id: 'ta', label: 'TA / Petro' },
  { id: 'speedway', label: 'Speedway' },
];
export const BRAND_IDS = BRANDS.map((b) => b.id);
export const brandLabel = (b: PartnerBrand) => BRANDS.find((x) => x.id === b)!.label;

export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
export const stateName = (code: string) => US_STATES[code] ?? code;

/** Short forms and common spellings people type, besides the full names and 2-letter codes. */
const STATE_ALIASES: Record<string, string> = {
  ala: 'AL', alab: 'AL', alaska: 'AK', ariz: 'AZ', ark: 'AR', cal: 'CA', cali: 'CA', calif: 'CA', colo: 'CO', col: 'CO',
  conn: 'CT', del: 'DE', fla: 'FL', flor: 'FL', geo: 'GA', ida: 'ID', ill: 'IL', ills: 'IL', ind: 'IN', kan: 'KS', kans: 'KS',
  kent: 'KY', lou: 'LA', mass: 'MA', mich: 'MI', minn: 'MN', miss: 'MS', mont: 'MT', neb: 'NE', nebr: 'NE', nev: 'NV',
  'n dakota': 'ND', 'no dakota': 'ND', 'n dak': 'ND', 's dakota': 'SD', 'so dakota': 'SD', 's dak': 'SD',
  'n carolina': 'NC', 'no carolina': 'NC', 's carolina': 'SC', 'so carolina': 'SC', 'w virginia': 'WV', 'west va': 'WV', 'w va': 'WV', wva: 'WV',
  'n mexico': 'NM', 'n jersey': 'NJ', 'n york': 'NY', 'n hampshire': 'NH', jersey: 'NJ', okla: 'OK', ore: 'OR', oreg: 'OR', penn: 'PA',
  penna: 'PA', pennsylvannia: 'PA', tenn: 'TN', tex: 'TX', wash: 'WA', wis: 'WI', wisc: 'WI', wyo: 'WY', yuta: 'UT', yutah: 'UT', juta: 'UT',
  ilinois: 'IL', masachusets: 'MA', missisipi: 'MS', tennesee: 'TN', conneticut: 'CT', arkanzas: 'AR',
};

/** Words that name two states: the person is asked which one. */
const PARTIAL_STATES: Record<string, string[]> = { carolina: ['NC', 'SC'], dakota: ['ND', 'SD'] };

/**
 * Two-letter codes that are also everyday words ("pilot in iowa"). They count as a state only when
 * typed in capitals or when they are the whole message.
 */
const WORDLIKE_CODES = new Set(['in', 'or', 'me']);
/** "ok", "hi", "oh" open a message as greetings ("hi, texas please"); anywhere else they are states. */
const GREETING_CODES = new Set(['ok', 'hi', 'oh']);

const BRAND_ALIASES: Record<string, PartnerBrand> = {
  pilot: 'pilot', pilots: 'pilot', 'flying j': 'pilot', flyingj: 'pilot', flying: 'pilot', fj: 'pilot', pfj: 'pilot', 'pilot j': 'pilot',
  'pilot flying j': 'pilot', 'pilot flying': 'pilot', 'pilot fj': 'pilot',
  loves: 'loves', love: 'loves', 'loves travel stop': 'loves', 'love s': 'loves', lovs: 'loves',
  ta: 'ta', petro: 'ta', 'ta petro': 'ta', tapetro: 'ta', 'travel centers': 'ta', travelcenters: 'ta', 'travel center': 'ta', 'travel centers of america': 'ta',
  speedway: 'speedway', 'speed way': 'speedway', speedways: 'speedway',
};

/** Words that carry no meaning in a search ("show me pilot stations in texas"). */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'at', 'best', 'by', 'cheap', 'cheapest', 'diesel', 'discount', 'discounts', 'find', 'for', 'from', 'fuel', 'gas',
  'give', 'i', 'in', 'is', 'list', 'me', 'near', 'need', 'of', 'on', 'or', 'please', 'price', 'prices', 'show', 'state', 'states', 'station',
  'stations', 'stop', 'stops', 'the', 'to', 'truck', 'what', 'where', 'with', 'all', 'pls', 'plz', 'whats', 'are', 'there', 'get',
]);

/** Words before a number that make it a road, not a store number. */
const ROAD_WORDS = new Set(['i', 'interstate', 'exit', 'hwy', 'highway', 'us', 'route', 'rt', 'sr', 'mile', 'mm']);

/** The store number in a station's name ("Love's 697" → "697"), or null. */
export const storeNumberOf = (name: string) => {
  const all = name.match(/\d+/g);
  return all ? String(Number(all[all.length - 1])) : null;
};

export interface ParsedQuery {
  states: string[];
  brands: PartnerBrand[];
  /** City names (upper case, as the dataset has them) when a word matched a known city. */
  cities: string[];
  /** A word that could be either of these states. */
  ambiguous: { word: string; states: string[] } | null;
  /** Store numbers ("love's 697", "#697"): only those stations are wanted. */
  numbers: string[];
  /** Words that matched nothing. */
  unknown: string[];
}

export const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Edit distance where swapping two neighbouring letters counts as one typo. */
export function typoDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const d: number[][] = Array.from({ length: m + 1 }, (_v, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/** How the word sounds, roughly: "cansas" and "kansas", "yuta" and "utah" come out close. */
export function soundKey(s: string): string {
  let k = s.replace(/ /g, '').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/[cq]/g, 'k').replace(/z/g, 's').replace(/x/g, 'ks').replace(/y/g, 'i').replace(/w/g, 'v');
  k = k[0] + k.slice(1).replace(/h/g, '');
  return k.replace(/(.)\1+/g, '$1');
}

/** Typos allowed for a word of this length. */
const allowed = (len: number) => (len <= 3 ? 0 : len <= 5 ? 1 : len <= 9 ? 2 : 3);

type Target = { kind: 'state'; code: string } | { kind: 'brand'; brand: PartnerBrand } | { kind: 'city'; city: string };

interface Dictionary {
  exact: Map<string, Target>;
  /** Words checked for typos: full state names, longer brand aliases, city names. */
  fuzzy: { word: string; sound: string; target: Target }[];
}

function buildDictionary(cities: Iterable<string>): Dictionary {
  const exact = new Map<string, Target>();
  const fuzzy: Dictionary['fuzzy'] = [];
  const add = (word: string, target: Target, typos = true) => {
    if (!exact.has(word)) exact.set(word, target);
    if (typos && word.length >= 4) fuzzy.push({ word, sound: soundKey(word), target });
  };
  for (const [code, name] of Object.entries(US_STATES)) add(normalize(name), { kind: 'state', code });
  for (const [alias, code] of Object.entries(STATE_ALIASES)) add(alias, { kind: 'state', code }, alias.length >= 5);
  for (const [alias, brand] of Object.entries(BRAND_ALIASES)) add(alias, { kind: 'brand', brand }, alias.length >= 5);
  for (const c of cities) {
    const w = normalize(c);
    if (w.length >= 3 && !exact.has(w)) add(w, { kind: 'city', city: c.toUpperCase() });
  }
  return { exact, fuzzy };
}

const targetKey = (t: Target) => (t.kind === 'state' ? 'S' + t.code : t.kind === 'brand' ? 'B' + t.brand : 'C' + t.city);

/** The closest dictionary word within the typos allowed, or the tied candidates when two are equally close. */
function closest(dict: Dictionary, word: string): Target[] {
  const max = allowed(word.length);
  if (!max) return [];
  const sound = soundKey(word);
  let best = Infinity;
  let found = new Map<string, Target>();
  for (const f of dict.fuzzy) {
    if (Math.abs(f.word.length - word.length) > max + 1) continue;
    // Cities need to be closer than states and brands: there are many of them and they are short.
    const limit = f.target.kind === 'city' ? Math.min(1, max) : max;
    const d = Math.min(typoDistance(word, f.word), typoDistance(sound, f.sound) + 0.5);
    if (d > limit) continue;
    // States and brands win over cities at the same distance.
    const score = d + (f.target.kind === 'city' ? 0.25 : 0);
    if (score < best) {
      best = score;
      found = new Map([[targetKey(f.target), f.target]]);
    } else if (score === best) found.set(targetKey(f.target), f.target);
  }
  return [...found.values()];
}

/** Cache of dictionaries by the set of cities they include. */
let cache: { key: string; dict: Dictionary } | null = null;
function dictionaryFor(cities: string[]): Dictionary {
  const key = cities.length + ':' + cities.slice(0, 3).join('|');
  if (cache?.key !== key) cache = { key, dict: buildDictionary(cities) };
  return cache.dict;
}

/**
 * Reads what someone typed. Each line (or comma-separated part) is read on its own; within it, the
 * longest phrase that names a state, brand or city wins ("new york", "flying j"), then single words,
 * exactly first and then allowing typos.
 */
export function parseQuery(text: string, cities: string[] = []): ParsedQuery {
  const dict = dictionaryFor(cities);
  const out: ParsedQuery = { states: [], brands: [], cities: [], ambiguous: null, numbers: [], unknown: [] };
  const take = (t: Target) => {
    if (t.kind === 'state' && !out.states.includes(t.code)) out.states.push(t.code);
    if (t.kind === 'brand' && !out.brands.includes(t.brand)) out.brands.push(t.brand);
    if (t.kind === 'city' && !out.cities.includes(t.city)) out.cities.push(t.city);
  };
  const rawWords = text.split(/[\n,;/]+/).map((part) => part.trim()).filter(Boolean);
  const wholeMessageWords = normalize(text).split(' ').filter(Boolean).length;

  for (const part of rawWords) {
    const original = part.replace(/['’`´]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
    const words = original.map((w) => normalize(w)).filter(Boolean);
    for (let i = 0; i < words.length; ) {
      let matched = 0;
      // Longest exact phrase first (up to four words: "travel centers of america").
      for (let n = Math.min(4, words.length - i); n >= 2 && !matched; n--) {
        const t = dict.exact.get(words.slice(i, i + n).join(' '));
        if (t) {
          take(t);
          matched = n;
        }
      }
      if (matched) {
        i += matched;
        continue;
      }
      const w = words[i];
      const orig = original[i];
      // Two-letter state codes. Ambiguous ones ("in", "or") only in capitals or alone.
      if (w.length === 2 && US_STATES[w.toUpperCase()]) {
        const caps = orig === orig.toUpperCase();
        const greeting = GREETING_CODES.has(w) && i === 0 && words.length > 1;
        if ((!WORDLIKE_CODES.has(w) && !greeting) || caps || wholeMessageWords === 1) {
          take({ kind: 'state', code: w.toUpperCase() });
          i++;
          continue;
        }
      }
      const exact = dict.exact.get(w);
      if (exact) {
        take(exact);
        i++;
        continue;
      }
      if (PARTIAL_STATES[w]) {
        out.ambiguous ??= { word: orig, states: PARTIAL_STATES[w] };
        i++;
        continue;
      }
      if (/^\d{1,6}$/.test(w)) {
        // A store number, unless it is part of a road ("I-80", "exit 305", "hwy 6").
        if (!ROAD_WORDS.has(words[i - 1] ?? '')) {
          const n = String(Number(w));
          if (!out.numbers.includes(n)) out.numbers.push(n);
        }
        i++;
        continue;
      }
      if (STOPWORDS.has(w)) {
        i++;
        continue;
      }
      // Two words with a typo ("nort dakota", "flyng j").
      if (i + 1 < words.length) {
        const pair = closest(dict, w + ' ' + words[i + 1]).filter((t) => t.kind !== 'city');
        if (pair.length === 1) {
          take(pair[0]);
          i += 2;
          continue;
        }
      }
      const near = closest(dict, w);
      const states = near.filter((t): t is Extract<Target, { kind: 'state' }> => t.kind === 'state');
      if (near.length === 1) take(near[0]);
      else if (states.length > 1 && states.length === near.length) out.ambiguous ??= { word: orig, states: states.map((s) => s.code) };
      else if (near.length > 1) take(near.find((t) => t.kind !== 'city') ?? near[0]);
      else out.unknown.push(orig);
      i++;
    }
  }
  return out;
}

// ---- What agents receive ------------------------------------------------------------------------

/** One partner station with the agent's price (the cabinet's discount minus the CFT margin). */
export interface AgentStation {
  id: number;
  brand: PartnerBrand;
  /** "Flying J 746", "Love's 695", "Petro 312", "Speedway 4638". */
  name: string;
  state: string;
  city: string | null;
  address: string | null;
  exit: string | null;
  /** The agent's price per gallon. For a station without a discount (when admins show those) it is the retail price. */
  price: number;
  retail: number | null;
  /** Retail minus the agent's price; null when the station has no discount. */
  saving: number | null;
  updatedAt: string | null;
}

export interface AgentDiscounts {
  /** When an admin last pulled the prices from the cabinet; null before the first pull. */
  pulledAt: string | null;
  stations: AgentStation[];
  me: { name: string; username: string | null; role: 'agent' | 'admin'; since: string | null; invitedBy: string | null };
}

/** "$5.37": every decimal there is, at least two. */
export function usd(p: number | null | undefined): string {
  if (p == null) return '—';
  const r = Math.round(p * 1000) / 1000;
  const decimals = Math.max(2, (String(r).split('.')[1] ?? '').length);
  return '$' + r.toFixed(decimals);
}

/** "SALT LAKE CITY" → "Salt Lake City". */
export const titleCase = (s: string | null) =>
  s ? s.toLowerCase().replace(/(^|[\s\-/.(])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase()).replace(/\bMc([a-z])/g, (_m, c: string) => 'Mc' + c.toUpperCase()) : '';

/** Cheapest first; stations with the same price by name. */
export const byPrice = (a: AgentStation, b: AgentStation) => a.price - b.price || a.name.localeCompare(b.name);
