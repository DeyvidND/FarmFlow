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
  it('false when courier not enabled, regardless of carriers', () => {
    expect(farmerCourierReady(false, { econt: { configured: true } })).toBe(false);
  });
  it('false when enabled but no connected carrier', () => {
    expect(farmerCourierReady(true, undefined)).toBe(false);
    expect(farmerCourierReady(true, { econt: { configured: false } })).toBe(false);
    expect(farmerCourierReady(true, {})).toBe(false);
  });
  it('true when enabled and econt OR speedy connected', () => {
    expect(farmerCourierReady(true, { econt: { configured: true } })).toBe(true);
    expect(farmerCourierReady(true, { speedy: { configured: true } })).toBe(true);
  });
});
