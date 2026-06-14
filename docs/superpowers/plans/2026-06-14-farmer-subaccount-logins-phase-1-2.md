# Farmer (producer) sub-account logins — Phase 1+2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A producer in a multi-farmer shop gets an invited login (`role='farmer'`)
that lands on a Статистика screen showing **only their own line-item turnover**;
the owner can also filter that screen by producer.

**Architecture:** Extend `users` with `role='farmer'` + `farmer_id` (Approach A —
reuse the whole login/reset/JWT/guard stack). Owner provisions via an email invite
that reuses the existing password-reset token. Turnover is attributed by line item
(`order_items` → `products.farmer_id`); a shared order counts for both producers and
delivery is nobody's turnover. The global `TenantRolesGuard` stays default-deny; only
a handful of endpoints are explicitly opened to `farmer`.

**Tech Stack:** NestJS + Drizzle (`@farmflow/api`), Drizzle schema (`@farmflow/db`),
shared types (`@farmflow/types`), Next 14 admin app (`@farmflow/web`). Jest on the
server; **the web app has no jest** — web tasks verify via `next build` + live E2E.

**Spec:** `docs/superpowers/specs/2026-06-14-farmer-subaccount-logins-design.md`

---

## Conventions (read once)

- **Package manager is pnpm.** Run server tests with
  `pnpm --filter @farmflow/api test -- <pathFragment>`.
- **Run jest, `next build`, and the dev server SEQUENTIALLY** on this machine
  (parallel runs cause FS flakes — known repo gotcha).
- **`@farmflow/db` and `@farmflow/types` are consumed as `dist`.** After editing
  either package, rebuild it (`pnpm --filter @farmflow/db build` /
  `pnpm --filter @farmflow/types build`) before the server/web picks up the change.
- **The web app talks to the API through a `/bff/*` catch-all proxy** (`apiFetch` in
  `client/src/lib/api-client.ts`). New API routes under existing controllers are
  proxied automatically — no per-route BFF code needed.
- **`TenantRolesGuard` is global + default-deny:** every tenant route is `admin`-only
  unless a `@Roles(...)` decorator opens it. Opening shared endpoints to `farmer` is a
  required step (Task 7), not optional polish — without it a farmer cannot even load
  the shell.
- Commit after each task with the message shown in its final step.

## File-structure map

**`@farmflow/db`**
- Modify `packages/db/src/schema.ts` — enum value + `users.farmer_id` + unique index.
- Generate `packages/db/drizzle/0043_*.sql`.

**`@farmflow/types`**
- Modify `packages/types/src/index.ts` — `TenantRole`, `JwtPayload`, `TenantRequestUser`.

**`@farmflow/api`**
- Modify `server/src/modules/auth/auth.service.ts` — thread `farmerId`; add `sendFarmerInvite`.
- Modify `server/src/modules/auth/jwt.strategy.ts` — return `farmerId`.
- Modify `server/src/modules/auth/auth.controller.ts` — open shared routes to `farmer`.
- Modify `server/src/modules/tenants/tenants.controller.ts` — open `/tenants/me` to `farmer`.
- Create `server/src/common/decorators/current-farmer.decorator.ts`.
- Create `server/src/common/scope/farmer-scope.util.ts` (pure resolver) + `.spec.ts`.
- Modify `server/src/modules/farmers/farmers.service.ts` — `grantAccess`/`revokeAccess`/`listAccess`.
- Create `server/src/modules/farmers/dto/grant-access.dto.ts`.
- Modify `server/src/modules/farmers/farmers.controller.ts` — access endpoints.
- Modify `server/src/modules/farmers/farmers.module.ts` — import `AuthModule`.
- Modify `server/src/modules/auth/auth.module.ts` — export `AuthService` (if not already).
- Create `server/src/modules/farmers/farmers.access.spec.ts`.
- Modify `server/src/modules/stats/stats.service.ts` — `statsForFarmer`.
- Modify `server/src/modules/stats/stats.controller.ts` — role scoping.
- Modify/extend `server/src/modules/auth/auth.service.spec.ts`,
  `server/src/modules/auth/jwt.strategy.spec.ts`.

**`@farmflow/web`**
- Modify `client/src/lib/api-client.ts` — access + `getStats(farmerId)`.
- Modify `client/src/lib/types.ts` — `FarmerAccess`.
- Modify `client/src/app/(admin)/farmers/page.tsx` — load access map.
- Modify `client/src/components/farmers/farmers-client.tsx` — access UI.
- Create `client/src/components/farmers/access-control.tsx`.
- Modify `client/src/components/layout/sidebar.tsx` — `role` prop + `FARMER_NAV`.
- Modify `client/src/components/layout/admin-shell.tsx` — `role` prop + route guard.
- Create `client/src/components/layout/farmer-route-guard.tsx`.
- Modify `client/src/app/(admin)/layout.tsx` — thread `role`.
- Modify `client/src/app/(admin)/stats/page.tsx` + `client/src/components/stats/stats-client.tsx` — owner dropdown.

---

# Phase 1 — Foundation (accounts, auth, invite/revoke)

## Task 1: DB schema — `farmer` role + `users.farmer_id`

**Files:**
- Modify: `packages/db/src/schema.ts` (enum line ~19; `users` table line ~106)
- Generate: `packages/db/drizzle/0043_*.sql`

- [ ] **Step 1: Add the enum value**

In `packages/db/src/schema.ts`, change:

```ts
export const userRoleEnum = pgEnum('user_role', ['admin', 'driver', 'customer']);
```
to:
```ts
export const userRoleEnum = pgEnum('user_role', ['admin', 'driver', 'customer', 'farmer']);
```

- [ ] **Step 2: Add `farmer_id` + a partial-unique index to `users`**

Ensure `uniqueIndex` is imported from `drizzle-orm/pg-core` (add it to the existing
import if missing). Replace the `users` table definition (currently a single-arg
`pgTable('users', { ... })`) with the two-arg form below — keep every existing column
exactly, add `farmerId`, and add the index callback:

```ts
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    role: userRoleEnum('role').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    tokenVersion: integer('token_version').notNull().default(0),
    hiddenNav: jsonb('hidden_nav').$type<string[]>(),
    // Producer sub-account link: a `role='farmer'` user manages only this producer's
    // data. NULL for owner/driver/customer rows. CASCADE so deleting the producer
    // deletes its login. (See farmers table below — forward ref via thunk.)
    farmerId: uuid('farmer_id').references(() => farmers.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // At most one login per producer.
    farmerIdUniq: uniqueIndex('users_farmer_id_uniq')
      .on(t.farmerId)
      .where(sql`${t.farmerId} is not null`),
  }),
);
```

> Note: `farmers` is declared later in the file; the `() => farmers.id` thunk defers
> resolution, exactly like `products.farmerId` already does — this compiles.

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter @farmflow/db generate`
Expected: a new `packages/db/drizzle/0043_*.sql` is created.

- [ ] **Step 4: Verify the generated SQL**

Open the new `0043_*.sql`. It must contain (order/spelling may vary):
```sql
ALTER TYPE "user_role" ADD VALUE 'farmer';
ALTER TABLE "users" ADD COLUMN "farmer_id" uuid;
ALTER TABLE "users" ADD CONSTRAINT ... FOREIGN KEY ("farmer_id") REFERENCES "farmers"("id") ON DELETE cascade ...;
CREATE UNIQUE INDEX "users_farmer_id_uniq" ON "users" ("farmer_id") WHERE "farmer_id" IS NOT NULL;
```
The migration is safe in one transaction here because **nothing in it inserts a
`'farmer'` row** (the enum value is only used at runtime). If drizzle split it into a
`statement-breakpoint`, leave it. Do not hand-edit unless a value is missing.

- [ ] **Step 5: Build the db package**

Run: `pnpm --filter @farmflow/db build`
Expected: succeeds (dist updated).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle
git commit -m "feat(db): add farmer role + users.farmer_id (producer sub-accounts, migration 0043)"
```

