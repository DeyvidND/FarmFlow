# Spec — Farmer (producer) sub-account logins + personal turnover

**Date:** 2026-06-14
**Repos touched:** `FarmFlow` (`server`, `client`, `packages/db`, `packages/types`)
**Status:** approved design, ready for implementation plan
**First implementation plan covers:** Phase 1 (foundation) + Phase 2 (stats) — the
literal "a producer logs in and sees their own turnover" end-to-end. Phases 3–4
(orders, own-products editing) are specified at lower detail for follow-on plans.

## Terminology (disambiguation — read first)

This codebase already overloads the word "farmer":

- **Tenant owner** — the `users` row with `role='admin'`; one per tenant. Runs the
  whole shop. The 2026-06-03 spec called *this* "the farmer" (one farm = one tenant).
- **Producer / vendor** — a `farmers` catalog row (name, bio, photo, email) inside a
  multi-farmer shop (`tenants.multi_farmer = true`). Today these have **no login**;
  they are display + product-attribution entities only. Products link to a producer
  via `products.farmer_id`.

**This spec adds a login for the second kind** — a scoped sub-account, one per
`farmers` row, that sees and manages only that producer's own data. The 2026-06-03
spec listed exactly this under "Out of scope"; we are now building it. Throughout
this document **"farmer" means a producer sub-account** (`role='farmer'`), never the
tenant owner.

## Goal

In a multi-farmer shop, each producer can log in and see **their personal turnover**
(оборот) — and, ultimately, manage their own corner of the shop:

1. Owner invites a producer to get a login (email invite → set-password link).
2. Producer logs into the same admin app, scoped to **only their own** data.
3. Producer sees their personal turnover/stats (revenue, orders, top products,
   trend) — attributed by line item, not whole order.
4. (Later phases) Producer sees their own orders and edits their own products.
5. Owner can also filter the stats screen by producer ("Фермер: Всички / X / Y").

## Current state (verified 2026-06-14)

- `users`: `{ id, tenant_id, email (unique), password_hash (argon2), role,
  must_change_password, token_version, hidden_nav, created_at }`. Role enum
  `user_role = ['admin','driver','customer']`. Owner = `role='admin'`.
- `farmers`: `{ id, tenant_id, name, role, bio, phone, email, ... }`. No account.
- `products.farmer_id uuid → farmers.id ON DELETE SET NULL`. Nullable (a product may
  have no producer).
- `order_items`: `{ id, order_id, product_id → products.id, product_name, quantity,
  price_stotinki }`. **No `farmer_id`** — producer attribution must join through
  `products.farmer_id`.
- `orders`: carries `total_stotinki` (whole order incl. delivery + all producers),
  `payment_method ('cod'|'online')`, `status`, `customer_phone/email/id`, `created_at`.
- **Auth is already built for this extension:**
  - `JwtPayload` carries `role` + `tv` (token_version revocation epoch).
  - `TenantRolesGuard` (global, default-deny): every tenant route is `admin`-only
    unless a `@Roles(...)` decorator opens it. Its own comment says it exists to
    future-proof non-admin roles — this is the intended seam.
  - `MustChangePasswordGuard` (global): a `must_change_password` token may only do
    GETs + `POST /auth/change-password` until the password is set.
  - Password-reset flow exists: `requestPasswordReset(email)` signs a 30-min,
    single-use token (separate `::pwreset` secret, bound to the password
    fingerprint) and emails a `/reset-password?token=…` link. `resetPassword` sets
    the new password + bumps `token_version`. The client `/reset-password` page
    exists.
- Tenant stats: `GET /stats` (JWT) → `StatsService.stats(tenantId, {range,from,to})`,
  whole-tenant, computed from `orders.total_stotinki` + `order_items`. Pure helpers
  (`resolveWindow`, `pickBucket`, `buildAxis`, `computeReturning`, `fillWeekday`,
  `pickSlowProducts`) are unit-tested and reusable as-is.
