/** Server-only configuration. Nothing here is ever sent to the browser except via PublicConfig. */
export const env = {
  /** DATABASE_URL (POSTGRES_URL also works). */
  get databaseUrl() {
    return process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  },
  get botToken() {
    return process.env.TELEGRAM_BOT_TOKEN ?? '';
  },
  get botUsername() {
    return (process.env.TELEGRAM_BOT_USERNAME ?? '').replace(/^@/, '') || null;
  },
  get webhookSecret() {
    return process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
  },
  get appUrl() {
    return (process.env.APP_URL ?? '').replace(/\/+$/, '');
  },
  /** The drivers' website (https://fuel.cftransport.com): the same app, signed in through the bot. Falls back to APP_URL. */
  get webUrl() {
    return (process.env.WEB_URL ?? '').replace(/\/+$/, '') || (process.env.APP_URL ?? '').replace(/\/+$/, '');
  },
  /** Lets candidates start without Telegram (local development, or a deliberate web rollout). */
  get allowWebCandidates() {
    return process.env.ALLOW_WEB_CANDIDATES === 'true';
  },
  /** How old Telegram initData may be when a candidate starts or resumes. */
  get initDataMaxAgeSec() {
    return Number(process.env.TELEGRAM_INITDATA_MAX_AGE_SEC ?? 86400);
  },
  /** Telegram user IDs that are always owners (comma-separated ADMIN_TELEGRAM_IDS). */
  get ownerTelegramIds(): number[] {
    return (process.env.ADMIN_TELEGRAM_IDS ?? '')
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isSafeInteger(n) && n > 0);
  },
  /** Telegram IDs of the people who have shifts and work reports (TASK_REPORT_USER_IDS). Nobody else sees them. */
  get taskReportUserIds(): number[] {
    return (process.env.TASK_REPORT_USER_IDS ?? '')
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isSafeInteger(n) && n > 0);
  },
  /** The key Claude Code (or another trusted script) uses to add work-log entries (tools/task-report/). */
  get taskReportToken() {
    return process.env.TASK_REPORT_TOKEN ?? '';
  },
  /** The scheduled jobs send "Authorization: Bearer <CRON_SECRET>". */
  get cronSecret() {
    return process.env.CRON_SECRET ?? '';
  },
  /** Company named in the driver registration page's consent wording. */
  get leadsCompanyName() {
    return (process.env.LEADS_COMPANY_NAME ?? '').trim() || 'CFT';
  },
  /** Overrides the default consent wording on the registration page. */
  get leadsConsentText() {
    return (process.env.LEADS_CONSENT_TEXT ?? '').trim() || null;
  },
  /** Opt-in: also collect newly registered small carriers from the public FMCSA census (carrier records, not driver sign-ups). */
  get fmcsaEnabled() {
    return process.env.LEADS_FMCSA_ENABLED === 'true';
  },
  /** Largest fleet (power units) still treated as an owner-operator prospect. */
  get fmcsaMaxPowerUnits() {
    const n = Number(process.env.LEADS_FMCSA_MAX_POWER_UNITS ?? 1);
    return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 1;
  },
  /** How many days of registrations each run re-checks (FMCSA publishes some records a few days late). */
  get fmcsaLookbackDays() {
    const n = Number(process.env.LEADS_FMCSA_LOOKBACK_DAYS ?? 10);
    return Number.isInteger(n) && n >= 1 && n <= 60 ? n : 10;
  },
  /** true keeps only carriers registered as "authorized for hire" (trucking companies, not private fleets). */
  get fmcsaForHireOnly() {
    return process.env.LEADS_FMCSA_FOR_HIRE_ONLY !== 'false';
  },
  /**
   * true (default): each sync deletes FMCSA carrier records that are no longer in the current window,
   * so the database holds the fresh set instead of accumulating old registrations.
   */
  get fmcsaReplaceOld() {
    return process.env.LEADS_FMCSA_REPLACE_OLD !== 'false';
  },
  /** The United Fuel customer cabinet account the bot signs in with to download fuel prices. */
  get fuelCabinetEmail() {
    return (process.env.FUEL_CABINET_EMAIL ?? '').trim();
  },
  get fuelCabinetPassword() {
    return process.env.FUEL_CABINET_PASSWORD ?? '';
  },
  /** Optional Socrata app token for data.transportation.gov (raises the rate limit; not required). */
  get socrataAppToken() {
    return process.env.SOCRATA_APP_TOKEN ?? '';
  },
  get googleServiceAccount(): { client_email: string; private_key: string } | null {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) return null;
    try {
      const j = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
      return j.client_email && j.private_key ? { client_email: j.client_email, private_key: j.private_key } : null;
    } catch {
      return null;
    }
  },
  /** TomTom key (server only): truck routes with live traffic, capped in Redis (support/helpers/kv.ts). */
  get tomtomKey() {
    return (process.env.TOMTOM_API_KEY ?? '').trim();
  },
  /** Google Cloud Text-to-Speech key (server only): the natural navigation voice, capped in Redis. */
  get googleTtsKey() {
    return (process.env.GOOGLE_TTS_KEY ?? '').trim();
  },
  /**
   * Our Redis on the same server (redis://:password@127.0.0.1:6379): our daily and monthly caps, rate
   * limits and the voice cache. When set it is used instead of Upstash.
   */
  get redisUrl() {
    return (process.env.REDIS_URL ?? '').trim();
  },
  /** Upstash Redis (REST), used when REDIS_URL is not set. */
  get kvUrl() {
    return (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').trim();
  },
  get kvToken() {
    return (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  },
  /** OpenRouteService key (server only): truck routes, place search and the last-resort station lookup. */
  get orsKey() {
    return (process.env.ORS_API_KEY ?? '').trim();
  },
  /** How many stations one request may look up by street address (the rest are done on later requests). */
  get geocodeBatch() {
    const n = Number(process.env.DRIVER_GEOCODE_BATCH ?? 60);
    return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : 60;
  },
  /** Route-map requests per user per minute: DRIVER_RATE_ROUTE / _PLACES / _DETOURS, else `fallback`. */
  driverRate(name: 'route' | 'places' | 'detours', fallback: number) {
    const n = Number(process.env[`DRIVER_RATE_${name.toUpperCase()}`]);
    return Number.isInteger(n) && n > 0 && n <= 10_000 ? n : fallback;
  },
};
