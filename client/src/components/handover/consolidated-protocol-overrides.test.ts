import { describe, expect, it } from 'vitest';
import { buildOverridesSetFieldOverride, buildOverridesToggleExclude } from './consolidated-protocol-overrides';

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

describe('buildOverridesSetFieldOverride', () => {
  it('creates the entry on empty overrides', () => {
    const out = buildOverridesSetFieldOverride({}, 'f:f1', 'batch', 'L-42');
    expect(out.fieldOverrides).toEqual({ 'f:f1': { batch: 'L-42' } });
  });

  it('merges into an existing entry without dropping its other fields', () => {
    const out = buildOverridesSetFieldOverride(
      { fieldOverrides: { 'f:f1': { batch: 'L-42', note: 'n' } } },
      'f:f1',
      'eDoc',
      'ЕД-7',
    );
    expect(out.fieldOverrides).toEqual({ 'f:f1': { batch: 'L-42', note: 'n', eDoc: 'ЕД-7' } });
  });

  it('leaves other rows of the map untouched', () => {
    const out = buildOverridesSetFieldOverride(
      { fieldOverrides: { 'o:o1': { note: 'x' } } },
      'f:f1',
      'batch',
      'L-1',
    );
    expect(out.fieldOverrides).toEqual({ 'o:o1': { note: 'x' }, 'f:f1': { batch: 'L-1' } });
  });

  it('trims the value', () => {
    const out = buildOverridesSetFieldOverride({}, 'f:f1', 'batch', '  L-42  ');
    expect(out.fieldOverrides).toEqual({ 'f:f1': { batch: 'L-42' } });
  });

  it('clears the field on empty/whitespace value', () => {
    const out = buildOverridesSetFieldOverride(
      { fieldOverrides: { 'f:f1': { batch: 'L-42', note: 'n' } } },
      'f:f1',
      'batch',
      '   ',
    );
    expect(out.fieldOverrides).toEqual({ 'f:f1': { note: 'n' } });
  });

  it('drops the entry entirely when its last field is cleared', () => {
    const out = buildOverridesSetFieldOverride(
      { fieldOverrides: { 'f:f1': { batch: 'L-42' } } },
      'f:f1',
      'batch',
      '',
    );
    expect(out.fieldOverrides).toEqual({});
  });

  it('clearing a field that was never set is a no-op entry-wise', () => {
    const out = buildOverridesSetFieldOverride({}, 'f:f1', 'eDoc', '');
    expect(out.fieldOverrides).toEqual({});
  });

  it('preserves excludedOrderIds/extraRows by reference and never mutates the input', () => {
    const current = {
      excludedOrderIds: ['o1'],
      extraRows: [{ section: 'A' as const, label: 'X' }],
      fieldOverrides: { 'f:f1': { batch: 'old' } },
    };
    const out = buildOverridesSetFieldOverride(current, 'f:f1', 'batch', 'new');
    expect(out.excludedOrderIds).toBe(current.excludedOrderIds);
    expect(out.extraRows).toBe(current.extraRows);
    expect(current.fieldOverrides).toEqual({ 'f:f1': { batch: 'old' } });
    expect(out.fieldOverrides).toEqual({ 'f:f1': { batch: 'new' } });
  });
});
