import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { StatsController } from './stats.controller';

describe('StatsController routing', () => {
  const svc = {
    stats: jest.fn().mockResolvedValue('whole'),
    statsForFarmer: jest.fn().mockResolvedValue('scoped'),
    turnoverBreakdown: jest.fn().mockResolvedValue('turnover'),
  };
  const ctrl = new StatsController(svc as any, {} as any, {} as any);

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

  describe('P&L и разходи', () => {
    const pnlSvc = { pnl: jest.fn().mockResolvedValue('pnl') };
    const expSvc = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'exp-1' }),
      update: jest.fn().mockResolvedValue({ id: 'exp-1' }),
      remove: jest.fn().mockResolvedValue({ ok: true }),
      setCommissionBps: jest.fn().mockResolvedValue({ bps: 1000 }),
    };
    const c = new StatsController(svc as any, pnlSvc as any, expSvc as any);
    const owner = { type: 'tenant', userId: 'user-1', tenantId: 't', role: 'admin' } as any;

    beforeEach(() => jest.clearAllMocks());

    it('pnl подава прозореца на сервиза', async () => {
      await c.pnl(owner, '30d', undefined, undefined);
      expect(pnlSvc.pnl).toHaveBeenCalledWith('t', { range: '30d', from: undefined, to: undefined });
    });

    it('create записва автора от токена, не от тялото', async () => {
      await c.createExpense(owner, { date: '2026-07-20', amountStotinki: 100, category: 'fuel' } as any);
      expect(expSvc.create).toHaveBeenCalledWith('t', 'user-1', expect.objectContaining({ category: 'fuel' }));
    });

    it('update и delete подават tenantId от токена', async () => {
      await c.updateExpense(owner, 'exp-1', { amountStotinki: 200 } as any);
      expect(expSvc.update).toHaveBeenCalledWith('t', 'exp-1', { amountStotinki: 200 });
      await c.deleteExpense(owner, 'exp-1');
      expect(expSvc.remove).toHaveBeenCalledWith('t', 'exp-1');
    });

    it('процентът се записва за наемателя от токена', async () => {
      await c.setCommission(owner, { bps: 1500 } as any);
      expect(expSvc.setCommissionBps).toHaveBeenCalledWith('t', 1500);
    });
  });

  describe('роли', () => {
    // Пазачът е глобален (TenantRolesGuard) и чете @Roles през
    // reflector.getAllAndOverride([handler, class]) — метод бие клас. Тестът
    // проверява метаданните, защото пазачът не минава през unit теста.
    const ROLES_KEY = 'roles';
    it('новите ендпойнти са само за собственик, въпреки че класът пуска и farmer', () => {
      const reflect = (m: string) => Reflect.getMetadata(ROLES_KEY, (StatsController.prototype as any)[m]);
      for (const m of ['pnl', 'listExpenses', 'createExpense', 'updateExpense', 'deleteExpense', 'setCommission']) {
        expect(reflect(m)).toEqual(['admin']);
      }
      // Старите остават отворени за производител.
      expect(Reflect.getMetadata(ROLES_KEY, StatsController)).toEqual(['admin', 'farmer']);
    });
  });
});
