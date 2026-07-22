import type { PDFImage } from 'pdf-lib';
import {
  A4_LANDSCAPE, contentW, Doc, INK, MARGIN, newPage,
  createDoc, drawBoldText, drawDocumentFooter, drawDocumentHeader, ensureSpace, stampPageNumbers, wrap,
} from './pdf-kit';
import { drawTable, columnWidths, type Cell, type Column, type PlacedRow } from './pdf-table';
import type { ConsolidatedFarmerRow, ConsolidatedOrderRow, ConsolidatedProtocolView } from './consolidated-protocol.service';
import type { ProtocolItemDto } from './dto/create-protocol.dto';

const itemsLine = (items: ProtocolItemDto[]): string =>
  items.map((it) => `${it.productName}${it.variantLabel ? ' · ' + it.variantLabel : ''} — ${it.quantity}${it.unit ?? ''}`).join('; ');

// Column widths computed from the landscape content width so the total is
// always exact (drawTable throws on a mismatch) regardless of A4_LANDSCAPE's
// literal value — weights, not pixels, are the source of truth.
const FARMER_COL_WEIGHTS = [1, 6, 11, 3, 3];
export const FARMER_COLUMNS: Column[] = (() => {
  const total = A4_LANDSCAPE.w - 2 * MARGIN;
  const [num, name, items, batch, eDoc] = columnWidths(total, FARMER_COL_WEIGHTS);
  return [
    { header: '№', width: num, align: 'right' },
    { header: 'Фермер', width: name },
    { header: 'Продукти и количества', width: items },
    { header: 'Партида', width: batch },
    { header: 'Е-док.', width: eDoc },
  ];
})();

/** Pure: farmer rows → drawTable cells. 1-based row numbers in column 0 are
 *  what the §3.6 signature strip (Task 8) matches against PlacedRow's own
 *  input-order index — keep this ordering and drawTable's row order identical. */
export function buildFarmerTableRows(farmers: ConsolidatedFarmerRow[]): Cell[][] {
  return farmers.map((f, i) => [String(i + 1), f.name, itemsLine(f.items), f.batch ?? '', f.eDoc ?? '']);
}

/** Pre-embeds every farmer's saved signature as a PDFImage (or null) BEFORE
 *  drawing — pdf-lib's embedPng is async, and drawFarmerSignatureStrip below
 *  must stay a plain synchronous draw pass over already-resolved images
 *  (matches how pdf-table's own ImageCell is always pre-embedded). Malformed
 *  signature data falls back to null (a blank line), never a thrown error. */
export async function embedFarmerSignatures(d: Doc, farmers: ConsolidatedFarmerRow[]): Promise<(PDFImage | null)[]> {
  const out: (PDFImage | null)[] = [];
  for (const f of farmers) {
    if (!f.signaturePng) { out.push(null); continue; }
    try {
      const bytes = Buffer.from(f.signaturePng.split(',').pop()!, 'base64');
      out.push(await d.doc.embedPng(bytes));
    } catch {
      out.push(null);
    }
  }
  return out;
}

const CHIP_W = 130;
const CHIP_H = 30;
const CHIP_GAP = 8;

/** §3.6: one strip per PAGE the farmer table actually spans (grouped by
 *  `placed[i].pageIndex`), positioned right below that page's own rows —
 *  never one strip at the very end, which would separate a page-1 farmer's
 *  row from their signature by every later page. `farmers`/`images` must be
 *  in the SAME order `placed` was produced from (drawTable's input order) —
 *  `placed[i]` corresponds to `farmers[i]`/`images[i]`. */
export function drawFarmerSignatureStrip(
  d: Doc,
  placed: PlacedRow[],
  farmers: ConsolidatedFarmerRow[],
  images: (PDFImage | null)[],
): void {
  const byPage = new Map<number, number[]>();
  placed.forEach((p, i) => {
    const list = byPage.get(p.pageIndex) ?? [];
    list.push(i);
    byPage.set(p.pageIndex, list);
  });

  const pages = d.doc.getPages();
  const perRow = Math.max(1, Math.floor((contentW(d) + CHIP_GAP) / (CHIP_W + CHIP_GAP)));

  for (const pageIndex of [...byPage.keys()].sort((a, b) => a - b)) {
    const indices = byPage.get(pageIndex)!;
    d.page = pages[pageIndex];
    d.y = Math.min(...indices.map((i) => placed[i].y)) - 14;

    const rowsNeeded = Math.ceil(indices.length / perRow);
    const stripHeight = rowsNeeded * (CHIP_H + 16) + 10;
    if (d.y - stripHeight < MARGIN) newPage(d); // strip continues on a fresh page when the source page has no room left

    indices.forEach((rowIdx, i) => {
      const col = i % perRow;
      const line = Math.floor(i / perRow);
      const x = MARGIN + col * (CHIP_W + CHIP_GAP);
      const y = d.y - line * (CHIP_H + 16);
      d.page.drawText(`${rowIdx + 1}. ${farmers[rowIdx].name}`, { x, y, size: 7.5, font: d.font, color: INK });
      const img = images[rowIdx];
      if (img) {
        d.page.drawImage(img, { x, y: y - 28, width: 90, height: 26 });
      } else {
        d.page.drawLine({ start: { x, y: y - 8 }, end: { x: x + CHIP_W - 10, y: y - 8 }, thickness: 0.5, color: INK });
      }
    });
    d.y -= rowsNeeded * (CHIP_H + 16) + 10;
  }
}

