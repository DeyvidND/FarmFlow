import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { ImageProcessor } from './image.processor';
import { ProductsService } from '../products/products.service';
import { FarmersService } from '../farmers/farmers.service';
import { SubcategoriesService } from '../subcategories/subcategories.service';

async function build(over: any = {}) {
  const products = { finishProductCover: jest.fn(), finishProductMedia: jest.fn(), ...over.products };
  const farmers = { finishFarmerCover: jest.fn(), finishFarmerMedia: jest.fn(), ...over.farmers };
  const subcategories = { finishSubcategoryCover: jest.fn(), finishSubcategoryMedia: jest.fn(), ...over.subcategories };
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      ImageProcessor,
      { provide: ProductsService, useValue: products },
      { provide: FarmersService, useValue: farmers },
      { provide: SubcategoriesService, useValue: subcategories },
    ],
  }).compile();
  return { proc: mod.get(ImageProcessor), products, farmers, subcategories };
}

const job = (entityType: string, entityId = 'e1') =>
  ({ data: { entityType, entityId, tenantId: 't1', bufferB64: Buffer.from('xy').toString('base64'), mime: 'image/jpeg' } } as Job);

describe('ImageProcessor dispatch', () => {
  it('routes product-cover to finishProductCover with decoded bytes', async () => {
    const { proc, products } = await build();
    await proc.process(job('product-cover', 'p1'));
    expect(products.finishProductCover).toHaveBeenCalledWith('p1', 't1', expect.any(Buffer), 'image/jpeg');
  });
  it('routes farmer-media to finishFarmerMedia', async () => {
    const { proc, farmers } = await build();
    await proc.process(job('farmer-media', 'f1'));
    expect(farmers.finishFarmerMedia).toHaveBeenCalledWith('f1', 't1', expect.any(Buffer), 'image/jpeg');
  });
  it('routes subcategory-cover to finishSubcategoryCover', async () => {
    const { proc, subcategories } = await build();
    await proc.process(job('subcategory-cover', 's1'));
    expect(subcategories.finishSubcategoryCover).toHaveBeenCalledWith('s1', 't1', expect.any(Buffer), 'image/jpeg');
  });
});
