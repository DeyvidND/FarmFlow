# Demo accounts in super-admin — design

**Date:** 2026-06-19
**Status:** Approved (brainstorming) — pending implementation plan

## Goal

Let a super-admin spin up disposable demo farm-shop accounts in one click and hand
the credentials to friends so they can test the **farmer/admin panel**. No live
third-party storefront is required — a tenant works panel-only today (storefront is
tied only by slug and is optional).

## Context (what already exists)

- The `admin` app (separate from the farmer panel) already has a **"Create tenant"**
  dialog backed by `POST /platform/tenants` → `PlatformService.createTenant()`
  (`server/src/modules/platform/platform.service.ts`). It creates a tenant + owner
  user (`role='admin'`, `mustChangePassword=true`) with an auto-generated temp
  password and shows a copy-ready success screen. No email is sent.
- There is **no tenant-delete** path today. `setStatus()` only soft-toggles
  `subscriptionStatus` (active/inactive).
- Background jobs use **BullMQ repeatable jobs** (the project dropped
  `@nestjs/schedule`). Helper: `server/src/common/queue/register-repeatable.ts`
  (`{ repeat: { pattern, tz: 'Europe/Sofia' }, jobId }`). Examples: slots
  `'30 6 * * *'`, billing `'0 3 * * *'`, digest `'0 7 * * *'`. Processors are
  registered only when `RUN_WORKERS` is true (`server/src/config/app-role.ts`,
  gated on `APP_ROLE`).
- Storage abstraction has `deleteByPrefix(prefix)` (paginated R2 delete). All tenant
  assets are keyed under `tenants/{slug}/...`, so `deleteByPrefix("tenants/{slug}/")`
  sweeps an entire tenant's media in one operation.
- There is a bulk-seed path `POST /platform/tenants/:id/import` →
  `PlatformService.importTenant()` (categories → farmers → products + contact +
  favicon). Demo seeding reuses this insert logic.

## Decisions

- **Cleanup = auto-expiry + manual** (chosen). Demos get an expiry date; a daily job
  hard-deletes expired demos; super-admin can also delete manually any time.
- **`mustChangePassword=false` for demos** — friend logs straight in with the given
  credentials, no forced reset. Real-tenant creation keeps the forced reset.
- **Built-in seed catalog is fixed/hardcoded** — not configurable per demo.
- **Hard delete is demo-only** — the delete path refuses any tenant where
  `is_demo=false`. Real tenants remain disable-only. This is the core safety rail.

## Data model (migration)

Add two columns to `tenants` (`packages/db/src/schema.ts` + new SQL migration):

- `is_demo boolean NOT NULL DEFAULT false`
- `demo_expires_at timestamptz NULL`

Real tenants default to `is_demo=false`, `demo_expires_at=NULL` — no behavior change.

## Backend

### Create demo — `POST /platform/tenants/demo`

Body: `{ days?: 7 | 14 | 30 }` (default 14). Guarded by `PlatformAdminGuard`.
As-built: the admin UI is one-click (always default 14); the `days` param is
supported by the endpoint but not yet surfaced in the UI.

`PlatformService.createDemoTenant(days)`:
1. Auto-generate farm name `Демо ферма {short-id}`, unique email
   `demo-{rand}@demo.farmflow.bg` (uniqueness pre-check, throws on the
   astronomically-rare collision), 14-char crypto-random password.
2. Insert tenant: same defaults as `createTenant` **plus** `is_demo=true`,
   `demo_expires_at = now + days`.
3. Insert owner user: `role='admin'`, `mustChangePassword=false`, argon2 hash.
4. Seed the fixed sample catalog by reusing `importTenant`: 3 subcategories
   (Зеленчуци / Плодове / Млечни), 2 farmers, 8 products with stock.
5. Return `{ id, name, slug, email, password, expiresAt }`.

**As-built deviation (intentional):** these steps are NOT wrapped in a single
`this.db.transaction` — they run as sequential awaits, mirroring the existing
non-transactional `createTenant`. A mid-seed failure leaves a half-seeded demo,
which is harmless: it is flagged `is_demo=true`, so the daily cleanup job and the
manual hard-delete both reclaim it. (See the code comment in `createDemoTenant`.)
The return shape omits `panelUrl` (the UI's credentials modal needs only
email/password/expiry).

The seed dataset is defined once as a constant (`demo-seed.ts`) so create-demo
and tests share it.

### Delete tenant — `DELETE /platform/tenants/:id`

Guarded by `PlatformAdminGuard`. `PlatformService.deleteTenant(id)`:
1. Load tenant; 404 if missing.
2. **Refuse with an error if `is_demo !== true`** (real tenants are never hard-deleted
   here).
3. One `this.db.transaction` deleting in FK-safe order:
   `emailPushes → newsletterCampaigns → orderItems (via orders) → orders → shipments →
   productAvailabilityWindows → reviews → products → subcategories → farmers → users →
   articleMedia/articles → deliverySlots → contactMessages → newsletterSubscribers →
   auditLogs → tenants`.
   (Media tables `productMedia`/`farmerMedia`/`subcategoryMedia`/`articleMedia` cascade
   on their parent's delete, but products/etc. only have NO ACTION on the tenant FK, so
   parents must be deleted explicitly in order.)
4. After the transaction commits, `storage.deleteByPrefix("tenants/{slug}/")`
   (best-effort; failure logged, not fatal).
5. Bust any platform/public cache for that tenant/slug.

### Auto-expiry job — new `CLEANUP_QUEUE`

- New module/processor following slots/billing/digest pattern; provider registered only
  when `RUN_WORKERS`.
- `onModuleInit`: `registerRepeatable(queue, 'expire-demos', '0 2 * * *')` (02:00 Sofia).
- `process`: select tenants where `is_demo AND demo_expires_at < now()`, call
  `deleteTenant(id)` for each (sequential; tolerate per-tenant failure and continue).

## Super-admin UI (`admin/src/components/tenants-client.tsx`)

- New **„Създай демо"** button beside the existing „Създай ферма". Click → calls
  `POST /platform/tenants/demo` → shows the existing credentials success screen with a
  copy button (email + password + expiry).
- Demo rows show a **„ДЕМО" badge** and an **expiry countdown** („изтича след N дни").
- **„Изтрий демо"** button on demo rows only (confirm dialog) → `DELETE`.
- Optional **„Само демо"** filter toggle on the list.

## Security

- Both new endpoints behind `PlatformAdminGuard` (super-admin only).
- `deleteTenant` hard-refuses non-demo tenants — the only hard-delete in the system,
  fenced to demos.
- Email uniqueness still enforced on create.

## Testing

- `deleteTenant` throws when `is_demo=false`; deletes a demo with full child graph
  without FK violation (integration-style with seeded data).
- `createDemoTenant` sets `is_demo=true` + future `demo_expires_at`,
  `mustChangePassword=false`, and seeds the expected catalog counts.
- Expiry job selects only expired demos (not future-dated, not real tenants).
- Existing server jest suite + client tsc/lint stay green.

## Out of scope

- Storefront/chaika changes (demo is panel-only).
- Configurable per-demo catalog.
- Self-service demo signup (super-admin-initiated only).

## Deploy notes

- New migration (the two `tenants` columns) → run on PROD Dokploy redeploy.
- New BullMQ queue → no new infra; runs under existing worker (`APP_ROLE` all/worker).
- No new env vars, no new dependencies.
