# Scale-prep: Image-resize Queue Implementation Plan (Phase E)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **DEPENDS ON** the foundation plan (`2026-06-15-scale-prep-foundation.md`, Phases A–D) being merged first — it reuses `IMAGE_QUEUE`-style queue wiring, `RUN_WORKERS`, and the BullMQ root module. This phase is **deferrable**: image upload is an admin/setup path (not per-delivery), and sharp already runs on the libuv threadpool, so it never blocks the event loop today. Land it only when you want uploads decoupled.

**Goal:** Move image optimization (`optimizeImage` + smart-crop + R2 upload + DB write) off the upload request onto a BullMQ worker, so an upload returns immediately and the heavy work is retried in the background.

**Architecture:** The upload handler base64-encodes the original bytes into a job and enqueues it (admin-volume, occasional — Redis payload size is acceptable and `removeOnComplete` clears it). A single `ImageProcessor` (in its own `ImageQueueModule` that imports the feature modules — one-directional, no cycle) dispatches each job to the owning service's **finisher** method, which is exactly today's upload tail (optimize → upload → update DB → delete old → crop → invalidate cache). The upload response carries a transient `imageProcessing: true` flag; the admin UI shows a placeholder and refetches.

**Tech Stack:** BullMQ + `@nestjs/bullmq`, sharp (`optimizeImage`/`smartFocal` utils, unchanged), drizzle, Jest.

**Spec:** `docs/superpowers/specs/2026-06-15-scale-prep-queues-design.md` (Component G).

---

## Why buffer-in-payload (not a temp R2 key)

`StorageService` exposes no `download()`, and in dev **stub mode** R2 stores nothing — a temp-key round-trip would not work locally. Passing the original buffer in the job payload needs no new storage method, works in stub mode, and is fine at admin upload volume (occasional ~5 MB images; `removeOnComplete` evicts the payload after the job runs).

## The 12 upload sites (all call `optimizeImage`)

| Service | Method(s) | entityType |
|---|---|---|
| `products.service.ts` | `uploadImage` (cover), `addMedia` (gallery) | `product-cover`, `product-media` |
| `farmers.service.ts` | two sites (`:203`, `:257` — cover + ?) | `farmer-*` |
| `subcategories.service.ts` | two sites (`:113`, `:167`) | `subcategory-*` |
| `tenants.service.ts` | one site (`:240`) | `tenant-*` |
| `articles.service.ts` | one site (`:256`, inline image) | `article-image` |
| `newsletter.service.ts` | one site (`:240`, inline image) | `newsletter-image` |

Task E5 enumerates each with its exact entityType + finisher.

---

## File Structure

- Modify: `server/src/common/queue/queue.constants.ts` — add `IMAGE_QUEUE`.
- Create: `server/src/common/queue/image-job.ts` — `ImageJobPayload` type + `encodeImageJob` helper.
- Create: `server/src/modules/image-queue/image.processor.ts` — dispatcher worker.
- Create: `server/src/modules/image-queue/image-queue.module.ts` — imports feature modules + gated processor.
- Modify: each feature module — `exports` its service + registers `IMAGE_QUEUE` producer.
- Modify: each feature service — split each upload site into `enqueue` + `finish*`.
- Modify: `server/src/app.module.ts` — import `ImageQueueModule`.
- Modify: admin UI dialogs — handle `imageProcessing` (Task E6).

---

## Task E1: `IMAGE_QUEUE` + job payload type

**Files:**
- Modify: `server/src/common/queue/queue.constants.ts`
- Create: `server/src/common/queue/image-job.ts`

- [ ] **Step 1: Add the queue name**

`server/src/common/queue/queue.constants.ts` — append:

```ts
export const IMAGE_QUEUE = 'image';
```

- [ ] **Step 2: Define the payload + encoder**

`server/src/common/queue/image-job.ts`:

