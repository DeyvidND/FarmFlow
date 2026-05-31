import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { type Database, products, tenants } from '@farmflow/db';
import type { Product, PublicProduct } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { StorageService } from '../storage/storage.service';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
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
    const [row] = await this.db
      .insert(products)
      .values({ ...dto, tenantId })
      .returning();
    await this.cache.invalidate(tenantId);
    return row;
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

  /** Soft delete via is_active=false; also cleans up the stored image. */
  async remove(id: string, tenantId: string): Promise<{ id: string }> {
    const product = await this.findOne(id, tenantId);

    if (product.imageUrl) await this.deleteObject(product.imageUrl);

    await this.db
      .update(products)
      .set({ isActive: false, imageUrl: null })
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
    const key = `tenants/${tenantId}/products/${randomUUID()}.${ext}`;
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

    const result = rows.map(toPublicProduct);
    await this.cache.set(tenant.id, result, 300);
    return result;
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

/** Strip tenant + stock before exposing a product publicly. */
function toPublicProduct(p: Product): PublicProduct {
  const { tenantId, stockQuantity, ...rest } = p;
  return rest;
}
