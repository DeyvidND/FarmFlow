import { BadRequestException } from '@nestjs/common';

/**
 * Upper bound for a single order's total (in stotinki). `orders.total_stotinki`
 * (and the order_items aggregates) are Postgres `integer` = int4, max 2,147,483,647.
 * An order total is built in JS float64 from DB-sourced unit prices × quantities,
 * so nothing between the reduce() and the INSERT stops it exceeding int4 — at which
 * point the INSERT throws 22003 'integer out of range' and the public checkout 500s.
 * The per-line `@Max(10_000)` quantity guard does NOT bound the aggregate (10k × the
 * max unit price × up to 100 lines is far past int4). Cap the order value well under
 * 2^31: 20,000,000.00 lv/€ is orders of magnitude above any real farm-produce basket
 * yet comfortably below the int4 ceiling, so the guard fires at the edge with a clean
 * 400 instead of letting Postgres raise a 500.
 */
export const MAX_ORDER_TOTAL_STOTINKI = 2_000_000_000; // 20,000,000.00

export function assertOrderTotalWithinBounds(totalStotinki: number): void {
  if (!Number.isFinite(totalStotinki) || totalStotinki > MAX_ORDER_TOTAL_STOTINKI) {
    throw new BadRequestException('Стойността на поръчката надвишава допустимия лимит.');
  }
}

/** Sum of quantity × unit price over order lines (the items subtotal, stotinki). */
export function subtotalStotinki(
  items: { quantity: number; priceStotinki: number }[],
): number {
  return items.reduce((s, i) => s + i.quantity * i.priceStotinki, 0);
}

/**
 * Recompute an order total after its items changed, preserving the delivery fee.
 * The fee is never stored on its own — it was folded into `totalStotinki` at
 * checkout (`total = subtotal + shipping`). So we recover it as `prevTotal −
 * prevSubtotal` (clamped ≥ 0 for odd legacy rows) and re-add it to the new
 * subtotal. We do NOT re-quote the carrier — the original shipping stands.
 */
export function recomputeTotalStotinki(
  prevTotal: number,
  prevSubtotal: number,
  newSubtotal: number,
): number {
  const shipping = Math.max(0, prevTotal - prevSubtotal);
  return newSubtotal + shipping;
}
