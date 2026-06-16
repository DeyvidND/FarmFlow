import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { type Database, orders, orderItems } from '@farmflow/db';
import type { PublicProduct } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { ProductsService } from '../products/products.service';
import { AvailabilityService } from '../availability/availability.service';
import { assembleCartPicks } from './recommendations.logic';

/** Best-seller chip caps at this many sales-ranked ids; the storefront pads the
 *  rest from featured/newest so the chip is never thin on a quiet shop. */
const BEST_SELLER_LIMIT = 8;
/** Cart picks shown. */
const RECS_LIMIT = 3;
/** Defensive cap on the cart-id list a client may send. */
const MAX_CART_IDS = 50;
/** product_id is a uuid column — a non-uuid value would make Postgres throw, so
 *  client-supplied cart ids are filtered to well-formed uuids before any query. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BEST_SELLER_TTL = 600;
const BOUGHT_TTL = 120;

/** A sale counts unless the order was cancelled — same rule the stats screen uses
 *  (status may be NULL on legacy rows, hence `is distinct from`). */
const LIVE = sql`${orders.status} is distinct from 'cancelled'`;

/**
 * Sales-derived merchandising: the „Най-продавани" ranking (best-sellers) and the
 * cart's „Често купувано заедно" picks (basket co-occurrence). Reads the
 * orders/order_items aggregate directly (like the stats screen) and maps results
 * onto the cached public catalog, so a warm call costs no extra Postgres beyond
 * the one aggregate query. Both methods self-gate on the tenant's merchandising
 * toggles, so a disabled feature returns empty without leaking data.
 */
@Injectable()
export class RecommendationsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly publicCache: PublicCacheService,
    private readonly products: ProductsService,
    private readonly availability: AvailabilityService,
  ) {}

  /** Sales-ranked product ids for the „Най-продавани" chip (highest qty first),
   *  capped at {@link BEST_SELLER_LIMIT}. Empty when the chip is toggled off or
   *  the farm has no sales yet. Redis-cached per tenant (10 min). */
  async bestSellerIdsBySlug(slug: string): Promise<string[]> {
    const tenant = await this.publicCache.resolveTenant(this.db, slug);
    if (!tenant.merchandising.bestSellers.show) return [];
    return this.rankedBestSellers(tenant.id);
  }

  /** Up to {@link RECS_LIMIT} bought-together picks for the items currently in the
   *  cart. Ranked by how many past baskets paired them with a cart item, then by
   *  quantity. Falls back to best-sellers, then featured/newest, so it is never
   *  empty while the catalog can fill it. Excludes the cart's own items and
   *  sold-out products. Empty when the feature is toggled off. */
  async boughtTogetherBySlug(slug: string, rawCartIds: string[]): Promise<PublicProduct[]> {
    const tenant = await this.publicCache.resolveTenant(this.db, slug);
    if (!tenant.merchandising.recommendations.show) return [];

    const cartIds = [...new Set(rawCartIds.filter((id) => UUID_RE.test(id)))].slice(0, MAX_CART_IDS);
    const cacheKey = `recos:bought:${tenant.id}:${[...cartIds].sort().join(',')}`;
    const cached = await this.publicCache.get<PublicProduct[]>(cacheKey);
    if (cached) return cached;

    // Candidate pool: the public catalog minus the cart's own items and anything
    // sold out (remaining = 0 on an active availability window).
    const [catalog, windows, bestSellerIds] = await Promise.all([
      this.products.findPublicBySlug(slug),
      this.availability.findPublicActiveBySlug(slug),
      this.rankedBestSellers(tenant.id),
    ]);
    // Basket co-occurrence — only when the cart has items to pair against.
    const coRows = cartIds.length ? await this.coOccurring(tenant.id, cartIds) : [];
    const coOccurringIds = coRows.map((r) => r.productId).filter((id): id is string => !!id);

    const result = assembleCartPicks({
      catalog,
      soldOutIds: new Set(windows.filter((w) => w.remaining === 0).map((w) => w.productId)),
      cartIds: new Set(cartIds),
      coOccurringIds,
      bestSellerIds,
      limit: RECS_LIMIT,
    });
    await this.publicCache.set(cacheKey, result, BOUGHT_TTL);
    return result;
  }

  /** Raw sales ranking for a resolved tenant id, Redis-cached. */
  private async rankedBestSellers(tenantId: string): Promise<string[]> {
    const key = `recos:bestsellers:${tenantId}`;
    const cached = await this.publicCache.get<string[]>(key);
    if (cached) return cached;

    const rows = await this.db
      .select({
        productId: orderItems.productId,
        qty: sql<number>`sum(${orderItems.quantity})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(eq(orders.tenantId, tenantId), LIVE, sql`${orderItems.productId} is not null`))
      .groupBy(orderItems.productId)
      .orderBy(desc(sql`sum(${orderItems.quantity})`))
      .limit(BEST_SELLER_LIMIT);

    const ids = rows.map((r) => r.productId).filter((id): id is string => !!id);
    await this.publicCache.set(key, ids, BEST_SELLER_TTL);
    return ids;
  }

  /** Products that shared a (non-cancelled) basket with any cart item, ranked by
   *  distinct-basket count then quantity, excluding the cart's own items. */
  private async coOccurring(tenantId: string, cartIds: string[]) {
    // Orders that contain at least one of the cart's products.
    const baskets = this.db
      .select({ orderId: orderItems.orderId })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(eq(orders.tenantId, tenantId), LIVE, inArray(orderItems.productId, cartIds)));

    return this.db
      .select({
        productId: orderItems.productId,
        baskets: sql<number>`count(distinct ${orderItems.orderId})::int`,
        qty: sql<number>`sum(${orderItems.quantity})::int`,
      })
      .from(orderItems)
      .where(
        and(
          inArray(orderItems.orderId, baskets),
          sql`${orderItems.productId} is not null`,
          sql`${orderItems.productId} not in (${sql.join(
            cartIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        ),
      )
      .groupBy(orderItems.productId)
      .orderBy(desc(sql`count(distinct ${orderItems.orderId})`), desc(sql`sum(${orderItems.quantity})`))
      .limit(RECS_LIMIT * 4);
  }
}
