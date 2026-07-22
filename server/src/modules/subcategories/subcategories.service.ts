import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { and, eq, asc, inArray } from 'drizzle-orm';
import { type Database, subcategories, subcategoryMedia } from '@fermeribg/db';
import type { Subcategory, SubcategoryMedia, PublicSubcategory } from '@fermeribg/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { IMAGE_QUEUE } from '../../common/queue/queue.constants';
import { encodeImageJob } from '../../common/queue/image-job';
import { positionCase } from '../../common/db/reorder.util';
import { CreateSubcategoryDto } from './dto/create-subcategory.dto';
import { UpdateSubcategoryDto } from './dto/update-subcategory.dto';
import { StorageService } from '../storage/storage.service';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { PublicCacheService, publicCacheKeys } from '../../common/cache/public-cache.service';
import { ReorderMediaDto } from '../../common/dto/reorder-media.dto';
import { ReorderDto } from '../../common/dto/reorder.dto';
import { PRODUCT_IMAGE_EXT_BY_MIME } from '../storage/dto/upload-image.dto';
import { optimizeImage } from '../storage/image.util';
import { smartFocal, smartFocalFromUrl } from '../storage/smart-crop.util';
import { tenantSlug } from '../../common/tenant-slug.util';

@Injectable()
export class SubcategoriesService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly cache: CatalogCacheService,
    private readonly publicCache: PublicCacheService,
    @InjectQueue(IMAGE_QUEUE) private readonly imageQueue: Queue,
  ) {}

  /** All subcategories for the tenant, ordered by display position then age. */
  findAll(tenantId: string): Promise<Subcategory[]> {
    return this.db
      .select()
      .from(subcategories)
      .where(eq(subcategories.tenantId, tenantId))
      .orderBy(asc(subcategories.position), asc(subcategories.createdAt));
  }

  /** Persist a new display order for the tenant's subcategories. Tenant-scoped,
   *  one transaction; busts the catalog + public subcategories caches. */
  async reorder(tenantId: string, dto: ReorderDto): Promise<{ ok: true }> {
    if (dto.items.length) {
      await this.db
        .update(subcategories)
        .set({ position: positionCase(subcategories.id, subcategories.position, dto.items) })
        .where(and(inArray(subcategories.id, dto.items.map((i) => i.id)), eq(subcategories.tenantId, tenantId)));
    }
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.subcategories(tenantId));
    return { ok: true };
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
    // Resolve the tenant slug once (instead of once per deleted object) — only when
    // there's actually something to purge, so a subcategory with no cover/gallery
    // never pays for the extra SELECT.
    let slug: string | undefined;
    if (media.length || subcat.imageUrl) {
      try {
        slug = await tenantSlug(this.db, tenantId);
      } catch {
        // best-effort: R2 purge skipped, DB delete proceeds
      }
    }
    await Promise.all(media.map((m) => this.deleteObject(m.url, tenantId, slug)));
    if (subcat.imageUrl) await this.deleteObject(subcat.imageUrl, tenantId, slug);
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
  ): Promise<Subcategory & { imageProcessing: boolean }> {
    const subcat = await this.findOne(id, tenantId);
    await this.imageQueue.add('process', encodeImageJob('subcategory-cover', id, tenantId, file));
    return { ...subcat, imageProcessing: true };
  }

  /** Called by the image worker after it has decoded and optimized the bytes. */
  async finishSubcategoryCover(
    id: string,
    tenantId: string,
    buffer: Buffer,
    mime: string,
  ): Promise<void> {
    const subcat = await this.findOne(id, tenantId);
    const img = await optimizeImage(
      buffer,
      mime,
      PRODUCT_IMAGE_EXT_BY_MIME[mime] ?? 'bin',
    );
    const slug = await tenantSlug(this.db, tenantId);
    const key = `tenants/${slug}/subcategories/${id}/${randomUUID()}.${img.ext}`;
    const { url } = await this.storage.upload(img.buffer, key, img.contentType);
    if (subcat.imageUrl) await this.deleteObject(subcat.imageUrl, tenantId, slug);
    await this.db
      .update(subcategories)
      .set({ imageUrl: url, coverCrop: await smartFocal(img.buffer) })
      .where(and(eq(subcategories.id, id), eq(subcategories.tenantId, tenantId)))
      .returning();
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.subcategories(tenantId));
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

  /** Append an uploaded photo to the gallery (async path): validates ownership
   *  then enqueues the heavy optimize+upload work; returns immediately so the
   *  HTTP response is fast. The worker calls `finishSubcategoryMedia` once done. */
  async addMedia(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<{ imageProcessing: boolean }> {
    await this.findOne(id, tenantId);
    await this.imageQueue.add('process', encodeImageJob('subcategory-media', id, tenantId, file));
    return { imageProcessing: true };
  }

  /** Worker finisher: runs the full synchronous optimize → upload → insert → syncCover
   *  pipeline for a gallery photo after the queue has decoded the raw bytes. */
  async finishSubcategoryMedia(
    id: string,
    tenantId: string,
    buffer: Buffer,
    mime: string,
  ): Promise<void> {
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

    const img = await optimizeImage(
      buffer,
      mime,
      PRODUCT_IMAGE_EXT_BY_MIME[mime] ?? 'bin',
    );
    const slug = await tenantSlug(this.db, tenantId);
    const key = `tenants/${slug}/subcategories/${id}/${randomUUID()}.${img.ext}`;
    const { url } = await this.storage.upload(img.buffer, key, img.contentType);

    await this.db
      .insert(subcategoryMedia)
      .values({ subcategoryId: id, tenantId, url, position: existing.length })
      .returning();

    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.subcategories(tenantId));
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

    await this.deleteObject(m.url, tenantId);
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

    // One UPDATE … CASE … END instead of a statement per row.
    if (dto.items.length) {
      await this.db
        .update(subcategoryMedia)
        .set({ position: positionCase(subcategoryMedia.id, subcategoryMedia.position, dto.items) })
        .where(
          and(
            inArray(subcategoryMedia.id, dto.items.map((i) => i.id)),
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
    // Two independent reads (gallery cover + current cover) — run them together.
    const [[first], [cur]] = await Promise.all([
      this.db
        .select({ url: subcategoryMedia.url })
        .from(subcategoryMedia)
        .where(eq(subcategoryMedia.subcategoryId, id))
        .orderBy(asc(subcategoryMedia.position))
        .limit(1),
      this.db
        .select({ imageUrl: subcategories.imageUrl })
        .from(subcategories)
        .where(and(eq(subcategories.id, id), eq(subcategories.tenantId, tenantId)))
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
      .update(subcategories)
      .set({ imageUrl: newUrl, coverCrop })
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

  /** Best-effort removal of a stored object given its public URL.
   *  SECURITY: `imageUrl` (and the media URL seeded from it) is a client-settable
   *  DTO field, so a stored URL may point at ANOTHER tenant's object. Only ever
   *  delete objects under this tenant's own `tenants/<slug>/` key prefix — never
   *  trust the raw key. Every uploaded object for this entity lives under that
   *  prefix, so legitimate cleanups are unaffected. */
  private async deleteObject(url: string, tenantId: string, slug?: string): Promise<void> {
    try {
      const key = new URL(url).pathname.replace(/^\/+/, '');
      if (!key) return;
      const s = slug ?? await tenantSlug(this.db, tenantId);
      if (!key.startsWith(`tenants/${s}/`)) return;
      await this.storage.delete(key);
    } catch {
      // a storage hiccup (or a missing/foreign tenant) must not block the DB write
    }
  }
}
