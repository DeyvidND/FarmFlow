import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ImageProcessor } from './image.processor';
import { ProductsService } from '../products/products.service';
import { FarmersService } from '../farmers/farmers.service';
import { SubcategoriesService } from '../subcategories/subcategories.service';
import { IMAGE_QUEUE } from '../../common/queue/queue.constants';

async function build(over: any = {}) {
  const products = {
    finishProductCover: jest.fn(),
    finishProductMedia: jest.fn().mockResolvedValue({ mediaId: 'm1' }),
    finishImageSanity: jest.fn(),
    ...over.products,
  };
  const farmers = { finishFarmerCover: jest.fn(), finishFarmerMedia: jest.fn(), ...over.farmers };
  const subcategories = { finishSubcategoryCover: jest.fn(), finishSubcategoryMedia: jest.fn(), ...over.subcategories };
  const queue = { add: jest.fn(), ...over.queue };
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      ImageProcessor,
      { provide: ProductsService, useValue: products },
      { provide: FarmersService, useValue: farmers },
      { provide: SubcategoriesService, useValue: subcategories },
      { provide: getQueueToken(IMAGE_QUEUE), useValue: queue },
    ],
  }).compile();
  return { proc: mod.get(ImageProcessor), products, farmers, subcategories, queue };
}

const job = (entityType: string, entityId = 'e1', extra: Record<string, unknown> = {}) =>
  ({
    name: 'process',
    data: { entityType, entityId, tenantId: 't1', bufferB64: Buffer.from('xy').toString('base64'), mime: 'image/jpeg', ...extra },
  }) as Job;

const sanityJob = (data: Record<string, unknown>) => ({ name: 'image-sanity', data }) as Job;

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

  it('routes product-media to finishProductMedia and does not enqueue a sanity job when clean', async () => {
    const { proc, products, queue } = await build();
    await proc.process(job('product-media', 'p1'));
    expect(products.finishProductMedia).toHaveBeenCalledWith('p1', 't1', expect.any(Buffer), 'image/jpeg');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('enqueues a follow-up image-sanity job when the inline check flagged reasons', async () => {
    const { proc, queue } = await build();
    await proc.process(job('product-media', 'p1', { sanityReasons: ['замъглена'] }));
    expect(queue.add).toHaveBeenCalledWith('image-sanity', { mediaId: 'm1', tenantId: 't1', reasons: ['замъглена'] });
  });

  it('dispatches a named image-sanity job to finishImageSanity', async () => {
    const { proc, products } = await build();
    await proc.process(sanityJob({ mediaId: 'm1', tenantId: 't1', reasons: ['замъглена'] }));
    expect(products.finishImageSanity).toHaveBeenCalledWith('m1', 't1', ['замъглена']);
  });

  it('re-throws (for BullMQ retry) when finishImageSanity fails', async () => {
    const { proc } = await build({ products: { finishImageSanity: jest.fn().mockRejectedValue(new Error('boom')) } });
    await expect(proc.process(sanityJob({ mediaId: 'm1', tenantId: 't1', reasons: [] }))).rejects.toThrow('boom');
  });
});
