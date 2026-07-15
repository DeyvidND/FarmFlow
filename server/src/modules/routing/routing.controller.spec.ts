import { RoutingController } from './routing.controller';

// Task A3 — a driver login (role='driver') sees only the leg resolved for
// them ON THAT DATE via CourierAssignmentService.resolveMyLeg (Task A2's
// per-day assignment board), NOT a global JWT-bound courierIndex: the SAME
// driver can resolve to a different leg (or no leg at all) on a different
// date. An admin's request is completely unaffected.
describe('RoutingController getRoute driver-scoping', () => {
  const routes = [
    { courierIndex: 0, stops: ['a'] },
    { courierIndex: 1, stops: ['b'] },
  ];
  const service = {
    getRoute: jest.fn().mockResolvedValue({ routes, couriers: 2 }),
  };
  const courierAssignmentService = {
    resolveMyLeg: jest.fn(),
  };
  const c = new RoutingController(service as any, {} as any, courierAssignmentService as any);

  beforeEach(() => jest.clearAllMocks());

  it('ignores couriers/ends query params for a driver and filters the response to their resolved leg', async () => {
    const user = { type: 'tenant', role: 'driver', userId: 'u1' } as any;
    courierAssignmentService.resolveMyLeg.mockResolvedValue(1);
    const result = await c.getRoute('t1', user, '2026-07-15', undefined, '5', 'home,last');
    expect(service.getRoute).toHaveBeenCalledWith('t1', '2026-07-15', undefined, undefined, undefined);
    expect(courierAssignmentService.resolveMyLeg).toHaveBeenCalledWith('t1', 'u1', '2026-07-15');
    expect(result).toEqual({ routes: [{ courierIndex: 1, stops: ['b'] }], couriers: 1 });
  });

  it('a driver with no assignment for the date gets an empty routes list ("не участва днес")', async () => {
    const user = { type: 'tenant', role: 'driver', userId: 'u1' } as any;
    courierAssignmentService.resolveMyLeg.mockResolvedValue(null);
    const result = await c.getRoute('t1', user, '2026-07-15');
    expect(result).toEqual({ routes: [], couriers: 0 });
  });

  it('a driver request with no date at all gets an empty routes list (never calls resolveMyLeg)', async () => {
    const user = { type: 'tenant', role: 'driver', userId: 'u1' } as any;
    const result = await c.getRoute('t1', user);
    expect(courierAssignmentService.resolveMyLeg).not.toHaveBeenCalled();
    expect(result).toEqual({ routes: [], couriers: 0 });
  });

  it('re-resolves per date: the SAME driver sees a different leg on a different date', async () => {
    const user = { type: 'tenant', role: 'driver', userId: 'u1' } as any;

    courierAssignmentService.resolveMyLeg.mockResolvedValueOnce(1);
    const dayX = await c.getRoute('t1', user, '2026-07-15');
    expect(dayX).toEqual({ routes: [{ courierIndex: 1, stops: ['b'] }], couriers: 1 });

    courierAssignmentService.resolveMyLeg.mockResolvedValueOnce(0);
    const dayY = await c.getRoute('t1', user, '2026-07-16');
    expect(dayY).toEqual({ routes: [{ courierIndex: 0, stops: ['a'] }], couriers: 1 });

    expect(courierAssignmentService.resolveMyLeg).toHaveBeenNthCalledWith(1, 't1', 'u1', '2026-07-15');
    expect(courierAssignmentService.resolveMyLeg).toHaveBeenNthCalledWith(2, 't1', 'u1', '2026-07-16');
  });

  it('an admin request is unaffected: couriers/ends pass through, all routes come back, resolveMyLeg is never called', async () => {
    const user = { type: 'tenant', role: 'admin' } as any;
    const result = await c.getRoute('t1', user, '2026-07-15', 'last', '5', 'home,last');
    expect(service.getRoute).toHaveBeenCalledWith('t1', '2026-07-15', 'last', 5, ['home', 'last']);
    expect(courierAssignmentService.resolveMyLeg).not.toHaveBeenCalled();
    expect(result).toEqual({ routes, couriers: 2 });
  });
});

