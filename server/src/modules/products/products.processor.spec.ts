import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { getQueueToken } from '@nestjs/bullmq';
import { ProductsProcessor } from './products.processor';
import { ProductsService } from './products.service';
import { PRODUCTS_QUEUE } from '../../common/queue/queue.constants';

const makeQueue = () => ({ add: jest.fn().mockResolvedValue(undefined) });

async function build(svc: any, queue: any): Promise<ProductsProcessor> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      ProductsProcessor,
      { provide: ProductsService, useValue: svc },
      { provide: getQueueToken(PRODUCTS_QUEUE), useValue: queue },
    ],
  }).compile();
  return mod.get(ProductsProcessor);
}

describe('ProductsProcessor', () => {
  it('process() expires promotions', async () => {
    const svc = { expirePromotions: jest.fn().mockResolvedValue(2) };
    const proc = await build(svc, makeQueue());
    await proc.process({ name: 'expire-promotions' } as Job);
    expect(svc.expirePromotions).toHaveBeenCalled();
  });

  it('onModuleInit registers the 01:00 Europe/Sofia repeatable', async () => {
    const queue = makeQueue();
    const proc = await build({ expirePromotions: jest.fn() }, queue);
    await proc.onModuleInit();
    expect(queue.add).toHaveBeenCalledWith(
      'expire-promotions',
      {},
      expect.objectContaining({ repeat: { pattern: '0 1 * * *', tz: 'Europe/Sofia' } }),
    );
  });
});
