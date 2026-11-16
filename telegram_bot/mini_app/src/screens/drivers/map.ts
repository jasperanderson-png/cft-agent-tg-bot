import maplibregl, { type GeoJSONSource, type Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { LatLng } from '../../../../../shared/driverRoute';
import { cfStyle } from './map-style';

// The map under the drivers' route screen: MapLibre with the CF Transport night style (OpenStreetMap
// data via OpenFreeMap, recoloured like the United Fuel app). Everything on it is drawn by the map
// engine on the GPU (route, traffic, stations, price tags); the only HTML element is the driver arrow,
// moved every frame without React. That keeps panning, pinching and tilting smooth on phones.

export type { MlMap };
export const ACCENT = '#a0dcff';
export const BRAND_COLORS: Record<string, string> = { p: '#ff9f7a', l: '#ffd166', t: '#7fe0a4', s: '#c9b0ff' };
const FONT = ['Noto Sans Bold'];
const empty = { type: 'FeatureCollection' as const, features: [] as GeoJSON.Feature[] };

export const ll = (p: LatLng): [number, number] => [p.lng, p.lat];
const line = (path: LatLng[]) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: path.map(ll) } });
const fc = (features: GeoJSON.Feature[]) => ({ type: 'FeatureCollection' as const, features });

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 3 - 1), 16));
/** A rounded, stretchable tag for prices, in one colour with a thin dark edge (drawn at 2x for sharpness). */
function chipImage(fill: string, edge: string): { width: number; height: number; data: Uint8Array } {
  const w = 48, h = 48, r = 13, data = new Uint8Array(w * h * 4);
  const [fr, fg, fb] = hex(fill), [er, eg, eb] = hex(edge);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = Math.max(r - x - 0.5, 0, x + 0.5 - (w - r)), dy = Math.max(r - y - 0.5, 0, y + 0.5 - (h - r));
      const d = r - Math.hypot(dx, dy); // inside distance from the rounded edge
      const i = (y * w + x) * 4;
      const inEdge = d < 2.5;
      data[i] = inEdge ? er : fr;
      data[i + 1] = inEdge ? eg : fg;
      data[i + 2] = inEdge ? eb : fb;
      data[i + 3] = Math.round(255 * Math.max(0, Math.min(1, d + 0.5)));
    }
  return { width: w, height: h, data };
}
const CHIP = { pixelRatio: 2, content: [12, 12, 36, 36] as [number, number, number, number], stretchX: [[14, 34]] as [number, number][], stretchY: [[14, 34]] as [number, number][] };

/** A station icon: a fuel pump on a rounded tile in the brand colour (drawn at 2x for sharpness). */
function pumpImage(fill: string, big = false): ImageData {
  const size = big ? 64 : 48, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const r = size * 0.26, pad = 3;
  g.beginPath();
  g.roundRect(pad, pad, size - 2 * pad, size - 2 * pad, r);
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = big ? 5 : 4;
  g.strokeStyle = big ? '#ffffff' : '#05080c';
  g.stroke();
  // Lucide's fuel pump (24-unit box), drawn in near-black.
  const s = (size - 2 * pad) / 24 * 0.62, o = (size - 24 * s) / 2;
  g.save();
  g.translate(o, o);
  g.scale(s, s);
  g.lineWidth = 2.4;
  g.lineCap = g.lineJoin = 'round';
  g.strokeStyle = '#05080c';
  g.stroke(new Path2D('M3 22h12 M4 9h10 M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18 M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V9.83a2 2 0 0 0-.59-1.42L18 5'));
  g.restore();
  return g.getImageData(0, 0, size, size);
}

