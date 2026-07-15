import { Injectable, Inject, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { type Database, users, auditLogs, orders } from '@fermeribg/db';
import * as argon2 from 'argon2';
import { AuthService } from '../auth/auth.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

/**
 * Task C2 — admin-only grant/revoke/list for `role='driver'` logins bound to a
 * courier leg (0-based `courierIndex`, matches `orders.courierIndex` /
 * `settings.routing.couriers[]`). Mirrors `FarmersService`'s
 * listAccess/grantAccess/revokeAccess almost line-for-line. "At most one driver
 * login per (tenantId, courierIndex)" is backed by the partial unique index
 * `users_tenant_courier_index_uniq` (mirrors `users_farmer_id_uniq` for
 * farmers) — grantAccess's own lookup+insert is a plain read-then-write, so the
 * DB constraint is what actually closes the race on concurrent grants.
 */
@Injectable()
export class CourierAccessService {
  private readonly logger = new Logger(CourierAccessService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  /** Courier-leg → login status list for the admin route access screen. */
  async listAccess(
    tenantId: string,
  ): Promise<{ courierIndex: number; email: string; invitePending: boolean }[]> {
    const rows = await this.db
      .select({ courierIndex: users.courierIndex, email: users.email, mustChange: users.mustChangePassword })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.role, 'driver')));
    const list: { courierIndex: number; email: string; invitePending: boolean }[] = [];
    for (const r of rows) {
      // A driver not yet bound to a leg shouldn't appear in this list.
      if (r.courierIndex !== null) {
        list.push({ courierIndex: r.courierIndex, email: r.email, invitePending: r.mustChange });
      }
    }
    return list;
  }

  /** Grant (or re-invite) a driver login bound to one courier leg. Idempotent
   *  re-invite resends to the (optionally updated) email. Email must be free
   *  across all users. */
  async grantAccess(
    tenantId: string,
    courierIndex: number,
    email: string,
  ): Promise<{ courierIndex: number; loginEmail: string; invitePending: boolean }> {
    // Normalize so the stored address matches what the courier types at login
    // (the login lookup is case-sensitive).
    const normalizedEmail = email.trim().toLowerCase();

    const [existing] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.role, 'driver'), eq(users.courierIndex, courierIndex)))
      .limit(1);

    // Email collision check (ignore this courier leg's own current row on re-invite).
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
        .set({ email: normalizedEmail, mustChangePassword: true, tokenVersion: sql`${users.tokenVersion} + 1` })
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
            courierIndex,
            email: normalizedEmail,
            role: 'driver',
            passwordHash,
            mustChangePassword: true,
          })
          .returning({ id: users.id });
        userId = created.id;
      } catch (err) {
        // users_tenant_courier_index_uniq (partial, role='driver') backstops the
        // read-then-write above: two concurrent grantAccess calls for the same leg
        // (e.g. an admin double-clicking "Покани") can both see existing=undefined
        // and race to insert — the DB constraint lets only one through.
        if ((err as { code?: string }).code === '23505') {
          throw new ConflictException('Достъп за този куриер вече е предоставен');
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
    return { courierIndex, loginEmail: normalizedEmail, invitePending: true };
  }

  /** Revoke a courier leg's login: kill live sessions (token_version bump) then delete. */
  async revokeAccess(tenantId: string, courierIndex: number): Promise<{ ok: true }> {
    const [login] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.role, 'driver'), eq(users.courierIndex, courierIndex)))
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
