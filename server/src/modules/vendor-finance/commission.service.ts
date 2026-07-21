import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gte, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import {
  type Database,
  commissionEntries,
  farmers,
  orderItems,
  orders,
  products,
  tenants,
} from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { readVendorFinance } from './vendor-finance.settings';
import { allocateOrderRevenue } from '../orders/basket-revenue.util';

/** One farmer's line in the commission summary. */
export interface CommissionFarmerSummary {
  farmerId: string;
  farmerName: string | null;
  orderCount: number;
  grossStotinki: number;
  commissionStotinki: number;
  settledCommissionStotinki: number;
}

export interface CommissionSummary {
  commissionEnabled: boolean;
  defaultRateBps: number;
  farmers: CommissionFarmerSummary[];
  totalGrossStotinki: number;
  totalCommissionStotinki: number;
}

/**
 * Commission ledger over the vendor (`farmers`) attribution that already exists on
 * every order item (order_items → products.farmer_id). No order splitting — one
 * entry per (order, farmer) with the farmer's item-only gross.
 *
 * DORMANT: until `settings.vendorFinance.commissionEnabled` the effective rate is
 * 0 bps, so entries record gross history but charge nothing. The rate is
 * snapshotted per entry at accrual time — flipping the switch later never
 * retro-charges already-collected orders.
 *
 * Accrual fires on the collected-money signal (COD marked received / Stripe paid),
 * void on cancel or COD refusal — the same "collected" semantics as Плащания.
 * All methods swallow their own errors: they run fire-and-forget inside order
 * flows and must never break an order write.
 */
