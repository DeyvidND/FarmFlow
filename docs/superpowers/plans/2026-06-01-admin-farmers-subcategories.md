# Farmers + Subcategories + Product Linking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add toggle-gated **Farmers** and **Subcategories** to the FarmFlow admin panel, link products to each, and reflect both on the storefront — full-stack (DB → NestJS → admin → storefront).

**Architecture:** Two new tenant-scoped tables (`farmers`, `subcategories`) + nullable FKs on `products` + two boolean flags on `tenants` (default off). Two NestJS modules mirror the `products` module (CRUD + R2 image upload, Redis catalog invalidation). The admin client gets two new pages with the design's toggle-banner / card-grid / slide-out-panel pattern and farmer/subcategory selects in the product dialog. The storefront gains public `farmers`/`subcategories` endpoints (return `[]` when the toggle is off) and renders grouped sections + farmer attribution.

**Tech Stack:** Drizzle ORM + Postgres, NestJS (class-validator DTOs), Next.js 14 (App Router, RSC + client components), Tailwind, sonner, R2 storage.

**Note on verification:** the repo has **no unit-test runner** (no jest/vitest). Each task verifies via TypeScript build / `next build` / `nest build` + `pnpm lint` and (for UI) the preview workflow. Where this plan says "verify", run the listed build/lint command and confirm no errors.

---

## File Structure

**Create**
- `server/src/modules/farmers/{farmers.controller,farmers.service,farmers.module}.ts`
- `server/src/modules/farmers/dto/{create-farmer,update-farmer}.dto.ts`
- `server/src/modules/subcategories/{subcategories.controller,subcategories.service,subcategories.module}.ts`
- `server/src/modules/subcategories/dto/{create-subcategory,update-subcategory}.dto.ts`
- `client/src/app/(admin)/farmers/page.tsx`, `client/src/app/(admin)/subcategories/page.tsx`
- `client/src/components/farmers/{farmers-client,farmer-panel,avatar}.tsx`
- `client/src/components/subcategories/{subcategories-client,subcategory-panel,section-photo}.tsx`
- `client/src/components/products/product-dialog.tsx` (edit-capable; supersedes create-only dialog)
- `storefront/src/components/storefront-catalog.tsx` (grouped sections wrapper)

**Modify**
- `packages/db/src/schema.ts`, `packages/db/src/seed.ts`, `packages/types/src/index.ts`
- `server/src/app.module.ts`, `server/src/modules/products/dto/create-product.dto.ts`, `server/src/modules/tenants/dto/update-tenant.dto.ts`
- `client/src/lib/types.ts`, `client/src/lib/api-client.ts`, `client/src/components/layout/sidebar.tsx`
- `client/src/components/products/products-client.tsx`, `client/src/app/(admin)/products/page.tsx`
- `storefront/src/lib/api.ts`, `storefront/src/app/products/page.tsx`, `storefront/src/components/product-card.tsx`, `storefront/src/app/product/[slug]/page.tsx`

---

## Task 1: DB schema + types + migration + seed

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/types/src/index.ts`
- Modify: `packages/db/src/seed.ts`

- [ ] **Step 1: Add `farmers` + `subcategories` tables to `schema.ts`** (insert before the `export const schema = {` block)

```ts
export const farmers = pgTable('farmers', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  name: text('name').notNull(),
  role: text('role'),
  bio: text('bio'),
  phone: text('phone'),
  since: text('since'),
  tint: text('tint'),
  imageUrl: text('image_url'),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow(),
});

export const subcategories = pgTable('subcategories', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  name: text('name').notNull(),
  description: text('description'),
  tint: text('tint'),
  imageUrl: text('image_url'),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow(),
});
```

- [ ] **Step 2: Add the two FK columns to `products`** (inside the `products` table column block, after `imageUrl`)

```ts
    // Optional multi-producer + section grouping links (admin toggles). FK SET NULL
    // on delete so removing a farmer/subcategory just unlinks its products.
    farmerId: uuid('farmer_id').references(() => farmers.id, { onDelete: 'set null' }),
    subcategoryId: uuid('subcategory_id').references(() => subcategories.id, {
      onDelete: 'set null',
    }),
```

> `farmers`/`subcategories` are declared *after* `products` in the file, but Drizzle's
> `() => farmers.id` thunk is lazy, so forward reference is fine. Keep the new tables
> before the `schema` export.

- [ ] **Step 3: Add the two tenant flags to `tenants`** (after `deliveryEnabled`)

```ts
  // Optional catalog groupings — when on, the matching admin page + product link
  // field + storefront grouping/attribution activate. Default off.
  multiFarmer: boolean('multi_farmer').notNull().default(false),
  multiSubcat: boolean('multi_subcat').notNull().default(false),
```

- [ ] **Step 4: Register the new tables in the `schema` export object**

Add `farmers,` and `subcategories,` lines inside `export const schema = { ... }`.

- [ ] **Step 5: Add types in `packages/types/src/index.ts`**

Extend the import list from `@farmflow/db` with `farmers,` and `subcategories,`, then add:

```ts
export type Farmer = InferSelectModel<typeof farmers>;
export type NewFarmer = InferInsertModel<typeof farmers>;

export type Subcategory = InferSelectModel<typeof subcategories>;
export type NewSubcategory = InferInsertModel<typeof subcategories>;

/** Public storefront shapes — tenant_id stripped. */
export type PublicFarmer = Omit<Farmer, 'tenantId'>;
export type PublicSubcategory = Omit<Subcategory, 'tenantId'>;
```

`PublicProduct` automatically keeps `farmerId`/`subcategoryId` (the Omit doesn't strip
them) and `PublicTenant` keeps `multiFarmer`/`multiSubcat`. No change needed there.

- [ ] **Step 6: Generate the migration**

Run: `pnpm --filter @farmflow/db generate`
Expected: one new `packages/db/drizzle/00XX_*.sql` + snapshot, containing `CREATE TABLE "farmers"`, `CREATE TABLE "subcategories"`, `ALTER TABLE "products" ADD COLUMN "farmer_id"/"subcategory_id"`, `ALTER TABLE "tenants" ADD COLUMN "multi_farmer"/"multi_subcat"`.

- [ ] **Step 7: Seed demo farmers + subcategories + links in `seed.ts`**

After the tenant insert (and before the products insert, since products now reference
them), insert farmers and subcategories, capturing their ids:

```ts
  const farmerRows = await db.insert(farmers).values([
    { tenantId: tenant.id, name: 'Петър Петров', role: 'Ягодоплодни насаждения', since: '2014', phone: '+359 88 412 0001', tint: '#2C5530', position: 0,
      bio: 'Гледа ягоди, малини и череши на 4 декара край Варна. Бере рано сутрин и доставя в същия ден.' },
    { tenantId: tenant.id, name: 'Мария Петрова', role: 'Преработка — сладка и сиропи', since: '2016', phone: '+359 88 412 0002', tint: '#B23B5E', position: 1,
      bio: 'Прави домашни сладка, конфитюри и сиропи по семейни рецепти, без консерванти и оцветители.' },
    { tenantId: tenant.id, name: 'Стоян Петров', role: 'Пчелар — мед и пчелни продукти', since: '2018', phone: '+359 88 412 0003', tint: '#D08B26', position: 2,
      bio: 'Поддържа 40 кошера в Лонгоза. Липов, акациев и полифлорен мед, прополис и восък.' },
  ]).returning();

  const subcatRows = await db.insert(subcategories).values([
    { tenantId: tenant.id, name: 'Сезонни плодове', tint: '#4C8A54', position: 0, description: 'Прясно набрани плодове през текущия сезон.' },
    { tenantId: tenant.id, name: 'Зимнина и буркани', tint: '#B23B5E', position: 1, description: 'Домашни сладка, конфитюри и сиропи за зимата.' },
    { tenantId: tenant.id, name: 'Пчелни продукти', tint: '#D08B26', position: 2, description: 'Мед и продукти от собствен пчелин.' },
  ]).returning();
