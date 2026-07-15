# Routes: add-orders, courier account, reminder day opt-out + test campaigns — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Farmer admin can add orders onto a day's delivery route; (2) a courier ("доставчик") gets a restricted login that sees ONLY their own route; (3) per-day checkbox to suppress the day-of reminder email + prod activation so tomorrow 08:00 the range email fires; (4) hard test campaigns for slot generation and 2-courier optimization / manual freedom.

**Architecture:** Routes are DERIVED — no routes table. A stop = a confirmed `deliveryType='address'` order scheduled for the day; persisted route state lives on `orders.course_index` (courier pin) + `orders.route_seq` (manual order). "Add order to route" therefore = reschedule the order to the day (existing `POST /orders/reschedule`) + optional courier pin (existing `PATCH /orders/route/order/:id/courier`). Courier account reuses the ALREADY-DECLARED-but-unused `driver` value in `user_role` enum, bound to a courier slot via new `users.courier_index`; server filters `getRoute` to their leg; client gets a 4-surface driver allow-list mirroring the farmer pattern. Reminder day opt-out = new `delivery_slots.reminder_opt_out` boolean — the reminder query already leftJoins `delivery_slots`, so the filter is one line.

**Tech Stack:** NestJS (`server/`), Next.js App Router (`client/`), Drizzle + hand-written migrations (`packages/db/drizzle/`), Jest (server), vitest (client unit).

## Global Constraints

