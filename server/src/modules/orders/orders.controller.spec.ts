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
  const ctrl = new OrdersController(svc as any, {} as any, {} as any);
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
  const ctrl = new OrdersController(svc as any, {} as any, {} as any);
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

  it('rejects a malformed farmer token (role=farmer, no farmerId) with 403', async () => {
    // updateStatus is `async` (the driver branch awaits the leg-ownership
    // check) — a synchronous throw inside an async function still surfaces as
    // a REJECTED PROMISE to the caller, not a sync throw, so this must assert
    // via `rejects.toThrow`, not the sync `expect(() => ...).toThrow()` form.
    await expect(ctrl.updateStatus('o1', tenant({ role: 'farmer' }), dto)).rejects.toThrow(
      ForbiddenException,
    );
    expect(svc.updateStatus).not.toHaveBeenCalled();
    expect(svc.updateStatusForFarmer).not.toHaveBeenCalled();
  });
});

// Task C3 — a driver (courier login) finishing/undoing from the route screen is
// routed to the transition-restricted updateStatusForCourier, never the plain
// owner path or the farmer IDOR path. Fast-follow (ledger finding #1): this is
// now gated by the same own-leg recompute+check pattern as POST
// /orders/route/measure — a driver may only touch an order on their own leg.
//
// Task A4 — the leg source is no longer the JWT's frozen `user.courierIndex`;
// it's resolved fresh from CourierAssignmentService.resolveMyLeg(tenantId,
// user.userId, orderDate) — the date-scoped board (Task A2). A driver with no
// assignment for that date (resolveMyLeg → null) owns no stops and is denied,
// same as the old "unbound driver" case, but the source of truth flips.
describe('OrdersController updateStatus routing (driver)', () => {
  const svc = {
    updateStatus: jest.fn().mockResolvedValue('owner'),
    updateStatusForFarmer: jest.fn().mockResolvedValue('scoped-farmer'),
    updateStatusForCourier: jest.fn().mockResolvedValue('scoped-courier'),
    findOne: jest.fn(),
  };
  const routing = { getRoute: jest.fn() };
  const courierAssignment = { resolveMyLeg: jest.fn() };
  const ctrl = new OrdersController(svc as any, routing as any, courierAssignment as any);
  const tenant = (over: Record<string, unknown>) =>
    ({ type: 'tenant', userId: 'u', tenantId: 't', ...over }) as any;
  const dto = { status: 'delivered' } as any;
  const order = { id: 'o1', slotDate: '2026-07-16', createdAt: new Date('2026-07-16T09:00:00Z') };
  const ownRoute = {
    routes: [
      { courierIndex: 0, stops: [{ id: 'other-leg-stop' }] },
      { courierIndex: 2, stops: [{ id: 'o1' }] },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    svc.findOne.mockResolvedValue(order);
    routing.getRoute.mockResolvedValue(ownRoute);
  });

  it('a driver assigned leg 2 for the order\'s day is routed to updateStatusForCourier', async () => {
    courierAssignment.resolveMyLeg.mockResolvedValue(2);
    await ctrl.updateStatus('o1', tenant({ role: 'driver' }), dto);
    expect(courierAssignment.resolveMyLeg).toHaveBeenCalledWith('t', 'u', '2026-07-16');
    // 'all' — an order the driver just marked delivered must still resolve to
    // their own leg, so the ownership check has to see finished stops.
    expect(routing.getRoute).toHaveBeenCalledWith('t', '2026-07-16', undefined, undefined, undefined, 'all');
    expect(svc.updateStatusForCourier).toHaveBeenCalledWith('o1', 't', dto);
    expect(svc.updateStatus).not.toHaveBeenCalled();
    expect(svc.updateStatusForFarmer).not.toHaveBeenCalled();
  });

  it('a driver assigned a DIFFERENT leg than the order\'s is rejected with 403', async () => {
    courierAssignment.resolveMyLeg.mockResolvedValue(0);
    await expect(
      ctrl.updateStatus('o1', tenant({ role: 'driver' }), dto),
    ).rejects.toThrow(ForbiddenException);
    expect(svc.updateStatusForCourier).not.toHaveBeenCalled();
  });

  it('a driver with no assignment for that date (resolveMyLeg → null) is rejected with 403', async () => {
    courierAssignment.resolveMyLeg.mockResolvedValue(null);
    await expect(
      ctrl.updateStatus('o1', tenant({ role: 'driver' }), dto),
    ).rejects.toThrow(ForbiddenException);
    expect(svc.updateStatusForCourier).not.toHaveBeenCalled();
    // Unassigned short-circuits before recomputing the route.
    expect(routing.getRoute).not.toHaveBeenCalled();
  });

  it('a slotless order falls back to its creation day (BG local) for the leg resolution', async () => {
    svc.findOne.mockResolvedValue({ id: 'o1', slotDate: null, createdAt: new Date('2026-07-16T21:30:00Z') });
    courierAssignment.resolveMyLeg.mockResolvedValue(2);
    await ctrl.updateStatus('o1', tenant({ role: 'driver' }), dto);
    // 21:30 UTC on 07-16 is past midnight Europe/Sofia (UTC+3 in July) → 07-17.
    expect(courierAssignment.resolveMyLeg).toHaveBeenCalledWith('t', 'u', '2026-07-17');
    expect(routing.getRoute).toHaveBeenCalledWith('t', '2026-07-17', undefined, undefined, undefined, 'all');
  });

  it('the same driver on a different date resolves independently (date-keyed, not frozen)', async () => {
    // Day X: assigned leg 1, which does NOT own o1 on that route snapshot.
    courierAssignment.resolveMyLeg.mockResolvedValueOnce(1);
    await expect(
      ctrl.updateStatus('o1', tenant({ role: 'driver' }), dto),
    ).rejects.toThrow(ForbiddenException);

    // Day X again (same order/date): now assigned leg 2, which DOES own o1.
    courierAssignment.resolveMyLeg.mockResolvedValueOnce(2);
    await ctrl.updateStatus('o1', tenant({ role: 'driver' }), dto);
    expect(svc.updateStatusForCourier).toHaveBeenCalledWith('o1', 't', dto);
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

// Fast-follow (ledger finding #1): GET /orders/:id was opened to role='driver'
// with only tenant-scoping — a driver holding another leg's order UUID could
// read full customer PII. Now gated by the same own-leg recompute+check as
// POST /orders/route/measure and PATCH /orders/:id/status (driver).
//
// Task A4 — leg source is CourierAssignmentService.resolveMyLeg(tenantId,
// user.userId, orderDate), resolved from the ORDER's own delivery date, not
// user.courierIndex (retired from the JWT by this task).
describe('OrdersController findOne (driver leg ownership)', () => {
  const svc = { findOne: jest.fn() };
  const routing = { getRoute: jest.fn() };
  const courierAssignment = { resolveMyLeg: jest.fn() };
  const ctrl = new OrdersController(svc as any, routing as any, courierAssignment as any);
  const tenant = (over: Record<string, unknown>) =>
    ({ type: 'tenant', userId: 'u', tenantId: 't', ...over }) as any;
  const order = { id: 'o1', slotDate: '2026-07-16', createdAt: new Date('2026-07-16T09:00:00Z') };

  beforeEach(() => {
    jest.clearAllMocks();
    svc.findOne.mockResolvedValue(order);
  });

  it('a driver assigned the leg that owns the order gets it back', async () => {
    courierAssignment.resolveMyLeg.mockResolvedValue(2);
    routing.getRoute.mockResolvedValue({ routes: [{ courierIndex: 2, stops: [{ id: 'o1' }] }] });
    const result = await ctrl.findOne('o1', 't', tenant({ role: 'driver' }));
    expect(courierAssignment.resolveMyLeg).toHaveBeenCalledWith('t', 'u', '2026-07-16');
    expect(result).toBe(order);
  });

  it('a driver assigned a leg that does NOT own the order is rejected with 403', async () => {
    courierAssignment.resolveMyLeg.mockResolvedValue(2);
    routing.getRoute.mockResolvedValue({ routes: [{ courierIndex: 0, stops: [{ id: 'other-order' }] }] });
    await expect(ctrl.findOne('o1', 't', tenant({ role: 'driver' }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('a driver with no assignment for that date (resolveMyLeg → null) is rejected with 403', async () => {
    courierAssignment.resolveMyLeg.mockResolvedValue(null);
    await expect(ctrl.findOne('o1', 't', tenant({ role: 'driver' }))).rejects.toThrow(
      ForbiddenException,
    );
    expect(routing.getRoute).not.toHaveBeenCalled();
  });

  it('an admin is never leg-checked (resolveMyLeg/getRoute not called)', async () => {
    const result = await ctrl.findOne('o1', 't', tenant({ role: 'admin' }));
    expect(result).toBe(order);
    expect(courierAssignment.resolveMyLeg).not.toHaveBeenCalled();
    expect(routing.getRoute).not.toHaveBeenCalled();
  });

  it('a farmer is never leg-checked (resolveMyLeg/getRoute not called)', async () => {
    const result = await ctrl.findOne('o1', 't', tenant({ role: 'farmer', farmerId: 'farmer-1' }));
    expect(result).toBe(order);
    expect(courierAssignment.resolveMyLeg).not.toHaveBeenCalled();
    expect(routing.getRoute).not.toHaveBeenCalled();
  });
});

// PATCH :id/cod-outcome mirrors the same owner-vs-producer scope split as
// PATCH :id/status.
describe('OrdersController setCodOutcome routing', () => {
  const svc = {
    setCodOutcome: jest.fn().mockResolvedValue('owner'),
    setCodOutcomeForFarmer: jest.fn().mockResolvedValue('scoped'),
  };
  const ctrl = new OrdersController(svc as any, {} as any, {} as any);
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
  const ctrl = new OrdersController(svc as any, {} as any, {} as any);
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

// GET /orders/prep mirrors /mine's owner-vs-producer split — no tenant-wide
// "prep" either (an owner MUST pass ?farmerId).
describe('OrdersController prep routing', () => {
  const svc = { prepSummary: jest.fn().mockResolvedValue('scoped') };
  const ctrl = new OrdersController(svc as any, {} as any, {} as any);
  const tenant = (over: Record<string, unknown>) =>
    ({ type: 'tenant', userId: 'u', tenantId: 't', ...over }) as any;

  beforeEach(() => jest.clearAllMocks());

  it('a producer is forced to their own farmerId, ignoring ?farmerId', async () => {
    await ctrl.prep(tenant({ role: 'farmer', farmerId: 'farmer-1' }), undefined, 'farmer-9');
    expect(svc.prepSummary).toHaveBeenCalledWith('t', 'farmer-1', undefined);
  });

  it('an owner with ?farmerId gets that producer\'s prep list', async () => {
    await ctrl.prep(tenant({ role: 'admin' }), undefined, 'farmer-3');
    expect(svc.prepSummary).toHaveBeenCalledWith('t', 'farmer-3', undefined);
  });

  it('passes the ?date query through to prepSummary', async () => {
    await ctrl.prep(tenant({ role: 'farmer', farmerId: 'farmer-1' }), '2026-07-15', undefined);
    expect(svc.prepSummary).toHaveBeenCalledWith('t', 'farmer-1', '2026-07-15');
  });

  it('an owner without ?farmerId gets a 400', async () => {
    // prep() is async (it also fetches the route to order the feed) — the guard
    // now rejects the promise rather than throwing synchronously.
    await expect(ctrl.prep(tenant({ role: 'admin' }), undefined, undefined)).rejects.toThrow(
      BadRequestException,
    );
    expect(svc.prepSummary).not.toHaveBeenCalled();
  });

  it('rejects a malformed farmer token (role=farmer, no farmerId) with 403', async () => {
    await expect(ctrl.prep(tenant({ role: 'farmer' }), undefined, undefined)).rejects.toThrow(
      ForbiddenException,
    );
    expect(svc.prepSummary).not.toHaveBeenCalled();
  });
});

// GET /orders/prep for a courier login (role='driver') — a driver has no
// farmerId at all, so it's routed to prepForDriver instead of prepSummary:
// resolve the driver's own leg for the day (same recompute as
// assertDriverOwnsOrder), then collect that leg's order ids from the
// recomputed route and hand them to a leg-scoped service method.
describe('OrdersController prep routing — driver', () => {
  const legSummary = (orders: any[]) => ({
    date: '2026-07-16',
    confirmedOrders: orders.length,
    pendingOrders: 0,
    orders,
  });
  const svc = {
    prepSummary: jest.fn(),
    prepForCourierLeg: jest.fn().mockResolvedValue(legSummary([])),
  };
  const routing = { getRoute: jest.fn() };
  const assignments = { resolveMyLeg: jest.fn() };
  const ctrl = new OrdersController(svc as any, routing as any, assignments as any);
  const driver = (over: Record<string, unknown> = {}) =>
    ({ type: 'tenant', role: 'driver', userId: 'driver-1', tenantId: 't', ...over }) as any;

  beforeEach(() => jest.clearAllMocks());

  it('an unassigned driver (no leg for the day) gets an empty summary without touching the route or prep query', async () => {
    assignments.resolveMyLeg.mockResolvedValue(null);
    const result = await ctrl.prep(driver(), '2026-07-16', undefined);

    expect(assignments.resolveMyLeg).toHaveBeenCalledWith('t', 'driver-1', '2026-07-16');
    expect(routing.getRoute).not.toHaveBeenCalled();
    expect(svc.prepForCourierLeg).not.toHaveBeenCalled();
    expect(svc.prepSummary).not.toHaveBeenCalled();
    expect(result).toEqual({ date: '2026-07-16', confirmedOrders: 0, pendingOrders: 0, orders: [] });
  });

  it('an assigned driver gets ONLY their own leg\'s order ids, route-ordered, never a raw farmerId path', async () => {
    assignments.resolveMyLeg.mockResolvedValue(1);
    routing.getRoute.mockResolvedValue({
      routes: [
        { courierIndex: 0, name: null, stops: [{ id: 'order-a' }, { id: 'order-b' }] },
        { courierIndex: 1, name: 'Васил', stops: [{ id: 'order-c' }, { id: 'order-d' }] },
      ],
    });
    // Service returns the leg's orders in a NON-route order; the controller must
    // re-sort them to the route (order-c stop 1, order-d stop 2) and stamp each.
    svc.prepForCourierLeg.mockResolvedValueOnce(
      legSummary([
        { id: 'order-d', routeSeq: null, courierIndex: null, courierName: null },
        { id: 'order-c', routeSeq: null, courierIndex: null, courierName: null },
      ]),
    );

    const result = await ctrl.prep(driver(), '2026-07-16', undefined);

    // 'all' — the packing list is this leg's whole load for the day and must not
    // shrink as the courier delivers. Previously this took getRoute's default,
    // which resolved the leg from a confirmed-only split: the partition moved as
    // stops were completed and the list could name another courier's orders.
    expect(routing.getRoute).toHaveBeenCalledWith('t', '2026-07-16', undefined, undefined, undefined, 'all');
    expect(svc.prepForCourierLeg).toHaveBeenCalledWith('t', ['order-c', 'order-d'], '2026-07-16');
    expect(svc.prepSummary).not.toHaveBeenCalled();
    // Sorted to route order + stamped with leg 1's position and courier name.
    expect(result.orders.map((o: any) => o.id)).toEqual(['order-c', 'order-d']);
    expect(result.orders[0]).toMatchObject({ routeSeq: 1, courierIndex: 1, courierName: 'Васил' });
    expect(result.orders[1]).toMatchObject({ routeSeq: 2, courierIndex: 1, courierName: 'Васил' });
  });

  it('ignores a query ?farmerId entirely for a driver — no farmerId concept applies', async () => {
    assignments.resolveMyLeg.mockResolvedValue(null);
    await ctrl.prep(driver(), '2026-07-16', 'farmer-9');
    expect(svc.prepSummary).not.toHaveBeenCalled();
  });

  it('defaults the date to today when none is given', async () => {
    assignments.resolveMyLeg.mockResolvedValue(null);
    const result = await ctrl.prep(driver(), undefined, undefined);
    expect(assignments.resolveMyLeg).toHaveBeenCalledWith('t', 'driver-1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// PATCH :id/fulfillment (Task #14) — same owner-vs-producer scope rule as
// /tomorrow (an owner MUST pass ?farmerId; a producer is forced to their own).
describe('OrdersController setFulfillment routing', () => {
  const svc = { setFulfillment: jest.fn().mockResolvedValue('ok') };
  const ctrl = new OrdersController(svc as any, {} as any, {} as any);
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
