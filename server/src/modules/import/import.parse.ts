import * as Papa from 'papaparse';
import * as ExcelJS from 'exceljs';
import type { RawRow } from './import.types';

/** Canonical column key → accepted header spellings (lowercased, space/punct-stripped). */
export const HEADER_ALIASES: Record<string, string[]> = {
  name: ['получател', 'име', 'name', 'recipient', 'клиент'],
  phone: ['телефон', 'тел', 'phone', 'gsm'],
  mode: ['доставка', 'режим', 'mode', 'delivery', 'типдоставка'],
  city: ['град', 'населеномясто', 'city', 'town'],
  office: ['офис', 'office', 'офискод'],
  address: ['адрес', 'address', 'улица'],
  weight: ['тегло', 'теглокг', 'weight', 'kg'],
  contents: ['съдържание', 'contents', 'описание'],
  cod: ['наложенплатеж', 'нп', 'cod', 'наложен'],
  declared: ['обявенастойност', 'declared', 'застраховка'],
  carrier: ['куриер', 'carrier', 'превозвач'],
};

/** Normalize a header cell for matching: lowercase, strip spaces + punctuation. */
function normHeader(h: string): string {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[\s./_-]+/g, '')
    .trim();
}

/** Build header-index → canonical-key map. Unknown headers are dropped. */
function mapHeaders(headers: string[]): (string | null)[] {
  return headers.map((h) => {
    const n = normHeader(h);
    for (const [canon, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(n)) return canon;
    }
    return null;
  });
}

function rowFromCells(cells: string[], keys: (string | null)[]): RawRow | null {
  const row: RawRow = {};
  let hasValue = false;
  keys.forEach((k, i) => {
    if (!k) return;
    const v = (cells[i] ?? '').toString().trim();
    if (v) hasValue = true;
    row[k] = v;
  });
  return hasValue ? row : null;
}

/** Parse an uploaded .csv/.xlsx buffer into canonical header-keyed rows. */
export async function parseFile(buffer: Buffer, fileName: string): Promise<RawRow[]> {
  const isXlsx = /\.xlsx$/i.test(fileName);
  if (isXlsx) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const rows: string[][] = [];
    ws.eachRow((r) => {
      const cells: string[] = [];
      // exceljs is 1-indexed; values[0] is unused.
      const values = Array.isArray(r.values) ? r.values.slice(1) : [];
      for (const v of values) cells.push(v == null ? '' : String(v));
      rows.push(cells);
    });
    if (!rows.length) return [];
    const keys = mapHeaders(rows[0]);
    return rows.slice(1).map((c) => rowFromCells(c, keys)).filter((r): r is RawRow => r != null);
  }
  // CSV
  const text = buffer.toString('utf8');
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
  const data = (parsed.data ?? []).filter((r) => Array.isArray(r));
  if (!data.length) return [];
  const keys = mapHeaders(data[0]);
  return data.slice(1).map((c) => rowFromCells(c, keys)).filter((r): r is RawRow => r != null);
}
