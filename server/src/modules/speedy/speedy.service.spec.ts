/**
 * Unit tests for SpeedyService.estimateShipping.
 * The service is instantiated with stub deps; private fields (client, cache,
 * loadStored, resolveCreds) are overridden per-test via (svc as any).
 */
import { SpeedyService } from './speedy.service';
import { Logger } from '@nestjs/common';

// Silence NestJS logger output during tests.
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

/** Minimal stub to satisfy the constructor without touching real DI. */
function makeService(): SpeedyService {
  const db = {} as any;
  const config = { get: (_k: string, d: any) => d } as any;
  const cache = { get: jest.fn(), set: jest.fn() } as any;
  const client = { call: jest.fn() } as any;
  const codRisk = {} as any;
  return new SpeedyService(db, config, cache, client, codRisk);
}

describe('SpeedyService.estimateShipping', () => {
  let svc: SpeedyService;

  beforeEach(() => {
    svc = makeService();
  });

  it('returns null when speedy is not configured', async () => {
    (svc as any).loadStored = jest.fn().mockResolvedValue({ speedy: { configured: false } });
    const result = await svc.estimateShipping('t1', { siteId: 100 });
    expect(result).toBeNull();
  });

  it('returns null when siteId is falsy', async () => {
    (svc as any).loadStored = jest.fn().mockResolvedValue({ speedy: { configured: true } });
    const result = await svc.estimateShipping('t1', { siteId: 0 });
    expect(result).toBeNull();
  });

  it('returns cached value without calling the API', async () => {
    (svc as any).loadStored = jest.fn().mockResolvedValue({ speedy: { configured: true } });
    const cache = { get: jest.fn().mockResolvedValue(1500), set: jest.fn() };
    (svc as any).cache = cache;
    const callMock = jest.fn();
    (svc as any).client = { call: callMock };

    const result = await svc.estimateShipping('t1', { siteId: 100 });
    expect(result).toBe(1500);
    expect(callMock).not.toHaveBeenCalled();
  });

  it('calls /calculate and returns stotinki (EUR × 100)', async () => {
    (svc as any).loadStored = jest.fn().mockResolvedValue({
      speedy: { configured: true, defaultServiceId: 505 },
    });
    (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });
    const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    (svc as any).cache = cache;
    const call = jest.fn().mockResolvedValue({ price: { total: 8.5 } });
    (svc as any).client = { call };

    const result = await svc.estimateShipping('t1', { siteId: 100, weightGrams: 1500 });
    expect(result).toBe(850);
    expect(call).toHaveBeenCalledWith(
      expect.anything(),
      'calculate',
      expect.any(Object),
      6000,
    );
  });

  it('returns null when the API returns 0 price', async () => {
    (svc as any).loadStored = jest.fn().mockResolvedValue({
      speedy: { configured: true },
    });
    (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });
    const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    (svc as any).cache = cache;
    (svc as any).client = { call: jest.fn().mockResolvedValue({ price: { total: 0 } }) };

    const result = await svc.estimateShipping('t1', { siteId: 100 });
    expect(result).toBeNull();
  });

  it('returns null on exception (never throws)', async () => {
    (svc as any).loadStored = jest.fn().mockRejectedValue(new Error('network error'));
    const result = await svc.estimateShipping('t1', { siteId: 100 });
    expect(result).toBeNull();
  });

  it('prices COD with a distinct cache key and passes cod to the request body', async () => {
    const call = jest.fn().mockResolvedValue({ price: { total: 5 } });
    (svc as any).client = { call };
    (svc as any).loadStored = jest.fn().mockResolvedValue({
      speedy: { configured: true, defaultServiceId: 505 },
    });
    (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });
    const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    (svc as any).cache = cache;

    await svc.estimateShipping('t1', { siteId: 100, weightGrams: 1000, codAmountStotinki: 5000 });

    // Cache key must contain 'cod' so COD and non-COD prices are stored separately.
    expect(cache.set.mock.calls[0][0]).toContain('cod');
    // body is the 3rd arg (index 2) of client.call(creds, path, body, timeout)
    const body = call.mock.calls[0][2];
    // buildShipmentRequest puts COD under service.additionalServices.cod.amount
    expect((body as any).service?.additionalServices?.cod?.amount).toBeGreaterThan(0);
  });
});

describe('SpeedyService.createLabelForOrder', () => {
  let svc: SpeedyService;

  beforeEach(() => {
    svc = makeService();
  });

  it('createLabelForOrder upserts an order-linked Speedy shipment', async () => {
    const call = jest.fn().mockResolvedValue({ id: 'S1', parcels: [{ barcode: 'BC1' }], price: { total: 4.2 } });
    (svc as any).client = { call };
    (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });
    (svc as any).loadStored = jest.fn().mockResolvedValue({ speedy: { configured: true, defaultServiceId: 505 } });
    (svc as any).searchSites = jest.fn().mockResolvedValue([{ id: 100 }]);
    (svc as any).orderForShipment = jest.fn().mockResolvedValue({
      tenantId: 't1', deliveryCity: 'Варна', customerName: 'И', customerPhone: '0888',
      deliveryAddress: 'ул', paymentMethod: 'cod', paidAt: null, totalStotinki: 5000,
    });

    // Mock db.insert(...).values(...).onConflictDoUpdate(...).returning()
    const returning = jest.fn().mockResolvedValue([{ carrier: 'speedy', carrierShipmentId: 'S1', trackingNumber: 'BC1', status: 'created' }]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = jest.fn().mockReturnValue({ values });
    (svc as any).db = { insert };

    const row = await svc.createLabelForOrder('t1', 'order-1');
    expect(call).toHaveBeenCalledWith(expect.anything(), 'shipment', expect.anything());
    expect(insert).toHaveBeenCalled();
    expect(row.carrier).toBe('speedy');
  });
});

describe('SpeedyService.maybeSeedSender (unit)', () => {
  const svc = new SpeedyService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never);
  const seed = (speedy: unknown, farmName: string, contact: unknown, profiles: unknown) =>
    (svc as unknown as {
      maybeSeedSender: (s: any, n: string, c: any, p: any) => Record<string, unknown>;
    }).maybeSeedSender(speedy, farmName, contact, profiles);

  it('seeds sender when empty, from the contract client', () => {
    const out = seed({ userName: 'u' }, 'Ферма', { phone: '0700' },
      [{ name: 'Клиент', phone: '0888', clientNumber: '9' }]);
    expect(out.sender).toEqual({ contactName: 'Клиент', phone: '0888', mode: 'office' });
  });

  it('does NOT overwrite an existing sender', () => {
    const existing = { name: 'Ръчно', phone: '0999', mode: 'office' };
    const out = seed({ userName: 'u', sender: existing }, 'Ферма', { phone: '0700' }, []);
    expect(out.sender).toEqual(existing);
  });
});
