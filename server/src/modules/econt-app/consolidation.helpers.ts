/**
 * Pure helpers for courier shipment consolidation. No DB, no clock — the service
 * reads rows and hands them here so the grouping/planning logic is unit-testable.
 */

export interface CandidateRow {
  shipmentId: string;
  orderId: string;
  orderNumber: number | null;
  farmerId: string;
  farmerName: string | null;
  totalStotinki: number;
  customerName: string | null;
  customerPhone: string | null;
  deliveryCity: string | null;
  deliveryAddress: string | null;
  visitorHash: string | null;
}

export interface SuggestionMember {
  shipmentId: string;
  orderId: string;
  orderNumber: number | null;
  farmerId: string;
  farmerName: string | null;
  totalStotinki: number;
}

export interface SuggestionGroup {
  key: string;
  customerName: string | null;
  customerPhone: string | null;
  deliveryCity: string | null;
  deliveryAddress: string | null;
  sumStotinki: number;
  members: SuggestionMember[];
}

const digits = (s: string | null): string => {
  const stripped = (s ?? '').replace(/\D/g, '');
  // Bulgaria: +359 = 0 in local format
  if (stripped.startsWith('359')) {
    return '0' + stripped.slice(3);
  }
  return stripped;
};

/**
 * Group key for "same customer, same destination". A shared visitor hash (both legs
 * of one checkout carry it — see createCourierOrders) is the strongest signal; when
 * absent, fall back to normalized phone + city + address.
 */
function candidateKey(r: CandidateRow): string {
  // Farmer-as-seller: the seller is part of the key, so only a SINGLE farmer's own
  // orders to one customer/destination may merge onto one waybill. Different farmers
  // are NEVER folded into one master — that master would collect the whole group's COD
  // to ONE account, breaking direct-to-farmer settlement (each farmer must collect their
  // own наложен платеж to their own Econt account / IBAN). A farmer shipping two of their
  // own orders to the same buyer still consolidates (one waybill, their own account).
  const dest = r.visitorHash
    ? `vh:${r.visitorHash}`
    : `pa:${digits(r.customerPhone)}|${(r.deliveryCity ?? '').trim().toLowerCase()}|${(r.deliveryAddress ?? '').trim().toLowerCase()}`;
  return `f:${r.farmerId}|${dest}`;
}

/**
 * Collapse candidate draft-shipment rows into suggestion groups. Only groups with
 * ≥2 members are returned; members are ordered by order number (stable). Group
 * order follows first appearance in `rows`.
 */
export function groupConsolidationCandidates(rows: CandidateRow[]): SuggestionGroup[] {
  const byKey = new Map<string, CandidateRow[]>();
  const order: string[] = [];
  for (const r of rows) {
    const k = candidateKey(r);
    const list = byKey.get(k);
    if (list) list.push(r);
    else {
      byKey.set(k, [r]);
      order.push(k);
    }
  }

  const out: SuggestionGroup[] = [];
  for (const k of order) {
    const list = byKey.get(k)!;
    if (list.length < 2) continue;
    const members = [...list]
      .sort((a, b) => (a.orderNumber ?? 0) - (b.orderNumber ?? 0))
      .map((r) => ({
        shipmentId: r.shipmentId,
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        farmerId: r.farmerId,
        farmerName: r.farmerName,
        totalStotinki: r.totalStotinki,
      }));
    const head = list[0];
    out.push({
      key: k,
      customerName: head.customerName,
      customerPhone: head.customerPhone,
      deliveryCity: head.deliveryCity,
      deliveryAddress: head.deliveryAddress,
      sumStotinki: members.reduce((s, m) => s + m.totalStotinki, 0),
      members,
    });
  }
  return out;
}

/** Thrown for any invalid consolidation request. `message` is user-facing (Bulgarian). */
export class ConsolidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsolidationError';
  }
}

export interface MemberState {
  shipmentId: string;
  orderId: string;
  farmerId: string;
  status: string;
  hasWaybill: boolean;
  consolidationGroupId: string | null;
  totalStotinki: number;
}

export interface ConsolidationPlan {
  masterShipmentId: string;
  masterOrderId: string;
  childShipmentIds: string[];
  codSumStotinki: number;
}

/**
 * Validate a set of member draft shipments and produce the merge plan: the
 * collector's shipment becomes the master (collects the summed COD), the rest
 * become children. Throws ConsolidationError on any invalid state.
 */
export function planConsolidation(members: MemberState[], collectorFarmerId: string): ConsolidationPlan {
  if (members.length < 2) {
    throw new ConsolidationError('Обединяването изисква поне две пратки.');
  }
  for (const m of members) {
    if (m.status !== 'draft' || m.hasWaybill) {
      throw new ConsolidationError('Една от пратките вече е обработена и не може да се обедини.');
    }
    if (m.consolidationGroupId) {
      throw new ConsolidationError('Една от пратките вече е обединена.');
    }
  }
  const master = members.find((m) => m.farmerId === collectorFarmerId);
  if (!master) {
    throw new ConsolidationError('Избраният събирач не е сред фермерите в групата.');
  }
  return {
    masterShipmentId: master.shipmentId,
    masterOrderId: master.orderId,
    childShipmentIds: members.filter((m) => m.shipmentId !== master.shipmentId).map((m) => m.shipmentId),
    codSumStotinki: members.reduce((s, m) => s + m.totalStotinki, 0),
  };
}

/**
 * Resolve which carrier the collector ships the consolidated parcel with. Uses the
 * single configured carrier; when both are configured a `requested` carrier must be
 * supplied. Throws when the collector cannot ship (or the request is unconfigured).
 */
export function resolveCollectorCarrier(
  ns: { econt?: { configured?: boolean }; speedy?: { configured?: boolean } } | undefined,
  requested?: 'econt' | 'speedy',
): 'econt' | 'speedy' {
  const econt = !!ns?.econt?.configured;
  const speedy = !!ns?.speedy?.configured;
  if (!econt && !speedy) {
    throw new ConsolidationError('Събирачът няма свързан куриер.');
  }
  if (requested) {
    if ((requested === 'econt' && !econt) || (requested === 'speedy' && !speedy)) {
      throw new ConsolidationError('Избраният куриер не е конфигуриран за събирача.');
    }
    return requested;
  }
  if (econt && speedy) {
    throw new ConsolidationError('Изберете куриер за обединената товарителница.');
  }
  return econt ? 'econt' : 'speedy';
}

/**
 * The COD a waybill must collect for `shipment`. For a consolidation MASTER
 * (consolidation_group_id === id) that is the stored group sum; otherwise null so
 * the caller keeps deriving COD from the order total (unchanged behaviour).
 */
export function consolidatedCodOverride(
  shipment: { id: string; consolidationGroupId: string | null; codAmountStotinki: number | null } | null | undefined,
): number | null {
  if (shipment && shipment.consolidationGroupId === shipment.id) {
    return shipment.codAmountStotinki;
  }
  return null;
}
