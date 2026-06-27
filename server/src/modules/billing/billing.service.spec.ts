import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingService } from './billing.service';
import { EmailService } from '../../common/email/email.service';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

/**
 * Chainable Drizzle mock. Builder methods return `this` (so update/set/where with
 * no `.returning()` resolve to the mock object when awaited — a truthy no-op).
 * Terminal reads (`limit`, `returning`) resolve arrays the tests queue up.
 */
function makeDb() {
  const db: any = {};
  const chain = () => db;
  db.select = jest.fn(chain);
  db.from = jest.fn(chain);
  db.where = jest.fn(chain);
  db.update = jest.fn(chain);
  db.set = jest.fn(chain);
  db.insert = jest.fn(chain);
  db.values = jest.fn(chain);
  db.limit = jest.fn().mockResolvedValue([]);
  db.returning = jest.fn().mockResolvedValue([]);
  return db;
}

const cfg = (over: Record<string, any> = {}) => ({
  get: (k: string, d?: any) => (k in over ? over[k] : d),
});

function makeEmail() {
  return { sendMail: jest.fn().mockResolvedValue(undefined) };
}

async function build(db: any, config: any, email: any): Promise<BillingService> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      BillingService,
      { provide: DB_TOKEN, useValue: db },
      { provide: ConfigService, useValue: config },
      { provide: EmailService, useValue: email },
      // summary() is cached; get→null keeps every call computing fresh (as before).
      {
        provide: PublicCacheService,
        useValue: { get: jest.fn(async () => null), set: jest.fn(async () => undefined) },
      },
    ],
  }).compile();
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  return mod.get(BillingService);
}

describe('BillingService — disabled (no STRIPE_SECRET_KEY)', () => {
  let db: any;
  let svc: BillingService;

  beforeEach(async () => {
    db = makeDb();
    svc = await build(db, cfg(), makeEmail());
  });

  it('isEnabled() is false without a key', () => {
    expect(svc.isEnabled()).toBe(false);
  });

  it('summary() returns a safe disabled snapshot, never throws', async () => {
    db.limit.mockResolvedValue([{ id: 't1', premium: false, subscriptionStatus: 'active', graceUntil: null, stripeCustomerId: null }]);
    const s = await svc.summary('t1');
    expect(s.enabled).toBe(false);
    expect(s.plan).toBe('standard');
    expect(s.status).toBe('active');
    expect(s.estimatedNextStotinki).toBe(3000);
  });

  it('summary() on a missing tenant returns the base default (no throw)', async () => {
    db.limit.mockResolvedValue([]); // tenant() throws NotFound → caught
    const s = await svc.summary('ghost');
    expect(s.enabled).toBe(false);
    expect(s.plan).toBe('standard');
  });

  it('summary() reports premium plan + €0 estimate', async () => {
    db.limit.mockResolvedValue([{ id: 't1', premium: true, subscriptionStatus: 'active', graceUntil: null, stripeCustomerId: null }]);
    const s = await svc.summary('t1');
    expect(s.plan).toBe('premium');
    expect(s.estimatedNextStotinki).toBe(0);
  });

  it('startCheckout() throws when Stripe disabled', async () => {
    await expect(svc.startCheckout('t1')).rejects.toThrow('Stripe не е конфигуриран');
  });

  it('billingPortal() throws when Stripe disabled', async () => {
    await expect(svc.billingPortal('t1')).rejects.toThrow('Stripe не е конфигуриран');
  });
});

