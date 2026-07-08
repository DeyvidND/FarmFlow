import { RoutingController } from './routing.controller';

describe('RoutingController suggest-days', () => {
  it('delegates to the service with the tenant id and the dto days', async () => {
    const service = { suggestDays: jest.fn().mockResolvedValue({ days: [], unplaced: [] }) };
    const c = new RoutingController(service as any);
    await c.suggestDays('t1', { days: ['2026-07-10', '2026-07-11'] } as any);
    expect(service.suggestDays).toHaveBeenCalledWith('t1', ['2026-07-10', '2026-07-11']);
  });
});
