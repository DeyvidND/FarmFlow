import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type Database, products, productMedia, farmers, subcategories } from '@farmflow/db';
import type { Product, ProductMedia, PublicProduct } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { IMAGE_QUEUE } from '../../common/queue/queue.constants';
import { encodeImageJob } from '../../common/queue/image-job';
import { clampLimit, keysetAfter, buildPage, type Paginated } from '../../common/pagination/keyset';
import { decodeCursor } from '../../common/pagination/cursor';

/** Lean product shape for cross-page consumers (farmer/section counts, low-stock
 *  notifications) that need every product but not the heavy columns. */
export interface ProductOption {
  id: string;
  name: string;
  weight: string | null;
  tint: string | null;
  isActive: boolean | null;
  stockQuantity: number | null;
  farmerId: string | null;
  subcategoryId: string | null;
}
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { StorageService } from '../storage/storage.service';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { ReorderMediaDto } from '../../common/dto/reorder-media.dto';
import { ReorderDto } from '../../common/dto/reorder.dto';
import { slugify } from '../articles/articles.util';
import { PRODUCT_IMAGE_EXT_BY_MIME } from '../storage/dto/upload-image.dto';
import { optimizeImage } from '../storage/image.util';
import { smartFocal, smartFocalFromUrl } from '../storage/smart-crop.util';
import { tenantSlug } from '../../common/tenant-slug.util';