export async function createMap(el: HTMLElement): Promise<MlMap> {
  const style = await cfStyle();
  const map = new maplibregl.Map({
    container: el,
    style: style as unknown as maplibregl.StyleSpecification,
    // The lower 48 states, whatever the screen's shape.
    bounds: [[-124.8, 24.4], [-66.9, 49.4]],
    fitBoundsOptions: { padding: { top: 150, bottom: 40, left: 12, right: 12 } },
    maxPitch: 60,
    // Phones with 3x screens draw at 2x: sharp enough, far less work per frame.
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    fadeDuration: 0,
    attributionControl: false,
    dragRotate: false,
    touchPitch: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.on('styleimagemissing', (e) => {
    // Icons the style refers to but hides: a transparent pixel instead of a warning.
    if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });
  map.on('load', () => {
    map.addImage('chip', chipImage('#10161b', '#3a4650'), CHIP);
    for (const [b, c] of Object.entries(BRAND_COLORS)) {
      map.addImage(`chip-${b}`, chipImage(c, '#05080c'), CHIP);
      map.addImage(`pump-${b}`, pumpImage(c), { pixelRatio: 2 });
      map.addImage(`pump-${b}-sel`, pumpImage(c, true), { pixelRatio: 2 });
    }
    // Under the first label layer: street and place names stay readable on top of the route.
    const labels = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id;
    for (const id of ['route-base', 'route', 'traffic', 'done', 'turn', 'stations', 'rstations']) {
      map.addSource(id, { type: 'geojson', data: empty });
    }
    const width = (a: number, b: number) => ['interpolate', ['linear'], ['zoom'], 4, a, 14, b] as maplibregl.ExpressionSpecification;
    const round = { 'line-cap': 'round', 'line-join': 'round' } as const;
    map.addLayer({ id: 'route-base', type: 'line', source: 'route-base', layout: round, paint: { 'line-color': ACCENT, 'line-opacity': 0.5, 'line-width': 3, 'line-dasharray': [1, 2] } }, labels);
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: round, paint: { 'line-color': '#05080c', 'line-width': width(6, 14) } }, labels);
    map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: round, paint: { 'line-color': ACCENT, 'line-width': width(3.5, 9) } }, labels);
    map.addLayer({
      id: 'traffic', type: 'line', source: 'traffic', layout: round,
      paint: { 'line-color': ['match', ['get', 'level'], 'jam', '#ff5a52', 'closed', '#9b1c1c', 'roadwork', '#f6cd7a', '#f6a94a'], 'line-width': width(3.5, 9) },
    }, labels);
    map.addLayer({ id: 'done', type: 'line', source: 'done', layout: round, paint: { 'line-color': '#4b5963', 'line-width': width(3.5, 9) } }, labels);
    map.addLayer({ id: 'turn', type: 'circle', source: 'turn', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 16, 9], 'circle-color': '#fff', 'circle-stroke-color': '#05080c', 'circle-stroke-width': 3 } });

    // Every station before a route is planned: a brand-coloured pump icon each. Zoomed out, the map
    // hides icons that would overlap (the cheaper one wins); zooming in shows more, then their prices.
    map.addLayer({
      id: 'st-icon', type: 'symbol', source: 'stations',
      layout: {
        'icon-image': ['concat', 'pump-', ['get', 'brand']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.62, 7, 0.85, 12, 1.05],
        'icon-padding': 1,
        'symbol-sort-key': ['get', 'cost'],
        'text-field': ['step', ['zoom'], '', 7.5, ['get', 'price']],
        'text-font': FONT, 'text-size': 12.5, 'text-anchor': 'left', 'text-offset': [1.15, 0], 'text-optional': true,
      },
      paint: { 'text-color': '#ffffff', 'text-halo-color': '#05080c', 'text-halo-width': 2 },
    });

    // The stations on and near the planned route: dots, price chips on the selected and the cheapest.
    map.addLayer({
      id: 'rs-dot', type: 'symbol', source: 'rstations',
      layout: {
        'icon-image': ['case', ['get', 'sel'], ['concat', 'pump-', ['get', 'brand'], '-sel'], ['concat', 'pump-', ['get', 'brand']]],
        'icon-size': ['case', ['get', 'sel'], 1, ['get', 'near'], 0.7, 0.85],
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'symbol-sort-key': ['case', ['get', 'sel'], 2, ['get', 'near'], 0, 1],
      },
      paint: { 'icon-opacity': ['case', ['get', 'near'], 0.75, 1] },
    });
    map.addLayer({
      id: 'rs-tag', type: 'symbol', source: 'rstations', filter: ['any', ['get', 'sel'], ['get', 'tag']],
      layout: {
        'text-field': ['get', 'price'], 'text-font': FONT, 'text-size': ['case', ['get', 'sel'], 15, 12.5],
        'icon-image': ['case', ['get', 'sel'], ['concat', 'chip-', ['get', 'brand']], 'chip'], 'icon-text-fit': 'both', 'icon-text-fit-padding': [3, 6, 3, 6],
        'text-anchor': 'left', 'text-offset': ['case', ['get', 'sel'], ['literal', [1.8, 0]], ['literal', [1.5, 0]]],
        'symbol-sort-key': ['case', ['get', 'sel'], 0, 1],
      },
      paint: { 'text-color': ['case', ['get', 'sel'], '#000000', '#ffffff'] },
    });
  });
  return map;
}

