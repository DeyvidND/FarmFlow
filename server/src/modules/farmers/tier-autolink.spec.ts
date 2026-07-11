import { effectiveTier } from './tier-autolink';

describe('effectiveTier', () => {
  it('keeps current tier when branding off and no explicit tier', () => {
    expect(effectiveTier({ currentTier: 1, brandingEnabled: false })).toBe(1);
  });
  it('bumps to 2 when branding enabled and no explicit tier', () => {
    expect(effectiveTier({ currentTier: 1, brandingEnabled: true })).toBe(2);
  });
  it('never downgrades below current when branding enabled', () => {
    expect(effectiveTier({ currentTier: 3, brandingEnabled: true })).toBe(3);
  });
  it('respects an explicit tier verbatim, even below the branding floor', () => {
    expect(effectiveTier({ currentTier: 2, brandingEnabled: true, explicitTier: 1 })).toBe(1);
  });
  it('respects an explicit upgrade', () => {
    expect(effectiveTier({ currentTier: 1, brandingEnabled: false, explicitTier: 3 })).toBe(3);
  });
});
