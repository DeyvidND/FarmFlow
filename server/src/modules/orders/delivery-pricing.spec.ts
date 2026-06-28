import {
  methodBaseFee,
  freeThresholdStotinki,
  applyFreeThreshold,
  localFeeStotinki,
  econtFallbackFee,
  buildPublicDelivery,
  courierMarkupStotinki,
  codEnabled,
  DELIVERY_DEFAULTS,
  type DeliveryConfig,
  speedyEnabled,
  comparisonActive,
  courierDoorEnabled,
  carrierPolicy,
} from './delivery-pricing';

describe('delivery-pricing', () => {
  describe('methodBaseFee', () => {
    it('returns the fallback when pricing is missing or has no type', () => {
      expect(methodBaseFee(undefined, 490)).toBe(490);
      expect(methodBaseFee({}, 490)).toBe(490);
    });
    it('free → 0', () => {
      expect(methodBaseFee({ type: 'free' }, 490)).toBe(0);
    });
    it('flat → feeStotinki (or fallback when unset)', () => {
      expect(methodBaseFee({ type: 'flat', feeStotinki: 600 }, 490)).toBe(600);
      expect(methodBaseFee({ type: 'flat' }, 490)).toBe(490);
    });
    it('freeOver and legacy/unknown types are treated as flat (per-method free-over ignored)', () => {
      // `freeOver` was removed from the union but may still exist in old saved configs.
      expect(methodBaseFee({ type: 'freeOver' as never, feeStotinki: 700 }, 490)).toBe(700);
      // `byWeight` was removed from the union but may still exist in old saved configs.
      expect(methodBaseFee({ type: 'byWeight' as never, feeStotinki: 800 }, 490)).toBe(800);
    });
  });

  describe('freeThresholdStotinki', () => {
    it('defaults to 4000 when unset', () => {
      expect(freeThresholdStotinki(null)).toBe(4000);
      expect(freeThresholdStotinki({})).toBe(4000);
    });
    it('honors an explicit value, including 0 (disables free delivery)', () => {
      expect(freeThresholdStotinki({ pricing: { freeThresholdStotinki: 3000 } })).toBe(3000);
      expect(freeThresholdStotinki({ pricing: { freeThresholdStotinki: 0 } })).toBe(0);
    });
  });

  describe('applyFreeThreshold', () => {
    it('zeroes the fee at or above the threshold', () => {
      expect(applyFreeThreshold(490, 4000, 4000)).toBe(0);
      expect(applyFreeThreshold(490, 5000, 4000)).toBe(0);
    });
    it('keeps the fee below the threshold', () => {
      expect(applyFreeThreshold(490, 3999, 4000)).toBe(490);
    });
    it('threshold 0 never makes delivery free', () => {
      expect(applyFreeThreshold(490, 999999, 0)).toBe(490);
    });
  });

  describe('localFeeStotinki', () => {
    it('unconfigured tenant: 490, free over 40', () => {
      expect(localFeeStotinki(null, 1000)).toBe(490);
      expect(localFeeStotinki(null, 4000)).toBe(0);
    });
    it('free self-delivery → always 0', () => {
      const cfg: DeliveryConfig = { methods: { ownSlots: { pricing: { type: 'free' } } } };
      expect(localFeeStotinki(cfg, 100)).toBe(0);
    });
    it('flat self-delivery + custom threshold', () => {
      const cfg: DeliveryConfig = {
        methods: { ownSlots: { pricing: { type: 'flat', feeStotinki: 600 } } },
        pricing: { freeThresholdStotinki: 3000 },
      };
      expect(localFeeStotinki(cfg, 2999)).toBe(600);
      expect(localFeeStotinki(cfg, 3000)).toBe(0);
    });
  });

  describe('econtFallbackFee', () => {
    it('defaults to 350 (office) / 590 (door)', () => {
      expect(econtFallbackFee(null, false)).toBe(350);
      expect(econtFallbackFee(null, true)).toBe(590);
    });
    it('uses the configured flat fee', () => {
      const cfg: DeliveryConfig = {
        methods: { econtOffice: { pricing: { type: 'flat', feeStotinki: 400 } } },
      };
      expect(econtFallbackFee(cfg, false)).toBe(400);
    });
  });

  describe('codEnabled', () => {
    it('defaults to true when unset (cash-first farms)', () => {
      expect(codEnabled(null)).toBe(true);
      expect(codEnabled({})).toBe(true);
      expect(codEnabled({ cod: {} })).toBe(true);
    });

    it('respects an explicit flag', () => {
      expect(codEnabled({ cod: { enabled: false } })).toBe(false);
      expect(codEnabled({ cod: { enabled: true } })).toBe(true);
    });
  });

  describe('buildPublicDelivery', () => {
    it('unconfigured tenant → legacy defaults', () => {
      expect(buildPublicDelivery(null)).toEqual({
        freeThresholdStotinki: DELIVERY_DEFAULTS.freeThresholdStotinki,
        addressFeeStotinki: DELIVERY_DEFAULTS.addressFeeStotinki,
        econtFeeStotinki: DELIVERY_DEFAULTS.econtFeeStotinki,
        econtAddressFeeStotinki: DELIVERY_DEFAULTS.econtAddressFeeStotinki,
      });
    });
    it('reflects configured local-free + threshold', () => {
      const cfg: DeliveryConfig = {
        methods: { ownSlots: { pricing: { type: 'free' } } },
        pricing: { freeThresholdStotinki: 3000 },
      };
      const pub = buildPublicDelivery(cfg);
      expect(pub.addressFeeStotinki).toBe(0);
      expect(pub.freeThresholdStotinki).toBe(3000);
    });
  });
});