@Injectable()
export class CommissionService {
  private readonly logger = new Logger(CommissionService.name);

  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  /** Record (idempotently) the per-farmer commission entries for a collected order. */
  async accrueForOrder(orderId: string, tenantId: string): Promise<void> {
    try {
      const [order] = await this.db
        .select({
          id: orders.id,
          status: orders.status,
          codOutcome: orders.codOutcome,
        })
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
        .limit(1);
      // Defense in depth: never accrue on a dead order even if a seam misfires.
      if (!order || order.status === 'cancelled' || order.codOutcome === 'refused') return;

      const items: {
        id: string;
        farmerId: string | null;
        quantity: number;
        priceStotinki: number;
        memberPriceStotinki: number;
        bundleParentId: string | null;
      }[] = await this.db
        .select({
          id: orderItems.id,
          farmerId: products.farmerId,
          quantity: orderItems.quantity,
          priceStotinki: orderItems.priceStotinki,
          // The member product's OWN list price — used only to weight a basket
          // child's share (see below). For an ordinary (non-basket) line this
          // equals priceStotinki and goes unused.
          memberPriceStotinki: products.priceStotinki,
          bundleParentId: orderItems.bundleParentId,
        })
        .from(orderItems)
        .innerJoin(products, eq(products.id, orderItems.productId))
        .where(eq(orderItems.orderId, orderId));

      // A basket explodes into one parent row (the basket's own price, farmerId
      // null) plus one zero-priced child row per member (farmerId = that
      // member's farmer). Naively summing priceStotinki×quantity would count the
      // parent as nobody's (farmerId null → skipped) and every child as 0 —
      // basket revenue would vanish from the ledger entirely. Instead,
      // {@link allocateOrderRevenue} allocates each parent's line total across
      // its children proportional to member price × quantity, so each child's
      // farmer is credited with ITS share, not its (zero) stored price.
      const allocatedByItemId = allocateOrderRevenue(items);

      // Item-only gross per farmer (delivery fee excluded — same rule as turnover).
      // Items on products without a farmer are the tenant's own — no commission.
      const grossByFarmer = new Map<string, number>();
      for (const it of items) {
        if (!it.farmerId) continue;
        const revenue = allocatedByItemId.get(it.id) ?? it.priceStotinki * it.quantity;
        grossByFarmer.set(it.farmerId, (grossByFarmer.get(it.farmerId) ?? 0) + revenue);
      }
      if (grossByFarmer.size === 0) return;

      const [tenant] = await this.db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      const vf = readVendorFinance(tenant?.settings);

      const overrides: { id: string; commissionRateBps: number | null }[] = await this.db
        .select({ id: farmers.id, commissionRateBps: farmers.commissionRateBps })
        .from(farmers)
        .where(
          and(eq(farmers.tenantId, tenantId), inArray(farmers.id, [...grossByFarmer.keys()])),
        );
      const overrideByFarmer = new Map(overrides.map((f) => [f.id, f.commissionRateBps]));

      const rows = [...grossByFarmer.entries()].map(([farmerId, grossStotinki]) => {
        const rateBps = vf.commissionEnabled
          ? (overrideByFarmer.get(farmerId) ?? vf.defaultCommissionRateBps)
          : 0;
        return {
          tenantId,
          orderId,
          farmerId,
          grossStotinki,
          rateBps,
          commissionStotinki: Math.round((grossStotinki * rateBps) / 10_000),
        };
      });

      // Serialize the ledger transition per order against a concurrent voidForOrder:
      // take a per-order advisory lock, then RE-READ the order's outcome under it. The
      // insert+revive below runs atomically so the revive step can't resurrect a
      // voided entry on an order a concurrent COD-refusal/cancel just committed —
      // which would leave commission accrued on money that never arrived. Same lock
      // key as voidForOrder (salt 7).
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${orderId}, 7))`);
        const [fresh] = await tx
          .select({ status: orders.status, codOutcome: orders.codOutcome })
          .from(orders)
          .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
          .limit(1);
        if (!fresh || fresh.status === 'cancelled' || fresh.codOutcome === 'refused') return;
        // Idempotent: the (order, farmer) unique index makes a re-accrue a no-op —
        // the FIRST snapshot (amounts AND rate) always wins.
        await tx.insert(commissionEntries).values(rows).onConflictDoNothing();
        // Revive entries a COD refusal voided when the outcome is re-marked received
        // (manual re-marks are authoritative). Keeps the original snapshot; settled
        // rows are final and untouched.
        await tx
          .update(commissionEntries)
          .set({ status: 'accrued' })
          .where(
            and(
              eq(commissionEntries.orderId, orderId),
              eq(commissionEntries.tenantId, tenantId),
              eq(commissionEntries.status, 'voided'),
            ),
          );
      });
    } catch (e) {
      this.logger.warn(`commission accrue failed for order ${orderId}: ${(e as Error).message}`);
    }
  }

  /** Void the accrued (never settled) entries of a cancelled/refused order. */
  async voidForOrder(orderId: string, tenantId: string): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        // Same per-order advisory lock as accrueForOrder (salt 7) so the two never
        // interleave. Re-read under it: only void if the order is STILL cancelled/
        // refused — a concurrent re-mark to 'received' that committed keeps its accrual.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${orderId}, 7))`);
        const [fresh] = await tx
          .select({ status: orders.status, codOutcome: orders.codOutcome })
          .from(orders)
          .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
          .limit(1);
        if (fresh && fresh.status !== 'cancelled' && fresh.codOutcome !== 'refused') return;
        await tx
          .update(commissionEntries)
          .set({ status: 'voided' })
          .where(
            and(
              eq(commissionEntries.orderId, orderId),
              eq(commissionEntries.tenantId, tenantId),
              eq(commissionEntries.status, 'accrued'),
            ),
          );
      });
    } catch (e) {
      this.logger.warn(`commission void failed for order ${orderId}: ${(e as Error).message}`);
    }
  }

  /** Per-farmer totals (accrued + settled; voided excluded). Optional farmer/date scope. */
  async summary(
    tenantId: string,
    opts: { farmerId?: string; from?: Date; to?: Date } = {},
  ): Promise<CommissionSummary> {
    const conditions = [
      eq(commissionEntries.tenantId, tenantId),
      ne(commissionEntries.status, 'voided'),
      ...(opts.farmerId ? [eq(commissionEntries.farmerId, opts.farmerId)] : []),
      ...(opts.from ? [gte(commissionEntries.createdAt, opts.from)] : []),
      ...(opts.to ? [lte(commissionEntries.createdAt, opts.to)] : []),
    ];
    // Per-farmer totals aggregated in Postgres — one grouped row per farmer instead
    // of scanning the whole (ever-growing) ledger into app memory to bucket in JS.
    // `sum()` comes back as a numeric string from node-pg; Number() is exact here
    // (a tenant's lifetime stotinki total is far below 2^53). The `filter (where
    // status='settled')` mirrors the old settled-only branch. Null farmerId is
    // excluded up front (the old loop did `if (!e.farmerId) continue`).
    const grouped = await this.db
      .select({
        farmerId: commissionEntries.farmerId,
        farmerName: farmers.name,
        orderCount: sql<number>`count(*)::int`,
        grossStotinki: sql<string>`coalesce(sum(${commissionEntries.grossStotinki}), 0)`,
        commissionStotinki: sql<string>`coalesce(sum(${commissionEntries.commissionStotinki}), 0)`,
        settledCommissionStotinki: sql<string>`coalesce(sum(${commissionEntries.commissionStotinki}) filter (where ${commissionEntries.status} = 'settled'), 0)`,
      })
      .from(commissionEntries)
      .leftJoin(farmers, eq(farmers.id, commissionEntries.farmerId))
      .where(and(...conditions, isNotNull(commissionEntries.farmerId)))
      .groupBy(commissionEntries.farmerId, farmers.name);

    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const vf = readVendorFinance(tenant?.settings);

    const rows: CommissionFarmerSummary[] = grouped
      .map((g) => ({
        farmerId: g.farmerId as string,
        farmerName: g.farmerName,
        orderCount: g.orderCount,
        grossStotinki: Number(g.grossStotinki),
        commissionStotinki: Number(g.commissionStotinki),
        settledCommissionStotinki: Number(g.settledCommissionStotinki),
      }))
      .sort((a, b) => b.grossStotinki - a.grossStotinki);
    return {
      commissionEnabled: vf.commissionEnabled,
      defaultRateBps: vf.defaultCommissionRateBps,
      farmers: rows,
      totalGrossStotinki: rows.reduce((s, r) => s + r.grossStotinki, 0),
      totalCommissionStotinki: rows.reduce((s, r) => s + r.commissionStotinki, 0),
    };
  }
}
