import { slugifyFarm, econtTenantSettings, isEcontAccountActive, withEcontActive } from './econt-app.helpers';

describe('slugifyFarm', () => {
  it('transliterates + kebab-cases a Bulgarian name', () => {
    expect(slugifyFarm('Ферма Петрови!!')).toMatch(/^[a-z0-9-]+$/);
    expect(slugifyFarm('  Hello World  ')).toBe('hello-world');
  });
  it('falls back when empty after stripping', () => {
    expect(slugifyFarm('!!!').length).toBeGreaterThan(0);
  });
});

describe('econtTenantSettings', () => {
  it('marks the product + inactive account + econt manual mode', () => {
    const s = econtTenantSettings();
    expect(s.product).toBe('econt-standalone');
    expect(s.econtApp).toEqual({ active: false });
    expect((s.delivery as any).econt.mode).toBe('manual');
  });
});

describe('isEcontAccountActive', () => {
  it('true only when econtApp.active === true', () => {
    expect(isEcontAccountActive({ econtApp: { active: true } })).toBe(true);
    expect(isEcontAccountActive({ econtApp: { active: false } })).toBe(false);
    expect(isEcontAccountActive({})).toBe(false);
    expect(isEcontAccountActive(null)).toBe(false);
  });
});

describe('withEcontActive', () => {
  it('sets the flag without dropping other settings', () => {
    const next = withEcontActive({ product: 'econt-standalone', foo: 1 }, true);
    expect(next.econtApp).toEqual({ active: true });
    expect(next.foo).toBe(1);
  });
});
