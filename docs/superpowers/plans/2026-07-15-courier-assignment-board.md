# Courier assignment board — per-day leg assignment + super-admin account creation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Source spec:** `docs/superpowers/specs/2026-07-15-courier-assignment-board-design.md` (approved, do not re-litigate its design decisions — this plan only says HOW).

**Goal:** Replace the fixed `users.courierIndex` login↔leg binding with a per-day assignment board: for a given date the farmer picks which courier accounts (plus their own account) work and which leg each takes; leg ownership resolves live against those assignments. Move courier-account CREATION from the farmer panel to the super-admin console; the farmer keeps a read-only roster.

**Architecture:** A new `routeCourierAssignments` table `(tenantId, date, accountId, legIndex)` is the source of truth for "who runs which leg on date X." Two hard DB unique constraints prevent double-booking. A date-scoped `resolveMyLeg(tenantId, accountId, date)` helper replaces the JWT strategy's global, date-less `courierIndex` injection at every driver-facing check point. Account grant/revoke/list moves out of the tenant-facing `routing.controller.ts` into a platform-only controller guarded by `PlatformAdminGuard` (NOT `@Roles('admin')` — see Global Constraints). `users.courierIndex` stays in place but stops being read by auth; its column DROP is a separate later PR, not this feature.

**Tech Stack:** NestJS (`server/`), Next.js App Router (`client/` farmer panel + `admin/` super-admin console), Drizzle + hand-written migrations (`packages/db/drizzle/`), shared types (`packages/types/`), Jest (server), vitest (client unit).

## Global Constraints

