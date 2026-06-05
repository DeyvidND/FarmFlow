import { serializeOrder } from './orders.service';

// A minimal raw order row; cast since serializeOrder only reads the fields below.
const baseRow = {
  id: 'o1',
  tenantId: 't1',
  paidAt: null,
  stripeCheckoutSessionId: null,
  stripePaymentIntentId: null,
  items: [],
} as unknown as Parameters<typeof serializeOrder>[0];

describe('serializeOrder — paymentStatus derivation', () => {
  it("marks 'paid' when paidAt is set", () => {
    expect(serializeOrder({ ...baseRow, paidAt: new Date() }).paymentStatus).toBe('paid');
  });

  it("marks 'pending_online' when a checkout session exists but it's unpaid", () => {
    expect(
      serializeOrder({ ...baseRow, stripeCheckoutSessionId: 'cs_test_1' }).paymentStatus,
    ).toBe('pending_online');
  });

  it("prefers 'paid' over 'pending_online' when both apply", () => {
    expect(
      serializeOrder({ ...baseRow, paidAt: new Date(), stripeCheckoutSessionId: 'cs_1' })
        .paymentStatus,
    ).toBe('paid');
  });

  it("falls back to 'cash' when there is no online payment", () => {
    expect(serializeOrder(baseRow).paymentStatus).toBe('cash');
  });

  it('drops raw Stripe identifiers + tenantId from the output', () => {
    const out = serializeOrder({
      ...baseRow,
      stripeCheckoutSessionId: 'cs_1',
      stripePaymentIntentId: 'pi_1',
    }) as Record<string, unknown>;
    expect(out.stripeCheckoutSessionId).toBeUndefined();
    expect(out.stripePaymentIntentId).toBeUndefined();
    expect(out.tenantId).toBeUndefined();
  });
});