```ts
/** Which upload a job services — maps 1:1 to a service finisher method. */
export type ImageEntityType =
  | 'product-cover'
  | 'product-media'
  | 'farmer-cover'
  | 'farmer-secondary'
  | 'subcategory-cover'
  | 'subcategory-secondary'
  | 'tenant-image'
  | 'article-image'
  | 'newsletter-image';

export interface ImageJobPayload {
  entityType: ImageEntityType;
  /** The owning row id (product/farmer/... id). */
  entityId: string;
  tenantId: string;
  /** Original upload bytes, base64. Decoded by the worker, then optimized. */
  bufferB64: string;
  mime: string;
}

/** Build a payload from a Multer file. Kept tiny + pure so callers stay one-liners. */
export function encodeImageJob(
  entityType: ImageJobPayload['entityType'],
  entityId: string,
  tenantId: string,
  file: { buffer: Buffer; mimetype: string },
): ImageJobPayload {
  return {
    entityType,
    entityId,
    tenantId,
    bufferB64: file.buffer.toString('base64'),
    mime: file.mimetype,
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add server/src/common/queue/queue.constants.ts server/src/common/queue/image-job.ts
git commit -m "feat(queue): IMAGE_QUEUE name + image job payload type"
```

---

## Task E2: Split the products cover upload into enqueue + finisher

**Files:**
- Modify: `server/src/modules/products/products.service.ts:200-227`
- Modify: `server/src/modules/products/products.module.ts`
- Create (test): `server/src/modules/products/products.image.spec.ts`

- [ ] **Step 1: Write the failing test (enqueue + finisher)**

`server/src/modules/products/products.image.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { ProductsService } from './products.service';
import { getQueueToken } from '@nestjs/bullmq';
import { IMAGE_QUEUE } from '../../common/queue/queue.constants';

// Minimal harness — only the collaborators uploadImage/finishProductCover touch.
function deps() {
  const db: any = {};
  const chain = () => db;
  db.select = jest.fn(chain); db.from = jest.fn(chain); db.where = jest.fn(chain);
  db.update = jest.fn(chain); db.set = jest.fn(chain); db.limit = jest.fn().mockResolvedValue([{ id: 'p1', tenantId: 't1', imageUrl: null }]);
  db.returning = jest.fn().mockResolvedValue([{ id: 'p1', imageUrl: 'https://cdn/x.webp' }]);
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const storage = { upload: jest.fn().mockResolvedValue({ url: 'https://cdn/x.webp' }), delete: jest.fn() };
  const cache = { invalidate: jest.fn() };
  return { db, queue, storage, cache };
}

async function build(d: ReturnType<typeof deps>): Promise<ProductsService> {
  // NOTE: adapt the provider tokens to ProductsService's actual constructor
  // (DB_TOKEN, StorageService, the products cache service, IMAGE_QUEUE).
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      ProductsService,
      { provide: require('../../common/drizzle/drizzle.constants').DB_TOKEN, useValue: d.db },
      { provide: require('../storage/storage.service').StorageService, useValue: d.storage },
      { provide: getQueueToken(IMAGE_QUEUE), useValue: d.queue },
      // + the products cache provider token used by ProductsService
    ],
  }).compile();
  return mod.get(ProductsService);
}

describe('ProductsService cover image (async)', () => {
  it('uploadImage enqueues a product-cover job and returns processing=true', async () => {
    const d = deps();
    const svc = await build(d);
    const file = { buffer: Buffer.from('abc'), mimetype: 'image/jpeg' } as any;
    const res: any = await svc.uploadImage('p1', 't1', file);
    expect(d.queue.add).toHaveBeenCalledWith(
      'process',
      expect.objectContaining({ entityType: 'product-cover', entityId: 'p1', tenantId: 't1', mime: 'image/jpeg' }),
    );
    expect(res.imageProcessing).toBe(true);
  });
});
```

> The harness comment flags the exact provider tokens to fill in from `ProductsService`'s constructor — keep them identical to the existing `products.service.spec.ts` setup if one exists.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @farmflow/api test -- products.image.spec`
Expected: FAIL — `uploadImage` doesn't enqueue / no `imageProcessing`.

