import { ShippingQuoteService } from './shipping-quote.service';

describe('ShippingQuoteService', () => {
  function makeEcont(price: number | null = 490) {
    return { estimateShipping: jest.fn().mockResolvedValue(price) };
  }

  function makeSpeedy(price: number | null = 420, sites: { id: number; name: string }[] = [{ id: 100, name: 'Варна' }]) {
    return {
      searchSites: jest.fn().mockResolvedValue(sites),
      estimateShipping: jest.fn().mockResolvedValue(price),
    };
  }

  it('returns both carrier quotes sorted cheapest-first', async () => {
    const svc = new ShippingQuoteService(makeEcont(490) as any, makeSpeedy(420) as any);
    const result = await svc.compare('t1', { destinationCity: 'Варна', deliveryMode: 'address' });
    expect(result.quotes[0].carrier).toBe('speedy');
    expect(result.quotes[0].priceStotinki).toBe(420);
    expect(result.cheapest).toBe('speedy');
  });

  it('degrades gracefully when speedy has no site match', async () => {
    const svc = new ShippingQuoteService(makeEcont(490) as any, makeSpeedy(420, []) as any);
    const result = await svc.compare('t1', { destinationCity: 'Непознат', deliveryMode: 'address' });
    expect(result.cheapest).toBe('econt');
    expect(result.quotes.find((q) => q.carrier === 'speedy')?.available).toBe(false);
  });

  it('degrades gracefully when speedy throws (not configured)', async () => {
    const speedy = {
      searchSites: jest.fn().mockRejectedValue(new Error('Speedy not configured')),
      estimateShipping: jest.fn(),
    };
    const svc = new ShippingQuoteService(makeEcont(490) as any, speedy as any);
    const result = await svc.compare('t1', { destinationCity: 'Варна', deliveryMode: 'address' });
    expect(result.cheapest).toBe('econt');
  });

  it('forwards codAmountStotinki to both carriers', async () => {
    const econt = { estimateShipping: jest.fn().mockResolvedValue(490) };
    const speedy = {
      searchSites: jest.fn().mockResolvedValue([{ id: 100, name: 'Варна' }]),
      estimateShipping: jest.fn().mockResolvedValue(420),
    };
    const svc = new ShippingQuoteService(econt as any, speedy as any);

    await svc.compare('t1', { destinationCity: 'Варна', deliveryMode: 'address', codAmountStotinki: 5000 });

    expect(econt.estimateShipping).toHaveBeenCalledWith('t1', expect.anything(), [], 1, 5000);
    expect(speedy.estimateShipping).toHaveBeenCalledWith('t1', { siteId: 100, weightGrams: 1000, codAmountStotinki: 5000 });
  });
});