describe('BillingService.billPush', () => {
  let db: any;
  let email: any;
  let svc: BillingService;
  const invoiceItems = { create: jest.fn().mockResolvedValue({ id: 'ii_1' }) };

  beforeEach(async () => {
    db = makeDb();
    email = makeEmail();
    svc = await build(db, cfg({ EMAIL_PRICE_PER_RECIPIENT_MICRO: 555 }), email);
    invoiceItems.create.mockClear();
  });

  it('premium → sets push price 0, no Stripe call', async () => {
    db.limit
      .mockResolvedValueOnce([{ id: 'p1', tenantId: 't1', stripeInvoiceItemId: null, subject: 'x', recipientCount: 3 }])
      .mockResolvedValueOnce([{ id: 't1', premium: true, stripeCustomerId: null }]);
    await svc.billPush('p1');
    expect(db.set).toHaveBeenCalledWith({ priceStotinki: 0 });
    expect(invoiceItems.create).not.toHaveBeenCalled();
  });

  it('non-premium with customer → invoice item priced per recipient (200 × 555µ = 11 ст)', async () => {
    (svc as any).client = { invoiceItems };
    db.limit
      .mockResolvedValueOnce([{ id: 'p1', tenantId: 't1', stripeInvoiceItemId: null, subject: 'Лято', recipientCount: 200 }])
      .mockResolvedValueOnce([{ id: 't1', premium: false, stripeCustomerId: 'cus_1' }]);
    await svc.billPush('p1');
    expect(invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_1', amount: 11, currency: 'eur' }),
    );
    expect(db.set).toHaveBeenCalledWith({ stripeInvoiceItemId: 'ii_1' });
  });

  it('tiny send that rounds to 0 ст → not billed (no Stripe call)', async () => {
    (svc as any).client = { invoiceItems };
    db.limit
      .mockResolvedValueOnce([{ id: 'p1', tenantId: 't1', stripeInvoiceItemId: null, subject: 'x', recipientCount: 5 }])
      .mockResolvedValueOnce([{ id: 't1', premium: false, stripeCustomerId: 'cus_1' }]);
    await svc.billPush('p1'); // 5 × 555µ = 0.2775 ст → round 0
    expect(invoiceItems.create).not.toHaveBeenCalled();
  });

  it('already-billed push → no-op (no Stripe, no update)', async () => {
    (svc as any).client = { invoiceItems };
    db.limit.mockResolvedValueOnce([{ id: 'p1', tenantId: 't1', stripeInvoiceItemId: 'ii_existing' }]);
    await svc.billPush('p1');
    expect(invoiceItems.create).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('non-premium without a customer → unbilled (no Stripe call, no throw)', async () => {
    (svc as any).client = { invoiceItems };
    db.limit
      .mockResolvedValueOnce([{ id: 'p1', tenantId: 't1', stripeInvoiceItemId: null }])
      .mockResolvedValueOnce([{ id: 't1', premium: false, stripeCustomerId: null }]);
    await svc.billPush('p1');
    expect(invoiceItems.create).not.toHaveBeenCalled();
  });
});

describe('BillingService.handleBillingEvent', () => {
  let db: any;
  let email: any;
  let svc: BillingService;

  beforeEach(async () => {
    db = makeDb();
    email = makeEmail();
    svc = await build(db, cfg({ BILLING_GRACE_DAYS: 7 }), email);
  });

  it('invoice.payment_failed (first) → past_due + grace set + email sent', async () => {
    db.limit.mockResolvedValue([{ id: 't1', email: 'f@farm.bg', graceUntil: null }]);
    await svc.handleBillingEvent({ type: 'invoice.payment_failed', data: { object: { customer: 'cus_1' } } });
    const setArg = db.set.mock.calls.at(-1)[0];
    expect(setArg.subscriptionStatus).toBe('past_due');
    expect(setArg.graceUntil).toBeInstanceOf(Date);
    expect(email.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'f@farm.bg' }));
  });

  it('invoice.payment_failed when grace already running → no reset, no email', async () => {
    db.limit.mockResolvedValue([{ id: 't1', email: 'f@farm.bg', graceUntil: new Date() }]);
    await svc.handleBillingEvent({ type: 'invoice.payment_failed', data: { object: { customer: 'cus_1' } } });
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  it('invoice.paid → active + grace cleared', async () => {
    db.limit.mockResolvedValue([{ id: 't1' }]);
    await svc.handleBillingEvent({ type: 'invoice.paid', data: { object: { customer: 'cus_1' } } });
    expect(db.set).toHaveBeenCalledWith({ subscriptionStatus: 'active', graceUntil: null });
  });

  it('customer.subscription.deleted → inactive', async () => {
    db.limit.mockResolvedValue([{ id: 't1' }]);
    await svc.handleBillingEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1' } } });
    expect(db.set).toHaveBeenCalledWith({ subscriptionStatus: 'inactive' });
  });

  it('checkout.session.completed (subscription) → stores sub id + active', async () => {
    db.limit.mockResolvedValue([{ id: 't1' }]);
    await svc.handleBillingEvent({
      type: 'checkout.session.completed',
      data: { object: { mode: 'subscription', customer: 'cus_1', subscription: 'sub_9' } },
    });
    expect(db.set).toHaveBeenCalledWith(
      expect.objectContaining({ stripeSubscriptionId: 'sub_9', subscriptionStatus: 'active', graceUntil: null }),
    );
  });

  it('checkout.session.completed (payment / order mode) → ignored by billing', async () => {
    await svc.handleBillingEvent({
      type: 'checkout.session.completed',
      data: { object: { mode: 'payment', customer: 'cus_1' } },
    });
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe('BillingService premium + grace cron', () => {
  let db: any;
  let svc: BillingService;
  const subscriptions = { cancel: jest.fn().mockResolvedValue({}) };

  beforeEach(async () => {
    db = makeDb();
    svc = await build(db, cfg(), makeEmail());
    subscriptions.cancel.mockClear();
  });

  it('setPremium(true) cancels the subscription + flips flags', async () => {
    (svc as any).client = { subscriptions };
    db.limit.mockResolvedValue([{ id: 't1', stripeSubscriptionId: 'sub_1' }]);
    await svc.setPremium('t1', true);
    expect(subscriptions.cancel).toHaveBeenCalledWith('sub_1');
    expect(db.set).toHaveBeenCalledWith(
      expect.objectContaining({ premium: true, subscriptionStatus: 'active', graceUntil: null }),
    );
  });

  it('setPremium(false) just clears the flag', async () => {
    db.limit.mockResolvedValue([{ id: 't1', stripeSubscriptionId: null }]);
    await svc.setPremium('t1', false);
    expect(db.set).toHaveBeenCalledWith({ premium: false });
  });

  it('suspendExpiredGrace() updates past_due+expired rows to inactive', async () => {
    db.returning.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);
    await svc.suspendExpiredGrace();
    expect(db.set).toHaveBeenCalledWith({ subscriptionStatus: 'inactive' });
    expect(db.returning).toHaveBeenCalled();
  });
});

describe('BillingService.isBillable', () => {
  let db: any;
  let svc: BillingService;

  // Stripe is "enabled" only when a client AND a billing price id are present.
  beforeEach(async () => {
    db = makeDb();
    svc = await build(db, cfg({ STRIPE_BILLING_PRICE_ID: 'price_1' }), makeEmail());
  });

  it('Stripe disabled (no client) → billable (no billing to enforce), no DB read', async () => {
    expect(await svc.isBillable('t1')).toBe(true);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('enabled + premium farm → billable', async () => {
    (svc as any).client = {};
    db.limit.mockResolvedValueOnce([{ id: 't1', premium: true, stripeCustomerId: null }]);
    expect(await svc.isBillable('t1')).toBe(true);
  });

  it('enabled + has Stripe customer → billable', async () => {
    (svc as any).client = {};
    db.limit.mockResolvedValueOnce([{ id: 't1', premium: false, stripeCustomerId: 'cus_1' }]);
    expect(await svc.isBillable('t1')).toBe(true);
  });

  it('enabled + non-premium + no customer → NOT billable', async () => {
    (svc as any).client = {};
    db.limit.mockResolvedValueOnce([{ id: 't1', premium: false, stripeCustomerId: null }]);
    expect(await svc.isBillable('t1')).toBe(false);
  });
});
