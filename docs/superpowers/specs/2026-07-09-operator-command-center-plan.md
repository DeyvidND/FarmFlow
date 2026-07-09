# Operator Command Center — implementation plan

Companion to `2026-07-09-operator-command-center-design.md`. Task-by-task, with exact
files, changes, and verification. Executed via subagent-driven development (Sonnet coders,
Opus reviews + verifies + commits between waves).

Repo: pnpm workspaces — `server/` (NestJS), `client/` (farmer panel Next.js),
`admin/` (super-admin Next.js), `delivery-web/`, `packages/{db,types}`.
Branch: `feat/operator-command-center`.

Verification commands (use `ctx-wire run` to keep logs out of context):
- server typecheck: `ctx-wire run pnpm -C server exec tsc --noEmit`
- client typecheck: `ctx-wire run pnpm -C client exec tsc --noEmit`
- admin typecheck: `ctx-wire run pnpm -C admin exec tsc --noEmit`
- types build (if needed): `ctx-wire run pnpm -C packages/types build`

---

## PHASE A — Full impersonation into the farmer panel

### A1 — types + jwt.strategy (foundational, do first, alone)

**`packages/types/src/index.ts`**
- `JwtPayload`: add `actingAdminId?: string;` (doc: "Set only on an impersonation session
  minted by a platform admin — the acting super-admin's id, for attribution.").
- `TenantRequestUser`: add `actingAdminId?: string;`.

**`server/src/modules/auth/jwt.strategy.ts`**
- In the `type === 'tenant'` branch return, thread it through:
  `...(payload.actingAdminId ? { actingAdminId: payload.actingAdminId } : {})`.

Verify: `pnpm -C packages/types build` (if types is prebuilt) then server typecheck.

### A2 — server auth: mint + exchange panel handoff

**`server/src/modules/auth/auth.service.ts`**
- Add `panelHandoffSecret()`: `return \`${...JWT_SECRET}::panel-handoff\`;` (mirror
  `handoffSecret`).
- Add `issuePanelHandoff(adminId: string, targetUserId: string, tenantId: string)`:
  signs `{ sub: targetUserId, tid: tenantId, aid: adminId, type: 'panel-handoff' }` with
  `panelHandoffSecret()`, `expiresIn: '120s'`, `jwtid: randomUUID()`. Returns `{ token }`.
- Add `panelHandoffLogin(token: string)`:
  - verify with `panelHandoffSecret()`; reject unless `type==='panel-handoff' && sub && jti`.
  - single-use Redis claim `panel-handoff:used:<jti>` (`SET ... PX 130000 NX`), reject replay.
  - load the target user row (`SELECT *` by id); require `user.tenantId`.
  - **No delivery-package gate** (any farm).
  - mint the session via a new private `signImpersonation(user, actingAdminId)` — see below.
- Add private `signImpersonation(userId, tenantId, role, tokenVersion, farmerId, actingAdminId)`:
  builds a `JwtPayload` like `sign()` but with `mustChangePassword: false`,
  `actingAdminId`, and signs with **`expiresIn: '60m'`** (custom TTL — pass an options arg
  to `this.jwt.sign(payload, { expiresIn: '60m' })`). Do NOT modify the existing `sign()`.

**`server/src/modules/auth/auth.controller.ts`**
- Add `POST /auth/panel-handoff` (unguarded, mirror the existing `/auth/handoff`),
  body `{ token: string }`, returns `{ accessToken }` from `panelHandoffLogin`. Apply the
  same throttle decorator the delivery handoff endpoint uses.

Verify: server typecheck.

### A3 — server platform: impersonate-panel endpoint

**`server/src/modules/platform/platform.service.ts`**
- Add `impersonatePanel(tenantId: string, adminId: string): Promise<{ url: string }>`:
  - owner lookup: `SELECT id, role, tokenVersion, mustChangePassword, farmerId FROM users
    WHERE tenant_id = :tenantId AND role = 'admin' LIMIT 1` (drizzle `and(eq,eq)`).
    400 „Фермата няма собственик за вход" if none.
  - `const { token } = await this.auth.issuePanelHandoff(adminId, owner.id, tenantId);`
  - insert `auditLogs` row: `{ adminId, tenantId, action: 'IMPERSONATE_PANEL',
    path: \`/platform/impersonate-panel/${tenantId}\`, statusCode: 200 }`.
  - `const base = this.config.get<string>('CLIENT_URL') ?? 'https://app.fermeribg.com';`
    (confirm the real farmer-panel origin during impl; check existing env usage / other
    URLs like DELIVERY_URL for the correct prod host — do NOT guess if a constant exists).
  - return `{ url: \`${base}/api/session/handoff?token=${encodeURIComponent(token)}\` }`.

**`server/src/modules/platform/platform.controller.ts`**
- Add `POST /platform/impersonate-panel/:tenantId` guarded by the class-level
  `PlatformAdminGuard`, throttled (mirror the existing `impersonate` route), reads the
  admin id from `req.user.adminId`, calls `impersonatePanel`.

Verify: server typecheck.

### A4 — audit interceptor attribution (parallel-safe with A2/A3; needs A1)

**`server/src/common/interceptors/audit.interceptor.ts`**
- Change the `adminId` value written so an impersonation session is attributed to the acting
  admin while keeping the acting user:
  `adminId: user.adminId ?? user.actingAdminId ?? null,`
  (leave `userId: user.userId ?? null` as-is → both columns populated on impersonated writes;
  no schema change to `audit_logs`).

Verify: server typecheck.

### A5 — client exchange route (parallel-safe; only depends on A2's endpoint contract)

**`client/src/app/api/session/handoff/route.ts`** *(new)*
- Mirror `delivery-web/src/app/api/session/handoff/route.ts` but:
  - POST to `${API_BASE}/auth/panel-handoff`.
  - on success set `SESSION_COOKIE` (`ff_session`) httpOnly cookie with
    `maxAge: 60 * 60` (60m, matching the impersonation TTL), `sameSite:'lax'`,
    `secure` in prod, `path:'/'`.
  - redirect to `/dashboard` on success; `/login?reason=handoff` on failure.
- Confirm `client/src/middleware.ts` does not intercept `/api/session/handoff` (it is not in
  `PROTECTED`/matcher, so it is public — verify, don't add it to PROTECTED).

Verify: client typecheck.

### A6 — client impersonation banner + exit (client app; run with A5)

- Locate the farmer-panel shell that wraps the authenticated `(admin)` route group
  (search `client/src/components` for the shell/layout that renders nav around pages —
  likely `admin-shell*` or the `(admin)/layout.tsx` server component that reads the session).
- The server component that already decodes/validates the session should also read
  `actingAdminId` (decode the `ff_session` JWT payload — reuse the panel's existing decode
  helper) and, when present, resolve the tenant/farm name and render a **persistent
  full-width high-contrast banner** above content:
  „⚠ Разглеждаш като [ферма] · платформен админ" + an „Изход" action.
- „Изход" → new route `client/src/app/api/session/exit-impersonation/route.ts` (or a small
  client handler) that deletes `ff_session` and redirects to `/login`. Keep it minimal.
- Banner must be impossible to miss (fixed/sticky, red/amber).

Verify: client typecheck.

### A7 — admin UI: button + api-client (admin app; parallel with client work)

**`admin/src/lib/api-client.ts`**
- Add `export const impersonateOwner = (tenantId: string) =>
  apiFetch<{ url: string }>(\`platform/impersonate-panel/${tenantId}\`, { method: 'POST' },
  'Неуспешно влизане в панела');`

**`admin/src/components/tenant-detail-client.tsx`**
- In the right-aligned action column (the `flex flex-col items-end gap-2.5` block, ~line 255,
  next to „Редактирай"/„Включи доставка"), add a „Влез в панела" button that calls
  `impersonateOwner(d.id)` and `window.open(url, '_blank', 'noopener')`. Mirror the busy-state
  pattern from `impersonate-button.tsx`. Blue `#3457B1` palette, `LogIn` icon,
  title="Отваря истинския панел на фермера като него — за поддръжка".

Verify: admin typecheck.

**Phase A gate (Opus):** all three typechecks pass → commit
`feat(admin): full-panel impersonation for super-admin (A)`.

---

## PHASE B — „Проблеми" screen

### B1 — error_events table

**`packages/db/src/schema.ts`**
- Add `export const errorEvents = pgTable('error_events', { id, tenantId (fk, null),
  userId (null), adminId (null), method text, path text, statusCode int, message text,
  stack text null, createdAt timestamp defaultNow }, (t) => ({ createdIdx: index on
  (createdAt, id), tenantIdx: index on tenantId }))`. Match `auditLogs` style. Re-export at
  the bottom export block.

**`packages/db/drizzle/0084_error_events.sql`** *(hand-written, matches convention)*
- `CREATE TABLE error_events (...)` + the two indexes. Mirror an existing migration's DDL
  style. (Do NOT rely solely on drizzle-kit generate — hand-write to be safe, per project
  convention.)

Verify: `pnpm -C packages/db build` (or typecheck) + confirm SQL parses.

### B2 — global exception filter writes error_events

**`server/src/common/filters/global-exception.filter.ts`**
- Inject `@Inject(DB_TOKEN) private readonly db: Database` (verify APP_FILTER DI resolves —
  it is registered as a provider so constructor DI works). If DI proves problematic, fall
  back to injecting via the module that registers `APP_FILTER`.
- On `status >= 500`, fire-and-forget insert into `errorEvents`: method, path (from
  `host.switchToHttp().getRequest()`), statusCode, `message` capped to ~1000 chars,
  `stack` capped ~4000 chars, plus `tenantId/userId/adminId` from `req.user` if present.
  `.catch(() => undefined)` — never block or throw. Keep the existing Sentry capture.

Verify: server typecheck.

### B3 — GET /platform/problems

**`server/src/modules/platform/platform.service.ts`** (+ controller route)
- `problems()` returns a severity-ranked unified list. Sources (only real data — omit any
  signal not backed by a query; if a source is capped, say so in the payload):
  - recent `errorEvents` (last 48h) joined to tenant name, grouped by tenant+path with counts.
  - reuse `insights.service.ts` attention signals (empty shop, dormant, dropping,
    Stripe/Econt incomplete).
  - reuse `deliveryOps()` stuck-товарителници + COD-outstanding farms.
  - **extend only if groundable during impl:** active-orders-but-no-active-slots;
    courier-not-connected-with-pending-shipments.
- Each item: `{ severity: 'high'|'med'|'low', tenantId, tenantName, kind, detail, count? }`.
- Add `GET /platform/problems` on the platform controller.

**`admin/src/lib/api-client.ts`**: `getProblems()` wrapper.

Verify: server + admin typecheck.

### B4 — admin „Проблеми" screen + nav + list badge

**`admin/src/components/panel-chrome.tsx`**: add a „Проблеми" `<Link href="/problems">`
(lucide `AlertTriangle`) in the nav row.
**`admin/src/app/(panel)/problems/page.tsx`** + **`problems-client.tsx`**: render the feed,
severity-coloured, each row with a „Влез в панела" deep-link (reuse `impersonateOwner`).
**`admin/src/components/tenants-client.tsx`**: add a per-farm problem-count badge if the
tenants payload can carry it cheaply (else defer — do not add an N+1).

**Phase B gate (Opus):** typechecks pass + migration applied locally if a DB is available →
commit `feat(admin): cross-farm problems feed + error_events (B)`.

---

## PHASE C — „Здраве" screen

### C1 — GET /platform/health-board

**`server/src/modules/platform/platform.service.ts`** (+ controller route)
- API/DB/Redis status: reuse `health.controller.ts` logic (DB `SELECT 1`, Redis `ping`).
- Queue depths + failed counts for the 12 queues in
  `server/src/common/queue/queue.constants.ts` (inject each `Queue` or use a Bull
  connection to read `getJobCounts()`). If wiring all 12 is heavy, cover the operationally
  important ones (email, operator-digest, econt, speedy, newsletter-draft, image) and
  `log()`/note which are shown.
- error rate 24h + top-5 error paths + per-farm error tally from `errorEvents`.
- last repeatable-job runs where cheaply available; omit otherwise.

**`admin/src/lib/api-client.ts`**: `getHealthBoard()`.

### C2 — admin „Здраве" screen + nav

**`panel-chrome.tsx`**: „Здраве" `<Link href="/health">` (lucide `Activity`).
**`admin/src/app/(panel)/health/page.tsx`** + client: status tiles (API/DB/Redis green/red),
queue-depth table, error-rate summary, per-farm error tally linking into the farm.

**Phase C gate (Opus):** typechecks pass → commit
`feat(admin): system health board (C)`.

---

## Notes / gotchas

- `CLIENT_URL` server env must be set in prod (farmer-panel origin) for A3.
- Server changes need an image rebuild; push to `main` auto-deploys the server (current infra).
- Do not touch the working Доставки handoff (`issueDeliveryHandoff`/`handoffLogin`/
  `/auth/handoff`) — panel handoff is a separate type + secret + endpoint.
- Impersonation session TTL 60m; the handoff link is single-use (Redis NX).
- Attribution: impersonated writes populate BOTH `audit_logs.user_id` (owner) and
  `admin_id` (acting super-admin). No `audit_logs` schema change.
