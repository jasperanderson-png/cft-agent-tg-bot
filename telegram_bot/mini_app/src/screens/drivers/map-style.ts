// Ported from the United Fuel app (src/map-style.ts). CF Transport basemaps: OpenFreeMap's free "Liberty" style (OpenMapTiles
// data from OpenStreetMap), recoloured for the brand at load time. Night is
// near-black with calm grey roads; day is a soft light grey with white roads.
// Highways stand out a little, small streets stay quiet, shops and other
// points of interest are hidden (fuel stops are drawn by the app), and place
// names are uppercase with letter spacing, like the app's titles.

const BASE = "https://tiles.openfreemap.org/styles/liberty";

type Palette = {
  land: string;
  residential: string;
  green: string;
  water: string;
  waterway: string;
  waterLabel: string;
  building: string;
  airport: string;
  runway: string;
  motorway: string;
  motorwayCasing: string;
  primary: string;
  primaryCasing: string;
  secondary: string;
  secondaryCasing: string;
  minor: string;
  minorCasing: string;
  path: string;
  rail: string;
  border: string;
  city: string;
  town: string;
  village: string;
  region: string;
  road: string;
  halo: string;
  relief: number;
};

const NIGHT: Palette = {
  land: "#0b0e12",
  residential: "#0f1318",
  green: "#0d1512",
  water: "#0f1a24",
  waterway: "#15263a",
  waterLabel: "#4f7192",
  building: "#151a21",
  airport: "#12161c",
  runway: "#1e242c",
  motorway: "#45525f",
  motorwayCasing: "#05080c",
  primary: "#323b46",
  primaryCasing: "#05080c",
  secondary: "#272e37",
  secondaryCasing: "#06090d",
  minor: "#1c2128",
  minorCasing: "#080b0f",
  path: "#171b21",
  rail: "#252b33",
  border: "#3a414b",
  city: "#e9edf1",
  town: "#b4bcc6",
  village: "#87909b",
  region: "#5f6976",
  road: "#b9c2cc",
  halo: "#0b0e12",
  relief: 0,
};


type Layer = {
  id: string;
  type: string;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
};
type Style = { layers: Layer[]; [key: string]: unknown };

/** Multiplies the output values of a zoom interpolation (road widths). */
function scaleWidth(value: unknown, factor: number): unknown {
  if (
    Array.isArray(value) &&
    value[0] === "interpolate" &&
    Array.isArray(value[2]) &&
    value[2][0] === "zoom"
  )
    return value.map((v, i) => (i > 2 && i % 2 === 0 && typeof v === "number" ? v * factor : v));
  return typeof value === "number" ? value * factor : value;
}

// Which road class a line layer draws, from its id.
const roadClass = (id: string) =>
  /motorway/.test(id)
    ? "motorway"
    : /trunk_primary/.test(id)
      ? "primary"
      : /secondary_tertiary/.test(id)
        ? "secondary"
        : /path_pedestrian/.test(id)
          ? "path"
          : /(major|transit)_rail/.test(id)
            ? "rail"
            : /(minor|street|link|service_track)/.test(id)
              ? "minor"
              : null;