- [ ] **Step 3: Refactor `uploadImage` → enqueue, add `finishProductCover`**

`server/src/modules/products/products.service.ts`:

(a) Add constructor injection for the queue (add to the existing constructor params):

```ts
    @InjectQueue(IMAGE_QUEUE) private readonly imageQueue: Queue,
```

and imports at top:

```ts
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { IMAGE_QUEUE } from '../../common/queue/queue.constants';
import { encodeImageJob } from '../../common/queue/image-job';
```

(b) Replace `uploadImage` (currently lines 200-227) with:

```ts
  /** Validate ownership, then queue the heavy optimize+store work. Returns the
   *  current row marked `imageProcessing` — the worker fills `imageUrl` shortly. */
  async uploadImage(id: string, tenantId: string, file: Express.Multer.File): Promise<Product & { imageProcessing: boolean }> {
    const product = await this.findOne(id, tenantId);
    await this.imageQueue.add('process', encodeImageJob('product-cover', id, tenantId, file));
    return { ...product, imageProcessing: true };
  }

  /** Worker path: the former synchronous body of uploadImage. */
  async finishProductCover(id: string, tenantId: string, buffer: Buffer, mime: string): Promise<void> {
    const product = await this.findOne(id, tenantId);
    const img = await optimizeImage(buffer, mime, PRODUCT_IMAGE_EXT_BY_MIME[mime] ?? 'bin');
    const slug = await tenantSlug(this.db, tenantId);
    const key = `tenants/${slug}/products/${id}/${randomUUID()}.${img.ext}`;
    const { url } = await this.storage.upload(img.buffer, key, img.contentType);
    if (product.imageUrl) await this.deleteObject(product.imageUrl);
    await this.db
      .update(products)
      .set({ imageUrl: url, coverCrop: await smartFocal(img.buffer) })
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId)));
    await this.cache.invalidate(tenantId);
  }
```

> `finishProductCover` is the original `uploadImage` body with `file.buffer`→`buffer`, `file.mimetype`→`mime`, and no `.returning()`/return (the worker discards the row).

- [ ] **Step 4: Register the IMAGE_QUEUE producer + export the service**

`server/src/modules/products/products.module.ts`:
- Add `import { BullModule } from '@nestjs/bullmq';` and `import { IMAGE_QUEUE } from '../../common/queue/queue.constants';`.
- Add `BullModule.registerQueue({ name: IMAGE_QUEUE, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: true, removeOnFail: 200 } })` to `imports`.
- Ensure `exports: [ProductsService]` includes `ProductsService` (add it — the ImageQueueModule needs it).

> Registering the same `IMAGE_QUEUE` with `defaultJobOptions` in multiple feature modules is fine — the options apply per producer; keep them identical across modules.

- [ ] **Step 5: Run the test + build**

Run: `pnpm --filter @farmflow/api test -- products.image.spec`
Expected: PASS.

Run: `pnpm --filter @farmflow/api build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/products
git commit -m "feat(products): queue cover-image optimize (enqueue + finishProductCover)"
```

---

## Task E3: Split the products gallery upload (`addMedia`)

**Files:**
- Modify: `server/src/modules/products/products.service.ts:272-312`

- [ ] **Step 1: Add the gallery test case**

Append to `products.image.spec.ts`:

```ts
  it('addMedia enqueues a product-media job and returns processing=true', async () => {
    const d = deps();
    const svc = await build(d);
    const file = { buffer: Buffer.from('abc'), mimetype: 'image/jpeg' } as any;
    const res: any = await svc.addMedia('p1', 't1', file);
    expect(d.queue.add).toHaveBeenCalledWith('process', expect.objectContaining({ entityType: 'product-media', entityId: 'p1' }));
    expect(res.imageProcessing).toBe(true);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @farmflow/api test -- products.image.spec`
Expected: FAIL on the new case.

