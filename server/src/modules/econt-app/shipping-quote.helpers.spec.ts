import { buildQuoteResult } from './shipping-quote.helpers';

describe('buildQuoteResult', () => {
  it('both available → sorts cheapest-first, cheapest = lower price', () => {
    const r = buildQuoteResult(450, 390);
    expect(r.quotes.map((q) => q.carrier)).toEqual(['speedy', 'econt']);
    expect(r.quotes[0]).toEqual({ carrier: 'speedy', priceStotinki: 390, available: true });
    expect(r.cheapest).toBe('speedy');
  });
  it('both available, econt cheaper → econt first', () => {
    const r = buildQuoteResult(300, 390);
    expect(r.quotes.map((q) => q.carrier)).toEqual(['econt', 'speedy']);
    expect(r.cheapest).toBe('econt');
  });
  it('only econt available → econt first + cheapest, speedy last unavailable', () => {
    const r = buildQuoteResult(450, null);
    expect(r.quotes[0].carrier).toBe('econt');
    expect(r.quotes[1]).toEqual({ carrier: 'speedy', priceStotinki: null, available: false });
    expect(r.cheapest).toBe('econt');
  });
  it('only speedy available → speedy first + cheapest', () => {
    const r = buildQuoteResult(null, 390);
    expect(r.quotes[0].carrier).toBe('speedy');
    expect(r.cheapest).toBe('speedy');
  });
  it('both unavailable → cheapest null, both available:false', () => {
    const r = buildQuoteResult(null, null);
    expect(r.cheapest).toBeNull();
    expect(r.quotes.every((q) => !q.available)).toBe(true);
  });
  it('tie → stable order (econt first), cheapest = econt', () => {
    const r = buildQuoteResult(400, 400);
    expect(r.quotes.map((q) => q.carrier)).toEqual(['econt', 'speedy']);
    expect(r.cheapest).toBe('econt');
  });

  describe('policy → selected', () => {
    it('default (customer) → selected = cheapest, policy echoed', () => {
      const r = buildQuoteResult(450, 390);
      expect(r.policy).toBe('customer');
      expect(r.selected).toBe('speedy'); // the cheaper one, as a default pre-select
    });
    it('cheapest policy → selected = cheapest', () => {
      const r = buildQuoteResult(450, 390, 'cheapest');
      expect(r.selected).toBe('speedy');
    });
    it('econt forced + available → selected = econt even when speedy cheaper', () => {
      const r = buildQuoteResult(450, 390, 'econt');
      expect(r.selected).toBe('econt');
      expect(r.cheapest).toBe('speedy'); // cheapest still reports the true low price
    });
    it('speedy forced + available → selected = speedy even when econt cheaper', () => {
      const r = buildQuoteResult(300, 390, 'speedy');
      expect(r.selected).toBe('speedy');
      expect(r.cheapest).toBe('econt');
    });
    it('forced carrier unavailable → falls back to cheapest available', () => {
      const r = buildQuoteResult(450, null, 'speedy');
      expect(r.selected).toBe('econt'); // speedy down → use the available one
    });
    it('forced carrier, neither available → selected null', () => {
      const r = buildQuoteResult(null, null, 'econt');
      expect(r.selected).toBeNull();
    });
  });

  describe('pricing', () => {
    it('orders cheapest first, no markup', () => {
      const r = buildQuoteResult(450, 390, 'customer');
      expect(r.quotes.find((q) => q.carrier === 'econt')!.priceStotinki).toBe(450);
      expect(r.quotes.find((q) => q.carrier === 'speedy')!.priceStotinki).toBe(390);
      expect(r.cheapest).toBe('speedy');
    });
    it('leaves an unavailable (null) carrier null', () => {
      const r = buildQuoteResult(450, null, 'customer');
      expect(r.quotes.find((q) => q.carrier === 'speedy')!.priceStotinki).toBeNull();
    });
  });
});
