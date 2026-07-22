import { ForbiddenException } from '@nestjs/common';
import { ConsolidatedProtocolController } from './consolidated-protocol.controller';

const TENANT = 't1';
const ADMIN = { type: 'tenant', role: 'admin', userId: 'u-owner', tenantId: TENANT } as any;
const DRIVER = { type: 'tenant', role: 'driver', userId: 'u-driver', tenantId: TENANT } as any;

function make() {
  const svc = {
    getView: jest.fn(),
    listForDay: jest.fn(),
    ensureDraft: jest.fn(),
    updateDraft: jest.fn(),
    sign: jest.fn(),
    getCourierRecipients: jest.fn(),
    sendLegProtocolsToCouriers: jest.fn(),
  };
  const courierAssignment = { resolveMyLeg: jest.fn() };
  return { svc, courierAssignment, ctrl: new ConsolidatedProtocolController(svc as any, courierAssignment as any) };
}

describe('ConsolidatedProtocolController — leg ownership guard', () => {
  it("an admin can open ANY leg's protocol without an ownership check", async () => {
    const { ctrl, svc, courierAssignment } = make();
    svc.getView.mockResolvedValue({ id: 'cp1', scope: 'leg', legIndex: 2, date: '2026-07-22' });
    await ctrl.getOne(TENANT, ADMIN, 'cp1');
    expect(courierAssignment.resolveMyLeg).not.toHaveBeenCalled();
  });

  it("the driver assigned to THIS protocol's own leg can open it", async () => {
    const { ctrl, svc, courierAssignment } = make();
    svc.getView.mockResolvedValue({ id: 'cp1', scope: 'leg', legIndex: 2, date: '2026-07-22' });
    courierAssignment.resolveMyLeg.mockResolvedValue(2);
    const out = await ctrl.getOne(TENANT, DRIVER, 'cp1');
    expect(out).toBeDefined();
    expect(courierAssignment.resolveMyLeg).toHaveBeenCalledWith(TENANT, 'u-driver', '2026-07-22');
  });

  it('a driver assigned to a DIFFERENT leg is forbidden', async () => {
    const { ctrl, svc, courierAssignment } = make();
    svc.getView.mockResolvedValue({ id: 'cp1', scope: 'leg', legIndex: 2, date: '2026-07-22' });
    courierAssignment.resolveMyLeg.mockResolvedValue(0); // driver's OWN leg for the day
    await expect(ctrl.getOne(TENANT, DRIVER, 'cp1')).rejects.toThrow(ForbiddenException);
  });

  it('a driver with NO assignment that day is forbidden, not shown an empty document', async () => {
    const { ctrl, svc, courierAssignment } = make();
    svc.getView.mockResolvedValue({ id: 'cp1', scope: 'leg', legIndex: 2, date: '2026-07-22' });
    courierAssignment.resolveMyLeg.mockResolvedValue(null);
    await expect(ctrl.getOne(TENANT, DRIVER, 'cp1')).rejects.toThrow(ForbiddenException);
  });

  it('a driver can NEVER open a scope=day protocol, regardless of leg', async () => {
    const { ctrl, svc, courierAssignment } = make();
    svc.getView.mockResolvedValue({ id: 'cp-day', scope: 'day', legIndex: null, date: '2026-07-22' });
    await expect(ctrl.getOne(TENANT, DRIVER, 'cp-day')).rejects.toThrow(ForbiddenException);
    expect(courierAssignment.resolveMyLeg).not.toHaveBeenCalled(); // day is refused outright, no leg check needed
  });
});

describe('ConsolidatedProtocolController — overrides PATCH stays admin-only', () => {
  it('has no @Roles decorator opening it to driver — the global default-deny handles it', () => {
    const meta = Reflect.getMetadata('roles', ConsolidatedProtocolController.prototype.updateOverrides);
    expect(meta).toBeUndefined();
  });
});

describe('ConsolidatedProtocolController — §4.4 "Прати на куриерите"', () => {
  it('has no @Roles decorator on courier-recipients — admin-only via the global default-deny', () => {
    const meta = Reflect.getMetadata('roles', ConsolidatedProtocolController.prototype.courierRecipients);
    expect(meta).toBeUndefined();
  });

  it('has no @Roles decorator on send-to-couriers — admin-only via the global default-deny', () => {
    const meta = Reflect.getMetadata('roles', ConsolidatedProtocolController.prototype.sendToCouriers);
    expect(meta).toBeUndefined();
  });

  it('courierRecipients delegates to the service with the tenant + date, unchanged', async () => {
    const { ctrl, svc } = make();
    svc.getCourierRecipients.mockResolvedValue([{ legIndex: 0, name: 'Лег 1', email: 'a@x.bg' }]);

    const out = await ctrl.courierRecipients(TENANT, { date: '2026-07-22' } as any);

    expect(svc.getCourierRecipients).toHaveBeenCalledWith(TENANT, '2026-07-22');
    expect(out).toEqual([{ legIndex: 0, name: 'Лег 1', email: 'a@x.bg' }]);
  });

  it('sendToCouriers delegates to the service with the tenant + date and returns its report', async () => {
    const { ctrl, svc } = make();
    const report = { recipients: [], sent: [{ legIndex: 0, email: 'a@x.bg', ok: true }], failed: [] };
    svc.sendLegProtocolsToCouriers.mockResolvedValue(report);

    const out = await ctrl.sendToCouriers(TENANT, { date: '2026-07-22' } as any);

    expect(svc.sendLegProtocolsToCouriers).toHaveBeenCalledWith(TENANT, '2026-07-22');
    expect(out).toEqual(report);
  });
});
