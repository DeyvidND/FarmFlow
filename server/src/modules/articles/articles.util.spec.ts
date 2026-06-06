import { slugify } from './articles.util';

describe('slugify', () => {
  it('transliterates Bulgarian Cyrillic to a Latin slug', () => {
    expect(slugify('Ябълки')).toBe('yabalki');
    expect(slugify('Череши')).toBe('chereshi');
    expect(slugify('Домашно сладко малина')).toBe('domashno-sladko-malina');
  });

  it('lowercases, trims and collapses separators', () => {
    expect(slugify('  Hello   World!! ')).toBe('hello-world');
  });

  it('returns an empty string when nothing is transliterable (callers add their own fallback)', () => {
    // Regression: this used to return the hardcoded 'article', which made
    // every module's own fallback (e.g. products' 'produkt') dead code.
    expect(slugify('????')).toBe('');
    expect(slugify('   ')).toBe('');
    expect(slugify('')).toBe('');
    expect(slugify('!@#$%')).toBe('');
  });
});