// Task A3 — a driver may only ever measure the leg resolved for them ON THAT
// DATE via resolveMyLeg; the request body's courierIndex is ignored and
// overridden, and the requested stopIds are checked against that resolved
// leg (getRoute) so a crafted stopIds list can't read back another courier's
// polyline/distance. An unassigned driver (resolveMyLeg → null) owns no
// stops, so any non-empty stopIds is rejected.
describe('RoutingController measure driver-scoping', () => {
  const ownRoute = {
    routes: [
      { courierIndex: 2, stops: [{ id: 's1' }, { id: 's2' }] },
      { courierIndex: 5, stops: [{ id: 'other' }] },
    ],
  };
  const service = {
    measureExplicitOrder: jest.fn().mockResolvedValue({ polyline: 'x' }),
    getRoute: jest.fn().mockResolvedValue(ownRoute),
  };
  const courierAssignmentService = {
    resolveMyLeg: jest.fn(),
  };
  const c = new RoutingController(service as any, {} as any, courierAssignmentService as any);

  beforeEach(() => jest.clearAllMocks());
  beforeEach(() => service.getRoute.mockResolvedValue(ownRoute));

  it("overrides dto.courierIndex with the driver's resolved leg, allows own-leg stopIds", async () => {
    const user = { type: 'tenant', role: 'driver', userId: 'u1' } as any;
    const dto = { date: '2026-07-15', stopIds: ['s1'], courierIndex: 9, endMode: 'home' } as any;
    courierAssignmentService.resolveMyLeg.mockResolvedValue(2);
    await c.measure('t1', user, dto);
    expect(courierAssignmentService.resolveMyLeg).toHaveBeenCalledWith('t1', 'u1', '2026-07-15');
    expect(service.getRoute).toHaveBeenCalledWith('t1', '2026-07-15', 'home');
    expect(service.measureExplicitOrder).toHaveBeenCalledWith(
      't1', '2026-07-15', ['s1'], 2, 'home', undefined,
    );
  });

  it("rejects a driver requesting a stopId from another courier's leg", async () => {
    const user = { type: 'tenant', role: 'driver', userId: 'u1' } as any;
    const dto = { date: '2026-07-15', stopIds: ['other'], courierIndex: 2, endMode: 'home' } as any;
    courierAssignmentService.resolveMyLeg.mockResolvedValue(2);
    await expect(c.measure('t1', user, dto)).rejects.toThrow('Не може да измервате чужд маршрут.');
    expect(service.measureExplicitOrder).not.toHaveBeenCalled();
  });

  it('rejects a stopId requested by a driver unassigned for that date (resolveMyLeg → null)', async () => {
    const user = { type: 'tenant', role: 'driver', userId: 'u1' } as any;
    const dto = { date: '2026-07-15', stopIds: ['s1'], courierIndex: 2, endMode: 'home' } as any;
    courierAssignmentService.resolveMyLeg.mockResolvedValue(null);
    await expect(c.measure('t1', user, dto)).rejects.toThrow('Не може да измервате чужд маршрут.');
    expect(service.measureExplicitOrder).not.toHaveBeenCalled();
  });

  it('leaves dto.courierIndex untouched for an admin and skips the own-leg check', async () => {
    const user = { type: 'tenant', role: 'admin' } as any;
    const dto = { date: '2026-07-15', stopIds: ['s1'], courierIndex: 3, endMode: 'home' } as any;
    await c.measure('t1', user, dto);
    expect(service.getRoute).not.toHaveBeenCalled();
    expect(courierAssignmentService.resolveMyLeg).not.toHaveBeenCalled();
    expect(service.measureExplicitOrder).toHaveBeenCalledWith(
      't1', '2026-07-15', ['s1'], 3, 'home', undefined,
    );
  });
});
