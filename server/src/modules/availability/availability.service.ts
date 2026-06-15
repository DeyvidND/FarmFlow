import {
  Injectable,
  Inject,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { type Database, productAvailabilityWindows, products } from '@farmflow/db';
import type { AvailabilityWindow, PublicAvailabilityWindow } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { bgToday } from '../../common/time/bg-time';
import { CreateWindowDto } from './dto/create-window.dto';
import { CreateWindowsBulkDto } from './dto/create-windows-bulk.dto';
import { UpdateWindowDto } from './dto/update-window.dto';
import { rangesOverlap, applyQuantityDelta } from './availability.util';

@Injectable()
export class AvailabilityService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly cache: CatalogCacheService,
    private readonly publicCache: PublicCacheService,
  ) {}

  /** All windows for the tenant, ordered by start date.
   *  opts.productId — optional product filter (any caller).
   *  opts.farmerId  — when non-null, only windows whose product belongs to that
   *                   farmer are returned (producer scope); null = whole tenant. */
  async list(
    tenantId: string,
    opts: { productId?: string; farmerId?: string | null },
  ): Promise<AvailabilityWindow[]> {
    const { productId, farmerId } = opts;

    // When a farmerScope is active, restrict to product ids owned by that farmer.
    if (farmerId) {
      const farmerProducts = await this.db
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.tenantId, tenantId), eq(products.farmerId, farmerId)));
      const ids = farmerProducts.map((p) => p.id);
      if (!ids.length) return [];

      const productFilter = productId && ids.includes(productId) ? productId : undefined;
      const effectiveIds = productFilter ? [productFilter] : ids;

      return this.db
        .select()
        .from(productAvailabilityWindows)
        .where(
          and(
            eq(productAvailabilityWindows.tenantId, tenantId),
            inArray(productAvailabilityWindows.productId, effectiveIds),
          ),
        )
        .orderBy(asc(productAvailabilityWindows.startsAt));
    }

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

  /** Create a new availability window.
   *  farmerScope — when non-null (producer caller), the target product must also
   *                belong to that farmer; null = owner, no extra restriction. */
  async create(
    tenantId: string,
    dto: CreateWindowDto,
    farmerScope: string | null,
  ): Promise<AvailabilityWindow> {
    // Ownership guard: a window may only be created for a product owned by the
    // caller's tenant. Without this, a tenant could attach windows to (and read
    // `remaining` of) another tenant's product — a cross-tenant IDOR.
    const [owned] = await this.db
      .select({ id: products.id, farmerId: products.farmerId })
      .from(products)
      .where(and(eq(products.id, dto.productId), eq(products.tenantId, tenantId)))
      .limit(1);
    if (!owned) throw new NotFoundException('Продуктът не е намерен');

    // Producer sub-account: also verify the product belongs to *their* farm.
    if (farmerScope !== null && owned.farmerId !== farmerScope) {
      throw new ForbiddenException('Нямате достъп до този продукт');
    }

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

  /** Set one window (same dates + quantity) on many products at once — the
   *  «Задай за всички» bulk action. Products not owned by the caller (tenant, and
   *  when scoped the producer's farm) are skipped; products that already have an
   *  overlapping window are skipped too. Both kinds of skip are reported, never
   *  fatal, so one bad product doesn't sink the whole batch. */
  async createBulk(
    tenantId: string,
    dto: CreateWindowsBulkDto,
    farmerScope: string | null,
  ): Promise<{
    created: AvailabilityWindow[];
    skipped: { productId: string; reason: 'not-found' | 'overlap' }[];
  }> {
    if (dto.endsAt < dto.startsAt) {
      throw new BadRequestException('Крайната дата е преди началната');
    }

    const requested = [...new Set(dto.productIds)];
    const skipped: { productId: string; reason: 'not-found' | 'overlap' }[] = [];

    // Owned products in this tenant (and, when scoped, this producer's farm).
    const ownConds = [eq(products.tenantId, tenantId), inArray(products.id, requested)];
    if (farmerScope !== null) ownConds.push(eq(products.farmerId, farmerScope));
    const owned = await this.db
      .select({ id: products.id })
      .from(products)
      .where(and(...ownConds));
    const ownedIds = new Set(owned.map((p) => p.id));

    const eligible: string[] = [];
    for (const id of requested) {
      if (ownedIds.has(id)) eligible.push(id);
      else skipped.push({ productId: id, reason: 'not-found' });
    }
    if (!eligible.length) return { created: [], skipped };

    // One query for every eligible product's existing windows → overlap-skip in JS.
    const existing = await this.db
      .select()
      .from(productAvailabilityWindows)
      .where(
        and(
          eq(productAvailabilityWindows.tenantId, tenantId),
          inArray(productAvailabilityWindows.productId, eligible),
        ),
      );
    const byProduct = new Map<string, typeof existing>();
    for (const w of existing) {
      const list = byProduct.get(w.productId!) ?? [];
      list.push(w);
      byProduct.set(w.productId!, list);
    }

    const toInsert: string[] = [];
    for (const id of eligible) {
      const windows = byProduct.get(id) ?? [];
      if (windows.some((w) => rangesOverlap(dto.startsAt, dto.endsAt, w.startsAt, w.endsAt))) {
        skipped.push({ productId: id, reason: 'overlap' });
      } else {
        toInsert.push(id);
      }
    }
    if (!toInsert.length) return { created: [], skipped };

    const created = await this.db
      .insert(productAvailabilityWindows)
      .values(
        toInsert.map((productId) => ({
          tenantId,
          productId,
          startsAt: dto.startsAt,
          endsAt: dto.endsAt,
          quantity: dto.quantity,
          remaining: dto.quantity,
        })),
      )
      .returning();
    await this.bust(tenantId);
    return { created, skipped };
  }

  /** Update an existing window.
   *  farmerScope — when non-null, the window's product must belong to that farmer. */
  async update(
    id: string,
    tenantId: string,
    dto: UpdateWindowDto,
    farmerScope: string | null,
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

    // Producer sub-account: verify the window belongs to their farm.
    if (farmerScope !== null) {
      const [prod] = await this.db
        .select({ farmerId: products.farmerId })
        .from(products)
        .where(and(eq(products.id, cur.productId!), eq(products.tenantId, tenantId)))
        .limit(1);
      if (!prod || prod.farmerId !== farmerScope) {
        throw new ForbiddenException('Нямате достъп до този период');
      }
    }

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

  /** Delete a window.
   *  farmerScope — when non-null, the window's product must belong to that farmer. */
  async remove(
    id: string,
    tenantId: string,
    farmerScope: string | null,
  ): Promise<{ id: string }> {
    // Producer sub-account: verify ownership before deleting.
    if (farmerScope !== null) {
      const [cur] = await this.db
        .select({ productId: productAvailabilityWindows.productId })
        .from(productAvailabilityWindows)
        .where(
          and(
            eq(productAvailabilityWindows.id, id),
            eq(productAvailabilityWindows.tenantId, tenantId),
          ),
        )
        .limit(1);
      if (!cur) throw new NotFoundException('Периодът не е намерен');

      const [prod] = await this.db
        .select({ farmerId: products.farmerId })
        .from(products)
        .where(and(eq(products.id, cur.productId!), eq(products.tenantId, tenantId)))
        .limit(1);
      if (!prod || prod.farmerId !== farmerScope) {
        throw new ForbiddenException('Нямате достъп до този период');
      }
    }

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

  /** Lean product list for the admin picker in «Задай наличност».
   *  Returns only active products for the tenant; when farmerScope is non-null
   *  (producer sub-account), restricts to that farmer's products only.
   *  Owner (farmerScope=null) gets all active products, optionally filtered if
   *  they pass a farmerId query param (handled in the controller). */
  async listPickerProducts(
    tenantId: string,
    farmerScope: string | null,
  ): Promise<{ id: string; name: string; weight: string | null; farmerId: string | null }[]> {
    const conditions = [
      eq(products.tenantId, tenantId),
      eq(products.isActive, true),
      // Exclude soft-deleted products (migration 0045): a deleted product must not
      // surface in the availability picker (matches products.service reads).
      isNull(products.deletedAt),
    ];
    if (farmerScope !== null) {
      conditions.push(eq(products.farmerId, farmerScope));
    }
    return this.db
      .select({
        id: products.id,
        name: products.name,
        weight: products.weight,
        farmerId: products.farmerId,
      })
      .from(products)
      .where(and(...conditions))
      .orderBy(asc(products.name));
  }

  /** Active windows (today within range) for a storefront slug — the overlay the
   *  storefront merges onto the cached catalog by productId. Not long-cached:
   *  `remaining` is volatile (changes per order).
   *  Returns [] immediately when the tenant's availabilitySectionEnabled toggle is
   *  off — no DB query needed. */
  async findPublicActiveBySlug(slug: string): Promise<PublicAvailabilityWindow[]> {
    const tenant = await this.publicCache.resolveTenant(this.db, slug);

    // Gated by the «Наличност» section toggle — if off, show nothing to the storefront.
    if (!tenant.availabilitySectionEnabled) return [];

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
