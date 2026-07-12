import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { and, asc, eq, getTableColumns, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { type Database, products, productMedia, productVariants, productBundleItems, farmers, subcategories } from '@fermeribg/db';
import type { Product, ProductMedia, ProductVariant, PublicProduct, PublicProductVariant, PublicBundleItem } from '@fermeribg/types';
import { BundleItemDto } from './dto/bundle-items.dto';
import { isPromoActive, salePriceStotinki } from './promo.util';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { IMAGE_QUEUE } from '../../common/queue/queue.constants';
import { encodeImageJob } from '../../common/queue/image-job';
import {
  clampLimit,
  keysetAfter,
  buildKeysetPage,
  cursorTs,
  KEYSET_TS,
  type Paginated,
} from '../../common/pagination/keyset';
import { positionCase } from '../../common/db/reorder.util';
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
  courierDisabled: boolean;
}

/** A bundle's member product as returned to the admin/farmer bundle editor (task #1).
 *  `isActive`/`courierDisabled` let the editor flag members that won't show on the
 *  storefront or can't ship by courier. */
export interface BundleMember {
  productId: string;
  name: string;
  slug: string | null;
  image: string | null;
  quantity: number;
  position: number;
  priceStotinki: number;
  isActive: boolean | null;
  courierDisabled: boolean;
}
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { AvailabilityService } from '../availability/availability.service';
import { StorageService } from '../storage/storage.service';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { ReorderMediaDto } from '../../common/dto/reorder-media.dto';
import { ReorderDto } from '../../common/dto/reorder.dto';
import { slugify } from '../articles/articles.util';
import { PRODUCT_IMAGE_EXT_BY_MIME } from '../storage/dto/upload-image.dto';
import { optimizeImage } from '../storage/image.util';
import { smartFocal, smartFocalFromUrl, isAllowedImageUrl } from '../storage/smart-crop.util';
import { inlineSanityCheck } from '../storage/image-sanity.util';
import { ImageSanityVisionClient } from './image-sanity-vision.client';
import { tenantSlug } from '../../common/tenant-slug.util';

