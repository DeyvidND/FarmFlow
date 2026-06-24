# Super-Admin Delivery Management — Design

**Date:** 2026-06-24
**Branch:** `feat/econt-standalone-service`
**Status:** Approved (brainstorming) — ready for implementation plan

## Goal

Give the super-admin a dedicated surface in the admin panel to **see** standalone delivery accounts and how they're doing, **create** new accounts (marking each as shop / delivery / both), **enable delivery on an existing farm**, and **toggle the delivery service on/off** per account. The super-admin does *not* operate accounts from here — to create shipments they log into the delivery app (`:3100`) directly. No impersonation.

## Context (as-built)

- A **delivery account** today = a `tenants` row created by self-signup at `:3100`, carrying `settings.product === 'econt-standalone'` and `settings.econtApp.active` (the paid/enabled flag), plus an `admin`-role `users` row. See `server/src/modules/econt-app/standalone-auth.service.ts` and `econt-app.helpers.ts`.
- A **farm account** = a normal FarmFlow tenant (storefront + catalog), created via super-admin `PlatformService.createTenant`.
- The **delivery app** (`main.econt.ts`, port 3100) and the **admin panel** (Next.js `admin/`, talking to the main API `/platform/*` via the `/bff` proxy) share the **same Postgres**. So the super-admin surface lives entirely in the main API's `platform` module — no calls to `:3100`.
- The delivery app gates paid actions with `ActivationGuard`, which only checks `isEcontAccountActive(settings)` (i.e. `settings.econtApp.active === true`) — there is **no product restriction**. So any tenant with `econtApp.active === true` can use the delivery app with its existing login.
- An activate endpoint already exists: `PATCH /platform/econt-accounts/:tenantId/activate` (`PlatformService.setEcontActive`, using `withEcontActive`). It has **no UI** and the admin tenants list (`listTenants`) shows delivery accounts undifferentiated among farms. That undifferentiated, UI-less state is the "I can't see it" problem this design fixes.

## Decisions (from brainstorming)

1. **Link model:** delivery accounts are their own tenants. At create time the super-admin checks capabilities **☑ Магазин / ☑ Доставка** → an account can be delivery-only, farm-only, or both. "Link to a farm" for an *existing* farm = enable delivery on it (add `econtApp`).
2. **Access model:** super-admin **creates + watches + toggles on/off** only. No impersonation; to operate, super-admin logs into `:3100` as the account.
3. No changes to `:3100`. No DB migration (capabilities are derived from existing `settings`; enabling delivery is an additive `settings` merge).

## Data Model — derived, no migration

Capabilities are computed from the existing `tenants.settings` JSON; nothing new is stored except an additive `econtApp` merge when enabling delivery.

Pure helper `deliveryCapabilities(settings): { shop: boolean; delivery: boolean; active: boolean; type: 'delivery' | 'farm' | 'both' }`:
- `delivery` = `settings.econtApp != null`
- `active` = `settings.econtApp?.active === true`
- `shop` = `settings.product !== 'econt-standalone'`
- `type` = `delivery && shop ? 'both' : delivery ? 'delivery' : 'farm'`

A tenant is a **delivery account** (appears in the new view) iff `delivery === true` (i.e. it has an `econtApp` settings block — whether active or not). Where each created account shows up: **delivery-only** and **both** appear in the new „Доставка" view; **shop-only** appears in the existing „Фермери" list (it has no `econtApp`); a **both** account appears in *both* views. So the create form can produce any account type, and each type lands in the matching view.

## Backend — `platform` module (main API)

All routes mounted on the existing `@UseGuards(PlatformAdminGuard) @Controller('platform')` controller. New DTOs in `server/src/modules/platform/dto/`.

### Pure helpers (TDD, no DB)
File `server/src/modules/platform/delivery-accounts.helpers.ts`:
- `deliveryCapabilities(settings)` — as above.
- `buildDeliveryOverview(shipmentRows): { total, codPendingStotinki, codCollectedStotinki, econt, speedy, lastShipmentAt }` — folds an array of `{ carrier, codAmountStotinki, codCollectedAt, createdAt }` into the overview shape. COD pending = sum of `codAmountStotinki` where `codCollectedAt == null`; collected = sum where `codCollectedAt != null`; `econt`/`speedy` = per-carrier counts; `lastShipmentAt` = max `createdAt`.

