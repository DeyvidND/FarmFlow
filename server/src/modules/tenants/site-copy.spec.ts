// server/src/modules/tenants/site-copy.spec.ts
import { cleanCopy, normalizeFaq } from './site-copy';

describe('site-copy helpers', () => {
  it('cleanCopy keeps known keys, trims, drops empty + unknown', () => {
    const out = cleanCopy('pazar', {
      'home.hero.title': '  Ново заглавие  ',
      'home.hero.lead': '   ',
      'bogus.key': 'x',
      'home.twoways.title': 5,
    });
    expect(out).toEqual({ 'home.hero.title': 'Ново заглавие' });
  });
  it('cleanCopy returns {} for non-objects', () => {
    expect(cleanCopy('pazar', null)).toEqual({});
    expect(cleanCopy('pazar', ['a'])).toEqual({});
  });
  it('normalizeFaq trims, drops empty rows, caps at 50', () => {
    const out = normalizeFaq([
      { q: ' Q1 ', a: ' A1 ' },
      { q: '', a: '' },
      { q: 'Q2', a: '' },
      'garbage',
    ]);
    expect(out).toEqual([{ q: 'Q1', a: 'A1' }, { q: 'Q2', a: '' }]);
    expect(normalizeFaq(Array(60).fill({ q: 'x', a: 'y' })).length).toBe(50);
  });
});
