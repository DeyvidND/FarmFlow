import { groupConsolidationCandidates, type CandidateRow } from './consolidation.helpers';

const row = (o: Partial<CandidateRow>): CandidateRow => ({
  shipmentId: 's', orderId: 'o', orderNumber: 1, farmerId: 'f', farmerName: 'F',
  totalStotinki: 1000, customerName: 'Иван', customerPhone: '0888 123 456',
  deliveryCity: 'Варна', deliveryAddress: 'ул. Х 1', visitorHash: null, ...o,
});

describe('groupConsolidationCandidates', () => {
  it('groups by shared visitor hash and sums totals', () => {
    const rows = [
      row({ shipmentId: 's1', orderId: 'o1', orderNumber: 7, farmerId: 'fA', totalStotinki: 1300, visitorHash: 'h1' }),
      row({ shipmentId: 's2', orderId: 'o2', orderNumber: 8, farmerId: 'fB', totalStotinki: 500, visitorHash: 'h1' }),
    ];
    const groups = groupConsolidationCandidates(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].sumStotinki).toBe(1800);
    expect(groups[0].members.map((m) => m.orderId)).toEqual(['o1', 'o2']);
  });

  it('drops singleton groups', () => {
    expect(groupConsolidationCandidates([row({ visitorHash: 'lonely' })])).toEqual([]);
  });

  it('falls back to phone+city+address when visitor hash is null', () => {
    const rows = [
      row({ shipmentId: 's1', orderId: 'o1', farmerId: 'fA', customerPhone: '0888-123-456', visitorHash: null }),
      row({ shipmentId: 's2', orderId: 'o2', farmerId: 'fB', customerPhone: '+359 888 123 456', visitorHash: null }),
    ];
    // Different-looking phones normalise to the same digits and same destination → one group.
    const groups = groupConsolidationCandidates(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(2);
  });

  it('keeps different destinations apart', () => {
    const rows = [
      row({ shipmentId: 's1', orderId: 'o1', farmerId: 'fA', deliveryAddress: 'ул. Х 1', visitorHash: null }),
      row({ shipmentId: 's2', orderId: 'o2', farmerId: 'fB', deliveryAddress: 'ул. Y 9', visitorHash: null }),
    ];
    expect(groupConsolidationCandidates(rows)).toEqual([]);
  });
});