- [ ] **Step 3: Split `addMedia` → enqueue + `finishProductMedia`**

Replace `addMedia` (lines 272-312) so it validates + enqueues:

```ts
  async addMedia(id: string, tenantId: string, file: Express.Multer.File): Promise<{ imageProcessing: boolean }> {
    await this.findOne(id, tenantId);
    await this.imageQueue.add('process', encodeImageJob('product-media', id, tenantId, file));
    return { imageProcessing: true };
  }

  /** Worker path: the former synchronous body of addMedia. */
  async finishProductMedia(id: string, tenantId: string, buffer: Buffer, mime: string): Promise<void> {
    const product = await this.findOne(id, tenantId);
    const existing = await this.db
      .select().from(productMedia).where(eq(productMedia.productId, id)).orderBy(asc(productMedia.position));
    if (existing.length === 0 && product.imageUrl) {
      const [adopted] = await this.db
        .insert(productMedia).values({ productId: id, tenantId, url: product.imageUrl, position: 0 }).returning();
      existing.push(adopted);
    }
    const img = await optimizeImage(buffer, mime, PRODUCT_IMAGE_EXT_BY_MIME[mime] ?? 'bin');
    const slug = await tenantSlug(this.db, tenantId);
    const key = `tenants/${slug}/products/${id}/${randomUUID()}.${img.ext}`;
    const { url } = await this.storage.upload(img.buffer, key, img.contentType);
    await this.db.insert(productMedia).values({ productId: id, tenantId, url, position: existing.length });
    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);
  }
```

> Same body as the original `addMedia`, buffer/mime params instead of `file`, no row returned.

- [ ] **Step 4: Run + build**

Run: `pnpm --filter @farmflow/api test -- products.image.spec`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/products/products.service.ts
git commit -m "feat(products): queue gallery-image optimize (addMedia + finishProductMedia)"
```

---

## Task E4: The dispatcher worker + ImageQueueModule

**Files:**
- Create: `server/src/modules/image-queue/image.processor.ts`
- Create: `server/src/modules/image-queue/image-queue.module.ts`
- Modify: `server/src/app.module.ts`
- Create (test): `server/src/modules/image-queue/image.processor.spec.ts`

- [ ] **Step 1: Write the failing dispatcher test**

`server/src/modules/image-queue/image.processor.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { ImageProcessor } from './image.processor';
import { ProductsService } from '../products/products.service';

