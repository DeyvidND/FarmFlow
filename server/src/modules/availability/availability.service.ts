import {
  Injectable,
  Inject,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { type Database, productAvailabilityWindows, products } from '@fermeribg/db';
import type { AvailabilityWindow, PublicAvailabilityWindow } from '@fermeribg/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { bgToday } from '../../common/time/bg-time';
import { CreateWindowDto } from './dto/create-window.dto';
import { CreateWindowsBulkDto } from './dto/create-windows-bulk.dto';
import { UpdateWindowDto } from './dto/update-window.dto';
import { rangesOverlap, applyQuantityDelta } from './availability.util';

// Availability has no date window anymore: a product just has a stock count that
// is live until depleted or deleted. We still persist an open-ended date range so
// the existing "active today" reads (orders checkout + public storefront) keep
// selecting the row with zero query changes.
const OPEN_START = '2000-01-01';
const OPEN_END = '9999-12-31';

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

    // One stock entry per product — if it already has one, the farmer edits it.
    const existing = await this.db
      .select()
      .from(productAvailabilityWindows)
      .where(
        and(
          eq(productAvailabilityWindows.tenantId, tenantId),
          eq(productAvailabilityWindows.productId, dto.productId),
        ),
      );

    if (existing.some((w) => rangesOverlap(OPEN_START, OPEN_END, w.startsAt, w.endsAt))) {
      throw new ConflictException('Този продукт вече има зададена наличност. Промени я вместо да добавяш нова.');
    }

    const [row] = await this.db
      .insert(productAvailabilityWindows)
      .values({
        tenantId,
        productId: dto.productId,
        startsAt: OPEN_START,
        endsAt: OPEN_END,
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
    // Per-product quantities (last entry wins on a duplicate productId).
    const qtyById = new Map<string, number>();
    for (const it of dto.items) qtyById.set(it.productId, it.quantity);
    const requested = [...qtyById.keys()];
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
      if (windows.some((w) => rangesOverlap(OPEN_START, OPEN_END, w.startsAt, w.endsAt))) {
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
          startsAt: OPEN_START,
          endsAt: OPEN_END,
          quantity: qtyById.get(productId)!,
          remaining: qtyById.get(productId)!,
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

    // Quantity-only edit. Editing down preserves what was already sold
    // (applyQuantityDelta), so `remaining` never exceeds the new stock.
    const quantity = dto.quantity ?? cur.quantity;
    const remaining =
      dto.quantity == null ? cur.remaining : applyQuantityDelta(cur, dto.quantity);

    const [row] = await this.db
      .update(productAvailabilityWindows)
      .set({ quantity, remaining })
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

  /** Upsert-or-clear the single open-ended stock window for a product — what the
   *  product dialog's „Наличност" field writes. `quantity` number → create the
   *  window (or edit its `quantity`, preserving what's already sold so `remaining`
   *  never exceeds the new stock); `null` → delete it, leaving the product
   *  unlimited. The caller (ProductsService) owns the product it just created /
   *  updated, so ownership is already proven here; every query is still
   *  tenant-scoped as defence in depth. */
  async setProductStock(
    tenantId: string,
    productId: string,
    quantity: number | null,
  ): Promise<void> {
    const existing = await this.db
      .select()
      .from(productAvailabilityWindows)
      .where(
        and(
          eq(productAvailabilityWindows.tenantId, tenantId),
          eq(productAvailabilityWindows.productId, productId),
        ),
      );
    const open =
      existing.find((w) => rangesOverlap(OPEN_START, OPEN_END, w.startsAt, w.endsAt)) ?? null;

    if (quantity === null) {
      if (!open) return; // nothing to clear — already unlimited
      await this.db
        .delete(productAvailabilityWindows)
        .where(eq(productAvailabilityWindows.id, open.id));
      await this.bust(tenantId);
      return;
    }

    if (open) {
      // Editing down preserves what was already sold (applyQuantityDelta), so
      // `remaining` never exceeds the new stock.
      const remaining = applyQuantityDelta(open, quantity);
      await this.db
        .update(productAvailabilityWindows)
        .set({ quantity, remaining })
        .where(eq(productAvailabilityWindows.id, open.id));
    } else {
      await this.db.insert(productAvailabilityWindows).values({
        tenantId,
        productId,
        startsAt: OPEN_START,
        endsAt: OPEN_END,
        quantity,
        remaining: quantity,
      });
    }
    await this.bust(tenantId);
  }

  /** Active windows (today within range) for a storefront slug — the overlay the
   *  storefront merges onto the cached catalog by productId. Not long-cached:
   *  `remaining` is volatile (changes per order). Always queried: availability is
   *  on for every farm, so any active window the farmer recorded is shown. */
  async findPublicActiveBySlug(slug: string): Promise<PublicAvailabilityWindow[]> {
    const tenant = await this.publicCache.resolveTenant(this.db, slug);

    const today = bgToday();
    // Push the active-today predicate into SQL so it's served by the
    // (tenant_id, ends_at, starts_at) index instead of scanning all tenant
    // windows and filtering in JS. ends_at >= today leads so expired windows
    // drop out before the starts_at <= today filter applies.
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
