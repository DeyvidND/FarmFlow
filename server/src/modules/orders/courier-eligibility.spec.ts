import { farmerCourierReady, farmerDeliveryNamespace } from './courier-eligibility';

describe('farmerDeliveryNamespace', () => {
  it('reads the per-farmer sub-namespace from tenant settings', () => {
    const settings = { delivery: { farmers: { f1: { econt: { configured: true } } } } };
    expect(farmerDeliveryNamespace(settings, 'f1')).toEqual({ econt: { configured: true } });
  });
  it('returns undefined when absent / settings null', () => {
    expect(farmerDeliveryNamespace(null, 'f1')).toBeUndefined();
    expect(farmerDeliveryNamespace({ delivery: {} }, 'f1')).toBeUndefined();
    expect(farmerDeliveryNamespace({ delivery: { farmers: {} } }, 'f1')).toBeUndefined();
  });
});

describe('farmerCourierReady', () => {
  it('false when no carrier configured', () => {
    expect(farmerCourierReady(undefined)).toBe(false);
    expect(farmerCourierReady({})).toBe(false);
    expect(farmerCourierReady({ econt: { configured: false } })).toBe(false);
  });
  it('true when econt OR speedy connected', () => {
    expect(farmerCourierReady({ econt: { configured: true } })).toBe(true);
    expect(farmerCourierReady({ speedy: { configured: true } })).toBe(true);
  });
});
