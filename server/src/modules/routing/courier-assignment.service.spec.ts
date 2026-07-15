import { ConflictException } from '@nestjs/common';
import { SQL, Param } from 'drizzle-orm';
import { routeCourierAssignments, users } from '@fermeribg/db';
import { CourierAssignmentService } from './courier-assignment.service';

/**
 * Walk a drizzle `and(eq(...), eq(...))` SQL tree and pull out every embedded
 * chunk (Column references and Param values), so a test can assert the WHERE
 * clause actually scoped on specific columns/values instead of just trusting
 * the mock resolved — a missing tenantId/date eq() would silently resolve a
 * leg across tenants or dates. Mirrors routing.service.spec.ts's helper.
 */
function flattenSql(node: unknown, out: unknown[] = []): unknown[] {
  if (node instanceof SQL) {
    for (const chunk of (node as unknown as { queryChunks: unknown[] }).queryChunks) {
      flattenSql(chunk, out);
    }
  } else if (Array.isArray(node)) {
    for (const item of node) flattenSql(item, out);
  } else {
    out.push(node);
  }
  return out;
}

function paramValues(node: unknown): unknown[] {
  return flattenSql(node)
    .filter((c): c is Param => c instanceof Param)
    .map((p) => p.value);
}

function hasColumn(node: unknown, col: unknown): boolean {
  return flattenSql(node).includes(col);
}

function makeDb() {
  const db: Record<string, jest.Mock> = {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockResolvedValue(undefined),
    transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(db)),
  };
  return db;
}

const TENANT = 'tenant-1';
const DATE_X = '2026-07-20';
const DATE_Y = '2026-07-21';
const ACCOUNT_A = 'account-a';
const ACCOUNT_B = 'account-b';

