import { RoutingService } from './routing.service';

describe('RoutingService.reverseGeocode', () => {
  it('delegates to MapsService.reverseGeocode and wraps the result', async () => {
    const maps = { reverseGeocode: jest.fn().mockResolvedValue('ул. Шипка 5, Варна') } as any;
    const svc = new RoutingService({} as any, maps);

    const out = await svc.reverseGeocode(43.2, 27.9);

    expect(maps.reverseGeocode).toHaveBeenCalledWith(43.2, 27.9);
    expect(out).toEqual({ address: 'ул. Шипка 5, Варна' });
  });

  it('wraps a null result (no match) the same way', async () => {
    const maps = { reverseGeocode: jest.fn().mockResolvedValue(null) } as any;
    const svc = new RoutingService({} as any, maps);

    const out = await svc.reverseGeocode(0, 0);

    expect(out).toEqual({ address: null });
  });
});
