import { RoutingController } from './routing.controller';

// Task C3 — a driver login (role='driver', bound to a courier leg via
// user.courierIndex from Task C1/C2) sees only their own leg of the route and
// cannot request a different courier count / end-mode shape than the
// tenant's default. An admin's request is completely unaffected.
describe('RoutingController getRoute driver-scoping', () => {
  const routes = [
    { courierIndex: 0, stops: ['a'] },
    { courierIndex: 1, stops: ['b'] },
  ];
  const service = {
    getRoute: jest.fn().mockResolvedValue({ routes, unplaced: [] }),
  };
  // courierAccessService is unused by getRoute — pass a stub.
  const c = new RoutingController(service as any, {} as any);

  beforeEach(() => jest.clearAllMocks());

  it('ignores couriers/ends query params for a driver and filters the response to their own leg', async () => {
    const user = { type: 'tenant', role: 'driver', courierIndex: 1 } as any;
    const result = await c.getRoute('t1', user, '2026-07-15', undefined, '5', 'home,last');
    expect(service.getRoute).toHaveBeenCalledWith('t1', '2026-07-15', undefined, undefined, undefined);
    expect(result).toEqual({ routes: [{ courierIndex: 1, stops: ['b'] }], unplaced: [] });
  });

  it('a driver with no bound courierIndex gets an empty routes list', async () => {
    const user = { type: 'tenant', role: 'driver', courierIndex: undefined } as any;
    const result = await c.getRoute('t1', user);
    expect(result).toEqual({ routes: [], unplaced: [] });
  });

  it('an admin request is unaffected: couriers/ends pass through and all routes come back', async () => {
    const user = { type: 'tenant', role: 'admin' } as any;
    const result = await c.getRoute('t1', user, '2026-07-15', 'last', '5', 'home,last');
    expect(service.getRoute).toHaveBeenCalledWith('t1', '2026-07-15', 'last', 5, ['home', 'last']);
    expect(result).toEqual({ routes, unplaced: [] });
  });
});

// Task C3 — a driver may only ever measure their OWN courier leg; the request
// body's courierIndex is ignored and overridden with the token's.
describe('RoutingController measure driver-scoping', () => {
  const service = {
    measureExplicitOrder: jest.fn().mockResolvedValue({ polyline: 'x' }),
  };
  const c = new RoutingController(service as any, {} as any);

  beforeEach(() => jest.clearAllMocks());

  it('overrides dto.courierIndex with the driver\'s own courierIndex', async () => {
    const user = { type: 'tenant', role: 'driver', courierIndex: 2 } as any;
    const dto = { date: '2026-07-15', stopIds: ['s1'], courierIndex: 9, endMode: 'home' } as any;
    await c.measure('t1', user, dto);
    expect(service.measureExplicitOrder).toHaveBeenCalledWith(
      't1', '2026-07-15', ['s1'], 2, 'home', undefined,
    );
  });

  it('leaves dto.courierIndex untouched for an admin', async () => {
    const user = { type: 'tenant', role: 'admin' } as any;
    const dto = { date: '2026-07-15', stopIds: ['s1'], courierIndex: 3, endMode: 'home' } as any;
    await c.measure('t1', user, dto);
    expect(service.measureExplicitOrder).toHaveBeenCalledWith(
      't1', '2026-07-15', ['s1'], 3, 'home', undefined,
    );
  });
});
