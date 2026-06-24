import { normalizeRow, normalizeBgPhone, toStotinki } from './import.normalize';
import type { BatchDefaults, RawRow } from './import.types';

const defaults: BatchDefaults = { carrier: 'econt', currency: 'EUR', weightGrams: 1000 };

describe('normalizeBgPhone', () => {
  it('keeps a valid +359 mobile', () => {
    expect(normalizeBgPhone('+359888123456')).toBe('+359888123456');
  });
  it('converts 08... to +359...', () => {
    expect(normalizeBgPhone('0888123456')).toBe('+359888123456');
  });
  it('converts 359... to +359...', () => {
    expect(normalizeBgPhone('359888123456')).toBe('+359888123456');
  });
  it('strips spaces/dashes', () => {
    expect(normalizeBgPhone('088 812-34-56')).toBe('+359888123456');
  });
  it('returns null for garbage', () => {
    expect(normalizeBgPhone('hello')).toBeNull();
  });
});

describe('toStotinki', () => {
  it('EUR decimal → cents', () => {
    expect(toStotinki('12.50', 'EUR')).toBe(1250);
  });
  it('BGN → EUR cents at the fixed rate', () => {
    // 19.5583 BGN / 1.95583 = 10.00 EUR → 1000
    expect(toStotinki('19.5583', 'BGN')).toBe(1000);
  });
  it('blank → null', () => {
    expect(toStotinki('', 'EUR')).toBeNull();
  });
  it('non-numeric → null', () => {
    expect(toStotinki('abc', 'EUR')).toBeNull();
  });
});

describe('normalizeRow', () => {
  it('maps fields, applies defaults, normalizes phone + money', () => {
    const raw: RawRow = {
      name: 'Иван', phone: '0888123456', mode: 'офис', city: 'Бургас',
      office: 'Изгрев', cod: '20', weight: '2',
    };
    const out = normalizeRow(raw, 3, defaults);
    expect(out).toMatchObject({
      rowIndex: 3,
      receiverName: 'Иван',
      receiverPhone: '+359888123456',
      deliveryMode: 'office',
      city: 'Бургас',
      office: 'Изгрев',
      weightGrams: 2000,
      codAmountStotinki: 2000,
      carrier: 'econt',
    });
  });

  it('falls back to batch defaults for blank weight/contents/carrier', () => {
    const out = normalizeRow({ name: 'A', phone: '0888', mode: 'address' }, 1, {
      ...defaults, contents: 'Зеленчуци', carrier: 'speedy',
    });
    expect(out.weightGrams).toBe(1000);
    expect(out.contents).toBe('Зеленчуци');
    expect(out.carrier).toBe('speedy');
  });

  it('keeps deliveryMode null when unparseable', () => {
    const out = normalizeRow({ name: 'A', phone: '0888', mode: 'хеликоптер' }, 1, defaults);
    expect(out.deliveryMode).toBeNull();
  });

  it('parses an EN carrier value case-insensitively', () => {
    const out = normalizeRow({ name: 'A', phone: '0888', carrier: 'Speedy' }, 1, defaults);
    expect(out.carrier).toBe('speedy');
  });
});
