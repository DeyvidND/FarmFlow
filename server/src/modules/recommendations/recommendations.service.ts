import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type Database, orders, orderItems } from '@fermeribg/db';
import type { PublicProduct } from '@fermeribg/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { ProductsService } from '../products/products.service';
import { AvailabilityService } from '../availability/availability.service';
import { assembleCartPicks, rankCartCoOccurrence } from './recommendations.logic';

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
/** TTL for the per-tenant co-occurrence map (anchor → co-bought ids, no cart
 *  context). 600 s matches best-sellers — both are derived from the same slow-
 *  moving orders aggregate. */
const COOCCUR_TTL = 600;
/** Per-anchor cap on the co-occurrence map (how many co-bought ids we keep for
 *  each product). RECS_LIMIT × 4 leaves headroom after sold-out / in-cart filtering. */
const CO_PER_ANCHOR = RECS_LIMIT * 4;
/** Safety backstop on the pairwise self-join row count, so a very large shop can't
 *  pull an unbounded product-pair set into one cached aggregate. Generous — for a
 *  typical farm catalog the real pair count is far below this. */
const PAIR_SCAN_LIMIT = 20000;

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

  /**
   * In-process single-flight for the two expensive sales aggregates. When the 600 s
   * cache expires on a busy shop, concurrent storefront/cart requests would all miss
   * and fire the same self-join at once (thundering herd). This coalesces them into
   * one recompute; the rest await the shared Promise. Keys mirror the Redis keys.
   * Mirrors PlatformInsightsService.inflight. (No Redis lock — staleness tolerance is
   * high and the audience is a handful of storefront requests.)
   */
  private readonly inflight = new Map<string, Promise<unknown>>();

  private singleFlight<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const run = compute().finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

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
   *  sold-out products. Empty when the feature is toggled off.
   *
   *  Caching strategy: the expensive Postgres aggregate is the per-tenant
   *  co-occurrence MAP (anchor → co-bought ids), cached under
   *  `recos:cooccur:{tenantId}` at {@link COOCCUR_TTL}. The cart-aware ranking
   *  ({@link rankCartCoOccurrence}) and pick assembly (exclude in-cart / sold-out)
   *  run entirely in-process from that cached map — no per-cart Redis key, so the
   *  hit rate stays high regardless of cart shape, yet the "bought together with
   *  THIS cart" signal is preserved (not flattened to global popularity). */
  async boughtTogetherBySlug(slug: string, rawCartIds: string[]): Promise<PublicProduct[]> {
    const tenant = await this.publicCache.resolveTenant(this.db, slug);
    if (!tenant.merchandising.recommendations.show) return [];

    const cartIds = [...new Set(rawCartIds.filter((id) => UUID_RE.test(id)))].slice(0, MAX_CART_IDS);

    // Candidate pool: the public catalog minus sold-out products.
    const [catalog, windows, bestSellerIds, coMap] = await Promise.all([
      this.products.findPublicBySlug(slug),
      this.availability.findPublicActiveBySlug(slug),
      this.rankedBestSellers(tenant.id),
      // Per-tenant basket co-occurrence map, cached (not per-cart).
      this.coOccurMap(tenant.id),
    ]);

    const result = assembleCartPicks({
      catalog,
      soldOutIds: new Set(windows.filter((w) => w.remaining === 0).map((w) => w.productId)),
      cartIds: new Set(cartIds),
      // Cart-aware: only products co-bought with THIS cart's items, strongest first.
      coOccurringIds: rankCartCoOccurrence(coMap, cartIds),
      bestSellerIds,
      limit: RECS_LIMIT,
    });
    return result;
  }

  /** Raw sales ranking for a resolved tenant id, Redis-cached. */
  private async rankedBestSellers(tenantId: string): Promise<string[]> {
    const key = `recos:bestsellers:${tenantId}`;
    const cached = await this.publicCache.get<string[]>(key);
    if (cached) return cached;

    return this.singleFlight(key, async () => {
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
    });
  }

  /**
   * Per-tenant basket co-occurrence MAP: for each anchor product, the product ids
   * most often bought in the SAME basket as it, ranked by distinct-basket count then
   * quantity and capped at {@link CO_PER_ANCHOR}. Built from a pairwise self-join of
   * order_items on order_id (excluding the anchor itself), scoped to non-cancelled
   * baskets. Cart-independent, so the whole map is cached once per tenant under
   * `recos:cooccur:{tenantId}`; the per-request cart-aware ranking
   * ({@link rankCartCoOccurrence}) is assembled in-process from it. This keeps the
   * "bought together with this cart" signal while collapsing the old unbounded
   * per-cart Redis keys (near-zero hit rate) into one stable per-tenant key.
   */
  private async coOccurMap(tenantId: string): Promise<Record<string, string[]>> {
    const key = `recos:cooccur:${tenantId}`;
    const cached = await this.publicCache.get<Record<string, string[]>>(key);
    if (cached) return cached;

    return this.singleFlight(key, async () => {
      const co = alias(orderItems, 'co'); // the co-bought item in the same basket
      const rows = await this.db
        .select({
          anchor: orderItems.productId,
          other: co.productId,
          baskets: sql<number>`count(distinct ${orderItems.orderId})::int`,
          qty: sql<number>`sum(${co.quantity})::int`,
        })
        .from(orderItems)
        .innerJoin(
          co,
          and(eq(co.orderId, orderItems.orderId), sql`${co.productId} <> ${orderItems.productId}`),
        )
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(
          and(
            eq(orders.tenantId, tenantId),
            LIVE,
            sql`${orderItems.productId} is not null`,
            sql`${co.productId} is not null`,
          ),
        )
        .groupBy(orderItems.productId, co.productId)
        // anchor groups the rows; within each, strongest pairing (baskets, then qty) first.
        .orderBy(
          asc(orderItems.productId),
          desc(sql`count(distinct ${orderItems.orderId})`),
          desc(sql`sum(${co.quantity})`),
        )
        .limit(PAIR_SCAN_LIMIT);

      // Rows arrive grouped by anchor and pre-ranked, so push in order and cap per anchor.
      const map: Record<string, string[]> = {};
      for (const r of rows) {
        if (!r.anchor || !r.other) continue;
        const list = (map[r.anchor] ??= []);
        if (list.length < CO_PER_ANCHOR) list.push(r.other);
      }

      await this.publicCache.set(key, map, COOCCUR_TTL);
      return map;
    });
  }
}