@Injectable()
export class ProductsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly cache: CatalogCacheService,
    private readonly publicCache: PublicCacheService,
    @InjectQueue(IMAGE_QUEUE) private readonly imageQueue: Queue,
    private readonly availability: AvailabilityService,
    private readonly sanityVision: ImageSanityVisionClient,
  ) {}

  /** Admin list: tenant-scoped, oldest first, keyset-paginated. `total` is included
   *  only on the first page (no cursor) so the UI can show the full count.
   *  farmerScope — when non-null (producer sub-account), restricts to that farmer's
   *  own products; null = owner, whole tenant. */
  async findAll(
    tenantId: string,
    opts: { cursor?: string; limit?: number; review?: boolean } = {},
    farmerScope: string | null = null,
  ): Promise<Paginated<Product>> {
    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    // `deleted_at IS NULL` hides soft-deleted products (a removed product, unlike a
    // hidden/inactive one, must disappear from the admin list — see remove()).
    const conds = [eq(products.tenantId, tenantId), isNull(products.deletedAt)];
    if (farmerScope !== null) conds.push(eq(products.farmerId, farmerScope));
    if (opts.review) conds.push(eq(products.needsReview, true));
    if (cur) conds.push(keysetAfter(products.createdAt, products.id, cur, 'asc'));

    const rows = await this.db
      .select({ ...getTableColumns(products), [KEYSET_TS]: cursorTs(products.createdAt) })
      .from(products)
      .where(and(...conds))
      .orderBy(asc(products.createdAt), asc(products.id))
      .limit(lim + 1);

    const page = buildKeysetPage(rows, lim);
    if (!cur) {
      const totalConds = [eq(products.tenantId, tenantId), isNull(products.deletedAt)];
      if (farmerScope !== null) totalConds.push(eq(products.farmerId, farmerScope));
      if (opts.review) totalConds.push(eq(products.needsReview, true));
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
        courierDisabled: products.courierDisabled,
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
    if (dto.items.length) {
      // One UPDATE … SET position = CASE … END instead of a statement per row.
      await this.db
        .update(products)
        .set({ position: positionCase(products.id, products.position, dto.items) })
        .where(and(inArray(products.id, dto.items.map((i) => i.id)), eq(products.tenantId, tenantId)));
    }
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
    opts: { needsReview?: boolean } = {},
  ): Promise<Product> {
    // `stock` is virtual — it drives the availability window, not a products
    // column — so strip it before the row is written.
    // `variants` are handled separately (upserted after the product row); strip here.
    const { stock, variants, saleEndsAt, ...productDto } = dto;
    // Convert ISO string → Date for the timestamp column (null passes through).
    const saleEndsAtDate = saleEndsAt != null ? new Date(saleEndsAt) : saleEndsAt;
    const promoOverride = resolvePromoOverride(productDto, variants, dto.priceStotinki);
    // A producer's products always belong to them — ignore any client-supplied farmer.
    const values = farmerScope !== null
      ? { ...productDto, saleEndsAt: saleEndsAtDate, ...promoOverride, farmerId: farmerScope }
      : { ...productDto, saleEndsAt: saleEndsAtDate, ...promoOverride };
    await this.assertRefsInTenant(tenantId, values);
    // Storefront product pages key off `slug`. The admin form doesn't collect
    // one, so derive a tenant-unique slug from the name (Cyrillic-aware).
    const slug = await this.uniqueSlug(tenantId, slugify(dto.name) || 'produkt');
    const [row] = await this.db
      .insert(products)
      .values({ ...values, tenantId, slug, needsReview: opts.needsReview ?? false })
      .returning();
    // A stock number sets the product's availability window straight away; null /
    // absent leaves it unlimited (no window).
    if (typeof stock === 'number') {
      await this.availability.setProductStock(tenantId, row.id, stock);
    }
    await this.syncVariants(tenantId, row.id, variants);
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
    // `stock` is virtual (drives the availability window); keep it out of the
    // products write. `undefined` = caller didn't touch stock (e.g. a hide/show
    // toggle) → leave the window alone.
    // `variants` are handled separately; `saleEndsAt` is an ISO string in the DTO
    // but a Date in the DB — convert here.
    const { stock, variants, saleEndsAt, ...rest } = dto;
    const saleEndsAtDate = saleEndsAt != null ? new Date(saleEndsAt) : saleEndsAt;
    const promoOverride = resolvePromoOverride(rest, variants, dto.priceStotinki);
    // Producers can edit their own product's fields but not its ownership.
    const data = farmerScope !== null
      ? { ...rest, saleEndsAt: saleEndsAtDate, ...promoOverride, farmerId: undefined }
      : { ...rest, saleEndsAt: saleEndsAtDate, ...promoOverride };
    await this.assertRefsInTenant(tenantId, data);
    const [row] = await this.db
      .update(products)
      .set({ ...data })
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Продуктът не е намерен');
    // number = set stock, null = clear (→ unlimited), undefined = untouched.
    if (stock !== undefined) {
      await this.availability.setProductStock(tenantId, id, stock);
    }
    await this.syncVariants(tenantId, id, variants);
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

  /** Admin sign-off: the product leaves the review queue and becomes publicly
   *  visible (subject to the usual isActive/stock rules). Idempotent. */
  async approve(id: string, tenantId: string): Promise<Product> {
    const [row] = await this.db
      .update(products)
      .set({ needsReview: false })
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId), isNull(products.deletedAt)))
      .returning();
    if (!row) throw new NotFoundException('Продуктът не е намерен');
    await this.cache.invalidate(tenantId);
    return row;
  }

  /** Size of the review queue — drives the «Провери продукти» badge. */
  async pendingReviewCount(tenantId: string): Promise<{ count: number }> {
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(and(
        eq(products.tenantId, tenantId),
        eq(products.needsReview, true),
        isNull(products.deletedAt),
      ));
    return { count };
  }

  /** Batch-update the `courierDisabled` flag for multiple products in one query.
   *  Only products belonging to the tenant (and farmer scope if non-null) are touched;
   *  the server silently ignores ids that don't pass the scope check. */
  async updateCourierBatch(
    tenantId: string,
    updates: { id: string; courierDisabled: boolean }[],
    farmerScope: string | null = null,
  ): Promise<{ ok: true }> {
    if (!updates.length) return { ok: true };
    const whens = updates.map(
      (u) => sql`when ${products.id} = ${u.id} then ${u.courierDisabled}`,
    );
    const conds = [
      inArray(products.id, updates.map((u) => u.id)),
      eq(products.tenantId, tenantId),
      isNull(products.deletedAt),
    ];
    if (farmerScope !== null) conds.push(eq(products.farmerId, farmerScope));
    await this.db
      .update(products)
      .set({ courierDisabled: sql`case ${sql.join(whens, sql` `)} else ${products.courierDisabled} end` })
      .where(and(...conds));
    await this.cache.invalidate(tenantId);
    return { ok: true };
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

  /** Persist the product's variants (full replace) and sync the cheapest price.
   *  Runs after the products row is written. No-op when `variants` is undefined
   *  (caller didn't touch them). */
  private async syncVariants(
    tenantId: string,
    productId: string,
    variants: VariantInput[] | undefined,
  ): Promise<void> {
    if (variants === undefined) return;
    // A fixed promo price must be a real discount — below the variant's price.
    for (const v of variants) {
      if (v.salePriceStotinki != null && v.salePriceStotinki >= v.priceStotinki) {
        throw new BadRequestException('Промо цената трябва да е под редовната цена на варианта');
      }
    }
    // One transaction so a mid-replace failure can't leave a partial variant set
    // plus a stale products.priceStotinki sync. Inserts are batched into a single
    // statement instead of one round-trip per variant.
    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(and(eq(productVariants.productId, productId), isNull(productVariants.deletedAt)));
      const { inserts, updates, deleteIds } = planVariantWrites(variants, existing.map((r) => r.id));
      if (inserts.length) {
        await tx.insert(productVariants).values(inserts.map((ins) => ({ ...ins, productId })));
      }
      for (const upd of updates) {
        const { id, ...set } = upd;
        await tx
          .update(productVariants)
          .set(set)
          .where(and(eq(productVariants.id, id), eq(productVariants.productId, productId)));
      }
      if (deleteIds.length) {
        await tx
          .update(productVariants)
          .set({ deletedAt: new Date() })
          .where(and(eq(productVariants.productId, productId), inArray(productVariants.id, deleteIds)));
      }
      // Keep products.priceStotinki = cheapest variant (for sort + "от X"); leave it
      // untouched when the product has no variants.
      const cheapest = cheapestVariantPrice(variants);
      if (cheapest != null) {
        await tx
          .update(products)
          .set({ priceStotinki: cheapest })
          .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)));
      }
    });
  }

  // ---- Bundle contents („Фермерска кошница" / готови пакети, task #1) ----

  /** Member products of a bundle (products.category='bundle'), ordered. Same
   *  guard/scope as the other product reads (a producer sees only their own). */
  async listBundleItems(
    bundleId: string,
    tenantId: string,
    farmerScope: string | null = null,
  ): Promise<BundleMember[]> {
    await this.findOne(bundleId, tenantId, farmerScope); // existence + tenant + farmer scope
    const rows = await this.db
      .select({
        productId: productBundleItems.productId,
        quantity: productBundleItems.quantity,
        position: productBundleItems.position,
        name: products.name,
        slug: products.slug,
        imageUrl: products.imageUrl,
        priceStotinki: products.priceStotinki,
        isActive: products.isActive,
        courierDisabled: products.courierDisabled,
      })
      .from(productBundleItems)
      .innerJoin(products, eq(products.id, productBundleItems.productId))
      .where(eq(productBundleItems.bundleId, bundleId))
      .orderBy(asc(productBundleItems.position), asc(productBundleItems.productId));
    return rows.map((r) => ({
      productId: r.productId,
      name: r.name,
      slug: r.slug,
      image: r.imageUrl,
      quantity: r.quantity,
      position: r.position,
      priceStotinki: r.priceStotinki,
      isActive: r.isActive,
      courierDisabled: r.courierDisabled,
    }));
  }

  /** Full-replace a bundle's member products (mirrors the variants "set" pattern):
   *  upsert the given members, drop any not in the list. Rejects a non-bundle target,
   *  a member that isn't in this tenant, the bundle referencing itself, and a member
   *  that is itself a bundle (no nested bundles → no render/loop hazard). Inactive
   *  members may be linked but are hidden from the public bundle payload. */
  async setBundleItems(
    bundleId: string,
    tenantId: string,
    items: BundleItemDto[],
    farmerScope: string | null = null,
  ): Promise<BundleMember[]> {
    const bundle = await this.findOne(bundleId, tenantId, farmerScope);
    if (bundle.category !== 'bundle') {
      throw new BadRequestException('Само пакет (готова кошница) може да съдържа продукти');
    }
    // A member appears once per bundle (unique bundle_id+product_id) — dedupe, last wins.
    const byProduct = new Map<string, BundleItemDto>();
    for (const it of items) byProduct.set(it.productId, it);
    const memberIds = [...byProduct.keys()];
    if (memberIds.includes(bundleId)) {
      throw new BadRequestException('Пакетът не може да съдържа себе си');
    }
    // One transaction so a mid-replace failure can't leave a partial membership set.
    // The member validation runs INSIDE the tx, under row locks (`.for('update')`),
    // so a concurrent product update can't flip a member's category to 'bundle' (or
    // move it to another farmer) between the check and the delete+insert below.
    await this.db.transaction(async (tx) => {
      if (memberIds.length) {
        const members = await tx
          .select({ id: products.id, category: products.category, farmerId: products.farmerId })
          .from(products)
          .where(and(eq(products.tenantId, tenantId), inArray(products.id, memberIds), isNull(products.deletedAt)))
          .for('update');
        const foundById = new Map(members.map((m) => [m.id, m]));
        for (const id of memberIds) {
          const m = foundById.get(id);
          if (!m) throw new BadRequestException('Продукт от пакета не е намерен в този магазин');
          if (m.category === 'bundle') throw new BadRequestException('Пакет не може да съдържа друг пакет');
          if (bundle.farmerId !== null && m.farmerId !== bundle.farmerId) {
            throw new BadRequestException('Продукт от пакета принадлежи на друг производител');
          }
        }
      }
      await tx.delete(productBundleItems).where(eq(productBundleItems.bundleId, bundleId));
      if (memberIds.length) {
        await tx.insert(productBundleItems).values(
          memberIds.map((productId, i) => ({
            tenantId,
            bundleId,
            productId,
            quantity: byProduct.get(productId)!.quantity ?? 1,
            position: i,
          })),
        );
      }
    });
    await this.cache.invalidate(tenantId);
    return this.listBundleItems(bundleId, tenantId, farmerScope);
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

  /** A product's live variants for the admin edit form (ordered). Enforces tenant
   *  + farmer scope via findOne. */
  async listVariants(id: string, tenantId: string, farmerScope: string | null = null): Promise<ProductVariant[]> {
    await this.findOne(id, tenantId, farmerScope);
    return this.db
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.productId, id), isNull(productVariants.deletedAt)))
      .orderBy(asc(productVariants.position), asc(productVariants.id));
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
    // Cheap, synchronous (no network) checks — flags the upload, never blocks it.
    // An anomaly makes the worker follow up with a vision-based pass once the
    // gallery row exists (see `finishProductMedia` / `finishImageSanity`).
    const sanity = await inlineSanityCheck(file.buffer, file.mimetype);
    await this.imageQueue.add(
      'process',
      encodeImageJob('product-media', id, tenantId, file, sanity.anomaly ? sanity.reasons : undefined),
    );
    return { imageProcessing: true };
  }

  /** Worker finisher: runs the full synchronous optimize → upload → insert → syncCover
   *  pipeline for a gallery photo after the queue has decoded the raw bytes. Returns
   *  the new gallery row's id so the caller can follow up with an image-sanity job. */
  async finishProductMedia(
    id: string,
    tenantId: string,
    buffer: Buffer,
    mime: string,
  ): Promise<{ mediaId: string }> {
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

    const [inserted] = await this.db
      .insert(productMedia)
      .values({ productId: id, tenantId, url, position: existing.length })
      .returning();

    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);
    return { mediaId: inserted.id };
  }

  /**
   * Worker finisher for the follow-up 'image-sanity' job: fetches the stored
   * photo the inline check flagged, asks the vision client to judge it, and
   * either applies a rotate/crop fix (uploading a derived object, keeping the
   * original for "върни оригинала") or marks it `sanityVerdict:'unusable'` for
   * the panel to surface. Idempotent (skips a row already judged) and
   * best-effort throughout — any failure leaves the row exactly as uploaded,
   * matching the fire-and-forget pattern used elsewhere in this pipeline.
   */
  async finishImageSanity(mediaId: string, tenantId: string, reasons: string[]): Promise<void> {
    const [row] = await this.db
      .select()
      .from(productMedia)
      .where(and(eq(productMedia.id, mediaId), eq(productMedia.tenantId, tenantId)));
    if (!row || row.autoFixed || row.sanityVerdict || !row.productId) return;
    const productId = row.productId;

    const allowedBase = this.storage.getPublicBaseUrl();
    if (!isAllowedImageUrl(row.url, allowedBase)) return;

    let original: Buffer;
    try {
      const res = await fetch(row.url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!res.ok) return;
      original = Buffer.from(await res.arrayBuffer());
    } catch {
      return;
    }

    let dataUri: string;
    try {
      const preview = await sharp(original, { failOn: 'none' })
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer();
      dataUri = `data:image/jpeg;base64,${preview.toString('base64')}`;
    } catch {
      return;
    }

    const verdict = await this.sanityVision.judge(dataUri, reasons);
    if (!verdict) return;

    if (verdict.verdict === 'unusable') {
      await this.db
        .update(productMedia)
        .set({ sanityVerdict: 'unusable', sanityReason: verdict.reason })
        .where(eq(productMedia.id, mediaId));
      return;
    }

    try {
      const meta = await sharp(original, { failOn: 'none' }).metadata();
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      let working = sharp(original, { failOn: 'none' });
      if (verdict.cropBox && w > 0 && h > 0) {
        const left = Math.min(Math.max(Math.round(verdict.cropBox.x * w), 0), w - 1);
        const top = Math.min(Math.max(Math.round(verdict.cropBox.y * h), 0), h - 1);
        const width = Math.min(Math.max(Math.round(verdict.cropBox.width * w), 1), w - left);
        const height = Math.min(Math.max(Math.round(verdict.cropBox.height * h), 1), h - top);
        if (width >= 50 && height >= 50) working = working.extract({ left, top, width, height });
      }
      if (verdict.rotate) working = working.rotate(verdict.rotate);
      const fixed = await working.webp({ quality: 90 }).toBuffer();

      const slug = await tenantSlug(this.db, tenantId);
      const key = `tenants/${slug}/products/${productId}/${randomUUID()}.webp`;
      const { url } = await this.storage.upload(fixed, key, 'image/webp');

      await this.db
        .update(productMedia)
        .set({ originalUrl: row.url, url, autoFixed: true, sanityVerdict: 'ok', sanityReason: verdict.reason })
        .where(eq(productMedia.id, mediaId));
      await this.syncCover(productId, tenantId);
      await this.cache.invalidate(tenantId);
    } catch {
      // Fix failed to apply — leave the row exactly as uploaded, never worse.
    }
  }

  /** Undo an image-sanity auto-fix: point the gallery item back at the
   *  pre-fix upload ("върни оригинала") and clear the worker's fields so it
   *  reads as never-touched. The fixed derivative in R2 is left in place
   *  (best-effort cleanup, not worth failing the revert over). No-op (not an
   *  error) if the item was never auto-fixed. */
  async revertMediaOriginal(
    id: string,
    mediaId: string,
    tenantId: string,
    farmerScope: string | null = null,
  ): Promise<{ id: string }> {
    await this.findOne(id, tenantId, farmerScope);

    const [m] = await this.db
      .select()
      .from(productMedia)
      .where(and(eq(productMedia.id, mediaId), eq(productMedia.productId, id), eq(productMedia.tenantId, tenantId)))
      .limit(1);
    if (!m) throw new NotFoundException('Снимката не е намерена');
    if (!m.autoFixed || !m.originalUrl) return { id: mediaId };

    const fixedUrl = m.url;
    await this.db
      .update(productMedia)
      .set({ url: m.originalUrl, originalUrl: null, autoFixed: false, sanityVerdict: null, sanityReason: null })
      .where(eq(productMedia.id, mediaId));
    await this.deleteObject(fixedUrl);
    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);
    return { id: mediaId };
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

    // One UPDATE … CASE … END instead of a statement per row.
    if (dto.items.length) {
      await this.db
        .update(productMedia)
        .set({ position: positionCase(productMedia.id, productMedia.position, dto.items) })
        .where(
          and(
            inArray(productMedia.id, dto.items.map((i) => i.id)),
            eq(productMedia.productId, id),
            eq(productMedia.tenantId, tenantId),
          ),
        );
    }
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
    const coverCrop = newUrl
      ? await smartFocalFromUrl(newUrl, this.storage.getPublicBaseUrl())
      : null;
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

  /** Live (non-deleted) variants for a set of products, grouped by productId,
   *  ordered by position. */
  private async variantsByProduct(productIds: string[]): Promise<Map<string, ProductVariant[]>> {
    const map = new Map<string, ProductVariant[]>();
    if (!productIds.length) return map;
    const rows = await this.db
      .select()
      .from(productVariants)
      .where(and(inArray(productVariants.productId, productIds), isNull(productVariants.deletedAt)))
      .orderBy(asc(productVariants.position), asc(productVariants.id));
    for (const r of rows) {
      const list = map.get(r.productId) ?? [];
      list.push(r);
      map.set(r.productId, list);
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
      .where(and(
        eq(products.tenantId, tenant.id),
        eq(products.isActive, true),
        eq(products.needsReview, false),
      ))
      .orderBy(asc(products.position), asc(products.createdAt), asc(products.id));

    const ids = rows.map((r) => r.id);
    // Independent batch loads — run concurrently on the cold-cache catalog build.
    const [mediaByProduct, varsByProduct] = await Promise.all([
      this.mediaUrlsByProduct(ids),
      this.variantsByProduct(ids),
    ]);
    const now = new Date();
    const result = rows.map((p) =>
      buildPublicProduct(p, mediaByProduct.get(p.id) ?? [], varsByProduct.get(p.id) ?? [], now),
    );

    // Attach resolved member products to bundle products (task #1). One query for
    // every bundle in the catalog; members are looked up in-memory against the
    // already-built public products, so an inactive / needs-review member simply
    // doesn't appear (no N+1, no private-field leak). Bundles with no live members
    // get an empty array (the storefront can then hide the „съдържание" block).
    const bundleIds = result.filter((p) => p.category === 'bundle').map((p) => p.id);
    if (bundleIds.length) {
      const links = await this.db
        .select({
          bundleId: productBundleItems.bundleId,
          productId: productBundleItems.productId,
          quantity: productBundleItems.quantity,
        })
        .from(productBundleItems)
        .where(inArray(productBundleItems.bundleId, bundleIds))
        .orderBy(asc(productBundleItems.position), asc(productBundleItems.productId));
      const publicById = new Map(result.map((p) => [p.id, p]));
      const membersByBundle = new Map<string, PublicBundleItem[]>();
      for (const l of links) {
        const member = publicById.get(l.productId);
        if (!member) continue; // inactive / hidden / needs-review member — skip
        const list = membersByBundle.get(l.bundleId) ?? [];
        list.push({
          productId: member.id,
          name: member.name,
          slug: member.slug,
          image: member.images[0] ?? null,
          quantity: l.quantity,
          priceStotinki: member.salePriceStotinki ?? member.priceStotinki,
        });
        membersByBundle.set(l.bundleId, list);
      }
      for (const p of result) {
        if (p.category === 'bundle') p.bundleProducts = membersByBundle.get(p.id) ?? [];
      }
    }

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

  /** Null out promos whose end date has passed so they disappear from the admin
   *  UI. Pricing already ignores them (date check), so this is tidiness only.
   *  Returns the number of products cleared. */
  async expirePromotions(now: Date = new Date()): Promise<number> {
    const rows = await this.db
      .update(products)
      .set({ salePercent: null, saleEndsAt: null })
      .where(and(isNotNull(products.saleEndsAt), lt(products.saleEndsAt, now)))
      .returning({ id: products.id, tenantId: products.tenantId });
    // The cached public catalog bakes the promo price in at build time (see
    // findPublicBySlug's `now`), so a warm cache built before this expiry keeps
    // showing the sale price — while intake reprices live and charges full price —
    // until the catalog TTL elapses. Bust every affected tenant's catalog.
    const tenantIds = new Set(rows.map((r) => r.tenantId).filter((id): id is string => id != null));
    await Promise.all([...tenantIds].map((id) => this.cache.invalidate(id)));
    return rows.length;
  }
}

/** Cheapest variant price (for products.priceStotinki sync + "от X"), or null. */
export function cheapestVariantPrice(variants: { priceStotinki: number }[]): number | null {
  if (!variants.length) return null;
  return variants.reduce((min, v) => (v.priceStotinki < min ? v.priceStotinki : min), variants[0].priceStotinki);
}

export interface VariantInput {
  id?: string;
  label: string;
  priceStotinki: number;
  salePriceStotinki?: number | null;
  stockQuantity?: number | null;
}

/** True when any incoming variant carries a fixed promo price. Used to enforce the
 *  product-%-vs-per-variant-fixed mutual exclusion at write time. */
export function variantsHaveFixedSale(variants: VariantInput[] | undefined): boolean {
  return Array.isArray(variants) && variants.some((v) => v.salePriceStotinki != null);
}

/** Enforce the promo mutual-exclusion at write time and return the columns to
 *  override on the products row:
 *   - Varianted product → never a product-level fixed price (cleared); a per-variant
 *     fixed price additionally clears the product %.
 *   - Plain product → a product-level fixed price clears the % (and must be a real
 *     discount, below the price).
 *  Throws BadRequest when the fixed price isn't below the regular price. */
export function resolvePromoOverride(
  promo: { salePercent?: number | null; salePriceStotinki?: number | null },
  variants: VariantInput[] | undefined,
  priceStotinki?: number,
): { salePercent?: null; saleEndsAt?: null; salePriceStotinki?: null } {
  if (Array.isArray(variants) && variants.length > 0) {
    return {
      salePriceStotinki: null,
      ...(variantsHaveFixedSale(variants) ? { salePercent: null, saleEndsAt: null } : {}),
    };
  }
  const fixed = promo.salePriceStotinki ?? null;
  if (fixed != null) {
    if (priceStotinki != null && fixed >= priceStotinki) {
      throw new BadRequestException('Промо цената трябва да е под редовната цена');
    }
    return { salePercent: null, saleEndsAt: null };
  }
  return {};
}

/** Diff incoming variants against the product's existing variant ids. `position`
 *  is the array index (the order the farmer arranged them). Rows with an id →
 *  updates; without → inserts; existing ids absent from the incoming list →
 *  soft-delete. */
export function planVariantWrites(incoming: VariantInput[], existingIds: string[]) {
  type Write = { label: string; priceStotinki: number; salePriceStotinki?: number | null; stockQuantity?: number | null; position: number };
  const inserts: Write[] = [];
  const updates: (Write & { id: string })[] = [];
  const keptIds = new Set<string>();
  incoming.forEach((v, position) => {
    const fields: Write = {
      label: v.label,
      priceStotinki: v.priceStotinki,
      position,
      // Always carry the promo price so a mode switch (% ↔ fixed) is written
      // deterministically — `null` clears a previously-set fixed promo.
      ...(v.salePriceStotinki !== undefined ? { salePriceStotinki: v.salePriceStotinki } : {}),
      ...(v.stockQuantity !== undefined ? { stockQuantity: v.stockQuantity } : {}),
    };
    if (v.id) {
      keptIds.add(v.id);
      updates.push({ id: v.id, ...fields });
    } else {
      inserts.push(fields);
    }
  });
  const deleteIds = existingIds.filter((id) => !keptIds.has(id));
  return { inserts, updates, deleteIds };
}

/** Map a product row (+ its media + live variants) to the public storefront shape,
 *  applying the active promo to the base price and every variant. */
export function buildPublicProduct(
  p: Product,
  mediaUrls: string[],
  variants: ProductVariant[],
  now: Date,
): PublicProduct {
  // Strip the raw fixed-price input column; the public shape carries only the
  // computed `salePriceStotinki` headline (set below).
  const { tenantId, stockQuantity, stripeProductId, stripePriceId, salePriceStotinki: _rawSalePrice, ...rest } = p;
  const images = mediaUrls.length ? mediaUrls : p.imageUrl ? [p.imageUrl] : [];
  const promo = isPromoActive(p.salePercent, p.saleEndsAt, now) && p.salePercent != null;
  const pub: PublicProduct = {
    ...rest,
    images,
    // Positive courier-shippability alias for clear storefront display (task #11):
    // true = may go on an Econt/Speedy waybill; false = pickup/local only. Single
    // source of truth is `courierDisabled` — no separate column to drift out of sync.
    courierShippable: !p.courierDisabled,
    variants: variants.map((v): PublicProductVariant => {
      // A variant's own fixed promo price wins; otherwise the active product-level
      // % applies. (Writes keep these mutually exclusive, so only one ever fires.)
      const sale =
        v.salePriceStotinki != null
          ? v.salePriceStotinki
          : promo
            ? salePriceStotinki(v.priceStotinki, p.salePercent!)
            : undefined;
      return {
        id: v.id,
        label: v.label,
        priceStotinki: v.priceStotinki,
        ...(sale != null ? { salePriceStotinki: sale } : {}),
        soldOut: v.stockQuantity === 0,
      };
    }),
  };
  // Headline sale price for the base product: a product-level fixed price wins;
  // otherwise the active % applies. (Writes keep these mutually exclusive.)
  const baseSale =
    p.salePriceStotinki != null ? p.salePriceStotinki : promo ? salePriceStotinki(p.priceStotinki, p.salePercent!) : undefined;
  if (baseSale != null) pub.salePriceStotinki = baseSale;
  return pub;
}