describe('carrier-comparison helpers', () => {
  it('speedyEnabled true only when speedy.configured', () => {
    expect(speedyEnabled({ speedy: { configured: true } } as any)).toBe(true);
    expect(speedyEnabled({ speedy: { configured: false } } as any)).toBe(false);
    expect(speedyEnabled(null)).toBe(false);
  });
  it('comparisonActive needs econt auto AND speedy configured', () => {
    expect(comparisonActive({ econt: { mode: 'auto' }, speedy: { configured: true } } as any)).toBe(true);
    expect(comparisonActive({ econt: { mode: 'manual' }, speedy: { configured: true } } as any)).toBe(false);
    expect(comparisonActive({ econt: { mode: 'auto' } } as any)).toBe(false);
  });
  it('courierDoorEnabled when econtAddress method on OR speedy configured', () => {
    expect(courierDoorEnabled({ methods: { econtAddress: { enabled: true } } } as any)).toBe(true);
    expect(courierDoorEnabled({ speedy: { configured: true } } as any)).toBe(true);
    expect(courierDoorEnabled({} as any)).toBe(false);
  });
  it('carrierPolicy defaults to customer; echoes a valid saved policy; rejects junk', () => {
    expect(carrierPolicy(null)).toBe('customer');
    expect(carrierPolicy({} as any)).toBe('customer');
    expect(carrierPolicy({ carrierPolicy: 'cheapest' } as any)).toBe('cheapest');
    expect(carrierPolicy({ carrierPolicy: 'econt' } as any)).toBe('econt');
    expect(carrierPolicy({ carrierPolicy: 'speedy' } as any)).toBe('speedy');
    expect(carrierPolicy({ carrierPolicy: 'bogus' } as any)).toBe('customer');
  });
  it('courierMarkupStotinki defaults to 0; reads a positive value; ignores negatives/garbage', () => {
    expect(courierMarkupStotinki(null)).toBe(0);
    expect(courierMarkupStotinki({} as any)).toBe(0);
    expect(courierMarkupStotinki({ pricing: { courierMarkupStotinki: 150 } } as any)).toBe(150);
    expect(courierMarkupStotinki({ pricing: { courierMarkupStotinki: -50 } } as any)).toBe(0);
    expect(courierMarkupStotinki({ pricing: { courierMarkupStotinki: 12.6 } } as any)).toBe(13); // rounded
  });
  it('buildPublicDelivery adds markup to courier fees only (not local self-delivery)', () => {
    const pub = buildPublicDelivery({ pricing: { courierMarkupStotinki: 100 } } as any);
    // courier fees = DELIVERY_DEFAULTS (350 / 590) + markup 100
    expect(pub.econtFeeStotinki).toBe(450);
    expect(pub.econtAddressFeeStotinki).toBe(690);
    // local self-delivery fee is untouched by courier markup
    expect(pub.addressFeeStotinki).toBe(DELIVERY_DEFAULTS.addressFeeStotinki);
  });
});
