import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ProductsService } from './products.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { StorageService } from '../storage/storage.service';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { AvailabilityService } from '../availability/availability.service';
import { IMAGE_QUEUE } from '../../common/queue/queue.constants';

/** Chainable Drizzle mock: select().from().where().limit() → [fakeProduct] */
function makeDb(fakeProduct: any = { id: 'p1', tenantId: 't1', imageUrl: null }) {
  const chain: any = {};
  chain.select = jest.fn(() => chain);
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.limit = jest.fn(() => Promise.resolve([fakeProduct]));
  chain.update = jest.fn(() => chain);
  chain.set = jest.fn(() => chain);
  chain.returning = jest.fn(() => Promise.resolve([fakeProduct]));
  return chain;
}

function makeQueue() {
  return { add: jest.fn().mockResolvedValue({ id: 'job-42' }) };
}

async function buildSvc(db: any, queue: any): Promise<ProductsService> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      ProductsService,
      { provide: DB_TOKEN, useValue: db },
      { provide: StorageService, useValue: { upload: jest.fn(), delete: jest.fn() } },
      { provide: CatalogCacheService, useValue: { invalidate: jest.fn() } },
      { provide: PublicCacheService, useValue: { invalidate: jest.fn() } },
      { provide: getQueueToken(IMAGE_QUEUE), useValue: queue },
      { provide: AvailabilityService, useValue: { setProductStock: jest.fn() } },
    ],
  }).compile();
  return mod.get(ProductsService);
}

describe('ProductsService.uploadImage (queue path)', () => {
  it('enqueues a product-cover job and returns imageProcessing:true without calling storage.upload', async () => {
    const db = makeDb({ id: 'p1', tenantId: 't1', imageUrl: null });
    const queue = makeQueue();
    const storage = { upload: jest.fn(), delete: jest.fn() };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: DB_TOKEN, useValue: db },
        { provide: StorageService, useValue: storage },
        { provide: CatalogCacheService, useValue: { invalidate: jest.fn() } },
        { provide: PublicCacheService, useValue: { invalidate: jest.fn() } },
        { provide: getQueueToken(IMAGE_QUEUE), useValue: queue },
        { provide: AvailabilityService, useValue: { setProductStock: jest.fn() } },
      ],
    }).compile();

    const svc = mod.get(ProductsService);

    const fakeFile: Express.Multer.File = {
      buffer: Buffer.from('fake-image-bytes'),
      mimetype: 'image/jpeg',
      originalname: 'test.jpg',
      fieldname: 'file',
      encoding: '7bit',
      size: 16,
      destination: '',
      filename: '',
      path: '',
      stream: null as any,
    };

    const result = await svc.uploadImage('p1', 't1', fakeFile);

    // Must enqueue with entityType=product-cover
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'process',
      expect.objectContaining({
        entityType: 'product-cover',
        entityId: 'p1',
        tenantId: 't1',
        mime: 'image/jpeg',
      }),
    );

    // Must NOT synchronously upload to storage
    expect(storage.upload).not.toHaveBeenCalled();

    // Must flag processing
    expect(result.imageProcessing).toBe(true);
  });
});

describe('ProductsService.addMedia (queue path)', () => {
  it('addMedia enqueues a product-media job and returns processing=true', async () => {
    const db = makeDb({ id: 'p1', tenantId: 't1', imageUrl: null });
    const queue = makeQueue();
    const svc = await buildSvc(db, queue);
    const file = { buffer: Buffer.from('abc'), mimetype: 'image/jpeg' } as any;
    const res: any = await svc.addMedia('p1', 't1', file);
    expect(queue.add).toHaveBeenCalledWith(
      'process',
      expect.objectContaining({ entityType: 'product-media', entityId: 'p1' }),
    );
    expect(res.imageProcessing).toBe(true);
  });
});
