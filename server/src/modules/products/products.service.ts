import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { type Database, products, productMedia, tenants } from '@farmflow/db';
import type { Product, ProductMedia, PublicProduct } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { StorageService } from '../storage/storage.service';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { ReorderMediaDto } from '../../common/dto/reorder-media.dto';
import { slugify } from '../articles/articles.util';
import { PRODUCT_IMAGE_EXT_BY_MIME } from '../storage/dto/upload-image.dto';

@Injectable()
export class ProductsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly cache: CatalogCacheService,
  ) {}

  /** All products for the tenant (active + inactive), newest first. */
  findAll(tenantId: string): Promise<Product[]> {
    return this.db
      .select()
      .from(products)
      .where(eq(products.tenantId, tenantId))
      .orderBy(products.createdAt);
  }

  async findOne(id: string, tenantId: string): Promise<Product> {
    const [row] = await this.db
      .select()
      .from(products)
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new NotFoundException('Продуктът не е намерен');
    return row;
  }

  async create(tenantId: string, dto: CreateProductDto): Promise<Product> {
    // Storefront product pages key off `slug`. The admin form doesn't collect
    // one, so derive a tenant-unique slug from the name (Cyrillic-aware).
    const slug = await this.uniqueSlug(tenantId, slugify(dto.name) || 'produkt');
    const [row] = await this.db
      .insert(products)
      .values({ ...dto, tenantId, slug })
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

  async update(id: string, tenantId: string, dto: UpdateProductDto): Promise<Product> {
    const [row] = await this.db
      .update(products)
      .set({ ...dto })
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Продуктът не е намерен');
    await this.cache.invalidate(tenantId);
    return row;
  }

  /** Soft delete via is_active=false. The image + gallery are kept intact so
   *  re-activating the product restores its photos — the cover object is now owned
   *  by the gallery, so dropping it here would orphan/corrupt the media rows. */
  async remove(id: string, tenantId: string): Promise<{ id: string }> {
    await this.findOne(id, tenantId);

    await this.db
      .update(products)
      .set({ isActive: false })
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId)));

    await this.cache.invalidate(tenantId);
    return { id };
  }

  async uploadImage(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<Product> {
    const product = await this.findOne(id, tenantId);

    const ext = PRODUCT_IMAGE_EXT_BY_MIME[file.mimetype] ?? 'bin';
    const key = `tenants/${tenantId}/products/${id}/${randomUUID()}.${ext}`;
    const { url } = await this.storage.upload(file.buffer, key, file.mimetype);

    // Replace: drop the previous object once the new one is stored.
    if (product.imageUrl) await this.deleteObject(product.imageUrl);

    const [row] = await this.db
      .update(products)
      .set({ imageUrl: url })
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId)))
      .returning();

    await this.cache.invalidate(tenantId);
    return row;
  }

  // ---- Gallery (multi-image) ----

  /** Ordered gallery for a product (admin). 404 if missing / cross-tenant. */
  async listMedia(id: string, tenantId: string): Promise<ProductMedia[]> {
    await this.findOne(id, tenantId);
    return this.db
      .select()
      .from(productMedia)
      .where(eq(productMedia.productId, id))
      .orderBy(asc(productMedia.position));
  }

  /** Append an uploaded photo to the gallery; keeps `imageUrl` synced to the cover. */
  async addMedia(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<ProductMedia> {
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

    const ext = PRODUCT_IMAGE_EXT_BY_MIME[file.mimetype] ?? 'bin';
    const key = `tenants/${tenantId}/products/${id}/${randomUUID()}.${ext}`;
    const { url } = await this.storage.upload(file.buffer, key, file.mimetype);

    const [row] = await this.db
      .insert(productMedia)
      .values({ productId: id, tenantId, url, position: existing.length })
      .returning();

    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);
    return row;
  }

  /** Remove one gallery photo (DB row + R2 object), then re-sync the cover. */
  async removeMedia(
    id: string,
    mediaId: string,
    tenantId: string,
  ): Promise<{ id: string }> {
    await this.findOne(id, tenantId);

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
  ): Promise<ProductMedia[]> {
    await this.findOne(id, tenantId);

    for (const it of dto.items) {
      await this.db
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
    const [first] = await this.db
      .select({ url: productMedia.url })
      .from(productMedia)
      .where(eq(productMedia.productId, id))
      .orderBy(asc(productMedia.position))
      .limit(1);
    await this.db
      .update(products)
      .set({ imageUrl: first?.url ?? null })
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
    const [tenant] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    if (!tenant) throw new NotFoundException('Фермата не е намерена');

    const cached = (await this.cache.get(tenant.id)) as PublicProduct[] | null;
    if (cached) return cached;

    const rows = await this.db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenant.id), eq(products.isActive, true)))
      .orderBy(products.createdAt);

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