describe('ImageProcessor dispatch', () => {
  it('routes product-cover to ProductsService.finishProductCover with decoded bytes', async () => {
    const products = { finishProductCover: jest.fn().mockResolvedValue(undefined), finishProductMedia: jest.fn() };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ImageProcessor,
        { provide: ProductsService, useValue: products },
        // other feature services stubbed as needed for the constructor
      ],
    }).compile();
    const proc = mod.get(ImageProcessor);
    const payload = { entityType: 'product-cover', entityId: 'p1', tenantId: 't1', bufferB64: Buffer.from('xy').toString('base64'), mime: 'image/jpeg' };
    await proc.process({ data: payload } as Job);
    expect(products.finishProductCover).toHaveBeenCalledWith('p1', 't1', expect.any(Buffer), 'image/jpeg');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @farmflow/api test -- image.processor.spec`
Expected: FAIL — cannot find module `./image.processor`.

- [ ] **Step 3: Implement the dispatcher**

`server/src/modules/image-queue/image.processor.ts`:

```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { IMAGE_QUEUE } from '../../common/queue/queue.constants';
import { ImageJobPayload } from '../../common/queue/image-job';
import { ProductsService } from '../products/products.service';
import { FarmersService } from '../farmers/farmers.service';
import { SubcategoriesService } from '../subcategories/subcategories.service';
import { TenantsService } from '../tenants/tenants.service';
import { ArticlesService } from '../articles/articles.service';
import { NewsletterService } from '../newsletter/newsletter.service';

@Processor(IMAGE_QUEUE, { concurrency: 3 })
export class ImageProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageProcessor.name);

  constructor(
    private readonly products: ProductsService,
    private readonly farmers: FarmersService,
    private readonly subcategories: SubcategoriesService,
    private readonly tenants: TenantsService,
    private readonly articles: ArticlesService,
    private readonly newsletter: NewsletterService,
  ) {
    super();
  }

  async process(job: Job<ImageJobPayload>): Promise<void> {
    const { entityType, entityId, tenantId, bufferB64, mime } = job.data;
    const buf = Buffer.from(bufferB64, 'base64');
    switch (entityType) {
      case 'product-cover': return this.products.finishProductCover(entityId, tenantId, buf, mime);
      case 'product-media': return this.products.finishProductMedia(entityId, tenantId, buf, mime);
      case 'farmer-cover': return this.farmers.finishFarmerCover(entityId, tenantId, buf, mime);
      case 'farmer-secondary': return this.farmers.finishFarmerSecondary(entityId, tenantId, buf, mime);
      case 'subcategory-cover': return this.subcategories.finishSubcategoryCover(entityId, tenantId, buf, mime);
      case 'subcategory-secondary': return this.subcategories.finishSubcategorySecondary(entityId, tenantId, buf, mime);
      case 'tenant-image': return this.tenants.finishTenantImage(entityId, tenantId, buf, mime);
      case 'article-image': return this.articles.finishArticleImage(entityId, tenantId, buf, mime);
      case 'newsletter-image': return this.newsletter.finishNewsletterImage(entityId, tenantId, buf, mime);
      default: this.logger.warn(`[image] unknown entityType=${entityType}`);
    }
  }
}
```

> The `finish*` method names here MUST match the finishers added in E2/E3/E5.

- [ ] **Step 4: Create the module**

`server/src/modules/image-queue/image-queue.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IMAGE_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';
import { ImageProcessor } from './image.processor';
import { ProductsModule } from '../products/products.module';
import { FarmersModule } from '../farmers/farmers.module';
import { SubcategoriesModule } from '../subcategories/subcategories.module';
import { TenantsModule } from '../tenants/tenants.module';
import { ArticlesModule } from '../articles/articles.module';
import { NewsletterModule } from '../newsletter/newsletter.module';

