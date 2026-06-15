// server/src/modules/tenants/site-copy.spec.ts
import { cleanCopy, normalizeFaq, sanitizeSiteUrl, isValidSlotKey } from './site-copy';

describe('site-copy helpers (slot-agnostic)', () => {
  it('cleanCopy keeps pattern-valid keys, trims, drops empty/bad', () => {
    expect(cleanCopy({ 'home.hero.title': '  Hi  ', 'home.hero.lead': '  ', 'bad key!': 'x', n: 5 }))
      .toEqual({ 'home.hero.title': 'Hi' });
  });
  it('cleanCopy returns {} for non-objects', () => {
    expect(cleanCopy(null)).toEqual({});
    expect(cleanCopy(['a'])).toEqual({});
  });
  it('normalizeFaq trims, drops empty, caps 50', () => {
    expect(normalizeFaq([{ q: ' Q ', a: ' A ' }, { q: '', a: '' }])).toEqual([{ q: 'Q', a: 'A' }]);
    expect(normalizeFaq(Array(60).fill({ q: 'x', a: 'y' })).length).toBe(50);
  });
  it('sanitizeSiteUrl allows http(s), strips trailing slash, rejects others', () => {
    expect(sanitizeSiteUrl('https://pazar.bg/')).toBe('https://pazar.bg');
    expect(sanitizeSiteUrl('http://a.test/x')).toBe('http://a.test/x');
    expect(sanitizeSiteUrl('javascript:alert(1)')).toBe('');
    expect(sanitizeSiteUrl('data:text/html,x')).toBe('');
    expect(sanitizeSiteUrl('not a url')).toBe('');
    expect(sanitizeSiteUrl('')).toBe('');
  });
  it('isValidSlotKey guards', () => {
    expect(isValidSlotKey('about.gallery_stalls')).toBe(true);
    expect(isValidSlotKey('site.pillar_market')).toBe(true);
    expect(isValidSlotKey('bad key')).toBe(false);
  });
});