- Sidebar (`client/.../layout/sidebar.tsx`): `NAV_GROUPS`; "Статистика" lives under
  the **Продажби** group at `/stats`. Nav is rendered from a static list; there is no
  role-based filtering yet.
- Latest DB migration: `0042`. **Next: `0043`** (verify before generating).

## Design

### Decisions locked in brainstorming

- **Approach A** — extend `users` with `role='farmer'` + `farmer_id`. Reuses the
  entire login/reset/JWT/guard stack. (Rejected: a parallel `farmer_users` table +
  second auth path; a magic-link read-only page — incompatible with "full
  management".)
- **Line-item attribution, current `farmer_id`, no snapshot (v1).** A producer's
  turnover = `Σ(quantity × price_stotinki)` over `order_items` joined to `products`
  filtered by `products.farmer_id`. A shared order (items from two producers) counts
  for **both**; the delivery fee is **nobody's** turnover. Attribution uses the
  product's *current* `farmer_id` — reassigning a product or deleting a producer
  moves/drops its history. Accepted limitation; a future `order_items.farmer_id`
  snapshot can fix it without changing the read API.
- **Owner may also filter** the stats screen by producer (`?farmerId=`).

---

### Phase 1 — Foundation: accounts, auth, invite/revoke

#### Data model (`packages/db`, migration `0043`)

- `ALTER TYPE user_role ADD VALUE 'farmer';`
  - **Gotcha:** Postgres `ADD VALUE` cannot run inside a transaction block on older
    servers and the new value is unusable in the *same* transaction that adds it.
    Keep it as its own migration statement; do not reference `'farmer'` in the same
    migration's later DML. Drizzle generates this from the enum change — verify the
    generated SQL isolates it.
- `users.farmer_id uuid` → `references farmers(id) ON DELETE CASCADE` (deleting a
  producer deletes its login). Nullable (owner/driver/customer rows have none).
- Partial unique index: `CREATE UNIQUE INDEX users_farmer_id_uniq ON users(farmer_id)
  WHERE farmer_id IS NOT NULL;` — at most one login per producer.

#### Types (`packages/types`)

- `TenantRole = 'admin' | 'driver' | 'customer' | 'farmer'`.
- `JwtPayload.farmerId?: string` (present only for `role='farmer'` tokens).
- `TenantRequestUser.farmerId?: string`.

#### Server auth wiring

- `auth.service.login`: select `farmer_id`; pass to `sign`. `sign` adds `farmerId` to
  the payload only when present.
- `jwt.strategy.validate`: return `farmerId` on the tenant `RequestUser`.
- New `@CurrentFarmer()` decorator → returns `req.user.farmerId`; throws
  `ForbiddenException` if absent (belt-and-braces; the route's `@Roles` already
  gates).
- **Effective-farmer resolver** (pure helper, unit-tested) used by every
  producer-scoped controller:
  - `role='farmer'` → use the token's `farmerId` (ignore any `?farmerId=` query —
    a producer can never widen scope).
  - `role='admin'` → optional `?farmerId=`; if present, validate it belongs to the
    tenant, else 400/404.

#### Provisioning (farmers module — owner-only, default `admin` role)

- `POST /farmers/:id/access { email }`:
  1. Load the producer; 404 if not in the caller's tenant.
  2. If a `users` row already has `farmer_id = :id` → treat as **re-invite**: if the
     email differs and is free, update it; resend the invite. (Email already taken by
     a *different* user → 409.)
  3. Otherwise create `users { tenant_id, farmer_id, email, role:'farmer',
     password_hash: argon2(crypto-random), must_change_password: true,
     token_version: 0 }`.
  4. Send the invite email — a new `AuthService.sendFarmerInvite(userId)` that signs
     the *same* reset token (`requestPasswordReset` logic) but with welcome copy
     ("Покана за достъп — задай си парола") pointing to `/reset-password`. Token
     logic stays in `AuthService`; `FarmersService` calls it.
