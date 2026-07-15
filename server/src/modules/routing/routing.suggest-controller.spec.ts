import { RoutingController } from './routing.controller';

describe('RoutingController suggest-days', () => {
  it('delegates to the service with the tenant id and the per-day couriers dto', async () => {
    const service = { suggestDays: jest.fn().mockResolvedValue({ days: [], unplaced: [] }) };
    // courierAccessService/courierAssignmentService are unused by suggestDays — pass stubs.
    const c = new RoutingController(service as any, {} as any, {} as any);
    const days = [
      { date: '2026-07-10', couriers: 2 },
      { date: '2026-07-11', couriers: 1 },
    ];
    await c.suggestDays('t1', { days } as any);
    expect(service.suggestDays).toHaveBeenCalledWith('t1', days);
  });
});
