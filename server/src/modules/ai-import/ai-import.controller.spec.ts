import { AiImportController } from './ai-import.controller';
import { ProductExtractService } from './product-extract.service';
import { ProductsService } from '../products/products.service';

const IMG = { mimetype: 'image/jpeg', size: 10, buffer: Buffer.from('x') } as Express.Multer.File;
const TXT = { mimetype: 'text/plain', originalname: 'a.txt', size: 10, buffer: Buffer.from('домати 4.50') } as Express.Multer.File;

function controller(extract: Partial<ProductExtractService>, products: Partial<ProductsService> = {}) {
  return new AiImportController(extract as ProductExtractService, products as ProductsService);
}

describe('AiImportController.extract', () => {
  it('routes an image to the vision path', async () => {
    const extractFromImage = jest.fn().mockResolvedValue([{ name: 'Домати', priceStotinki: 450, unit: 'кг', isActive: true }]);
    const res = await controller({ extractFromImage } as any).extract(IMG, undefined);
    expect(extractFromImage).toHaveBeenCalledWith(IMG);
    expect(res.products).toHaveLength(1);
  });

  it('routes text/file to the text path', async () => {
    const parseToText = jest.fn().mockResolvedValue('домати 4.50');
    const extract = jest.fn().mockResolvedValue([]);
    await controller({ parseToText, extract } as any).extract(TXT, undefined);
    expect(parseToText).toHaveBeenCalledWith(TXT, undefined);
    expect(extract).toHaveBeenCalledWith('домати 4.50');
  });
});

describe('AiImportController.commit', () => {
  const row = { name: 'Домати', priceStotinki: 450, unit: 'кг' };

  it('forces a farmer token to its own farmerId (ignores the body override)', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'p1' });
    const c = controller({} as any, { create } as any);
    const res = await c.commit('tenant-1', { role: 'farmer', farmerId: 'me' } as any, {
      products: [row],
      farmerId: 'someone-else',
    } as any);
    expect(create).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ name: 'Домати', farmerId: 'me' }), 'me');
    expect(res).toEqual({ created: 1 });
  });

  it('lets the owner attach rows to a chosen producer', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'p1' });
    const c = controller({} as any, { create } as any);
    await c.commit('tenant-1', { role: 'admin' } as any, { products: [row, row], farmerId: 'f9' } as any);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenLastCalledWith('tenant-1', expect.objectContaining({ farmerId: 'f9' }), 'f9');
  });
});
