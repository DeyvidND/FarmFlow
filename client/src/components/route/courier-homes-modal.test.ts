import { describe, expect, it } from 'vitest';
import { mergeCourierRows } from './courier-homes-modal';

const row = (homeAddress: string, lat?: number, lng?: number) => ({
  homeAddress,
  homePin: lat != null && lng != null ? { lat, lng } : null,
});

describe('mergeCourierRows', () => {
  it('sends only the edited rows when there is nothing to carry over', () => {
    const out = mergeCourierRows([row('адрес 1'), row('адрес 2')], []);
    expect(out).toHaveLength(2);
    expect(out[0].homeAddress).toBe('адрес 1');
    expect(out[1].homeAddress).toBe('адрес 2');
  });

  it('does NOT wipe a higher-index courier not active (visible) today', () => {
    // Tenant has 3 couriers configured; today is a lighter day with only 2
    // active — the modal only shows/edits rows for those 2.
    const original = [
      { name: 'Иван', homeAddress: 'адрес А', homeLat: '43.1', homeLng: '27.9' },
      { name: 'Петър', homeAddress: 'адрес Б', homeLat: '43.2', homeLng: '27.8' },
      { name: 'Георги', homeAddress: 'адрес В', homeLat: '43.3', homeLng: '27.7' },
    ];
    const editedRows = [row('нов адрес А', 43.15, 27.95), row('адрес Б', 43.2, 27.8)];

    const out = mergeCourierRows(editedRows, original);

    expect(out).toHaveLength(3);
    // Rows 0-1 reflect the edit.
    expect(out[0].homeAddress).toBe('нов адрес А');
    expect(out[0].homeLat).toBe('43.15');
    // Row 2 (Георги, not shown/edited today) is carried over UNCHANGED —
    // this is the fix: previously only 2 rows were sent, wiping index 2.
    expect(out[2]).toEqual(original[2]);
  });

  it('does not wipe a field this modal never edits — the per-courier start base', () => {
    // «Тръгва от» (startAddress/startLat/startLng) is owned by CourierStartsModal.
    // Saving „Домове на куриерите" must not touch it: the server replaces the
    // stored couriers array wholesale, so a dropped field is a deleted field.
    const original = [
      {
        name: 'Иван',
        homeAddress: 'адрес А',
        homeLat: '43.1',
        homeLng: '27.9',
        startAddress: 'Каварна, ул. Добротица 5',
        startLat: '43.43',
        startLng: '28.34',
      },
    ];

    const out = mergeCourierRows([row('нов адрес А', 43.15, 27.95)], original);

    // The home fields are the edit...
    expect(out[0].homeAddress).toBe('нов адрес А');
    // ...and the start base survives it untouched.
    expect(out[0].startAddress).toBe('Каварна, ул. Добротица 5');
    expect(out[0].startLat).toBe('43.43');
    expect(out[0].startLng).toBe('28.34');
  });

  it('lets an edited row clear its home (address + pin both cleared)', () => {
    const original = [{ name: 'Иван', homeAddress: 'адрес А', homeLat: '43.1', homeLng: '27.9' }];
    const out = mergeCourierRows([row('')], original);
    expect(out[0].homeAddress).toBeNull();
    expect(out[0].homeLat).toBeNull();
    expect(out[0].homeLng).toBeNull();
  });

  it('handles more edited rows than originally loaded (courier count increased)', () => {
    const out = mergeCourierRows([row('a'), row('b'), row('c')], [{ homeAddress: 'a', homeLat: null, homeLng: null }]);
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.homeAddress)).toEqual(['a', 'b', 'c']);
  });
});
