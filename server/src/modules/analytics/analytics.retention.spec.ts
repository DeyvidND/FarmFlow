import { AnalyticsRetention } from './analytics.retention';

describe('AnalyticsRetention', () => {
  it('deletes rows older than the cutoff', async () => {
    const returning = jest.fn().mockResolvedValue([]);
    const del = jest.fn().mockReturnValue({ returning });
    const db = { delete: () => ({ where: del }) } as any;
    const svc = new AnalyticsRetention(db);
    await svc.prune();
    expect(del).toHaveBeenCalledTimes(1);
    expect(returning).toHaveBeenCalledTimes(1);
  });
});