```

Then add `farmerId` / `subcategoryId` to the existing product rows using the captured
ids. Map per `data.js`: products 1–5,9 → `farmerRows[0]` & `subcatRows[0]`; products
6–7 → `farmerRows[1]` & `subcatRows[1]`; product 8 → `farmerRows[2]` & `subcatRows[2]`.
Example for the first product row:

```ts
    { tenantId: tenant.id, name: 'Ягоди', slug: 'yagodi', priceStotinki: 650, unit: 'бр', weight: '500 г', category: 'Плодове', tint: '#D94A4A', stockQuantity: 24, isActive: true, farmerId: farmerRows[0].id, subcategoryId: subcatRows[0].id },
```

Update the imports at the top of `seed.ts` to include `farmers, subcategories`, and add
`farmers, subcategories` to the `TRUNCATE` list (before `products`, since products FK
them — actually CASCADE handles order, but list them: `... subcategories, farmers, products ...`). Leave both tenant toggles unset (default false).

- [ ] **Step 8: Verify**

Run: `pnpm --filter @farmflow/db build` → Expected: no TS errors.
Run (if a dev DB is available): `pnpm db:migrate && pnpm db:seed` → Expected: "Seed complete". If no DB is reachable, skip the migrate/seed run and note it.

- [ ] **Step 9: Commit**

```bash
git add packages/db packages/types
git commit -m "feat(db): farmers + subcategories tables, product links, tenant toggles"
```

---

## Task 2: Server — farmers module

**Files:**
- Create: `server/src/modules/farmers/dto/create-farmer.dto.ts`
- Create: `server/src/modules/farmers/dto/update-farmer.dto.ts`
- Create: `server/src/modules/farmers/farmers.service.ts`
- Create: `server/src/modules/farmers/farmers.controller.ts`
- Create: `server/src/modules/farmers/farmers.module.ts`

- [ ] **Step 1: `create-farmer.dto.ts`**

```ts
import { IsString, IsOptional, IsInt, IsUrl, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateFarmerDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: 'Пчелар — мед' })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bio?: string;

  @ApiPropertyOptional({ example: '+359 88 412 0001' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: '2014' })
  @IsOptional()
  @IsString()
  since?: string;

  @ApiPropertyOptional({ example: '#2C5530' })
  @IsOptional()
  @IsString()
  tint?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  imageUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}
```

- [ ] **Step 2: `update-farmer.dto.ts`**

```ts
import { PartialType } from '@nestjs/swagger';
import { CreateFarmerDto } from './create-farmer.dto';

export class UpdateFarmerDto extends PartialType(CreateFarmerDto) {}
```

- [ ] **Step 3: `farmers.service.ts`** (CRUD + R2 image, mirrors ProductsService; hard delete)

```ts
import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, eq, asc } from 'drizzle-orm';
import { type Database, farmers } from '@farmflow/db';
import type { Farmer } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CreateFarmerDto } from './dto/create-farmer.dto';
import { UpdateFarmerDto } from './dto/update-farmer.dto';
import { StorageService } from '../storage/storage.service';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { PRODUCT_IMAGE_EXT_BY_MIME } from '../storage/dto/upload-image.dto';

@Injectable()
export class FarmersService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly cache: CatalogCacheService,
  ) {}

  findAll(tenantId: string): Promise<Farmer[]> {
    return this.db
      .select()
      .from(farmers)
      .where(eq(farmers.tenantId, tenantId))
      .orderBy(asc(farmers.position), asc(farmers.createdAt));
  }

  async findOne(id: string, tenantId: string): Promise<Farmer> {
    const [row] = await this.db
      .select()
      .from(farmers)
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new NotFoundException('Фермерът не е намерен');
    return row;
  }

  async create(tenantId: string, dto: CreateFarmerDto): Promise<Farmer> {
    const [row] = await this.db.insert(farmers).values({ ...dto, tenantId }).returning();
    await this.cache.invalidate(tenantId);
    return row;
  }

  async update(id: string, tenantId: string, dto: UpdateFarmerDto): Promise<Farmer> {
    const [row] = await this.db
      .update(farmers)
      .set({ ...dto })
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Фермерът не е намерен');
    await this.cache.invalidate(tenantId);
    return row;
  }

  /** Hard delete; products.farmer_id FK is ON DELETE SET NULL, so products unlink. */
  async remove(id: string, tenantId: string): Promise<{ id: string }> {
    const farmer = await this.findOne(id, tenantId);
    if (farmer.imageUrl) await this.deleteObject(farmer.imageUrl);
    await this.db
      .delete(farmers)
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)));
    await this.cache.invalidate(tenantId);
    return { id };
  }

  async uploadImage(id: string, tenantId: string, file: Express.Multer.File): Promise<Farmer> {
    const farmer = await this.findOne(id, tenantId);
    const ext = PRODUCT_IMAGE_EXT_BY_MIME[file.mimetype] ?? 'bin';
    const key = `tenants/${tenantId}/farmers/${randomUUID()}.${ext}`;
    const { url } = await this.storage.upload(file.buffer, key, file.mimetype);
    if (farmer.imageUrl) await this.deleteObject(farmer.imageUrl);
    const [row] = await this.db
      .update(farmers)
      .set({ imageUrl: url })
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
      .returning();
    await this.cache.invalidate(tenantId);
    return row;
  }

  private async deleteObject(url: string): Promise<void> {
    try {
      const key = new URL(url).pathname.replace(/^\/+/, '');
      if (key) await this.storage.delete(key);
    } catch {
      /* storage hiccup must not block the DB write */
    }
  }
}
```

- [ ] **Step 4: `farmers.controller.ts`** (mirrors ProductsController admin half)

```ts
import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, UseGuards, UploadedFile, UseInterceptors,
  ParseFilePipe, FileTypeValidator, MaxFileSizeValidator,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { FarmersService } from './farmers.service';
import { CreateFarmerDto } from './dto/create-farmer.dto';
import { UpdateFarmerDto } from './dto/update-farmer.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import {
  UploadImageDto, PRODUCT_IMAGE_MIME_REGEX, PRODUCT_IMAGE_MAX_BYTES,
} from '../storage/dto/upload-image.dto';

