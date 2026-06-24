export interface DeliveryCaps {
  shop: boolean;
  delivery: boolean;
  active: boolean;
  type: 'delivery' | 'farm' | 'both';
}

/** Derive a tenant's delivery/shop capabilities from its settings JSON. */
export function deliveryCapabilities(settings: unknown): DeliveryCaps {
  const s = (settings ?? {}) as Record<string, any>;
  const delivery = s.econtApp != null;
  const active = s.econtApp?.active === true;
  const shop = s.product !== 'econt-standalone';
  const type = delivery && shop ? 'both' : delivery ? 'delivery' : 'farm';
  return { shop, delivery, active, type };
}

export interface DeliveryOverview {
  total: number;
  codPendingStotinki: number;
  codCollectedStotinki: number;
  econt: number;
  speedy: number;
  lastShipmentAt: string | null;
}

export interface ShipmentLite {
  carrier: string | null;
  status?: string | null;
  codAmountStotinki: number | null;
  codCollectedAt: Date | string | null;
  createdAt: Date | string | null;
}

// COD on these statuses will never be collected, so it doesn't count as "money
// you're waiting on" (returned/refused = recipient declined; cancelled/failed = void).
const NO_COD_PENDING = new Set(['cancelled', 'failed', 'returned', 'refused']);

/** Fold a tenant's shipments into the super-admin overview. COD "collected" = courier
 *  marked it collected; "pending" = not yet collected AND still in a live state. */
export function buildDeliveryOverview(rows: ShipmentLite[]): DeliveryOverview {
  let codPendingStotinki = 0;
  let codCollectedStotinki = 0;
  let econt = 0;
  let speedy = 0;
  let last = 0;
  for (const r of rows) {
    const cod = r.codAmountStotinki ?? 0;
    if (r.codCollectedAt) codCollectedStotinki += cod;
    else if (!NO_COD_PENDING.has(r.status ?? '')) codPendingStotinki += cod;
    if (r.carrier === 'speedy') speedy++;
    else econt++;
    const ts = r.createdAt ? new Date(r.createdAt).getTime() : 0;
    if (ts > last) last = ts;
  }
  return {
    total: rows.length,
    codPendingStotinki,
    codCollectedStotinki,
    econt,
    speedy,
    lastShipmentAt: last ? new Date(last).toISOString() : null,
  };
}
