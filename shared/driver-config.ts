// Every threshold of the drivers' route map in one place, read by the server and the Mini App.
// Change a number here, run the tests, deploy. (Server-only limits can also be overridden with the
// environment variables named next to them.)

export const DRIVER_MAP = {
  // ---- which stations count as "on the route" (shared/driver-route.ts, DriverMap.tsx)
  /** First filter: stations within this many miles of the route line. */
  corridorMi: 1.5,
  /** "Nearby stations": within this many miles of the route. */
  nearbyMi: 20,
  /** At most this many nearby stations are shown. */
  nearbyMax: 30,
  /** On a planned route the map shows only the cheapest few. */
  cheapShown: 3,

  // ---- real detour time (tools/driver-map/detours.ts)
  detour: {
    /** The cheapest this-many corridor stations get a real driving-time check. */
    candidates: 5,
    /** The detour is measured from this many miles before the station to this many after it. */
    aroundMi: 15,
    /** More extra driving than this (minutes) and the station is no longer "on your route". */
    maxMin: 10,
  },

  // ---- prices (pieces.tsx)
  /** A price older than this many hours is marked "Old price". */
  stalePriceHours: 24,

  // ---- live location alerts in the bot chat (tools/driver-map/alerts.ts)
  alerts: {
    /** Alert when the next partner station ahead is this close (miles, straight line). */
    aheadMi: 50,
    /** "Ahead" = within this many degrees either side of the direction of travel. */
    coneDeg: 45,
    /** The same station is not announced again to the same driver for this many hours. */
    repeatHours: 24,
    /** Below this movement (miles) between two updates the direction is not trusted. */
    minMoveMi: 0.2,
  },

  // ---- abuse guard: requests per Telegram user per minute (env: DRIVER_RATE_ROUTE, _PLACES, _DETOURS)
  ratePerMinute: { route: 20, places: 60, detours: 10 },

  // ---- station map points (tools/driver-map/stations.ts)
  /** The daily job re-checks map points older than this many days. */
  relocateDays: 90,
  /** The daily job stops starting new lookups after this many seconds (Vercel stops at 60). */
  relocateBudgetS: 45,
  /** At most this many address lookups per daily run (the free services' daily limits). */
  relocateMax: 400,
} as const;
