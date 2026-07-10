import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gte, inArray, lte, ne } from 'drizzle-orm';
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

      const items: { farmerId: string | null; quantity: number; priceStotinki: number }[] =
        await this.db
          .select({
            farmerId: products.farmerId,
            quantity: orderItems.quantity,
            priceStotinki: orderItems.priceStotinki,
          })
          .from(orderItems)
          .innerJoin(products, eq(products.id, orderItems.productId))
          .where(eq(orderItems.orderId, orderId));

      // Item-only gross per farmer (delivery fee excluded — same rule as turnover).
      // Items on products without a farmer are the tenant's own — no commission.
      const grossByFarmer = new Map<string, number>();
      for (const it of items) {
        if (!it.farmerId) continue;
        grossByFarmer.set(
          it.farmerId,
          (grossByFarmer.get(it.farmerId) ?? 0) + it.priceStotinki * it.quantity,
        );
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
        .where(inArray(farmers.id, [...grossByFarmer.keys()]));
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

      // Idempotent: the (order, farmer) unique index makes a re-accrue a no-op —
      // the FIRST snapshot (amounts AND rate) always wins.
      await this.db.insert(commissionEntries).values(rows).onConflictDoNothing();

      // Revive entries a COD refusal voided when the outcome is re-marked received
      // (manual re-marks are authoritative). Keeps the original snapshot; settled
      // rows are final and untouched.
      await this.db
        .update(commissionEntries)
        .set({ status: 'accrued' })
        .where(and(eq(commissionEntries.orderId, orderId), eq(commissionEntries.status, 'voided')));
    } catch (e) {
      this.logger.warn(`commission accrue failed for order ${orderId}: ${(e as Error).message}`);
    }
  }

  /** Void the accrued (never settled) entries of a cancelled/refused order. */
  async voidForOrder(orderId: string, tenantId: string): Promise<void> {
    try {
      await this.db
        .update(commissionEntries)
        .set({ status: 'voided' })
        .where(
          and(
            eq(commissionEntries.orderId, orderId),
            eq(commissionEntries.tenantId, tenantId),
            eq(commissionEntries.status, 'accrued'),
          ),
        );
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
    const entries: {
      farmerId: string | null;
      grossStotinki: number;
      commissionStotinki: number;
      status: 'accrued' | 'voided' | 'settled';
    }[] = await this.db
      .select({
        farmerId: commissionEntries.farmerId,
        grossStotinki: commissionEntries.grossStotinki,
        commissionStotinki: commissionEntries.commissionStotinki,
        status: commissionEntries.status,
      })
      .from(commissionEntries)
      .where(and(...conditions));

    const byFarmer = new Map<string, CommissionFarmerSummary>();
    for (const e of entries) {
      if (!e.farmerId) continue;
      const row = byFarmer.get(e.farmerId) ?? {
        farmerId: e.farmerId,
        farmerName: null,
        orderCount: 0,
        grossStotinki: 0,
        commissionStotinki: 0,
        settledCommissionStotinki: 0,
      };
      row.orderCount += 1;
      row.grossStotinki += e.grossStotinki;
      row.commissionStotinki += e.commissionStotinki;
      if (e.status === 'settled') row.settledCommissionStotinki += e.commissionStotinki;
      byFarmer.set(e.farmerId, row);
    }

    if (byFarmer.size > 0) {
      const names: { id: string; name: string }[] = await this.db
        .select({ id: farmers.id, name: farmers.name })
        .from(farmers)
        .where(inArray(farmers.id, [...byFarmer.keys()]));
      for (const n of names) {
        const row = byFarmer.get(n.id);
        if (row) row.farmerName = n.name;
      }
    }

    const [tenant] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const vf = readVendorFinance(tenant?.settings);

    const rows = [...byFarmer.values()].sort((a, b) => b.grossStotinki - a.grossStotinki);
    return {
      commissionEnabled: vf.commissionEnabled,
      defaultRateBps: vf.defaultCommissionRateBps,
      farmers: rows,
      totalGrossStotinki: rows.reduce((s, r) => s + r.grossStotinki, 0),
      totalCommissionStotinki: rows.reduce((s, r) => s + r.commissionStotinki, 0),
    };
  }
}
