import { strToU8, zipSync } from 'fflate';

/**
 * Minimal, dependency-light XLSX writer (Office Open XML) for clean report workbooks:
 * styled header, frozen first row, autofilter, column widths, dd/mm/yyyy and hh:mm cells.
 * Strings are written as inline strings, so cell text is never evaluated as a formula.
 */

export type Style = 'text' | 'header' | 'date' | 'time' | 'pct' | 'int' | 'dec1' | 'wrap' | 'good' | 'bad' | 'bold' | 'title' | 'muted' | 'center' | 'price' | 'datetime' | 'note';
const STYLE_INDEX: Record<Style, number> = { text: 0, header: 1, date: 2, time: 3, pct: 4, int: 5, dec1: 6, wrap: 7, good: 8, bad: 9, bold: 10, title: 11, muted: 12, center: 13, price: 14, datetime: 15, note: 16 };

export type CellValue = string | number | null | undefined;
export type Cell = CellValue | { v: CellValue; s: Style };

export interface Column {
  header: string;
  width: number;
  style?: Style;
}

export interface SheetSpec {
  name: string;
  columns: Column[];
  rows: Cell[][];
  /** Header row + freeze + autofilter (default true). Set false for free-form sheets. */
  table?: boolean;
  /** Rows written after the table and a blank row, outside the filter (for example a total). */
  footer?: Cell[][];
}

const esc = (s: string) =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function cellXml(ref: string, cell: Cell, colStyle: Style | undefined): string {
  const { v, s } = cell !== null && typeof cell === 'object' ? cell : { v: cell, s: colStyle ?? 'text' };
  const st = STYLE_INDEX[s] ? ` s="${STYLE_INDEX[s]}"` : '';
  if (v === null || v === undefined || v === '') return st ? `<c r="${ref}"${st}/>` : '';
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
  return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
}

function sheetXml(sh: SheetSpec): string {
  const table = sh.table !== false;
  const body: Cell[][] = table ? [sh.columns.map((c) => ({ v: c.header, s: 'header' as Style })), ...sh.rows] : sh.rows;
  const all: Cell[][] = sh.footer?.length ? [...body, [], ...sh.footer] : body;
  const lastCol = colName(Math.max(0, sh.columns.length - 1));
  const rows = all
    .map((r, ri) => {
      const cells = r.map((c, ci) => cellXml(colName(ci) + (ri + 1), c, (ri === 0 && table) || ri >= body.length ? undefined : sh.columns[ci]?.style)).join('');
      const ht = table && ri === 0 ? ' ht="22" customHeight="1"' : '';
      return `<row r="${ri + 1}"${ht}>${cells}</row>`;
    })
    .join('');
  const views = table
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>';
  const cols = `<cols>${sh.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('')}</cols>`;
  const filter = table && body.length > 1 ? `<autoFilter ref="A1:${lastCol}${body.length}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${views}<sheetFormatPr defaultRowHeight="18"/>${cols}<sheetData>${rows}</sheetData>${filter}<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="5"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="hh:mm"/><numFmt numFmtId="166" formatCode="0.0"/><numFmt numFmtId="167" formatCode="&quot;$&quot;0.00##"/><numFmt numFmtId="168" formatCode="dd/mm/yyyy hh:mm"/></numFmts>
<fonts count="5">
<font><sz val="11"/><color rgb="FF1F1F1F"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="16"/><color rgb="FF202C33"/><name val="Calibri"/><family val="2"/></font>
<font><sz val="10"/><color rgb="FF7A7A7A"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF202C33"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFA0DCFF"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDDF3E4"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFCE1DE"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFD0D0D0"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="17">
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="9" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="168" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export function sheetName(raw: string, used: Set<string>): string {
  let n = raw.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || 'Sheet';
  for (let i = 2; used.has(n.toLowerCase()); i++) n = n.slice(0, 28) + ' ' + i;
  used.add(n.toLowerCase());
  return n;
}

export function buildXlsx(sheets: SheetSpec[], title = 'Report'): Uint8Array {
  const used = new Set<string>();
  const names = sheets.map((s) => sheetName(s.name, used));
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    'docProps/core.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>CFT Agent Academy</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${sheets.some((s) => s.table !== false && s.rows.length) ? `<definedNames>${sheets.map((s, i) => (s.table !== false && s.rows.length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(names[i].replace(/'/g, "''"))}'!$A$1:$${colName(s.columns.length - 1)}$${s.rows.length + 1}</definedName>` : '')).join('')}</definedNames>` : ''}</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(STYLES),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s))));
  return zipSync(files, { level: 6 });
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
