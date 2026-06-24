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
});
