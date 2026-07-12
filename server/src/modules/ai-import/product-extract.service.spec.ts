import { BadRequestException, BadGatewayException } from '@nestjs/common';
import { ProductExtractService, isImageFile } from './product-extract.service';

// sharp is heavy; stub it — we assert the downscale pipeline is invoked, not pixels.
jest.mock('sharp', () => {
  const chain = {
    rotate: jest.fn().mockReturnThis(),
    resize: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from('tiny-jpeg')),
  };
  return { __esModule: true, default: jest.fn(() => chain), __chain: chain };
});

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

/** Multer file for the vision-path tests — needs `size` (checked by extractFromImage). */
function imageFileOf(over: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'cenorazpis.jpg',
    mimetype: 'image/jpeg',
    size: 1024,
    buffer: Buffer.from('raw'),
    ...over,
  } as Express.Multer.File;
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

describe('isImageFile', () => {
  it('accepts jpeg/png/webp, rejects the rest', () => {
    expect(isImageFile(imageFileOf({ mimetype: 'image/jpeg' }))).toBe(true);
    expect(isImageFile(imageFileOf({ mimetype: 'image/png' }))).toBe(true);
    expect(isImageFile(imageFileOf({ mimetype: 'image/webp' }))).toBe(true);
    expect(isImageFile(imageFileOf({ mimetype: 'text/csv' }))).toBe(false);
    expect(isImageFile(imageFileOf({ mimetype: 'application/pdf' }))).toBe(false);
  });
});

describe('ProductExtractService.extractFromImage', () => {
  function withClient(create: jest.Mock): ProductExtractService {
    const svc = makeSvc();
    (svc as any).client = { chat: { completions: { create } } };
    return svc;
  }

  it('downscales, sends a data-URI image_url, and coerces the reply rows', async () => {
    const create = jest.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              products: [
                { name: 'Домати', priceStotinki: 450, unit: 'кг' },
                { name: '', priceStotinki: 100, unit: 'бр' }, // dropped by coerce
              ],
            }),
          },
        },
      ],
    });
    const rows = await withClient(create).extractFromImage(imageFileOf());
    expect(rows).toEqual([{ name: 'Домати', priceStotinki: 450, unit: 'кг', isActive: true }]);
    const msg = create.mock.calls[0][0].messages[1];
    const img = msg.content.find((p: any) => p.type === 'image_url');
    expect(img.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('rejects an oversized image with a BG message', async () => {
    const create = jest.fn();
    await expect(
      withClient(create).extractFromImage(imageFileOf({ size: 11 * 1024 * 1024 })),
    ).rejects.toThrow('Снимката е твърде голяма');
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a corrupt image (sharp decode failure) with a BG message', async () => {
    const sharpModule = require('sharp');
    const chain = sharpModule.__chain;
    chain.toBuffer.mockRejectedValueOnce(new Error('bad image'));
    const create = jest.fn();
    await expect(
      withClient(create).extractFromImage(imageFileOf()),
    ).rejects.toThrow('Снимката не може да бъде прочетена');
    expect(create).not.toHaveBeenCalled();
  });
});