- `DELETE /farmers/:id/access`: find the producer's login → bump `token_version`
  (kills active sessions immediately) → delete the row. 204.
- Admin `GET /farmers` (list/detail) includes per-row access status via a `LEFT JOIN
  users ON users.farmer_id = farmers.id`: `{ hasLogin, loginEmail, invitePending }`
  (`invitePending = must_change_password` — invited but not yet activated). Admin
  endpoint only; the public `PublicFarmer` projection (which strips email) is
  untouched.

#### Client (owner side — Фермери screen)

- Per-producer "Достъп" block: if no login → email field + "Изпрати покана"; if
  invited → "Поканен (изчаква)" + "Изпрати отново" / "Откажи достъп"; if active →
  "Активен · {email}" + "Откажи достъп". Wire through the BFF to the two endpoints.
- `admin`/`client` `api-client.ts`: `grantFarmerAccess(id, email)`,
  `revokeFarmerAccess(id)`.

#### Minimal farmer shell (enough to ship Phase 2)

- `AdminShell` already reads `/auth/me` (now returns `role`). Pass `role` to
  `Sidebar`. When `role='farmer'`, render a **reduced nav** — Phase 1+2 = just
  **Статистика** (`/stats`). The set grows in Phases 3–4.
- Client route guard: a small allowlist in `AdminShell` (`FARMER_ALLOWED` = paths a
  producer may open, e.g. `['/stats','/settings','/help','/reset-password']`); a
  producer hitting anything else is redirected to `/stats`. This is UX only — the
  hard boundary is the server's default-deny `TenantRolesGuard`.
- Forced-password-change modal + `/settings` change-password already work for any
  tenant token; they work unchanged for `role='farmer'`.

---

### Phase 2 — Personal turnover (the "види оборота")

#### Server — `StatsService.statsForFarmer(tenantId, farmerId, opts)`

Returns the **same `StatsSummary` shape** as `stats()` (so the client renders one
component), but every order-derived figure is recomputed from line items joined to
`products` filtered by `farmer_id`:

- **revenue / series / weekday / payment split** — `Σ(oi.quantity ×
  oi.price_stotinki)` over live (`status IS DISTINCT FROM 'cancelled'`) orders in the
  window whose item's product belongs to this producer. (Replaces the whole-tenant
  path's use of `orders.total_stotinki`.) Payment split groups that line-item sum by
  the parent order's `payment_method`; weekday/series bucket by the parent order's
  `created_at` in Europe/Sofia.
- **orderCount** — `COUNT(DISTINCT order_id)` among orders containing ≥1 of this
  producer's items (an order shared with another producer counts for both).
- **avgOrderStotinki** — producer revenue ÷ that distinct order count.
- **prev window** — same computation over the immediately-preceding equal window
  (delta arrows).
- **topProducts / slowProducts** — already product-based; filter to
  `products.farmer_id = :farmerId` (slowProducts: this producer's active products,
  zero-sellers first).
- **loyalty (customerCount / returning / new)** — distinct customer keys among
  orders containing this producer's items, vs the same key set *before* the window.
  Reuses `computeReturning`.
- Reuses all existing pure helpers; `sparse` threshold unchanged.

`StatsService.stats()` (whole-tenant) is untouched.

#### Server — controller

