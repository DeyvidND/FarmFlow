import { CarrierFulfillmentService } from './carrier-fulfillment.service';
import { CarrierRegistry } from './carrier-registry';

describe('CarrierFulfillmentService', () => {
  const order = (carrier: string | null, dt = 'econt_address') => ({ carrier, deliveryType: dt, tenantId: 't1' });
  const dbFor = (row: unknown) => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => [row] }) }) }),
  });

  it('routes speedy door orders to speedy auto-create', async () => {
    const econt = { autoCreateForOrder: jest.fn() };
    const speedy = { autoCreateForOrder: jest.fn() };
    const registry = new CarrierRegistry(econt as never, speedy as never);
    const svc = new CarrierFulfillmentService(dbFor(order('speedy')) as never, registry);
    await svc.autoCreateForOrder('o1');
    expect(speedy.autoCreateForOrder).toHaveBeenCalledWith('o1');
    expect(econt.autoCreateForOrder).not.toHaveBeenCalled();
  });

  it('routes econt/null-carrier door orders to econt', async () => {
    const econt = { autoCreateForOrder: jest.fn() };
    const speedy = { autoCreateForOrder: jest.fn() };
    const registry = new CarrierRegistry(econt as never, speedy as never);
    const svc = new CarrierFulfillmentService(dbFor(order(null)) as never, registry);
    await svc.autoCreateForOrder('o1');
    expect(econt.autoCreateForOrder).toHaveBeenCalledWith('o1');
    expect(speedy.autoCreateForOrder).not.toHaveBeenCalled();
  });
});

describe('CarrierRegistry.get', () => {
  const econt = { tag: 'econt' };
  const speedy = { tag: 'speedy' };
  const registry = new CarrierRegistry(econt as never, speedy as never);

  it('returns speedy only for an explicit "speedy"', () => {
    expect((registry.get('speedy') as unknown as typeof speedy).tag).toBe('speedy');
  });
  it('falls back to econt for null / "econt" / unknown', () => {
    expect((registry.get(null) as unknown as typeof econt).tag).toBe('econt');
    expect((registry.get('econt') as unknown as typeof econt).tag).toBe('econt');
    expect((registry.get('bogus') as unknown as typeof econt).tag).toBe('econt');
  });
});