const ORDER_COL_WEIGHTS = [2, 3, 3, 10, 2];
export const ORDER_COLUMNS: Column[] = (() => {
  const total = A4_LANDSCAPE.w - 2 * MARGIN;
  const [num, code, city, items, total_] = columnWidths(total, ORDER_COL_WEIGHTS);
  return [
    { header: '№ поръчка', width: num },
    { header: 'Код клиент', width: code },
    { header: 'Град/зона', width: city },
    { header: 'Продукти и количества', width: items },
    { header: 'Стойност', width: total_, align: 'right' },
  ];
})();

function moneyStr(stotinki: number): string {
  return `${(stotinki / 100).toFixed(2)} лв.`;
}

/** Pure: order rows → drawTable cells. Deliberately carries NO customer name,
 *  phone, or exact address — spec §3.7 keeps that on the driver's protected
 *  route list only; this document shows just order №, a zero-PII customer
 *  code, and the city/zone. */
export function buildOrderTableRows(orders: ConsolidatedOrderRow[]): Cell[][] {
  return orders.map((o) => [
    o.orderNumber != null ? `№ ${o.orderNumber}` : '—',
    o.customerCode,
    o.cityOrZone ?? '—',
    itemsLine(o.items),
    moneyStr(o.totalStotinki),
  ]);
}

/** Verbatim per spec §3.7 — matches the wording already established for the
 *  screen "Проверка"/bilateral-receipt precinct: full name/phone/address
 *  live ONLY in the driver's protected route list, never on this document. */
export const PRIVACY_NOTE =
  'Име, телефон и точен адрес на клиента се съхраняват само в защитения маршрутен списък на превозвача.';

function drawSectionTitle(d: Doc, text: string): void {
  ensureSpace(d, 26);
  drawBoldText(d, text, MARGIN, d.y, 12);
  d.y -= 20;
}

/**
 * Full consolidated (day/leg) handover-protocol render: header (own ОБ-<n>
 * series, chernova subtitle while draft) → section А (farmers + cargo, with
 * the §3.6 signature-by-row strip) → section Б (orders, no PII, + the §3.7
 * privacy note) → section В (transport-operator acceptance: manual meta
 * fields + the receiver's signature) → footer/page numbers. Matches the
 * bilateral renderer's (handover-pdf.ts) house style: same header/footer
 * primitives, same faux-bold, same brand-from-tenant-name source.
 */
export async function renderConsolidatedProtocolPdf(view: ConsolidatedProtocolView, brand: string): Promise<Buffer> {
  const d = await createDoc(A4_LANDSCAPE);
  const title =
    view.scope === 'day'
      ? 'ОБОБЩЕН ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ'
      : `ОБОБЩЕН ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ — ЛЕГ ${(view.legIndex ?? 0) + 1}`;

  drawDocumentHeader(d, {
    brand,
    title,
    subtitle: view.status === 'draft' ? 'чернова — подлежи на промяна' : null,
    number: `ОБ-${view.docNumber}`,
    date: new Date(view.date),
  });

  drawSectionTitle(d, 'А. Фермери и приет товар');
  const farmerRows = buildFarmerTableRows(view.rows.farmers);
  const sectionAImages = await embedFarmerSignatures(d, view.rows.farmers);
  const placedA = drawTable(d, FARMER_COLUMNS, farmerRows);
  drawFarmerSignatureStrip(d, placedA, view.rows.farmers, sectionAImages);
  d.y -= 16;

  drawSectionTitle(d, 'Б. Разпределение по поръчки');
  drawTable(d, ORDER_COLUMNS, buildOrderTableRows(view.rows.orders));
  d.y -= 8;
  ensureSpace(d, 22);
  for (const l of wrap(PRIVACY_NOTE, d.font, 8, contentW(d))) {
    d.page.drawText(l, { x: MARGIN, y: d.y, size: 8, font: d.font, color: INK });
    d.y -= 11;
  }
  d.y -= 12;

  drawSectionTitle(d, 'В. Приемане от транспортния оператор');
  ensureSpace(d, 90);
  const m = view.meta;
  const line = (text: string) => {
    ensureSpace(d, 16);
    d.page.drawText(text, { x: MARGIN, y: d.y, size: 10, font: d.font, color: INK });
    d.y -= 16;
  };
  line(`Возило: ${m.vehicle ?? '—'}    Рег. №: ${m.plate ?? '—'}`);
  line(`Тръгва от: ${m.startPlace ?? '—'} в ${m.startTime ?? '—'} ч.    Очаквано приключване: ${m.plannedEnd ?? '—'}`);
  d.y -= 10;
  ensureSpace(d, 44);
  d.page.drawText(`Приел за транспорт: ${m.driverName ?? '______________________'}`, { x: MARGIN, y: d.y, size: 10, font: d.font, color: INK });
  if (view.receiverSignaturePng) {
    try {
      const bytes = Buffer.from(view.receiverSignaturePng.split(',').pop()!, 'base64');
      const img = await d.doc.embedPng(bytes);
      d.page.drawImage(img, { x: MARGIN + 230, y: d.y - 4, width: 110, height: 36 });
    } catch {
      // malformed signature data — the blank label above stands alone
    }
  }
  d.y -= 40;

  drawDocumentFooter(d, `Документът е издаден електронно от ${brand}.`);
  if (d.doc.getPageCount() > 1) stampPageNumbers(d);

  return Buffer.from(await d.doc.save());
}