- `@Roles('admin','farmer')` on `GET /stats`.
- Resolve effective farmer (pure resolver above):
  - `role='farmer'` → `statsForFarmer(tenantId, tokenFarmerId, opts)`.
  - `role='admin'` + `?farmerId=` (validated in tenant) → `statsForFarmer(...)`.
  - `role='admin'`, no `farmerId` → `stats(...)` (whole-tenant, today's behavior).

#### Client — `/stats` screen

- `api-client`: `stats(range/from/to, farmerId?)`.
- **Owner, multi-farmer tenant:** a "Фермер: Всички / {producer} …" dropdown
  (populated from `GET /farmers`); selecting one passes `?farmerId=` and re-titles to
  that producer. "Всички" = whole-tenant. (Single-farmer tenants don't show it.)
- **Producer:** no dropdown; header reads "Моят оборот"; payload is already scoped by
  the token.
- The summary/chart component is unchanged (same shape).

---

### Phase 3 — Farmer shell + "Моите поръчки" (follow-on plan)

- Expand `role='farmer'` nav to **Статистика · Моите поръчки**. Extend
  `FARMER_ALLOWED`.
- `GET /orders` (or a scoped `/orders/mine`) opened via `@Roles('admin','farmer')`;
  for a producer, return only orders containing their items, projecting **their** line
  items + **their** subtotal (not the whole-order total). Owner view unchanged.

### Phase 4 — "Моите продукти" (edit own) (follow-on plan)

- Expand nav to include **Моите продукти**. Extend `FARMER_ALLOWED`.
- Product read/write routes opened via `@Roles('admin','farmer')` with an ownership
  check: a producer sees/edits only `products.farmer_id = me`; **create forces
  `farmer_id = me`**; a producer may not reassign `farmer_id`, nor touch another
  producer's product (403). Owner keeps full catalog control.

---

## Security notes

- **Default-deny holds.** Every existing owner endpoint stays `admin`-only; only the
  endpoints we explicitly open with `@Roles('admin','farmer')` admit producers, and
  each forces `farmer_id` from the token. A producer cannot widen scope via query
  param, header, or body.
- **Revocation is immediate.** "Откажи достъп" and producer deletion bump
  `token_version`, so any live producer token fails the strategy's `tv` check on the
  next request.
- **Invite token safety** is inherited: 30-min, single-use, separate secret, bound to
  the password fingerprint — once the producer sets a password the fingerprint
  changes and the link is dead. `must_change_password` blocks all writes until set.
- **Email uniqueness** across all `users` (existing unique constraint) covers
  producer logins; the partial unique index guarantees one login per producer.

## Testing (TDD — failing test first per item)

- **Server unit:**
  - effective-farmer resolver: producer forced to token id (query ignored); admin
    optional + tenant validation.
  - provisioning: create login (flag set, invite sent); re-invite resends/updates
    email; duplicate email → 409; revoke bumps `token_version` + deletes.
  - `statsForFarmer` attribution: shared order counts for both producers; delivery
    fee excluded; reassignment uses current `farmer_id`; cancelled excluded;
    top/slow filtered to the producer; loyalty scoped to producer's orders.
  - guard: a `farmer` token is 403'd on an owner-only route; allowed on
    `@Roles('admin','farmer')` routes.
- **Client:** stats screen renders producer-scoped payload; owner dropdown passes
  `farmerId`; Фермери access block (invite/revoke) submit paths.
- **Live E2E:** invite a producer on a multi-farmer tenant → set password via the
  emailed link → log in → forced password change → land on Статистика scoped to that
  producer → numbers reconcile with the owner's `?farmerId=` view for the same
  producer → "Откажи достъп" kills the session.

## Out of scope (v1)

- `order_items.farmer_id` snapshot (historical attribution after reassignment).
- Producer-editable bio/photo of their own `farmers` row (catalog stays owner-managed
  in v1).
- Per-producer payouts / money settlement, producer-to-producer visibility, 2FA.
- Driver/customer roles (still inert).

## Risks / notes

- The running services are `dist` builds; after implementing, rebuild + restart and
  apply migration `0043` to verify end-to-end (per repo dev-verify gotchas:
  `packages/db` + `packages/types` must be built to `dist` before the server picks up
  the new types/schema).
- `ADD VALUE` enum migration is the one irreversible-ish step — verify the generated
  SQL before applying to production; enum values cannot be dropped.
- Per repo machine gotcha: run jest, next build, and the server **sequentially** (not
  in parallel) to avoid FS flakes.
