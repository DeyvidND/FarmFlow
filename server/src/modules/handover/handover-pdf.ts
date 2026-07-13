import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'fs';
import { join } from 'path';

const FONT = readFileSync(join(__dirname, '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf'));
const lv = (st: number) => (st / 100).toFixed(2).replace('.', ',') + ' лв.';

export async function renderProtocolPdf(row: any): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(FONT);
  const page = doc.addPage([595, 842]); // A4
  const ink = rgb(0.11, 0.1, 0.09);
  let y = 800;
  const line = (text: string, size = 11, dx = 40) => {
    page.drawText(text, { x: dx, y, size, font, color: ink });
    y -= size + 6;
  };
  const title = row.kind === 'operator_to_customer'
    ? 'РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА'
    : 'ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ';
  line(`${title} № ${row.protocolNumber ?? '—'}`, 15);
  line(`Дата: ${new Date(row.signedAt ?? row.createdAt).toLocaleString('bg-BG')}`, 10);
  y -= 6;
  line('Предал:', 11); line(partyLine(row.fromSnapshot), 10);
  y -= 2;
  line('Приел:', 11); line(partyLine(row.toSnapshot), 10);
  y -= 8;
  line('Стока:', 11);
  for (const it of row.items) {
    line(`• ${it.productName}${it.variantLabel ? ' · ' + it.variantLabel : ''} — ${it.quantity} ${it.unit ?? ''} × ${lv(it.priceStotinki)}`, 10, 52);
  }
  y -= 4;
  line(`Общо: ${lv(row.totalStotinki)}`, 12);
  y -= 20;
  await sigBlock(doc, page, font, 40, y, 'Предал', row.fromSignaturePng);
  await sigBlock(doc, page, font, 320, y, 'Приел', row.toSignaturePng);
  return Buffer.from(await doc.save());
}

function partyLine(s: any): string {
  const parts = [s?.name, s?.eik && 'ЕИК ' + s.eik, s?.regNo && 'рег.№ ' + s.regNo, s?.address, s?.phone]
    .filter(Boolean);
  return parts.join(', ');
}

async function sigBlock(doc: any, page: any, font: any, x: number, y: number, label: string, png: string | null) {
  page.drawText(`${label}: ______________________`, { x, y, size: 10, font });
  if (png) {
    try {
      const bytes = Buffer.from(png.split(',').pop()!, 'base64');
      const img = await doc.embedPng(bytes);
      page.drawImage(img, { x, y: y + 6, width: 120, height: 40 });
    } catch {
      // Malformed/corrupt signature data — fall back to the blank line already drawn above.
    }
  }
}
