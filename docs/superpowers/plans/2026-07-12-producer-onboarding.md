# Producer Onboarding Engine (Phase 1+2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A producer publishes their catalog from one photo of a price list (farmer panel), and the operator onboards a producer in one action (create + AI-import + magic link) from the super-admin console.

**Architecture:** Move the existing text-only `ProductExtractService` (super-admin AI import) into a shared `ai-import` NestJS module and extend it with a vision path (sharp downscale → gpt-4o-mini `image_url`). Expose it tenant-scoped (`/products/ai-import/*`) for the farmer panel with the same IDOR scoping as `/stats`, and platform-scoped (`/platform/tenants/:id/producers/onboard`) for one-shot operator onboarding that reuses `FarmersService.create`, `grantAccess`, and `AuthService.issueInvite`.

**Tech Stack:** NestJS + Drizzle (server), Next.js app-router ×2 (client = farmer panel, admin = super-admin console), OpenAI SDK (`gpt-4o-mini`), sharp, BullMQ (NOT used in this plan — image-sanity worker is a separate future plan), jest.

**Spec:** `docs/superpowers/specs/2026-07-12-producer-onboarding-design.md` (Phases 1+2. Phase 3 image-sanity worker is OUT of this plan.)

## Global Constraints

- All user-facing copy is Bulgarian. Prices are integer stotinki (eurocents) — never floats.
- Monorepo: `server/` = NestJS API (`@fermeribg/api`), `client/` = farmer panel (`@fermeribg/web`), `admin/` = super-admin console (`@fermeribg/admin`). pnpm workspaces.
- Run jest as: `pnpm --filter @fermeribg/api exec jest <path>` from repo root. Typecheck: `npx tsc --noEmit -p tsconfig.json` inside each package dir.
- Every commit message ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Admin UI uses the `ff-*` Tailwind tokens (e.g. `bg-ff-surface`, `border-ff-border`, `text-ff-ink`); NEVER raw hex, NEVER `border-left` accent stripes. Client (farmer panel) targets non-digital users: big labels, one obvious primary action.
- OpenAI calls are foreground here (human waits on preview) — 30s client timeout already configured in the service; do not add queues in this plan.
- No DB migrations are needed in this plan. Do not touch `server/src/modules/vendor-finance/*`.
- `git push` only at the very end (final task) — pushing to main auto-deploys production.

---

### Task 1: Move ProductExtractService into a shared `ai-import` module

**Files:**
- Create: `server/src/modules/ai-import/ai-import.module.ts`
- Move (git mv): `server/src/modules/platform/product-extract.service.ts` → `server/src/modules/ai-import/product-extract.service.ts`
- Modify: `server/src/modules/platform/platform.module.ts` (drop provider, add module import)
- Modify: `server/src/modules/platform/platform.controller.ts` (import path only)

**Interfaces:**
- Consumes: existing `ProductExtractService` (`parseToText(file, text)`, `extract(text)`, `ExtractedProduct`).
- Produces: `AiImportModule` exporting `ProductExtractService` — Tasks 2/3/4/6 import from `../ai-import/product-extract.service`.

- [ ] **Step 1: Move the file**

```bash
cd server
git mv src/modules/platform/product-extract.service.ts src/modules/ai-import/product-extract.service.ts
```

- [ ] **Step 2: Create the module**

`server/src/modules/ai-import/ai-import.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ProductExtractService } from './product-extract.service';

/**
 * AI product import: turns a pasted price list, an uploaded file, or (vision) a
 * PHOTO of a price list into clean product rows. Shared by the super-admin
 * onboarding import and the tenant-facing "add from photo" flow.
 */
@Module({
  providers: [ProductExtractService],
  exports: [ProductExtractService],
})
export class AiImportModule {}
```

- [ ] **Step 3: Rewire PlatformModule**

In `server/src/modules/platform/platform.module.ts`:
1. Delete the line `import { ProductExtractService } from './product-extract.service';`
2. Add `import { AiImportModule } from '../ai-import/ai-import.module';`
3. Add `AiImportModule,` to the `imports:` array (next to `VendorFinanceModule,`).
4. Remove `ProductExtractService,` from the `providers:` array.

- [ ] **Step 4: Fix the controller import**

In `server/src/modules/platform/platform.controller.ts` replace:

```ts
import { ProductExtractService } from './product-extract.service';
```

with:

```ts
import { ProductExtractService } from '../ai-import/product-extract.service';
```

Also update the inline type import in the extract endpoint's return type: replace `import('./product-extract.service').ExtractedProduct` with `import('../ai-import/product-extract.service').ExtractedProduct`.

- [ ] **Step 5: Typecheck + existing platform tests**

```bash
cd server && npx tsc --noEmit -p tsconfig.json
cd .. && pnpm --filter @fermeribg/api exec jest src/modules/platform
```

Expected: tsc silent; platform suites PASS (marketplace-finance, demo-seed, operator-digest, platform.service).

