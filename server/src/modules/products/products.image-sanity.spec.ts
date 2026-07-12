import sharp from 'sharp';
import { ProductsService } from './products.service';

/** A drizzle query-builder stub: chain methods return itself, and it resolves
 *  to `rows` whether the caller awaits after `.where()` or after a trailing
 *  `.limit()` — mirrors real drizzle builders (thenable + chainable). */
function chainable(rows: unknown[]) {
  const obj: any = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) obj[m] = jest.fn(() => obj);
  obj.then = (resolve: (v: unknown) => void) => resolve(rows);
  return obj;
}

function makeUpdateChain(calls: Record<string, unknown>[]) {
  const upd: any = {};
  upd.set = jest.fn((s: Record<string, unknown>) => {
    calls.push(s);
    return upd;
  });
  upd.where = jest.fn(async () => undefined);
  return upd;
}

const baseRow = {
  id: 'm1',
  productId: 'p1',
  tenantId: 't1',
  url: 'https://cdn.example.com/orig.webp',
  position: 0,
  autoFixed: false,
  sanityVerdict: null,
  originalUrl: null,
  sanityReason: null,
};

function makeStorage(over: Partial<{ upload: jest.Mock; getPublicBaseUrl: jest.Mock }> = {}) {
  return {
    upload: jest.fn().mockResolvedValue({ key: 'k', url: 'https://cdn.example.com/fixed.webp' }),
    getPublicBaseUrl: jest.fn(() => 'https://cdn.example.com'),
    ...over,
  };
}

describe('ProductsService.finishImageSanity', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('skips a row that no longer exists (deleted between enqueue and run)', async () => {
    const db: any = { select: jest.fn(() => chainable([])) };
    const sanityVision = { judge: jest.fn() };
    const svc = new ProductsService(db, {} as never, {} as never, {} as never, {} as never, {} as never, sanityVision as never);

    await svc.finishImageSanity('missing', 't1', ['замъглена']);

    expect(sanityVision.judge).not.toHaveBeenCalled();
  });

  it('skips a row already judged — idempotent against a re-run/retry', async () => {
    const db: any = { select: jest.fn(() => chainable([{ ...baseRow, autoFixed: true }])) };
    const sanityVision = { judge: jest.fn() };
    const svc = new ProductsService(db, {} as never, {} as never, {} as never, {} as never, {} as never, sanityVision as never);

    await svc.finishImageSanity('m1', 't1', ['замъглена']);

    expect(sanityVision.judge).not.toHaveBeenCalled();
  });

  it('refuses to fetch a url outside the storage base — SSRF guard', async () => {
    const db: any = { select: jest.fn(() => chainable([baseRow])) };
    const storage = makeStorage({ getPublicBaseUrl: jest.fn(() => 'https://other.example.com') });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    const sanityVision = { judge: jest.fn() };
    const svc = new ProductsService(db, storage as never, {} as never, {} as never, {} as never, {} as never, sanityVision as never);

    await svc.finishImageSanity('m1', 't1', ['замъглена']);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sanityVision.judge).not.toHaveBeenCalled();
  });

  it('marks the row unusable — without touching storage — on an unusable verdict', async () => {
    const real = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 5, g: 5, b: 5 } } })
      .jpeg()
      .toBuffer();
    const updateCalls: Record<string, unknown>[] = [];
    const db: any = { select: jest.fn(() => chainable([baseRow])), update: jest.fn(() => makeUpdateChain(updateCalls)) };
    const storage = makeStorage();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => real.buffer.slice(real.byteOffset, real.byteOffset + real.byteLength) }) as any;
    const sanityVision = {
      judge: jest.fn().mockResolvedValue({ rotate: 0, verdict: 'unusable', reason: 'продуктът не се вижда' }),
    };
    const svc = new ProductsService(
      db,
      storage as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      sanityVision as never,
    );

    await svc.finishImageSanity('m1', 't1', ['замъглена']);

    expect(storage.upload).not.toHaveBeenCalled();
    expect(updateCalls).toEqual([{ sanityVerdict: 'unusable', sanityReason: 'продуктът не се вижда' }]);
  });

  it('leaves the row untouched when the vision judge fails (returns null)', async () => {
    const real = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 5, g: 5, b: 5 } } })
      .jpeg()
      .toBuffer();
    const db: any = { select: jest.fn(() => chainable([baseRow])), update: jest.fn() };
    const storage = makeStorage();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => real.buffer.slice(real.byteOffset, real.byteOffset + real.byteLength) }) as any;
    const sanityVision = { judge: jest.fn().mockResolvedValue(null) };
    const svc = new ProductsService(db, storage as never, {} as never, {} as never, {} as never, {} as never, sanityVision as never);

    await svc.finishImageSanity('m1', 't1', ['замъглена']);

    expect(db.update).not.toHaveBeenCalled();
  });

  it('applies rotate+crop, uploads a derived image, and keeps the original for revert', async () => {
    const real = await sharp({ create: { width: 800, height: 800, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .jpeg()
      .toBuffer();

    const updateCalls: Record<string, unknown>[] = [];
    const select = jest
      .fn()
      .mockImplementationOnce(() => chainable([baseRow])) // finishImageSanity's own load
      .mockImplementationOnce(() => chainable([{ slug: 'chayka' }])) // tenantSlug
      .mockImplementationOnce(() => chainable([{ url: 'https://cdn.example.com/fixed.webp' }])) // syncCover: gallery position-0
      .mockImplementationOnce(() => chainable([{ imageUrl: 'https://cdn.example.com/fixed.webp' }])); // syncCover: current cover — matches, no-op
    const db: any = { select, update: jest.fn(() => makeUpdateChain(updateCalls)) };
    const storage = makeStorage();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => real.buffer.slice(real.byteOffset, real.byteOffset + real.byteLength) }) as any;
    const cache = { invalidate: jest.fn() };
    const sanityVision = {
      judge: jest.fn().mockResolvedValue({
        rotate: 90,
        cropBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
        verdict: 'ok',
        reason: 'изправена и изрязана',
      }),
    };
    const svc = new ProductsService(db, storage as never, cache as never, {} as never, {} as never, {} as never, sanityVision as never);

    await svc.finishImageSanity('m1', 't1', ['необичайно съотношение']);

    expect(storage.upload).toHaveBeenCalledTimes(1);
    const [, key, contentType] = storage.upload.mock.calls[0];
    expect(key).toMatch(/^tenants\/chayka\/products\/p1\/.+\.webp$/);
    expect(contentType).toBe('image/webp');
    expect(updateCalls).toEqual([
      {
        originalUrl: baseRow.url,
        url: 'https://cdn.example.com/fixed.webp',
        autoFixed: true,
        sanityVerdict: 'ok',
        sanityReason: 'изправена и изрязана',
      },
    ]);
    expect(cache.invalidate).toHaveBeenCalledWith('t1');
  });
});

