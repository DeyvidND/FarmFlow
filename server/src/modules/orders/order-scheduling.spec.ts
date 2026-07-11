import { scheduledForRange } from './order-scheduling';

describe('scheduledForRange', () => {
  it('builds a defined SQL condition for a valid range', () => {
    const cond = scheduledForRange('2026-07-10', '2026-07-12');
    expect(cond).toBeDefined();
    // Serialized SQL should reference both the slot-date range and the slotless
    // createdAt fallback (gte/lt on orders.created_at).
    const seen = new WeakSet();
    const sql = JSON.stringify(cond, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    });
    expect(sql).toContain('date');
    expect(sql).toContain('created_at');
  });

  it('for a single-day range still includes the slotless createdAt fallback', () => {
    const cond = scheduledForRange('2026-07-10', '2026-07-10');
    const seen = new WeakSet();
    expect(JSON.stringify(cond, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    })).toContain('created_at');
  });
});