function recolour(base: Style, p: Palette): Style {
  const style = structuredClone(base);
  for (const l of style.layers) {
    const id = l.id;
    const paint = (l.paint ??= {});
    const layout = (l.layout ??= {});
    const hide = () => (layout.visibility = "none");
    // Clutter a truck driver doesn't need on a fuel map.
    if (/^poi_|^airport$|one_way_arrow|^highway-name-path$|^building-3d$|^road_area_pattern$|_hatching$|^label_other$/.test(id)) {
      hide();
      continue;
    }
    if (l.type === "background") paint["background-color"] = p.land;
    else if (l.type === "raster") {
      if (p.relief) paint["raster-opacity"] = p.relief;
      else hide();
    } else if (l.type === "fill") {
      if (id === "water") paint["fill-color"] = p.water;
      else if (/^park$|landcover_(wood|grass|wetland)|landuse_(pitch|cemetery)/.test(id)) {
        paint["fill-color"] = p.green;
        paint["fill-opacity"] = 0.9;
      } else if (/landuse_residential|landuse_(hospital|school|track)/.test(id)) {
        paint["fill-color"] = p.residential;
        paint["fill-opacity"] = 1;
      } else if (id === "building") {
        paint["fill-color"] = p.building;
        paint["fill-outline-color"] = p.building;
      } else if (id === "aeroway_fill") paint["fill-color"] = p.airport;
      else if (/landcover_(ice|sand)/.test(id)) {
        paint["fill-color"] = p.residential;
        paint["fill-opacity"] = 0.6;
      }
      // No bright outlines or textures (park edges, wetland pattern).
      delete paint["fill-pattern"];
      if ("fill-outline-color" in paint) paint["fill-outline-color"] = paint["fill-color"];
    } else if (l.type === "line") {
      if (/^waterway/.test(id)) paint["line-color"] = p.waterway;
      else if (/^aeroway/.test(id)) paint["line-color"] = p.runway;
      else if (/^boundary/.test(id)) {
        paint["line-color"] = p.border;
        paint["line-opacity"] = 0.7;
      } else if (id === "park_outline") hide();
      else {
        const cls = roadClass(id);
        if (!cls) continue;
        const casing = /casing/.test(id);
        const colour = {
          motorway: casing ? p.motorwayCasing : p.motorway,
          primary: casing ? p.primaryCasing : p.primary,
          secondary: casing ? p.secondaryCasing : p.secondary,
          minor: casing ? p.minorCasing : p.minor,
          path: p.path,
          rail: p.rail,
        }[cls];
        paint["line-color"] = colour;
        // Highways a little wider so the network reads at a glance.
        if (cls === "motorway") paint["line-width"] = scaleWidth(paint["line-width"], 1.25);
        if (/^tunnel_/.test(id)) paint["line-opacity"] = 0.6;
      }
    } else if (l.type === "symbol") {
      // Highway shields keep their own colours and halo (numbers on badges).
      if (/shield/.test(id)) continue;
      paint["text-halo-color"] = p.halo;
      paint["text-halo-width"] = 1.4;
      paint["text-halo-blur"] = 0.4;
      if (/^label_city/.test(id)) {
        paint["text-color"] = p.city;
        layout["text-font"] = ["Noto Sans Bold"];
        layout["text-transform"] = "uppercase";
        layout["text-letter-spacing"] = 0.08;
        layout["icon-image"] = "";
      } else if (id === "label_town") {
        paint["text-color"] = p.town;
        layout["text-font"] = ["Noto Sans Bold"];
        layout["text-transform"] = "uppercase";
        layout["text-letter-spacing"] = 0.06;
        layout["icon-image"] = "";
      } else if (id === "label_village") {
        paint["text-color"] = p.village;
        layout["icon-image"] = "";
      } else if (/^label_(state|country)/.test(id)) {
        paint["text-color"] = p.region;
        layout["text-transform"] = "uppercase";
        layout["text-letter-spacing"] = 0.18;
      } else if (/^highway-name/.test(id)) {
        // Street names readable at a glance while driving.
        paint["text-color"] = p.road;
        paint["text-halo-width"] = 1.8;
      } else if (/^water|waterway_line_label/.test(id)) {
        paint["text-color"] = p.waterLabel;
        paint["text-halo-width"] = 1;
      }
    }
  }
  return style;
}

let base: Promise<Style> | null = null;
let built: Promise<Style> | null = null;
/** The CF Transport night style (fetched once, recoloured, cached). */
export function cfStyle(): Promise<Style> {
  base ??= fetch(BASE).then((r) => {
    if (!r.ok) throw new Error(`Map style ${r.status}`);
    return r.json() as Promise<Style>;
  });
  built ??= base.then((b) => recolour(b, NIGHT));
  built.catch(() => {
    base = null;
    built = null;
  });
  return built;
}

/** Map data credits (OpenStreetMap licence). */
export const MAP_CREDITS = "© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap";