- [ ] **Step 6: Commit**

```bash
git add -A server/src/modules
git commit -m "refactor(server): move ProductExtractService into shared ai-import module

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Vision path — extract products from a photo

**Files:**
- Modify: `server/src/modules/ai-import/product-extract.service.ts`
- Test: `server/src/modules/ai-import/product-extract.service.spec.ts` (new)

**Interfaces:**
- Consumes: existing `SYSTEM_PROMPT`, `coerce()`, `this.client` (OpenAI), `this.model`.
- Produces: `isImageFile(file: Express.Multer.File): boolean` (exported helper) and `extractFromImage(file: Express.Multer.File): Promise<ExtractedProduct[]>` — used by Task 3 and Task 6.

- [ ] **Step 1: Refactor — share the completion-parsing tail**

In `product-extract.service.ts`, the existing `extract(text)` method calls `this.client.chat.completions.create(...)` and then parses the JSON reply into `ExtractedProduct[]` (JSON.parse of the first choice's content, read `.products`, map through `coerce`, cap at `MAX_ROWS`). Cut that post-completion parsing block VERBATIM into a new private method and call it from `extract`:

```ts
  /** Parse one completion's raw content into clean rows (shared by text + vision). */
  private parseCompletion(raw: string | null | undefined): ExtractedProduct[] {
    // <verbatim body moved from extract(): the JSON.parse → products array →
    //  coerce() map → filter nulls → slice(0, MAX_ROWS) block>
  }
```

`extract(text)` keeps its own try/catch and error mapping exactly as-is, just delegating the parsing: `return this.parseCompletion(res.choices[0]?.message?.content);` (match the existing local variable name for the completion result).

- [ ] **Step 2: Write the failing tests**

`server/src/modules/ai-import/product-extract.service.spec.ts`:

```ts
import { ConfigService } from '@nestjs/config';
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

const file = (over: Partial<Express.Multer.File> = {}): Express.Multer.File =>
  ({
    fieldname: 'file',
    originalname: 'cenorazpis.jpg',
    mimetype: 'image/jpeg',
    size: 1024,
    buffer: Buffer.from('raw'),
    ...over,
  }) as Express.Multer.File;

function service(create: jest.Mock): ProductExtractService {
  const config = { get: (k: string, d?: string) => (k === 'OPENAI_API_KEY' ? 'test-key' : d) } as unknown as ConfigService;
  const svc = new ProductExtractService(config);
  (svc as any).client = { chat: { completions: { create } } };
  return svc;
}

describe('isImageFile', () => {
  it('accepts jpeg/png/webp, rejects the rest', () => {
    expect(isImageFile(file({ mimetype: 'image/jpeg' }))).toBe(true);
    expect(isImageFile(file({ mimetype: 'image/png' }))).toBe(true);
    expect(isImageFile(file({ mimetype: 'image/webp' }))).toBe(true);
    expect(isImageFile(file({ mimetype: 'text/csv' }))).toBe(false);
    expect(isImageFile(file({ mimetype: 'application/pdf' }))).toBe(false);
  });
});

