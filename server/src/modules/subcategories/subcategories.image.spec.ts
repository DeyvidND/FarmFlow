import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { SubcategoriesService } from './subcategories.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { StorageService } from '../storage/storage.service';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { IMAGE_QUEUE } from '../../common/queue/queue.constants';

/** Chainable Drizzle mock: select().from().where().limit() → [fakeSubcat] */
function makeDb(fakeSubcat: any = { id: 's1', tenantId: 't1', imageUrl: null }) {
  const chain: any = {};
  chain.select = jest.fn(() => chain);
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.limit = jest.fn(() => Promise.resolve([fakeSubcat]));
  chain.update = jest.fn(() => chain);
  chain.set = jest.fn(() => chain);
  chain.returning = jest.fn(() => Promise.resolve([fakeSubcat]));
  return chain;
}

function makeQueue() {
  return { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
}

async function buildSvc(db: any, queue: any): Promise<SubcategoriesService> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      SubcategoriesService,
      { provide: DB_TOKEN, useValue: db },
      { provide: StorageService, useValue: { upload: jest.fn(), delete: jest.fn() } },
      { provide: CatalogCacheService, useValue: { invalidate: jest.fn() } },
      { provide: PublicCacheService, useValue: { del: jest.fn(), resolveTenant: jest.fn(), get: jest.fn(), set: jest.fn() } },
      { provide: getQueueToken(IMAGE_QUEUE), useValue: queue },
    ],
  }).compile();
  return mod.get(SubcategoriesService);
}

describe('SubcategoriesService.uploadImage (queue path)', () => {
  it('enqueues a subcategory-cover job and returns imageProcessing:true without calling storage.upload', async () => {
    const db = makeDb({ id: 's1', tenantId: 't1', imageUrl: null });
    const queue = makeQueue();
    const storage = { upload: jest.fn(), delete: jest.fn() };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        SubcategoriesService,
        { provide: DB_TOKEN, useValue: db },
        { provide: StorageService, useValue: storage },
        { provide: CatalogCacheService, useValue: { invalidate: jest.fn() } },
        { provide: PublicCacheService, useValue: { del: jest.fn(), resolveTenant: jest.fn(), get: jest.fn(), set: jest.fn() } },
        { provide: getQueueToken(IMAGE_QUEUE), useValue: queue },
      ],
    }).compile();

    const svc = mod.get(SubcategoriesService);

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

    const result = await svc.uploadImage('s1', 't1', fakeFile);

    // Must enqueue with entityType=subcategory-cover
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'process',
      expect.objectContaining({
        entityType: 'subcategory-cover',
        entityId: 's1',
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

describe('SubcategoriesService.addMedia (queue path)', () => {
  it('addMedia enqueues a subcategory-media job and returns processing=true', async () => {
    const db = makeDb({ id: 's1', tenantId: 't1', imageUrl: null });
    const queue = makeQueue();
    const svc = await buildSvc(db, queue);
    const file = { buffer: Buffer.from('abc'), mimetype: 'image/jpeg' } as any;
    const res: any = await svc.addMedia('s1', 't1', file);
    expect(queue.add).toHaveBeenCalledWith(
      'process',
      expect.objectContaining({ entityType: 'subcategory-media', entityId: 's1' }),
    );
    expect(res.imageProcessing).toBe(true);
  });
});
