import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, eq, asc } from 'drizzle-orm';
import { type Database, farmers, tenants } from '@farmflow/db';
import type { Farmer, PublicFarmer } from '@farmflow/types';
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

  /** All farmers for the tenant, ordered by display position then age. */
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

  async uploadImage(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<Farmer> {
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