function setData(map: MlMap, id: string, data: unknown) {
  (map.getSource(id) as GeoJSONSource | undefined)?.setData(data as GeoJSON.GeoJSON);
}

/** The route (and, dashed, the original route when going through a station off it), with traffic. */
export function drawRoute(map: MlMap, path: LatLng[] | null, base: LatLng[] | null, traffic: { from: number; to: number; level: string }[] = []) {
  setData(map, 'route', path && path.length > 1 ? line(path) : empty);
  setData(map, 'route-base', base && base.length > 1 ? line(base) : empty);
  setData(map, 'traffic', path ? fc(traffic.filter((t) => t.to > t.from && t.to < path.length).map((t) => ({ ...line(path.slice(t.from, t.to + 1)), properties: { level: t.level } }))) : empty);
}
export function drawDriven(map: MlMap, driven: LatLng[] | null) {
  setData(map, 'done', driven && driven.length > 1 ? line(driven) : empty);
}
export function drawTurn(map: MlMap, at: LatLng | null) {
  setData(map, 'turn', at ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: ll(at) } } : empty);
}

export interface MapStation { id: number; brand: string; lat: number | null; lng: number | null; price: number | null }
const money = (n: number | null) => (n != null ? '$' + n.toFixed(2) : '');

/** Every station with a map point (the clustered layer). */
export function setStations(map: MlMap, stations: MapStation[]) {
  setData(map, 'stations', fc(stations.filter((s) => s.lat != null && s.lng != null).map((s) => ({
    type: 'Feature', properties: { id: s.id, brand: s.brand, price: money(s.price), cost: s.price ?? 99 }, geometry: { type: 'Point', coordinates: [s.lng!, s.lat!] },
  }))));
}
/** The route's stations: `sel` the chosen one, `tag` those that show their price, `near` those off the route. */
export function setRouteStations(map: MlMap, stations: (MapStation & { sel: boolean; tag: boolean; near: boolean })[]) {
  setData(map, 'rstations', fc(stations.filter((s) => s.lat != null).map((s) => ({
    type: 'Feature', properties: { id: s.id, brand: s.brand, price: money(s.price), sel: s.sel, tag: s.tag, near: s.near }, geometry: { type: 'Point', coordinates: [s.lng!, s.lat!] },
  }))));
}
export function showLayers(map: MlMap, ids: string[], on: boolean) {
  for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}
export const ALL_STATION_LAYERS = ['st-icon'];

/** Taps on stations (all stations, or the route's). */
export function onStationTap(map: MlMap, open: (id: number) => void) {
  const pick = (e: maplibregl.MapLayerMouseEvent) => {
    const id = Number(e.features?.[0]?.properties?.id);
    if (Number.isFinite(id)) open(id);
  };
  for (const id of ['st-icon', 'rs-dot', 'rs-tag']) {
    map.on('click', id, pick);
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
}

/** Fits a path into the visible band between the top panel and the bottom card. */
export function fitPath(map: MlMap, path: LatLng[], pad: { top: number; bottom: number }) {
  if (path.length < 2) return;
  const b = new maplibregl.LngLatBounds(ll(path[0]), ll(path[0]));
  for (const p of path) b.extend(ll(p));
  map.fitBounds(b, { padding: { top: pad.top + 24, bottom: pad.bottom + 24, left: 30, right: 74 }, duration: 650, maxZoom: 14, bearing: 0, pitch: 0 });
}

/** The driver arrow: one HTML marker, moved and turned directly (no React) for smooth motion. */
export function driverMarker(map: MlMap) {
  const el = document.createElement('div');
  el.className = 'dm-puck';
  el.innerHTML = '<i class="dm-puck-halo"></i><svg viewBox="0 0 40 40" class="dm-puck-arrow" aria-hidden="true"><path d="M20 4 L33 34 L20 27 L7 34 Z"/></svg>';
  // Turns with the road, but always faces the screen (a tilted map would flatten it).
  const marker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'viewport' });
  let shown = false;
  return {
    set(at: LatLng, heading: number | null) {
      marker.setLngLat(ll(at));
      el.classList.toggle('no-heading', heading == null);
      if (heading != null) marker.setRotation(heading);
      if (!shown) { marker.addTo(map); shown = true; }
    },
    hide() { if (shown) { marker.remove(); shown = false; } },
  };
}
