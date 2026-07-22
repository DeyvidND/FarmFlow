import { describe, expect, it } from 'vitest';
import { META_FIELDS, META_LABELS, isMetaDirty, seedMetaForm } from './consolidated-protocol-meta';

describe('seedMetaForm', () => {
  it('fills every field, absent keys becoming empty strings', () => {
    const form = seedMetaForm({ vehicle: 'Форд', plannedEnd: '20:00' });
    expect(form.vehicle).toBe('Форд');
    expect(form.plannedEnd).toBe('20:00');
    expect(form.plate).toBe('');
    expect(Object.keys(form).sort()).toEqual([...META_FIELDS].sort());
  });

  it('handles a missing meta object entirely', () => {
    const form = seedMetaForm(undefined);
    for (const f of META_FIELDS) expect(form[f]).toBe('');
  });
});

describe('isMetaDirty', () => {
  it('flags a single changed field', () => {
    const saved = seedMetaForm({ vehicle: 'Форд' });
    const edited = { ...saved, plate: 'В1234АВ' };
    expect(isMetaDirty(edited, saved)).toBe(true);
  });

  it('is clean when every field matches', () => {
    const saved = seedMetaForm({ vehicle: 'Форд', plate: 'В1234АВ' });
    expect(isMetaDirty({ ...saved }, saved)).toBe(false);
  });

  it('with nothing saved yet, an all-empty form is clean and any content is dirty', () => {
    const empty = seedMetaForm(undefined);
    expect(isMetaDirty(empty, null)).toBe(false);
    expect(isMetaDirty({ ...empty, vehicle: 'Форд' }, null)).toBe(true);
  });
});

describe('META_LABELS', () => {
  it('labels every field in Bulgarian — operators must never see raw English keys', () => {
    for (const f of META_FIELDS) {
      expect(META_LABELS[f]).toMatch(/[А-Яа-я]/);
    }
  });
});