- Migrations are HAND-WRITTEN in `packages/db/drizzle/NNNN_*.sql` + journal entry in `packages/db/drizzle/meta/_journal.json` (idx must be gapless — a gap silently breaks the migrator). Next free: **0106** (last = 0105, idx 103).
- Any query using `scheduledForDay/Range` MUST `leftJoin(deliverySlots)`; UPDATEs use id-subselect instead.
- Push to `main` auto-deploys Hetzner (migrator runs before app images). Do NOT push until final gates pass.
- All client → API traffic via `/bff` proxy. All dates Europe/Sofia (`bgToday()`).
- Server route access is default-deny (`TenantRolesGuard`, default `['admin']`); every endpoint a driver may hit needs explicit `@Roles(...)`.
- Client 4-surface contract when touching role routing: `client/src/middleware.ts` (PROTECTED + matcher + allow-lists), `farmer-route-guard.tsx` (mirror list), `topbar.tsx` PAGE_TITLES, `sidebar.tsx` NAV.
- Optional string DTOs: `@IsOptional()` doesn't coerce `''`→`undefined`; add `@Transform` when relevant.
- UI copy in Bulgarian, matches existing panel tone (informal „ти").

---

## Workstream A — Per-day reminder opt-out + prod email test

### Task A1: Migration 0106 + schema + reminder filter (server, TDD)

**Files:**
- Create: `packages/db/drizzle/0106_slot_reminder_opt_out.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` (append idx 104)
- Modify: `packages/db/src/schema.ts` (deliverySlots table, ~line 361-390)
- Modify: `server/src/modules/sms-reminder/sms-reminder.service.ts` (sendForTenant where-clause)
- Modify: `server/src/modules/slots/dto/create-slot.dto.ts` (+`reminderOptOut?: boolean`; UpdateSlotDto inherits via PartialType)
- Modify: `server/src/modules/slots/slots.service.ts` (`create`/`update` pass the flag through; the findAll projection returns it)
- Test: `server/src/modules/sms-reminder/sms-reminder.service.spec.ts` (extend existing spec)

**Interfaces:**
- Produces: `deliverySlots.reminderOptOut: boolean` (drizzle camelCase for `reminder_opt_out`), surfaced on slot list rows as `reminderOptOut`, PATCHable via existing `PATCH /slots/:id` body `{ reminderOptOut: boolean }`.

- [ ] **Step 1: failing test** — extend the sms-reminder spec: an order whose slot has `reminderOptOut=true` is NOT selected/sent; a slotless order (NULL join) still IS sent.
- [ ] **Step 2: run test → FAIL** (`pnpm --filter @fermeribg/api test -- sms-reminder`).
- [ ] **Step 3: implement**

```sql
-- 0106_slot_reminder_opt_out.sql
ALTER TABLE "delivery_slots" ADD COLUMN IF NOT EXISTS "reminder_opt_out" boolean NOT NULL DEFAULT false;
```

Journal append (idx 104, when: 1784300000000, tag `0106_slot_reminder_opt_out`).

`schema.ts` (inside deliverySlots): `reminderOptOut: boolean('reminder_opt_out').notNull().default(false),`

`sms-reminder.service.ts` where-clause add:
```ts
// Day-level opt-out lives on the slot row; slotless orders (NULL) still remind.
or(isNull(deliverySlots.reminderOptOut), eq(deliverySlots.reminderOptOut, false)),
```

DTO add:
```ts
@ApiPropertyOptional({ description: 'Не изпращай имейл „доставка днес" за този ден.' })
@IsOptional()
@IsBoolean()
reminderOptOut?: boolean;
```
Wire through `slots.service.ts` create/update `.values`/`.set` and the findAll select.

- [ ] **Step 4: tests pass** (sms-reminder + slots suites).
- [ ] **Step 5: commit** `feat(server): per-day reminder opt-out flag on delivery slots (migr 0106)`

### Task A2: Client UI for the day checkbox (2 surfaces)

**Files:**
- Modify: `client/src/components/route/delivery-windows-modal.tsx` — checkbox „Изпрати напомняне по имейл в деня на доставката" (checked = send; unchecked writes `reminderOptOut: true`), shown for the modal's day, persisted immediately via `updateSlot(slotId, { reminderOptOut })`. Needs the day's slot id → extend the route page's data or fetch `GET /slots` and match by date (slots list is small).
- Modify: `client/src/components/slots/slots-client.tsx` (+ day row/dialog component it uses, `add-slot-dialog.tsx`) — same toggle per day („Напомняне в деня") with a muted „изкл." badge when opted out.
- Modify: `client/src/lib/api-client.ts` — extend the slot types with `reminderOptOut`.
- Test: existing client unit patterns (`*.test.ts`) for any extracted pure helper; otherwise browser-verify.

**UX decision (asked to think about placement):** primary surface = the *delivery-windows modal on the route page* — that's where the operator is the evening before, approving windows; the checkbox answers exactly the question they're deciding there. Secondary mirror = the Слотове day grid so the state is discoverable/editable independent of routes. Tenant-wide master toggle stays where it is (Настройки → Доставка, `sms-reminder-card.tsx`).

- [ ] Implement both surfaces; when the day has NO slot row (slotless legacy day) hide the checkbox (rule-generated days always have a row).
- [ ] Browser-verify in dev (preview): toggle in windows modal → PATCH fires → slots page reflects; toggle back on slots page → modal reflects.
- [ ] Commit `feat(client): per-day reminder opt-out checkbox (windows modal + slots grid)`

### Task A3: Dev end-to-end reminder verification + prod activation prep

- [ ] Dev: seed/адаптирай order for today with approved window; run `POST /sms-reminder/run` (guarded, tenant from JWT) → email dispatched (check mail log / Ethereal), claim set; re-run → 0 sent (idempotent); flip day opt-out → run on fresh order → skipped.
- [ ] Verify cron registration path (`RUN_WORKERS`) unchanged.
- [ ] Write prod activation checklist for TOMORROW (2026-07-16): (1) deploy contains this branch; (2) tenant toggle „Напомняне в деня на доставка" = ON (Настройки → Доставка); (3) вечерта: маршрут за 16.07 → генерирай + одобри прозорци; (4) 08:00 cron sends; verify in `sms_log`/mail provider + `delivery_window_sms_at` set. NOTE: manual `POST /sms-reminder/run` on prod would email REAL customers — only do after explicit go.

---

## Workstream B — „Добави поръчки" on the route page

### Task B1: Add-orders modal (client-only; server endpoints exist)

**Files:**
- Create: `client/src/components/route/add-orders-modal.tsx`
- Modify: `client/src/components/route/route-client.tsx` — toolbar button „Добави поръчки" (admin only), next to „Предложи по дни".
- Modify: `client/src/lib/api-client.ts` — reuse `listReschedulable()` + `rescheduleOrders()` (exist; suggester uses them) + `setOrderCourier()`.

**Interfaces:**
- Consumes: `GET /orders/reschedulable` → `{ id, orderNumber, customerName, customerPhone, totalStotinki, status, slotDate, deliveryLat, deliveryLng }[]` (pending+confirmed address orders, any day, innerJoin slot). `POST /orders/reschedule { orderIds, toDate }` (moves + emails buyers the new date). `PATCH /orders/route/order/:id/courier { courierIndex }`.

**Behaviour:**
- Modal lists candidates whose `slotDate !== routeDate`, grouped by date („днес", „16.07", …), checkbox per order, shows име/№/сума/статус; ⚠️ badge „чака потвърждение" for pending (pending orders reschedule fine but only CONFIRMED ones appear on the route — modal says this inline).
- Courier select (only when `courierCount > 1`): „Автоматично" (default) or Куриер 1..N (preselect active tab).
- Apply: `rescheduleOrders(ids, routeDate)` → if courier picked, `setOrderCourier(id, idx)` per order → toast „Добавени N поръчки към <date>" → `router.refresh()`.
- Inline note that customers получават имейл за новата дата (rescheduleOrders emails buyers — deliberate, existing behaviour).

- [ ] Unit-test the pure grouping/filter helper (extract `partitionCandidates(rows, routeDate)` into `add-orders.ts`, vitest).
- [ ] Implement modal + wire button.
- [ ] Browser-verify: order from day X appears, add to day Y courier 2 → lands pinned on courier 2 tab.
- [ ] Commit `feat(client): add orders onto a route day (reschedule + courier pin)`

---

## Workstream C — Courier (driver) account: sees only their route

### Task C1: Migration 0107 + users.courierIndex + JWT plumbing (server)

**Files:**
- Create: `packages/db/drizzle/0107_user_courier_index.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` (idx 105)
- Modify: `packages/db/src/schema.ts` users table (+`courierIndex: smallint('courier_index')`)
- Modify: `packages/types/src/index.ts` — `JwtPayload` + `TenantRequestUser` get `courierIndex?: number | null`
- Modify: `server/src/modules/auth/jwt.strategy.ts` — return `courierIndex` fresh from the DB row it already loads for the tokenVersion check (no token staleness on rebind)
- Modify: `server/src/modules/auth/auth.service.ts` `sign()` — embed `courierIndex` (informational; the strategy's DB read is authoritative)

```sql
-- 0107_user_courier_index.sql
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "courier_index" smallint;
```

- [ ] TDD on jwt.strategy: driver user row with courier_index=1 → request user carries courierIndex 1.
- [ ] Commit `feat(server): users.courier_index + driver JWT plumbing (migr 0107)`

### Task C2: Courier access grant/revoke/list endpoints (server, admin-only)

**Files:**
- Create: `server/src/modules/routing/courier-access.service.ts`
- Modify: `server/src/modules/routing/routing.controller.ts` + `routing.module.ts`
- Create: `server/src/modules/routing/dto/courier-access.dto.ts`
- Test: `server/src/modules/routing/courier-access.service.spec.ts`

**Interfaces (mirror `farmers.service.grantAccess` exactly — normalized email, collision check, argon2 random hash, `mustChangePassword: true`, invite mail via `auth.sendFarmerInvite`-style set-password link; check that helper's copy — if farmer-specific, add a generic `sendUserInvite`):**
- `GET /orders/route/courier-access` → `{ courierIndex, email, invitePending }[]`
- `POST /orders/route/courier-access { courierIndex: 0..9, email }` → grant/re-invite (upsert on (tenantId, role='driver', courierIndex))
- `DELETE /orders/route/courier-access/:index` → revoke (tokenVersion bump + delete, null FK refs first — copy `revokeAccess` transaction)

- [ ] TDD: grant creates driver user bound to index; regrant updates email + bumps tv; revoke deletes + bumps; email collision → 409; index ≥ 10 → 400.
- [ ] Commit `feat(server): courier access grant/revoke/list (driver accounts)`

### Task C3: Driver-scoped route access (server)

**Files:**
- Modify: `server/src/modules/routing/routing.controller.ts`:
  - `GET /orders/route`: `@Roles('admin','driver')`; inject `@CurrentUser()`; when `role==='driver'` → ignore `couriers`/`ends` query, use tenant defaults, then filter result: `{ ...res, routes: res.routes.filter(r => r.courierIndex === user.courierIndex) }`. Driver with null/out-of-range index → `routes: []`.
  - `POST /orders/route/measure`: `@Roles('admin','driver')`; when driver, force `dto.courierIndex = user.courierIndex`.
- Modify: `server/src/modules/orders/orders.controller.ts`:
  - `PATCH /orders/:id/status`: add `'driver'` to `@Roles`; when driver, only `status ∈ {'delivered','confirmed'}` allowed (finish + undo), else 403.
  - `GET /orders/:id` (OrderPanel): add `'driver'` to `@Roles` (same-tenant scoping already enforced by service).
- Test: routing controller/service spec — driver sees exactly own leg; other legs' stops+money absent; forbidden statuses 403.

- [ ] TDD then implement; run full routing + orders suites.
- [ ] Commit `feat(server): driver role sees only own route leg; finish/undo scoped`

### Task C4: Client driver surfaces (4-surface contract + login bounce)

**Files:**
- Modify: `client/src/middleware.ts` — add `DRIVER_ALLOWED = ['/route', '/help']`; role-aware bounce: farmer→`/stats`, driver→`/route`.
- Modify: `client/src/components/layout/farmer-route-guard.tsx` → generalize to `role-route-guard.tsx` (props: role) OR add parallel `DriverRouteGuard`; mount in `admin-shell.tsx` when `role==='driver'`.
- Modify: `client/src/components/layout/sidebar.tsx` — `DRIVER_NAV = [Маршрут(/route), Помощ(/help)]`, branch `role==='driver'`.
- `topbar.tsx` PAGE_TITLES — `/route` already titled „Маршрут" (no change; verify).
- Login redirect: authed driver on `/login`/`/dashboard` lands `/route` (middleware handles via bounce).

- [ ] Implement; `next build` green.
- [ ] Commit `feat(client): driver role surfaces (route-only panel)`

### Task C5: Route page driver mode + courier-access UI

**Files:**
- Modify: `client/src/components/route/route-client.tsx` — consume role from `RoleProvider`; when driver HIDE: „Предложи по дни", windows modal button, couriers count select, end-mode select, courier-homes modal, „Добави поръчки", per-stop „Куриер" move-select, reorder modal. KEEP: stop list, map, Waze/Google links, „Поръчка" panel, „Готово" finish + undo, „Завърших доставките".
- Modify: `client/src/components/route/courier-homes-modal.tsx` — per-courier row gains „Акаунт за куриера": email input + „Покани" / „Премахни достъп" (calls the C2 endpoints), status line (има акаунт / поканен).
- Modify: `client/src/lib/api-client.ts` — `listCourierAccess/grantCourierAccess/revokeCourierAccess` wrappers.

- [ ] Implement; browser-verify BOTH roles: admin unchanged; driver login → lands /route → sees exactly one leg, no admin controls; „Готово" + „Отмени" work.
- [ ] Commit `feat(client): driver route view + courier account management UI`

---

## Workstream D — Test campaigns

### Task D1: Slot generation battery

- [ ] Unit tests (extend `slot-rule`/slots specs): weekday rule across month boundary; interval mode anchored in past; `skipDates` excluded; horizon top-up idempotence (`lastMaterializedDate` guard + force); dup-day suppression (manual row beats rule row); one-row-per-(tenant,date) enforcement; DST transition dates 2026-03-29 / 2026-10-25 produce correct Sofia dates; bulk `expandDates` weekday filter.
- [ ] Browser (dev): configure weekday rule → grid materializes; edit capacity of booked day (regression: kept-row update, no 400); close/open day; verify public picker floor (no past days).
- [ ] Fix anything found (each fix = its own TDD commit).

### Task D2: 2-courier optimization + organizer freedom battery

- [ ] Browser (dev, seeded geocoded orders, couriers=2): route splits into 2 tabs; per-tab money; move stop Куриер 1→2 via select → persists across refresh + `getRoute` honours pin; reorder within leg → `route_seq` persists, no re-optimize; suggest-days with different per-day courier counts → apply → orders land on days; windows generate with 2 couriers → per-leg windows sane; add-orders modal (B1) pins to chosen courier.
- [ ] Server unit tests where gaps: `setOrderCourier` out-of-range index → auto; pinned stop bypasses sweepSplit; sequence for one courier doesn't disturb other leg.
- [ ] Fix anything found.

---

## Ship

- [ ] Gates: `pnpm --filter @fermeribg/api test` full green; client `pnpm --filter @fermeribg/web build` + unit; `pnpm lint`; `tsc`.
- [ ] Code review pass on full diff (correctness + the two new migrations + security: driver scoping, courier-access IDOR, DTO whitelisting).
- [ ] Merge branch → main, push (auto-deploy; migrator runs 0106+0107 first).
- [ ] Prod: flip tenant „Напомняне в деня на доставка" ON; evening: одобри прозорци за 16.07; tomorrow 08:00 verify email received + `sms_log`.
