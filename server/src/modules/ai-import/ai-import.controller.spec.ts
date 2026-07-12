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
