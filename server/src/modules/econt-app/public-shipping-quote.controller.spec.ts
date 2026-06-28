import { PublicShippingQuoteController } from './public-shipping-quote.controller';

const makeStubs = () => ({
  db: {} as any,
  tenantCache: { resolveTenant: jest.fn() } as any,
  quote: { compare: jest.fn() } as any,
});

const DTO = { destinationCity: 'Sofia', deliveryMode: 'address' as const };

describe('PublicShippingQuoteController.compare', () => {
  it('returns empty quotes and does NOT call quote.compare when comparisonActive is false', async () => {
    const { db, tenantCache, quote } = makeStubs();
    (tenantCache.resolveTenant as jest.Mock).mockResolvedValue({
      id: 't1',
      comparisonActive: false,
      carrierPolicy: 'customer',
    });

    const ctrl = new PublicShippingQuoteController(db, tenantCache, quote);
    const result = await ctrl.compare('test-farm', DTO);

    expect(result).toEqual({ quotes: [], cheapest: null, policy: 'customer', selected: null });
    expect((quote.compare as jest.Mock)).not.toHaveBeenCalled();
  });

  it('delegates to quote.compare with tenantId and dto when comparisonActive is true', async () => {
    const { db, tenantCache, quote } = makeStubs();
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

    const ctrl = new PublicShippingQuoteController(db, tenantCache, quote);
    const result = await ctrl.compare('test-farm', DTO);

    expect((quote.compare as jest.Mock)).toHaveBeenCalledWith('t1', DTO, 'cheapest', 200);
    expect(result).toBe(quoteResult);
  });
});
