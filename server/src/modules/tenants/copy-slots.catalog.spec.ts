// server/src/modules/tenants/copy-slots.catalog.spec.ts
import { getCopyCatalog, copySlotKeys, DEFAULT_SITE_THEME } from './copy-slots.catalog';

describe('copy-slots catalog', () => {
  it('returns the pazar catalog for default/unknown themes', () => {
    expect(getCopyCatalog().length).toBeGreaterThan(0);
    expect(getCopyCatalog('nope')).toBe(getCopyCatalog(DEFAULT_SITE_THEME));
  });
  it('has unique, non-empty keys and defaults', () => {
    const cat = getCopyCatalog();
    const keys = cat.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of cat) {
      expect(s.key).toMatch(/^[a-z0-9._]+$/);
      expect(s.default.length).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(0);
    }
  });
  it('copySlotKeys reflects the catalog', () => {
    expect(copySlotKeys().has('home.hero.title')).toBe(true);
    expect(copySlotKeys().has('not.a.key')).toBe(false);
  });
});
