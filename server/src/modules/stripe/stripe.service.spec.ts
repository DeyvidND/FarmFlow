import { ConfigService } from '@nestjs/config';
import { StripeService } from './stripe.service';

// Disabled-safe behaviour: with no STRIPE_SECRET_KEY the service must never
// throw on read paths and must report itself as not configured.
describe('StripeService (Stripe disabled)', () => {
  const config = {
    get: (key: string, def?: unknown) =>
      key === 'STRIPE_SECRET_KEY' || key === 'STRIPE_WEBHOOK_SECRET' ? '' : def,
  } as unknown as ConfigService;
  const svc = new StripeService({} as never, config);

  it('reports disabled when no secret key is set', () => {
    expect(svc.isEnabled()).toBe(false);
  });

  it('connectSummary returns a safe disconnected summary without touching the DB', async () => {
    const summary = await svc.connectSummary('tenant-1');
    expect(summary).toEqual({
      enabled: false,
      connected: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      availableStotinki: 0,
      pendingStotinki: 0,
      nextPayout: null,
      feeBps: 0,
    });
  });
});
