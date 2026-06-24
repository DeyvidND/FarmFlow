import { validateRow } from './import.validate';
import type { NormalizedRow } from './import.types';

const base: NormalizedRow = {
  rowIndex: 1, receiverName: 'Иван', receiverPhone: '+359888123456',
  deliveryMode: 'office', city: 'Бургас', office: 'Изгрев', address: null, streetNo: null,
  weightGrams: 1000, contents: 'Зеленчуци', codAmountStotinki: null,
  declaredValueStotinki: null, carrier: 'econt', raw: {},
};

describe('validateRow', () => {
  it('passes a complete office row', () => {
    expect(validateRow(base).status).toBe('ok');
  });

  it('errors on missing name', () => {
    const v = validateRow({ ...base, receiverName: '' });
    expect(v.status).toBe('error');
    expect(v.issues.some((i) => i.field === 'receiverName')).toBe(true);
  });

  it('errors on invalid phone', () => {
    const v = validateRow({ ...base, receiverPhone: 'abc' });
    expect(v.status).toBe('error');
    expect(v.issues.some((i) => i.field === 'receiverPhone')).toBe(true);
  });

  it('errors when deliveryMode is missing', () => {
    const v = validateRow({ ...base, deliveryMode: null });
    expect(v.status).toBe('error');
    expect(v.issues.some((i) => i.field === 'deliveryMode')).toBe(true);
  });

  it('errors when office mode but no office', () => {
    const v = validateRow({ ...base, office: null });
    expect(v.status).toBe('error');
    expect(v.issues.some((i) => i.field === 'office')).toBe(true);
  });

  it('errors when address mode but no city or address', () => {
    const v = validateRow({ ...base, deliveryMode: 'address', office: null, city: null, address: null });
    expect(v.issues.some((i) => i.field === 'city')).toBe(true);
    expect(v.issues.some((i) => i.field === 'address')).toBe(true);
  });

  it('warns (not errors) on a missing weight', () => {
    const v = validateRow({ ...base, weightGrams: null });
    expect(v.status).toBe('warn');
    expect(v.issues.some((i) => i.field === 'weightGrams')).toBe(true);
  });
});
