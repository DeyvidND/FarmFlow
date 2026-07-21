import { HandoverController } from './handover.controller';

/**
 * `GET /handover/check` is the ONE handover route open to a courier, so what it
 * hands back is a PII boundary: a protocol names the counterparty and their
 * address. These tests pin the scoping, not the happy path.
 */

const TENANT = 't1';
const DRIVER = { role: 'driver', userId: 'u-driver', tenantId: TENANT } as any;
const OWNER = { role: 'admin', userId: 'u-owner', tenantId: TENANT } as any;

/** Two legs: leg 1 carries orders A+B, leg 2 carries order C. */
const route = {
  routes: [
    { courierIndex: 1, stops: [{ id: 'order-A' }, { id: 'order-B' }] },
    { courierIndex: 2, stops: [{ id: 'order-C' }] },
  ],
};

function make(overrides: { myLeg?: number | null } = {}) {
  const handover = { listForCheck: jest.fn().mockResolvedValue([]) };
  const routing = { getRoute: jest.fn().mockResolvedValue(route) };
  const courierAssignment = {
    resolveMyLeg: jest.fn().mockResolvedValue(overrides.myLeg === undefined ? 1 : overrides.myLeg),
  };
  return {
    handover,
    routing,
    courierAssignment,
    ctrl: new HandoverController(handover as any, routing as any, courierAssignment as any),
  };
}

describe('HandoverController.check — driver scoping', () => {
  it('passes ONLY the driver own-leg order ids, never another leg’s', async () => {
    const { ctrl, handover } = make();

    await ctrl.check(TENANT, DRIVER, '2026-07-21');

    expect(handover.listForCheck).toHaveBeenCalledTimes(1);
    const scope = handover.listForCheck.mock.calls[0][2] as Set<string>;
    expect(scope).toBeInstanceOf(Set);
    expect([...scope].sort()).toEqual(['order-A', 'order-B']);
    expect(scope.has('order-C')).toBe(false); // the other courier's stop
  });

  it('resolves the leg from the DATE-scoped board, for the requested day', async () => {
    const { ctrl, courierAssignment } = make();

    await ctrl.check(TENANT, DRIVER, '2026-07-21');

    expect(courierAssignment.resolveMyLeg).toHaveBeenCalledWith(TENANT, 'u-driver', '2026-07-21');
  });

  it('returns NOTHING when the driver has no assignment that day — not everything', async () => {
    const { ctrl, handover } = make({ myLeg: null });

    const out = await ctrl.check(TENANT, DRIVER, '2026-07-21');

    expect(out).toEqual([]);
    expect(handover.listForCheck).not.toHaveBeenCalled(); // never falls through to the tenant-wide list
  });

  it('returns nothing when the driver is assigned a leg that has no stops', async () => {
    const { ctrl, handover } = make({ myLeg: 9 }); // a leg absent from the route

    const out = await ctrl.check(TENANT, DRIVER, '2026-07-21');

    expect(out).toEqual([]);
    expect(handover.listForCheck).not.toHaveBeenCalled();
  });

  it('asks for the WHOLE day’s load — scope must not shrink as stops are delivered', async () => {
    const { ctrl, routing } = make();

    await ctrl.check(TENANT, DRIVER, '2026-07-21');

    // last positional arg of getRoute is the status filter
    const args = routing.getRoute.mock.calls[0];
    expect(args[0]).toBe(TENANT);
    expect(args[1]).toBe('2026-07-21');
    expect(args[args.length - 1]).toBe('all');
  });

  it('leaves the owner UNSCOPED — they legitimately see the whole day', async () => {
    const { ctrl, handover, courierAssignment, routing } = make();

    await ctrl.check(TENANT, OWNER, '2026-07-21');

    expect(courierAssignment.resolveMyLeg).not.toHaveBeenCalled();
    expect(routing.getRoute).not.toHaveBeenCalled();
    expect(handover.listForCheck).toHaveBeenCalledWith(TENANT, { date: '2026-07-21', slotId: undefined });
    expect(handover.listForCheck.mock.calls[0][2]).toBeUndefined(); // no filter set
  });
});
