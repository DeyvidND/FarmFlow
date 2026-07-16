import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'fs';
import { join } from 'path';

const FONT = readFileSync(join(__dirname, '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf'));

export const PAGE_W = 595; // A4
export const PAGE_H = 842;
export const MARGIN = 55;
export const CONTENT_W = PAGE_W - 2 * MARGIN;
const INK = rgb(0.11, 0.1, 0.09);
const BODY_SIZE = 11;
const BODY_LH = BODY_SIZE + 5;

/** Bulgarian short date, e.g. "16.07.2026 г." */
function dateBg(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()} г.`;
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
 * Party descriptor for the prose sentence:
 * `Име (ЕИК …)` or `Име (рег.№ …)`, plus `, адрес …` when present. `withId=false`
 * (a customer) prints only the name + address — customers carry no ЕИК/рег.№.
 */
export function descriptor(p: any, withId: boolean): string {
  let out = String(p?.name ?? '—');
  if (withId) {
    const id = p?.eik ? `ЕИК ${p.eik}` : p?.regNo ? `рег.№ ${p.regNo}` : null;
    if (id) out += ` (${id})`;
  }
  if (p?.address) out += `, адрес ${p.address}`;
  return out;
}

export interface ProtocolText {
  title: string;
  number: string | null;
  sentence: string;
  itemLines: string[];
  footer: string;
  fromName: string;
  toName: string;
}

/**
 * Pure text composition for a handover protocol — everything printable derived
 * from the frozen row, no drawing. Kind-aware: farmer leg →
 * „ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ" with legal ids on both parties; customer leg →
 * „РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА" with the customer (no id) as receiver. Order
 * numbers come from `row.meta.orderNumbers`; absent (old rows) → the „поръчки №"
 * fragment is dropped. `itemLines` includes 2 dotted continuation slots for
 * hand-written additions on the round.
 */
export function composeProtocol(row: any): ProtocolText {
  const isCustomer = row.kind === 'operator_to_customer';
  const when = dateBg(new Date(row.signedAt ?? row.createdAt ?? Date.now()));
  const fromDesc = descriptor(row.fromSnapshot, true);
  const toDesc = descriptor(row.toSnapshot, !isCustomer);

  const orderNums: number[] | undefined = row.meta?.orderNumbers;
  const nums = orderNums?.length ? orderNums.join(', ') : null;
  const reason = isCustomer
    ? nums
      ? `във връзка с поръчка № ${nums}`
      : 'във връзка с направената поръчка'
    : nums
      ? `във връзка с доставка на селскостопанска продукция по поръчки № ${nums}`
      : 'във връзка с доставка на селскостопанска продукция';

  const items: any[] = row.items ?? [];
  const itemLines = items.map((it, i) => {
    const variant = it.variantLabel ? ` · ${it.variantLabel}` : '';
    const qty = `${it.quantity}${it.unit ? ` ${it.unit}` : ''}`;
    return `${i + 1}. ${it.productName}${variant} — ${qty}`;
  });

  const noun = isCustomer ? 'Настоящата разписка' : 'Настоящият протокол';

  return {
    title: isCustomer ? 'РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА' : 'ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ',
    number: row.protocolNumber != null ? `№ ${row.protocolNumber}` : null,
    sentence: `Днес, ${when}, ${fromDesc} предаде на ${toDesc}, ${reason}, долуописаните стоки:`,
    itemLines,
    footer: `${noun} се състави в два еднообразни екземпляра — по един за всяка страна.`,
    fromName: String(row.fromSnapshot?.name ?? ''),
    toName: String(row.toSnapshot?.name ?? ''),
  };
}

export async function renderProtocolPdf(row: any): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(FONT);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const t = composeProtocol(row);

  let y = PAGE_H - 70;
  const drawLeft = (text: string, x: number, size = BODY_SIZE, lh = BODY_LH) => {
    for (const l of wrap(text, font, size, CONTENT_W - (x - MARGIN))) {
      page.drawText(l, { x, y, size, font, color: INK });
      y -= lh;
    }
  };
  const drawCentered = (text: string, size: number) => {
    const w = font.widthOfTextAtSize(text, size);
    return { x: (PAGE_W - w) / 2, w };
  };

  // ── Title (centered, faux-bold, underlined) ──────────────────────────────
  const titleSize = 16;
  const { x: titleX, w: titleW } = drawCentered(t.title, titleSize);
  page.drawText(t.title, { x: titleX, y, size: titleSize, font, color: INK });
  page.drawText(t.title, { x: titleX + 0.4, y, size: titleSize, font, color: INK }); // faux-bold
  page.drawLine({ start: { x: titleX, y: y - 4 }, end: { x: titleX + titleW, y: y - 4 }, thickness: 1, color: INK });
  y -= titleSize + 8;

  if (t.number) {
    const { x } = drawCentered(t.number, 11);
    page.drawText(t.number, { x, y, size: 11, font, color: INK });
    y -= 11 + 6;
  }
  y -= 14;

  // ── Prose opening sentence ───────────────────────────────────────────────
  drawLeft(t.sentence, MARGIN);
  y -= 10;

  // ── Numbered inventory + 2 dotted continuation lines ─────────────────────
  const itemX = MARGIN + 6;
  for (const line of t.itemLines) drawLeft(line, itemX);
  const dot = font.widthOfTextAtSize('.', BODY_SIZE);
  for (let k = 0; k < 2; k++) {
    const prefix = `${t.itemLines.length + 1 + k}. `;
    const room = CONTENT_W - 6 - font.widthOfTextAtSize(prefix, BODY_SIZE);
    page.drawText(prefix + '.'.repeat(Math.max(0, Math.floor(room / dot))), { x: itemX, y, size: BODY_SIZE, font, color: INK });
    y -= BODY_LH;
  }
  y -= 12;

  // ── Two-copies footer ────────────────────────────────────────────────────
  drawLeft(t.footer, MARGIN, 10, 15);

  // ── Signature blocks (fixed near the foot) ───────────────────────────────
  const sigY = Math.min(y - 40, 150);
  await sigBlock(doc, page, font, MARGIN, sigY, 'Предал', t.fromName, row.fromSignaturePng);
  await sigBlock(doc, page, font, PAGE_W / 2 + 10, sigY, 'Приел', t.toName, row.toSignaturePng);

  return Buffer.from(await doc.save());
}

async function sigBlock(
  doc: PDFDocument,
  page: PDFPage,
  font: PDFFont,
  x: number,
  y: number,
  label: string,
  name: string | null | undefined,
  png: string | null,
) {
  const nameX = x + font.widthOfTextAtSize(`${label}: `, 10);
  page.drawText(`${label}: ______________________`, { x, y, size: 10, font, color: INK });
  if (name) {
    page.drawText(String(name), { x: nameX, y: y - 13, size: 9, font, color: INK });
  }
  if (png) {
    try {
      const bytes = Buffer.from(png.split(',').pop()!, 'base64');
      const img = await doc.embedPng(bytes);
      page.drawImage(img, { x: nameX, y: y + 4, width: 110, height: 36 });
    } catch {
      // Malformed/corrupt signature data — fall back to the blank line drawn above.
    }
  }
}
