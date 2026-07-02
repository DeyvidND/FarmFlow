import { TrackController, AnalyticsController } from './analytics.controller';

describe('analytics controllers', () => {
  it('track passes slug/body/ip/ua through to the service', async () => {
    const svc = { track: jest.fn().mockResolvedValue(undefined) } as any;
    const c = new TrackController(svc);
    await c.track('ferma', { type: 'page_view', path: '/' } as any, '1.2.3.4', 'UA');
    expect(svc.track).toHaveBeenCalledWith('ferma', { type: 'page_view', path: '/' }, '1.2.3.4', 'UA');
  });

  it('summary scopes to the caller tenant', () => {
    const svc = { summary: jest.fn().mockReturnValue('x') } as any;
    const c = new AnalyticsController(svc);
    c.summary({ tenantId: 't1', role: 'farmer' } as any, '30d', undefined, undefined);
    expect(svc.summary).toHaveBeenCalledWith('t1', { range: '30d', from: undefined, to: undefined });
  });
});
