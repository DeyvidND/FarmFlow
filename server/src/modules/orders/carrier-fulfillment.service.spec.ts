import { CarrierFulfillmentService } from './carrier-fulfillment.service';

describe('CarrierFulfillmentService', () => {
  const order = (carrier: string | null, dt = 'econt_address') => ({ carrier, deliveryType: dt, tenantId: 't1' });

  it('routes speedy door orders to speedy auto-create', async () => {
    const econt = { autoCreateForOrder: jest.fn() };
    const speedy = { autoCreateForOrder: jest.fn() };
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: () => [order('speedy')] }) }) }) };
    const svc = new CarrierFulfillmentService(db as any, econt as any, speedy as any);
    await svc.autoCreateForOrder('o1');
    expect(speedy.autoCreateForOrder).toHaveBeenCalledWith('o1');
    expect(econt.autoCreateForOrder).not.toHaveBeenCalled();
  });

  it('routes econt/null-carrier door orders to econt', async () => {
    const econt = { autoCreateForOrder: jest.fn() };
    const speedy = { autoCreateForOrder: jest.fn() };
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: () => [order(null)] }) }) }) };
    const svc = new CarrierFulfillmentService(db as any, econt as any, speedy as any);
    await svc.autoCreateForOrder('o1');
    expect(econt.autoCreateForOrder).toHaveBeenCalledWith('o1');
  });
});