// One-directional: this module imports the feature modules (which export their
// services); none of them import this one → no circular dependency. The processor
// only loads on copies that run workers.
@Module({
  imports: [
    BullModule.registerQueue({ name: IMAGE_QUEUE }),
    ProductsModule, FarmersModule, SubcategoriesModule, TenantsModule, ArticlesModule, NewsletterModule,
  ],
  providers: [...(RUN_WORKERS ? [ImageProcessor] : [])],
})
export class ImageQueueModule {}
```

- [ ] **Step 5: Register in app.module + ensure feature modules export their services**

- `server/src/app.module.ts`: import `ImageQueueModule` and add it to `imports` (after the feature modules it composes).
- In each of `farmers/subcategories/tenants/articles/newsletter` `*.module.ts`, ensure `exports: [<TheService>]` is present (add if missing).

- [ ] **Step 6: Run the test + build**

Run: `pnpm --filter @farmflow/api test -- image.processor.spec`
Expected: PASS.

Run: `pnpm --filter @farmflow/api build`
Expected: success (this will FAIL until E5 adds the `finish*` methods to the other services — do E5 before building, or stub the finishers first).

- [ ] **Step 7: Commit (after E5 compiles)**

```bash
git add server/src/modules/image-queue server/src/app.module.ts
git commit -m "feat(image): dispatcher worker + ImageQueueModule"
```

---

## Task E5: Split the remaining 5 services (identical pattern)

Apply the **exact same split** as Task E2 to each site below. For each: inject
`@InjectQueue(IMAGE_QUEUE)` + import `encodeImageJob`; register the `IMAGE_QUEUE`
producer in the module + `exports` the service; turn the upload method into
`{ findOne/validate → imageQueue.add('process', encodeImageJob(<type>, id, tenantId, file)) → return { ...row, imageProcessing: true } }`; move the old body into the matching `finish*` method (buffer/mime params, no return).

**Sites + finisher names (must match `image.processor.ts`):**

- [ ] `farmers.service.ts:203` → `uploadImage` → enqueue `farmer-cover`, finisher `finishFarmerCover`.
- [ ] `farmers.service.ts:257` → second upload → enqueue `farmer-secondary`, finisher `finishFarmerSecondary`.
- [ ] `subcategories.service.ts:113` → enqueue `subcategory-cover`, finisher `finishSubcategoryCover`.
- [ ] `subcategories.service.ts:167` → enqueue `subcategory-secondary`, finisher `finishSubcategorySecondary`.
- [ ] `tenants.service.ts:240` → enqueue `tenant-image`, finisher `finishTenantImage`.
- [ ] `articles.service.ts:256` → enqueue `article-image`, finisher `finishArticleImage`.
- [ ] `newsletter.service.ts:240` → enqueue `newsletter-image`, finisher `finishNewsletterImage`.

> Open each file first and confirm the exact upload signature + which DB columns/
> key-prefix/crop it writes — the finisher is byte-for-byte today's body with
> `file.buffer`→`buffer`, `file.mimetype`→`mime`. Add one enqueue test per service
> mirroring `products.image.spec.ts`.

- [ ] **For each site:** write the enqueue test → run (fail) → split the method → run (pass) → commit:

```bash
git add server/src/modules/<service> && git commit -m "feat(<service>): queue image optimize (enqueue + finisher)"
```

- [ ] **After all sites: full build + suite**

Run: `pnpm --filter @farmflow/api build && pnpm --filter @farmflow/api test`
Expected: both green; `image.processor.ts` now resolves every finisher.

---

## Task E6: Admin UI — show "processing" + refetch

**Files (admin app — confirm exact paths in `client/`):**
- Product dialog (cover + gallery upload handlers).
- Farmer / subcategory / settings (tenant) / article / newsletter image upload handlers.

- [ ] **Step 1: After an upload that returns `imageProcessing: true`**, show a placeholder/badge (e.g. „обработва се…") in place of the image and trigger a refetch of the entity/list after a short delay (e.g. refetch the list query, or poll the single entity until `imageUrl` changes). Reuse the existing post-mutation refetch the dialog already does on save — just gate the "image ready" display on the url being present.

- [ ] **Step 2: Verify in the running admin app** (per the preview/verify workflow): upload a product photo → placeholder appears → within ~1–2s a refetch shows the optimized image. Upload with the worker stopped → placeholder persists (job waits in the queue); start the worker → image appears. This proves the decoupling end-to-end.

- [ ] **Step 3: Commit**

```bash
git add client/<changed files>
git commit -m "feat(admin): show processing placeholder for async image uploads"
```

---

## Final verification (Phase E)

- [ ] `pnpm --filter @farmflow/api build && pnpm --filter @farmflow/api test` → green.
- [ ] Local two-role smoke: `APP_ROLE=web` (upload) + `APP_ROLE=worker` (drains) against shared Redis + R2 → uploaded image appears after the worker runs; upload with worker down → job waits, processes when worker starts.

---

## Self-review notes (author)

- `finish*` method names are consistent between `image.processor.ts` (E4) and the service splits (E2/E3/E5).
- `ImageJobPayload.entityType` union values match every `encodeImageJob(...)` call and every `switch` case.
- No circular module dependency: `ImageQueueModule` imports feature modules; feature modules only import the global `StorageModule` + register the `IMAGE_QUEUE` producer.
- Buffer-in-payload avoids needing a `StorageService.download()` and works in dev stub mode.
- Known cut (flagged): per-service finishers are near-duplicate of today's bodies — repetition is intentional (each writes a different table/column/crop); they are NOT collapsed into one generic writer to avoid string-keyed drizzle updates.
