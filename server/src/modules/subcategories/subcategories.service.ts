import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, eq, asc, inArray } from 'drizzle-orm';
import { type Database, subcategories, subcategoryMedia } from '@farmflow/db';
import type { Subcategory, SubcategoryMedia, PublicSubcategory } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CreateSubcategoryDto } from './dto/create-subcategory.dto';
import { UpdateSubcategoryDto } from './dto/update-subcategory.dto';
import { StorageService } from '../storage/storage.service';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { PublicCacheService, publicCacheKeys } from '../../common/cache/public-cache.service';
import { ReorderMediaDto } from '../../common/dto/reorder-media.dto';
import { PRODUCT_IMAGE_EXT_BY_MIME } from '../storage/dto/upload-image.dto';

@Injectable()
export class SubcategoriesService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly cache: CatalogCacheService,
    private readonly publicCache: PublicCacheService,
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
    await this.publicCache.del(publicCacheKeys.subcategories(tenantId));
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
    await this.publicCache.del(publicCacheKeys.subcategories(tenantId));
    return row;
  }

  /** Hard delete; products.subcategory_id FK is ON DELETE SET NULL, so products unlink.
   *  Gallery rows drop via FK cascade; their R2 objects are purged here first. */
  async remove(id: string, tenantId: string): Promise<{ id: string }> {
    const subcat = await this.findOne(id, tenantId);
    const media = await this.db
      .select({ url: subcategoryMedia.url })
      .from(subcategoryMedia)
      .where(eq(subcategoryMedia.subcategoryId, id));
    for (const m of media) await this.deleteObject(m.url);
    if (subcat.imageUrl) await this.deleteObject(subcat.imageUrl);
    await this.db
      .delete(subcategories)
      .where(and(eq(subcategories.id, id), eq(subcategories.tenantId, tenantId)));
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.subcategories(tenantId));
    return { id };
  }

  async uploadImage(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<Subcategory> {
    const subcat = await this.findOne(id, tenantId);
    const ext = PRODUCT_IMAGE_EXT_BY_MIME[file.mimetype] ?? 'bin';
    const key = `tenants/${tenantId}/subcategories/${id}/${randomUUID()}.${ext}`;
    const { url } = await this.storage.upload(file.buffer, key, file.mimetype);
    if (subcat.imageUrl) await this.deleteObject(subcat.imageUrl);
    const [row] = await this.db
      .update(subcategories)
      .set({ imageUrl: url })
      .where(and(eq(subcategories.id, id), eq(subcategories.tenantId, tenantId)))
      .returning();
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.subcategories(tenantId));
    return row;
  }

  // ---- Gallery (multi-image) ----

  /** Ordered gallery for a section (admin). 404 if missing / cross-tenant. */
  async listMedia(id: string, tenantId: string): Promise<SubcategoryMedia[]> {
    await this.findOne(id, tenantId);
    return this.db
      .select()
      .from(subcategoryMedia)
      .where(eq(subcategoryMedia.subcategoryId, id))
      .orderBy(asc(subcategoryMedia.position));
  }

  /** Append an uploaded photo to the gallery; keeps `imageUrl` synced to the cover. */
  async addMedia(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<SubcategoryMedia> {
    const subcat = await this.findOne(id, tenantId);

    const existing = await this.db
      .select()
      .from(subcategoryMedia)
      .where(eq(subcategoryMedia.subcategoryId, id))
      .orderBy(asc(subcategoryMedia.position));

    // Legacy item (cover set, no gallery yet): adopt the existing cover as photo 0.
    if (existing.length === 0 && subcat.imageUrl) {
      const [adopted] = await this.db
        .insert(subcategoryMedia)
        .values({ subcategoryId: id, tenantId, url: subcat.imageUrl, position: 0 })
        .returning();
      existing.push(adopted);
    }

    const ext = PRODUCT_IMAGE_EXT_BY_MIME[file.mimetype] ?? 'bin';
    const key = `tenants/${tenantId}/subcategories/${id}/${randomUUID()}.${ext}`;
    const { url } = await this.storage.upload(file.buffer, key, file.mimetype);

    const [row] = await this.db
      .insert(subcategoryMedia)
      .values({ subcategoryId: id, tenantId, url, position: existing.length })
      .returning();

    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.subcategories(tenantId));
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
      .from(subcategoryMedia)
      .where(
        and(
          eq(subcategoryMedia.id, mediaId),
          eq(subcategoryMedia.subcategoryId, id),
          eq(subcategoryMedia.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!m) throw new NotFoundException('Снимката не е намерена');

    await this.deleteObject(m.url);
    await this.db.delete(subcategoryMedia).where(eq(subcategoryMedia.id, mediaId));
    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.subcategories(tenantId));
    return { id: mediaId };
  }

  /** Persist a new gallery order; cover follows whichever photo is now position 0. */
  async reorderMedia(
    id: string,
    tenantId: string,
    dto: ReorderMediaDto,
  ): Promise<SubcategoryMedia[]> {
    await this.findOne(id, tenantId);

    for (const it of dto.items) {
      await this.db
        .update(subcategoryMedia)
        .set({ position: it.position })
        .where(
          and(
            eq(subcategoryMedia.id, it.id),
            eq(subcategoryMedia.subcategoryId, id),
            eq(subcategoryMedia.tenantId, tenantId),
          ),
        );
    }
    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.subcategories(tenantId));

    return this.db
      .select()
      .from(subcategoryMedia)
      .where(eq(subcategoryMedia.subcategoryId, id))
      .orderBy(asc(subcategoryMedia.position));
  }

  /** Mirror the first gallery photo into `subcategories.imageUrl` as the cover;
   *  NULLs it when the gallery is empty. */
  private async syncCover(id: string, tenantId: string): Promise<void> {
    const [first] = await this.db
      .select({ url: subcategoryMedia.url })
      .from(subcategoryMedia)
      .where(eq(subcategoryMedia.subcategoryId, id))
      .orderBy(asc(subcategoryMedia.position))
      .limit(1);
    await this.db
      .update(subcategories)
      .set({ imageUrl: first?.url ?? null })
      .where(and(eq(subcategories.id, id), eq(subcategories.tenantId, tenantId)));
  }

  /** Gallery photo URLs (ordered) for a set of sections — single query, no N+1. */
  private async mediaUrlsBySubcategory(ids: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (!ids.length) return map;
    const rows = await this.db
      .select({ subcategoryId: subcategoryMedia.subcategoryId, url: subcategoryMedia.url })
      .from(subcategoryMedia)
      .where(inArray(subcategoryMedia.subcategoryId, ids))
      .orderBy(asc(subcategoryMedia.position));
    for (const r of rows) {
      const list = map.get(r.subcategoryId!) ?? [];
      list.push(r.url);
      map.set(r.subcategoryId!, list);
    }
    return map;
  }

  /** Public sections for a storefront slug — [] unless the tenant has multiSubcat on. */
  async findPublicBySlug(slug: string): Promise<PublicSubcategory[]> {
    const tenant = await this.publicCache.resolveTenant(this.db, slug);
    if (!tenant.multiSubcat) return [];

    const key = publicCacheKeys.subcategories(tenant.id);
    const cached = await this.publicCache.get<PublicSubcategory[]>(key);
    if (cached) return cached;

    const rows = await this.db
      .select()
      .from(subcategories)
      .where(eq(subcategories.tenantId, tenant.id))
      .orderBy(asc(subcategories.position), asc(subcategories.createdAt));
    const mediaBySubcat = await this.mediaUrlsBySubcategory(rows.map((r) => r.id));
    const result: PublicSubcategory[] = rows.map(({ tenantId: _tenantId, ...rest }) => {
      const urls = mediaBySubcat.get(rest.id) ?? [];
      const images = urls.length ? urls : rest.imageUrl ? [rest.imageUrl] : [];
      return { ...rest, images };
    });
    await this.publicCache.set(key, result);
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