### Service methods (`PlatformService`)
- `listDeliveryAccounts({ cursor?, limit? })` → keyset-paginated (same `keysetAfter`/`buildPage` pattern as `listTenants`, ordered by `createdAt, id`) list of tenants where `settings->'econtApp' is not null`. Each row: `{ id, name, slug, email, phone, type, active, createdAt, overview }` where `overview` comes from `buildDeliveryOverview` over that tenant's shipments. Aggregate shipments in a single grouped query keyed by `tenantId` to avoid N+1. **No caching** — this is a single-operator, low-traffic view, so create / toggle / enable reflect immediately and we avoid the stale-toggle problem `listTenants`'s 60 s cache would cause. (The toggle switch may still update optimistically in the client.)
- `getDeliveryAccount(tenantId)` → the same row shape + `recentShipments` (last 20: `{ id, carrier, status, codAmountStotinki, codCollectedAt, createdAt, trackingNumber, econtShipmentNumber }`). 404 if the tenant doesn't exist or isn't delivery-capable.
- `createDeliveryAccount(dto)` → see DTO below. Email lowercased; reject duplicate user email (`ConflictException`, message `Имейлът вече е зает`) — same check as `createTenant`/standalone signup. At least one of `shop`/`delivery` must be true, else `BadRequestException('Изберете поне една роля')`. Unique slug via the existing slug helper. Insert `tenants` + one `admin` `users` row (argon2 hash, `mustChangePassword: false` — super-admin provisions a known password). Settings built from capabilities:
  - `delivery` only → `econtTenantSettings()` (sets `product: 'econt-standalone'`), then `withEcontActive(_, dto.active)`.
  - `shop` only → the farm default settings, `product` left as a normal farm; no `econtApp`.
  - both → farm default settings **plus** `econtApp: { active: dto.active }` merged in.
  When `shop` is checked, also run the same sample-catalog seed a normal farm gets. To avoid a second user / duplicated logic, **factor two reusable pieces out of `createTenant`**: `farmDefaultSettings()` (the default farm `settings` object) and `seedSampleCatalog(tenantId)` (the catalog/farmer/subcat seed). `createDeliveryAccount` inserts the tenant+user itself and calls `seedSampleCatalog` only when `shop` is true; `createTenant` is refactored to call the same two helpers (no behaviour change — covered by existing `createTenant` tests).
  Returns `{ id, name, slug, email, password }` — `password` echoed **once** so the super-admin can hand it over / log into `:3100`.
- **Toggle on/off** → reuse the existing `setEcontAppActive(tenantId, active)` (merges via `withEcontActive`, 404 `Акаунтът не е намерен`). The new route delegates straight to it; no new method needed.
- `enableDeliveryOnFarm(tenantId)` → load tenant; if already delivery-capable, return it unchanged (idempotent); else merge `econtApp: { active: true }` into its `settings` (additive, keeps all farm keys). 404 `Фермата не е намерена` if missing. This is the "link an existing farm to delivery" path.

### DTOs
- `CreateDeliveryAccountDto`: `email` `@IsEmail`; `password` `@IsString @MinLength(12) @MaxLength(128)` (platform password floor); `name` `@IsString @MinLength(2) @MaxLength(120)`; `phone?` `@IsOptional @IsString @MaxLength(40)`; `shop` `@IsBoolean`; `delivery` `@IsBoolean`; `active` `@IsOptional @IsBoolean` (default `true`). Validation: at least one of `shop`/`delivery` true (custom check in service → `BadRequestException` `Изберете поне една роля`).
- `SetDeliveryActiveDto`: `active` `@IsBoolean`.

### Controller routes (under `/platform`, `PlatformAdminGuard`)
- `GET  /platform/delivery/accounts?cursor&limit` → `listDeliveryAccounts`
- `GET  /platform/delivery/accounts/:tenantId` → `getDeliveryAccount`
- `POST /platform/delivery/accounts` → `createDeliveryAccount` (`@Throttle` default; `@HttpCode(201)`)
- `PATCH /platform/delivery/accounts/:tenantId/active` → `setDeliveryActive`
- `PATCH /platform/delivery/accounts/:tenantId/enable-delivery` → `enableDeliveryOnFarm`

