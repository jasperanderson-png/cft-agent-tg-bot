import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The CFT brand files server-drawn pictures use (fuel price tables, work report cards): fonts and the
// logo, in core/brand/. Barlow is the Mini App's font (Latin only); Fira Sans has Russian letters.
// On the server they are read from the checked-out code (core/brand/).

let dir: string | null = null;
/** core/brand/ next to this file when run from source, from the project root when deployed. */
export function brandDir(): string {
  if (dir) return dir;
  for (const d of [join(import.meta.dirname ?? '', 'brand'), join(process.cwd(), 'core/brand')]) {
    if (existsSync(join(d, 'Barlow-Regular.ttf'))) return (dir = d);
  }
  throw new Error('Brand fonts not found (core/brand)');
}

export const brandFile = (name: string) => join(brandDir(), name);

let logo: string | null = null;
/** The CFT logo (white and blue, for dark backgrounds) as an SVG data URI, 366.52 × 43.72. */
export const logoDataUri = () => (logo ??= 'data:image/svg+xml;base64,' + readFileSync(brandFile('cft-primary.svg')).toString('base64'));
export const LOGO_RATIO = 366.52 / 43.72;
