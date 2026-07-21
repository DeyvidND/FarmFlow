import { cityFromAddress } from './handover-city';
import {
  A4_PORTRAIT,
  Doc,
  MARGIN,
  INK,
  contentW,
  createDoc,
  dateBg,
  drawBoldText,
  drawDocumentFooter,
  drawDocumentHeader,
  ensureSpace,
  wrap,
} from './pdf-kit';

// Geometry now lives in pdf-kit; these stay for this file's own layout maths.
const PAGE_W = A4_PORTRAIT.w;
// CONTENT_W and wrap ARE imported elsewhere (handover-pdf.spec.ts) — keep them exported.
export const CONTENT_W = PAGE_W - 2 * MARGIN;
export { wrap };

const BODY_SIZE = 11;
const BODY_LH = BODY_SIZE + 5;

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
 * „по поръчка № 101" / „по поръчки № 101, 102" fragment for the intro line —
 * singular for exactly one order, plural for 2+, empty when the row carries
 * no order numbers (old rows, or `meta` absent entirely) so the intro falls
 * back to the plain „…за долуописаните стоки:" with no dangling „по поръчки №".
 */
function orderNumbersFragment(row: any): string {
  const nums: number[] = row?.meta?.orderNumbers ?? [];
  if (!nums.length) return '';
  const word = nums.length === 1 ? 'поръчка' : 'поръчки';
  return ` по ${word} № ${nums.join(', ')}`;
}

/**
 * Pure text composition for a handover protocol — everything printable derived
 * from the frozen row, no drawing. Kind-aware: farmer leg →
 * „ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ" with legal ids on both parties; customer leg →
 * „РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА" with the customer (no id) as receiver. Matches
 * the structure of the customer's real bilateral .doc: title → № → opening →
 * ПРЕДАВА/ПРИЕМА party blocks → intro → numbered items → footer → signatures.
 * The intro cites `row.meta.orderNumbers` (the orders this protocol covers)
 * when present; absent/empty (old rows) → the „по поръчки №" fragment is
 * dropped. A line with no value (no phone, no address, …) is simply omitted —
 * never rendered as an empty labelled field. `itemLines` includes 2 dotted
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
  const orderFragment = orderNumbersFragment(row);

  return {
    title: isCustomer ? 'РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА' : 'ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ',
    number: row.protocolNumber != null ? `№ ${row.protocolNumber}` : null,
    opening: `Днес, ${when}${cityClause}, между:`,
    from,
    to,
    intro: `се състави ${docNoun}${orderFragment} за долуописаните стоки:`,
    itemLines,
    footer: `${isCustomer ? 'Настоящата разписка' : 'Настоящият протокол'} се състави в два еднообразни екземпляра — по един за всяка страна.`,
    fromName: from.name,
    toName: to.name,
  };
}

export async function renderProtocolPdf(row: any): Promise<Buffer> {
  const d = await createDoc(A4_PORTRAIT);
  const t = composeProtocol(row);
  const operatorSnap = row.kind === 'operator_to_customer' ? row.fromSnapshot : row.toSnapshot;
  const brand = String(operatorSnap?.name ?? 'ФермериБГ');

  drawDocumentHeader(d, {
    brand,
    title: t.title,
    number: row.protocolNumber != null ? String(row.protocolNumber) : null,
    date: new Date(row.signedAt ?? row.createdAt ?? Date.now()),
  });

  const drawLeft = (text: string, x: number, size = BODY_SIZE, lh = BODY_LH) => {
    for (const l of wrap(text, d.font, size, contentW(d) - (x - MARGIN))) {
      ensureSpace(d, lh);
      d.page.drawText(l, { x, y: d.y, size, font: d.font, color: INK });
      d.y -= lh;
    }
  };

  drawLeft(t.opening, MARGIN);
  d.y -= 10;

  drawParty(d, MARGIN, t.from);
  d.y -= 6;
  ensureSpace(d, 18);
  const iW = d.font.widthOfTextAtSize('и', 12);
  d.page.drawText('и', { x: MARGIN + (contentW(d) - iW) / 2, y: d.y, size: 12, font: d.font, color: INK });
  d.y -= 18;
  drawParty(d, MARGIN, t.to);
  d.y -= 4;

  drawLeft(t.intro, MARGIN);
  d.y -= 10;

  const itemX = MARGIN + 6;
  for (const line of t.itemLines) drawLeft(line, itemX);

  const dot = d.font.widthOfTextAtSize('.', BODY_SIZE);
  for (let k = 0; k < 2; k++) {
    const prefix = `${t.itemLines.length + 1 + k}. `;
    const room = contentW(d) - 6 - d.font.widthOfTextAtSize(prefix, BODY_SIZE);
    ensureSpace(d, BODY_LH);
    d.page.drawText(prefix + '.'.repeat(Math.max(0, Math.floor(room / dot))), {
      x: itemX, y: d.y, size: BODY_SIZE, font: d.font, color: INK,
    });
    d.y -= BODY_LH;
  }
  d.y -= 12;

  drawLeft(t.footer, MARGIN, 10, 15);

  // Signature blocks need ~90pt; ensureSpace breaks the page rather than let a
  // long item list run straight through them (the bug the old code had, since
  // it only ever clamped to a fixed y and never checked remaining room). The
  // Math.min then restores what that old clamp got right: for the common
  // short protocol, anchor the blocks near the foot of the page — like a real
  // paper form — instead of floating them immediately under a couple of lines
  // of content. SIG_FOOT_Y leaves ~95pt above MARGIN, enough for the label,
  // the party name below it, and a signature image drawn up to 36pt above the
  // label, with room to spare before the footer.
  ensureSpace(d, 90);
  const SIG_FOOT_Y = 150;
  const sigY = Math.min(d.y - 20, SIG_FOOT_Y);
  await sigBlock(d, MARGIN, sigY, 'ПРЕДАЛ', t.fromName, row.fromSignaturePng);
  await sigBlock(d, PAGE_W / 2 + 10, sigY, 'ПРИЕЛ', t.toName, row.toSignaturePng);
  d.y = sigY - 40;

  // Same brand source as the header — a tenant whose operator isn't ФермериБГ
  // should not see two different issuers named on the same document.
  drawDocumentFooter(d, `Документът е издаден електронно от ${brand}.`);

  return Buffer.from(await d.doc.save());
}

/**
 * Draws one ПРЕДАВА/ПРИЕМА party block (role, name in faux-bold, then whichever
 * of idLine/address/contact the party actually has — a field with no value is
 * simply never drawn, never printed as an empty labelled line). Breaks pages
 * as needed via `ensureSpace`, same as every other block in this renderer.
 */
