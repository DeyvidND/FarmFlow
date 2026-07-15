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

// PATCH :id/status mirrors the same owner-vs-producer scope split. An owner edits
// any order tenant-wide; a producer is routed to the IDOR-scoped service method
// (which also restricts them to the «delivered» / cash-received transition).
describe('OrdersController updateStatus routing', () => {
  const svc = {
    updateStatus: jest.fn().mockResolvedValue('owner'),
    updateStatusForFarmer: jest.fn().mockResolvedValue('scoped'),
  };
  const ctrl = new OrdersController(svc as any);
  const tenant = (over: Record<string, unknown>) =>
    ({ type: 'tenant', userId: 'u', tenantId: 't', ...over }) as any;
  const dto = { status: 'delivered' } as any;

  beforeEach(() => jest.clearAllMocks());

  it('an owner edits any order tenant-wide (no producer scope)', async () => {
    await ctrl.updateStatus('o1', tenant({ role: 'admin' }), dto);
    expect(svc.updateStatus).toHaveBeenCalledWith('o1', 't', dto);
    expect(svc.updateStatusForFarmer).not.toHaveBeenCalled();
  });

  it('a producer is routed to the IDOR-scoped method with their own farmerId', async () => {
    await ctrl.updateStatus('o1', tenant({ role: 'farmer', farmerId: 'farmer-1' }), dto);
    expect(svc.updateStatusForFarmer).toHaveBeenCalledWith('o1', 't', 'farmer-1', dto);
    expect(svc.updateStatus).not.toHaveBeenCalled();
  });

  it('rejects a malformed farmer token (role=farmer, no farmerId) with 403', () => {
    expect(() => ctrl.updateStatus('o1', tenant({ role: 'farmer' }), dto)).toThrow(
      ForbiddenException,
    );
    expect(svc.updateStatus).not.toHaveBeenCalled();
    expect(svc.updateStatusForFarmer).not.toHaveBeenCalled();
  });
});

// Task C3 — a driver (courier login) finishing/undoing from the route screen is
// routed to the transition-restricted updateStatusForCourier, never the plain
// owner path or the farmer IDOR path.
describe('OrdersController updateStatus routing (driver)', () => {
  const svc = {
    updateStatus: jest.fn().mockResolvedValue('owner'),
    updateStatusForFarmer: jest.fn().mockResolvedValue('scoped-farmer'),
    updateStatusForCourier: jest.fn().mockResolvedValue('scoped-courier'),
  };
  const ctrl = new OrdersController(svc as any);
  const tenant = (over: Record<string, unknown>) =>
    ({ type: 'tenant', userId: 'u', tenantId: 't', ...over }) as any;
  const dto = { status: 'delivered' } as any;

  beforeEach(() => jest.clearAllMocks());

  it('a driver is routed to updateStatusForCourier', async () => {
    await ctrl.updateStatus('o1', tenant({ role: 'driver', courierIndex: 2 }), dto);
    expect(svc.updateStatusForCourier).toHaveBeenCalledWith('o1', 't', dto);
    expect(svc.updateStatus).not.toHaveBeenCalled();
    expect(svc.updateStatusForFarmer).not.toHaveBeenCalled();
  });
});

// Task C3 — GET /orders/:id (OrderPanel) opened to driver logins alongside
// whatever roles were already allowed.
describe('OrdersController findOne role metadata', () => {
  it('allows admin, farmer, and driver', () => {
    expect(Reflect.getMetadata('roles', OrdersController.prototype.findOne)).toEqual([
      'admin',
      'farmer',
      'driver',
    ]);
  });
});

// PATCH :id/cod-outcome mirrors the same owner-vs-producer scope split as
// PATCH :id/status.
describe('OrdersController setCodOutcome routing', () => {
  const svc = {
    setCodOutcome: jest.fn().mockResolvedValue('owner'),
    setCodOutcomeForFarmer: jest.fn().mockResolvedValue('scoped'),
  };
  const ctrl = new OrdersController(svc as any);
  const tenant = (over: Record<string, unknown>) =>
    ({ type: 'tenant', userId: 'u', tenantId: 't', ...over }) as any;
  const dto = { outcome: 'refused', reason: 'не вдигна' } as any;

  beforeEach(() => jest.clearAllMocks());

  it('an owner edits any order tenant-wide (no producer scope)', async () => {
    await ctrl.setCodOutcome('o1', tenant({ role: 'admin' }), dto);
    expect(svc.setCodOutcome).toHaveBeenCalledWith('o1', 't', dto);
    expect(svc.setCodOutcomeForFarmer).not.toHaveBeenCalled();
  });

  it('a producer is routed to the IDOR-scoped method with their own farmerId', async () => {
    await ctrl.setCodOutcome('o1', tenant({ role: 'farmer', farmerId: 'farmer-1' }), dto);
    expect(svc.setCodOutcomeForFarmer).toHaveBeenCalledWith('o1', 't', 'farmer-1', dto);
    expect(svc.setCodOutcome).not.toHaveBeenCalled();
  });

  it('rejects a malformed farmer token (role=farmer, no farmerId) with 403', () => {
    expect(() => ctrl.setCodOutcome('o1', tenant({ role: 'farmer' }), dto)).toThrow(
      ForbiddenException,
    );
    expect(svc.setCodOutcome).not.toHaveBeenCalled();
    expect(svc.setCodOutcomeForFarmer).not.toHaveBeenCalled();
  });
});

import { BadRequestException } from '@nestjs/common';

