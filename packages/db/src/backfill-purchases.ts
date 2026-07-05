import { config } from 'dotenv';
config({ path: '../../.env' });
config();
import { createHash } from 'node:crypto';
import { and, gte, inArray, isNotNull, notExists, eq, sql } from 'drizzle-orm';
import { createDb, orders, siteEvents } from './index';

/**
 * One-off backfill: emit a server-side 'purchase' site_event for confirmed-sale
 * orders placed BEFORE the recordPurchase() emit paths existed (checkout.service /
 * stripe.service), so the funnel's purchase stage isn't missing historical sales.
 *
 * Re-runnable: guarded by NOT EXISTS on (tenant_id, order_id, event_type='purchase'),
 * so a second run inserts 0 rows. Synthetic visitorHash (sha256('backfill|'+orderId))
 * since the real checkout-time hash was never captured for these legacy orders — it
 * carries no cross-day identity anyway, so it can't over/under-count a real visitor.
 */

const LOOKBACK_DAYS = 180;
const CHUNK_SIZE = 500;

// Statuses that represent a confirmed sale (mirrors the payments/analytics
// convention elsewhere in the codebase — 'pending'/'cancelled' are excluded).
const SALE_STATUSES = ['confirmed', 'preparing', 'out_for_delivery', 'delivered'] as const;

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const db = createDb(connectionString);

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);

  // Eligible orders: confirmed-sale status, within the lookback window, tenant
  // known, and with no existing 'purchase' row for this order yet.
  const eligible = await db
    .select({
      id: orders.id,
      tenantId: orders.tenantId,
      totalStotinki: orders.totalStotinki,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(
      and(
        inArray(orders.status, [...SALE_STATUSES]),
        gte(orders.createdAt, since),
        isNotNull(orders.tenantId),
        notExists(
          db
            .select({ id: siteEvents.id })
            .from(siteEvents)
            .where(
              and(
                eq(siteEvents.orderId, orders.id),
                eq(siteEvents.eventType, 'purchase'),
              ),
            ),
        ),
      ),
    );

  if (!eligible.length) {
    console.log('backfill-purchases: 0 eligible orders — nothing to do.');
    return;
  }

  const rows = eligible.map((o) => ({
    tenantId: o.tenantId!,
    // Synthetic per-order hash — no real checkout-time hash was captured for
    // these legacy orders. device is OMITTED (defaults 'desktop', unused on
    // purchase rows).
    visitorHash: createHash('sha256').update(`backfill|${o.id}`).digest('hex'),
    eventType: 'purchase',
    orderId: o.id,
    valueStotinki: o.totalStotinki,
    // Lands the row in the correct historical bucket instead of "now".
    createdAt: o.createdAt ?? new Date(),
  }));

  let inserted = 0;
  for (const batch of chunk(rows, CHUNK_SIZE)) {
    await db.insert(siteEvents).values(batch);
    inserted += batch.length;
  }

  console.log(`backfill-purchases: inserted ${inserted} purchase event(s) for ${eligible.length} order(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('backfill-purchases failed:', err);
    process.exit(1);
  });
