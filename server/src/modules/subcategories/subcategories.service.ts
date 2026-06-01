import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, eq, asc } from 'drizzle-orm';
import { type Database, subcategories, tenants } from '@farmflow/db';
import type { Subcategory, PublicSubcategory } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CreateSubcategoryDto } from './dto/create-subcategory.dto';
import { UpdateSubcategoryDto } from './dto/update-subcategory.dto';
import { StorageService } from '../storage/storage.service';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { PRODUCT_IMAGE_EXT_BY_MIME } from '../storage/dto/upload-image.dto';

@Injectable()
export class SubcategoriesService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly cache: CatalogCacheService,
  ) {}

  /** All subcategories for the tenant, ordered by display position then age. */
  findAll(tenantId: string): Promise<Subcategory[]> {
    return this.db
      .select()
      .from(subcategories)
      .where(eq(subcategories.tenantId, tenantId))
      .orderBy(asc(subcategories.position), asc(subcategories.createdAt));
  }

  async findOne(id: string, tenantId: string): Promise<Subcategory> {
    const [row] = await this.db
      .select()
      .from(subcategories)
      .where(and(eq(subcategories.id, id), eq(subcategories.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new NotFoundException('Категорията не е намерена');
    return row;
  }

  async create(tenantId: string, dto: CreateSubcategoryDto): Promise<Subcategory> {
    const [row] = await this.db
      .insert(subcategories)
      .values({ ...dto, tenantId })
      .returning();
    await this.cache.invalidate(tenantId);
    return row;
  }

  async update(
    id: string,
    tenantId: string,
    dto: UpdateSubcategoryDto,
  ): Promise<Subcategory> {
    const [row] = await this.db
      .update(subcategories)
      .set({ ...dto })
      .where(and(eq(subcategories.id, id), eq(subcategories.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Категорията не е намерена');
    await this.cache.invalidate(tenantId);
    return row;
  }

  /** Hard delete; products.subcategory_id FK is ON DELETE SET NULL, so products unlink. */
  async remove(id: string, tenantId: string): Promise<{ id: string }> {
    const subcat = await this.findOne(id, tenantId);
    if (subcat.imageUrl) await this.deleteObject(subcat.imageUrl);
    await this.db
      .delete(subcategories)
      .where(and(eq(subcategories.id, id), eq(subcategories.tenantId, tenantId)));
    await this.cache.invalidate(tenantId);
    return { id };
  }

  async uploadImage(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<Subcategory> {
    const subcat = await this.findOne(id, tenantId);
    const ext = PRODUCT_IMAGE_EXT_BY_MIME[file.mimetype] ?? 'bin';
    const key = `tenants/${tenantId}/subcategories/${randomUUID()}.${ext}`;
    const { url } = await this.storage.upload(file.buffer, key, file.mimetype);
    if (subcat.imageUrl) await this.deleteObject(subcat.imageUrl);
    const [row] = await this.db
      .update(subcategories)
      .set({ imageUrl: url })
      .where(and(eq(subcategories.id, id), eq(subcategories.tenantId, tenantId)))
      .returning();
    await this.cache.invalidate(tenantId);
    return row;
  }

  /** Public sections for a storefront slug — [] unless the tenant has multiSubcat on. */
  async findPublicBySlug(slug: string): Promise<PublicSubcategory[]> {
    const [tenant] = await this.db
      .select({ id: tenants.id, multiSubcat: tenants.multiSubcat })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    if (!tenant) throw new NotFoundException('Фермата не е намерена');
    if (!tenant.multiSubcat) return [];
    const rows = await this.db
      .select()
      .from(subcategories)
      .where(eq(subcategories.tenantId, tenant.id))
      .orderBy(asc(subcategories.position), asc(subcategories.createdAt));
    return rows.map(({ tenantId: _tenantId, ...rest }) => rest);
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
