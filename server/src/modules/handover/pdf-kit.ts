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

export interface DocHeader {
  brand: string;
  title: string;
  subtitle?: string | null;
  number?: string | null;
  date?: Date | null;
}

/**
 * The one block that makes every document of ours look like ours: brand line,
 * rule, centred title, optional subtitle, then № and date on one row.
 *
 * Deliberately size-independent — it consumes the same vertical space on A4
 * portrait and landscape, so the bilateral protocol and the consolidated one
 * line up despite different page shapes.
 */
export function drawDocumentHeader(d: Doc, h: DocHeader): void {
  const w = contentW(d);
  const centre = (text: string, size: number, bold: boolean) => {
    const x = MARGIN + (w - d.font.widthOfTextAtSize(text, size)) / 2;
    if (bold) drawBoldText(d, text, x, d.y, size);
    else d.page.drawText(text, { x, y: d.y, size, font: d.font, color: INK });
  };

  // Brand line, left, small caps-ish.
  drawBoldText(d, h.brand, MARGIN, d.y, 10);
  d.y -= 6;
  d.page.drawLine({
    start: { x: MARGIN, y: d.y },
    end: { x: MARGIN + w, y: d.y },
    thickness: 1.2,
    color: INK,
  });
  d.y -= 22;

  centre(h.title, 14, true);
  d.y -= 18;

  if (h.subtitle) {
    centre(h.subtitle, 9, false);
    d.y -= 13;
  }

  // Number and date are independent: the row draws when EITHER is present.
  // An unsaved preview has no number yet, but it still has a date — the day
  // goods changed hands is real information on a приемо-предавателен протокол
  // even before it is numbered, so a bare date is drawn rather than
  // suppressed along with the (still-missing) number.
  if (h.number || h.date) {
    if (h.number) {
      d.page.drawText(`№ ${h.number}`, { x: MARGIN, y: d.y, size: 10, font: d.font, color: INK });
    }
    if (h.date) {
      const right = dateBg(h.date);
      const rw = d.font.widthOfTextAtSize(right, 10);
      d.page.drawText(right, { x: MARGIN + w - rw, y: d.y, size: 10, font: d.font, color: INK });
    }
    d.y -= 18;
  }
}

/**
 * Footer pinned to the foot of the CURRENT page. Does not move the cursor —
 * callers keep laying out body content after calling it.
 */
export function drawDocumentFooter(d: Doc, text: string): void {
  const w = contentW(d);
  const size = 8;
  const x = MARGIN + (w - d.font.widthOfTextAtSize(text, size)) / 2;
  d.page.drawText(text, { x, y: MARGIN - 18, size, font: d.font, color: INK });
}
