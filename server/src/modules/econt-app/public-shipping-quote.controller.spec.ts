import { PublicShippingQuoteController } from './public-shipping-quote.controller';

const makeStubs = () => {
  const limit = jest.fn();
  const where = jest.fn(() => ({ limit }));
  const from = jest.fn(() => ({ where }));
  const select = jest.fn(() => ({ from }));
  return {
    db: { select } as any,
    tenantCache: { resolveTenant: jest.fn() } as any,
    quote: { compare: jest.fn() } as any,
    maps: { geocodeCity: jest.fn() } as any,
    dbChain: { select, from, where, limit },
  };
};

const DTO = { destinationCity: 'Sofia', deliveryMode: 'address' as const };

describe('PublicShippingQuoteController.compare', () => {
  it('returns empty quotes and does NOT call quote.compare when comparisonActive is false', async () => {
    const { db, tenantCache, quote, maps } = makeStubs();
    (tenantCache.resolveTenant as jest.Mock).mockResolvedValue({
      id: 't1',
      comparisonActive: false,
      carrierPolicy: 'customer',
    });

    const ctrl = new PublicShippingQuoteController(db, tenantCache, quote, maps);
    const result = await ctrl.compare('test-farm', DTO);

    expect(result).toEqual({ quotes: [], cheapest: null, policy: 'customer', selected: null });
    expect((quote.compare as jest.Mock)).not.toHaveBeenCalled();
  });

  it('delegates to quote.compare with tenantId and dto when comparisonActive is true (city present, no geocode)', async () => {
    const { db, tenantCache, quote, maps, dbChain } = makeStubs();
    const quoteResult = {
      quotes: [{ carrier: 'econt', stotinki: 500 }],
      cheapest: 'econt',
    };
    (tenantCache.resolveTenant as jest.Mock).mockResolvedValue({
      id: 't1',
      comparisonActive: true,
      carrierPolicy: 'cheapest',
      courierMarkupStotinki: 200,
    });
    (quote.compare as jest.Mock).mockResolvedValue(quoteResult);

    const ctrl = new PublicShippingQuoteController(db, tenantCache, quote, maps);
    const result = await ctrl.compare('test-farm', DTO);

    expect((quote.compare as jest.Mock)).toHaveBeenCalledWith('t1', DTO, 'cheapest', 200);
    expect(result).toBe(quoteResult);
    expect(maps.geocodeCity).not.toHaveBeenCalled();
    expect(dbChain.select).not.toHaveBeenCalled();
  });

  it('geocodes a typed destinationAddress (no city) and delegates with the resolved city', async () => {
    const { db, tenantCache, quote, maps, dbChain } = makeStubs();
    (tenantCache.resolveTenant as jest.Mock).mockResolvedValue({
      id: 't1',
      comparisonActive: true,
      carrierPolicy: 'customer',
      courierMarkupStotinki: 0,
    });
    dbChain.limit.mockResolvedValue([{ farmLat: '43.2', farmLng: '27.9' }]);
    (maps.geocodeCity as jest.Mock).mockResolvedValue('Варна');
    (quote.compare as jest.Mock).mockResolvedValue({ quotes: [], cheapest: null });

    const ctrl = new PublicShippingQuoteController(db, tenantCache, quote, maps);
    const addrDto = { destinationAddress: 'ул. Дунав 5, Варна', deliveryMode: 'address' as const };
    await ctrl.compare('test-farm', addrDto as any);

    expect(maps.geocodeCity).toHaveBeenCalledWith('ул. Дунав 5, Варна', { lat: 43.2, lng: 27.9 });
    expect((quote.compare as jest.Mock)).toHaveBeenCalledWith(
      't1',
      { ...addrDto, destinationCity: 'Варна' },
      'customer',
      0,
    );
  });

  it('returns empty quotes without calling quote.compare when geocoding misses', async () => {
    const { db, tenantCache, quote, maps, dbChain } = makeStubs();
    (tenantCache.resolveTenant as jest.Mock).mockResolvedValue({
      id: 't1',
      comparisonActive: true,
      carrierPolicy: 'customer',
    });
    dbChain.limit.mockResolvedValue([{ farmLat: null, farmLng: null }]);
    (maps.geocodeCity as jest.Mock).mockResolvedValue(null);

    const ctrl = new PublicShippingQuoteController(db, tenantCache, quote, maps);
    const result = await ctrl.compare('test-farm', {
      destinationAddress: 'ул. Дунав 5, Варна',
      deliveryMode: 'address',
    } as any);

    expect(result).toEqual({ quotes: [], cheapest: null, policy: 'customer', selected: null });
    expect((quote.compare as jest.Mock)).not.toHaveBeenCalled();
  });

  it('rejects a garbage/non-street destinationAddress before ever calling geocode', async () => {
    const { db, tenantCache, quote, maps } = makeStubs();
    (tenantCache.resolveTenant as jest.Mock).mockResolvedValue({
      id: 't1',
      comparisonActive: true,
      carrierPolicy: 'customer',
    });

    const ctrl = new PublicShippingQuoteController(db, tenantCache, quote, maps);
    const result = await ctrl.compare('test-farm', {
      destinationAddress: 'Варна',
      deliveryMode: 'address',
    } as any);

    expect(result).toEqual({ quotes: [], cheapest: null, policy: 'customer', selected: null });
    expect(maps.geocodeCity).not.toHaveBeenCalled();
    expect((quote.compare as jest.Mock)).not.toHaveBeenCalled();
  });
});