- **⚠️ HARD PRECONDITION — do not cut this branch or start any task until ALL FOUR are on `main`** (see [Preconditions](#preconditions--branch-cut) below). As of plan-writing NONE are merged. This is a precondition, not a nice-to-have — the four predecessors edit the same files this feature edits (`courier-access.service.ts`, `users` schema, `orders.controller.ts`, `jwt.strategy.ts`); working concurrently guarantees conflicts.
- **⚠️ THE `'admin'` NAMING COLLISION IS THE SHARPEST EDGE IN THIS FEATURE.** TenantRole `'admin'` = the *tenant owner* (farmer), enforced by `TenantRolesGuard` + `@Roles('admin')`. Platform session `type:'platform'` = the *super-admin of the whole platform*, enforced by `PlatformAdminGuard`. They are NOT the same principal and NOT the same guard. The new account-creation controller MUST use `@UseGuards(PlatformAdminGuard)`. Reusing `@Roles('admin')` there would silently re-grant account creation to every farmer — the exact capability we are removing. Never let the two guards be swapped.
- Migrations are HAND-WRITTEN in `packages/db/drizzle/NNNN_*.sql` + a gapless journal entry in `packages/db/drizzle/meta/_journal.json` (a gap silently breaks the migrator). **Do NOT hardcode the number** — see Task A1; it is the next gapless index after whatever the merged predecessors landed.
- Any query using `scheduledForDay/Range` MUST `leftJoin(deliverySlots)` (the `deliverySlots.date` reference throws "missing FROM-clause entry" otherwise). `routeCourierAssignments` is NOT a scheduling-status source and does NOT itself need the leftJoin; but any order query that joins assignments by date keeps obeying the existing `leftJoin(deliverySlots)` rule — the new table just adds a second join on the same `date` string.
- Order-pinning (`orders.courierIndex`, set by `setOrderCourier`) = "this STOP belongs to leg N" and is a SEPARATE concept from `routeCourierAssignments.legIndex` = "this ACCOUNT drives leg N today." This feature does NOT touch order-pinning. Do not merge the two `courierIndex` concepts.
- Server route access is default-deny (`TenantRolesGuard`, default `['admin']`); every endpoint a driver may hit needs explicit `@Roles(...)`.
- Client 4-surface driver-chrome contract when touching role routing: `client/src/middleware.ts` + `client/src/components/layout/driver-route-guard.tsx` + `sidebar.tsx` + `topbar.tsx` must all agree, or a driver is either bounced wrongly or shown organizer-only chrome.
- All client → API traffic via the `/bff` proxy, never the API origin. All dates Europe/Sofia ISO `YYYY-MM-DD` (matches `deliverySlots.date`).
- Optional string DTOs: `@IsOptional()` doesn't coerce `''`→`undefined`; add `@Transform` where relevant.
- UI copy in Bulgarian, matching existing panel tone (informal „ти").
- Push to `main` auto-deploys Hetzner (migrator runs before app images). Do NOT push until final gates pass. Backend-first ordering applies (root CLAUDE.md gotcha #10).

---

## Preconditions & branch cut

**Verify BEFORE writing any code. `git log main --oneline` must show ALL of:**

1. `feat/routes-courier-reminder` merged to `main`.
2. `task_a04caefa` — orders leg-ownership checks on `findOne` (`GET /orders/:id`) + `updateStatusForCourier`. **Hard dependency** (Task A4 re-points the exact checks this task introduces). As of plan-writing `orders.controller.ts:133-135` still reads "Tenant-scoping alone … is sufficient here; no ownership-narrowing beyond tenant for this read" — i.e. this task has NOT landed.
3. `task_ad76feca` — `GET /tenants/me` billing-field stripping (`tenants.controller.ts` / `tenants.service.ts`).
4. `task_a954f6ec` — grantAccess race fix + `users_tenant_courier_index_uniq` partial unique index + its migration (`0108_users_courier_index_uniq.sql`). As of plan-writing this migration is UNCOMMITTED (`??` in `git status`) — not landed.

**Then, and only then:**

- [ ] Cut a NEW branch off `main`: `git checkout main && git pull && git checkout -b feat/courier-assignment-board`. This is a fresh branch, NOT a continuation of `feat/routes-courier-reminder`.
- [ ] **Re-read `task_a04caefa`'s landed leg-ownership helper/shape** on `main` before starting Task A4 (its check reads `user.courierIndex`; Task A4 replaces that source with `resolveMyLeg`). Adjust Task A4's brief to extend, not fork, whatever pattern landed.
- [ ] Create the SDD ledger `.superpowers/sdd/progress-feat-courier-assignment-board.md` with a `## Tasks` checklist (the 8 tasks below) and a `## Log` section, mirroring `.superpowers/sdd/progress-routes-courier-reminder.md`.
- [ ] Commit this plan on the new branch as the ledger base.

**Staged follow-ups this feature deliberately does NOT do (track separately):**
- Dropping `users.courier_index` + removing `users_tenant_courier_index_uniq` — a LATER, separate migration/PR after this feature is proven in prod reading from `routeCourierAssignments` (spec §1.3, §7.3). Deploy it backend-first so no running old image reads a dropped column.
- Removing `courierIndex` from `TenantRequestUser` / `JwtPayload` types — leave typed-optional during the staged retirement to avoid churn; retire it with the column-drop PR.

---

## Workstream A — Data model + date-scoped leg resolution (server)

### Task A1: Migration + `routeCourierAssignments` schema + constraint tests

**Files:**
- Create: `packages/db/drizzle/NNNN_route_courier_assignments.sql` (NNNN per the rule below)
- Modify: `packages/db/drizzle/meta/_journal.json` (append the next gapless idx)
- Modify: `packages/db/src/schema.ts` (add `routeCourierAssignments` table export; near the other route/order tables)
- Test: `server/src/modules/routing/route-courier-assignments.schema.spec.ts` (new — a live-DB constraint test in the routing module, colocated with the code that uses it)

**Interfaces:**
- Produces: drizzle export `routeCourierAssignments` with columns `id`, `tenantId`, `date`, `accountId`, `legIndex` (camelCase), plus two unique constraints `route_courier_assign_tenant_date_account_uniq` and `route_courier_assign_tenant_date_leg_uniq`.

- [ ] **Step 1: Determine the migration number.** Do NOT hardcode. Read `packages/db/drizzle/meta/_journal.json` on the freshly-cut branch. The rule: this feature's first migration is the **next gapless index after whatever the predecessors landed**. If the highest tag is `0108` (idx 106), use `0109` (idx 107). If a predecessor already claimed `0109`, use `0110`, etc. Record the chosen `NNNN` and `idx` and use them consistently in Steps 4–5. (Expected at plan-writing: `0109`, idx 107.)

- [ ] **Step 2: Write the failing constraint test**

```ts
// route-courier-assignments.schema.spec.ts — needs a real Postgres test DB.
// Mirrors the "duplicate raises 23505, not a silent overwrite" style used for
// users_tenant_courier_index_uniq. Skip-guard if no TEST_DATABASE_URL, matching
// sibling live-DB specs in this repo.
it('rejects a duplicate (tenantId, date, accountId)', async () => {
  await db.insert(routeCourierAssignments).values({ tenantId: T, date: '2026-07-20', accountId: A, legIndex: 0 });
  await expect(
    db.insert(routeCourierAssignments).values({ tenantId: T, date: '2026-07-20', accountId: A, legIndex: 1 }),
  ).rejects.toMatchObject({ code: '23505' });
});

it('rejects a duplicate (tenantId, date, legIndex)', async () => {
  await db.insert(routeCourierAssignments).values({ tenantId: T, date: '2026-07-21', accountId: A, legIndex: 0 });
  await expect(
    db.insert(routeCourierAssignments).values({ tenantId: T, date: '2026-07-21', accountId: B, legIndex: 0 }),
  ).rejects.toMatchObject({ code: '23505' });
});
```

- [ ] **Step 3: Run test → FAIL** (`pnpm --filter @fermeribg/api test -- route-courier-assignments.schema`). Expected: FAIL (`routeCourierAssignments` undefined / table missing).

- [ ] **Step 4: Write the migration + schema**

```sql
-- NNNN_route_courier_assignments.sql
CREATE TABLE IF NOT EXISTS "route_courier_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "date" text NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "leg_index" smallint NOT NULL,
  "created_at" timestamp DEFAULT now(),
  CONSTRAINT "route_courier_assign_tenant_date_account_uniq" UNIQUE ("tenant_id", "date", "account_id"),
  CONSTRAINT "route_courier_assign_tenant_date_leg_uniq" UNIQUE ("tenant_id", "date", "leg_index")
);
```

Journal append (use the idx/tag from Step 1; `version:"7"`, next `when` epoch-ms after the current tail, `tag` = filename without `.sql`).

`schema.ts` (new export — follow the file's existing `pgTable` style; `smallint`, `uuid`, `text`, `timestamp`, `uniqueIndex`/`unique` already imported for other tables):

```ts
export const routeCourierAssignments = pgTable(
  'route_courier_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // ISO YYYY-MM-DD, Europe/Sofia — same convention as deliverySlots.date / scheduledForDay.
    date: text('date').notNull(),
    // The assigned login: a role='driver' row OR the tenant owner's role='admin' row.
    // Deliberately NOT discriminated by role (spec §1.1) — the caller always knows
    // the role from context.
    accountId: uuid('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 0-based leg number, same indexing as orders.courierIndex / settings.routing.couriers[].
    legIndex: smallint('leg_index').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // One leg per account per day — an account can't be two legs at once.
    accountUniq: unique('route_courier_assign_tenant_date_account_uniq').on(t.tenantId, t.date, t.accountId),
    // One account per leg per day — a leg can't have two drivers. Hard DB
    // constraints (not app checks) so concurrent board edits can't double-book.
    legUniq: unique('route_courier_assign_tenant_date_leg_uniq').on(t.tenantId, t.date, t.legIndex),
  }),
);
```

- [ ] **Step 5: Apply + run test → PASS.** `pnpm db:migrate` locally, then `pnpm --filter @fermeribg/api test -- route-courier-assignments.schema`. Expected: PASS (both duplicates raise `23505`).

- [ ] **Step 6: Commit** `feat(db): route_courier_assignments table for per-day leg board (migr NNNN)`

---

### Task A2: Assignment service (`resolveMyLeg` + board CRUD + roster) + tenant endpoints

**Files:**
- Create: `server/src/modules/routing/courier-assignment.service.ts`
- Create: `server/src/modules/routing/dto/courier-assignment.dto.ts`
- Modify: `server/src/modules/routing/routing.controller.ts` (add 3 tenant endpoints; imports)
- Modify: `server/src/modules/routing/routing.module.ts` (register `CourierAssignmentService`)
- Test: `server/src/modules/routing/courier-assignment.service.spec.ts`

**Interfaces:**
- Consumes: `routeCourierAssignments` (Task A1); `users` (roster).
- Produces (later tasks depend on these EXACT signatures):
  - `resolveMyLeg(tenantId: string, accountId: string, date: string): Promise<number | null>` — the `legIndex` for that account on that date, or `null` if no row.
  - `getAssignmentsForDay(tenantId: string, date: string): Promise<{ accountId: string; legIndex: number }[]>`
  - `setAssignmentsForDay(tenantId, date, assignments: { accountId: string; legIndex: number }[]): Promise<{ accountId: string; legIndex: number }[]>` — whole-board replace; validates no dup accountId/legIndex in payload → 409; transactional delete-then-insert; catches `23505` → 409.
  - `listTenantCouriers(tenantId, selfUserId): Promise<{ accountId: string; email: string; isSelf: boolean }[]>` — the tenant's `role='driver'` logins PLUS the calling owner's own account (`isSelf: true`), no sensitive fields.
  - Endpoints: `GET /orders/route/assignments?date=…`, `PUT /orders/route/assignments`, `GET /orders/route/couriers` — all `@Roles('admin')`, tenant-scoped via `@CurrentTenant()`.

- [ ] **Step 1: Write the failing service spec** (mock db, mirror `routing.service.spec.ts` / `courier-access.service.spec.ts` style — prove the WHERE structure is tenant+date-scoped, not just "called with something"):

```ts
describe('resolveMyLeg', () => {
  it('returns the assigned legIndex for (tenant, date, account)', async () => {
    // db returns [{ legIndex: 1 }] → expect 1
  });
  it('returns null when there is no row for that date', async () => {
    // db returns [] → expect null
  });
  it('is date-scoped: same account, two dates → two legs resolved independently', async () => {
    // date X → 1, date Y → 0
  });
});

describe('setAssignmentsForDay', () => {
  it('rejects a payload double-booking one leg (two accounts same legIndex) with 409', async () => {
    await expect(svc.setAssignmentsForDay(T, D, [
      { accountId: A, legIndex: 0 }, { accountId: B, legIndex: 0 },
    ])).rejects.toBeInstanceOf(ConflictException);
  });
  it('rejects a payload assigning one account to two legs with 409', async () => { /* A→0, A→1 */ });
  it('maps a DB 23505 to a 409', async () => { /* stubbed tx insert throws {code:23505} */ });
});

describe('listTenantCouriers', () => {
  it('returns drivers + a self entry flagged isSelf, no password/hash/tokenVersion fields', async () => { /* ... */ });
});
```

- [ ] **Step 2: Run → FAIL** (`pnpm --filter @fermeribg/api test -- courier-assignment.service`). Expected: FAIL (service undefined).

- [ ] **Step 3: Implement the service.** Key methods:

```ts
async resolveMyLeg(tenantId: string, accountId: string, date: string): Promise<number | null> {
  const [row] = await this.db
    .select({ legIndex: routeCourierAssignments.legIndex })
    .from(routeCourierAssignments)
    .where(and(
      eq(routeCourierAssignments.tenantId, tenantId),
      eq(routeCourierAssignments.date, date),
      eq(routeCourierAssignments.accountId, accountId),
    ))
    .limit(1);
  return row ? row.legIndex : null;
}

async setAssignmentsForDay(tenantId, date, assignments) {
  // In-payload validation BEFORE hitting the DB (clear 409 the UI surfaces inline).
  const accs = new Set<string>(); const legs = new Set<number>();
  for (const a of assignments) {
    if (accs.has(a.accountId)) throw new ConflictException('Този акаунт вече е зачислен за деня.');
    if (legs.has(a.legIndex)) throw new ConflictException('Този курс вече има куриер за деня.');
    accs.add(a.accountId); legs.add(a.legIndex);
  }
  // Whole-board replace: delete the day's rows, insert the new set, atomically.
  try {
    return await this.db.transaction(async (tx) => {
      await tx.delete(routeCourierAssignments)
        .where(and(eq(routeCourierAssignments.tenantId, tenantId), eq(routeCourierAssignments.date, date)));
      if (assignments.length) {
        await tx.insert(routeCourierAssignments)
          .values(assignments.map((a) => ({ tenantId, date, accountId: a.accountId, legIndex: a.legIndex })));
      }
      return assignments;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new ConflictException('Разписанието се промени едновременно — опресни и опитай пак.');
    }
    throw err;
  }
}
```

`listTenantCouriers(tenantId, selfUserId)`: select `role='driver'` rows (`accountId`, `email`) scoped to tenant; also select the owner's own row by `id=selfUserId` (email); return drivers mapped with `isSelf:false` plus the self row with `isSelf:true`. Return ONLY `{ accountId, email, isSelf }` — never `passwordHash`/`tokenVersion`/`mustChangePassword`.

DTO (`courier-assignment.dto.ts`):

```ts
class AssignmentRowDto {
  @IsUUID() accountId!: string;
  @IsInt() @Min(0) @Max(9) legIndex!: number;
}
export class SetAssignmentsDto {
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => AssignmentRowDto) assignments!: AssignmentRowDto[];
}
export class AssignmentsQueryDto {
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
}
```

Controller (add to `routing.controller.ts`, multi-segment paths so OrdersModule's `/orders/:id` can't capture them — same reason as the existing `route/*` routes):

```ts
@Get('route/assignments')
@Roles('admin')
getAssignments(@CurrentTenant() tenantId: string, @Query() q: AssignmentsQueryDto) {
  return this.courierAssignmentService.getAssignmentsForDay(tenantId, q.date);
}

@Put('route/assignments')
@Roles('admin')
setAssignments(@CurrentTenant() tenantId: string, @Body() dto: SetAssignmentsDto) {
  return this.courierAssignmentService.setAssignmentsForDay(tenantId, dto.date, dto.assignments);
}

// Read-only roster for the farmer: drivers + own account. Feeds the read-only
// CourierHomesModal (Task C1) and the assignment board (Task C2). Deliberately a
// NEW tenant-scoped endpoint, NOT the platform listAccess (which is behind
// PlatformAdminGuard + takes an explicit tenantId — a farmer session can't and
// shouldn't reach it; cross-tenant foot-gun).
@Get('route/couriers')
@Roles('admin')
listCouriers(@CurrentTenant() tenantId: string, @CurrentUser() user: TenantRequestUser) {
  return this.courierAssignmentService.listTenantCouriers(tenantId, user.userId);
}
```

Register `CourierAssignmentService` in `routing.module.ts` providers and inject it in the controller constructor.

- [ ] **Step 4: Run → PASS** (`pnpm --filter @fermeribg/api test -- courier-assignment.service`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): per-day courier-assignment service + tenant board/roster endpoints`

---

### Task A3: `getRoute` + `route/measure` — assignments drive leg count & driver leg via `resolveMyLeg`

**Files:**
- Modify: `server/src/modules/routing/routing.service.ts` (`getRoute` — leg-count precedence)
- Modify: `server/src/modules/routing/routing.controller.ts` (`getRoute` driver filter, `measure` driver scope)
- Test: `server/src/modules/routing/routing.service.spec.ts` + a controller-level spec for the driver filter

**Interfaces:**
- Consumes: `resolveMyLeg`, `getAssignmentsForDay` (Task A2).

**Two distinct changes — keep them separate in the code:**

1. **Leg-count precedence (organizer view, spec §4.2).** In `getRoute`, before computing `n = effectiveCourierCount(...)`, look up `getAssignmentsForDay(tenantId, date)`. If it returns ≥1 row, `n` = the count of DISTINCT `legIndex` values in the assignments (overriding both `?couriers=` and `settings.routing.courierCount`). Zero assignments → unchanged current behavior (dropdown/`effectiveCourierCount` → `sweepSplit`). The `free`/pinned split logic at `routing.service.ts:471-496` is otherwise untouched.
2. **Driver leg via `resolveMyLeg` (spec §3.3/§3.5).** In the controller, replace the driver filter's `user.courierIndex` with `resolveMyLeg(tenantId, user.userId, date)`:

```ts
// getRoute controller — driver branch (replaces the r.courierIndex === user.courierIndex filter)
if (!isDriver) return result;
const myLeg = date ? await this.courierAssignmentService.resolveMyLeg(tenantId, user.userId, date) : null;
if (myLeg == null) return { ...result, routes: [], couriers: 0 }; // "не участва днес" empty state
const routes = result.routes.filter((r) => r.courierIndex === myLeg);
return { ...result, routes, couriers: routes.length };
```

For `route/measure`, the existing own-leg check (`51baa66`) recomputes the driver's own stops from `getRoute` and rejects foreign `stopIds`. Re-point the leg it compares against from `user.courierIndex` to `resolveMyLeg(tenantId, user.userId, dto.date)`; a `null` leg → the driver owns no stops → any non-empty `stopIds` is rejected (`ForbiddenException`), and `courierIndex` passed to `measureExplicitOrder` is `undefined`/the resolved leg. Extend the existing pattern; do NOT add a parallel one.

- [ ] **Step 1: Write failing tests** — (a) `getRoute`: with 2 assignment rows (legs 0,1) for date X and `?couriers=1`, the split still produces 2 legs (assignments win over the dropdown); with 0 assignments, `?couriers=1` yields 1 leg (unchanged). (b) driver `getRoute`: driver assigned leg 1 on date X sees only leg-1 stops+money, others absent; driver with NO assignment for X → `routes: []`; same driver on date Y (assigned leg 0) sees leg 0 (proves date-keyed, not frozen). (c) `measure`: `stopIds` outside the resolved leg for the measured date rejected; own-leg measures fine.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement both changes** (inject `CourierAssignmentService` into `RoutingService` for the precedence lookup, and it is already available in the controller from Task A2).
- [ ] **Step 4: Run → PASS**; run the full routing suite (`pnpm --filter @fermeribg/api test -- routing`) — no regressions.
- [ ] **Step 5: Commit** `feat(server): assignments drive leg count + date-scoped driver leg resolution`

---

### Task A4: Finish/undo + `GET /orders/:id` leg-ownership via `resolveMyLeg`; retire `courierIndex` from JWT

> **⚠️ BLOCKED ON `task_a04caefa`.** This task re-points the exact leg-ownership check that `task_a04caefa` introduces on `orders.findOne` + `updateStatusForCourier`. **Before writing it, read that task's landed helper on `main`** (it will read `user.courierIndex`) and extend it — do not fork or duplicate it. If `task_a04caefa` landed with a different shape than assumed here, adjust this task's brief at execution time.

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts` (`updateStatusForCourier`, `findOne` — swap the leg source)
- Modify: `server/src/modules/orders/orders.controller.ts` (pass what `resolveMyLeg` needs; likely `user.userId` + the order's date)
- Modify: `server/src/modules/auth/jwt.strategy.ts` (STOP selecting/injecting `courierIndex`)
- Modify: `server/src/modules/orders/orders.module.ts` (import routing's `CourierAssignmentService` if not already reachable)
- Test: `server/src/modules/orders/orders.service.spec.ts` (or the spec `task_a04caefa` added — extend it)

**Interfaces:**
- Consumes: `resolveMyLeg` (Task A2); the leg-ownership check shape from `task_a04caefa`.

**Ordering rationale (why JWT retirement lives HERE, last):** Task A3 migrated `getRoute`/`measure` off `user.courierIndex` but the JWT still injects it (harmlessly unused there). This task migrates the LAST two readers (finish/undo + `findOne`), so retiring the JWT injection now leaves NO reader broken. Do not retire the injection before this task.

- [ ] **Step 1: Write failing tests** — driver can finish/undo only their assigned leg's orders for that order's delivery day; a driver with no assignment for that day → denied (403/404-style, matching `task_a04caefa`'s deny shape); `GET /orders/:id` for an order on a leg the driver isn't assigned → denied. The leg is resolved from the ORDER's scheduled date (via the existing `scheduledForDay`/slot join — keep the `leftJoin(deliverySlots)` contract), not a request param.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** In `updateStatusForCourier`/`findOne`, fetch the order's delivery date (the slot-joined date already available in `task_a04caefa`'s query), then `resolveMyLeg(tenantId, user.userId, orderDate)`; compare the order's leg (`orders.courierIndex`, i.e. its pin — a driver may only act on stops that resolve onto their leg) against the driver's resolved leg. Then in `jwt.strategy.ts`: drop `courierIndex` from the `users` select (keep the `tokenVersion` re-select for revocation) and remove the `...(user.courierIndex != null ? {courierIndex} : {})` spread. Leave `TenantRequestUser.courierIndex` typed-optional (retired with the column-drop PR).
- [ ] **Step 4: Run → PASS**; full `orders` + `auth` + `routing` suites green.
- [ ] **Step 5: Commit** `feat(server): date-scoped leg-ownership on finish/undo + order read; retire courierIndex from JWT`

---

## Workstream B — Courier-account creation moves to super-admin

### Task B1: Platform courier controller (PlatformAdminGuard) + re-point service + delete tenant-panel copies

> **⚠️ Guard: `@UseGuards(PlatformAdminGuard)`, NEVER `@Roles('admin')`.** See Global Constraints. This is the naming-collision regression.
>
> Parallelizable with Task A2/A3 (different files) once A1 is done — but the account-CRUD file `courier-access.service.ts` was edited by `task_a954f6ec`; confirm no conflict.

**Files:**
- Create: `server/src/modules/platform/platform-courier.controller.ts` (or add a section to `platform.controller.ts` — match the module's convention; sibling per-tenant routes already live as `@Post('tenants/:id/...')` on `PlatformController`)
- Modify: `server/src/modules/routing/courier-access.service.ts` (`grantAccess` drops the `courierIndex` param/binding; `listAccess`/`revokeAccess` keyed by `accountId` not leg index)
- Modify: `server/src/modules/routing/routing.controller.ts` (DELETE the 3 tenant-panel courier-access endpoints at lines ~221-243 + the now-unused `GrantCourierAccessDto` import + `CourierAccessService` injection if nothing else uses it)
- Modify: `server/src/modules/platform/platform.module.ts` (provide the controller; import `RoutingModule`/export `CourierAccessService` so it's injectable — or move the service to a shared spot)
- Modify: `server/src/modules/routing/dto/courier-access.dto.ts` (grant DTO becomes `{ email }` only)
- Test: `server/src/modules/routing/courier-access.service.spec.ts` (update to the leg-free grant) + a guard test proving a tenant `@Roles('admin')` session is rejected by `PlatformAdminGuard`

**Interfaces:**
- Endpoints (base path to match sibling platform routes — `platform/tenants/:tenantId/...`, confirmed against `@Post('tenants/:id/products/extract')`):
  - `GET  /platform/tenants/:tenantId/courier-access` → `{ accountId, email, invitePending }[]`
  - `POST /platform/tenants/:tenantId/courier-access { email }` → grant/re-invite
  - `DELETE /platform/tenants/:tenantId/courier-access/:accountId` → revoke
- Grant semantics: provisions a `role='driver'` login for the target tenant (normalized email, collision check, argon2 random hash, `mustChangePassword`, set-password invite mail) with `courierIndex` left NULL — leg assignment happens on the board (Task C2), not at grant time.

- [ ] **Step 1: Write failing tests** — (a) `grantAccess(tenantId, email)` creates a driver login with `courierIndex` NULL, sends the invite, collision → 409; `revokeAccess(tenantId, accountId)` bumps tokenVersion + nulls FK refs + deletes (copy the existing transaction). (b) Guard test: a request whose session `type:'tenant', role:'admin'` hitting the platform controller is rejected with 403 by `PlatformAdminGuard`; a `type:'platform'` session passes.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Reshape `CourierAccessService.grantAccess` to `(tenantId, email)` (drop the `courierIndex` lookup/insert value — create the driver row with no `courierIndex`); reshape `listAccess`/`revokeAccess` to key by `accountId` (`users.id`) instead of `courierIndex`. Add the platform controller with `@UseGuards(PlatformAdminGuard)` taking `@Param('tenantId')`. Delete the tenant-panel endpoints from `routing.controller.ts`. Keep the invite-mail flow intact.
- [ ] **Step 4: Run → PASS**; full `routing` + `platform` suites green; `pnpm --filter @fermeribg/api build` (tsc) green — confirm the deleted tenant endpoints have no dangling imports.
- [ ] **Step 5: Commit** `feat(server): super-admin courier-account CRUD (platform-guarded); remove farmer-panel account creation`

---

### Task B2: Admin app — „Куриери" section

**Files:**
- Modify: `admin/src/components/tenant-detail-client.tsx` (add a „Куриери" section — flat roster + invite/resend/revoke, mirroring `CourierHomesModal`'s old UX but in the admin console)
- Modify: `admin/src/lib/api-client.ts` (add `listTenantCourierAccess(tenantId)`, `grantTenantCourierAccess(tenantId, email)`, `revokeTenantCourierAccess(tenantId, accountId)` — calling `platform/tenants/${tenantId}/courier-access`, matching the existing `platform/tenants/${tenantId}/...` wrapper style)
- Test: browser-verify (admin app has no unit harness for this; follow the repo's browser-verify precedent)

**Interfaces:**
- Consumes: the Task B1 platform endpoints. Because accounts are no longer per-leg, the list is a FLAT roster (email + invite-pending status), not a per-leg grid.

- [ ] **Step 1: Add the api-client wrappers** (return `{ accountId, email, invitePending }[]` for list).
- [ ] **Step 2: Add the „Куриери" section** to `tenant-detail-client.tsx` (follow the existing `<h2 className="…font-extrabold">` section pattern at lines ~295/421): list rows with email + „поканен"/„активен" badge, an „Покани куриер" email input + button, „Изпрати отново" and „Премахни достъп" per row. Bulgarian copy, informal tone.
- [ ] **Step 3: `pnpm --filter @fermeribg/admin build`** green.
- [ ] **Step 4: Browser-verify** (dev): as super-admin, open a tenant → Куриери → invite an email (invite mail fires) → row appears „поканен" → revoke removes it. A tenant/farmer session cannot reach these endpoints (Task B1 guard test already proves the server side).
- [ ] **Step 5: Commit** `feat(admin): per-tenant Куриери section (invite/resend/revoke courier logins)`

---

## Workstream C — Farmer panel (client)

### Task C1: `CourierHomesModal` → read-only roster

> Must land AFTER Task B1 (the tenant grant/revoke endpoints it currently calls are deleted there) and Task A2 (the new roster endpoint it will read).

**Files:**
- Modify: `client/src/components/route/courier-homes-modal.tsx` (remove all invite/resend/revoke actions; render a read-only roster from `GET /orders/route/couriers`)
- Modify: `client/src/lib/api-client.ts` (remove `grantCourierAccess`/`revokeCourierAccess`/`listCourierAccess` wrappers at lines ~748-759 — they hit now-deleted endpoints; add `listRouteCouriers(): { accountId, email, isSelf }[]` calling `orders/route/couriers`)
- Modify: `client/src/lib/types.ts` (retire/replace the `CourierAccess` type used by the removed wrappers)
- Test: vitest for any extracted pure helper; otherwise browser-verify

**Interfaces:**
- Consumes: `GET /orders/route/couriers` (Task A2) → `{ accountId, email, isSelf }[]`.

- [ ] **Step 1: Swap the data source** — replace `listCourierAccess`/grant/revoke usage with `listRouteCouriers`; delete the grant/revoke/invite UI (email inputs, „Покани"/„Премахни достъп" buttons, per-row busy tracking that drove them). Keep the courier HOME-address editing UI (that's the modal's original, separate purpose — `mergeCourierRows`/`rowToPayload`/`getTenant`/`updateTenant` stay). The roster becomes a read-only list: „Куриери на фермата" — email per row, „(ти)" marker on the `isSelf` row; a note that accounts are created by the platform operator.
- [ ] **Step 2: Remove the dead api-client wrappers + `CourierAccess` type**; `pnpm --filter @fermeribg/web build` green (catches any other caller of the removed wrappers).
- [ ] **Step 3: Browser-verify** (dev): farmer opens the modal → sees the roster (drivers + own account) read-only, no invite/revoke controls; home-address editing still works.
- [ ] **Step 4: Commit** `feat(client): CourierHomesModal read-only courier roster (account creation moved to admin)`

---

### Task C2: Assignment board UI on the route page + precedence + 4-surface driver chrome

**Files:**
- Create: `client/src/components/route/courier-assignment-board.tsx`
- Modify: `client/src/components/route/route-client.tsx` (mount the board alongside — NOT replacing — the couriers-count dropdown; apply the precedence rule)
- Modify: `client/src/lib/api-client.ts` (`getRouteAssignments(date)`, `setRouteAssignments(date, assignments)` → `orders/route/assignments`)
- Modify: `client/src/middleware.ts` + `client/src/components/layout/driver-route-guard.tsx` + `sidebar.tsx` + `topbar.tsx` — verify (and only change if needed) the 4-surface contract so an unassigned driver still lands on `/route` and sees the friendly empty state, NOT bounced and NOT shown organizer chrome
- Test: vitest for the pure precedence helper (extract `deriveLegCount(assignments, dropdownCount)` / precedence logic into `courier-assignment.ts`); browser-verify both roles

**Interfaces:**
- Consumes: `GET /orders/route/couriers` (roster, Task A2), `GET/PUT /orders/route/assignments` (Task A2). Server already computes the split from assignments (Task A3) — the client reflects it.

**Behavior (spec §4):**
- Scope: the currently selected route date only (no recurring view — YAGNI).
- Rows: all roster entries (drivers + own account, the `isSelf` row labelled e.g. „Аз (собствена доставка)"). Per row: a leg select `0..N` or „не участва днес" (unassigned). Immediate persistence via `setRouteAssignments`.
- **Precedence (§4.2):** zero assignments for the date → route page behaves exactly as today (couriers-count dropdown + auto-split live). ≥1 assignment → the board defines the day: leg count = number of distinct assigned legs; the couriers-count dropdown becomes read-only/hidden for that day (the board drives the split server-side). No state where both fight over the leg count.
- A double-book PUT returns 409 (Task A2) → surface it inline on the offending row.

- [ ] **Step 1: Write the failing vitest** for `deriveLegCount(assignments, dropdownCount)`: `[]` → use `dropdownCount`; `[{leg:0},{leg:1}]` → 2 (distinct legs), dropdown inert. And a helper that maps a 409 to the inline error string.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the board component + wire into `route-client.tsx` (admin only — hidden in driver mode, which Task A4 already makes moot server-side, but keep the client gating consistent). Apply precedence to the couriers-count dropdown (disable/hide when assignments exist).
- [ ] **Step 4: Verify the 4-surface contract** — confirm `middleware.ts`/`driver-route-guard.tsx`/`sidebar.tsx`/`topbar.tsx` all still name the same driver route set; an unassigned driver lands on `/route` and sees „нямаш маршрут за днес" (the §3.5 empty state from Task A3), not bounced/organizer chrome. Change all four together only if a change is needed.
- [ ] **Step 5: Run vitest → PASS**; `pnpm --filter @fermeribg/web build` green.
- [ ] **Step 6: Browser-verify BOTH roles** (dev): farmer assigns couriers to legs for a day → the split reflects the board; a driver logs in and sees exactly their assigned leg (and the empty state when unassigned); admin on a zero-assignment day is unchanged (dropdown still drives the split); a double-book shows the inline 409.
- [ ] **Step 7: Commit** `feat(client): per-day courier assignment board (leg assignment + dropdown precedence)`

---

## Ship

- [ ] **Gates:** `pnpm --filter @fermeribg/api test` full green; `pnpm --filter @fermeribg/web test` + `build`; `pnpm --filter @fermeribg/admin build`; `pnpm lint`; `tsc` across the workspace.
- [ ] **Migration sanity:** `_journal.json` has NO idx gap; the new migration is additive (new table only — safe on a live DB); `users.courier_index` is still present (its DROP is the SEPARATE follow-up PR, not this branch).
- [ ] **Full-diff code review** (merge-base..HEAD, independent reviewer): correctness + the new migration + security. Specifically verify: every new/changed query is `tenantId`-scoped (no cross-tenant reach on assignments/roster/resolveMyLeg); the platform courier controller uses `PlatformAdminGuard` and the tenant courier-access endpoints are GONE (naming-collision regression); driver leg resolution is date-keyed everywhere (`getRoute`, `measure`, finish/undo, `findOne`) with no residual `user.courierIndex` read in the auth path; the roster endpoint leaks no sensitive fields.
- [ ] **Live E2E** (dev DB): farmer assigns a day's board → driver sees only their leg → finish/undo scoped to that leg → unassigned driver gets the empty state → super-admin creates a courier account from the admin console → it appears in the farmer's read-only roster.
- [ ] **Finish the branch** via `superpowers:finishing-a-development-branch` — merge to `main` only on explicit user go-ahead (push auto-deploys Hetzner; migrator runs the new table migration first). Backend-first ordering per root CLAUDE.md #10.
- [ ] **File the staged follow-up** for the later `users.courier_index` DROP + `users_tenant_courier_index_uniq` removal + type cleanup, to be done once this feature is confirmed live in prod reading from `routeCourierAssignments`.

---

## Self-review (against the spec)

- §1.1 table + both unique constraints → Task A1. §1.3 staged retirement (column stays, auth stops reading) → Task A4 (JWT) + Ship follow-up (DROP). §1.2 leftJoin contract → Global Constraints + Task A4 note.
- §2.1 relocate CRUD to platform + drop courierIndex from grant → Task B1. §2.2 naming collision → Global Constraints + Task B1 guard test. §2.3 admin „Куриери" → Task B2. §2.4 read-only roster endpoint + modal → Task A2 (endpoint) + Task C1 (modal).
- §3.1 JWT stops resolving leg → Task A4. §3.2 `resolveMyLeg` → Task A2. §3.3 endpoints (getRoute/measure/finish-undo/findOne) → Tasks A3+A4. §3.4 `task_a04caefa` hard dependency → Preconditions + Task A4 block note. §3.5 empty state → Tasks A3 (getRoute/measure) + A4 (deny) + C2 (UI). §3.6 no order-pin conflation → Global Constraints.
- §4.1 board behavior → Task C2. §4.2 precedence → Task A3 (server leg count) + Task C2 (dropdown inert). §4.3 4-surface contract → Task C2 Step 4.
- §5 testing → each task's TDD steps + Ship. §6 YAGNI (no recurring, no accountRole, no column drop) → honored (not planned). §7 sequencing/migration numbering → Preconditions + Task A1 Step 1.

## Execution handoff

**Plan complete. Two execution options:**

1. **Subagent-Driven (recommended)** — `superpowers:subagent-driven-development`: a fresh implementer subagent per task, a task-scoped reviewer given `git diff <base>..<head>` of just that task, fix-round until approved, tracked in `.superpowers/sdd/progress-feat-courier-assignment-board.md`. This matches how the predecessor branch was executed. **Do NOT dispatch any task until the four preconditions are on `main`.**
2. **Inline Execution** — `superpowers:executing-plans`: batch execution with checkpoints.

**Suggested SDD order** (respecting dependencies; A2‖B1 parallelizable after A1): A1 → A2 → A3 → A4 → B1 → B2 → C1 → C2 → Ship.
