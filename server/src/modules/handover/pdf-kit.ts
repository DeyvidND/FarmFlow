import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'fs';
import { join } from 'path';
import { bgDateOf } from '../../common/time/bg-time';

/** Read once at module load — the same file the bilateral renderer has always used. */
const FONT_REGULAR = readFileSync(join(__dirname, '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf'));

export const A4_PORTRAIT = { w: 595, h: 842 };
export const A4_LANDSCAPE = { w: 842, h: 595 };
export const MARGIN = 55;
export const INK = rgb(0.11, 0.1, 0.09);

/**
 * Mutable draw context. `page` and `y` change as content flows, so a page break
 * is `newPage(d)` rather than threading a new cursor through every helper.
 */
export interface Doc {
  doc: PDFDocument;
  font: PDFFont;
  size: { w: number; h: number };
  page: PDFPage;
  y: number;
}

export async function createDoc(size: { w: number; h: number }): Promise<Doc> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(FONT_REGULAR);
  const page = doc.addPage([size.w, size.h]);
  return { doc, font, size, page, y: size.h - MARGIN };
}

export function contentW(d: Doc): number {
  return d.size.w - 2 * MARGIN;
}

export function newPage(d: Doc): void {
  d.page = d.doc.addPage([d.size.w, d.size.h]);
  d.y = d.size.h - MARGIN;
}

/**
 * Break to a new page when `needed` points would run past the bottom margin.
 * Returns whether it broke, so callers can redraw a table's header row.
 */
export function ensureSpace(d: Doc, needed: number): boolean {
  if (d.y - needed >= MARGIN) return false;
  newPage(d);
  return true;
}

/**
 * Emulated bold: the asset set has only DejaVuSans regular, so weight is faked
 * by overdrawing with a small horizontal offset. Two offsets rather than the
 * single 0.4 the bilateral renderer used — at 9pt table-header sizes one pass
 * is almost invisible.
 *
 * THIS IS THE SEAM. If DejaVuSans-Bold.ttf is ever added to assets/fonts,
 * embed it in `createDoc` as `fontBold` and make this one call to drawText —
 * no other file needs to change.
 */
export function drawBoldText(d: Doc, text: string, x: number, y: number, size: number): void {
  for (const dx of [0, 0.25, 0.5]) {
    d.page.drawText(text, { x: x + dx, y, size, font: d.font, color: INK });
  }
}

/** Greedy word-wrap: split `text` into lines no wider than `maxWidth` at `size`. */
export function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= maxWidth || !line) {
      line = next;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Bulgarian short date in Europe/Sofia, e.g. "16.07.2026 г."
 *
 * Goes through bgDateOf rather than Date's local getters: no TZ is set in the
 * Dockerfile or compose, so prod runs UTC while dev machines here run
 * Europe/Sofia — a local-getter bug is right locally and wrong in prod.
 */
export function dateBg(d: Date): string {
  const [year, month, day] = bgDateOf(d).split('-');
  return `${day}.${month}.${year} г.`;
}
