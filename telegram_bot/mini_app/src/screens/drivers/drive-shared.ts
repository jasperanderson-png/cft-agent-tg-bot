import type { DriverPlace } from '../../../../../support/common/types';
import type { LatLng, RankBy } from '../../../../../support/common/driver-route';

// Types and small values that the route map's parts share: DriverMap.tsx and the use-*.ts / *Card.tsx
// files beside it.

export type Mode = 'route' | 'states';
export type Phase = 'go1' | 'stop' | 'go2' | 'done';
export interface Trip { phase: Phase; stopId: number | null }
export interface Field { text: string; place: DriverPlace | null }
export interface Fix extends LatLng { heading: number | null; speed: number | null; accuracy: number | null }

/** What the route card shows: every station on and near the route (by price), or the best 3 by a ranking. */
export type Show = 'all' | RankBy;
export const SHOWS: Show[] = ['all', 'rec', 'cheap', 'disc'];
export const SHOW_LABEL: Record<Show, string> = { all: 'All', rec: 'Recommended', cheap: 'Cheapest', disc: 'Biggest discount' };

/** A message at the bottom of the map, with an optional button. */
export interface Note { text: string; action?: { label: string; run: () => void } }
