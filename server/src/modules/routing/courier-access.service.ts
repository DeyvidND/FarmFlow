import { Injectable, Inject, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { type Database, users, auditLogs, orders } from '@fermeribg/db';
import * as argon2 from 'argon2';
import { AuthService } from '../auth/auth.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

/**
 * Task B1 — super-admin-only (platform-guarded, see `PlatformAdminGuard`)
 * grant/revoke/list for `role='driver'` logins. Account creation moved OUT of
 * the farmer panel here; leg assignment no longer happens at grant time —
 * `courierIndex` is left NULL on every insert and the per-day assignment
 * board (Task A2/C2, `routeCourierAssignments` + `CourierAssignmentService`)
 * is now the sole source of truth for "who runs which leg on date X."
 * Mirrors `FarmersService`'s listAccess/grantAccess/revokeAccess almost
 * line-for-line, keyed by `accountId` (`users.id`) instead of a leg index.
 */
@Injectable()
export class CourierAccessService {
  private readonly logger = new Logger(CourierAccessService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  /** Flat roster of driver logins for the super-admin console. */
  async listAccess(
    tenantId: string,
  ): Promise<{ accountId: string; email: string; invitePending: boolean }[]> {
    const rows = await this.db
      .select({ accountId: users.id, email: users.email, mustChange: users.mustChangePassword })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.role, 'driver')));
    return rows.map((r) => ({ accountId: r.accountId, email: r.email, invitePending: r.mustChange }));
  }

  /** Grant (or re-invite) a driver login for this tenant. Idempotent re-invite
   *  (same email → resend) resends to the same account. Email must be free
   *  across all users. Created with `courierIndex` NULL — leg assignment
   *  happens on the per-day board, not here. */
  async grantAccess(
    tenantId: string,
    email: string,
  ): Promise<{ accountId: string; email: string; invitePending: boolean }> {
    // Normalize so the stored address matches what the courier types at login
    // (the login lookup is case-sensitive).
    const normalizedEmail = email.trim().toLowerCase();

    const [existing] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.role, 'driver'), eq(users.email, normalizedEmail)))
      .limit(1);

    // Email collision check (ignore this same login's own row on re-invite).
    const [emailOwner] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);
    if (emailOwner && emailOwner.id !== existing?.id) {
      throw new ConflictException('Този имейл вече се използва');
    }

    let userId: string;
    if (existing) {
      const [updated] = await this.db
        .update(users)
        .set({ mustChangePassword: true, tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(eq(users.id, existing.id))
        .returning({ id: users.id });
      userId = updated.id;
    } else {
      const passwordHash = await argon2.hash(`${randomUUID()}${randomUUID()}`);
      try {
        const [created] = await this.db
          .insert(users)
          .values({
            tenantId,
            email: normalizedEmail,
            role: 'driver',
            passwordHash,
            mustChangePassword: true,
          })
          .returning({ id: users.id });
        userId = created.id;
      } catch (err) {
        // users_email_unique backstops the read-then-write above: two concurrent
        // grantAccess calls for the same email (e.g. a double-clicked "Покани")
        // can both see existing=undefined/emailOwner=undefined and race to
        // insert — the DB constraint lets only one through.
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictException('Този имейл вече се използва');
        }
        throw err;
      }
    }

    // Swallow invite-send failures (mirrors FarmersService.grantAccess): the
    // account is created and an admin can re-send from the courier access
    // screen, so a transient email outage must not 500 the provisioning call.
    try {
      const appUrl = this.config.get<string>('PUBLIC_APP_URL') ?? 'http://localhost:3000';
      await this.auth.issueInvite(userId, { appUrl, email: true, subject: 'Покана за достъп — Маршрут' });
    } catch (err) {
      this.logger.error(
        `Courier invite email failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { accountId: userId, email: normalizedEmail, invitePending: true };
  }

  /** Revoke a driver login: kill live sessions (token_version bump) then delete. */
  async revokeAccess(tenantId: string, accountId: string): Promise<{ ok: true }> {
    const [login] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.role, 'driver'), eq(users.id, accountId)))
      .limit(1);
    if (!login) throw new NotFoundException('Този куриер няма достъп');
    // Clear the FK references to this login BEFORE deleting it — audit_logs.user_id
    // and orders.customer_id are ON DELETE NO ACTION, so a referenced user row can't
    // be deleted (raw delete → FK violation → 500). Null them (keep the audit trail
    // + any orders, just unlinked from the gone login) and bump tokenVersion so a
    // live JWT is rejected at once. All in one transaction so a mid-way failure
    // never leaves the login half-revoked.
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(eq(users.id, login.id));
      await tx.update(auditLogs).set({ userId: null }).where(eq(auditLogs.userId, login.id));
      await tx.update(orders).set({ customerId: null }).where(eq(orders.customerId, login.id));
      await tx.delete(users).where(eq(users.id, login.id));
    });
    return { ok: true };
  }
}