describe('CourierAssignmentService', () => {
  let db: ReturnType<typeof makeDb>;
  let svc: CourierAssignmentService;

  beforeEach(() => {
    db = makeDb();
    svc = new CourierAssignmentService(db as any);
  });

  describe('resolveMyLeg', () => {
    it('returns the assigned legIndex for (tenant, date, account)', async () => {
      db.limit.mockResolvedValueOnce([{ legIndex: 1 }]);

      const result = await svc.resolveMyLeg(TENANT, ACCOUNT_A, DATE_X);

      expect(result).toBe(1);
      const whereArg = db.where.mock.calls[0][0];
      expect(hasColumn(whereArg, routeCourierAssignments.tenantId)).toBe(true);
      expect(hasColumn(whereArg, routeCourierAssignments.date)).toBe(true);
      expect(hasColumn(whereArg, routeCourierAssignments.accountId)).toBe(true);
      expect(paramValues(whereArg)).toEqual(
        expect.arrayContaining([TENANT, DATE_X, ACCOUNT_A]),
      );
    });

    it('returns null when there is no row for that date', async () => {
      db.limit.mockResolvedValueOnce([]);

      const result = await svc.resolveMyLeg(TENANT, ACCOUNT_A, DATE_X);

      expect(result).toBeNull();
    });

    it('is date-scoped: same account, two dates → two legs resolved independently', async () => {
      db.limit.mockResolvedValueOnce([{ legIndex: 1 }]);
      const legX = await svc.resolveMyLeg(TENANT, ACCOUNT_A, DATE_X);

      db.limit.mockResolvedValueOnce([{ legIndex: 0 }]);
      const legY = await svc.resolveMyLeg(TENANT, ACCOUNT_A, DATE_Y);

      expect(legX).toBe(1);
      expect(legY).toBe(0);
      const [firstWhere, secondWhere] = db.where.mock.calls.map((c) => c[0]);
      expect(paramValues(firstWhere)).toEqual(expect.arrayContaining([DATE_X]));
      expect(paramValues(secondWhere)).toEqual(expect.arrayContaining([DATE_Y]));
    });
  });

  describe('getAssignmentsForDay', () => {
    it('returns the day rows scoped to tenant + date', async () => {
      db.where.mockResolvedValueOnce([
        { accountId: ACCOUNT_A, legIndex: 0 },
        { accountId: ACCOUNT_B, legIndex: 1 },
      ]);

      const result = await svc.getAssignmentsForDay(TENANT, DATE_X);

      expect(result).toEqual([
        { accountId: ACCOUNT_A, legIndex: 0 },
        { accountId: ACCOUNT_B, legIndex: 1 },
      ]);
      const whereArg = db.where.mock.calls[0][0];
      expect(hasColumn(whereArg, routeCourierAssignments.tenantId)).toBe(true);
      expect(hasColumn(whereArg, routeCourierAssignments.date)).toBe(true);
      expect(paramValues(whereArg)).toEqual(expect.arrayContaining([TENANT, DATE_X]));
    });
  });

  describe('setAssignmentsForDay', () => {
    it('rejects a payload double-booking one leg (two accounts same legIndex) with 409', async () => {
      await expect(
        svc.setAssignmentsForDay(TENANT, DATE_X, [
          { accountId: ACCOUNT_A, legIndex: 0 },
          { accountId: ACCOUNT_B, legIndex: 0 },
        ]),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('rejects a payload assigning one account to two legs with 409', async () => {
      await expect(
        svc.setAssignmentsForDay(TENANT, DATE_X, [
          { accountId: ACCOUNT_A, legIndex: 0 },
          { accountId: ACCOUNT_A, legIndex: 1 },
        ]),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('replaces the day atomically: delete-then-insert inside one transaction', async () => {
      const assignments = [
        { accountId: ACCOUNT_A, legIndex: 0 },
        { accountId: ACCOUNT_B, legIndex: 1 },
      ];

      const result = await svc.setAssignmentsForDay(TENANT, DATE_X, assignments);

      expect(db.transaction).toHaveBeenCalled();
      expect(db.delete).toHaveBeenCalledWith(routeCourierAssignments);
      expect(db.insert).toHaveBeenCalledWith(routeCourierAssignments);
      expect(db.values).toHaveBeenCalledWith([
        { tenantId: TENANT, date: DATE_X, accountId: ACCOUNT_A, legIndex: 0 },
        { tenantId: TENANT, date: DATE_X, accountId: ACCOUNT_B, legIndex: 1 },
      ]);
      expect(result).toEqual(assignments);
    });

    it('clearing the board (empty array) deletes without inserting', async () => {
      const result = await svc.setAssignmentsForDay(TENANT, DATE_X, []);

      expect(db.delete).toHaveBeenCalledWith(routeCourierAssignments);
      expect(db.insert).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('maps a DB 23505 to a 409', async () => {
      const uniqueViolation = Object.assign(
        new Error('duplicate key value violates unique constraint "route_courier_assign_tenant_date_leg_uniq"'),
        { code: '23505' },
      );
      db.values.mockRejectedValueOnce(uniqueViolation);

      await expect(
        svc.setAssignmentsForDay(TENANT, DATE_X, [{ accountId: ACCOUNT_A, legIndex: 0 }]),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('listTenantCouriers', () => {
    it('returns drivers + a self entry flagged isSelf, no password/hash/tokenVersion fields', async () => {
      db.where.mockResolvedValueOnce([
        { accountId: ACCOUNT_A, email: 'driver-a@x.bg' },
        { accountId: ACCOUNT_B, email: 'driver-b@x.bg' },
      ]);
      db.limit.mockResolvedValueOnce([{ accountId: 'owner-1', email: 'owner@x.bg' }]);

      const result = await svc.listTenantCouriers(TENANT, 'owner-1');

      expect(result).toEqual([
        { accountId: ACCOUNT_A, email: 'driver-a@x.bg', isSelf: false },
        { accountId: ACCOUNT_B, email: 'driver-b@x.bg', isSelf: false },
        { accountId: 'owner-1', email: 'owner@x.bg', isSelf: true },
      ]);
      for (const entry of result) {
        expect(entry).not.toHaveProperty('passwordHash');
        expect(entry).not.toHaveProperty('tokenVersion');
        expect(entry).not.toHaveProperty('mustChangePassword');
      }
      const driversWhereArg = db.where.mock.calls[0][0];
      expect(hasColumn(driversWhereArg, users.tenantId)).toBe(true);
      expect(hasColumn(driversWhereArg, users.role)).toBe(true);
      expect(paramValues(driversWhereArg)).toEqual(expect.arrayContaining([TENANT, 'driver']));
    });

    it('returns just the self entry when the tenant has no driver logins', async () => {
      db.where.mockResolvedValueOnce([]);
      db.limit.mockResolvedValueOnce([{ accountId: 'owner-1', email: 'owner@x.bg' }]);

      const result = await svc.listTenantCouriers(TENANT, 'owner-1');

      expect(result).toEqual([{ accountId: 'owner-1', email: 'owner@x.bg', isSelf: true }]);
    });
  });
});
