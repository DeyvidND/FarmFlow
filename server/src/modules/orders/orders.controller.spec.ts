import { ForbiddenException } from '@nestjs/common';
import { OrdersController } from './orders.controller';

// The payments route mirrors /stats: effectiveFarmerId decides owner vs producer
// scope. A producer is forced to its own farmerId (query override ignored); a
// malformed farmer token (role='farmer', no farmerId) is rejected with 403.
describe('OrdersController payments routing', () => {
  const svc = {
    payments: jest.fn().mockResolvedValue('owner'),
    paymentsForFarmer: jest.fn().mockResolvedValue('scoped'),
  };
  const ctrl = new OrdersController(svc as any);
  const tenant = (over: Record<string, unknown>) =>
    ({ type: 'tenant', userId: 'u', tenantId: 't', ...over }) as any;

  beforeEach(() => jest.clearAllMocks());

  it('a producer is forced to their own farmerId, ignoring ?farmerId', async () => {
    await ctrl.payments(tenant({ role: 'farmer', farmerId: 'farmer-1' }), {
      method: 'all',
      farmerId: 'farmer-9',
    } as any);
    expect(svc.paymentsForFarmer).toHaveBeenCalledWith('t', 'farmer-1', {
      method: 'all',
      farmerId: 'farmer-9',
    });
    expect(svc.payments).not.toHaveBeenCalled();
  });

  it('an owner with ?farmerId gets the producer-scoped payments', async () => {
    await ctrl.payments(tenant({ role: 'admin' }), { farmerId: 'farmer-3' } as any);
    expect(svc.paymentsForFarmer).toHaveBeenCalledWith('t', 'farmer-3', expect.any(Object));
    expect(svc.payments).not.toHaveBeenCalled();
  });

  it('an owner without ?farmerId gets the whole-tenant payments', async () => {
    await ctrl.payments(tenant({ role: 'admin' }), { method: 'cod' } as any);
    expect(svc.payments).toHaveBeenCalledWith('t', { method: 'cod' });
    expect(svc.paymentsForFarmer).not.toHaveBeenCalled();
  });

  it('rejects a malformed farmer token (role=farmer, no farmerId) with 403', () => {
    expect(() => ctrl.payments(tenant({ role: 'farmer' }), {} as any)).toThrow(ForbiddenException);
    expect(svc.payments).not.toHaveBeenCalled();
    expect(svc.paymentsForFarmer).not.toHaveBeenCalled();
  });
});
