# Spec — Farmer logins, forced + self-service password change, super-admin onboarding

**Date:** 2026-06-03
**Repos touched:** `FarmFlow` (`server`, `client`, `admin`, `packages/db`, `packages/types`)
**Status:** approved design, ready for implementation plan

## Goal

The platform operator (super-admin) onboards farms ("farmers"). Each farm is an
isolated tenant whose owner manages only their own website (existing behaviour —
the "personalization"). Add:

1. Super-admin creates a farm login (email + temporary password) from the
   super-admin panel; public self-registration is removed.
2. The farmer is **forced to change** the temporary password on first login, and
   can change it again **any number of times** afterwards.
3. The super-admin can also change **their own** password.
4. Unpaid farms can be disabled — **already built** (`/platform/tenants/:id/status`
   + `ActiveSubscriptionGuard`); no work beyond surfacing "Add farmer".

## Current state (verified)

- `users` table: one owner per tenant, `role='admin'`, `passwordHash` (argon2). No
  `must_change_password` column.
- `platform_admins` table: super-admins, `passwordHash` (argon2).
- Auth endpoints: only `POST /auth/login`, `POST /auth/register` (public, open).
  **No** change-password anywhere.
- Platform endpoints: `POST /platform/auth/login`, `GET /platform/tenants`,
  `PATCH /platform/tenants/:id/status` (all but login behind `PlatformAdminGuard`).
- Super-admin UI (`admin` app): login + Фермери list with working enable/disable
  toggle. **No** "create farm" action.
- Tenant admin UI (`client` app, :3005): full per-tenant management, sidebar with
  logout, a public `/register` page + login "Регистрирай се" link. **No** `/settings`.
- `JwtPayload` (`@farmflow/types`): tenant `{ sub, type:'tenant', tenantId, role }`;
  platform `{ sub, type:'platform' }`.

## Design

### Data model (`packages/db`)

- Add `users.must_change_password boolean NOT NULL DEFAULT false`.
- Drizzle migration via `pnpm --filter @farmflow/db generate` + `migrate`.

### Types (`packages/types`)

- Extend tenant `JwtPayload` with `mustChangePassword?: boolean` (carried in the
  token so the forced-change guard needs no per-request DB read).

### Server (`server`)

1. **Lock onboarding** — remove public `POST /auth/register` (endpoint + `RegisterDto`
   wiring from the controller). Registration now only via the platform endpoint.
2. **`POST /platform/tenants`** (`PlatformAdminGuard`) — body
   `{ farmName, email, tempPassword, phone? }`. Creates tenant + owner user with
   `mustChangePassword=true` (reuses the slug/insert logic moved out of the old
   register path). Returns the created farm summary (incl. slug). 201.
3. **`POST /auth/change-password`** (tenant JWT) — body `{ currentPassword, newPassword }`.
   argon2-verify current against the user (`sub`), reject if wrong; hash + store new;
   set `must_change_password=false`. **Re-sign** a fresh tenant JWT with
   `mustChangePassword:false` and return `{ accessToken }` so the client clears the
   forced state without re-login. Repeatable (no one-time restriction).
4. **`GET /auth/me`** (tenant JWT) — returns `{ email, role, mustChangePassword }` for
   the client to decide the forced redirect (also derivable from the token claim).
5. **`POST /platform/change-password`** (`PlatformAdminGuard`) — body
   `{ currentPassword, newPassword }`. argon2-verify + rehash the `platform_admins`
   row (`sub`). 204. Repeatable.
6. **`MustChangePasswordGuard`** (global `APP_GUARD`) — for `type:'tenant'` tokens
   with `mustChangePassword:true`, allow only: any `GET`, and `POST /auth/change-password`;
   `403` everything else. Reads the claim from the JWT (no DB hit). Defense-in-depth
   behind the client redirect.
7. New decorator `@CurrentUserId()` (reads `req.user.sub`) for the change-password
   handlers, alongside existing `@CurrentTenant()`.

### Client tenant admin (`client`, :3005)

1. **`/settings`** route — change-password form (current / new / confirm; min 6,
   confirm match). Submits to a Next route handler `POST /api/session/change-password`
   that proxies `POST /auth/change-password`, then **updates the `ff_*_session` cookie**
   with the returned fresh token. Success → toast + redirect to `/dashboard`.
2. **Sidebar** — add a `Settings` (lucide) item, label "Настройки", at the bottom
   block next to "Изход", linking to `/settings`.
3. **Forced change** — middleware/layout reads `mustChangePassword` from the session
   token; if true and path ≠ `/settings`, redirect to `/settings` and show a banner
   ("Смени временната си парола, за да продължиш."). Cleared once the token refreshes.
4. **Remove** the `/register` page and the login "Регистрирай се" link.

### Super-admin app (`admin`)

1. **"Add farmer"** button on the Фермери page → dialog (`farmName`, `email`,
   `tempPassword` with a generate button, `phone?`). Submits via BFF →
   `POST /platform/tenants`. On success prepend to the list and surface the temp
   password to copy. `api-client`: add `createTenant()`.
2. **Super-admin change-password** — a small settings entry (topbar menu or
   `/settings`) with a change-password form → BFF `POST /platform/change-password`.
   `api-client`: add `changePassword()`.

## Flow

Add farmer (super-admin) → email + temp password handed to farmer → farmer logs in
at :3005 → `mustChangePassword` forces `/settings` (server also 403s writes) → sets
new password → fresh token clears the flag → full access to their own site. Farmer
can revisit `/settings` to change password again anytime. Super-admin changes their
own password from the admin app. Unpaid → toggle off on the Фермери page (existing).

## Testing (TDD — failing test first per item)

- **server** (e2e/unit): change-password happy path (clears flag, new token works,
  old password rejected); wrong current → 401/400; `/platform/tenants` creates tenant
  + owner with flag true; public `/auth/register` is gone (404); `MustChangePasswordGuard`
  403s a write while flag set and allows it after change; platform change-password.
- **client**: settings form validation + success path (mock the route handler);
  forced redirect when flag set.
- **admin**: add-farmer dialog submit; change-password submit.

## Out of scope

- Farmer sub-accounts within one tenant (each farmer = one tenant, full control of
  own site — already the model).
- Email delivery of credentials, password-reset-by-email ("Забравена парола?" stays
  as-is), 2FA, password-strength meter beyond min length.

## Risks / notes

- Removing `/auth/register` is a breaking change for any current caller; the client
  `/register` page is removed in the same change.
- `mustChangePassword` in the JWT means a farmer with an old token (pre-change) keeps
  the flag until the token refreshes; the change-password response returns a fresh
  token, and login always issues a current one, so this is self-healing.
- The running services are `dist` builds via nohup; after implementing, rebuild +
  restart (or run `pnpm dev`) and apply the DB migration to verify end-to-end.