@Injectable()
export class ProductsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly cache: CatalogCacheService,
    private readonly publicCache: PublicCacheService,
    @InjectQueue(IMAGE_QUEUE) private readonly imageQueue: Queue,
  ) {}

  /** Admin list: tenant-scoped, oldest first, keyset-paginated. `total` is included
   *  only on the first page (no cursor) so the UI can show the full count.
   *  farmerScope — when non-null (producer sub-account), restricts to that farmer's
   *  own products; null = owner, whole tenant. */
  async findAll(
    tenantId: string,
    opts: { cursor?: string; limit?: number } = {},
    farmerScope: string | null = null,
  ): Promise<Paginated<Product>> {
    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    // `deleted_at IS NULL` hides soft-deleted products (a removed product, unlike a
    // hidden/inactive one, must disappear from the admin list — see remove()).
    const conds = [eq(products.tenantId, tenantId), isNull(products.deletedAt)];
    if (farmerScope !== null) conds.push(eq(products.farmerId, farmerScope));
    if (cur) conds.push(keysetAfter(products.createdAt, products.id, cur, 'asc'));

    const rows = await this.db
      .select()
      .from(products)
      .where(and(...conds))
      .orderBy(asc(products.createdAt), asc(products.id))
      .limit(lim + 1);

    const page = buildPage(rows, lim, (r) => ({ createdAt: r.createdAt!, id: r.id }));
    if (!cur) {
      const totalConds = [eq(products.tenantId, tenantId), isNull(products.deletedAt)];
      if (farmerScope !== null) totalConds.push(eq(products.farmerId, farmerScope));
      const [{ total }] = await this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(products)
        .where(and(...totalConds));
      page.total = total;
    }
    return page;
  }

  /** Lean full list for cross-page consumers (no pagination — ids + a few fields).
   *  Soft-deleted products are excluded so they don't inflate farmer/section counts
   *  or trip low-stock notifications. */
  listOptions(tenantId: string, farmerScope: string | null = null): Promise<ProductOption[]> {
    const conds = [eq(products.tenantId, tenantId), isNull(products.deletedAt)];
    if (farmerScope !== null) conds.push(eq(products.farmerId, farmerScope));
    return this.db
      .select({
        id: products.id,
        name: products.name,
        weight: products.weight,
        tint: products.tint,
        isActive: products.isActive,
        stockQuantity: products.stockQuantity,
        farmerId: products.farmerId,
        subcategoryId: products.subcategoryId,
      })
      .from(products)
      .where(and(...conds))
      .orderBy(asc(products.position), asc(products.createdAt));
  }

  /** Persist a new catalog display order. Each item's `position` is set
   *  tenant-scoped in one transaction (a mid-loop failure can't leave a
   *  half-applied order); the public catalog cache is busted. Used for both
   *  global and per-category reordering — the client computes the position
   *  values (full 0..N-1 sequence for global, slot-preserving for per-category). */
  async reorder(tenantId: string, dto: ReorderDto): Promise<{ ok: true }> {
    await this.db.transaction(async (tx) => {
      for (const it of dto.items) {
        await tx
          .update(products)
          .set({ position: it.position })
          .where(and(eq(products.id, it.id), eq(products.tenantId, tenantId)));
      }
    });
    await this.cache.invalidate(tenantId);
    return { ok: true };
  }

  /** farmerScope — when non-null (producer sub-account), the product must also
   *  belong to that farmer; a foreign product is reported as not-found (no
   *  existence leak). This is the single ownership gate the media/image methods
   *  funnel through, so opening those to producers needs no extra checks. */
  async findOne(id: string, tenantId: string, farmerScope: string | null = null): Promise<Product> {
    const [row] = await this.db
      .select()
      .from(products)
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new NotFoundException('Продуктът не е намерен');
    if (farmerScope !== null && row.farmerId !== farmerScope) {
      throw new NotFoundException('Продуктът не е намерен');
    }
    return row;
  }

  /** Reject a farmer/subcategory reference that belongs to another tenant. The
   *  ids come straight from the client DTO; every other module validates such
   *  cross-row references the same way (e.g. reviews → product). */
  private async assertRefsInTenant(
    tenantId: string,
    dto: { farmerId?: string | null; subcategoryId?: string | null },
  ): Promise<void> {
    if (dto.farmerId) {
      const [f] = await this.db
        .select({ id: farmers.id })
        .from(farmers)
        .where(and(eq(farmers.id, dto.farmerId), eq(farmers.tenantId, tenantId)))
        .limit(1);
      if (!f) throw new BadRequestException('Невалиден фермер');
    }
    if (dto.subcategoryId) {
      const [s] = await this.db
        .select({ id: subcategories.id })
        .from(subcategories)
        .where(and(eq(subcategories.id, dto.subcategoryId), eq(subcategories.tenantId, tenantId)))
        .limit(1);
      if (!s) throw new BadRequestException('Невалидна подкатегория');
    }
  }

  /** farmerScope — when non-null (producer sub-account), the new product is forced
   *  onto that farmer regardless of any farmerId in the DTO (a producer can only
   *  create products for themselves). */
  async create(
    tenantId: string,
    dto: CreateProductDto,
    farmerScope: string | null = null,
  ): Promise<Product> {
    // A producer's products always belong to them — ignore any client-supplied farmer.
    const values = farmerScope !== null ? { ...dto, farmerId: farmerScope } : dto;
    await this.assertRefsInTenant(tenantId, values);
    // Storefront product pages key off `slug`. The admin form doesn't collect
    // one, so derive a tenant-unique slug from the name (Cyrillic-aware).
    const slug = await this.uniqueSlug(tenantId, slugify(dto.name) || 'produkt');
    const [row] = await this.db
      .insert(products)
      .values({ ...values, tenantId, slug })
      .returning();
    await this.cache.invalidate(tenantId);
    return row;
  }

  /** First free `slug`, `slug-2`, `slug-3`… for this tenant (the (tenant, slug)
   *  index is unique). */
  private async uniqueSlug(tenantId: string, base: string): Promise<string> {
    const root = base || 'produkt';
    let candidate = root;
    for (let i = 2; ; i++) {
      const [taken] = await this.db
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.tenantId, tenantId), eq(products.slug, candidate)))
        .limit(1);
      if (!taken) return candidate;
      candidate = `${root}-${i}`;
    }
  }

  /** farmerScope — when non-null (producer sub-account), the product must belong to
   *  that farmer (else not-found) and any `farmerId` reassignment in the DTO is
   *  dropped so a producer can never move a product to (or away from) themselves. */
  async update(
    id: string,
    tenantId: string,
    dto: UpdateProductDto,
    farmerScope: string | null = null,
  ): Promise<Product> {
    if (farmerScope !== null) await this.findOne(id, tenantId, farmerScope);
    // Producers can edit their own product's fields but not its ownership.
    const data = farmerScope !== null ? { ...dto, farmerId: undefined } : dto;
    await this.assertRefsInTenant(tenantId, data);
    const [row] = await this.db
      .update(products)
      .set({ ...data })
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Продуктът не е намерен');
    await this.cache.invalidate(tenantId);
    return row;
  }

  /** Soft delete: stamp `deleted_at` so the product leaves every admin read and the
   *  catalog for good. The row stays (its order_items / reviews FKs are ON DELETE no
   *  action — a hard delete would fail for any product ever ordered) and its
   *  image + gallery are untouched. We also clear `is_active` so the storefront,
   *  which filters on `is_active = true`, drops it too. Distinct from the is_active
   *  hide/show toggle, which keeps a product visible (greyed) in the admin list. */
  async remove(id: string, tenantId: string, farmerScope: string | null = null): Promise<{ id: string }> {
    await this.findOne(id, tenantId, farmerScope);

    await this.db
      .update(products)
      .set({ isActive: false, deletedAt: new Date() })
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId)));

    await this.cache.invalidate(tenantId);
    return { id };
  }

  async uploadImage(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
    farmerScope: string | null = null,
  ): Promise<Product & { imageProcessing: boolean }> {
    const product = await this.findOne(id, tenantId, farmerScope);
    await this.imageQueue.add('process', encodeImageJob('product-cover', id, tenantId, file));
    return { ...product, imageProcessing: true };
  }

  /** Called by the image worker after it has decoded and optimized the bytes. */
  async finishProductCover(
    id: string,
    tenantId: string,
    buffer: Buffer,
    mime: string,
  ): Promise<void> {
    const product = await this.findOne(id, tenantId);

    const img = await optimizeImage(
      buffer,
      mime,
      PRODUCT_IMAGE_EXT_BY_MIME[mime] ?? 'bin',
    );
    const slug = await tenantSlug(this.db, tenantId);
    const key = `tenants/${slug}/products/${id}/${randomUUID()}.${img.ext}`;
    const { url } = await this.storage.upload(img.buffer, key, img.contentType);

    // Replace: drop the previous object once the new one is stored.
    if (product.imageUrl) await this.deleteObject(product.imageUrl);

    await this.db
      .update(products)
      .set({ imageUrl: url, coverCrop: await smartFocal(img.buffer) })
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId)))
      .returning();

    await this.cache.invalidate(tenantId);
  }

  /**
   * Bulk-link products to a farmer and/or subcategory (the assign picker on the
   * Фермери / Подкатегории pages). Tenant-scoped; `null` unlinks. Only the keys
   * present in the DTO are written, so the two links are independent. One cache
   * invalidation for the whole batch.
   */
  async assignProducts(
    tenantId: string,
    dto: { productIds: string[]; farmerId?: string | null; subcategoryId?: string | null },
  ): Promise<{ updated: number }> {
    if (!dto.productIds?.length) return { updated: 0 };
    // Same cross-tenant guard as create/update: a tenant must not be able to link
    // its products to another tenant's farmer/subcategory (the bulk path is no
    // exception — the DB single-column FK only proves the row exists, not tenancy).
    await this.assertRefsInTenant(tenantId, dto);
    const set: Partial<typeof products.$inferInsert> = {};
    if (dto.farmerId !== undefined) set.farmerId = dto.farmerId;
    if (dto.subcategoryId !== undefined) set.subcategoryId = dto.subcategoryId;
    if (Object.keys(set).length === 0) return { updated: 0 };

    const rows = await this.db
      .update(products)
      .set(set)
      .where(and(eq(products.tenantId, tenantId), inArray(products.id, dto.productIds)))
      .returning({ id: products.id });

    await this.cache.invalidate(tenantId);
    return { updated: rows.length };
  }

  // ---- Gallery (multi-image) ----

  /** Ordered gallery for a product (admin). 404 if missing / cross-tenant /
   *  (when scoped) not the producer's own. */
  async listMedia(id: string, tenantId: string, farmerScope: string | null = null): Promise<ProductMedia[]> {
    await this.findOne(id, tenantId, farmerScope);
    return this.db
      .select()
      .from(productMedia)
      .where(eq(productMedia.productId, id))
      .orderBy(asc(productMedia.position));
  }

  /** Append an uploaded photo to the gallery (async path): validates ownership
   *  then enqueues the heavy optimize+upload work; returns immediately so the
   *  HTTP response is fast. The worker calls `finishProductMedia` once done. */
  async addMedia(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
    farmerScope: string | null = null,
  ): Promise<{ imageProcessing: boolean }> {
    await this.findOne(id, tenantId, farmerScope);
    await this.imageQueue.add('process', encodeImageJob('product-media', id, tenantId, file));
    return { imageProcessing: true };
  }

  /** Worker finisher: runs the full synchronous optimize → upload → insert → syncCover
   *  pipeline for a gallery photo after the queue has decoded the raw bytes. */
  async finishProductMedia(
    id: string,
    tenantId: string,
    buffer: Buffer,
    mime: string,
  ): Promise<void> {
    const product = await this.findOne(id, tenantId);

    const existing = await this.db
      .select()
      .from(productMedia)
      .where(eq(productMedia.productId, id))
      .orderBy(asc(productMedia.position));

    // Legacy item (cover set, no gallery yet): adopt the existing cover as photo 0
    // so it joins the gallery instead of being silently replaced/orphaned.
    if (existing.length === 0 && product.imageUrl) {
      const [adopted] = await this.db
        .insert(productMedia)
        .values({ productId: id, tenantId, url: product.imageUrl, position: 0 })
        .returning();
      existing.push(adopted);
    }

    const img = await optimizeImage(
      buffer,
      mime,
      PRODUCT_IMAGE_EXT_BY_MIME[mime] ?? 'bin',
    );
    const slug = await tenantSlug(this.db, tenantId);
    const key = `tenants/${slug}/products/${id}/${randomUUID()}.${img.ext}`;
    const { url } = await this.storage.upload(img.buffer, key, img.contentType);

    await this.db
      .insert(productMedia)
      .values({ productId: id, tenantId, url, position: existing.length })
      .returning();

    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);
  }

  /** Remove one gallery photo (DB row + R2 object), then re-sync the cover. */
  async removeMedia(
    id: string,
    mediaId: string,
    tenantId: string,
    farmerScope: string | null = null,
  ): Promise<{ id: string }> {
    await this.findOne(id, tenantId, farmerScope);

    const [m] = await this.db
      .select()
      .from(productMedia)
      .where(
        and(
          eq(productMedia.id, mediaId),
          eq(productMedia.productId, id),
          eq(productMedia.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!m) throw new NotFoundException('Снимката не е намерена');

    await this.deleteObject(m.url);
    await this.db.delete(productMedia).where(eq(productMedia.id, mediaId));
    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);
    return { id: mediaId };
  }

  /** Persist a new gallery order; cover follows whichever photo is now position 0. */
  async reorderMedia(
    id: string,
    tenantId: string,
    dto: ReorderMediaDto,
    farmerScope: string | null = null,
  ): Promise<ProductMedia[]> {
    await this.findOne(id, tenantId, farmerScope);

    // One transaction so a mid-loop failure can't leave a half-applied order.
    await this.db.transaction(async (tx) => {
      for (const it of dto.items) {
        await tx
          .update(productMedia)
          .set({ position: it.position })
          .where(
            and(
              eq(productMedia.id, it.id),
              eq(productMedia.productId, id),
              eq(productMedia.tenantId, tenantId),
            ),
          );
      }
    });
    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);

    return this.db
      .select()
      .from(productMedia)
      .where(eq(productMedia.productId, id))
      .orderBy(asc(productMedia.position));
  }

  /** Mirror the first gallery photo (by position) into `products.imageUrl` as the
   *  cover; NULLs the cover when the gallery is empty. */
  private async syncCover(id: string, tenantId: string): Promise<void> {
    // Two independent reads (gallery cover + current cover) — run them together.
    const [[first], [cur]] = await Promise.all([
      this.db
        .select({ url: productMedia.url })
        .from(productMedia)
        .where(eq(productMedia.productId, id))
        .orderBy(asc(productMedia.position))
        .limit(1),
      this.db
        .select({ imageUrl: products.imageUrl })
        .from(products)
        .where(and(eq(products.id, id), eq(products.tenantId, tenantId)))
        .limit(1),
    ]);
    const newUrl = first?.url ?? null;
    // Cover image unchanged → keep whatever framing is set (incl. a manual override).
    if (cur?.imageUrl === newUrl) return;
    // New cover → recompute a content-aware focal default (the old framing belonged
    // to the previous image; the cover editor also resets it on a cover change).
    const coverCrop = newUrl ? await smartFocalFromUrl(newUrl) : null;
    await this.db
      .update(products)
      .set({ imageUrl: newUrl, coverCrop })
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId)));
  }

  /** Gallery photo URLs (ordered) for a set of products — single query, no N+1. */
  private async mediaUrlsByProduct(ids: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (!ids.length) return map;
    const rows = await this.db
      .select({ productId: productMedia.productId, url: productMedia.url })
      .from(productMedia)
      .where(inArray(productMedia.productId, ids))
      .orderBy(asc(productMedia.position));
    for (const r of rows) {
      const list = map.get(r.productId!) ?? [];
      list.push(r.url);
      map.set(r.productId!, list);
    }
    return map;
  }

  /** Public catalog for a storefront slug — active products only, Redis-cached. */
  async findPublicBySlug(slug: string): Promise<PublicProduct[]> {
    // Shared Redis slug→tenant resolver (same key farmers/subcats/reviews use), so
    // a warm storefront/bootstrap render does zero Postgres tenant lookups.
    const tenant = await this.publicCache.resolveTenant(this.db, slug);

    const cached = (await this.cache.get(tenant.id)) as PublicProduct[] | null;
    if (cached) return cached;

    const rows = await this.db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenant.id), eq(products.isActive, true)))
      .orderBy(asc(products.position), asc(products.createdAt), asc(products.id));

    const mediaByProduct = await this.mediaUrlsByProduct(rows.map((r) => r.id));
    const result = rows.map((p) => toPublicProduct(p, mediaByProduct.get(p.id) ?? []));
    await this.cache.set(tenant.id, result, 300);
    return result;
  }

  /** Single active product by its storefront slug, or 404. Reuses the cached
   *  public catalog so a product page hits Redis, not Postgres. */
  async findPublicProductBySlug(
    slug: string,
    productSlug: string,
  ): Promise<PublicProduct> {
    const catalog = await this.findPublicBySlug(slug);
    const product = catalog.find((p) => p.slug === productSlug);
    if (!product) throw new NotFoundException('Продуктът не е намерен');
    return product;
  }

  /** Best-effort removal of a stored object given its public URL. */
  private async deleteObject(url: string): Promise<void> {
    try {
      const key = new URL(url).pathname.replace(/^\/+/, '');
      if (key) await this.storage.delete(key);
    } catch {
      // a storage hiccup must not block the DB write
    }
  }
}

/** Strip tenant + stock + internal Stripe ids before exposing a product publicly,
 *  and attach the ordered gallery (cover-first; falls back to the legacy single
 *  `imageUrl`, else an empty list). */
function toPublicProduct(p: Product, mediaUrls: string[]): PublicProduct {
  const { tenantId, stockQuantity, stripeProductId, stripePriceId, ...rest } = p;
  const images = mediaUrls.length ? mediaUrls : p.imageUrl ? [p.imageUrl] : [];
  return { ...rest, images };
}