---

## Task 2: Shared types — `TenantRole`, `JwtPayload`, `TenantRequestUser`

**Files:**
- Modify: `packages/types/src/index.ts:109` (`TenantRole`), `:116` (`JwtPayload`), `:130` (`TenantRequestUser`)

- [ ] **Step 1: Extend the role + token + request-user types**

```ts
export type TenantRole = 'admin' | 'driver' | 'customer' | 'farmer';
```

In `JwtPayload`, add below `role?`:
```ts
  /** Present only on producer sub-account tokens (role='farmer'): the farmers.id
   *  this login is scoped to. */
  farmerId?: string;
```

In `TenantRequestUser`, add below `role`:
```ts
  /** Producer scope for role='farmer' (else undefined). */
  farmerId?: string;
```

- [ ] **Step 2: Build the types package**

Run: `pnpm --filter @farmflow/types build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/index.ts
git commit -m "feat(types): farmer role + farmerId on JwtPayload/TenantRequestUser"
```

---

## Task 3: Thread `farmerId` through login + JWT

**Files:**
- Modify: `server/src/modules/auth/auth.service.ts:33-50` (`login`), `:235-251` (`sign`)
- Modify: `server/src/modules/auth/jwt.strategy.ts:61-66`
- Test: `server/src/modules/auth/auth.service.spec.ts`, `server/src/modules/auth/jwt.strategy.spec.ts`

- [ ] **Step 1: Write the failing tests**

Add to `auth.service.spec.ts` (inside the top-level `describe('AuthService', …)`):

```ts
  describe('login', () => {
    it('signs a token carrying farmerId for a producer sub-account', async () => {
      db.limit.mockResolvedValueOnce([{
        id: USER_ID, tenantId: TENANT_ID, email: 'p@farm.bg',
        passwordHash: '$argon2id$fake', role: 'farmer', mustChangePassword: false,
        tokenVersion: 0, farmerId: 'farmer-1',
      }]);
      (argon2.verify as jest.Mock).mockResolvedValueOnce(true);

      await service.login({ email: 'p@farm.bg', password: 'x' });

      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'farmer', farmerId: 'farmer-1', tenantId: TENANT_ID }),
      );
    });

    it('omits farmerId for an owner token', async () => {
      db.limit.mockResolvedValueOnce([{
        id: USER_ID, tenantId: TENANT_ID, email: 'o@farm.bg',
        passwordHash: '$argon2id$fake', role: 'admin', mustChangePassword: false,
        tokenVersion: 0, farmerId: null,
      }]);
      (argon2.verify as jest.Mock).mockResolvedValueOnce(true);

      await service.login({ email: 'o@farm.bg', password: 'x' });

      const payload = (jwtService.sign as jest.Mock).mock.calls[0][0];
      expect(payload.farmerId).toBeUndefined();
    });
  });
```

