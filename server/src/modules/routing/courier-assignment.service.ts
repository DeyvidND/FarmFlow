import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { type Database, routeCourierAssignments, users } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { isUniqueViolation } from '../../common/db/pg-error';

export type AssignmentRow = { accountId: string; legIndex: number };
export type CourierRosterEntry = { accountId: string; email: string; isSelf: boolean };

/**
 * Task A2 — per-day leg board: `routeCourierAssignments` (Task A1) is the
 * source of truth for "who runs which leg on date X." `resolveMyLeg` is the
 * date-scoped replacement for the JWT strategy's global, date-less
 * `courierIndex` injection at every driver-facing check point (Task A3/A4).
 */
@Injectable()
export class CourierAssignmentService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  /** The legIndex assigned to `accountId` on `date`, or null if unassigned. */
  async resolveMyLeg(tenantId: string, accountId: string, date: string): Promise<number | null> {
    const [row] = await this.db
      .select({ legIndex: routeCourierAssignments.legIndex })
      .from(routeCourierAssignments)
      .where(
        and(
          eq(routeCourierAssignments.tenantId, tenantId),
          eq(routeCourierAssignments.date, date),
          eq(routeCourierAssignments.accountId, accountId),
        ),
      )
      .limit(1);
    return row ? row.legIndex : null;
  }

  /** The full board for one day: every (accountId, legIndex) pair assigned. */
  async getAssignmentsForDay(tenantId: string, date: string): Promise<AssignmentRow[]> {
    return this.db
      .select({ accountId: routeCourierAssignments.accountId, legIndex: routeCourierAssignments.legIndex })
      .from(routeCourierAssignments)
      .where(and(eq(routeCourierAssignments.tenantId, tenantId), eq(routeCourierAssignments.date, date)));
  }

  /**
   * Whole-board replace for one day. Validates the payload itself has no
   * duplicate accountId/legIndex BEFORE hitting the DB (a clear 409 the UI
   * can surface inline), then atomically delete-then-inserts inside one
   * transaction serialized by a per-(tenant,date) advisory lock. The lock — NOT
   * the two DB unique constraints — is the real race guard: the constraints only
   * stop double-booking ONE leg, they do NOT stop two concurrent replaces from
   * merging into a UNION when their rows are disjoint. A 23505 still maps to 409.
   */
  async setAssignmentsForDay(
    tenantId: string,
    date: string,
    assignments: AssignmentRow[],
  ): Promise<AssignmentRow[]> {
    const accs = new Set<string>();
    const legs = new Set<number>();
    for (const a of assignments) {
      if (accs.has(a.accountId)) throw new ConflictException('Този акаунт вече е зачислен за деня.');
      if (legs.has(a.legIndex)) throw new ConflictException('Този курс вече има куриер за деня.');
      accs.add(a.accountId);
      legs.add(a.legIndex);
    }

    try {
      return await this.db.transaction(async (tx) => {
        // Serialize concurrent whole-board replaces for this (tenant, date). Without
        // it, two replaces can both DELETE-all before either INSERTs, then insert
        // disjoint rows → the board becomes the UNION of both submissions (neither
        // operator's board). Releases on commit/rollback (order-number lock pattern).
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':' || ${date}, 0))`,
        );
        await tx
          .delete(routeCourierAssignments)
          .where(and(eq(routeCourierAssignments.tenantId, tenantId), eq(routeCourierAssignments.date, date)));
        if (assignments.length) {
          await tx.insert(routeCourierAssignments).values(
            assignments.map((a) => ({ tenantId, date, accountId: a.accountId, legIndex: a.legIndex })),
          );
        }
        return assignments;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Разписанието се промени едновременно — опресни и опитай пак.');
      }
      throw err;
    }
  }

  /**
   * Read-only roster for the farmer: the tenant's role='driver' logins plus
   * the calling owner's own account (isSelf: true). No sensitive fields —
   * never passwordHash/tokenVersion/mustChangePassword.
   */
  async listTenantCouriers(tenantId: string, selfUserId: string): Promise<CourierRosterEntry[]> {
    const drivers = await this.db
      .select({ accountId: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.role, 'driver')));
    const [self] = await this.db
      .select({ accountId: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, selfUserId))
      .limit(1);

    const roster: CourierRosterEntry[] = drivers.map((d) => ({
      accountId: d.accountId,
      email: d.email,
      isSelf: false,
    }));
    if (self) roster.push({ accountId: self.accountId, email: self.email, isSelf: true });
    return roster;
  }
}
