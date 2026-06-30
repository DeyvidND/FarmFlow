import { BadRequestException, BadGatewayException } from '@nestjs/common';
import { ProductExtractService } from './product-extract.service';

/** Build a service with a stubbed config. Default key=null so the constructor
 *  never instantiates a real OpenAI client (which left a worker handle dangling
 *  under parallel load → "worker failed to exit gracefully" + flaky timeouts).
 *  The extract tests inject their own mock `client` directly. */
function makeSvc(key: string | null = null) {
  const config = { get: (k: string, d?: unknown) => (k === 'OPENAI_API_KEY' ? key : d) } as any;
  return new ProductExtractService(config);
}

function fileOf(name: string, buffer: Buffer, mimetype = 'application/octet-stream') {
  return { originalname: name, buffer, mimetype } as Express.Multer.File;
}

describe('ProductExtractService.parseToText', () => {
  it('prefers pasted text over a file', async () => {
    const svc = makeSvc();
    const text = await svc.parseToText(fileOf('x.txt', Buffer.from('от файл')), 'от текст');
    expect(text).toBe('от текст');
  });

  it('decodes .txt and .csv as utf-8', async () => {
    const svc = makeSvc();
    expect(await svc.parseToText(fileOf('p.txt', Buffer.from('Домати 2,50')), undefined)).toContain('Домати');
    expect(await svc.parseToText(fileOf('p.csv', Buffer.from('Мед,12'), 'text/csv'), undefined)).toContain('Мед');
  });

  it('parses .xlsx cells into text via exceljs', async () => {
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Лист');
    ws.addRow(['Домати', '2,50', 'кг']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const svc = makeSvc();
    const out = await svc.parseToText(fileOf('p.xlsx', buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), undefined);
    expect(out).toContain('Домати');
    expect(out).toContain('кг');
  });

  it('rejects no input', async () => {
    await expect(makeSvc().parseToText(undefined, undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unsupported file type', async () => {
    await expect(makeSvc().parseToText(fileOf('p.pdf', Buffer.from('x'), 'application/pdf'), undefined))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ProductExtractService.extract', () => {
  function withRows(svc: ProductExtractService, json: unknown) {
    (svc as any).client = {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(json) } }] }) } },
    };
  }

  it('coerces price, defaults unit, drops nameless rows, omits empty optionals', async () => {
    const svc = makeSvc();
    withRows(svc, {
      products: [
        { name: 'Домати', priceStotinki: 250, unit: 'кг', weight: '', category: 'Зеленчуци', description: '' },
        { name: '', priceStotinki: 100, unit: 'бр' },
        { name: 'Мед', priceStotinki: -5, unit: '', weight: '500 г', category: '', description: 'Акациев' },
      ],
    });
    const rows = await svc.extract('…');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ name: 'Домати', priceStotinki: 250, unit: 'кг', category: 'Зеленчуци', isActive: true });
    expect(rows[1]).toEqual({ name: 'Мед', priceStotinki: 0, unit: 'бр', weight: '500 г', description: 'Акациев', isActive: true });
  });

  it('rounds a non-integer price', async () => {
    const svc = makeSvc();
    withRows(svc, { products: [{ name: 'Сирене', priceStotinki: 649.7, unit: 'кг' }] });
    expect((await svc.extract('…'))[0].priceStotinki).toBe(650);
  });

  it('caps at 1000 rows', async () => {
    const svc = makeSvc();
    withRows(svc, { products: Array.from({ length: 1100 }, (_, i) => ({ name: `П${i}`, priceStotinki: 100, unit: 'бр' })) });
    expect(await svc.extract('…')).toHaveLength(1000);
  });

  it('throws on invalid JSON from the model', async () => {
    const svc = makeSvc();
    (svc as any).client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'not json' } }] }) } } };
    await expect(svc.extract('…')).rejects.toBeInstanceOf(BadGatewayException);
  });
});
