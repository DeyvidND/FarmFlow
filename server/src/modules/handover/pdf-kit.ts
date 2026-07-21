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
  /**
   * Called after every page `newPage` creates — NOT for the first page, which
   * `createDoc` makes before any caller can install a hook. `pageIndex` is
   * 0-based over the document, so the first hook call receives 1.
   *
   * Exists because `drawTable` calls `newPage` internally: without this a
   * caller has no way to put a continuation header on the pages its own table
   * generated.
   */
  onNewPage?: (d: Doc, pageIndex: number) => void;
  /**
   * What `onNewPage` consumes from the top of a fresh page. `drawTable`
   * paginates up front, so it must know this to keep later pages' budgets
   * honest — otherwise rows sized for a full page get drawn onto a page whose
   * top is already occupied, and they cross the bottom margin.
   */
  reservedTopOnNewPage: number;
}

export async function createDoc(size: { w: number; h: number }): Promise<Doc> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(FONT_REGULAR);
  const page = doc.addPage([size.w, size.h]);
  return { doc, font, size, page, y: size.h - MARGIN, reservedTopOnNewPage: 0 };
}

export function contentW(d: Doc): number {
  return d.size.w - 2 * MARGIN;
}

export function newPage(d: Doc): void {
  d.page = d.doc.addPage([d.size.w, d.size.h]);
  d.y = d.size.h - MARGIN;
  d.onNewPage?.(d, d.doc.getPageCount() - 1);
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
 * Largest size at or below `nominalSize` — down to a floor of 60% of it —
 * at which `text` fits inside `maxWidth`. pdf-lib glyph widths scale exactly
 * linearly with size, so one measurement at the nominal size gives the exact
 * scale factor needed; no search loop required. Returns `nominalSize`
 * unchanged when the text already fits.
 *
 * This is shrink-to-fit, not wrap: a long title or subtitle that ran wider
 * than the content box used to be measured for centring at a fixed size and
 * then drawn at an x that landed left of MARGIN, bleeding off both edges of
 * the page. Wrapping would fix that too, but the header's height is a
 * deliberate, tested invariant (identical on A4 portrait and landscape) —
 * wrapping would make the height depend on how many lines the title needs,
 * which depends on page width, which breaks that invariant. Shrinking the
 * font keeps the block exactly one line, so the vertical advance below never
 * changes. Below the floor we stop shrinking and draw it oversized anyway —
 * a slightly overset title beats clipping or erroring on a document header.
 */
function fitTextSize(font: PDFFont, text: string, nominalSize: number, maxWidth: number): number {
  const width = font.widthOfTextAtSize(text, nominalSize);
  if (width <= maxWidth) return nominalSize;
  const floor = nominalSize * 0.6;
  return Math.max(nominalSize * (maxWidth / width), floor);
}

/**
 * The one block that makes every document of ours look like ours: brand line,
 * rule, centred title, optional subtitle, then № and date on one row.
 *
 * Deliberately size-independent — it consumes the same vertical space on A4
 * portrait and landscape, so the bilateral protocol and the consolidated one
 * line up despite different page shapes. Title and subtitle shrink to fit
 * (see `fitTextSize`) rather than wrap, so that invariant holds even when a
 * document carries a long title or subtitle.
 */
export function drawDocumentHeader(d: Doc, h: DocHeader): void {
  const w = contentW(d);
  const centre = (text: string, nominalSize: number, bold: boolean) => {
    const size = fitTextSize(d.font, text, nominalSize, w);
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
 * The widest label `stampPageNumbers`'s default formatter is ever expected to
 * draw — three digits each side ("стр. 999 от 999") — plus a small gap.
 * `drawDocumentFooter` reserves this on the right unconditionally (see below).
 */
const FOOTER_PAGE_NUMBER_SAMPLE = 'стр. 999 от 999';
const FOOTER_PAGE_NUMBER_GAP = 10;

/**
 * Footer pinned to the foot of the CURRENT page. Does not move the cursor —
 * callers keep laying out body content after calling it.
 *
 * Lays out inside the content width minus a strip reserved on the right for
 * `stampPageNumbers`'s label, which draws at the same y, right-aligned to the
 * same content edge. Neither function knows the other is ever called, and
 * before this the footer centred across the FULL content width — harmless
 * while every footer string was short, but the footer also carries Bulgarian
 * legal boilerplate, and a long enough sentence would run its right edge
 * straight into the page number.
 *
 * The strip is reserved even on documents that never call
 * `stampPageNumbers`: `drawDocumentFooter` has no way to know whether they
 * will, and a document without page numbers just gets a slightly narrower
 * footer — cheap insurance that removes the coupling entirely rather than
 * relying on both call sites staying short forever.
 *
 * A footer too long for the reduced width shrinks (reusing `fitTextSize`,
 * the same shrink-to-fit `drawDocumentHeader` uses for over-long titles)
 * rather than wrapping — wrapping would change the footer's height, and it is
 * pinned to a fixed y. It stays visually centred WITHIN the reduced area, not
 * centred on the full page and then clipped by the reserve.
 */
export function drawDocumentFooter(d: Doc, text: string): void {
  const reserve = d.font.widthOfTextAtSize(FOOTER_PAGE_NUMBER_SAMPLE, 8) + FOOTER_PAGE_NUMBER_GAP;
  const w = contentW(d) - reserve;
  const size = fitTextSize(d.font, text, 8, w);
  const x = MARGIN + (w - d.font.widthOfTextAtSize(text, size)) / 2;
  d.page.drawText(text, { x, y: MARGIN - 18, size, font: d.font, color: INK });
}

/**
 * Draws „стр. X от Y" at the foot of every page. A post-pass by necessity: the
 * total is not knowable while the pages are being laid out.
 *
 * Does not move the cursor — callers may keep drawing after calling it, though
 * in practice this is the last thing a renderer does.
 */
export function stampPageNumbers(d: Doc, label: (page: number, total: number) => string = (p, t) => `стр. ${p} от ${t}`): void {
  const pages = d.doc.getPages();
  const total = pages.length;
  pages.forEach((page, i) => {
    const text = label(i + 1, total);
    const w = d.font.widthOfTextAtSize(text, 8);
    page.drawText(text, { x: d.size.w - MARGIN - w, y: MARGIN - 18, size: 8, font: d.font, color: INK });
  });
}