Add to `jwt.strategy.spec.ts` a case asserting the tenant branch returns `farmerId`
when the payload carries it (mirror the existing tenant test; assert the returned
object contains `farmerId: 'farmer-1'` when `payload.farmerId` is set and the user
row's `tokenVersion` matches).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @farmflow/api test -- auth.service.spec`
Expected: FAIL (sign payload lacks `farmerId`).

- [ ] **Step 3: Implement — `sign` carries `farmerId`, `login` passes it**

In `auth.service.ts`, change `sign` to accept and conditionally include `farmerId`:

```ts
  private sign(
    sub: string,
    tenantId: string,
    role: Role,
    mustChangePassword = false,
    tokenVersion = 0,
    farmerId?: string | null,
  ): { accessToken: string } {
    const payload: JwtPayload = {
      sub,
      type: 'tenant',
      tenantId,
      role,
      mustChangePassword,
      tv: tokenVersion,
      ...(farmerId ? { farmerId } : {}),
    };
    return { accessToken: this.jwt.sign(payload) };
  }
```

In `login`, pass the user's `farmerId` (the `select()` already returns all columns):

```ts
    return this.sign(
      user.id, user.tenantId, user.role, user.mustChangePassword, user.tokenVersion, user.farmerId,
    );
```

- [ ] **Step 4: Implement — strategy returns `farmerId`**

In `jwt.strategy.ts`, the `type === 'tenant'` return becomes:

```ts
      return {
        type: 'tenant',
        userId: payload.sub,
        tenantId: payload.tenantId,
        role: (payload.role ?? 'admin') as TenantRole,
        ...(payload.farmerId ? { farmerId: payload.farmerId } : {}),
      };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @farmflow/api test -- auth.service.spec jwt.strategy.spec`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/auth/auth.service.ts server/src/modules/auth/jwt.strategy.ts server/src/modules/auth/auth.service.spec.ts server/src/modules/auth/jwt.strategy.spec.ts
git commit -m "feat(auth): carry farmerId in token + RequestUser for producer sub-accounts"
```

---

## Task 4: `@CurrentFarmer()` decorator + pure scope resolver

**Files:**
- Create: `server/src/common/decorators/current-farmer.decorator.ts`
- Create: `server/src/common/scope/farmer-scope.util.ts`
- Test: `server/src/common/scope/farmer-scope.util.spec.ts`

- [ ] **Step 1: Write the failing test**

`server/src/common/scope/farmer-scope.util.spec.ts`:

```ts
import { ForbiddenException } from '@nestjs/common';
import { effectiveFarmerId } from './farmer-scope.util';

describe('effectiveFarmerId', () => {
  it('forces a producer to their own token id, ignoring any query override', () => {
    expect(effectiveFarmerId('farmer', 'farmer-1', 'farmer-9')).toBe('farmer-1');
    expect(effectiveFarmerId('farmer', 'farmer-1', undefined)).toBe('farmer-1');
  });

  it('throws when a farmer token has no farmerId (malformed)', () => {
    expect(() => effectiveFarmerId('farmer', undefined, undefined)).toThrow(ForbiddenException);
  });

  it('lets an owner pick a producer or see the whole tenant', () => {
    expect(effectiveFarmerId('admin', undefined, 'farmer-3')).toBe('farmer-3');
    expect(effectiveFarmerId('admin', undefined, undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @farmflow/api test -- farmer-scope`
Expected: FAIL ("Cannot find module './farmer-scope.util'").

- [ ] **Step 3: Implement the resolver + decorator**

`server/src/common/scope/farmer-scope.util.ts`:

```ts
import { ForbiddenException } from '@nestjs/common';
import type { TenantRole } from '@farmflow/types';

/**
 * Decide which producer a stats/scoped request applies to.
 * - role 'farmer': always their own token id (a producer can never widen scope;
 *   any query override is ignored). Missing id ⇒ malformed token ⇒ 403.
 * - any other role (owner 'admin'): the optional query id, or null = whole tenant.
 */
export function effectiveFarmerId(
  role: TenantRole,
  tokenFarmerId: string | undefined,
  queryFarmerId: string | undefined,
): string | null {
  if (role === 'farmer') {
    if (!tokenFarmerId) throw new ForbiddenException('Невалиден достъп');
    return tokenFarmerId;
  }
  return queryFarmerId ?? null;
}
```

`server/src/common/decorators/current-farmer.decorator.ts`:

```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** The producer id a role='farmer' token is scoped to (undefined otherwise). */
export const CurrentFarmer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.user?.farmerId;
  },
);
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @farmflow/api test -- farmer-scope`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/common/scope server/src/common/decorators/current-farmer.decorator.ts
git commit -m "feat(auth): pure effectiveFarmerId resolver + CurrentFarmer decorator"
```

---

## Task 5: `AuthService.sendFarmerInvite`

**Files:**
- Modify: `server/src/modules/auth/auth.service.ts` (add method + an invite-email helper)
- Test: `server/src/modules/auth/auth.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Add to `auth.service.spec.ts`:

```ts
  describe('sendFarmerInvite', () => {
    const userRow = {
      id: USER_ID, tenantId: TENANT_ID, email: 'p@farm.bg',
      passwordHash: '$argon2id$fake', role: 'farmer' as const, mustChangePassword: true,
    };

    it('signs a reset token and emails a set-password invite', async () => {
      db.limit.mockResolvedValueOnce([userRow]);

      await service.sendFarmerInvite(USER_ID);

      expect(jwtService.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ sub: USER_ID, type: 'reset' }),
        expect.objectContaining({ secret: 'test-secret::pwreset' }),
      );
      const sent = emailMock.sendMail.mock.calls[0][0];
      expect(sent.to).toBe('p@farm.bg');
      expect(sent.html).toContain('reset-token');
    });

    it('throws when the user does not exist', async () => {
      db.limit.mockResolvedValueOnce([]);
      await expect(service.sendFarmerInvite(USER_ID)).rejects.toThrow();
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @farmflow/api test -- auth.service.spec`
Expected: FAIL (`sendFarmerInvite` is not a function).

- [ ] **Step 3: Implement**

Add `NotFoundException` to the `@nestjs/common` import in `auth.service.ts`. Add the
method (place it after `requestPasswordReset`):

```ts
  /**
   * Invite a producer sub-account: email a set-password link. Reuses the password
   * reset token (separate secret, single-use, bound to the password fingerprint), so
   * the temporary random password set at creation is never disclosed. Longer-lived
   * (7d) than a self-service reset since the producer may open the email later.
   */
  async sendFarmerInvite(userId: string): Promise<void> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new NotFoundException('Профилът не е намерен');

    const token = await this.jwt.signAsync(
      { sub: user.id, type: 'reset', pv: this.pwFingerprint(user.passwordHash) },
      { secret: this.resetSecret(), expiresIn: '7d' },
    );
    const appUrl = this.config.get<string>('PUBLIC_APP_URL') ?? 'http://localhost:3000';
    const link = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
    await this.email.sendMail({
      to: user.email,
      subject: 'Покана за достъп — FarmFlow',
      html: inviteEmailHtml(link),
      text: `Получи достъп до своя оборот във FarmFlow.\nОтвори тази връзка, за да зададеш парола (валидна 7 дни):\n${link}`,
    });
  }
```

At the bottom of the file (next to `resetEmailHtml`), add:

```ts
/** Branded invite email — producer sets their first password. */
function inviteEmailHtml(link: string): string {
  return `<!doctype html><html lang="bg"><body style="margin:0;background:#f6f4ec;font-family:Arial,Helvetica,sans-serif;color:#23210f">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ec;padding:28px 0">
    <tr><td align="center">
      <table role="presentation" width="460" cellpadding="0" cellspacing="0" style="max-width:460px;background:#fffdf7;border:1px solid #e7e3d6;border-radius:16px;overflow:hidden">
        <tr><td style="background:#2d6a4f;padding:22px 28px;color:#eaf1e4;font-size:20px;font-weight:bold">🌿 FarmFlow</td></tr>
        <tr><td style="padding:28px">
          <h1 style="margin:0 0 12px;font-size:20px;color:#23210f">Покана за достъп</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#4a4733">
            Получи достъп до своя личен оборот във FarmFlow. Натисни бутона, за да зададеш парола и да влезеш.
          </p>
          <p style="margin:0 0 22px">
            <a href="${link}" style="display:inline-block;background:#2d6a4f;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 22px;border-radius:10px">Задай парола и влез</a>
          </p>
          <p style="margin:0;font-size:13px;color:#8a8770">Връзката е валидна 7 дни.</p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #eee7d6;font-size:12px;color:#a8a594">FarmFlow · Управление на фермата</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @farmflow/api test -- auth.service.spec`
Expected: PASS.

- [ ] **Step 5: Ensure `AuthModule` exports `AuthService`**

Open `server/src/modules/auth/auth.module.ts`. If `exports` does not already list
`AuthService`, add `exports: [AuthService],` to the `@Module({...})`. (FarmersModule
will inject it in Task 6.)

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/auth/auth.service.ts server/src/modules/auth/auth.service.spec.ts server/src/modules/auth/auth.module.ts
git commit -m "feat(auth): sendFarmerInvite (set-password invite reusing reset token)"
```

---

## Task 6: Farmers service — grant / revoke / list access

**Files:**
- Modify: `server/src/modules/farmers/farmers.service.ts`
- Modify: `server/src/modules/farmers/farmers.module.ts` (import `AuthModule`)
- Test: `server/src/modules/farmers/farmers.access.spec.ts`

- [ ] **Step 1: Write the failing test**

`server/src/modules/farmers/farmers.access.spec.ts`:

```ts
import { ConflictException, NotFoundException } from '@nestjs/common';
import { FarmersService } from './farmers.service';

jest.mock('argon2', () => ({ hash: jest.fn().mockResolvedValue('hash') }));

function makeDb() {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
  };
}

const TENANT = 'tenant-1';
const FARMER = 'farmer-1';

describe('FarmersService access', () => {
  let db: ReturnType<typeof makeDb>;
  let auth: { sendFarmerInvite: jest.Mock };
  let svc: FarmersService;

  beforeEach(() => {
    db = makeDb();
    auth = { sendFarmerInvite: jest.fn().mockResolvedValue(undefined) };
    // Storage/cache deps are unused by the access methods → pass minimal stubs.
    svc = new FarmersService(db as any, {} as any, {} as any, {} as any, auth as any);
    jest.clearAllMocks();
  });

  it('grantAccess creates a farmer login and sends the invite', async () => {
    db.limit
      .mockResolvedValueOnce([{ id: FARMER, tenantId: TENANT, name: 'Иван' }]) // findOne
      .mockResolvedValueOnce([]) // no existing login for this farmer
      .mockResolvedValueOnce([]); // email not taken
    db.returning.mockResolvedValueOnce([{ id: 'user-1' }]); // insert user

    const res = await svc.grantAccess(TENANT, FARMER, 'ivan@farm.bg');

    expect(db.insert).toHaveBeenCalled();
    expect(auth.sendFarmerInvite).toHaveBeenCalledWith('user-1');
    expect(res).toEqual({ hasLogin: true, loginEmail: 'ivan@farm.bg', invitePending: true });
  });

  it('grantAccess rejects an email already used by another user', async () => {
    db.limit
      .mockResolvedValueOnce([{ id: FARMER, tenantId: TENANT, name: 'Иван' }]) // findOne
      .mockResolvedValueOnce([]) // no existing login for this farmer
      .mockResolvedValueOnce([{ id: 'other-user' }]); // email taken

    await expect(svc.grantAccess(TENANT, FARMER, 'taken@farm.bg')).rejects.toThrow(ConflictException);
    expect(auth.sendFarmerInvite).not.toHaveBeenCalled();
  });

  it('revokeAccess bumps token_version then deletes the login', async () => {
    db.limit
      .mockResolvedValueOnce([{ id: FARMER, tenantId: TENANT, name: 'Иван' }]) // findOne
      .mockResolvedValueOnce([{ id: 'user-1' }]); // existing login

    const res = await svc.revokeAccess(TENANT, FARMER);

    expect(db.update).toHaveBeenCalled(); // tokenVersion bump
    expect(db.delete).toHaveBeenCalled();
    expect(res).toEqual({ ok: true });
  });

  it('revokeAccess 404s when the producer has no login', async () => {
    db.limit
      .mockResolvedValueOnce([{ id: FARMER, tenantId: TENANT, name: 'Иван' }]) // findOne
      .mockResolvedValueOnce([]); // no login
    await expect(svc.revokeAccess(TENANT, FARMER)).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @farmflow/api test -- farmers.access`
Expected: FAIL (methods + constructor arg don't exist).

- [ ] **Step 3: Implement — extend the service**

In `farmers.service.ts`:

1. Add imports:
```ts
import { Injectable, Inject, NotFoundException, ConflictException } from '@nestjs/common';
import { and, eq, asc, inArray, sql } from 'drizzle-orm';
import { type Database, farmers, farmerMedia, users } from '@farmflow/db';
import * as argon2 from 'argon2';
import { AuthService } from '../auth/auth.service';
```
(`randomUUID` is already imported; keep it.)

2. Add `AuthService` as the last constructor dependency:
```ts
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly cache: CatalogCacheService,
    private readonly publicCache: PublicCacheService,
    private readonly auth: AuthService,
  ) {}
```

3. Add the three methods (place them after `findOne`):

```ts
  /** Producer → login status map for the admin Фермери screen. */
  async listAccess(
    tenantId: string,
  ): Promise<Record<string, { hasLogin: true; loginEmail: string; invitePending: boolean }>> {
    const rows = await this.db
      .select({ farmerId: users.farmerId, email: users.email, mustChange: users.mustChangePassword })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.role, 'farmer')));
    const map: Record<string, { hasLogin: true; loginEmail: string; invitePending: boolean }> = {};
    for (const r of rows) {
      if (r.farmerId) map[r.farmerId] = { hasLogin: true, loginEmail: r.email, invitePending: r.mustChange };
    }
    return map;
  }

  /** Invite (or re-invite) a producer: create the scoped login if absent, then email
   *  a set-password link. Idempotent re-invite resends to the (optionally updated)
   *  email. Email must be free across all users. */
  async grantAccess(
    tenantId: string,
    farmerId: string,
    email: string,
  ): Promise<{ hasLogin: true; loginEmail: string; invitePending: boolean }> {
    await this.findOne(farmerId, tenantId); // 404 if cross-tenant / missing

    const [existing] = await this.db
      .select()
      .from(users)
      .where(eq(users.farmerId, farmerId))
      .limit(1);

    // Email collision check (ignore the producer's own current row on re-invite).
    const [emailOwner] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (emailOwner && emailOwner.id !== existing?.id) {
      throw new ConflictException('Този имейл вече се използва');
    }

    let userId: string;
    if (existing) {
      const [updated] = await this.db
        .update(users)
        .set({ email, mustChangePassword: true, tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(eq(users.id, existing.id))
        .returning({ id: users.id });
      userId = updated.id;
    } else {
      const passwordHash = await argon2.hash(`${randomUUID()}${randomUUID()}`);
      const [created] = await this.db
        .insert(users)
        .values({ tenantId, farmerId, email, role: 'farmer', passwordHash, mustChangePassword: true })
        .returning({ id: users.id });
      userId = created.id;
    }

    await this.auth.sendFarmerInvite(userId);
    return { hasLogin: true, loginEmail: email, invitePending: true };
  }

  /** Revoke a producer's login: kill live sessions (token_version bump) then delete. */
  async revokeAccess(tenantId: string, farmerId: string): Promise<{ ok: true }> {
    await this.findOne(farmerId, tenantId);
    const [login] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.farmerId, farmerId), eq(users.tenantId, tenantId)))
      .limit(1);
    if (!login) throw new NotFoundException('Този фермер няма достъп');
    await this.db
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, login.id));
    await this.db.delete(users).where(eq(users.id, login.id));
    return { ok: true };
  }
```

4. In `farmers.module.ts`, add `AuthModule` to `imports`:
```ts
import { AuthModule } from '../auth/auth.module';
// ...
@Module({
  imports: [/* ...existing..., */ AuthModule],
  // ...
})
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @farmflow/api test -- farmers.access`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/farmers/farmers.service.ts server/src/modules/farmers/farmers.module.ts server/src/modules/farmers/farmers.access.spec.ts
git commit -m "feat(farmers): grant/revoke/list producer login access"
```

---

## Task 7: Access endpoints + open shared routes to `farmer`

**Files:**
- Create: `server/src/modules/farmers/dto/grant-access.dto.ts`
- Modify: `server/src/modules/farmers/farmers.controller.ts`
- Modify: `server/src/modules/auth/auth.controller.ts`
- Modify: `server/src/modules/tenants/tenants.controller.ts`

- [ ] **Step 1: Create the DTO**

`server/src/modules/farmers/dto/grant-access.dto.ts`:

```ts
import { IsEmail } from 'class-validator';

export class GrantAccessDto {
  @IsEmail({}, { message: 'Невалиден имейл' })
  email!: string;
}
```

- [ ] **Step 2: Add the access endpoints (owner-only — no `@Roles`)**

In `farmers.controller.ts`, import the DTO and add these handlers. Place `@Get('access')`
**before** `@Get(':id')`, and the `:id/access` handlers after `update`:

```ts
import { GrantAccessDto } from './dto/grant-access.dto';

  // Literal route — must precede `:id`.
  @Get('access')
  listAccess(@CurrentTenant() tenantId: string) {
    return this.farmersService.listAccess(tenantId);
  }

  @Post(':id/access')
  grantAccess(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: GrantAccessDto,
  ) {
    return this.farmersService.grantAccess(tenantId, id, dto.email);
  }

  @Delete(':id/access')
  revokeAccess(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.farmersService.revokeAccess(tenantId, id);
  }
```

> These stay `admin`-only automatically (no `@Roles` ⇒ default-deny). Good — only the
> owner provisions logins.

- [ ] **Step 3: Open the shared endpoints a producer needs**

A `farmer` token must be able to load the shell + change its password. Add
`@Roles('admin', 'farmer')` (import `Roles` from
`../../common/decorators/roles.decorator`) to these handlers:

- `auth.controller.ts`: `getMe` (`GET /auth/me`), `changePassword`
  (`POST /auth/change-password`), `updateNav` (`PATCH /auth/me/nav`).
- `tenants.controller.ts`: the `GET /me` handler (tenant profile the admin layout
  fetches). Find the `me()` handler and add `@Roles('admin', 'farmer')` above it.

Example (auth.controller.ts):
```ts
import { Roles } from '../../common/decorators/roles.decorator';
// ...
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Roles('admin', 'farmer')
  @Get('me')
  @HttpCode(200)
  getMe(@CurrentUserId() userId: string) {
    return this.authService.getMe(userId);
  }
```
Apply the same `@Roles('admin', 'farmer')` line to `changePassword` and `updateNav`.

- [ ] **Step 4: Verify the build + full server suite**

Run: `pnpm --filter @farmflow/api build`
Expected: succeeds.
Run: `pnpm --filter @farmflow/api test`
Expected: all green (existing + new).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/farmers/dto/grant-access.dto.ts server/src/modules/farmers/farmers.controller.ts server/src/modules/auth/auth.controller.ts server/src/modules/tenants/tenants.controller.ts
git commit -m "feat(farmers): access endpoints; open auth/tenants shared routes to farmer role"
```

---

## Task 8: Web — access types + api-client

**Files:**
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/lib/api-client.ts`

- [ ] **Step 1: Add the `FarmerAccess` type**

In `client/src/lib/types.ts`, add (near the `Farmer` type):

```ts
export interface FarmerAccess {
  hasLogin: true;
  loginEmail: string;
  invitePending: boolean;
}
```

- [ ] **Step 2: Add api-client calls**

In `client/src/lib/api-client.ts`, import `FarmerAccess` in the type import block, and
add under the `// ---- Farmers ----` section:

```ts
export const getFarmerAccess = () =>
  apiFetch<Record<string, FarmerAccess>>('farmers/access');

export const grantFarmerAccess = (id: string, email: string) =>
  apiFetch<FarmerAccess>(`farmers/${id}/access`, { method: 'POST', ...json({ email }) }, 'Неуспешна покана');

export const revokeFarmerAccess = (id: string) =>
  apiFetch<{ ok: true }>(`farmers/${id}/access`, { method: 'DELETE' }, 'Неуспешно');
```

- [ ] **Step 3: Verify types compile (no jest in web — typecheck via build later)**

Run: `pnpm --filter @farmflow/web exec tsc --noEmit`
Expected: succeeds (or no new errors).

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/api-client.ts
git commit -m "feat(web): FarmerAccess type + grant/revoke/list access api-client calls"
```

---

## Task 9: Web — "Достъп" UI on the Фермери screen

**Files:**
- Create: `client/src/components/farmers/access-control.tsx`
- Modify: `client/src/app/(admin)/farmers/page.tsx` (load access map, pass it down)
- Modify: `client/src/components/farmers/farmers-client.tsx` (accept `initialAccess`, render control)

- [ ] **Step 1: Build the access control component**

`client/src/components/farmers/access-control.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { KeyRound, Check, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, grantFarmerAccess, revokeFarmerAccess } from '@/lib/api-client';
import type { FarmerAccess } from '@/lib/types';

/** Per-producer login provisioning: invite by email, resend, or revoke. */
export function AccessControl({ farmerId, initial }: { farmerId: string; initial?: FarmerAccess }) {
  const [access, setAccess] = useState<FarmerAccess | undefined>(initial);
  const [email, setEmail] = useState(initial?.loginEmail ?? '');
  const [busy, setBusy] = useState(false);

  async function invite() {
    if (!email.trim()) return;
    setBusy(true);
    try {
      const res = await grantFarmerAccess(farmerId, email.trim());
      setAccess(res);
      toast.success('Поканата е изпратена');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      await revokeFarmerAccess(farmerId);
      setAccess(undefined);
      toast.success('Достъпът е премахнат');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-ff-border-2 px-[18px] pb-4 pt-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-ff-muted">
        <KeyRound size={14} /> Личен достъп
      </div>
      {access ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-ff-ink-2">
            {access.invitePending ? (
              <><Send size={13} className="text-ff-amber-600" /> Поканен · {access.loginEmail}</>
            ) : (
              <><Check size={13} className="text-ff-green-700" /> Активен · {access.loginEmail}</>
            )}
          </span>
          <div className="flex items-center gap-2">
            {access.invitePending && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={invite}>
                Изпрати отново
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={revoke} title="Откажи достъп">
              <X size={14} /> Откажи
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="имейл на фермера"
            className="min-w-[160px] flex-1 rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[13px] font-semibold text-ff-ink-2 shadow-ff-sm focus:outline-none focus:ring-2 focus:ring-ff-green-500/40"
          />
          <Button size="sm" variant="primary" disabled={busy || !email.trim()} onClick={invite}>
            <Send size={14} /> Покани
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Load the access map in the Фермери page**

Open `client/src/app/(admin)/farmers/page.tsx`. It currently loads farmers, products,
multiFarmer. Add a parallel fetch of the access map via the API (mirror its existing
token+fetch pattern), e.g.:

```tsx
import { getFarmerAccess } from '@/lib/api-client'; // if the page is a client comp; otherwise fetch directly
```
If the page is a server component, fetch `${API_BASE}/farmers/access` with the bearer
token (cache `no-store`) alongside the existing fetches and default to `{}` on
failure. Pass it as `initialAccess` to `<FarmersClient … />`.

> Follow the page's existing fetch style exactly (server `fetch` + `API_BASE` +
> `SESSION_COOKIE`, like `stats/page.tsx`). Default `initialAccess = {}`.

- [ ] **Step 3: Wire the control into `farmers-client.tsx`**

Add `initialAccess` to the props:
```tsx
import type { Farmer, ProductOption, FarmerAccess } from '@/lib/types';
import { AccessControl } from './access-control';

export function FarmersClient({
  initialFarmers,
  products,
  initialMultiFarmer,
  initialAccess = {},
}: {
  initialFarmers: Farmer[];
  products: ProductOption[];
  initialMultiFarmer: boolean;
  initialAccess?: Record<string, FarmerAccess>;
}) {
```

Inside each producer card, directly after the "Свързани продукти" block's closing
`</div>` (the one closing `border-t … bg-ff-surface-2 …`), add:
```tsx
                  <AccessControl farmerId={f.id} initial={initialAccess[f.id]} />
```

- [ ] **Step 4: Verify build**

Run: `pnpm --filter @farmflow/web build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/farmers/access-control.tsx client/src/app/(admin)/farmers/page.tsx client/src/components/farmers/farmers-client.tsx
git commit -m "feat(web): producer login provisioning UI on Фермери screen"
```

---

## Task 10: Web — role-aware shell, farmer nav, route guard

**Files:**
- Modify: `client/src/components/layout/sidebar.tsx`
- Create: `client/src/components/layout/farmer-route-guard.tsx`
- Modify: `client/src/components/layout/admin-shell.tsx`
- Modify: `client/src/app/(admin)/layout.tsx`

- [ ] **Step 1: Add `FARMER_NAV` + a `role` prop to the sidebar**

In `sidebar.tsx`, after the `NAV` export, add the producer's nav (Phase 1+2 = just
Статистика):

```tsx
/** Reduced nav for a producer sub-account (role='farmer'). Grows in later phases. */
export const FARMER_NAV: NavItem[] = [
  { href: '/stats', label: 'Статистика', Icon: BarChart3, desc: 'Твоят личен оборот, поръчки и тренд.' },
];
```

Add `role` to the `Sidebar` props (default `'admin'`):
```tsx
export function Sidebar({
  pendingCount = 0,
  subscriptionActive = true,
  articlesEnabled = true,
  hiddenNav = [],
  role = 'admin',
}: {
  pendingCount?: number;
  subscriptionActive?: boolean;
  articlesEnabled?: boolean;
  hiddenNav?: string[];
  role?: string;
}) {
```

In the `<nav>` body, branch on role. Replace the children of `<nav …>` (the `HOME`
item + `sortedGroups.map(...)`) with:

```tsx
        {role === 'farmer' ? (
          <div className="flex flex-col gap-1">{FARMER_NAV.map(renderItem)}</div>
        ) : (
          <>
            {/* Home — always on top, no group header */}
            <div className="flex flex-col gap-1">{renderItem(HOME)}</div>
            {sortedGroups.map((group) => {
              /* …unchanged existing group-rendering code… */
            })}
          </>
        )}
```

> Keep the existing group-rendering code verbatim inside the `<>…</>`; only the
> `role === 'farmer'` branch is new. The footer (Помощ / Настройки / Изход) stays for
> both roles — a producer needs password change + logout.

- [ ] **Step 2: Create the route guard**

`client/src/components/layout/farmer-route-guard.tsx`:

```tsx
'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/** Producers may only open their own screens; bounce anything else to /stats.
 *  UX only — the server's default-deny guard is the real boundary. */
const FARMER_ALLOWED = ['/stats', '/settings', '/help'];

export function FarmerRouteGuard() {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    const ok = FARMER_ALLOWED.some((p) => pathname === p || pathname.startsWith(p + '/'));
    if (!ok) router.replace('/stats');
  }, [pathname, router]);
  return null;
}
```

- [ ] **Step 3: Thread `role` through `AdminShell`**

In `admin-shell.tsx`, add `role` to props, pass to `Sidebar`, and mount the guard for
producers:

```tsx
import { FarmerRouteGuard } from '@/components/layout/farmer-route-guard';

export function AdminShell({
  children,
  subscriptionActive = true,
  tenantName,
  articlesEnabled = true,
  hiddenNav = [],
  mustChangePassword = false,
  role = 'admin',
}: {
  children: React.ReactNode;
  subscriptionActive?: boolean;
  tenantName?: string;
  articlesEnabled?: boolean;
  hiddenNav?: string[];
  mustChangePassword?: boolean;
  role?: string;
}) {
```
Pass `role` to `<Sidebar … role={role} />`, and before the `<Toaster …>` add:
```tsx
      {role === 'farmer' && <FarmerRouteGuard />}
```

- [ ] **Step 4: Pass `role` from the layout**

In `client/src/app/(admin)/layout.tsx`, the layout already fetches `/auth/me` into
`account` (which includes `role`). Pass it down:

```tsx
    <AdminShell
      subscriptionActive={subscriptionActive}
      tenantName={me.name ?? undefined}
      articlesEnabled={me.articlesEnabled ?? true}
      hiddenNav={account?.hiddenNav ?? []}
      mustChangePassword={mustChangePassword}
      role={account?.role ?? 'admin'}
    >
```

- [ ] **Step 5: Verify build**

Run: `pnpm --filter @farmflow/web build`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/layout/sidebar.tsx client/src/components/layout/farmer-route-guard.tsx client/src/components/layout/admin-shell.tsx "client/src/app/(admin)/layout.tsx"
git commit -m "feat(web): role-aware sidebar + farmer route guard (producers see only Статистика)"
```

---

# Phase 2 — Personal turnover

## Task 11: `StatsService.statsForFarmer` (line-item attribution)

**Files:**
- Modify: `server/src/modules/stats/stats.service.ts`

> No unit test: like the existing `stats()`, this is DB-bound and the repo has no DB
> integration tests — the pure helpers it reuses are already covered, and the SQL is
> verified by the live E2E reconciliation in Task 13's verification. Do not invent a
> mock-DB test that would only assert the mock.

- [ ] **Step 1: Implement `statsForFarmer`**

Add this method to `StatsService` (after `stats`). It returns the same
`StatsSummary` shape but every order-derived figure is summed from line items joined
to `products` filtered by `farmerId`; order counts are `COUNT(DISTINCT order_id)`.

```ts
  /** Per-producer turnover for a multi-farmer shop. Same shape as {@link stats}, but
   *  money/orders come from order_items joined to products filtered by farmer_id (a
   *  shared order counts for every producer in it; delivery is nobody's turnover).
   *  Uses the product's current farmer_id (no snapshot) — see the spec's v1 limit. */
  async statsForFarmer(
    tenantId: string,
    farmerId: string,
    opts: { range?: string; from?: string; to?: string } = {},
  ): Promise<StatsSummary> {
    const today = bgToday();
    const { from, to, range } = resolveWindow(opts, today);
    const bucket = pickBucket(from, to);
    const cfg = BUCKETS[bucket];
    const axisKeys = buildAxis(bucket, from, to);

    const since = bgDayBounds(from).from;
    const toExcl = bgDayBounds(to).to;
    const spanMs = toExcl.getTime() - since.getTime();
    const prevSince = new Date(since.getTime() - spanMs);

    const live = sql`${orders.status} is distinct from 'cancelled'`;
    const lineRev = sql`${orderItems.quantity} * ${orderItems.priceStotinki}`;
    const keyExpr = sql<string>`coalesce(nullif(${orders.customerPhone}, ''), nullif(${orders.customerEmail}, ''), ${orders.customerId}::text)`;
    // Reusable base: this producer's line items, in/around the window.
    const mine = and(eq(orders.tenantId, tenantId), eq(products.farmerId, farmerId));

    const inCur = sql`${orders.createdAt} >= ${since} and ${orders.createdAt} < ${toExcl} and ${live}`;
    const inPrev = sql`${orders.createdAt} >= ${prevSince} and ${orders.createdAt} < ${since} and ${live}`;

    // ── Headline: current + previous window, line-item money + distinct orders. ──
    const aggP = this.db
      .select({
        orderCount: sql<number>`count(distinct ${orders.id}) filter (where ${inCur})::int`,
        revenue: sql<number>`coalesce(sum(${lineRev}) filter (where ${inCur}), 0)::int`,
        prevOrderCount: sql<number>`count(distinct ${orders.id}) filter (where ${inPrev})::int`,
        prevRevenue: sql<number>`coalesce(sum(${lineRev}) filter (where ${inPrev}), 0)::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(mine, gte(orders.createdAt, prevSince), lt(orders.createdAt, toExcl)));

    // ── Payment split (current window): line-item money by parent order method. ──
    const paymentP = this.db
      .select({
        method: orders.paymentMethod,
        count: sql<number>`count(distinct ${orders.id})::int`,
        revenue: sql<number>`coalesce(sum(${lineRev}), 0)::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(mine, gte(orders.createdAt, since), lt(orders.createdAt, toExcl), live))
      .groupBy(orders.paymentMethod);

    // ── Top products (this producer's). ──
    const topP = this.db
      .select({
        name: sql<string>`coalesce(${orderItems.productName}, 'Без име')`,
        quantity: sql<number>`sum(${orderItems.quantity})::int`,
        revenueStotinki: sql<number>`sum(${lineRev})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(mine, gte(orders.createdAt, since), lt(orders.createdAt, toExcl), live))
      .groupBy(sql`1`)
      .orderBy(sql`3 desc`)
      .limit(5);

    // ── Loyalty: distinct customers among this producer's orders, window vs before. ──
    const winKeysP = this.db
      .selectDistinct({ k: keyExpr })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(mine, gte(orders.createdAt, since), lt(orders.createdAt, toExcl), live, sql`${keyExpr} is not null`));
    const priorKeysP = this.db
      .selectDistinct({ k: keyExpr })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(mine, lt(orders.createdAt, since), live, sql`${keyExpr} is not null`));

    // ── Trend: line-item money + distinct orders per Sofia-local bucket. ──
    const localTs = sql`(${orders.createdAt} at time zone 'UTC' at time zone ${BG_TZ})`;
    const bucketExpr = sql<string>`to_char(date_trunc(${sql.raw(`'${cfg.trunc}'`)}, ${localTs}), ${sql.raw(`'${cfg.fmt}'`)})`;
    const seriesP = this.db
      .select({
        t: bucketExpr,
        orders: sql<number>`count(distinct ${orders.id}) filter (where ${live})::int`,
        revenueStotinki: sql<number>`coalesce(sum(${lineRev}) filter (where ${live}), 0)::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(mine, gte(orders.createdAt, since), lt(orders.createdAt, toExcl)))
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    // ── Slow products: this producer's active catalog + how much each sold. ──
    const activeProductsP = this.db
      .select({ id: products.id, name: products.name, weight: products.weight })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.farmerId, farmerId), eq(products.isActive, true)));
    const soldP = this.db
      .select({
        productId: orderItems.productId,
        qty: sql<number>`sum(${orderItems.quantity})::int`,
        revenue: sql<number>`sum(${lineRev})::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(mine, gte(orders.createdAt, since), lt(orders.createdAt, toExcl), live, sql`${orderItems.productId} is not null`))
      .groupBy(orderItems.productId);

    // ── Weekday load: line-item money + distinct orders per Sofia weekday. ──
    const dowExpr = sql<number>`extract(dow from (${orders.createdAt} at time zone 'UTC' at time zone ${BG_TZ}))::int`;
    const weekdayP = this.db
      .select({
        dow: dowExpr,
        orders: sql<number>`count(distinct ${orders.id}) filter (where ${live})::int`,
        revenueStotinki: sql<number>`coalesce(sum(${lineRev}) filter (where ${live}), 0)::int`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(and(mine, gte(orders.createdAt, since), lt(orders.createdAt, toExcl)))
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const [[agg], paymentRows, topProducts, winKeys, priorKeys, seriesRows, activeProducts, sold, weekdayRows] =
      await Promise.all([aggP, paymentP, topP, winKeysP, priorKeysP, seriesP, activeProductsP, soldP, weekdayP]);

    const ret = computeReturning(winKeys.map((r) => r.k), priorKeys.map((r) => r.k));
    const cod = paymentRows.find((r) => r.method === 'cod');
    const online = paymentRows.find((r) => r.method === 'online');

    const soldMap = new Map(sold.map((s) => [s.productId, s]));
    const slowProducts = pickSlowProducts(
      activeProducts.map((p) => {
        const s = soldMap.get(p.id);
        return {
          name: [p.name, p.weight].filter(Boolean).join(' '),
          quantity: s?.qty ?? 0,
          revenueStotinki: s?.revenue ?? 0,
        };
      }),
      5,
    );
    const weekdayLoad = fillWeekday(weekdayRows);

    const found = new Map(seriesRows.map((r) => [r.t, r]));
    const points: StatsPoint[] = axisKeys.map((t) => {
      const r = found.get(t);
      return { t, orders: r?.orders ?? 0, revenueStotinki: r?.revenueStotinki ?? 0 };
    });

    return {
      range, bucket, from, to,
      revenueStotinki: agg.revenue,
      orderCount: agg.orderCount,
      avgOrderStotinki: agg.orderCount ? Math.round(agg.revenue / agg.orderCount) : 0,
      prevRevenueStotinki: agg.prevRevenue,
      prevOrderCount: agg.prevOrderCount,
      customerCount: ret.customerCount,
      returningCustomers: ret.returningCustomers,
      newCustomers: ret.newCustomers,
      codOrders: cod?.count ?? 0,
      codRevenueStotinki: cod?.revenue ?? 0,
      onlineOrders: online?.count ?? 0,
      onlineRevenueStotinki: online?.revenue ?? 0,
      topProducts,
      slowProducts,
      weekdayLoad,
      sparse: agg.orderCount < SPARSE_MIN,
      points,
    };
  }
```

- [ ] **Step 2: Verify the build + existing stats tests still pass**

Run: `pnpm --filter @farmflow/api build`
Expected: succeeds.
Run: `pnpm --filter @farmflow/api test -- stats.service.spec`
Expected: PASS (pure helpers unchanged).

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/stats/stats.service.ts
git commit -m "feat(stats): statsForFarmer — per-producer line-item turnover"
```

---

## Task 12: Stats controller — role-scoped routing

**Files:**
- Modify: `server/src/modules/stats/stats.controller.ts`
- Test: `server/src/modules/stats/stats.controller.spec.ts` (create)

- [ ] **Step 1: Write the failing test**

`server/src/modules/stats/stats.controller.spec.ts`:

```ts
import { StatsController } from './stats.controller';

describe('StatsController routing', () => {
  const svc = { stats: jest.fn().mockResolvedValue('whole'), statsForFarmer: jest.fn().mockResolvedValue('scoped') };
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
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @farmflow/api test -- stats.controller`
Expected: FAIL (controller signature differs).

- [ ] **Step 3: Implement the controller**

Rewrite `stats.controller.ts`:

```ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { StatsService } from './stats.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { effectiveFarmerId } from '../../common/scope/farmer-scope.util';
import type { TenantRequestUser } from '@farmflow/types';

@ApiTags('stats')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Roles('admin', 'farmer')
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get()
  @ApiQuery({ name: 'range', required: false, enum: ['7d', '30d', '90d', '1y'] })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'farmerId', required: false, description: 'Owner-only: scope to one producer' })
  stats(
    @CurrentUser() user: TenantRequestUser,
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('farmerId') farmerId?: string,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, farmerId);
    const opts = { range, from, to };
    return scope
      ? this.statsService.statsForFarmer(user.tenantId, scope, opts)
      : this.statsService.stats(user.tenantId, opts);
  }
}
```

> Verify `CurrentUser` (`server/src/common/decorators/current-user.decorator.ts`)
> returns `req.user`. If its shape differs, adapt the destructuring — the controller
> only needs `user.role`, `user.farmerId`, `user.tenantId`.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @farmflow/api test -- stats.controller`
Expected: PASS.

- [ ] **Step 5: Full server suite + build**

Run: `pnpm --filter @farmflow/api test`
Run: `pnpm --filter @farmflow/api build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/stats/stats.controller.ts server/src/modules/stats/stats.controller.spec.ts
git commit -m "feat(stats): role-scoped /stats (producer forced, owner optional ?farmerId)"
```

---

## Task 13: Web — `farmerId` in getStats + owner producer dropdown

**Files:**
- Modify: `client/src/lib/api-client.ts:451-457` (`getStats`)
- Modify: `client/src/app/(admin)/stats/page.tsx`
- Modify: `client/src/components/stats/stats-client.tsx`

- [ ] **Step 1: Add `farmerId` to `getStats`**

Replace `getStats` in `api-client.ts`:

```ts
export const getStats = (
  opts: ({ range: StatsRange } | { from: string; to: string }) & { farmerId?: string },
) => {
  const base =
    'from' in opts
      ? `from=${encodeURIComponent(opts.from)}&to=${encodeURIComponent(opts.to)}`
      : `range=${opts.range}`;
  const fid = opts.farmerId ? `&farmerId=${encodeURIComponent(opts.farmerId)}` : '';
  return apiFetch<StatsSummary>(`stats?${base}${fid}`);
};
```

- [ ] **Step 2: Feed role + producer list into the stats page**

In `client/src/app/(admin)/stats/page.tsx`, also fetch (in parallel with the existing
`load()`) the viewer's role, the tenant's `multiFarmer` flag, and the farmers list —
only the owner needs the dropdown. Mirror the file's existing token+fetch style:

```tsx
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { StatsClient } from '@/components/stats/stats-client';
import type { StatsSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function authed<T>(path: string, token: string): Promise<T | null> {
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json();
}

export default async function StatsPage() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return <StatsClient initial={null} role="admin" farmers={[]} multiFarmer={false} />;

  const [initial, account, profile] = await Promise.all([
    authed<StatsSummary>('stats?range=30d', token),
    authed<{ role?: string }>('auth/me', token),
    authed<{ multiFarmer?: boolean }>('tenants/me', token),
  ]);
  const role = account?.role ?? 'admin';
  const multiFarmer = profile?.multiFarmer === true;
  // Only the owner of a multi-farmer shop needs the producer picker.
  const farmers =
    role === 'admin' && multiFarmer
      ? (await authed<{ id: string; name: string }[]>('farmers', token)) ?? []
      : [];

  return (
    <StatsClient initial={initial} role={role} farmers={farmers} multiFarmer={multiFarmer} />
  );
}
```

> If `tenants/me` does not expose `multiFarmer`, use whatever field it returns for the
> multi-farmer flag (grep the tenants controller/service); the gate is simply
> "owner + shop has multiple producers".

- [ ] **Step 3: Add the dropdown + producer header to `stats-client.tsx`**

Extend the component props and refetch wiring. At the top of `StatsClient`:

```tsx
export function StatsClient({
  initial,
  role = 'admin',
  farmers = [],
  multiFarmer = false,
}: {
  initial: StatsSummary | null;
  role?: string;
  farmers?: { id: string; name: string }[];
  multiFarmer?: boolean;
}) {
```

Add a `farmerId` state and include it in every `getStats` call the component already
makes (find the existing `getStats({ range })` / `getStats({ from, to })` calls and
spread `{ farmerId }`). Add a `useEffect` that refetches when `farmerId` changes (same
fetch the range selector uses). Example state + handler:

```tsx
  const showPicker = role === 'admin' && multiFarmer && farmers.length > 0;
  const [farmerId, setFarmerId] = useState<string>(''); // '' = whole tenant
```

Wherever the screen currently builds the `getStats` argument, merge the producer:
```tsx
  const withScope = (o: { range: StatsRange } | { from: string; to: string }) =>
    ({ ...o, ...(farmerId ? { farmerId } : {}) });
  // …call getStats(withScope({ range })) etc.
```

Add the picker to the header row (near the `<Seg … />` range selector). For a
producer, render a static title instead:

```tsx
  {role === 'farmer' ? (
    <div className="text-[15px] font-extrabold text-ff-ink">Моят оборот</div>
  ) : showPicker ? (
    <label className="inline-flex items-center gap-2 text-[13px] font-bold text-ff-ink-2">
      Фермер:
      <select
        value={farmerId}
        onChange={(e) => setFarmerId(e.target.value)}
        className="rounded-lg border border-ff-border bg-ff-surface px-2.5 py-1.5 text-[13px] font-semibold text-ff-ink-2 shadow-ff-sm focus:outline-none focus:ring-2 focus:ring-ff-green-500/40"
      >
        <option value="">Всички</option>
        {farmers.map((f) => (
          <option key={f.id} value={f.id}>{f.name}</option>
        ))}
      </select>
    </label>
  ) : null}
```

And add `farmerId` to the dependency array of the effect that refetches on range
change so switching producer reloads the data.

- [ ] **Step 4: Verify build**

Run: `pnpm --filter @farmflow/web build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/api-client.ts "client/src/app/(admin)/stats/page.tsx" client/src/components/stats/stats-client.tsx
git commit -m "feat(web): producer turnover — owner farmer dropdown + producer header on Статистика"
```

---

## Final verification (after all tasks)

- [ ] **Rebuild dist deps + apply migration**

```bash
pnpm --filter @farmflow/db build
pnpm --filter @farmflow/types build
pnpm --filter @farmflow/api build
```
Apply migration `0043` (server auto-migrates on boot, or run the db migrate script).

- [ ] **Full server suite green**

Run: `pnpm --filter @farmflow/api test`
Expected: all pass (existing + new: auth login/invite, farmer-scope, farmers.access,
stats.controller).

- [ ] **Web build green**

Run: `pnpm --filter @farmflow/web build`

- [ ] **Live E2E (per the spec's checklist)** — start the dev stack, then on a
  multi-farmer tenant:
  1. Фермери → a producer → enter email → "Покани" → an invite email is written
     (dev = `.mail-preview/`).
  2. Open the emailed `/reset-password` link → set a password.
  3. Log in as the producer → forced password-change modal → set new password → land
     on **Статистика** showing only that producer's data; the sidebar shows only
     Статистика; navigating to `/orders` bounces back to `/stats`.
  4. As the owner, open Статистика → "Фермер: {that producer}" → the numbers match
     the producer's own view for the same range. **Reconcile**: their `revenueStotinki`
     equals the manual sum of `quantity × price_stotinki` over that producer's line
     items in the window; a shared order appears in both producers' counts; the
     delivery fee is in neither.
  5. Фермери → "Откажи достъп" → the producer's existing session is rejected on its
     next request (must log in again, and login now fails).

---

## Self-review (completed during planning)

- **Spec coverage:** Phase 1 (enum+`farmer_id` T1; types T2; auth threading T3;
  decorator+resolver T4; invite T5; grant/revoke/list T6; endpoints + open shared
  routes T7; web access types/client T8; access UI T9; role shell/guard T10) and
  Phase 2 (`statsForFarmer` T11; controller scoping T12; web dropdown T13) all map to
  tasks. Owner `?farmerId=` bonus → T11/T12/T13. Out-of-scope items (snapshot, own
  products/orders) are deferred to Phases 3–4, not in this plan.
- **Placeholder scan:** none — every code step shows full code; the two "follow the
  page's existing fetch style" notes (T9 step 2, T13 step 2) give an exact template
  (`stats/page.tsx`) and the concrete shape to produce.
- **Type consistency:** `effectiveFarmerId(role, tokenFarmerId, queryFarmerId)`,
  `FarmerAccess { hasLogin, loginEmail, invitePending }`, `grantAccess`/`revokeAccess`/
  `listAccess`, `sendFarmerInvite`, `statsForFarmer(tenantId, farmerId, opts)`, and the
  `role`/`farmerId` JWT+RequestUser fields are used identically across server, tests,
  and web.
- **Security:** opening `auth/me`, `auth/change-password`, `auth/me/nav`, `tenants/me`,
  and `stats` to `farmer` is explicit (T7, T12); every other tenant route stays
  default-deny; producer scope is forced from the token (T4/T12); revoke bumps
  `token_version` (T6).
