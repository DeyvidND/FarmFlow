import { ForbiddenException } from '@nestjs/common';
import { StatsController } from './stats.controller';

describe('StatsController routing', () => {
  const svc = {
    stats: jest.fn().mockResolvedValue('whole'),
    statsForFarmer: jest.fn().mockResolvedValue('scoped'),
    turnoverBreakdown: jest.fn().mockResolvedValue('turnover'),
  };
  const ctrl = new StatsController(svc as any);

  beforeEach(() => jest.clearAllMocks());

  it('a producer is forced to their own farmerId, ignoring the query', async () => {
    await ctrl.stats(
      { type: 'tenant', userId: 'u', tenantId: 't', role: 'farmer', farmerId: 'farmer-1' } as any,
      '30d', undefined, undefined, 'farmer-9',
    );
    expect(svc.statsForFarmer).toHaveBeenCalledWith('t', 'farmer-1', { range: '30d', from: undefined, to: undefined });
    expect(svc.stats).not.toHaveBeenCalled();
  });

  it('an owner with ?farmerId gets the scoped stats', async () => {
    await ctrl.stats(
      { type: 'tenant', userId: 'u', tenantId: 't', role: 'admin' } as any,
      '30d', undefined, undefined, 'farmer-3',
    );
    expect(svc.statsForFarmer).toHaveBeenCalledWith('t', 'farmer-3', expect.any(Object));
  });

  it('an owner without a farmerId gets whole-tenant stats', async () => {
    await ctrl.stats(
      { type: 'tenant', userId: 'u', tenantId: 't', role: 'admin' } as any,
      '30d', undefined, undefined, undefined,
    );
    expect(svc.stats).toHaveBeenCalledWith('t', { range: '30d', from: undefined, to: undefined });
    expect(svc.statsForFarmer).not.toHaveBeenCalled();
  });

  it('rejects a malformed farmer token (role=farmer, no farmerId) with 403', () => {
    expect(() =>
      ctrl.stats(
        { type: 'tenant', userId: 'u', tenantId: 't', role: 'farmer' } as any,
        '30d', undefined, undefined, undefined,
      ),
    ).toThrow(ForbiddenException);
    expect(svc.stats).not.toHaveBeenCalled();
    expect(svc.statsForFarmer).not.toHaveBeenCalled();
  });

  describe('GET /stats/turnover (Task #9/#10)', () => {
    it('a producer is forced to their own farmerId, ignoring the query', async () => {
      await ctrl.turnover(
        { type: 'tenant', userId: 'u', tenantId: 't', role: 'farmer', farmerId: 'farmer-1' } as any,
        '30d', undefined, undefined, 'delivered', 'false', 'farmer-9',
      );
      expect(svc.turnoverBreakdown).toHaveBeenCalledWith('t', {
        range: '30d', from: undefined, to: undefined, basis: 'delivered',
        includeUndelivered: false, farmerId: 'farmer-1',
      });
    });

    it('an owner without ?farmerId gets the whole-tenant breakdown (farmerId undefined)', async () => {
      await ctrl.turnover(
        { type: 'tenant', userId: 'u', tenantId: 't', role: 'admin' } as any,
        '30d', undefined, undefined, undefined, undefined, undefined,
      );
      expect(svc.turnoverBreakdown).toHaveBeenCalledWith('t', {
        range: '30d', from: undefined, to: undefined, basis: undefined,
        includeUndelivered: undefined, farmerId: undefined,
      });
    });

    it('includeUndelivered omitted → undefined (service now defaults it to false); "false" → false; any other value → true', async () => {
      await ctrl.turnover({ type: 'tenant', userId: 'u', tenantId: 't', role: 'admin' } as any, undefined, undefined, undefined, undefined, undefined, undefined);
      expect(svc.turnoverBreakdown).toHaveBeenLastCalledWith('t', expect.objectContaining({ includeUndelivered: undefined }));

      await ctrl.turnover({ type: 'tenant', userId: 'u', tenantId: 't', role: 'admin' } as any, undefined, undefined, undefined, undefined, 'true', undefined);
      expect(svc.turnoverBreakdown).toHaveBeenLastCalledWith('t', expect.objectContaining({ includeUndelivered: true }));

      await ctrl.turnover({ type: 'tenant', userId: 'u', tenantId: 't', role: 'admin' } as any, undefined, undefined, undefined, undefined, 'false', undefined);
      expect(svc.turnoverBreakdown).toHaveBeenLastCalledWith('t', expect.objectContaining({ includeUndelivered: false }));
    });

    it('rejects a malformed farmer token (role=farmer, no farmerId) with 403', () => {
      expect(() =>
        ctrl.turnover(
          { type: 'tenant', userId: 'u', tenantId: 't', role: 'farmer' } as any,
          undefined, undefined, undefined, undefined, undefined, undefined,
        ),
      ).toThrow(ForbiddenException);
      expect(svc.turnoverBreakdown).not.toHaveBeenCalled();
    });
  });
});
