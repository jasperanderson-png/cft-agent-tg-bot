export interface CsvColumn<T> {
  label: string;
  get: (row: T) => unknown;
}

/**
 * RFC 4180 quoting, plus protection against spreadsheet formula injection: text starting with
 * = + - @ (or a tab/CR) is prefixed with an apostrophe so Excel/Sheets treat it as text.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) || s.startsWith("'") ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCSV<T>(cols: readonly CsvColumn<T>[], rows: readonly T[]): string {
  return [cols.map((c) => csvCell(c.label)).join(','), ...rows.map((r) => cols.map((c) => csvCell(c.get(r))).join(','))].join('\r\n');
}

/**
 * Text of an uploaded file. UTF-8 and UTF-16 (Excel's "Unicode text") are read as such. Anything
 * else is a Windows "ANSI" file, where runs of high bytes are Cyrillic words (windows-1251) and
 * lone ones are accented Latin letters (windows-1252).
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    let runs = 0;
    let lone = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0xc0) bytes[i - 1] >= 0xc0 || bytes[i + 1] >= 0xc0 ? runs++ : lone++;
    return new TextDecoder(runs > lone ? 'windows-1251' : 'windows-1252').decode(bytes);
  }
}

/** The separator a file uses: Excel writes ";" under many regional settings, and tabs for "Unicode text". */
export function csvDelimiter(text: string): string {
  const header = text.split(/\r\n|\n|\r/, 1)[0].replace(/"[^"]*"/g, '');
  const count = (d: string) => header.split(d).length - 1;
  return [',', ';', '\t', '|'].reduce((best, d) => (count(d) > count(best) ? d : best));
}

/** Parses RFC 4180 CSV (quoted fields, embedded newlines, CRLF or LF, optional BOM) into rows of cells. */
export function parseCSV(text: string, delimiter?: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  const sep = delimiter ?? csvDelimiter(src);
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** CSV rows as objects keyed by the header row. */
export function csvObjects(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCSV(text);
  if (!header) return [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()]).filter(([h]) => h)));
}

export function csvFilename(kind: string, date = new Date()): string {
  return `cft-agent-academy_${kind}_${date.toISOString().slice(0, 10)}.csv`;
}