describe('ProductsService.addMedia — inline sanity wiring', () => {
  it('enqueues the process job without sanityReasons for a clean photo', async () => {
    const db: any = { select: jest.fn(() => chainable([{ id: 'p1', tenantId: 't1' }])) };
    const imageQueue = { add: jest.fn() };
    const svc = new ProductsService(db, {} as never, {} as never, {} as never, imageQueue as never, {} as never, {} as never);
    // Large + high-detail (random noise) → clears the resolution, aspect-ratio, and blur checks.
    const raw = Buffer.alloc(800 * 800 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
    const clean = await sharp(raw, { raw: { width: 800, height: 800, channels: 3 } }).jpeg().toBuffer();

    await svc.addMedia('p1', 't1', { buffer: clean, mimetype: 'image/jpeg' } as any);

    expect(imageQueue.add).toHaveBeenCalledWith('process', expect.objectContaining({ entityType: 'product-media' }));
    const payload = imageQueue.add.mock.calls[0][1];
    expect(payload.sanityReasons).toBeUndefined();
  });

  it('enqueues the process job WITH sanityReasons for a flagged photo', async () => {
    const db: any = { select: jest.fn(() => chainable([{ id: 'p1', tenantId: 't1' }])) };
    const imageQueue = { add: jest.fn() };
    const svc = new ProductsService(db, {} as never, {} as never, {} as never, imageQueue as never, {} as never, {} as never);
    // Tiny + flat → below the resolution floor AND featureless → flagged.
    const flagged = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 128, g: 128, b: 128 } } })
      .jpeg()
      .toBuffer();

    await svc.addMedia('p1', 't1', { buffer: flagged, mimetype: 'image/jpeg' } as any);

    const payload = imageQueue.add.mock.calls[0][1];
    expect(payload.sanityReasons).toEqual(expect.arrayContaining(['ниска резолюция']));
  });
});