describe('extractFromImage', () => {
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
    const rows = await service(create).extractFromImage(file());
    expect(rows).toEqual([{ name: 'Домати', priceStotinki: 450, unit: 'кг', isActive: true }]);
    const msg = create.mock.calls[0][0].messages[1];
    const img = msg.content.find((p: any) => p.type === 'image_url');
    expect(img.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('rejects an oversized image with a BG message', async () => {
    const create = jest.fn();
    await expect(
      service(create).extractFromImage(file({ size: 11 * 1024 * 1024 })),
    ).rejects.toThrow('Снимката е твърде голяма');
    expect(create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm --filter @fermeribg/api exec jest src/modules/ai-import/product-extract.service.spec.ts
```

Expected: FAIL — `isImageFile` / `extractFromImage` not exported / not a function.

- [ ] **Step 4: Implement**

In `product-extract.service.ts` add (top-level, near `MAX_TEXT`):

```ts
import sharp from 'sharp';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_RE = /^image\/(jpeg|png|webp)$/;

/** True when the upload is a photo the vision path should handle. */
export function isImageFile(file: Express.Multer.File): boolean {
  return IMAGE_MIME_RE.test(file.mimetype ?? '');
}
```

and the method on the service (below `extract`):

```ts
  /**
   * Vision path: a PHOTO of a price list (paper/handwritten) → product rows.
   * Downscaled before sending — vision cost scales with pixels and 1600px is
   * plenty for OCR. Same prompt + coercion as the text path.
   */
  async extractFromImage(file: Express.Multer.File): Promise<ExtractedProduct[]> {
    if (!this.client) {
      throw new ServiceUnavailableException('AI импортът не е настроен (липсва OPENAI_API_KEY).');
    }
    if (!isImageFile(file)) throw new BadRequestException('Подайте снимка (JPEG/PNG/WebP).');
    if (file.size > MAX_IMAGE_BYTES) {
      throw new BadRequestException('Снимката е твърде голяма (до 10MB). Снимайте отново или я компресирайте.');
    }
    // .rotate() honours EXIF orientation — phone photos are often sideways.
    const jpeg = await sharp(file.buffer)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const dataUri = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Извади продуктите от този ценоразпис (снимка).' },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          },
        ],
      });
      return this.parseCompletion(res.choices[0]?.message?.content);
    } catch (e) {
      this.log.warn(`OpenAI image extract failed: ${String((e as Error)?.message ?? e)}`);
      throw new BadGatewayException('AI разчитането на снимката не успя. Опитайте пак или поставете текста.');
    }
  }
```

Match the existing `extract()` for the exact `create(...)` options shape (e.g. if it passes `temperature`/`response_format`, mirror them) — read it first.

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @fermeribg/api exec jest src/modules/ai-import/product-extract.service.spec.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
git add server/src/modules/ai-import
git commit -m "feat(ai-import): vision extract — photo of a price list to product rows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Tenant-scoped extract endpoint (`POST /products/ai-import/extract`)

**Files:**
- Create: `server/src/modules/ai-import/ai-import.controller.ts`
- Modify: `server/src/modules/ai-import/ai-import.module.ts`
- Modify: `server/src/app.module.ts` (register `AiImportModule` — find the `imports:` array; add next to the other feature modules, e.g. after `ImportModule`)
- Test: `server/src/modules/ai-import/ai-import.controller.spec.ts` (new)

**Interfaces:**
- Consumes: `ProductExtractService.parseToText/extract/extractFromImage`, `isImageFile` (Task 2); `JwtAuthGuard`, `Roles`, `CurrentTenant`, `CurrentUser`, `effectiveFarmerId` (existing, same imports as `products.controller.ts`).
- Produces: `POST /products/ai-import/extract` → `{ products: ExtractedProduct[] }`. Controller class `AiImportController` — Task 4 adds the commit route to it.

- [ ] **Step 1: Write the failing controller test**

`server/src/modules/ai-import/ai-import.controller.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @fermeribg/api exec jest src/modules/ai-import/ai-import.controller.spec.ts
```

Expected: FAIL — `ai-import.controller` module not found.

- [ ] **Step 3: Implement the controller (extract route only)**

`server/src/modules/ai-import/ai-import.controller.ts`:

```ts
import { Body, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { effectiveFarmerId } from '../../common/scope/farmer-scope.util';
import type { TenantRequestUser } from '@fermeribg/types';
import { ProductsService } from '../products/products.service';
import { ProductExtractService, isImageFile, type ExtractedProduct } from './product-extract.service';
import { CommitAiImportDto } from './dto/commit-ai-import.dto';

/**
 * Tenant-facing AI product import: photo / pasted list → preview rows → commit.
 * Same extraction engine as the super-admin onboarding import; the difference is
 * auth (tenant JWT) and scoping (a producer commits only into their own catalog).
 */
@ApiTags('ai-import')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('products/ai-import')
export class AiImportController {
  constructor(
    private readonly extractSvc: ProductExtractService,
    private readonly productsSvc: ProductsService,
  ) {}

  // Foreground OpenAI call — throttled so one user can't burn the API budget.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('extract')
  @Roles('admin', 'farmer')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async extract(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('text') text: string | undefined,
  ): Promise<{ products: ExtractedProduct[] }> {
    if (file && isImageFile(file)) {
      return { products: await this.extractSvc.extractFromImage(file) };
    }
    const content = await this.extractSvc.parseToText(file, text);
    return { products: await this.extractSvc.extract(content) };
  }
}
```

(`CommitAiImportDto` import will be created in Task 4 — for THIS task's compile, create the DTO file as an empty class placeholder is NOT allowed; instead add the import in Task 4. Leave the import line OUT in this task.)

- [ ] **Step 4: Wire the module**

`ai-import.module.ts` becomes:

```ts
import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { ProductExtractService } from './product-extract.service';
import { AiImportController } from './ai-import.controller';

@Module({
  imports: [ProductsModule],
  controllers: [AiImportController],
  providers: [ProductExtractService],
  exports: [ProductExtractService],
})
export class AiImportModule {}
```

In `server/src/app.module.ts`: add `import { AiImportModule } from './modules/ai-import/ai-import.module';` and `AiImportModule,` in the `imports:` array (grep for `ImportModule` to find the spot).

- [ ] **Step 5: Run tests + typecheck**

```bash
pnpm --filter @fermeribg/api exec jest src/modules/ai-import
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
```

Expected: all ai-import tests PASS; tsc silent.

- [ ] **Step 6: Commit**

```bash
git add server/src
git commit -m "feat(ai-import): tenant-scoped extract endpoint (photo or text to preview rows)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Commit endpoint with producer IDOR scope

**Files:**
- Create: `server/src/modules/ai-import/dto/commit-ai-import.dto.ts`
- Modify: `server/src/modules/ai-import/ai-import.controller.ts`
- Test: extend `server/src/modules/ai-import/ai-import.controller.spec.ts`

**Interfaces:**
- Consumes: `ProductsService.create(tenantId: string, dto: CreateProductDto, scope: string | null)` (exact signature used by `products.controller.ts` `@Post()`).
- Produces: `POST /products/ai-import/commit` body `{ products: AiImportProductDto[], farmerId?: string }` → `{ created: number }`. Client (Task 5) and admin onboarding rely on this shape.

- [ ] **Step 1: DTO**

`server/src/modules/ai-import/dto/commit-ai-import.dto.ts`:

```ts
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsInt, IsNotEmpty, IsOptional,
  IsString, IsUUID, MaxLength, Min, ValidateNested,
} from 'class-validator';

/** One reviewed row from the AI-extract preview. Mirrors ExtractedProduct. */
export class AiImportProductDto {
  @IsString()
  @IsNotEmpty({ message: 'Името на продукта е задължително.' })
  @MaxLength(200)
  name!: string;

  @IsInt()
  @Min(0)
  priceStotinki!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  unit!: string;

  @IsOptional() @IsString() @MaxLength(100)
  weight?: string;

  @IsOptional() @IsString() @MaxLength(100)
  category?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export class CommitAiImportDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => AiImportProductDto)
  products!: AiImportProductDto[];

  /** Owner-only: attach the rows to one producer. A producer token is always
   *  forced to its own farmerId regardless of this field. */
  @IsOptional()
  @IsUUID()
  farmerId?: string;
}
```

- [ ] **Step 2: Failing tests**

Append to `ai-import.controller.spec.ts`:

```ts
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
```

- [ ] **Step 3: Run to verify failure**

```bash
pnpm --filter @fermeribg/api exec jest src/modules/ai-import/ai-import.controller.spec.ts
```

Expected: FAIL — `commit` is not a function.

- [ ] **Step 4: Implement commit**

Add to `AiImportController` (plus the `CommitAiImportDto` import at top):

```ts
  /** Publish the reviewed rows. Row-by-row through the SAME validated create path
   *  a manual product create uses — a malformed row fails like a manual one would. */
  @Post('commit')
  @Roles('admin', 'farmer')
  async commit(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Body() dto: CommitAiImportDto,
  ): Promise<{ created: number }> {
    const scope = effectiveFarmerId(user.role, user.farmerId, dto.farmerId);
    let created = 0;
    for (const p of dto.products) {
      await this.productsSvc.create(
        tenantId,
        {
          name: p.name,
          priceStotinki: p.priceStotinki,
          unit: p.unit,
          weight: p.weight,
          category: p.category,
          description: p.description,
          isActive: p.isActive ?? true,
          farmerId: scope ?? undefined,
        } as Parameters<ProductsService['create']>[1],
        scope,
      );
      created++;
    }
    return { created };
  }
```

- [ ] **Step 5: Run tests + typecheck; fix the `as` cast if CreateProductDto accepts the literal directly (preferred: import `CreateProductDto` and build a typed object).**

```bash
pnpm --filter @fermeribg/api exec jest src/modules/ai-import
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
```

Expected: PASS ×4+; tsc silent.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/ai-import
git commit -m "feat(ai-import): commit endpoint — reviewed rows into the catalog, producer-scoped

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Farmer-panel UI — „Добави от снимка или списък"

**Files:**
- Modify: `client/src/lib/api-client.ts` (add 2 functions + 1 type near the existing `getCommissionSummary` block; the file already has an `apiFetch` helper hitting `/bff/${path}`)
- Create: `client/src/components/products/ai-import-dialog.tsx`
- Modify: `client/src/components/products/products-client.tsx` (mount the dialog + a header button)

**Interfaces:**
- Consumes: `POST products/ai-import/extract` (multipart `file` or `text`) → `{ products: ExtractedProduct[] }`; `POST products/ai-import/commit` `{ products, farmerId? }` → `{ created }` (Task 3/4).
- Produces: `<AiImportDialog open onClose onDone />` component; `extractAiProducts`, `commitAiProducts` api functions.

- [ ] **Step 1: api-client functions**

Add to `client/src/lib/api-client.ts` (bottom):

```ts
// ── AI product import (photo / pasted list → preview → commit) ──

export interface AiExtractedProduct {
  name: string;
  priceStotinki: number;
  unit: string;
  weight?: string;
  category?: string;
  description?: string;
  isActive?: boolean;
}

/** Photo or pasted text → AI-extracted preview rows. Multipart: do NOT set
 *  content-type — the browser sets the boundary and the BFF forwards it. */
export const extractAiProducts = (input: { file?: File; text?: string }) => {
  const fd = new FormData();
  if (input.file) fd.append('file', input.file);
  if (input.text) fd.append('text', input.text);
  return apiFetch<{ products: AiExtractedProduct[] }>('products/ai-import/extract', {
    method: 'POST',
    body: fd,
  });
};

/** Publish the reviewed rows (owner may target one producer via farmerId). */
export const commitAiProducts = (products: AiExtractedProduct[], farmerId?: string) =>
  apiFetch<{ created: number }>('products/ai-import/commit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ products, ...(farmerId ? { farmerId } : {}) }),
  });
```

Match the file's existing `apiFetch` call style (error message argument etc.) — read 2-3 neighbouring functions first and mirror them exactly.

- [ ] **Step 2: The dialog component**

First read `client/src/components/products/product-dialog.tsx` and copy its modal shell (overlay + panel classes, close button, focus handling). Then create `client/src/components/products/ai-import-dialog.tsx` with this structure and behavior (adapt class names to whatever the shell uses — do not invent a new modal system):

```tsx
'use client';

import { useRef, useState } from 'react';
import { Camera, ClipboardPaste, Loader2, Trash2 } from 'lucide-react';
import { extractAiProducts, commitAiProducts, type AiExtractedProduct } from '@/lib/api-client';

/** Photo/paste → AI preview → publish. The preview table is the safety gate:
 *  vision misreads handwriting, so a human confirms every row before commit. */
export function AiImportDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after a successful commit so the products list can refresh. */
  onDone: (created: number) => void;
}) {
  const [mode, setMode] = useState<'photo' | 'text'>('photo');
  const [text, setText] = useState('');
  const [rows, setRows] = useState<AiExtractedProduct[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  async function runExtract(input: { file?: File; text?: string }) {
    setBusy(true);
    setErr(null);
    try {
      const res = await extractAiProducts(input);
      if (res.products.length === 0) setErr('Не разчетохме продукти. Опитайте с по-ясна снимка или поставете текста.');
      else setRows(res.products);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Грешка при разчитането.');
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!rows?.length) return;
    setBusy(true);
    setErr(null);
    try {
      const { created } = await commitAiProducts(rows);
      onDone(created);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Грешка при публикуването.');
    } finally {
      setBusy(false);
    }
  }

  const patchRow = (i: number, patch: Partial<AiExtractedProduct>) =>
    setRows((r) => r!.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const dropRow = (i: number) => setRows((r) => r!.filter((_, idx) => idx !== i));

  // …modal shell from product-dialog.tsx around:
  // Stage 1 (rows === null): two big tabs —
  //   „Снимай ценоразписа" → <input ref={fileRef} type="file" accept="image/*"
  //     capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void runExtract({ file: f }); }} />
  //     + a large tap target button that clicks fileRef
  //   „Постави текст" → <textarea value={text} …/> + button „Разчети" → runExtract({ text })
  //   busy → <Loader2 className="animate-spin" /> + „Разчитаме…“
  // Stage 2 (rows): editable table — columns Име (text input), Цена в € (number input,
  //   value={(row.priceStotinki / 100).toFixed(2)}, onChange → patchRow(i, { priceStotinki: Math.round(parseFloat(v || '0') * 100) })),
  //   Единица (text input), delete row (Trash2 → dropRow) — plus footer:
  //   „{rows.length} продукта" · button „Откажи" · primary „Публикувай“ → publish()
  // err → red text line above the footer.
}
```

The comment block above is the REQUIRED structure — implement it fully in JSX (no dead comments left in the final file). Big touch targets (min h-12 buttons), Bulgarian labels exactly as written.

- [ ] **Step 3: Mount in the products screen**

In `client/src/components/products/products-client.tsx`: find the header action that opens the existing „Нов продукт" dialog (grep `Нов продукт`). Next to it add:

```tsx
<Button variant="outline" onClick={() => setAiImportOpen(true)}>
  <Camera className="mr-2 h-5 w-5" /> Добави от снимка
</Button>
```

plus state `const [aiImportOpen, setAiImportOpen] = useState(false);` and at the bottom of the JSX:

```tsx
<AiImportDialog
  open={aiImportOpen}
  onClose={() => setAiImportOpen(false)}
  onDone={(created) => {
    toast.success(`Добавени ${created} продукта`);
    router.refresh();
  }}
/>
```

Mirror the file's existing imports (Button, toast, router) — if it uses a different refresh pattern (e.g. a `reload()` callback or state setter), use THAT instead of `router.refresh()`.

- [ ] **Step 4: Typecheck + dev-compile**

```bash
cd client && npx tsc --noEmit -p tsconfig.json && cd ..
```

Expected: silent. (The page itself is auth-gated; tsc + compile is the verification bar here.)

- [ ] **Step 5: Commit**

```bash
git add client/src
git commit -m "feat(client): add products from a photo — AI import dialog in the farmer panel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Platform one-shot producer onboarding endpoint

**Files:**
- Create: `server/src/modules/platform/producer-onboard.service.ts`
- Create: `server/src/modules/platform/dto/onboard-producer.dto.ts`
- Modify: `server/src/modules/platform/platform.controller.ts` (one new route)
- Modify: `server/src/modules/platform/platform.module.ts` (one new provider)
- Test: `server/src/modules/platform/producer-onboard.service.spec.ts`

**Interfaces:**
- Consumes: `FarmersService.create(tenantId, dto): Promise<Farmer>`; `FarmersService.grantAccess(tenantId, farmerId, email)`; `AuthService.issueInvite(userId, { appUrl, email?, subject? }): Promise<{ link: string }>`; `ProductExtractService.extract/extractFromImage` + `isImageFile`; `ProductsService.create(tenantId, dto, scope)`; Drizzle `users` table (lookup userId by farmerId).
- Produces: `POST /platform/tenants/:id/producers/onboard` (multipart) → `{ farmerId: string; productsCreated: number; inviteLink: string | null }`.

- [ ] **Step 1: DTO**

`server/src/modules/platform/dto/onboard-producer.dto.ts`:

```ts
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** One-shot producer onboarding: create + optional AI catalog + optional invite.
 *  The price list photo arrives as the multipart `file` part, not in this DTO. */
export class OnboardProducerDto {
  @IsString()
  @IsNotEmpty({ message: 'Името на производителя е задължително.' })
  @MaxLength(200)
  name!: string;

  @IsOptional() @IsString() @MaxLength(50)
  phone?: string;

  @IsOptional() @IsEmail({}, { message: 'Невалиден имейл.' })
  email?: string;

  @IsOptional() @IsString() @MaxLength(100_000)
  pricelistText?: string;
}
```

- [ ] **Step 2: Failing service spec**

`server/src/modules/platform/producer-onboard.service.spec.ts`:

```ts
import { ProducerOnboardService } from './producer-onboard.service';

const IMG = { mimetype: 'image/jpeg', size: 5, buffer: Buffer.from('x') } as Express.Multer.File;

function makeDb(userRow: { id: string } | undefined) {
  const step: any = {};
  for (const m of ['select', 'from', 'where', 'limit']) step[m] = jest.fn(() => step);
  step.then = (res: (v: unknown) => void) => res(userRow ? [userRow] : []);
  const db: any = {};
  for (const m of ['select', 'from', 'where', 'limit']) db[m] = jest.fn(() => step);
  return db;
}

function make(over: Record<string, unknown> = {}, userRow: { id: string } | undefined = { id: 'u1' }) {
  const deps = {
    farmers: { create: jest.fn().mockResolvedValue({ id: 'f1' }), grantAccess: jest.fn().mockResolvedValue({}) },
    extract: {
      extract: jest.fn().mockResolvedValue([{ name: 'Домати', priceStotinki: 450, unit: 'кг', isActive: true }]),
      extractFromImage: jest.fn().mockResolvedValue([{ name: 'Мед', priceStotinki: 1200, unit: 'бр', isActive: true }]),
    },
    products: { create: jest.fn().mockResolvedValue({ id: 'p1' }) },
    auth: { issueInvite: jest.fn().mockResolvedValue({ link: 'https://x/reset-password?token=t' }) },
    config: { get: jest.fn().mockReturnValue('https://panel.example') },
    ...over,
  };
  const svc = new ProducerOnboardService(
    makeDb(userRow),
    deps.farmers as any,
    deps.extract as any,
    deps.products as any,
    deps.auth as any,
    deps.config as any,
  );
  return { svc, deps };
}

describe('ProducerOnboardService.onboard', () => {
  it('creates the producer, imports the pasted list under their id, and mints an invite link', async () => {
    const { svc, deps } = make();
    const res = await svc.onboard('t1', { name: 'Иван', email: 'ivan@x.bg', pricelistText: 'домати 4.50' }, undefined);
    expect(deps.farmers.create).toHaveBeenCalledWith('t1', { name: 'Иван', phone: undefined });
    expect(deps.products.create).toHaveBeenCalledWith('t1', expect.objectContaining({ farmerId: 'f1' }), 'f1');
    expect(deps.farmers.grantAccess).toHaveBeenCalledWith('t1', 'f1', 'ivan@x.bg');
    expect(deps.auth.issueInvite).toHaveBeenCalledWith('u1', expect.objectContaining({ email: false }));
    expect(res).toEqual({ farmerId: 'f1', productsCreated: 1, inviteLink: 'https://x/reset-password?token=t' });
  });

  it('uses the vision path for a photo and skips the invite when no email', async () => {
    const { svc, deps } = make();
    const res = await svc.onboard('t1', { name: 'Иван' }, IMG);
    expect(deps.extract.extractFromImage).toHaveBeenCalledWith(IMG);
    expect(deps.farmers.grantAccess).not.toHaveBeenCalled();
    expect(res.inviteLink).toBeNull();
    expect(res.productsCreated).toBe(1);
  });

  it('still succeeds with zero products when no price list is given', async () => {
    const { svc, deps } = make();
    const res = await svc.onboard('t1', { name: 'Иван' }, undefined);
    expect(deps.products.create).not.toHaveBeenCalled();
    expect(res.productsCreated).toBe(0);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
pnpm --filter @fermeribg/api exec jest src/modules/platform/producer-onboard.service.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement the service**

`server/src/modules/platform/producer-onboard.service.ts`:

```ts
import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { type Database, users } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { FarmersService } from '../farmers/farmers.service';
import { ProductsService } from '../products/products.service';
import { AuthService } from '../auth/auth.service';
import { ProductExtractService, isImageFile } from '../ai-import/product-extract.service';
import { OnboardProducerDto } from './dto/onboard-producer.dto';

export interface OnboardResult {
  farmerId: string;
  productsCreated: number;
  inviteLink: string | null;
}

/**
 * One operator action = a working producer: create the farmer under the brand
 * tenant, AI-import their price list (photo or text) attached to their id, and
 * mint a 7-day single-use set-password link the operator shares over Viber.
 * Sequential on purpose — each stage's failure message tells the operator
 * exactly which part to retry.
 */
@Injectable()
export class ProducerOnboardService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly farmers: FarmersService,
    private readonly extract: ProductExtractService,
    private readonly products: ProductsService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  async onboard(
    tenantId: string,
    dto: OnboardProducerDto,
    file: Express.Multer.File | undefined,
  ): Promise<OnboardResult> {
    const farmer = await this.farmers.create(tenantId, { name: dto.name, phone: dto.phone });

    let productsCreated = 0;
    if ((file && isImageFile(file)) || dto.pricelistText?.trim()) {
      const rows =
        file && isImageFile(file)
          ? await this.extract.extractFromImage(file)
          : await this.extract.extract(dto.pricelistText!.trim());
      for (const p of rows) {
        await this.products.create(tenantId, { ...p, farmerId: farmer.id }, farmer.id);
        productsCreated++;
      }
    }

    let inviteLink: string | null = null;
    if (dto.email) {
      await this.farmers.grantAccess(tenantId, farmer.id, dto.email);
      const [user] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.farmerId, farmer.id), eq(users.tenantId, tenantId)))
        .limit(1);
      if (!user) throw new InternalServerErrorException('Достъпът е създаден, но профилът не бе намерен.');
      const appUrl = this.config.get<string>('PUBLIC_APP_URL') ?? 'http://localhost:3000';
      const { link } = await this.auth.issueInvite(user.id, {
        appUrl,
        email: false, // grantAccess already emailed; this link is for Viber sharing
        subject: 'Покана за достъп — ФермериБГ',
      });
      inviteLink = link;
    }

    return { farmerId: farmer.id, productsCreated, inviteLink };
  }
}
```

- [ ] **Step 5: Route + provider**

In `platform.controller.ts` add (imports: `ProducerOnboardService`, `OnboardProducerDto`; `FileInterceptor` is already imported):

```ts
  /** One-shot producer onboarding: create + AI-import price list + invite link. */
  @Post('tenants/:id/producers/onboard')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  onboardProducer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OnboardProducerDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.producerOnboard.onboard(id, dto, file);
  }
```

with `private readonly producerOnboard: ProducerOnboardService,` added to the constructor. In `platform.module.ts` add `ProducerOnboardService` to `providers` (import from `./producer-onboard.service`). `FarmersModule`, `ProductsModule`, `AuthModule`, `AiImportModule` are already in `imports` — verify `FarmersModule` exports `FarmersService` (grep `exports` in `farmers.module.ts`; if missing, add it).

- [ ] **Step 6: Run tests + typecheck**

```bash
pnpm --filter @fermeribg/api exec jest src/modules/platform/producer-onboard.service.spec.ts
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
```

Expected: PASS ×3; tsc silent.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/platform
git commit -m "feat(platform): one-shot producer onboarding — create, AI-import, invite link

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Super-admin UI — „Onboard производител" on the brand page

**Files:**
- Modify: `admin/src/lib/api-client.ts` (one function + result type)
- Create: `admin/src/components/producer-onboard-dialog.tsx`
- Modify: `admin/src/components/tenant-detail-client.tsx` (button + dialog mount, next to the existing `ProductImportDialog` trigger — grep `ProductImportDialog`)

**Interfaces:**
- Consumes: `POST platform/tenants/:id/producers/onboard` (Task 6) via the admin `/bff` proxy; admin modal pattern (`animate-ff-pop fixed left-1/2 top-1/2 …` — copy from `tenants-client.tsx` dialogs); `CopyButton` pattern from `tenants-client.tsx`.
- Produces: `onboardProducer(tenantId, form)` api function; `<ProducerOnboardDialog tenantId open onClose />`.

- [ ] **Step 1: api-client**

Append to `admin/src/lib/api-client.ts`:

```ts
// ── One-shot producer onboarding (create + AI-import + invite link) ──

export interface OnboardProducerResult {
  farmerId: string;
  productsCreated: number;
  inviteLink: string | null;
}

/** Multipart: do NOT set content-type — the browser sets the boundary. */
export const onboardProducer = (
  tenantId: string,
  input: { name: string; phone?: string; email?: string; pricelistText?: string; file?: File },
) => {
  const fd = new FormData();
  fd.append('name', input.name);
  if (input.phone) fd.append('phone', input.phone);
  if (input.email) fd.append('email', input.email);
  if (input.pricelistText) fd.append('pricelistText', input.pricelistText);
  if (input.file) fd.append('file', input.file);
  return apiFetch<OnboardProducerResult>(
    `platform/tenants/${tenantId}/producers/onboard`,
    { method: 'POST', body: fd },
    'Неуспешно създаване на производителя',
  );
};
```

- [ ] **Step 2: Dialog component**

`admin/src/components/producer-onboard-dialog.tsx` — follow the exact modal shell used by the dialogs in `tenants-client.tsx` (`animate-ff-fade fixed inset-0 z-40 bg-ff-overlay` scrim + `animate-ff-pop fixed left-1/2 top-1/2 z-50 w-[460px] …` panel). Content:

- **Form stage:** fields Име* (text), Телефон (tel), Имейл (email — „с имейл ще получи и покана по пощата"), Ценоразпис: textarea за paste + „или снимка" file input (`accept="image/*"`); submit „Създай производителя" (disabled while busy, shows „Създаване…").
- On submit → `onboardProducer(tenantId, values)`.
- **Result stage:** green check header „Производителят е създаден" · line „{productsCreated} продукта добавени" · when `inviteLink`: a `bg-ff-surface-2` box with the link in `<code>` + a Copy button (reuse the `CopyButton` component pattern from `tenants-client.tsx` — 2s „Копирано" state) and hint „Прати линка по Viber — важи 7 дни, еднократно." · „Затвори" button.
- Errors → `toast.error(errMsg(e))` with the same `errMsg` helper pattern as `tenants-client.tsx` (`e instanceof ApiError ? e.message : 'Възникна грешка'`).

- [ ] **Step 3: Mount on the tenant detail**

In `admin/src/components/tenant-detail-client.tsx`: grep `ProductImportDialog` — next to the button that opens it, add a sibling button:

```tsx
<button
  onClick={() => setOnboardOpen(true)}
  className="inline-flex h-10 items-center gap-2 rounded-xl bg-ff-green-700 px-3.5 text-[13px] font-bold text-white shadow-ff-sm hover:brightness-95"
>
  <UserPlus size={16} /> Onboard производител
</button>
```

with `const [onboardOpen, setOnboardOpen] = useState(false);`, `UserPlus` from lucide-react, and at the JSX bottom:

```tsx
{onboardOpen && <ProducerOnboardDialog tenantId={tenant.id} onClose={() => setOnboardOpen(false)} />}
```

(match the actual tenant-id prop name used in that file — grep how `ProductImportDialog` receives it and mirror).

- [ ] **Step 4: Typecheck**

```bash
cd admin && npx tsc --noEmit -p tsconfig.json && cd ..
```

Expected: silent.

- [ ] **Step 5: Commit**

```bash
git add admin/src
git commit -m "feat(admin): Onboard производител — one-shot create + AI-import + invite link

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Full verification + push

**Files:** none new.

- [ ] **Step 1: Typecheck all three packages**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ../client && npx tsc --noEmit -p tsconfig.json && cd ../admin && npx tsc --noEmit -p tsconfig.json && cd ..
```

Expected: all silent.

- [ ] **Step 2: Run the touched server suites**

```bash
pnpm --filter @fermeribg/api exec jest src/modules/ai-import src/modules/platform
```

Expected: ALL PASS (including pre-existing platform suites — the ProductExtractService move must not have broken them).

- [ ] **Step 3: Dev-compile the two frontends**

Start each dev server briefly (`pnpm --filter @fermeribg/web exec next dev -p 3000`, `pnpm --filter @fermeribg/admin exec next dev -p 3002`) or use the repo's preview tooling; hit `/login` on each; confirm zero compile errors in the output, then stop them.

- [ ] **Step 4: Push (production auto-deploys from main — this is the ONLY push in the plan)**

```bash
git push origin main
```

- [ ] **Step 5: Report**

Summarize: endpoints added, UI entry points („Добави от снимка" on /products in the farmer panel; „Onboard производител" on the brand's tenant page in the admin console), and what still needs a human eye (authenticated visual check after deploy; a real photo extract против жив OPENAI_API_KEY).