`:tenantId` validated with `ParseUUIDPipe`. The legacy `PATCH /platform/econt-accounts/:tenantId/activate` stays (no breakage); the new `/delivery/accounts/:id/active` is the path the UI uses.

## Admin UI — `admin/`

- **Nav:** add „Доставка" to `admin/src/components/panel-chrome.tsx` nav, route `admin/src/app/(panel)/delivery/page.tsx` (server component, mirrors `tenants/page.tsx`).
- **List client** `admin/src/components/delivery-accounts-client.tsx` (mirrors `tenants-client.tsx` + `use-paginated-list.ts`): table columns — Име · Имейл · Тип (badges Магазин/Доставка) · Статус (on/off switch) · Пратки (#) · Наложен платеж: чака / събрано · Последна активност. Toggle switch calls `PATCH …/active`. Row click → detail drawer/section showing `recentShipments` (read-only).
- **Create** „Създай акаунт" button → modal form: Имейл, Парола, Име, Телефон, ☑ Магазин, ☑ Доставка, ☑ Активен. On success show the echoed credentials once. Calls `POST /platform/delivery/accounts`.
- **Enable on existing farm:** an action „Включи доставка" on a farm — surfaced on the existing tenant detail page (`tenant-detail-client.tsx`) calling `PATCH …/enable-delivery`. (Lightweight; keeps the farm flow where farms are managed.)
- All calls go through the admin `/bff` proxy (`admin/src/lib/api-client.ts`), same as existing platform calls.
- **Mobile-responsive** — table degrades to stacked cards on phones, consistent with the rest of the admin panel and the delivery UI work just shipped.

## Security

- Every new route behind `PlatformAdminGuard` (most-privileged token in the system).
- Passwords argon2-hashed; the plaintext is only echoed once in the create response and never stored or logged.
- No impersonation token is minted → no new auth attack surface.
- Cross-tenant reads are by design (super-admin oversight); all writes are scoped to the single `:tenantId` addressed.
- If an `auditLogs` write already wraps `createTenant`/activate, mirror it for create + toggle + enable (best-effort, non-blocking).

## Testing

- `delivery-accounts.helpers.spec.ts` — `deliveryCapabilities` (all four settings shapes) + `buildDeliveryOverview` (COD pending/collected split, per-carrier counts, lastShipmentAt, empty input).
- `platform.service.spec.ts` additions — `createDeliveryAccount` for the three capability combos (delivery-only / shop-only / both) incl. duplicate-email reject and "at least one role" reject, and that `seedSampleCatalog` runs only when `shop` is set; `listDeliveryAccounts` returns only delivery-capable tenants with correct overview; `enableDeliveryOnFarm` merges additively + is idempotent. (`setEcontAppActive` toggle already has coverage; add a case if missing for 404 on non-delivery tenant.) Refactor safety: existing `createTenant` tests must stay green after the helper extraction.
- Admin UI: typecheck + production build (existing pattern; no component unit tests in this repo's admin app).

## Out of scope (YAGNI)

Impersonation / "log in as", a cross-tenant join table, editing or creating shipments from the admin panel, delivery billing / payment collection, any `:3100` code change, any DB migration.

## File structure

- `server/src/modules/platform/delivery-accounts.helpers.ts` (+ `.spec.ts`) — pure capability + overview helpers.
- `server/src/modules/platform/dto/create-delivery-account.dto.ts`, `set-delivery-active.dto.ts` — new DTOs.
- `server/src/modules/platform/platform.service.ts` — new methods (list/get/create/setActive/enable).
- `server/src/modules/platform/platform.controller.ts` — 5 new routes.
- `admin/src/app/(panel)/delivery/page.tsx`, `admin/src/components/delivery-accounts-client.tsx` — new UI.
- `admin/src/components/panel-chrome.tsx`, `admin/src/components/tenant-detail-client.tsx` — nav item + enable-delivery action.
