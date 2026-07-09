# Operator Command Center — super-admin full access + monitoring

**Date:** 2026-07-09
**Status:** Approved (design), pending implementation
**Owner:** platform admin (ФермериБГ staff)

## Problem

The super-admin panel (`admin/`) can read per-farm aggregates (order counts, revenue,
recent orders, audit log, health signals) but cannot:

1. **See what a farmer sees** — the „Влез като фермер" button only mints a *Доставки*
   session, not the real farmer panel (`client/`). When a farmer reports „не работи",
   the operator can't reproduce it in the farmer's actual panel (products, orders,
   наличност, витрина, настройки).
2. **Be alerted to problems proactively** — server errors go only to external Sentry;
   nothing surfaces in-panel. There is no per-farm „нещо е счупено" feed.
3. **Drill into real rows** — detail views show counts, not the specific broken
   order/product/shipment.
4. **See system health** — API/DB/Redis/queue status lives in infra only, not the panel.

## Goal

One **Operator Command Center** inside the existing `admin/` app + `server/platform`
module. No new app, no new auth system. Reuses `PlatformAdminGuard` and the existing
single-use handoff mechanism.

Delivered in **3 phases**, in this order:

- **Phase A — Full impersonation into the farmer panel** (highest value: unblocks
  debugging; also delivers „ровя в реалните данни" because once inside you see every row).
- **Phase B — „Проблеми" screen** (proactive alarm across all farms).
- **Phase C — „Здраве" screen** (platform technical pulse).

---

## Phase A — Full impersonation into the farmer panel

### Decision

Full **write** access (operator explicitly chose this over read-only). Every action is
attributed to the acting admin so nothing is silent. Mitigations: persistent banner,
`actingAdminId` stamped on the session + every audit row, short TTL, single-use handoff.

### Flow

```
admin panel                     server (Nest)                    client/ (farmer panel)
-----------                     -------------                    ----------------------
[Влез в панела] ──POST /platform/impersonate-panel/:tenantId──▶
                                mint panel-handoff JWT
                                (type:'panel-handoff', 120s,
                                 single-use, derived secret,
                                 carries actingAdminId)
                                write IMPERSONATE audit row
     ◀──────── { url: <client>/api/session/handoff?token=… } ──
open url in new tab ───────────────────────────────────────────▶ GET /api/session/handoff
                                                                  POST /auth/panel-handoff {token}
                                POST /auth/panel-handoff ◀────────
                                panelHandoffLogin(token):
                                 - verify + single-use claim
                                 - resolve tenant OWNER user
                                   (role='admin')
                                 - mint tenant session,
                                   TTL 60m, mustChangePassword=false,
                                   actingAdminId embedded
     ─────────── { accessToken } ──────────────────────────────▶ set ff_session cookie
                                                                  redirect /dashboard
```

### Components

**Types (`@fermeribg/types`)**
- Add optional `actingAdminId?: string` to `JwtPayload` and `RequestUser`.

**Server — auth (`server/src/modules/auth/auth.service.ts`)**
- `issuePanelHandoff(adminId, targetUserId, tenantId)` — mints a `type:'panel-handoff'`
  token (own derived secret `${JWT_SECRET}::panel-handoff`, 120s, `jwtid`), embedding
  `adminId` as the acting admin. Mirrors `issueDeliveryHandoff` but a distinct type/secret
  so it can never be exchanged on the delivery path (or vice-versa).
- `panelHandoffLogin(token)` — verifies (panel-handoff secret), enforces single-use via
  Redis `panel-handoff:used:<jti>` (NX, PX 130s), resolves the target user, and mints a
  tenant session with:
  - `actingAdminId` embedded,
  - `mustChangePassword: false` (admin is not resetting the farmer's password),
  - **short TTL: 60 minutes** (impersonation must not linger for 7 days).
  - **No delivery-package gate** — works for any farm.
- Add a private `signImpersonation(...)` variant (or extend `sign`) that accepts a custom
  `expiresIn` and an `actingAdminId` claim. Keep the normal `sign` untouched.

**Server — auth controller (`server/src/modules/auth/auth.controller.ts`)**
- `POST /auth/panel-handoff` — unguarded (like the existing `/auth/handoff`), body `{token}`,
  returns `{ accessToken }`. Throttled.

**Server — jwt.strategy (`server/src/modules/auth/jwt.strategy.ts`)**
- In the `type === 'tenant'` branch, pass `actingAdminId` through into `RequestUser` when
  present. (Token still passes the normal `tokenVersion` check for the underlying user.)

**Server — platform (`server/src/modules/platform/platform.controller.ts` + `.service.ts`)**
- `POST /platform/impersonate-panel/:tenantId` (guarded by `PlatformAdminGuard`, throttled):
  `impersonatePanel(tenantId, adminId)` resolves the tenant's owner user
  (`role='admin'`), calls `issuePanelHandoff`, writes an `IMPERSONATE_PANEL` audit row
  (`adminId`, `tenantId`), returns `{ url: <CLIENT_URL>/api/session/handoff?token=… }`.
  400 if the tenant has no owner login. Requires a `CLIENT_URL` env (default the prod
  farmer-panel origin).

**Server — audit interceptor (`server/src/common/interceptors/audit.interceptor.ts`)**
- When the request user is a tenant token carrying `actingAdminId`, record BOTH the tenant
  `userId`/`tenantId`/`farmerId` AND the `adminId = actingAdminId`, and flag the row as
  impersonated (reuse the existing `adminId` column; optionally set `action` suffix or an
  `impersonated` marker). Net effect: every write during impersonation is attributable to
  the admin, not silently to the farmer.

**Client — exchange route (`client/src/app/api/session/handoff/route.ts`)** *(new)*
- Mirror `delivery-web/src/app/api/session/handoff/route.ts`: GET `?token` → POST
  `${API_BASE}/auth/panel-handoff` → on success set `ff_session` httpOnly cookie
  (`SESSION_COOKIE`, but with `maxAge` matching the 60m impersonation TTL) → redirect
  `/dashboard`. On failure redirect `/login?reason=handoff`.
- `client/src/middleware.ts` must not block `/api/session/handoff` (it isn't in `PROTECTED`
  / matcher, so it's already public — verify).

**Client — impersonation banner**
- The farmer panel shell (the layout/`AdminShell` that wraps `(admin)` pages) decodes the
  `ff_session` payload server-side; when `actingAdminId` is present, render a persistent
  top banner: „⚠ Разглеждаш като [ферма] · платформен админ · [Изход]".
- „Изход" → a small client route that clears `ff_session` and closes/returns. (New tab, so
  „Изход" can just clear cookie + redirect to `/login` or close.)
- Banner is unmissable (full-width, high-contrast) so the operator never acts thinking it's
  their own account.

### Security notes

- Panel-handoff token: distinct `type` + derived secret + 120s + single-use → cannot be
  replayed as an auth token or on the delivery path.
- Session TTL 60m (vs 7d normal) limits blast radius of a left-open impersonation tab.
- `actingAdminId` in the session + audit rows = full attribution; no action looks like the
  farmer performed it.
- `mustChangePassword` forced to false in the minted session so the operator is never
  pushed into the farmer's password-change modal.
- The exchange endpoint is unguarded by design (same as the working delivery handoff) but
  only accepts a valid, single-use, admin-minted token.

### Acceptance (Phase A)

- From „Фермери → [ферма]", „Влез в панела" opens the real farmer panel in a new tab, logged
  in as that farm, with the red impersonation banner visible.
- All farmer-panel screens work (products, orders, наличност, витрина, настройки).
- A write performed while impersonating produces an audit row carrying the acting admin id.
- The impersonation session expires after ~60 minutes; the handoff link is single-use.
- The existing Доставки „Влез като фермер" flow is unchanged.

---

## Phase B — „Проблеми" screen

### error_events table (`packages/db/src/schema.ts` + migration)

New table `error_events`:
- `id` (uuid pk), `tenantId` (nullable fk), `userId` (nullable), `adminId` (nullable),
  `method` (text), `path` (text), `statusCode` (int), `message` (text, capped ~1000 chars),
  `stack` (text, capped ~4000 chars, nullable), `createdAt` (timestamptz default now).
- Indexes: `createdAt desc`, `tenantId`.
- Next migration number = current highest + 1 (confirm during implementation).

### Global exception filter (`server/src/common/filters/global-exception.filter.ts`)

- On a caught exception with computed status `>= 500` (or unhandled), fire-and-forget an
  insert into `error_events` (method, path, statusCode, capped message/stack, tenantId +
  userId/adminId if resolvable from the request). Never block or fail the response; swallow
  insert errors. Keep the existing Sentry report.

### Endpoint `GET /platform/problems`

Returns a unified, severity-ranked list of active problems across all farms. Sources:
- Recent `error_events` (joined to tenant name) — last 24–48h, grouped by tenant/path.
- Reuse existing signals already computed in `insights.service.ts` (empty shop, no orders,
  dormant, dropping, Stripe/Econt incomplete) and `deliveryOps()` (stuck товарителници,
  COD outstanding).
- **Extend if data available** (confirm during implementation, don't invent):
  farms with active orders but no active delivery slots; courier not connected but pending
  shipments; recent payment/checkout failures. Any signal that can't be grounded in real
  data is omitted, not faked — and if a source is capped/sampled, say so in the payload.

Each problem carries: `severity`, `tenantId`, `tenantName`, `kind`, `detail`, and enough to
deep-link into Phase A impersonation for that farm.

### Admin UI

- New nav item „Проблеми" → `(panel)/problems/page.tsx` + `problems-client.tsx`.
- Per-farm problem badge on the „Фермери" list rows (count of active problems).
- Each problem row has a one-click „Влез в панела" (Phase A) for that farm.
- The existing daily operator digest email remains the push channel; this screen is the
  live view. (Real-time push — Telegram/critical-email — is a later add-on, not Phase B.)

### Acceptance (Phase B)

- Triggering a server 500 for a farm creates an `error_events` row that appears on „Проблеми".
- Existing insights/delivery signals appear in the unified feed.
- Each row deep-links into that farm's panel.

---

## Phase C — „Здраве" screen

### Endpoint `GET /platform/health-board`

- API/DB/Redis status (reuse `health.controller.ts` logic: DB ping + Redis ping).
- BullMQ queue depths + failed-job counts for the existing queues (names confirmed during
  implementation).
- 24h error rate + top error paths + per-farm error tally (from `error_events`).
- Last cron/repeatable-job run times where cheaply available (BullMQ repeatable metadata);
  omit if not.

### Admin UI

- New nav item „Здраве" → `(panel)/health/page.tsx` + client. Simple status board:
  green/red tiles for API/DB/Redis, queue-depth table, error-rate summary, per-farm error
  tally linking into the farm.

### Acceptance (Phase C)

- Board shows live API/DB/Redis status and real queue depths.
- Error-rate summary matches `error_events`.

---

## Out of scope (YAGNI)

- Real-time push alerts (Telegram/SMS) — later add-on.
- Pulling from the external Sentry API — errors come from the internal `error_events` table
  (self-contained, works even if Sentry is down).
- Read-only impersonation mode toggle — operator chose full write; not building the toggle
  now (the `actingAdminId` design leaves room to add it later).
- Row-level admin-side viewers for every entity — folded into Phase A (impersonate and look).

## Rollout / sequencing

Phase A ships and is verified before B; B before C. Each phase is independently deployable.
Server changes require an image rebuild + push to `main` (server auto-deploys on push per
current infra). New env: `CLIENT_URL` (farmer-panel origin) on the server.
