import { describe, expect, it } from 'vitest';
import { buildOverridesToggleExclude } from './consolidated-protocol-overrides';

describe('buildOverridesToggleExclude', () => {
  it('adds an order id to excludedOrderIds', () => {
    const out = buildOverridesToggleExclude({}, 'o1', true);
    expect(out.excludedOrderIds).toEqual(['o1']);
  });

  it('does not duplicate an already-excluded order', () => {
    const out = buildOverridesToggleExclude({ excludedOrderIds: ['o1'] }, 'o1', true);
    expect(out.excludedOrderIds).toEqual(['o1']);
  });

  it('removes an order id when un-excluding', () => {
    const out = buildOverridesToggleExclude({ excludedOrderIds: ['o1', 'o2'] }, 'o1', false);
    expect(out.excludedOrderIds).toEqual(['o2']);
  });

  it('preserves extraRows/fieldOverrides untouched', () => {
    const current = { extraRows: [{ section: 'A' as const, label: 'X' }], fieldOverrides: { 'f:f1': { note: 'n' } } };
    const out = buildOverridesToggleExclude(current, 'o1', true);
    expect(out.extraRows).toBe(current.extraRows);
    expect(out.fieldOverrides).toBe(current.fieldOverrides);
  });
});
