import {
  Injectable,
  Inject,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { type Database, productAvailabilityWindows, products } from '@farmflow/db';
import type { AvailabilityWindow, PublicAvailabilityWindow } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { bgToday } from '../../common/time/bg-time';
import { CreateWindowDto } from './dto/create-window.dto';
import { UpdateWindowDto } from './dto/update-window.dto';
import { rangesOverlap, applyQuantityDelta } from './availability.util';

@Injectable()
export class AvailabilityService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly cache: CatalogCacheService,
    private readonly publicCache: PublicCacheService,
  ) {}

  /** All windows for the tenant (optionally filtered to one product), current +
   *  upcoming + past, ordered by start date. */
  list(tenantId: string, productId?: string): Promise<AvailabilityWindow[]> {
    const where = productId
      ? and(
          eq(productAvailabilityWindows.tenantId, tenantId),
          eq(productAvailabilityWindows.productId, productId),
        )
      : eq(productAvailabilityWindows.tenantId, tenantId);
    return this.db
      .select()
      .from(productAvailabilityWindows)
      .where(where)
      .orderBy(asc(productAvailabilityWindows.startsAt));
  }

  async create(tenantId: string, dto: CreateWindowDto): Promise<AvailabilityWindow> {
    // Ownership guard: a window may only be created for a product owned by the
    // caller's tenant. Without this, a tenant could attach windows to (and read
    // `remaining` of) another tenant's product — a cross-tenant IDOR.
    const [owned] = await this.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, dto.productId), eq(products.tenantId, tenantId)))
      .limit(1);
    if (!owned) throw new NotFoundException('Продуктът не е намерен');

    if (dto.endsAt < dto.startsAt) {
      throw new BadRequestException('Крайната дата е преди началната');
    }

    // Fetch existing windows for this product (under this tenant) to check overlap.
    const existing = await this.db
      .select()
      .from(productAvailabilityWindows)
      .where(
        and(
          eq(productAvailabilityWindows.tenantId, tenantId),
          eq(productAvailabilityWindows.productId, dto.productId),
        ),
      );

    if (existing.some((w) => rangesOverlap(dto.startsAt, dto.endsAt, w.startsAt, w.endsAt))) {
      throw new ConflictException('Периодът се застъпва с друг за този продукт');
    }

    const [row] = await this.db
      .insert(productAvailabilityWindows)
      .values({
        tenantId,
        productId: dto.productId,
        startsAt: dto.startsAt,
        endsAt: dto.endsAt,
        quantity: dto.quantity,
        remaining: dto.quantity,
      })
      .returning();
    await this.bust(tenantId);
    return row;
  }

  async update(
    id: string,
    tenantId: string,
    dto: UpdateWindowDto,
  ): Promise<AvailabilityWindow> {
    const [cur] = await this.db
      .select()
      .from(productAvailabilityWindows)
      .where(
        and(
          eq(productAvailabilityWindows.id, id),
          eq(productAvailabilityWindows.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!cur) throw new NotFoundException('Периодът не е намерен');

    const startsAt = dto.startsAt ?? cur.startsAt;
    const endsAt = dto.endsAt ?? cur.endsAt;
    if (endsAt < startsAt) {
      throw new BadRequestException('Крайната дата е преди началната');
    }

    // Overlap check against this product's *other* windows.
    const siblings = await this.db
      .select()
      .from(productAvailabilityWindows)
      .where(
        and(
          eq(productAvailabilityWindows.tenantId, tenantId),
          eq(productAvailabilityWindows.productId, cur.productId!),
        ),
      );
    if (
      siblings.some(
        (w) => w.id !== id && rangesOverlap(startsAt, endsAt, w.startsAt, w.endsAt),
      )
    ) {
      throw new ConflictException('Периодът се застъпва с друг за този продукт');
    }

    const quantity = dto.quantity ?? cur.quantity;
    const remaining =
      dto.quantity == null ? cur.remaining : applyQuantityDelta(cur, dto.quantity);

    const [row] = await this.db
      .update(productAvailabilityWindows)
      .set({ startsAt, endsAt, quantity, remaining })
      .where(
        and(
          eq(productAvailabilityWindows.id, id),
          eq(productAvailabilityWindows.tenantId, tenantId),
        ),
      )
      .returning();
    await this.bust(tenantId);
    return row;
  }

  async remove(id: string, tenantId: string): Promise<{ id: string }> {
    const res = await this.db
      .delete(productAvailabilityWindows)
      .where(
        and(
          eq(productAvailabilityWindows.id, id),
          eq(productAvailabilityWindows.tenantId, tenantId),
        ),
      )
      .returning({ id: productAvailabilityWindows.id });
    if (!res.length) throw new NotFoundException('Периодът не е намерен');
    await this.bust(tenantId);
    return { id };
  }

  /** Active windows (today within range) for a storefront slug — the overlay the
   *  storefront merges onto the cached catalog by productId. Not long-cached:
   *  `remaining` is volatile (changes per order). */
  async findPublicActiveBySlug(slug: string): Promise<PublicAvailabilityWindow[]> {
    const tenant = await this.publicCache.resolveTenant(this.db, slug);
    const today = bgToday();
    // Push the active-today predicate into SQL so it's served by the
    // (product_id, starts_at, ends_at) index instead of scanning all tenant
    // windows and filtering in JS (mirrors the checkout-path query).
    const rows = await this.db
      .select()
      .from(productAvailabilityWindows)
      .where(
        and(
          eq(productAvailabilityWindows.tenantId, tenant.id),
          lte(productAvailabilityWindows.startsAt, today),
          gte(productAvailabilityWindows.endsAt, today),
        ),
      );
    return rows.map((w) => ({
      productId: w.productId!,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      quantity: w.quantity,
      remaining: w.remaining,
    }));
  }

  /** Busts the admin catalog cache when windows change. */
  private async bust(tenantId: string): Promise<void> {
    await this.cache.invalidate(tenantId);
  }
}
