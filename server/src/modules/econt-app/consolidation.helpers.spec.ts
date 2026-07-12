import { groupConsolidationCandidates, type CandidateRow } from './consolidation.helpers';

const row = (o: Partial<CandidateRow>): CandidateRow => ({
  shipmentId: 's', orderId: 'o', orderNumber: 1, farmerId: 'f', farmerName: 'F',
  totalStotinki: 1000, customerName: 'Иван', customerPhone: '0888 123 456',
  deliveryCity: 'Варна', deliveryAddress: 'ул. Х 1', visitorHash: null, ...o,
});

describe('groupConsolidationCandidates', () => {
  it('groups the SAME farmer\'s orders by shared visitor hash and sums totals', () => {
    const rows = [
      row({ shipmentId: 's1', orderId: 'o1', orderNumber: 7, farmerId: 'fA', totalStotinki: 1300, visitorHash: 'h1' }),
      row({ shipmentId: 's2', orderId: 'o2', orderNumber: 8, farmerId: 'fA', totalStotinki: 500, visitorHash: 'h1' }),
    ];
    const groups = groupConsolidationCandidates(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].sumStotinki).toBe(1800);
    expect(groups[0].members.map((m) => m.orderId)).toEqual(['o1', 'o2']);
  });

  it('NEVER folds different farmers into one master (farmer-as-seller: each collects own COD)', () => {
    // Same buyer, same destination, same checkout — but two different sellers. Under the
    // one-collector model these merged; under farmer-as-seller they must stay separate so
    // each farmer's наложен платеж is paid to their own account.
    const rows = [
      row({ shipmentId: 's1', orderId: 'o1', farmerId: 'fA', totalStotinki: 1300, visitorHash: 'h1' }),
      row({ shipmentId: 's2', orderId: 'o2', farmerId: 'fB', totalStotinki: 500, visitorHash: 'h1' }),
    ];
    expect(groupConsolidationCandidates(rows)).toEqual([]);
  });

  it('drops singleton groups', () => {
    expect(groupConsolidationCandidates([row({ visitorHash: 'lonely' })])).toEqual([]);
  });

  it('falls back to phone+city+address for the same farmer when visitor hash is null', () => {
    const rows = [
      row({ shipmentId: 's1', orderId: 'o1', farmerId: 'fA', customerPhone: '0888-123-456', visitorHash: null }),
      row({ shipmentId: 's2', orderId: 'o2', farmerId: 'fA', customerPhone: '+359 888 123 456', visitorHash: null }),
    ];
    // Different-looking phones normalise to the same digits and same destination → one group.
    const groups = groupConsolidationCandidates(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(2);
  });

  it('does not fold different farmers even on the phone+address fallback', () => {
    const rows = [
      row({ shipmentId: 's1', orderId: 'o1', farmerId: 'fA', customerPhone: '0888-123-456', visitorHash: null }),
      row({ shipmentId: 's2', orderId: 'o2', farmerId: 'fB', customerPhone: '+359 888 123 456', visitorHash: null }),
    ];
    expect(groupConsolidationCandidates(rows)).toEqual([]);
  });

  it('keeps different destinations apart', () => {
    const rows = [
      row({ shipmentId: 's1', orderId: 'o1', farmerId: 'fA', deliveryAddress: 'ул. Х 1', visitorHash: null }),
      row({ shipmentId: 's2', orderId: 'o2', farmerId: 'fA', deliveryAddress: 'ул. Y 9', visitorHash: null }),
    ];
    expect(groupConsolidationCandidates(rows)).toEqual([]);
  });
});

import {
  planConsolidation, resolveCollectorCarrier, consolidatedCodOverride,
  ConsolidationError, type MemberState,
} from './consolidation.helpers';

const member = (o: Partial<MemberState>): MemberState => ({
  shipmentId: 's', orderId: 'o', farmerId: 'f', status: 'draft',
  hasWaybill: false, consolidationGroupId: null, totalStotinki: 1000, ...o,
});

describe('planConsolidation', () => {
  const members = [
    member({ shipmentId: 's1', orderId: 'o1', farmerId: 'fA', totalStotinki: 1300 }),
    member({ shipmentId: 's2', orderId: 'o2', farmerId: 'fB', totalStotinki: 500 }),
  ];

  it('makes the collector the master and sums COD', () => {
    const plan = planConsolidation(members, 'fB');
    expect(plan.masterShipmentId).toBe('s2');
    expect(plan.masterOrderId).toBe('o2');
    expect(plan.childShipmentIds).toEqual(['s1']);
    expect(plan.codSumStotinki).toBe(1800);
  });

  it('rejects fewer than two members', () => {
    expect(() => planConsolidation([members[0]], 'fA')).toThrow(ConsolidationError);
  });
  it('rejects a collector not in the group', () => {
    expect(() => planConsolidation(members, 'fZ')).toThrow(ConsolidationError);
  });
  it('rejects a member that already has a waybill', () => {
    const bad = [members[0], member({ shipmentId: 's2', farmerId: 'fB', hasWaybill: true })];
    expect(() => planConsolidation(bad, 'fA')).toThrow(ConsolidationError);
  });
  it('rejects a member already in a group', () => {
    const bad = [members[0], member({ shipmentId: 's2', farmerId: 'fB', consolidationGroupId: 'gX' })];
    expect(() => planConsolidation(bad, 'fA')).toThrow(ConsolidationError);
  });
});

describe('resolveCollectorCarrier', () => {
  it('uses the only configured carrier', () => {
    expect(resolveCollectorCarrier({ econt: { configured: true } })).toBe('econt');
    expect(resolveCollectorCarrier({ speedy: { configured: true } })).toBe('speedy');
  });
  it('honours a valid requested carrier when both are configured', () => {
    expect(resolveCollectorCarrier({ econt: { configured: true }, speedy: { configured: true } }, 'speedy')).toBe('speedy');
  });
  it('throws when both configured and none requested', () => {
    expect(() => resolveCollectorCarrier({ econt: { configured: true }, speedy: { configured: true } })).toThrow(ConsolidationError);
  });
  it('throws when the collector has no carrier', () => {
    expect(() => resolveCollectorCarrier({})).toThrow(ConsolidationError);
    expect(() => resolveCollectorCarrier(undefined)).toThrow(ConsolidationError);
  });
  it('throws when the requested carrier is not configured', () => {
    expect(() => resolveCollectorCarrier({ econt: { configured: true } }, 'speedy')).toThrow(ConsolidationError);
  });
});

describe('consolidatedCodOverride', () => {
  it('returns the group sum for a master shipment', () => {
    expect(consolidatedCodOverride({ id: 'm', consolidationGroupId: 'm', codAmountStotinki: 1800 })).toBe(1800);
  });
  it('returns null for a child or a non-consolidated shipment', () => {
    expect(consolidatedCodOverride({ id: 'c', consolidationGroupId: 'm', codAmountStotinki: 500 })).toBeNull();
    expect(consolidatedCodOverride({ id: 'x', consolidationGroupId: null, codAmountStotinki: 500 })).toBeNull();
    expect(consolidatedCodOverride(null)).toBeNull();
  });
});
