import { normalizeLegal } from './legal';

describe('normalizeLegal', () => {
  it('stamps confirmedAt and passes through the given fields', () => {
    const out = normalizeLegal({ kind: 'company', name: 'ЕООД Тест', eik: '111' });
    expect(out.confirmedAt).toBeDefined();
    expect(new Date(out.confirmedAt!).toString()).not.toBe('Invalid Date');
    expect(out).toMatchObject({ kind: 'company', name: 'ЕООД Тест', eik: '111' });
  });

  it('drops blank/whitespace-only optional fields to undefined', () => {
    const out = normalizeLegal({ name: '  ', eik: '', address: '  гр. Варна  ' });
    expect(out.name).toBeUndefined();
    expect(out.eik).toBeUndefined();
    expect(out.address).toBe('гр. Варна');
  });
});