function drawParty(d: Doc, x: number, p: PartyText): void {
  const line = (text: string, size = BODY_SIZE, bold = false) => {
    ensureSpace(d, BODY_LH);
    if (bold) drawBoldText(d, text, x, d.y, size);
    else d.page.drawText(text, { x, y: d.y, size, font: d.font, color: INK });
    d.y -= BODY_LH;
  };
  line(p.role, BODY_SIZE, true);
  line(p.name, BODY_SIZE, true);
  if (p.idLine) line(p.idLine);
  if (p.address) for (const l of wrap(`адрес: ${p.address}`, d.font, BODY_SIZE, contentW(d))) line(l);
  const contact = [p.phone && `тел.: ${p.phone}`, p.email && `e-mail: ${p.email}`].filter(Boolean).join('   ');
  if (contact) line(contact);
}

async function sigBlock(
  d: Doc,
  x: number,
  y: number,
  label: string,
  name: string | null | undefined,
  png: string | null,
) {
  const nameX = x + d.font.widthOfTextAtSize(`${label}: `, 10);
  d.page.drawText(`${label}: ______________________`, { x, y, size: 10, font: d.font, color: INK });
  if (name) {
    d.page.drawText(`/${String(name)}/`, { x: nameX, y: y - 13, size: 9, font: d.font, color: INK });
  }
  if (png) {
    try {
      const bytes = Buffer.from(png.split(',').pop()!, 'base64');
      const img = await d.doc.embedPng(bytes);
      d.page.drawImage(img, { x: nameX, y: y + 4, width: 110, height: 36 });
    } catch {
      // Malformed/corrupt signature data — fall back to the blank line drawn above.
    }
  }
}