@ApiTags('farmers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('farmers')
export class FarmersController {
  constructor(private readonly farmersService: FarmersService) {}

  @Get()
  findAll(@CurrentTenant() tenantId: string) {
    return this.farmersService.findAll(tenantId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.farmersService.findOne(id, tenantId);
  }

  @Post()
  create(@CurrentTenant() tenantId: string, @Body() dto: CreateFarmerDto) {
    return this.farmersService.create(tenantId, dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @CurrentTenant() tenantId: string, @Body() dto: UpdateFarmerDto) {
    return this.farmersService.update(id, tenantId, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.farmersService.remove(id, tenantId);
  }

  @Post(':id/image')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadImageDto })
  @UseInterceptors(FileInterceptor('image'))
  uploadImage(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new FileTypeValidator({ fileType: PRODUCT_IMAGE_MIME_REGEX }),
          new MaxFileSizeValidator({ maxSize: PRODUCT_IMAGE_MAX_BYTES }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.farmersService.uploadImage(id, tenantId, file);
  }
}
```

- [ ] **Step 5: `farmers.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { FarmersService } from './farmers.service';
import { FarmersController } from './farmers.controller';
import { CatalogCacheModule } from '../catalog-cache/catalog-cache.module';

@Module({
  imports: [CatalogCacheModule],
  controllers: [FarmersController],
  providers: [FarmersService],
})
export class FarmersModule {}
```

- [ ] **Step 6: Verify** — `pnpm --filter @farmflow/server build`. Expected: compiles (module not yet registered; that's Task 4).

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/farmers
git commit -m "feat(server): farmers CRUD module"
```

---

## Task 3: Server — subcategories module

**Files:** mirror Task 2 under `server/src/modules/subcategories/` with these substitutions:
- Table: `subcategories`; type: `Subcategory`; controller path `@Controller('subcategories')`; `@ApiTags('subcategories')`.
- DTO `CreateSubcategoryDto` fields: `name` (required `@IsString`), `description?`, `tint?`, `imageUrl?` (`@IsUrl`), `position?` (`@IsInt @Min(0)`). **No** role/bio/phone/since.
- Service messages: `'Категорията не е намерена'`. R2 key: `tenants/${tenantId}/subcategories/${randomUUID()}.${ext}`.
- `UpdateSubcategoryDto extends PartialType(CreateSubcategoryDto)`.

- [ ] **Step 1: `dto/create-subcategory.dto.ts`**

```ts
import { IsString, IsOptional, IsInt, IsUrl, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSubcategoryDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: '#4C8A54' })
  @IsOptional()
  @IsString()
  tint?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  imageUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}
```

- [ ] **Step 2: `dto/update-subcategory.dto.ts`** — `PartialType(CreateSubcategoryDto)`.

- [ ] **Step 3: `subcategories.service.ts`** — copy `farmers.service.ts`, replace `farmers`→`subcategories`, `Farmer`→`Subcategory`, `Фермерът не е намерен`→`Категорията не е намерена`, R2 key `.../subcategories/...`.

- [ ] **Step 4: `subcategories.controller.ts`** — copy `farmers.controller.ts`, replace `Farmers`→`Subcategories`, `farmers`→`subcategories`, DTO names accordingly.

- [ ] **Step 5: `subcategories.module.ts`** — copy, rename to `SubcategoriesModule`/`SubcategoriesController`/`SubcategoriesService`.

- [ ] **Step 6: Verify** — `pnpm --filter @farmflow/server build`.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/subcategories
git commit -m "feat(server): subcategories CRUD module"
```

---

## Task 4: Server — product/tenant DTOs, public endpoints, module wiring

**Files:**
- Modify: `server/src/modules/products/dto/create-product.dto.ts`
- Modify: `server/src/modules/tenants/dto/update-tenant.dto.ts`
- Modify: `server/src/modules/farmers/farmers.{service,controller,module}.ts`
- Modify: `server/src/modules/subcategories/subcategories.{service,controller,module}.ts`
- Modify: `server/src/app.module.ts`

- [ ] **Step 1: Product DTO — add link fields** (append to `CreateProductDto`)

```ts
  @ApiPropertyOptional({ description: 'Linked farmer (multi-producer mode)' })
  @IsOptional()
  @IsUUID()
  farmerId?: string | null;

  @ApiPropertyOptional({ description: 'Linked subcategory section' })
  @IsOptional()
  @IsUUID()
  subcategoryId?: string | null;
```

Add `IsUUID` to the `class-validator` import line. (`UpdateProductDto` inherits via
`PartialType`.) To allow *unlinking* (set to null), the validator must permit null:
change both to `@IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID()` and import
`ValidateIf`.

- [ ] **Step 2: Tenant DTO — add toggles** (append to `UpdateTenantDto`)

```ts
  @ApiPropertyOptional({ example: false, description: 'Multiple producers share this storefront' })
  @IsOptional()
  @IsBoolean()
  multiFarmer?: boolean;

  @ApiPropertyOptional({ example: false, description: 'Group products into subcategory sections' })
  @IsOptional()
  @IsBoolean()
  multiSubcat?: boolean;
```

- [ ] **Step 3: Public farmers endpoint** — add a service method + a public controller.

In `farmers.service.ts` add (and import `tenants` from `@farmflow/db`, `NotFoundException` already imported, `PublicFarmer` from types):

```ts
  /** Public farmers for a storefront slug — [] unless the tenant has multiFarmer on. */
  async findPublicBySlug(slug: string): Promise<PublicFarmer[]> {
    const [tenant] = await this.db
      .select({ id: tenants.id, multiFarmer: tenants.multiFarmer })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    if (!tenant) throw new NotFoundException('Фермата не е намерена');
    if (!tenant.multiFarmer) return [];
    const rows = await this.db
      .select()
      .from(farmers)
      .where(eq(farmers.tenantId, tenant.id))
      .orderBy(asc(farmers.position), asc(farmers.createdAt));
    return rows.map(({ tenantId, ...rest }) => rest);
  }
```

In `farmers.controller.ts` add a second exported controller:

```ts
@ApiTags('public')
@Controller('public/:slug/farmers')
export class PublicFarmersController {
  constructor(private readonly farmersService: FarmersService) {}

  @Get()
  findPublic(@Param('slug') slug: string) {
    return this.farmersService.findPublicBySlug(slug);
  }
}
```

Register it in `farmers.module.ts`: `controllers: [FarmersController, PublicFarmersController]`.

- [ ] **Step 4: Public subcategories endpoint** — same pattern in subcategories module:
service `findPublicBySlug` guarding on `tenant.multiSubcat`, `PublicSubcategory[]`;
`PublicSubcategoriesController` at `@Controller('public/:slug/subcategories')`;
register in the module.

- [ ] **Step 5: Register modules in `app.module.ts`** — import `FarmersModule` and
`SubcategoriesModule` and add them to the `imports` array (after `ProductsModule`).

- [ ] **Step 6: Verify** — `pnpm --filter @farmflow/server build` then `pnpm --filter @farmflow/server lint`. Expected: no errors. If a DB + server is runnable, smoke-test:
`GET /public/ferma-petrovi/farmers` → `[]` (toggle off), and authed `GET /farmers` → 3 rows.

- [ ] **Step 7: Commit**

```bash
git add server/src
git commit -m "feat(server): product link fields, tenant toggles, public farmer/subcategory endpoints"
```

---

## Task 5: Admin client — types + api-client

**Files:**
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/lib/api-client.ts`

- [ ] **Step 1: Extend `Product` + add new interfaces in `types.ts`**

Add to the `Product` interface:

```ts
  farmerId: string | null;
  subcategoryId: string | null;
```

Add new types:

```ts
export interface Farmer {
  id: string;
  name: string;
  role: string | null;
  bio: string | null;
  phone: string | null;
  since: string | null;
  tint: string | null;
  imageUrl: string | null;
  position: number;
  createdAt: string;
}

export interface Subcategory {
  id: string;
  name: string;
  description: string | null;
  tint: string | null;
  imageUrl: string | null;
  position: number;
  createdAt: string;
}

/** Subset of the tenant profile the panel reads (GET /tenants/me). */
export interface TenantProfile {
  id: string;
  name: string;
  multiFarmer: boolean;
  multiSubcat: boolean;
  deliveryEnabled: boolean;
}
```

- [ ] **Step 2: Add api-client functions** (`client/src/lib/api-client.ts`)

Import the new types, then append:

```ts
// ---- Farmers ----
export const listFarmers = () => apiFetch<Farmer[]>('farmers');
export const createFarmer = (data: Partial<Farmer>) =>
  apiFetch<Farmer>('farmers', { method: 'POST', ...json(data) }, 'Неуспешно създаване');
export const updateFarmer = (id: string, data: Partial<Farmer>) =>
  apiFetch<Farmer>(`farmers/${id}`, { method: 'PATCH', ...json(data) }, 'Неуспешно записване');
export const deleteFarmer = (id: string) =>
  apiFetch<{ id: string }>(`farmers/${id}`, { method: 'DELETE' }, 'Неуспешно изтриване');
export function uploadFarmerImage(id: string, file: File) {
  const fd = new FormData();
  fd.append('image', file);
  return apiFetch<Farmer>(`farmers/${id}/image`, { method: 'POST', body: fd }, 'Неуспешно качване');
}

// ---- Subcategories ----
export const listSubcategories = () => apiFetch<Subcategory[]>('subcategories');
export const createSubcategory = (data: Partial<Subcategory>) =>
  apiFetch<Subcategory>('subcategories', { method: 'POST', ...json(data) }, 'Неуспешно създаване');
export const updateSubcategory = (id: string, data: Partial<Subcategory>) =>
  apiFetch<Subcategory>(`subcategories/${id}`, { method: 'PATCH', ...json(data) }, 'Неуспешно записване');
export const deleteSubcategory = (id: string) =>
  apiFetch<{ id: string }>(`subcategories/${id}`, { method: 'DELETE' }, 'Неуспешно изтриване');
export function uploadSubcategoryImage(id: string, file: File) {
  const fd = new FormData();
  fd.append('image', file);
  return apiFetch<Subcategory>(`subcategories/${id}/image`, { method: 'POST', body: fd }, 'Неуспешно качване');
}

// ---- Tenant toggles ----
export const updateTenant = (data: { multiFarmer?: boolean; multiSubcat?: boolean }) =>
  apiFetch<TenantProfile>('tenants/me', { method: 'PATCH', ...json(data) }, 'Неуспешна промяна');
```

(Add `Farmer, Subcategory, TenantProfile` to the type import at the top.)

- [ ] **Step 3: Verify** — `pnpm --filter @farmflow/web lint` (typecheck). Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib
git commit -m "feat(web): farmer/subcategory api-client + types"
```

---

## Task 6: Admin client — sidebar nav

**Files:**
- Modify: `client/src/components/layout/sidebar.tsx`

- [ ] **Step 1: Add nav items** — import `Users` and `Tags` from `lucide-react`; insert
into `NAV` after the Продукти entry:

```ts
  { href: '/farmers', label: 'Фермери', Icon: Users },
  { href: '/subcategories', label: 'Подкатегории', Icon: Tags },
```

- [ ] **Step 2: Verify** — `pnpm --filter @farmflow/web lint`.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/layout/sidebar.tsx
git commit -m "feat(web): farmers + subcategories nav items"
```

---

## Task 7: Admin client — Farmers page

**Files:**
- Create: `client/src/components/farmers/avatar.tsx`
- Create: `client/src/components/farmers/farmer-panel.tsx`
- Create: `client/src/components/farmers/farmers-client.tsx`
- Create: `client/src/app/(admin)/farmers/page.tsx`

- [ ] **Step 1: `avatar.tsx`** (initials disc or image; port of design `Avatar`/`initialsOf`/`hexA`)

```tsx
'use client';

export function hexA(hex: string | null, a: number): string {
  const h = (hex ?? '#4C8A54').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

export function Avatar({
  name, tint, imageUrl, size = 44, ring = false,
}: { name: string; tint: string | null; imageUrl?: string | null; size?: number; ring?: boolean }) {
  const t = tint ?? '#2C5530';
  if (imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={imageUrl} alt={name} width={size} height={size}
      className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  return (
    <span className="grid shrink-0 place-items-center rounded-full font-display font-extrabold"
      style={{ width: size, height: size, background: hexA(t, 0.16), color: t,
        fontSize: size * 0.36, boxShadow: ring ? `inset 0 0 0 1.5px ${hexA(t, 0.4)}` : 'none' }}>
      {initialsOf(name)}
    </span>
  );
}
```

- [ ] **Step 2: `farmer-panel.tsx`** (slide-out create/edit; port of design `FarmerPanel`)

```tsx
'use client';

import { useState } from 'react';
import { X, Check, Image as ImageIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Avatar } from './avatar';
import { ApiError, createFarmer, updateFarmer, uploadFarmerImage } from '@/lib/api-client';
import type { Farmer } from '@/lib/types';

const TINTS = ['#2C5530', '#B23B5E', '#D08B26', '#5B5BA8', '#A11E2E', '#3B7D52'];
const field = 'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] font-semibold text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500 w-full';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

export function FarmerPanel({
  farmer, onClose, onSaved,
}: { farmer: Partial<Farmer>; onClose: () => void; onSaved: (f: Farmer) => void }) {
  const isNew = !farmer.id;
  const [name, setName] = useState(farmer.name ?? '');
  const [role, setRole] = useState(farmer.role ?? '');
  const [bio, setBio] = useState(farmer.bio ?? '');
  const [phone, setPhone] = useState(farmer.phone ?? '+359 ');
  const [since, setSince] = useState(farmer.since ?? '2026');
  const [tint, setTint] = useState(farmer.tint ?? TINTS[0]);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) { toast.error('Въведи име на фермера'); return; }
    setSaving(true);
    try {
      const data = { name: name.trim(), role: role.trim(), bio: bio.trim(), phone: phone.trim(), since: since.trim(), tint };
      let saved: Farmer;
      if (isNew) { saved = await createFarmer(data); toast.success('Фермерът е добавен'); }
      else { saved = await updateFarmer(farmer.id!, data); toast.success('Фермерът е обновен'); }
      onSaved(saved);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    } finally { setSaving(false); }
  }

  async function onPickImage(file: File) {
    if (isNew) { toast.error('Първо запази фермера, после качи снимка'); return; }
    try {
      const updated = await uploadFarmerImage(farmer.id!, file);
      onSaved(updated);
      toast.success('Снимката е качена');
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Грешка'); }
  }

  return (
    <>
      <div onClick={onClose} className="animate-ff-fade fixed inset-0 z-40 bg-[rgba(30,28,15,0.32)]" />
      <div className="ff-order-panel fixed right-0 top-0 z-50 flex h-full w-[440px] max-w-full flex-col bg-ff-surface shadow-ff-lg">
        <div className="flex items-center justify-between border-b border-ff-border-2 px-6 pb-[18px] pt-[22px]">
          <div>
            <div className="mb-0.5 text-[12.5px] font-bold text-ff-muted">{isNew ? 'НОВ ФЕРМЕР' : 'РЕДАКЦИЯ'}</div>
            <h2 className="text-[22px] font-extrabold tracking-[-0.015em]">{isNew ? 'Добави фермер' : farmer.name}</h2>
          </div>
          <button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-[11px] border border-ff-border bg-ff-surface-2 text-ff-ink-2"><X size={20} /></button>
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
          <div className="flex items-center gap-3.5 rounded-xl border border-ff-border-2 bg-ff-surface-2 p-3.5">
            <Avatar name={name || '?'} tint={tint} imageUrl={farmer.imageUrl} size={48} ring />
            <div className="min-w-0">
              <div className="text-[15.5px] font-extrabold">{name || 'Име на фермера'}</div>
              <div className="text-[12.5px] font-bold" style={{ color: tint }}>{role || 'Специалност'}</div>
            </div>
          </div>

          {!isNew && (
            <label className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-1.5 text-[13px] font-bold text-ff-ink-2">
              <ImageIcon size={15} /> Качи снимка
              <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && onPickImage(e.target.files[0])} />
            </label>
          )}

          <label className={labelCls}>Име<input value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. Петър Петров" className={field} /></label>
          <label className={labelCls}>Специалност / роля<input value={role} onChange={(e) => setRole(e.target.value)} placeholder="напр. Пчелар — мед" className={field} /></label>
          <label className={labelCls}>Кратко описание<textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} placeholder="Какво произвежда този фермер…" className={`${field} resize-y leading-relaxed`} /></label>
          <div className="grid grid-cols-[1fr_110px] gap-3">
            <label className={labelCls}>Телефон<input value={phone} onChange={(e) => setPhone(e.target.value)} className={field} /></label>
            <label className={labelCls}>От година<input value={since} onChange={(e) => setSince(e.target.value)} className={field} /></label>
          </div>
          <div className={labelCls}>Цвят на профила
            <div className="flex flex-wrap gap-2.5">
              {TINTS.map((t) => (
                <button key={t} type="button" onClick={() => setTint(t)} className="grid h-[34px] w-[34px] place-items-center rounded-full"
                  style={{ background: t, boxShadow: tint === t ? `0 0 0 3px var(--ff-surface), 0 0 0 5px ${t}` : 'inset 0 0 0 1px rgba(0,0,0,0.1)' }}>
                  {tint === t && <Check size={16} strokeWidth={3} color="#fff" />}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex gap-2.5 border-t border-ff-border-2 px-6 pb-[22px] pt-4">
          <Button variant="primary" onClick={save} disabled={saving} className="flex-1 rounded-sm"><Check size={18} /> {isNew ? 'Добави фермер' : 'Запази промените'}</Button>
          <Button variant="ghost" onClick={onClose} className="rounded-sm">Отказ</Button>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 3: `farmers-client.tsx`** (toggle banner + grid + linked-product chips)

```tsx
'use client';

import { useState } from 'react';
import { Plus, Pencil, Link2, ChevronRight, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ApiError, updateTenant } from '@/lib/api-client';
import type { Farmer, Product } from '@/lib/types';
import { Avatar } from './avatar';
import { FarmerPanel } from './farmer-panel';

export function FarmersClient({
  initialFarmers, products, initialMultiFarmer,
}: { initialFarmers: Farmer[]; products: Product[]; initialMultiFarmer: boolean }) {
  const [farmers, setFarmers] = useState(initialFarmers);
  const [multi, setMulti] = useState(initialMultiFarmer);
  const [edit, setEdit] = useState<Partial<Farmer> | null>(null);

  const productsOf = (fid: string) => products.filter((p) => p.farmerId === fid);

  async function onToggle(v: boolean) {
    setMulti(v); // optimistic
    try {
      await updateTenant({ multiFarmer: v });
      toast.success(v ? 'Режим с няколко фермери — включен' : 'Единичен производител');
    } catch (e) { setMulti(!v); toast.error(e instanceof ApiError ? e.message : 'Грешка'); }
  }

  function onSaved(f: Farmer) {
    setFarmers((prev) => (prev.some((x) => x.id === f.id) ? prev.map((x) => (x.id === f.id ? f : x)) : [...prev, f]));
  }

  return (
    <div className="animate-ff-fade-up">
      {/* toggle banner */}
      <div className="mb-[18px] flex flex-wrap items-center gap-4 rounded-[14px] border p-5 shadow-ff-sm"
        style={{ background: multi ? 'var(--ff-green-50)' : 'var(--ff-surface)', borderColor: multi ? 'var(--ff-green-100)' : 'var(--ff-border)' }}>
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl" style={{ background: multi ? 'var(--ff-green-100)' : 'var(--ff-surface-2)', color: multi ? 'var(--ff-green-700)' : 'var(--ff-muted)' }}><Users size={23} /></span>
        <div className="min-w-[220px] flex-1">
          <div className="text-[15.5px] font-extrabold">Няколко фермери в това стопанство</div>
          <div className="mt-0.5 max-w-[580px] text-[13px] leading-snug text-ff-ink-2">Включи това само ако зад един уебсайт стоят повече от един производител — тогава всеки продукт се свързва с конкретен фермер.</div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="text-[13px] font-bold" style={{ color: multi ? 'var(--ff-green-700)' : 'var(--ff-muted)' }}>{multi ? 'Включено' : 'Изключено'}</span>
          <ToggleSwitch checked={multi} onChange={onToggle} />
        </div>
      </div>

      {!multi ? (
        <div className="mx-auto max-w-[560px] rounded-[var(--ff-radius)] border border-ff-border bg-ff-surface px-6 py-14 text-center shadow-ff-sm">
          <div className="mx-auto mb-4 grid h-[60px] w-[60px] place-items-center rounded-2xl bg-ff-surface-2 text-ff-muted-2"><Users size={30} /></div>
          <h2 className="mb-2 text-[19px] font-extrabold">Един производител</h2>
          <p className="mx-auto max-w-[430px] text-sm leading-relaxed text-ff-ink-2">В момента всички продукти са на едно стопанство. Ако започнете да продавате продукти от няколко фермери под един магазин, включете опцията горе.</p>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ff-muted">{farmers.length} фермери · продуктите им се показват в общия магазин</p>
            <Button variant="primary" onClick={() => setEdit({})} className="rounded-sm"><Plus size={18} /> Добави фермер</Button>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-4">
            {farmers.map((f) => {
              const prods = productsOf(f.id);
              return (
                <div key={f.id} className="flex flex-col overflow-hidden rounded-[var(--ff-radius)] border border-ff-border bg-ff-surface shadow-ff-sm">
                  <div className="flex items-start gap-3.5 border-b border-ff-border-2 px-[18px] pb-3.5 pt-[18px]">
                    <Avatar name={f.name} tint={f.tint} imageUrl={f.imageUrl} size={52} ring />
                    <div className="min-w-0 flex-1">
                      <div className="text-[17px] font-extrabold tracking-[-0.01em]">{f.name}</div>
                      <div className="mt-px text-[13px] font-bold" style={{ color: f.tint ?? 'var(--ff-green-700)' }}>{f.role}</div>
                      <div className="mt-[3px] text-xs text-ff-muted">{f.since && `от ${f.since} г. · `}{f.phone}</div>
                    </div>
                    <button onClick={() => setEdit(f)} className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] border border-ff-border bg-ff-surface-2 text-ff-ink-2"><Pencil size={16} /></button>
                  </div>
                  {f.bio && <div className="flex-1 px-[18px] py-3.5 text-[13.5px] leading-normal text-ff-ink-2">{f.bio}</div>}
                  <div className="border-t border-ff-border-2 bg-ff-surface-2 px-[18px] pb-4 pt-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-ff-muted"><Link2 size={14} /> Свързани продукти</span>
                      <span className="text-[12.5px] font-extrabold text-ff-green-700">{prods.length}</span>
                    </div>
                    {prods.length ? (
                      <div className="flex flex-wrap gap-[7px]">
                        {prods.map((p) => (
                          <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full border border-ff-border bg-ff-surface py-[5px] pl-2 pr-2.5 text-[12.5px] font-bold text-ff-ink-2">
                            <span className="h-2 w-2 rounded-full" style={{ background: p.tint ?? '#4C8A54' }} />{p.name}
                          </span>
                        ))}
                      </div>
                    ) : <div className="text-[12.5px] text-ff-muted">Още няма продукти. Свържи от „Продукти“.</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {edit && <FarmerPanel farmer={edit} onClose={() => setEdit(null)} onSaved={onSaved} />}
    </div>
  );
}
```

- [ ] **Step 4: `page.tsx`** (SSR fetch farmers + products + tenant flag)

```tsx
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { FarmersClient } from '@/components/farmers/farmers-client';
import type { Farmer, Product } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return fallback;
  const res = await fetch(`${API_BASE}/${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) return fallback;
  return res.json();
}

export default async function FarmersPage() {
  const [farmers, products, tenant] = await Promise.all([
    fetchJson<Farmer[]>('farmers', []),
    fetchJson<Product[]>('products', []),
    fetchJson<{ multiFarmer: boolean }>('tenants/me', { multiFarmer: false }),
  ]);
  return <FarmersClient initialFarmers={farmers} products={products} initialMultiFarmer={tenant.multiFarmer} />;
}
```

- [ ] **Step 5: Verify** — `pnpm --filter @farmflow/web lint`; then preview: open `/farmers`, toggle on, add a farmer, confirm card + chips render, toggle persists on reload.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/farmers client/src/app/\(admin\)/farmers
git commit -m "feat(web): farmers admin page (toggle, cards, slide-out panel)"
```

---

## Task 8: Admin client — Subcategories page

**Files:**
- Create: `client/src/components/subcategories/section-photo.tsx`
- Create: `client/src/components/subcategories/subcategory-panel.tsx`
- Create: `client/src/components/subcategories/subcategories-client.tsx`
- Create: `client/src/app/(admin)/subcategories/page.tsx`

- [ ] **Step 1: `section-photo.tsx`** (image or tinted gradient banner; port of design `SectionPhoto`)

```tsx
'use client';

import { Image as ImageIcon } from 'lucide-react';
import { hexA } from '@/components/farmers/avatar';

export function SectionPhoto({
  tint, imageUrl, height = 120, radius = 12, label = true,
}: { tint: string | null; imageUrl?: string | null; height?: number; radius?: number; label?: boolean }) {
  const t = tint ?? '#4C8A54';
  if (imageUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={imageUrl} alt="" className="w-full object-cover" style={{ height, borderRadius: radius }} />;
  }
  return (
    <div className="relative w-full overflow-hidden border border-ff-border-2" style={{ height, borderRadius: radius, background: `linear-gradient(135deg, ${hexA(t, 0.18)}, var(--ff-surface-2))` }}>
      <svg viewBox="0 0 120 60" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full opacity-50">
        <path d="M0 46 Q 20 34 40 42 T 80 40 T 120 46 V60 H0Z" fill={hexA(t, 0.22)} />
        <path d="M0 52 Q 30 44 60 50 T 120 50 V60 H0Z" fill={hexA(t, 0.16)} />
        <circle cx="92" cy="18" r="9" fill={hexA(t, 0.2)} />
      </svg>
      {label && <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-white/80 px-[7px] py-0.5 text-[10.5px] font-semibold text-ff-muted"><ImageIcon size={12} /> снимка на секцията</span>}
    </div>
  );
}
```

- [ ] **Step 2: `subcategory-panel.tsx`** — mirror `farmer-panel.tsx` with these changes:
fields are **name, description, tint** only (no role/bio/phone/since); preview replaced
by a `<SectionPhoto tint={tint} imageUrl={subcat.imageUrl} height={130} />` block above
the upload button; tints `['#4C8A54', '#B23B5E', '#D08B26', '#5B5BA8', '#A11E2E', '#3B3B57']`;
calls `createSubcategory`/`updateSubcategory`/`uploadSubcategoryImage`; toasts
"Подкатегорията е добавена/обновена". Header labels "НОВА ПОДКАТЕГОРИЯ"/"Добави подкатегория".

```tsx
'use client';

import { useState } from 'react';
import { X, Check, Image as ImageIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SectionPhoto } from './section-photo';
import { ApiError, createSubcategory, updateSubcategory, uploadSubcategoryImage } from '@/lib/api-client';
import type { Subcategory } from '@/lib/types';

const TINTS = ['#4C8A54', '#B23B5E', '#D08B26', '#5B5BA8', '#A11E2E', '#3B3B57'];
const field = 'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] font-semibold text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500 w-full';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

export function SubcategoryPanel({
  subcat, onClose, onSaved,
}: { subcat: Partial<Subcategory>; onClose: () => void; onSaved: (s: Subcategory) => void }) {
  const isNew = !subcat.id;
  const [name, setName] = useState(subcat.name ?? '');
  const [description, setDescription] = useState(subcat.description ?? '');
  const [tint, setTint] = useState(subcat.tint ?? TINTS[0]);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) { toast.error('Въведи име на подкатегорията'); return; }
    setSaving(true);
    try {
      const data = { name: name.trim(), description: description.trim(), tint };
      const saved = isNew ? await createSubcategory(data) : await updateSubcategory(subcat.id!, data);
      toast.success(isNew ? 'Подкатегорията е добавена' : 'Подкатегорията е обновена');
      onSaved(saved); onClose();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : 'Грешка'); }
    finally { setSaving(false); }
  }

  async function onPickImage(file: File) {
    if (isNew) { toast.error('Първо запази секцията, после качи снимка'); return; }
    try { onSaved(await uploadSubcategoryImage(subcat.id!, file)); toast.success('Снимката е качена'); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : 'Грешка'); }
  }

  return (
    <>
      <div onClick={onClose} className="animate-ff-fade fixed inset-0 z-40 bg-[rgba(30,28,15,0.32)]" />
      <div className="ff-order-panel fixed right-0 top-0 z-50 flex h-full w-[440px] max-w-full flex-col bg-ff-surface shadow-ff-lg">
        <div className="flex items-center justify-between border-b border-ff-border-2 px-6 pb-[18px] pt-[22px]">
          <div>
            <div className="mb-0.5 text-[12.5px] font-bold text-ff-muted">{isNew ? 'НОВА ПОДКАТЕГОРИЯ' : 'РЕДАКЦИЯ'}</div>
            <h2 className="text-[22px] font-extrabold tracking-[-0.015em]">{isNew ? 'Добави подкатегория' : subcat.name}</h2>
          </div>
          <button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-[11px] border border-ff-border bg-ff-surface-2 text-ff-ink-2"><X size={20} /></button>
        </div>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
          <div>
            <div className="mb-1.5 text-[12.5px] font-bold text-ff-ink-2">Снимка на секцията</div>
            <SectionPhoto tint={tint} imageUrl={subcat.imageUrl} height={130} />
            {!isNew && (
              <label className="mt-2 inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-1.5 text-[13px] font-bold text-ff-ink-2">
                <ImageIcon size={15} /> Качи снимка
                <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && onPickImage(e.target.files[0])} />
              </label>
            )}
          </div>
          <label className={labelCls}>Заглавие на секцията<input value={name} onChange={(e) => setName(e.target.value)} placeholder="напр. Сезонни плодове" className={field} /></label>
          <label className={labelCls}>Кратко описание <span className="font-semibold text-ff-muted">(опционално)</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Какво обединява тази секция…" className={`${field} resize-y leading-relaxed`} /></label>
          <div className={labelCls}>Цвят на секцията
            <div className="flex flex-wrap gap-2.5">
              {TINTS.map((t) => (
                <button key={t} type="button" onClick={() => setTint(t)} className="grid h-[34px] w-[34px] place-items-center rounded-full"
                  style={{ background: t, boxShadow: tint === t ? `0 0 0 3px var(--ff-surface), 0 0 0 5px ${t}` : 'inset 0 0 0 1px rgba(0,0,0,0.1)' }}>
                  {tint === t && <Check size={16} strokeWidth={3} color="#fff" />}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex gap-2.5 border-t border-ff-border-2 px-6 pb-[22px] pt-4">
          <Button variant="primary" onClick={save} disabled={saving} className="flex-1 rounded-sm"><Check size={18} /> {isNew ? 'Добави подкатегория' : 'Запази промените'}</Button>
          <Button variant="ghost" onClick={onClose} className="rounded-sm">Отказ</Button>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 3: `subcategories-client.tsx`** — mirror `farmers-client.tsx`: `Tags` icon
in the banner; banner copy "Подкатегории в магазина" / "Включи това, ако искаш да групираш
продуктите си…"; empty-state "Без подкатегории"; `updateTenant({ multiSubcat })`;
card uses `<SectionPhoto tint={s.tint} imageUrl={s.imageUrl} height={108} radius={0} label={false} />`
on top, then name + description + the same linked-products footer (`productsOf` matches
`p.subcategoryId === s.id`). Props: `{ initialSubcats, products, initialMultiSubcat }`.

```tsx
'use client';

import { useState } from 'react';
import { Plus, Pencil, Link2, Tags } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ApiError, updateTenant } from '@/lib/api-client';
import type { Subcategory, Product } from '@/lib/types';
import { SectionPhoto } from './section-photo';
import { SubcategoryPanel } from './subcategory-panel';

export function SubcategoriesClient({
  initialSubcats, products, initialMultiSubcat,
}: { initialSubcats: Subcategory[]; products: Product[]; initialMultiSubcat: boolean }) {
  const [subcats, setSubcats] = useState(initialSubcats);
  const [multi, setMulti] = useState(initialMultiSubcat);
  const [edit, setEdit] = useState<Partial<Subcategory> | null>(null);

  const productsOf = (sid: string) => products.filter((p) => p.subcategoryId === sid);

  async function onToggle(v: boolean) {
    setMulti(v);
    try { await updateTenant({ multiSubcat: v }); toast.success(v ? 'Подкатегориите са включени' : 'Подкатегориите са изключени'); }
    catch (e) { setMulti(!v); toast.error(e instanceof ApiError ? e.message : 'Грешка'); }
  }
  function onSaved(s: Subcategory) {
    setSubcats((prev) => (prev.some((x) => x.id === s.id) ? prev.map((x) => (x.id === s.id ? s : x)) : [...prev, s]));
  }

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-[18px] flex flex-wrap items-center gap-4 rounded-[14px] border p-5 shadow-ff-sm"
        style={{ background: multi ? 'var(--ff-green-50)' : 'var(--ff-surface)', borderColor: multi ? 'var(--ff-green-100)' : 'var(--ff-border)' }}>
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl" style={{ background: multi ? 'var(--ff-green-100)' : 'var(--ff-surface-2)', color: multi ? 'var(--ff-green-700)' : 'var(--ff-muted)' }}><Tags size={23} /></span>
        <div className="min-w-[220px] flex-1">
          <div className="text-[15.5px] font-extrabold">Подкатегории в магазина</div>
          <div className="mt-0.5 max-w-[580px] text-[13px] leading-snug text-ff-ink-2">Включи това, ако искаш да групираш продуктите си в собствени секции — всяка със снимка, заглавие и кратко описание.</div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="text-[13px] font-bold" style={{ color: multi ? 'var(--ff-green-700)' : 'var(--ff-muted)' }}>{multi ? 'Включено' : 'Изключено'}</span>
          <ToggleSwitch checked={multi} onChange={onToggle} />
        </div>
      </div>

      {!multi ? (
        <div className="mx-auto max-w-[560px] rounded-[var(--ff-radius)] border border-ff-border bg-ff-surface px-6 py-14 text-center shadow-ff-sm">
          <div className="mx-auto mb-4 grid h-[60px] w-[60px] place-items-center rounded-2xl bg-ff-surface-2 text-ff-muted-2"><Tags size={30} /></div>
          <h2 className="mb-2 text-[19px] font-extrabold">Без подкатегории</h2>
          <p className="mx-auto max-w-[430px] text-sm leading-relaxed text-ff-ink-2">В момента продуктите се показват без допълнително групиране. Включи опцията горе, за да подредиш магазина в секции.</p>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ff-muted">{subcats.length} подкатегории · показват се като секции в магазина</p>
            <Button variant="primary" onClick={() => setEdit({})} className="rounded-sm"><Plus size={18} /> Добави подкатегория</Button>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-4">
            {subcats.map((s) => {
              const prods = productsOf(s.id);
              return (
                <div key={s.id} className="flex flex-col overflow-hidden rounded-[var(--ff-radius)] border border-ff-border bg-ff-surface shadow-ff-sm">
                  <SectionPhoto tint={s.tint} imageUrl={s.imageUrl} height={108} radius={0} label={false} />
                  <div className="flex items-start gap-2.5 border-b border-ff-border-2 px-[18px] pb-3 pt-3.5">
                    <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.tint ?? '#4C8A54' }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[17px] font-extrabold tracking-[-0.01em]">{s.name}</div>
                      {s.description && <p className="mt-[3px] text-[13px] leading-snug text-ff-ink-2">{s.description}</p>}
                    </div>
                    <button onClick={() => setEdit(s)} className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] border border-ff-border bg-ff-surface-2 text-ff-ink-2"><Pencil size={16} /></button>
                  </div>
                  <div className="flex-1 bg-ff-surface-2 px-[18px] pb-4 pt-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-ff-muted"><Link2 size={14} /> Свързани продукти</span>
                      <span className="text-[12.5px] font-extrabold text-ff-green-700">{prods.length}</span>
                    </div>
                    {prods.length ? (
                      <div className="flex flex-wrap gap-[7px]">
                        {prods.map((p) => (
                          <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full border border-ff-border bg-ff-surface py-[5px] pl-2 pr-2.5 text-[12.5px] font-bold text-ff-ink-2">
                            <span className="h-2 w-2 rounded-full" style={{ background: p.tint ?? '#4C8A54' }} />{p.name}
                          </span>
                        ))}
                      </div>
                    ) : <div className="text-[12.5px] text-ff-muted">Още няма продукти. Свържи от „Продукти“.</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {edit && <SubcategoryPanel subcat={edit} onClose={() => setEdit(null)} onSaved={onSaved} />}
    </div>
  );
}
```

- [ ] **Step 4: `page.tsx`** — same shape as the farmers page, fetching
`subcategories`, `products`, and `tenants/me` (read `multiSubcat`):

```tsx
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { SubcategoriesClient } from '@/components/subcategories/subcategories-client';
import type { Subcategory, Product } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function fetchJson<T>(path: string, fallback: T): Promise<T> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return fallback;
  const res = await fetch(`${API_BASE}/${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) return fallback;
  return res.json();
}

export default async function SubcategoriesPage() {
  const [subcats, products, tenant] = await Promise.all([
    fetchJson<Subcategory[]>('subcategories', []),
    fetchJson<Product[]>('products', []),
    fetchJson<{ multiSubcat: boolean }>('tenants/me', { multiSubcat: false }),
  ]);
  return <SubcategoriesClient initialSubcats={subcats} products={products} initialMultiSubcat={tenant.multiSubcat} />;
}
```

- [ ] **Step 5: Verify** — `pnpm --filter @farmflow/web lint`; preview `/subcategories`.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/subcategories client/src/app/\(admin\)/subcategories
git commit -m "feat(web): subcategories admin page"
```

---

## Task 9: Admin client — product dialog with farmer/subcategory links

**Files:**
- Create: `client/src/components/products/product-dialog.tsx` (edit-capable; replaces create-only)
- Modify: `client/src/components/products/products-client.tsx`
- Modify: `client/src/app/(admin)/products/page.tsx`

- [ ] **Step 1: `product-dialog.tsx`** — generalize `create-product-dialog.tsx`: accept a
`product?: Product` (edit when present), `farmers: Farmer[]`, `subcats: Subcategory[]`,
`multiFarmer`, `multiSubcat`, and an `onSubmit(data: Partial<Product>) => Promise<void>`.
Add, after the unit/colour grid, the two conditional selects:

```tsx
{multiFarmer && farmers.length > 0 && (
  <label className={labelCls}>
    Фермер
    <select value={farmerId} onChange={(e) => setFarmerId(e.target.value)} className={`${field} cursor-pointer appearance-none`}>
      {farmers.map((f) => <option key={f.id} value={f.id}>{f.name}{f.role ? ` — ${f.role}` : ''}</option>)}
    </select>
  </label>
)}
{multiSubcat && subcats.length > 0 && (
  <label className={labelCls}>
    Подкатегория
    <select value={subcatId} onChange={(e) => setSubcatId(e.target.value)} className={`${field} cursor-pointer appearance-none`}>
      {subcats.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  </label>
)}
```

Initialize `farmerId` from `product?.farmerId ?? farmers[0]?.id ?? ''` and `subcatId`
likewise. Include in the submit payload only when the toggle is on:
`farmerId: multiFarmer ? (farmerId || null) : undefined`,
`subcategoryId: multiSubcat ? (subcatId || null) : undefined`. Header text and submit
label switch on `product` (Нов продукт / Редакция, Създай / Запази).

- [ ] **Step 2: Wire `products-client.tsx`** — accept new props
`farmers: Farmer[]; subcats: Subcategory[]; multiFarmer: boolean; multiSubcat: boolean`;
replace `CreateProductDialog` import/usage with `ProductDialog`; add an `editProduct`
state so the card's edit button can open the full dialog for relinking. Pass an
`onSubmit` that calls `createProduct` (new) or `updateProduct(editProduct.id, …)` (edit)
and patches local state. Keep the existing inline price/stock quick-edit as-is.

- [ ] **Step 3: Wire `products/page.tsx`** — fetch farmers, subcats, tenant flags
alongside products (same `fetchJson` helper as Task 7) and pass them to `ProductsClient`.

- [ ] **Step 4: Verify** — `pnpm --filter @farmflow/web lint`; preview: with both toggles
on, create a product choosing a farmer + subcategory; confirm the farmer/subcategory
pages now list it as a linked chip.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/products client/src/app/\(admin\)/products
git commit -m "feat(web): product dialog links to farmer + subcategory"
```

---

## Task 10: Storefront — public API client additions

**Files:**
- Modify: `storefront/src/lib/api.ts`

- [ ] **Step 1: Re-export new types + add fetchers** (after the catalog section)

```ts
import type { PublicProduct, PublicArticle, PublicFarmer, PublicSubcategory } from '@farmflow/types';
export type { PublicProduct, PublicArticle, PublicFarmer, PublicSubcategory };

/** Farmers for a storefront — [] when the farm runs single-producer (toggle off). */
export function getFarmers(slug: string): Promise<PublicFarmer[]> {
  return request<PublicFarmer[]>(`/public/${slug}/farmers`, { next: { revalidate: 300 } } as RequestInit);
}

/** Subcategory sections — [] when grouping is off (toggle off). */
export function getSubcategories(slug: string): Promise<PublicSubcategory[]> {
  return request<PublicSubcategory[]>(`/public/${slug}/subcategories`, { next: { revalidate: 300 } } as RequestInit);
}
```

(Adjust the existing top-of-file `import type { PublicProduct, PublicArticle }` to the
combined import above rather than duplicating.)

- [ ] **Step 2: Verify** — `pnpm --filter @farmflow/storefront lint` (or `next lint`).

- [ ] **Step 3: Commit**

```bash
git add storefront/src/lib/api.ts
git commit -m "feat(storefront): public farmers + subcategories api"
```

---

## Task 11: Storefront — grouped sections + farmer attribution

**Files:**
- Create: `storefront/src/components/storefront-catalog.tsx`
- Modify: `storefront/src/app/products/page.tsx`
- Modify: `storefront/src/components/product-card.tsx`
- Modify: `storefront/src/app/product/[slug]/page.tsx`

- [ ] **Step 1: `storefront-catalog.tsx`** — chooses grouped vs flat rendering.

```tsx
'use client';

import type { PublicProduct, PublicFarmer, PublicSubcategory } from '@/lib/api';
import { CatalogClient } from './catalog-client';
import { ProductCard } from './product-card';

export function StorefrontCatalog({
  products, subcategories, farmers,
}: { products: PublicProduct[]; subcategories: PublicSubcategory[]; farmers: PublicFarmer[] }) {
  const farmerById = new Map(farmers.map((f) => [f.id, f]));

  // No subcategory grouping → existing flat catalog with category chips.
  if (subcategories.length === 0) {
    return <CatalogClient products={products} />;
  }

  const sections = subcategories
    .map((s) => ({ subcat: s, items: products.filter((p) => p.subcategoryId === s.id) }))
    .filter((sec) => sec.items.length > 0);
  const ungrouped = products.filter((p) => !p.subcategoryId || !subcategories.some((s) => s.id === p.subcategoryId));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 48, marginTop: 28 }}>
      {sections.map(({ subcat, items }) => (
        <section key={subcat.id}>
          {subcat.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={subcat.imageUrl} alt={subcat.name} style={{ width: '100%', height: 160, objectFit: 'cover', borderRadius: 14, marginBottom: 16 }} />
          )}
          <div className="section-head" style={{ textAlign: 'left', marginBottom: 16 }}>
            <h2 style={{ borderLeft: `4px solid ${subcat.tint ?? '#4C8A54'}`, paddingLeft: 12 }}>{subcat.name}</h2>
            {subcat.description && <p>{subcat.description}</p>}
          </div>
          <div className="grid grid--4">
            {items.map((p) => <ProductCard key={p.id} product={p} farmer={p.farmerId ? farmerById.get(p.farmerId) : undefined} />)}
          </div>
        </section>
      ))}
      {ungrouped.length > 0 && (
        <section>
          <div className="section-head" style={{ textAlign: 'left', marginBottom: 16 }}><h2>Други</h2></div>
          <div className="grid grid--4">
            {ungrouped.map((p) => <ProductCard key={p.id} product={p} farmer={p.farmerId ? farmerById.get(p.farmerId) : undefined} />)}
          </div>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 2: `products/page.tsx`** — fetch subcategories + farmers alongside products,
swap `CatalogClient` for `StorefrontCatalog`:

```tsx
import { getProducts, getSubcategories, getFarmers, resolveSlug, type PublicProduct, type PublicSubcategory, type PublicFarmer } from '@/lib/api';
import { StorefrontCatalog } from '@/components/storefront-catalog';
// ...
  let products: PublicProduct[] = [];
  let subcategories: PublicSubcategory[] = [];
  let farmers: PublicFarmer[] = [];
  let failed = false;
  try {
    [products, subcategories, farmers] = await Promise.all([
      getProducts(slug).then((ps) => ps.filter((p) => p.category !== 'bundle')),
      getSubcategories(slug),
      getFarmers(slug),
    ]);
  } catch { failed = true; }
// ...
  {failed ? (/* unchanged error text */) : (
    <StorefrontCatalog products={products} subcategories={subcategories} farmers={farmers} />
  )}
```

- [ ] **Step 3: `product-card.tsx`** — accept an optional `farmer?: PublicFarmer` and,
when present, render a small attribution line under the price:

```tsx
{farmer && (
  <div className="product__meta" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
    <span style={{ width: 8, height: 8, borderRadius: 99, background: farmer.tint ?? '#4C8A54' }} />
    Произведено от {farmer.name}
  </div>
)}
```

Add `farmer` to the component props (`farmer?: PublicFarmer` from `@/lib/api`).

- [ ] **Step 4: `product/[slug]/page.tsx`** — fetch farmers, find the product's farmer,
and pass it where the page renders product info (an attribution line near the title,
matching the card style). If the product page uses `product-buy.tsx`, thread the farmer
name through as a prop or render the small line directly in the server component.

- [ ] **Step 5: Verify** — `pnpm --filter @farmflow/storefront build`; preview /products
with `multiSubcat` on (sections appear) and off (flat catalog unchanged); with
`multiFarmer` on, a card shows "Произведено от …".

- [ ] **Step 6: Commit**

```bash
git add storefront/src
git commit -m "feat(storefront): subcategory sections + farmer attribution"
```

---

## Self-Review notes

- **Spec coverage:** DB tables/FKs/flags (Task 1) ✓; server CRUD + image + public + DTOs + wiring (Tasks 2–4) ✓; admin types/api/nav/pages/product-linking (Tasks 5–9) ✓; storefront api + grouping + attribution (Tasks 10–11) ✓.
- **Type consistency:** `farmerId`/`subcategoryId` used identically in DB column, DTO, `Product` type, dialog payload, and storefront grouping. Toggle names `multiFarmer`/`multiSubcat` consistent across tenant column, DTO, `updateTenant`, page props.
- **Unlink path:** product DTO uses `@ValidateIf(v !== null) @IsUUID()` so a product can be cleared of its farmer/subcategory (Task 4 Step 1). Hard delete + FK `SET NULL` keeps products valid when a farmer/subcat is removed.
- **No DB available:** Task 1 Step 8 notes migrate/seed may be skipped; everything else verifies via build/lint/preview.
```
