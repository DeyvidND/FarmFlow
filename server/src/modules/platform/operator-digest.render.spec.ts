import { assembleDigest, type OperatorDigestInput } from './operator-digest.render';

const EMPTY: OperatorDigestInput = {
  pulse: { orders24h: 0, revenue24hStotinki: 0, newSignups: [] },
  signals: [],
  stuckDrafts: [],
  emailTotals: { recipientTotal: 0, revenueStotinki: 0, marginStotinki: 0 },
};

describe('assembleDigest', () => {
  it('flags a fully-quiet day as empty', () => {
    const r = assembleDigest(EMPTY, '2026-06-30');
    expect(r.isEmpty).toBe(true);
  });

  it('is not empty when there are orders, signups, signals, or stuck drafts', () => {
    expect(assembleDigest({ ...EMPTY, pulse: { ...EMPTY.pulse, orders24h: 1 } }, '2026-06-30').isEmpty).toBe(false);
    expect(assembleDigest({ ...EMPTY, pulse: { ...EMPTY.pulse, newSignups: [{ name: 'Ферма А', createdAt: new Date() }] } }, '2026-06-30').isEmpty).toBe(false);
    expect(assembleDigest({ ...EMPTY, signals: [{ name: 'Ф', phone: null, signals: [{ label: 'x', action: 'y' }] }] }, '2026-06-30').isEmpty).toBe(false);
    expect(assembleDigest({ ...EMPTY, stuckDrafts: [{ farmerName: 'И', tenantName: 'Т', count: 2, oldestAt: new Date() }] }, '2026-06-30').isEmpty).toBe(false);
  });

  it('email revenue alone does NOT make a day non-empty', () => {
    const r = assembleDigest({ ...EMPTY, emailTotals: { recipientTotal: 50, revenueStotinki: 9999, marginStotinki: 3000 } }, '2026-06-30');
    expect(r.isEmpty).toBe(true);
  });

  it('lists a flagged farm with phone and each signal action in the attention section', () => {
    const r = assembleDigest(
      { ...EMPTY, signals: [{ name: 'Зелена Ферма', phone: '0888123456', signals: [{ label: 'Няма активни продукти', action: 'Помогни да качи продукти' }] }] },
      '2026-06-30',
    );
    expect(r.html).toContain('Зелена Ферма');
    expect(r.html).toContain('0888123456');
    expect(r.html).toContain('Помогни да качи продукти');
    expect(r.text).toContain('Зелена Ферма');
    expect(r.text).toContain('0888123456');
  });

  it('renders — for a missing phone', () => {
    const r = assembleDigest({ ...EMPTY, signals: [{ name: 'Ф', phone: null, signals: [{ label: 'l', action: 'a' }] }] }, '2026-06-30');
    expect(r.text).toContain('—');
  });

  it('escapes HTML in farm names', () => {
    const r = assembleDigest({ ...EMPTY, signals: [{ name: 'A & <b>', phone: null, signals: [{ label: 'l', action: 'a' }] }] }, '2026-06-30');
    expect(r.html).toContain('A &amp; &lt;b&gt;');
    expect(r.html).not.toContain('<b>');
  });

  it('omits the stuck-drafts section when there are none but shows it when present', () => {
    expect(assembleDigest({ ...EMPTY, pulse: { ...EMPTY.pulse, orders24h: 1 } }, '2026-06-30').html).not.toContain('Заседнали доставки');
    const withDrafts = assembleDigest({ ...EMPTY, stuckDrafts: [{ farmerName: 'Иван', tenantName: 'Ферма Х', count: 3, oldestAt: new Date() }] }, '2026-06-30');
    expect(withDrafts.html).toContain('Заседнали доставки');
    expect(withDrafts.html).toContain('Иван');
    expect(withDrafts.html).toContain('Ферма Х');
  });
});
