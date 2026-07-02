import { AnalyticsRetention } from './analytics.retention';

describe('AnalyticsRetention', () => {
  it('deletes rows older than the cutoff', async () => {
    const del = jest.fn().mockResolvedValue(undefined);
    const db = { delete: () => ({ where: del }) } as any;
    const svc = new AnalyticsRetention(db);
    await svc.prune();
    expect(del).toHaveBeenCalledTimes(1);
  });
});