// GET /orders/mine mirrors /payments's owner-vs-producer split, but an owner
// has no tenant-wide "mine" (that's just /orders) — so admin without
// ?farmerId is a 400, not a silent fallback.
describe('OrdersController mine routing', () => {
  const svc = {
    ordersForFarmer: jest.fn().mockResolvedValue('scoped'),
  };
  const ctrl = new OrdersController(svc as any);
  const tenant = (over: Record<string, unknown>) =>
    ({ type: 'tenant', userId: 'u', tenantId: 't', ...over }) as any;

  beforeEach(() => jest.clearAllMocks());

  it('a producer is forced to their own farmerId, ignoring ?farmerId', async () => {
    await ctrl.mine(tenant({ role: 'farmer', farmerId: 'farmer-1' }), {
      farmerId: 'farmer-9',
    } as any);
    expect(svc.ordersForFarmer).toHaveBeenCalledWith('t', 'farmer-1', {
      farmerId: 'farmer-9',
    });
  });

  it('an owner with ?farmerId gets that producer\'s view', async () => {
    await ctrl.mine(tenant({ role: 'admin' }), { farmerId: 'farmer-3' } as any);
    expect(svc.ordersForFarmer).toHaveBeenCalledWith('t', 'farmer-3', expect.any(Object));
  });

  it('an owner without ?farmerId gets a 400 (no tenant-wide "mine")', () => {
    expect(() => ctrl.mine(tenant({ role: 'admin' }), {} as any)).toThrow(BadRequestException);
    expect(svc.ordersForFarmer).not.toHaveBeenCalled();
  });

  it('rejects a malformed farmer token (role=farmer, no farmerId) with 403', () => {
    expect(() => ctrl.mine(tenant({ role: 'farmer' }), {} as any)).toThrow();
    expect(svc.ordersForFarmer).not.toHaveBeenCalled();
  });
});

// GET /orders/tomorrow (Task #14) mirrors /mine's owner-vs-producer split —
// no tenant-wide "tomorrow" either (an owner MUST pass ?farmerId).
describe('OrdersController tomorrow routing', () => {
  const svc = { tomorrowForFarmer: jest.fn().mockResolvedValue('scoped') };
  const ctrl = new OrdersController(svc as any);
  const tenant = (over: Record<string, unknown>) =>
    ({ type: 'tenant', userId: 'u', tenantId: 't', ...over }) as any;

  beforeEach(() => jest.clearAllMocks());

  it('a producer is forced to their own farmerId, ignoring ?farmerId', async () => {
    await ctrl.tomorrow(tenant({ role: 'farmer', farmerId: 'farmer-1' }), 'farmer-9');
    expect(svc.tomorrowForFarmer).toHaveBeenCalledWith('t', 'farmer-1');
  });

  it('an owner with ?farmerId gets that producer\'s tomorrow list', async () => {
    await ctrl.tomorrow(tenant({ role: 'admin' }), 'farmer-3');
    expect(svc.tomorrowForFarmer).toHaveBeenCalledWith('t', 'farmer-3');
  });

  it('an owner without ?farmerId gets a 400', () => {
    expect(() => ctrl.tomorrow(tenant({ role: 'admin' }), undefined)).toThrow(BadRequestException);
    expect(svc.tomorrowForFarmer).not.toHaveBeenCalled();
  });

  it('rejects a malformed farmer token (role=farmer, no farmerId) with 403', () => {
    expect(() => ctrl.tomorrow(tenant({ role: 'farmer' }), undefined)).toThrow(ForbiddenException);
    expect(svc.tomorrowForFarmer).not.toHaveBeenCalled();
  });
});

// PATCH :id/fulfillment (Task #14) — same owner-vs-producer scope rule as
// /tomorrow (an owner MUST pass ?farmerId; a producer is forced to their own).
describe('OrdersController setFulfillment routing', () => {
  const svc = { setFulfillment: jest.fn().mockResolvedValue('ok') };
  const ctrl = new OrdersController(svc as any);
  const tenant = (over: Record<string, unknown>) =>
    ({ type: 'tenant', userId: 'u', tenantId: 't', ...over }) as any;
  const dto = { state: 'fulfilled' } as any;

  beforeEach(() => jest.clearAllMocks());

  it('a producer is forced to their own farmerId, ignoring ?farmerId', async () => {
    await ctrl.setFulfillment('o1', tenant({ role: 'farmer', farmerId: 'farmer-1' }), dto, 'farmer-9');
    expect(svc.setFulfillment).toHaveBeenCalledWith('o1', 't', 'farmer-1', 'fulfilled');
  });

  it('an owner with ?farmerId marks on that producer\'s behalf', async () => {
    await ctrl.setFulfillment('o1', tenant({ role: 'admin' }), dto, 'farmer-3');
    expect(svc.setFulfillment).toHaveBeenCalledWith('o1', 't', 'farmer-3', 'fulfilled');
  });

  it('an owner without ?farmerId gets a 400', () => {
    expect(() => ctrl.setFulfillment('o1', tenant({ role: 'admin' }), dto, undefined)).toThrow(
      BadRequestException,
    );
    expect(svc.setFulfillment).not.toHaveBeenCalled();
  });

  it('rejects a malformed farmer token (role=farmer, no farmerId) with 403', () => {
    expect(() => ctrl.setFulfillment('o1', tenant({ role: 'farmer' }), dto, undefined)).toThrow(
      ForbiddenException,
    );
    expect(svc.setFulfillment).not.toHaveBeenCalled();
  });
});
