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
  // Speedy COD settlement stamps codSettledAt (never codCollectedAt); Econt stamps
  // codCollectedAt. Either means the money is in, so both count as "collected".
  codSettledAt?: Date | string | null;
  createdAt: Date | string | null;
}

// COD on these statuses will never be collected, so it doesn't count as "money you're
// waiting on". Matches canonical English (Speedy) AND Econt's raw Bulgarian status
// (върната / отказана / анулирана) by substring, since the two carriers store
// status differently.
const DEAD_COD_MARKERS = ['cancelled', 'failed', 'returned', 'refused', 'върн', 'отказ', 'анулир'];

function isDeadCodStatus(status: string | null | undefined): boolean {
  const s = (status ?? '').toLowerCase();
  return DEAD_COD_MARKERS.some((m) => s.includes(m));
}

/** Fold a tenant's shipments into the super-admin overview. COD "collected" = courier
 *  marked it collected/settled; "pending" = not yet in AND still in a live state. */
export function buildDeliveryOverview(rows: ShipmentLite[]): DeliveryOverview {
  let codPendingStotinki = 0;
  let codCollectedStotinki = 0;
  let econt = 0;
  let speedy = 0;
  let last = 0;
  for (const r of rows) {
    const cod = r.codAmountStotinki ?? 0;
    if (r.codCollectedAt || r.codSettledAt) codCollectedStotinki += cod;
    else if (!isDeadCodStatus(r.status)) codPendingStotinki += cod;
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
