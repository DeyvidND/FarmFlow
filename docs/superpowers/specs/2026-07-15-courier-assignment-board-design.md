# Courier assignment board — per-day leg assignment + super-admin account creation — design

**Builds on:** `feat/routes-courier-reminder` (branch merge-base `09d6fa1`), which is
fully implemented, reviewed, tested, and about to merge to `main`. This feature is a
NEW branch cut from `main` *after* that branch and its three in-flight fast-follow
tasks land (see [Sequencing & preconditions](#7-sequencing--preconditions--migration-numbering)).

## Problem

The prior branch shipped courier ("доставчик") logins, but with two shapes we now want
to change:

1. **The farmer self-serves courier-account creation.** `CourierHomesModal` in the
   farmer panel lets a tenant owner invite/resend/revoke driver logins directly
   (`POST/DELETE /orders/route/courier-access`, all `@Roles('admin')` where 'admin'
   means the *tenant owner*). We want account CREATION to be a platform super-admin
   responsibility instead — the operator provisions courier logins per tenant from the
   admin console, and the farmer only *uses* them.

2. **An account is welded to one leg forever.** `users.courierIndex` (a smallint on the
   login row) permanently binds a driver account to exactly one courier leg at grant
   time — "account #2 is always Куриер 2." Real delivery days don't work that way: on
   Monday three couriers run, on Tuesday only one, on Wednesday the farmer drives it
   themselves. The farmer needs to decide *per day* which accounts work and which leg
   each one takes — including assigning the day to their own account for self-delivery.

This feature replaces the fixed binding with a **per-day assignment board**: for a given
date, the farmer picks which courier accounts (plus their own account) are working and
which leg number each takes. Leg ownership is then resolved live against those
assignments instead of against the frozen `users.courierIndex`.

## Decisions captured in brainstorming

These were settled with the user; this spec writes them up, it does not re-open them.

- **Account creation → super-admin only.** The farmer panel loses invite/revoke; the
  admin app (`@fermeribg/admin`, platform console) gains a "Куриери" section per tenant.
  The farmer keeps a **read-only roster** in `CourierHomesModal`.
- **Per-day board, not a recurring schedule.** v1 assigns couriers to legs for one
  specific date only. No weekly/recurring default (explicit YAGNI cut — revisitable).
- **The farmer's own account is a "courier" on the board.** For self-delivery days the
  tenant-owner `role='admin'` row is a selectable assignee, indistinguishable from a
  driver row on the board.
- **New assignment table, `users.courierIndex` retired from auth.** A new
  `routeCourierAssignments` table becomes the source of truth for "who runs which leg on
  date X." `users.courierIndex` stops being read by auth; its column is dropped in a
  *later, separate* migration once nothing reads it (no big-bang).
- **Order-pinning is untouched.** `orders.courierIndex` (the per-order "pin this stop to
  leg N", set by `setOrderCourier`) is a **separate concept** from the driver account's
  leg. This feature does not change order-pinning. See the callout in section 3.

## Existing foundation (grounded in code)

Everything below was verified against the working tree at spec-writing time
(2026-07-15). Line numbers are load-bearing anchors; re-confirm before editing since
three background tasks are mutating these files concurrently.

- **`users.courierIndex`** — `smallint('courier_index')`, nullable, `packages/db/src/schema.ts:163`.
  A partial unique index `users_tenant_courier_index_uniq` on `(tenantId, courierIndex)`
  WHERE `role='driver' AND courier_index is not null` exists at `schema.ts:174-176`,
  backed by migration `0108_users_courier_index_uniq.sql` (idx 106 in the journal). This
  index was added by fast-follow `task_a954f6ec` to close a grantAccess race; **as of
  spec-writing it is present in the working tree but UNCOMMITTED** (`??` in `git status`).
- **`CourierAccessService`** — `server/src/modules/routing/courier-access.service.ts`,
  methods `listAccess` / `grantAccess` / `revokeAccess` for `role='driver'` logins, each
  permanently bound to one `courierIndex` at grant time.
- **`routing.controller.ts`** — `@Controller('orders')`, so the courier-access routes are
  actually `GET/POST /orders/route/courier-access` and `DELETE /orders/route/courier-access/:index`
  (`routing.controller.ts:221-243`), all `@Roles('admin')`. A comment at lines 217-220
  already flags this as "a security-sensitive account-management surface." The
  driver-scoped read/finish endpoints — `GET /orders/route` (`@Roles('admin','driver')`,
  line 50-52), `POST /orders/route/measure` (`@Roles('admin','driver')`, line 118-120) —
  and the order finish/undo endpoints in `orders.controller.ts` all trust
  `user.courierIndex`.
- **JWT re-select** — `server/src/modules/auth/jwt.strategy.ts:53-73` re-reads
  `courierIndex` fresh from the DB on every request (piggybacking the tokenVersion
  check) so a re-grant/revoke takes effect without re-login. This read is **global and
  NOT keyed by any date param.** That property is exactly what this feature has to break
  (section 3).
- **`sweepSplit()`** — `server/src/modules/routing/route-split.ts:400-403`, already
  generic to N couriers (`couriers: number`); partitions stops among N legs.
- **`effectiveCourierCount()`** — `routing.service.ts:269`, resolves the leg count from
  a `?couriers=` query param, else `settings.routing.courierCount`, else 1, clamped
  `[1,10]`.
- **`getRoute`** — `routing.service.ts:465,482`; computes `n = effectiveCourierCount(...)`
  then `groups = sweepSplit(originPt, free, n, splitEnd)` where `free` = orders NOT
  manually pinned via `setOrderCourier`.
- **Session/role types** — `packages/types/src/index.ts`: `TenantRole =
  'admin' | 'driver' | 'customer' | 'farmer'` (~line 239); `JwtPayload.type?:
  'tenant' | 'platform'` (~line 246); `TenantRequestUser.courierIndex?: number` (~line 271).
- **Platform gating pattern** — `server/src/common/guards/platform-admin.guard.ts`
  extends `AuthGuard('jwt')` and rejects anything whose session `type !== 'platform'`.
  Platform-only controllers use `@UseGuards(PlatformAdminGuard)` (see
  `platform.controller.ts:62`, `marketplace-finance.controller.ts:23`). This is a
  DIFFERENT guard from the tenant-side `TenantRolesGuard` + `@Roles(...)`.
- **Client route page** — `client/src/components/route/route-client.tsx` (couriers-count
  dropdown ~line 139/169/292/306/429), `courier-homes-modal.tsx` (grant/revoke/list UI,
  already has per-row busy tracking), and the **4-surface driver-gating contract**:
  `client/src/middleware.ts` + `client/src/components/layout/driver-route-guard.tsx` +
  `sidebar.tsx` + `topbar.tsx` must all agree, or a driver is either bounced wrongly or
  shown organizer-only chrome.
- **Admin per-tenant detail** — `admin/src/app/(panel)/tenants/[id]/page.tsx` +
  `admin/src/components/tenant-detail-client.tsx`, the natural home for the new courier
  section.
- **Date convention** — `server/src/modules/orders/order-scheduling.ts`: `deliverySlots.date`
  is text ISO (`YYYY-MM-DD`, Europe/Sofia), and any query using `scheduledForDay/Range`
  MUST `leftJoin(deliverySlots)`.

## 1. Data model

### 1.1 New table `routeCourierAssignments` (migration NNNN — number per section 7)

The source of truth for "which account runs which leg on which day."

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK, `defaultRandom()` | |
| `tenantId` | `uuid NOT NULL`, FK → `tenants.id` `ON DELETE CASCADE` | tenant scope |
| `date` | `text NOT NULL` | ISO `YYYY-MM-DD`, Europe/Sofia — matches `deliverySlots.date` / `scheduledForDay` convention |
| `accountId` | `uuid NOT NULL`, FK → `users.id` `ON DELETE CASCADE` | the assigned login (driver OR the tenant owner) |
| `legIndex` | `smallint NOT NULL` | 0-based leg number, same indexing as `orders.courierIndex` / `settings.routing.couriers[]` |
| `createdAt` | `timestamp DEFAULT now()` | |

**Constraints:**

- `UNIQUE (tenantId, date, accountId)` — one leg per account per day (an account can't be
  two legs at once).
- `UNIQUE (tenantId, date, legIndex)` — one account per leg per day (a leg can't have two
  drivers).
- Both are hard DB constraints, not app-level checks, so concurrent board edits can't
  double-book (same lesson as the `users_tenant_courier_index_uniq` fast-follow).

**Indexing:** the two unique constraints already cover the hot read path (`WHERE
tenantId=? AND date=?`), so no additional index is required for v1.

**`accountId` is deliberately untyped by role.** A row works identically whether
`accountId` points at a `role='driver'` login or the tenant's own `role='admin'` login.
No `accountRole` column: the caller always knows which table/role it's joining from
context (the board lists the driver roster + the owner explicitly; leg resolution looks
the caller's own `userId` up directly). Adding a role discriminator would be redundant
denormalization.

**Hand-written migration** (per `packages/CLAUDE.md`): `CREATE TABLE
route_courier_assignments (...)` with the two `UNIQUE` constraints inline, plus the
matching gapless journal entry. Drizzle schema in `packages/db/src/schema.ts` mirrors it
(camelCase `routeCourierAssignments`, `legIndex` etc.).

### 1.2 Interaction with the `deliverySlots` leftJoin contract

`routeCourierAssignments` is **not itself a scheduling-status source** — it says who
drives, not when an order is scheduled. So the table does NOT need the `leftJoin(deliverySlots)`
treatment that `scheduledForDay/Range` require. Confirmed against
`order-scheduling.ts`. The one place the contract still applies: leg resolution joins
assignments to *orders* by date, and those order queries continue to obey the existing
`leftJoin(deliverySlots)` rule for the `deliverySlots.date` reference — the new table
just adds a second join keyed on the same `date` string, it does not relax the existing
one.

### 1.3 Retiring `users.courierIndex` from auth (staged, NOT a big-bang)

Sequenced explicitly to avoid one risky migration:

1. **This feature's first migration** adds `routeCourierAssignments` and switches every
   reader (auth + endpoints, section 3) off `users.courierIndex`. The column stays in
   place, still written by the (now-relocated) grant flow if convenient, but **nothing in
   the authorization path reads it anymore.**
2. **A later follow-up migration** (its own PR, after this feature is proven in prod)
   drops `users.courier_index` and removes `users_tenant_courier_index_uniq`. This is
   called out here as a tracked follow-up step, not part of this feature's first
   migration.

## 2. Courier-account creation moves to super-admin

### 2.1 Server — relocate the grant/revoke/list surface to a platform controller

Move the CRUD out of the tenant-facing `routing.controller.ts` into a platform-only
controller. The existing `CourierAccessService` logic is reusable almost verbatim; only
the *guarding and the tenant-id source* change.

- **New controller** (e.g. `admin`-scoped in the platform module, or a new
  `platform-courier` controller), guarded with `@UseGuards(PlatformAdminGuard)` — the
  same guard `platform.controller.ts` uses — so ONLY `type:'platform'` sessions reach it.
  Endpoints take the target `tenantId` as a **route/body param** (a super-admin is not
  tenant-scoped), e.g.:
  - `GET  /platform/tenants/:tenantId/courier-access` → list
  - `POST /platform/tenants/:tenantId/courier-access { email }` → grant/re-invite
  - `DELETE /platform/tenants/:tenantId/courier-access/:accountId` → revoke
  (Exact base path to match sibling platform routes; the point is the guard and the
  explicit tenantId, not the string.)
- **Delete the tenant-panel copies** in `routing.controller.ts` (`GET/POST /orders/route/courier-access`,
  `DELETE .../:index`) so the farmer can no longer create/revoke accounts. Keep the
  service; re-point it.
- **Grant semantics change with the new model.** Because a login is no longer welded to a
  leg, `grantAccess` should stop requiring/consuming a `courierIndex` — it provisions a
  `role='driver'` login for the tenant (normalized email, collision check, argon2 random
  hash, `mustChangePassword`, set-password invite mail), and leg assignment happens later
  on the board. If keeping `users.courierIndex` populated during the staged retirement
  (section 1.3) is convenient, assign the next free index purely as a legacy stopgap; it
  is not authoritative and can be nulled once the column is dropped.

### 2.2 The 'admin' naming collision — flagged as a real bug risk

**This is the sharpest edge in the whole feature.** Two unrelated concepts share the
word "admin":

- **TenantRole `'admin'`** — the tenant *owner* (farmer/farm-admin) logging into the
  client panel. Enforced by `TenantRolesGuard` + `@Roles('admin')` on tenant routes.
- **Platform session `type:'platform'`** — the actual super-admin of the whole platform,
  logging into the `admin` app. Enforced by `PlatformAdminGuard`.

They are **NOT the same principal and NOT the same guard.** The prior branch's
courier-access endpoints are `@Roles('admin')` — i.e. any tenant owner. This feature
moves creation to super-admin, so the new controller MUST use `PlatformAdminGuard`, NOT
`@Roles('admin')`. Reusing `@Roles('admin')` here would silently re-grant the capability
to every farmer — the exact thing we're removing. The implementation plan must call this
out at the controller and never let the two guards be swapped.

### 2.3 Admin app — new "Куриери" section

In `admin/src/app/(panel)/tenants/[id]/` (via `tenant-detail-client.tsx`), add a
"Куриери" section that lists this tenant's driver logins and offers invite / resend /
revoke — mirroring `CourierHomesModal`'s UX but in the admin console, calling the new
`/platform/tenants/:tenantId/courier-access` endpoints. Because accounts are no longer
per-leg, the list is a flat roster (email + invite-pending status), not a per-leg grid.

### 2.4 Farmer panel — `CourierHomesModal` becomes read-only

`client/src/components/route/courier-homes-modal.tsx` loses its invite/resend/revoke
actions entirely and becomes a **read-only roster** — just the list of the tenant's
courier accounts so the farmer knows who exists to assign on the board.

**Decision — where the read comes from:** add a **new farmer-reachable, read-only list
endpoint** on the tenant side (e.g. `GET /orders/route/couriers`, `@Roles('admin')`)
returning `{ accountId, email }[]` for the tenant's `role='driver'` logins. Justification
for a new endpoint rather than relaxing the platform one: the platform `listAccess`
endpoint is now behind `PlatformAdminGuard` and takes an explicit `tenantId` param — a
farmer session can't call it and shouldn't be able to (it would be a cross-tenant
foot-gun). A dedicated tenant-scoped read, returning only non-sensitive fields (no
password/hash, no tokenVersion), keeps the farmer's roster strictly within their own
tenant via the existing `@CurrentTenant()` scoping. This same endpoint feeds the
assignment board (section 4).

## 3. Leg resolution — the hard part

Today, "my leg" = `user.courierIndex`, injected once per request by the JWT strategy,
**not keyed by any date.** Leg assignment is now inherently date-scoped
(`routeCourierAssignments` keyed on `(tenantId, date, accountId)`), so this global,
date-less injection can no longer answer "which leg am I on?" — the answer depends on the
`date` the request is asking about.

### 3.1 The JWT strategy stops resolving the leg

- `jwt.strategy.ts:53-73` **stops reading/injecting `courierIndex`.** It keeps the
  tokenVersion re-select (that's still needed for revocation), but drops the
  `courierIndex` selection and the `...(user.courierIndex != null ? {courierIndex} : {})`
  spread. `TenantRequestUser.courierIndex` becomes unused for auth (may be removed from
  the type in the follow-up that drops the column; leave it typed-optional during the
  staged retirement to avoid churn).
- **Rationale:** the strategy has no `date` in scope — it runs before the route handler
  and its params. Leg ownership is now a per-request, per-date question and must be
  resolved where the `date` is known: inside each endpoint (or a shared helper it calls).

### 3.2 New resolution helper (date-scoped, per-request)

Add a helper on the routing/courier-access service, e.g.:

```
resolveMyLeg(tenantId, accountId /* = user.userId */, date): Promise<number | null>
```

It selects `legIndex` from `routeCourierAssignments` WHERE `(tenantId, date, accountId)`.
Returns `null` when there's no row — meaning "not assigned on this date." Each
driver-scoped endpoint calls this with the request's `date` param and the caller's
`user.userId` (NOT `user.courierIndex`).

### 3.3 Endpoints that must change

Every check currently trusting `user.courierIndex` is re-pointed at `resolveMyLeg(...,
date)`:

- **`GET /orders/route`** (`routing.service.getRoute`, controller line 50-52) — the
  filter that narrows a driver to their own leg must resolve the leg from the request's
  `date` (the route page is always viewing a specific day) instead of `user.courierIndex`.
  A driver with no assignment for that date → treated as "not assigned today" (see 3.4).
- **`POST /orders/route/measure`** (controller line 118-120) — already carries the
  IDOR-fix from the prior branch that scopes a driver's `stopIds` to their own leg
  (commit `51baa66`). That leg must now come from `resolveMyLeg(..., date)` for the
  measured day, not `user.courierIndex`. Extend the existing pattern; do not add a
  parallel one.
- **Order finish / undo** — `PATCH /orders/:id/status` (`orders.controller.ts:149-158`,
  driver path routes to `ordersService.updateStatusForCourier`). The driver may only
  finish/undo stops on **their** leg for that order's delivery day; the leg check must go
  through `resolveMyLeg` keyed on the order's scheduled date.
- **`GET /orders/:id`** (OrderPanel, `orders.controller.ts:136-140`) — currently
  tenant-scoped only, with an explicit comment that there is "no ownership-narrowing
  beyond tenant."

### 3.4 Hard dependency on fast-follow `task_a04caefa` (ordering constraint, not a footnote)

A parallel background task (`task_a04caefa`) is **right now** adding leg-ownership checks
to `orders.findOne` (`GET /orders/:id`) and `updateStatusForCourier`. As of spec-writing
those checks are **not yet in the working tree** — `orders.controller.ts:134-135` still
reads "Tenant-scoping alone ... is sufficient here; no ownership-narrowing beyond tenant
for this read." That task will introduce the leg-ownership pattern these two endpoints
use.

**This feature MUST build on top of whatever pattern `task_a04caefa` lands, not
duplicate or conflict with it.** Concretely: when `task_a04caefa` merges, its
leg-ownership check will read `user.courierIndex`; this feature then *replaces the source
of that check* with `resolveMyLeg(..., date)` in the same call sites. That means this
feature cannot start on those two endpoints until `task_a04caefa` is on `main` (see
section 7). Treat it as a blocking predecessor.

### 3.5 "Not assigned today" behavior

When `resolveMyLeg` returns `null` for the requested date, endpoints do NOT error — they
return an empty/"no route for you today" result:

- `GET /orders/route` → `{ ...res, routes: [] }` (empty legs; the client renders a
  friendly "нямаш маршрут за днес" state).
- `POST /orders/route/measure` → empty/no-op (no stops belong to a null leg).
- finish/undo and `GET /orders/:id` → 403/404-style deny for stops not on an assigned
  leg (a driver with no assignment owns no stops that day).

### 3.6 Order-pinning is NOT touched (explicit anti-conflation)

`orders.courierIndex` (the per-order pin set by `setOrderCourier`, `routing.service.ts:1012`)
and the driver-**account**'s leg are two different things:

- `orders.courierIndex` = "this *stop* belongs to leg N" (organizer decision about an
  order).
- `routeCourierAssignments.legIndex` = "this *account* drives leg N today" (who's behind
  the wheel).

`getRoute` keeps splitting only the `free` (unpinned) orders via `sweepSplit`; pinned
stops keep their pin. This feature changes only *which leg a driver is authorized to see*,
never how stops are assigned to legs. Do not merge the two `courierIndex` concepts.

## 4. Assignment board UI (farmer panel, route page)

A new component **alongside** (not replacing) the existing couriers-count dropdown in
`client/src/components/route/route-client.tsx`.

### 4.1 Behavior

- **Scope:** the currently selected route date only (no recurring/weekly view — YAGNI,
  section 6).
- **Rows:** all courier accounts for the tenant (driver roster from the new read-only
  `GET /orders/route/couriers` endpoint, section 2.4) **plus the farmer's own account**,
  always present as a selectable entry (labelled e.g. "Аз (собствена доставка)").
- **Per row:** assign to a leg number `0..N` or "не участва днес" (unassigned). Writes go
  to `routeCourierAssignments` for that date via new endpoints:
  - `GET /orders/route/assignments?date=YYYY-MM-DD` → `{ accountId, legIndex }[]`
  - `PUT /orders/route/assignments { date, assignments: [{accountId, legIndex}] }` (or
    per-row `POST`/`DELETE`) — `@Roles('admin')`, tenant-scoped. Server enforces the two
    unique constraints; a double-book returns a clear 409 the UI surfaces inline.
- **Immediate persistence**, matching the panel's existing modal patterns.

### 4.2 Precedence: board vs. the couriers-count dropdown

Explicit rule (removes ambiguity):

- **Zero assignments for the selected date** → route page behaves EXACTLY as today: the
  couriers-count dropdown + auto-split (`effectiveCourierCount` → `sweepSplit`) are live,
  unchanged.
- **One or more assignments for the date** → the assignments define the day. Leg count =
  the number of distinct assigned legs; the couriers-count dropdown becomes **read-only /
  hidden** for that day (it no longer drives the split — the board does). `sweepSplit`
  distributes the `free`/unpinned orders across exactly the assigned legs.

This keeps the dropdown as the zero-config fast path and the board as the explicit
override, with no state where both silently fight over the leg count.

### 4.3 4-surface driver-chrome contract

If assignment state changes what a driver sees (e.g. an unassigned driver logging in and
finding no route), the driver-facing gating must stay consistent across ALL FOUR
surfaces — `client/src/middleware.ts`, `driver-route-guard.tsx`, `sidebar.tsx`,
`topbar.tsx` — per the known recurring gotcha. Specifically: an authenticated driver with
no assignment for today still lands on `/route` and sees the friendly empty state
(section 3.5); they are NOT bounced out of the panel and NOT shown organizer chrome. Any
change to what the driver route renders must be reflected in all four surfaces in the
same change.

## 5. Testing (TDD)

- **Migration / schema:** `routeCourierAssignments` table exists with both unique
  constraints; a duplicate `(tenantId, date, accountId)` and a duplicate `(tenantId,
  date, legIndex)` each raise a DB constraint error (not a silent overwrite).
- **`resolveMyLeg` (server unit):** returns the assigned `legIndex` for `(tenant, date,
  account)`; returns `null` for a date with no row; is correctly date-scoped (same
  account, two dates, two different legs → each date resolves independently).
- **`GET /orders/route` (driver):** driver assigned leg 1 on date X sees only leg 1's
  stops + money; other legs absent; driver with NO assignment for X → `routes: []`. Same
  driver on date Y (assigned leg 0) sees leg 0 — proving the resolution is date-keyed and
  not frozen.
- **`route/measure` (driver):** stopIds outside the resolved leg for the measured date
  are rejected (extends the prior branch's IDOR test, `51baa66`).
- **Finish/undo + `GET /orders/:id`:** driver can only act on their assigned leg's
  orders for that day; unassigned → denied. (Layered on top of `task_a04caefa`'s pattern
  — write these once that task's shape is on `main`.)
- **Platform courier CRUD:** a `type:'platform'` session can grant/revoke for an
  explicit tenant; a tenant `@Roles('admin')` session is rejected by `PlatformAdminGuard`
  (guards the naming-collision regression from section 2.2).
- **Farmer read-only roster:** `GET /orders/route/couriers` returns the tenant's drivers
  with no sensitive fields, scoped to the caller's tenant; a farmer cannot reach the
  platform CRUD.
- **Board precedence:** zero assignments → dropdown/auto-split path; ≥1 assignment → leg
  count = assigned legs, dropdown inert; double-book → 409.
- **Client:** browser-verify both roles — farmer assigns couriers to legs for a day, a
  driver logs in and sees exactly their assigned leg (and the empty state when
  unassigned); admin unchanged on zero-assignment days.

## 6. Scope (YAGNI)

**In v1:**
- `routeCourierAssignments` per-date board; super-admin account creation; read-only
  farmer roster; date-scoped leg resolution; the farmer's own account assignable.

**Explicitly OUT (revisitable later):**
- **No recurring/weekly assignment default.** Each day is set independently. A "copy
  yesterday" / weekly template is a future nicety, not v1.
- **No `accountRole` discriminator column** on the assignment table (section 1.1).
- **No dropping of `users.courier_index` in this feature's first migration** — that's the
  staged follow-up (section 1.3).
- No per-leg capacity/limits, no auto-assignment/optimization of accounts to legs (the
  farmer assigns manually).

## 7. Sequencing & preconditions + migration numbering

### 7.1 Hard precondition — cut this branch only after the predecessors merge

This feature is a NEW branch off `main`, created **only after** ALL of the following are
merged to `main`:

- `feat/routes-courier-reminder` (the branch this extends).
- `task_a04caefa` — orders leg-ownership checks on `findOne` / `updateStatusForCourier`
  (**hard dependency**, section 3.4 — this feature re-points the exact checks that task
  introduces).
- `task_ad76feca` — tenants/me billing-field stripping (touches
  `tenants.controller.ts` / `tenants.service.ts`).
- `task_a954f6ec` — grantAccess race / `users_tenant_courier_index_uniq` fix (touches
  `courier-access.service.ts` + `users` schema + migration `0108`).

This feature's data-model and endpoint changes edit the same files those tasks are
mutating (`courier-access.service.ts`, `users` schema, `orders.controller.ts`). Working
concurrently would guarantee conflicts. **This is a precondition, not a nice-to-have** —
do not start the branch until `git log main` shows all four landed.

### 7.2 Migration numbering — describe the rule, don't hardcode

At spec-writing time the journal (`packages/db/drizzle/meta/_journal.json`) tail is **idx
106, tag `0108_users_courier_index_uniq`** — and that migration is still UNCOMMITTED in
the working tree (fast-follow `task_a954f6ec` is landing it). Because the three
fast-follows may each add migrations before this branch is cut, **do not hardcode a
number.** The rule:

> This feature's first migration is the **next gapless index after whatever the
> fast-follows have landed on `main`**. Check `_journal.json` on the freshly-cut branch:
> if the highest is `0108` (idx 106), this feature's table migration is `0109` (idx 107);
> if a fast-follow already claimed `0109`, use `0110`; and so on. The `users.courier_index`
> DROP is a *later* migration again (section 1.3), numbered when that follow-up PR is
> written.

Journal discipline per `packages/CLAUDE.md`: gapless `idx`, `version:"7"`, a `when`
epoch-ms, `tag` = filename without `.sql`. A gap silently breaks the migrator.

### 7.3 Deploy note

Push to `main` auto-deploys Hetzner; the migrator runs before app images. The staged
column-drop (section 1.3) must deploy *after* this feature is live and confirmed reading
from `routeCourierAssignments`, or the deploy would drop a column the still-running old
image reads. Backend-first ordering (per root `CLAUDE.md` gotcha #10) applies.

## Open items for implementation planning

- Confirm the final base path for the platform courier controller against sibling
  platform routes (`/platform/tenants/:tenantId/...` vs the module's existing convention).
- Decide `PUT` whole-board vs. per-row `POST`/`DELETE` for the assignment endpoint (4.1)
  — either is fine; pick one in the plan and keep the 409-on-double-book behavior.
- When `task_a04caefa` lands, read its exact leg-ownership helper shape before writing
  the finish/undo + `GET /orders/:id` changes so this feature extends rather than forks it.
