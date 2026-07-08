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
  if (r.visitorHash) return `vh:${r.visitorHash}`;
  return `pa:${digits(r.customerPhone)}|${(r.deliveryCity ?? '').trim().toLowerCase()}|${(r.deliveryAddress ?? '').trim().toLowerCase()}`;
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
