import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The project layout rule (README, "Project layout"): imports only go down.
//   support/commands → telegram_bot → tools → support/helpers / database → support/common
// A tool reads another tool only where listed in TOOL_READS. The Mini App only uses support/common/.
// Tests are exempt: they drive the whole bot through the router on purpose.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Which parts each part may import (besides itself). The support/ folders count as parts of their own. */
const MAY_IMPORT: Record<string, string[]> = {
  commands: ['*'],
  telegram_bot: ['tools', 'helpers', 'database', 'common'],
  mini_app: ['common'],
  tools: ['helpers', 'database', 'common'],
  helpers: ['database', 'common'],
  database: ['helpers', 'common'], // one level with helpers: the connection reads env, helpers read the database
  common: [],
};

/** The one-way reads between tools. */
const TOOL_READS: Record<string, string[]> = { 'driver-map': ['fuel-prices'] };

/** "tools/fuel-prices/x.ts" → part "tools", tool "fuel-prices"; "support/helpers/x.ts" → "helpers"; the Mini App is its own part. */
function partOf(file: string): { part: string; tool?: string } {
  const p = relative(ROOT, file).split(sep);
  if (p[0] === 'telegram_bot' && p[1] === 'mini_app') return { part: 'mini_app' };
  if (p[0] === 'tools') return { part: 'tools', tool: p[1] };
  if (p[0] === 'support') return { part: p[1] };
  return { part: p[0] };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', 'tests', 'public', 'signup-page'].includes(e.name) ? [] : sourceFiles(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

function wrongImports(): string[] {
  const parts = ['support', 'telegram_bot', 'tools', 'database'];
  const bad: string[] = [];
  for (const file of parts.flatMap((p) => sourceFiles(join(ROOT, p)))) {
    const from = partOf(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g)) {
      const to = partOf(resolve(dirname(file), m[1]));
      if (to.part === from.part && to.tool === from.tool) continue;
      const allowed = MAY_IMPORT[from.part] ?? [];
      const ok = allowed.includes('*') || allowed.includes(to.part) || (from.part === 'tools' && to.part === 'tools' && (TOOL_READS[from.tool!] ?? []).includes(to.tool!));
      if (!ok) bad.push(`${relative(ROOT, file).split(sep).join('/')} → ${m[1]}`);
    }
  }
  return bad;
}

describe('project layout', () => {
  it('imports only go down', () => {
    expect(wrongImports()).toEqual([]);
  });
});
