import { RoutingService } from './routing.service';

// Proves the tenant's saved courier default (settings.routing.courierCount) is
// applied when the request omits ?couriers=, that an explicit ?couriers= still
// wins, and that the fallback is 1 when neither is set. Mirrors the mocked-db
// style of routing.humanize-order.spec.ts.
describe('RoutingService.getRoute — saved courier count default', () => {
  function makeDb(selectResults: any[][]) {
    const results = [...selectResults];
    const db = {
      select: () => {
        const result = results.length ? results.shift()! : [];
        const chain: any = {
          from: () => chain,
          leftJoin: () => chain,
          where: () => chain,
          orderBy: () => Promise.resolve(result),
          limit: () => Promise.resolve(result),
          then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
        };
        return chain;
      },
    } as any;
    return db;
  }

  const geoOrder = (id: string, lat: number, lng: number) => ({
    id,
    customer: null,
    phone: null,
    email: null,
    address: `адрес ${id}`,
    note: null,
    lat: String(lat),
    lng: String(lng),
  });

  // Six geocoded stops in distinct bearings around the depot, so a sweep split
  // has room to carve the requested number of couriers.
  const stops = () => [
    geoOrder('A', 43.24, 27.90),
    geoOrder('B', 43.23, 27.95),
    geoOrder('C', 43.20, 27.98),
    geoOrder('D', 43.16, 27.96),
    geoOrder('E', 43.14, 27.90),
    geoOrder('F', 43.18, 27.86),
  ];

  const makeMaps = () =>
    ({
      route: jest.fn(async (_o: any, pts: any[]) => ({
        order: pts.map((_: any, i: number) => i),
        distanceM: 1000,
        durationS: 600,
        polyline: 'g',
      })),
      routeFixed: jest.fn().mockResolvedValue({ distanceM: 900, durationS: 600, polyline: 'r' }),
      geocode: jest.fn(),
    }) as any;

  const tenant = (routing: Record<string, unknown>) => ({
    farmAddress: 'Ферма',
    farmLat: '43.17',
    farmLng: '27.84',
    settings: { routing },
  });

  it('splits by the saved courierCount when ?couriers= is absent', async () => {
    const db = makeDb([[tenant({ courierCount: 3 })], stops(), []]);
    const svc = new RoutingService(db, makeMaps(), {} as any);

    const result = await svc.getRoute('t1', '2026-07-07'); // no endMode, no couriers

    expect(result.couriers).toBe(3);
    expect(result.routes).toHaveLength(3);
  });

  it('lets an explicit ?couriers= override the saved default', async () => {
    const db = makeDb([[tenant({ courierCount: 3 })], stops(), []]);
    const svc = new RoutingService(db, makeMaps(), {} as any);

    const result = await svc.getRoute('t1', '2026-07-07', undefined, 2); // 2 wins over saved 3

    expect(result.couriers).toBe(2);
  });

  it('falls back to a single courier when neither is set', async () => {
    const db = makeDb([[tenant({})], stops(), []]);
    const svc = new RoutingService(db, makeMaps(), {} as any);

    const result = await svc.getRoute('t1', '2026-07-07');

    expect(result.couriers).toBe(1);
  });
});
