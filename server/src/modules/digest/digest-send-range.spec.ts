import { Logger, BadRequestException } from '@nestjs/common';
import { DigestService } from './digest.service';

const OPTS = { from: '2026-07-10', to: '2026-07-12', farmerIds: ['f1', 'f2'], statuses: ['confirmed'] };

// db mock: a single reused chain object where select/from/innerJoin/leftJoin/where
// all return `chain` itself for further chaining (matching real drizzle builders,
// which stay chainable AND are directly awaitable). `chain` is made "thenable" so
// `await ...where(cond)` (no further chaining — the farmers query) resolves too.
// Each terminal point (bare await, `.limit()`, `.orderBy()`) pulls the next queued
// stage result in the order the three queries actually run: tenant, farmers, line
// items.
function makeService(stages: {
  tenant?: Record<string, unknown> | null;
  farmers?: Record<string, unknown>[];
  lineItems?: Record<string, unknown>[];
}) {
  const email = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const queue: unknown[][] = [
    stages.tenant === null ? [] : [stages.tenant ?? { multiFarmer: true }],
    stages.farmers ?? [],
    stages.lineItems ?? [],
  ];
  let idx = 0;
  const nextResult = () => queue[idx++];

  const chain: any = {};
  chain.select = jest.fn(() => chain);
  chain.from = jest.fn(() => chain);
  chain.innerJoin = jest.fn(() => chain);
  chain.leftJoin = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.limit = jest.fn(() => Promise.resolve(nextResult()));
  chain.orderBy = jest.fn(() => Promise.resolve(nextResult()));
  // Bare `await chain` (the farmers query has no `.limit()`/`.orderBy()` after
  // `.where()`) — treated as a thenable, same as a real drizzle query builder.
  chain.then = (resolve: (v: unknown) => void) => resolve(nextResult());

  return { service: new DigestService(chain as never, email as never), email };
}

describe('DigestService.sendFarmerOrderEmails', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('rejects a non-multiFarmer tenant', async () => {
    const { service } = makeService({ tenant: { multiFarmer: false } });
    await expect(service.sendFarmerOrderEmails('t', OPTS)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects from > to', async () => {
    const { service } = makeService({ tenant: { multiFarmer: true } });
    await expect(
      service.sendFarmerOrderEmails('t', { ...OPTS, from: '2026-07-20', to: '2026-07-10' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a range wider than 31 days', async () => {
    const { service } = makeService({ tenant: { multiFarmer: true } });
    await expect(
      service.sendFarmerOrderEmails('t', { ...OPTS, from: '2026-07-01', to: '2026-08-15' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when statuses contain nothing allowed (cancelled stripped)', async () => {
    const { service } = makeService({ tenant: { multiFarmer: true } });
    await expect(
      service.sendFarmerOrderEmails('t', { ...OPTS, statuses: ['cancelled', 'bogus'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when no selected farmer resolves for the tenant', async () => {
    const { service } = makeService({ tenant: { multiFarmer: true }, farmers: [] });
    await expect(service.sendFarmerOrderEmails('t', OPTS)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sends to farmers with orders, skips farmers with none', async () => {
    const { service, email } = makeService({
      tenant: { multiFarmer: true },
      farmers: [
        { id: 'f1', name: 'Иван', email: 'ivan@x.bg' },
        { id: 'f2', name: 'Мария', email: 'maria@x.bg' },
      ],
      lineItems: [
        {
          farmerId: 'f1',
          orderId: 'o1',
          deliveryType: 'address',
          customerName: 'Клиент',
          deliveryAddress: 'ул. 1',
          deliveryCity: 'София',
          econtOffice: null,
          slotFrom: '09:00:00',
          slotTo: '12:00:00',
          slotDate: '2026-07-10',
          productName: 'Домати',
          quantity: 2,
        },
      ],
    });
    const res = await service.sendFarmerOrderEmails('t', OPTS);
    expect(res).toEqual({ sent: 1, skipped: 1 });
    expect(email.sendMail).toHaveBeenCalledTimes(1);
    expect(email.sendMail.mock.calls[0][0].to).toBe('ivan@x.bg');
    expect(email.sendMail.mock.calls[0][0].subject).toContain('Твоите поръчки за');
  });

  it('strips a disallowed status from a mixed list and proceeds with the rest', async () => {
    const { service, email } = makeService({
      tenant: { multiFarmer: true },
      farmers: [
        { id: 'f1', name: 'Иван', email: 'ivan@x.bg' },
        { id: 'f2', name: 'Мария', email: 'maria@x.bg' },
      ],
      lineItems: [
        {
          farmerId: 'f1',
          orderId: 'o1',
          deliveryType: 'pickup',
          customerName: 'Клиент',
          deliveryAddress: null,
          deliveryCity: null,
          econtOffice: null,
          slotFrom: null,
          slotTo: null,
          slotDate: '2026-07-10',
          productName: 'Домати',
          quantity: 2,
        },
      ],
    });
    const res = await service.sendFarmerOrderEmails('t', { ...OPTS, statuses: ['confirmed', 'cancelled'] });
    expect(res).toEqual({ sent: 1, skipped: 1 });
    expect(email.sendMail).toHaveBeenCalledTimes(1);
    expect(email.sendMail.mock.calls[0][0].to).toBe('ivan@x.bg');
  });

  it('does not abort remaining farmers when one sendMail throws', async () => {
    const { service, email } = makeService({
      tenant: { multiFarmer: true },
      farmers: [
        { id: 'f1', name: 'Иван', email: 'ivan@x.bg' },
        { id: 'f2', name: 'Мария', email: 'maria@x.bg' },
      ],
      lineItems: [
        { farmerId: 'f1', orderId: 'o1', deliveryType: 'pickup', customerName: 'A', deliveryAddress: null, deliveryCity: null, econtOffice: null, slotFrom: null, slotTo: null, slotDate: '2026-07-10', productName: 'P', quantity: 1 },
        { farmerId: 'f2', orderId: 'o2', deliveryType: 'pickup', customerName: 'B', deliveryAddress: null, deliveryCity: null, econtOffice: null, slotFrom: null, slotTo: null, slotDate: '2026-07-10', productName: 'Q', quantity: 1 },
      ],
    });
    email.sendMail.mockRejectedValueOnce(new Error('smtp down'));
    const res = await service.sendFarmerOrderEmails('t', OPTS);
    expect(email.sendMail).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ sent: 1, skipped: 1 });
  });
});
