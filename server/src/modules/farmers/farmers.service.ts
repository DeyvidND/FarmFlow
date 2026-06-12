import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, eq, asc, inArray } from 'drizzle-orm';
import { type Database, farmers, farmerMedia } from '@farmflow/db';
import type { Farmer, FarmerMedia, PublicFarmer } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CreateFarmerDto } from './dto/create-farmer.dto';
import { UpdateFarmerDto } from './dto/update-farmer.dto';
import { StorageService } from '../storage/storage.service';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { PublicCacheService, publicCacheKeys } from '../../common/cache/public-cache.service';
import { ReorderMediaDto } from '../../common/dto/reorder-media.dto';
import { ReorderDto } from '../../common/dto/reorder.dto';
import { PRODUCT_IMAGE_EXT_BY_MIME } from '../storage/dto/upload-image.dto';
import { optimizeImage } from '../storage/image.util';
import { smartFocal, smartFocalFromUrl } from '../storage/smart-crop.util';

@Injectable()
export class FarmersService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly cache: CatalogCacheService,
    private readonly publicCache: PublicCacheService,
  ) {}

  /** All farmers for the tenant, ordered by display position then age. */
  findAll(tenantId: string): Promise<Farmer[]> {
    return this.db
      .select()
      .from(farmers)
      .where(eq(farmers.tenantId, tenantId))
      .orderBy(asc(farmers.position), asc(farmers.createdAt));
  }

  /** Persist a new display order for the tenant's farmers. Tenant-scoped, one
   *  transaction; busts the catalog + public farmers caches. */
  async reorder(tenantId: string, dto: ReorderDto): Promise<{ ok: true }> {
    await this.db.transaction(async (tx) => {
      for (const it of dto.items) {
        await tx
          .update(farmers)
          .set({ position: it.position })
          .where(and(eq(farmers.id, it.id), eq(farmers.tenantId, tenantId)));
      }
    });
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));
    return { ok: true };
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
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));
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
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));
    return row;
  }

  /** Hard delete; products.farmer_id FK is ON DELETE SET NULL, so products unlink.
   *  Gallery rows drop via FK cascade; their R2 objects are purged here first. */
  async remove(id: string, tenantId: string): Promise<{ id: string }> {
    const farmer = await this.findOne(id, tenantId);
    const media = await this.db
      .select({ url: farmerMedia.url })
      .from(farmerMedia)
      .where(eq(farmerMedia.farmerId, id));
    for (const m of media) await this.deleteObject(m.url);
    if (farmer.imageUrl) await this.deleteObject(farmer.imageUrl);
    await this.db
      .delete(farmers)
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)));
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));
    return { id };
  }

  async uploadImage(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<Farmer> {
    const farmer = await this.findOne(id, tenantId);
    const img = await optimizeImage(
      file.buffer,
      file.mimetype,
      PRODUCT_IMAGE_EXT_BY_MIME[file.mimetype] ?? 'bin',
    );
    const key = `tenants/${tenantId}/farmers/${id}/${randomUUID()}.${img.ext}`;
    const { url } = await this.storage.upload(img.buffer, key, img.contentType);
    if (farmer.imageUrl) await this.deleteObject(farmer.imageUrl);
    const [row] = await this.db
      .update(farmers)
      .set({ imageUrl: url, coverCrop: await smartFocal(img.buffer) })
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
      .returning();
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));
    return row;
  }

  // ---- Gallery (multi-image) ----

  /** Ordered gallery for a farmer (admin). 404 if missing / cross-tenant. */
  async listMedia(id: string, tenantId: string): Promise<FarmerMedia[]> {
    await this.findOne(id, tenantId);
    return this.db
      .select()
      .from(farmerMedia)
      .where(eq(farmerMedia.farmerId, id))
      .orderBy(asc(farmerMedia.position));
  }

  /** Append an uploaded photo to the gallery; keeps `imageUrl` synced to the cover. */
  async addMedia(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<FarmerMedia> {
    const farmer = await this.findOne(id, tenantId);

    const existing = await this.db
      .select()
      .from(farmerMedia)
      .where(eq(farmerMedia.farmerId, id))
      .orderBy(asc(farmerMedia.position));

    // Legacy item (cover set, no gallery yet): adopt the existing cover as photo 0.
    if (existing.length === 0 && farmer.imageUrl) {
      const [adopted] = await this.db
        .insert(farmerMedia)
        .values({ farmerId: id, tenantId, url: farmer.imageUrl, position: 0 })
        .returning();
      existing.push(adopted);
    }

    const img = await optimizeImage(
      file.buffer,
      file.mimetype,
      PRODUCT_IMAGE_EXT_BY_MIME[file.mimetype] ?? 'bin',
    );
    const key = `tenants/${tenantId}/farmers/${id}/${randomUUID()}.${img.ext}`;
    const { url } = await this.storage.upload(img.buffer, key, img.contentType);

    const [row] = await this.db
      .insert(farmerMedia)
      .values({ farmerId: id, tenantId, url, position: existing.length })
      .returning();

    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));
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
      .from(farmerMedia)
      .where(
        and(
          eq(farmerMedia.id, mediaId),
          eq(farmerMedia.farmerId, id),
          eq(farmerMedia.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!m) throw new NotFoundException('Снимката не е намерена');

    await this.deleteObject(m.url);
    await this.db.delete(farmerMedia).where(eq(farmerMedia.id, mediaId));
    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));
    return { id: mediaId };
  }

  /** Persist a new gallery order; cover follows whichever photo is now position 0. */
  async reorderMedia(
    id: string,
    tenantId: string,
    dto: ReorderMediaDto,
  ): Promise<FarmerMedia[]> {
    await this.findOne(id, tenantId);

    // One transaction so a mid-loop failure can't leave a half-applied order.
    await this.db.transaction(async (tx) => {
      for (const it of dto.items) {
        await tx
          .update(farmerMedia)
          .set({ position: it.position })
          .where(
            and(
              eq(farmerMedia.id, it.id),
              eq(farmerMedia.farmerId, id),
              eq(farmerMedia.tenantId, tenantId),
            ),
          );
      }
    });
    await this.syncCover(id, tenantId);
    await this.cache.invalidate(tenantId);
    await this.publicCache.del(publicCacheKeys.farmers(tenantId));

    return this.db
      .select()
      .from(farmerMedia)
      .where(eq(farmerMedia.farmerId, id))
      .orderBy(asc(farmerMedia.position));
  }

  /** Mirror the first gallery photo into `farmers.imageUrl` as the cover; NULLs it
   *  when the gallery is empty. */
  private async syncCover(id: string, tenantId: string): Promise<void> {
    const [first] = await this.db
      .select({ url: farmerMedia.url })
      .from(farmerMedia)
      .where(eq(farmerMedia.farmerId, id))
      .orderBy(asc(farmerMedia.position))
      .limit(1);
    const newUrl = first?.url ?? null;
    const [cur] = await this.db
      .select({ imageUrl: farmers.imageUrl })
      .from(farmers)
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
      .limit(1);
    // Cover image unchanged → keep whatever framing is set (incl. a manual override).
    if (cur?.imageUrl === newUrl) return;
    // New cover → recompute a content-aware focal default (the old framing belonged
    // to the previous image; the cover editor also resets it on a cover change).
    const coverCrop = newUrl ? await smartFocalFromUrl(newUrl) : null;
    await this.db
      .update(farmers)
      .set({ imageUrl: newUrl, coverCrop })
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)));
  }

  /** Gallery photo URLs (ordered) for a set of farmers — single query, no N+1. */
  private async mediaUrlsByFarmer(ids: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (!ids.length) return map;
    const rows = await this.db
      .select({ farmerId: farmerMedia.farmerId, url: farmerMedia.url })
      .from(farmerMedia)
      .where(inArray(farmerMedia.farmerId, ids))
      .orderBy(asc(farmerMedia.position));
    for (const r of rows) {
      const list = map.get(r.farmerId!) ?? [];
      list.push(r.url);
      map.set(r.farmerId!, list);
    }
    return map;
  }

  /** Public farmers for a storefront slug — [] unless the tenant has multiFarmer on. */
  async findPublicBySlug(slug: string): Promise<PublicFarmer[]> {
    const tenant = await this.publicCache.resolveTenant(this.db, slug);
    if (!tenant.multiFarmer) return [];

    const key = publicCacheKeys.farmers(tenant.id);
    const cached = await this.publicCache.get<PublicFarmer[]>(key);
    if (cached) return cached;

    const rows = await this.db
      .select()
      .from(farmers)
      .where(eq(farmers.tenantId, tenant.id))
      .orderBy(asc(farmers.position), asc(farmers.createdAt));
    const mediaByFarmer = await this.mediaUrlsByFarmer(rows.map((r) => r.id));
    // Strip personal farmer contact (email + phone) — the storefront renders the
    // tenant's public contact, never an individual farmer's. (email leak fixed in
    // 248c330; phone was the same class of over-exposure on a world-readable API.)
    const result: PublicFarmer[] = rows.map(
      ({ tenantId: _tenantId, email: _email, phone: _phone, ...rest }) => {
      const urls = mediaByFarmer.get(rest.id) ?? [];
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
