import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'fs';
import { join } from 'path';
import { bgDateOf } from '../../common/time/bg-time';
import { cityFromAddress } from './handover-city';

const FONT = readFileSync(join(__dirname, '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf'));

export const PAGE_W = 595; // A4
export const PAGE_H = 842;
export const MARGIN = 55;
export const CONTENT_W = PAGE_W - 2 * MARGIN;
const INK = rgb(0.11, 0.1, 0.09);
const BODY_SIZE = 11;
const BODY_LH = BODY_SIZE + 5;

/**
 * Bulgarian short date in Europe/Sofia, e.g. "16.07.2026 г."
 *
 * Goes through bgDateOf rather than Date's local getters: no TZ is set in the
 * Dockerfile or compose, so prod runs UTC while every dev machine here runs
 * Europe/Sofia. `d.getDate()` was therefore right locally and wrong in prod —
 * a протокол signed at 01:30 Sofia (22:30Z the day before) printed yesterday's
 * date on a legal document.
 */
function dateBg(d: Date): string {
  const [year, month, day] = bgDateOf(d).split('-');
  return `${day}.${month}.${year} г.`;
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

export interface PartyText {
  role: string; // 'ПРЕДАВА:' | 'ПРИЕМА:'
  name: string;
  idLine: string | null; // 'ЕИК 203912345' | 'рег.№ …' | null
  address: string | null;
  phone: string | null;
  email: string | null;
}

export interface ProtocolText {
  title: string;
  number: string | null;
  opening: string; // 'Днес, 20.07.2026 г., в гр. Варна, между:'
  from: PartyText;
  to: PartyText;
  intro: string; // 'се състави настоящият приемо-предавателен протокол за долуописаните стоки:'
  itemLines: string[];
  footer: string;
  fromName: string;
  toName: string;
}

/** ЕИК / рег.№ line for a party (skipped for a customer / no id). */
function idLineOf(p: any, withId: boolean): string | null {
  if (!withId) return null;
  if (p?.eik) return `ЕИК ${p.eik}`;
  if (p?.regNo) return `рег.№ ${p.regNo}`;
  return null;
}

function partyText(p: any, role: string, withId: boolean): PartyText {
  return {
    role,
    name: String(p?.name ?? '—'),
    idLine: idLineOf(p, withId),
    address: p?.address ? String(p.address) : null,
    phone: p?.phone ? String(p.phone) : null,
    email: p?.email ? String(p.email) : null,
  };
}

/**
 * Pure text composition for a handover protocol — everything printable derived
 * from the frozen row, no drawing. Kind-aware: farmer leg →
 * „ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ" with legal ids on both parties; customer leg →
 * „РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА" with the customer (no id) as receiver. Matches
 * the structure of the customer's real bilateral .doc: title → № → opening →
 * ПРЕДАВА/ПРИЕМА party blocks → intro → numbered items → footer → signatures.
 * A line with no value (no phone, no address, …) is simply omitted — never
 * rendered as an empty labelled field. `itemLines` includes 2 dotted
 * continuation slots for hand-written additions on the round (added at draw
 * time, not here — this stays pure text of the actual items).
 */
export function composeProtocol(row: any): ProtocolText {
  const isCustomer = row.kind === 'operator_to_customer';
  const when = dateBg(new Date(row.signedAt ?? row.createdAt ?? Date.now()));

  // Operator is the receiver on a farmer leg, the sender on a customer leg.
  const operatorSnap = isCustomer ? row.fromSnapshot : row.toSnapshot;
  const city = cityFromAddress(operatorSnap?.address);
  const cityClause = city ? `, в ${city.prefix} ${city.name}` : '';

  const from = partyText(row.fromSnapshot, 'ПРЕДАВА:', true);
  const to = partyText(row.toSnapshot, 'ПРИЕМА:', !isCustomer);

  const items: any[] = row.items ?? [];
  const itemLines = items.map((it, i) => {
    const variant = it.variantLabel ? ` · ${it.variantLabel}` : '';
    const qty = `${it.quantity}${it.unit ? ` ${it.unit}` : ''}`;
    return `${i + 1}. ${it.productName}${variant} — ${qty}`;
  });

  const docNoun = isCustomer ? 'настоящата разписка за получена стока' : 'настоящият приемо-предавателен протокол';

  return {
    title: isCustomer ? 'РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА' : 'ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ',
    number: row.protocolNumber != null ? `№ ${row.protocolNumber}` : null,
    opening: `Днес, ${when}${cityClause}, между:`,
    from,
    to,
    intro: `се състави ${docNoun} за долуописаните стоки:`,
    itemLines,
    footer: `${isCustomer ? 'Настоящата разписка' : 'Настоящият протокол'} се състави в два еднообразни екземпляра — по един за всяка страна.`,
    fromName: from.name,
    toName: to.name,
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
  /** Draws `text` centered on the page at the current `size` and current `y`; returns its box. */
  const drawCentered = (text: string, size: number) => {
    const w = font.widthOfTextAtSize(text, size);
    const x = (PAGE_W - w) / 2;
    page.drawText(text, { x, y, size, font, color: INK });
    return { x, w };
  };

  // ── Title (centered, faux-bold, underlined) ──────────────────────────────
  const titleSize = 16;
  const { x: titleX, w: titleW } = drawCentered(t.title, titleSize);
  page.drawText(t.title, { x: titleX + 0.4, y, size: titleSize, font, color: INK }); // faux-bold overlay
  page.drawLine({ start: { x: titleX, y: y - 4 }, end: { x: titleX + titleW, y: y - 4 }, thickness: 1, color: INK });
  y -= titleSize + 8;

  if (t.number) {
    drawCentered(t.number, 11);
    y -= 11 + 6;
  }
  y -= 10;

  // ── Opening line ("Днес, <дата>[, в гр. X], между:") ──────────────────────
  drawLeft(t.opening, MARGIN);
  y -= 10;

  // ── ПРЕДАВА party, centered „и", ПРИЕМА party ─────────────────────────────
  y = drawParty(page, font, MARGIN, y, t.from);
  y -= 6;
  drawCentered('и', 12);
  y -= 12 + 6;
  y = drawParty(page, font, MARGIN, y, t.to);
  y -= 4;

  // ── Intro line ─────────────────────────────────────────────────────────
  drawLeft(t.intro, MARGIN);
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

/**
 * Draws one ПРЕДАВА/ПРИЕМА party block (role, name in faux-bold, then whichever
 * of idLine/address/contact the party actually has — a field with no value is
 * simply never drawn, never printed as an empty labelled line). Returns the
 * cursor `y` after the block so the caller can keep laying out below it.
 */
function drawParty(page: PDFPage, font: PDFFont, x: number, startY: number, p: PartyText): number {
  let y = startY;
  const line = (text: string, size = BODY_SIZE, bold = false) => {
    page.drawText(text, { x, y, size, font, color: INK });
    if (bold) page.drawText(text, { x: x + 0.4, y, size, font, color: INK });
    y -= BODY_LH;
  };
  line(p.role, BODY_SIZE, true);
  line(p.name, BODY_SIZE, true);
  if (p.idLine) line(p.idLine);
  if (p.address) {
    for (const l of wrap(`адрес: ${p.address}`, font, BODY_SIZE, CONTENT_W)) {
      page.drawText(l, { x, y, size: BODY_SIZE, font, color: INK });
      y -= BODY_LH;
    }
  }
  const contact = [p.phone && `тел.: ${p.phone}`, p.email && `e-mail: ${p.email}`].filter(Boolean).join('   ');
  if (contact) line(contact);
  return y;
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
