# Deliveries Package + dostavki Cut — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Make deliveries a super-admin-gated package ("farmer panel + deliveries"), move the heavy Еконт/Speedy carrier connect+monitor UI out of the crowded farmer panel into the existing standalone delivery app (dostavki/`delivery-web`), and have the panel deep-link (SSO handoff) to it — while the storefront keeps driving orders into the carrier flow.

**Architecture:** One new per-tenant flag `deliveriesPackageEnabled` (mirrors `deliveryEnabled`) is the seam. Carrier code already lives once and runs as a second deployable (`main.econt.ts` → dostavki). `delivery-web` already covers carrier connect (creds), shipments, import, COD — it is MISSING the sender-profile editor, which must be ported before the panel's carrier sections can be removed.

**Tech Stack:** Drizzle/Postgres (hand-written migrations — generate is broken @0059) · NestJS · Next.js × (client panel, admin, storefront, delivery-web) · Jest. Money in stotinki.

---

## Decisions baked in (stated assumptions — user said "proceed without asking")

- **`deliveriesPackageEnabled` defaults TRUE.** Non-breaking: every existing live tenant keeps delivery. Super-admin turns it OFF for "panel-only" tenants. (The upsell is "off for new panel-only sells", set per tenant in admin.)
- **The cut line** (locked with user): carrier **connect + monitor** (Еконт/Speedy creds, sender, package, shipments, labels, COD, import, tracking) → dostavki. Storefront delivery **setup** (method toggles, prices, free-over, who-pays, carrier-policy, pickup address, self-delivery slots/route) → stays in farmer panel. Panel keeps status badges + a "Управлявай доставки →" deep-link.
- **SSO handoff** = short-TTL signed token in the deep-link URL (`?token=`), mirroring the editable-site `?edit=<token>` pattern. dostavki login accepts it, sets its `ff_delivery_session` cookie.
- **Ordering constraint:** the panel's `econt-section`/`speedy-section` (sender editor) can only be REMOVED after dostavki gains the sender editor (Phase 3). Until then they stay.

---

## Phases (dependency order)

1. **Package flag** — db + server + admin toggle + gating (panel nav, storefront, delivery-web access). Non-destructive. **Build now.**
2. **Panel deep-link + status** — panel shows carrier status badges + "Управлявай доставки →" card; SSO token mint + dostavki `?token=` accept.
3. **Port sender editor to dostavki** — delivery-web settings gains Еконт/Speedy sender/package/COD editors (port from panel). Removes the last gap.
4. **Remove carrier sections from panel** — delete econt-section/speedy-section/shipments-table/office-picker-preview from the panel delivery page (now safe). Panel delivery = light setup + deep-link only.

---

# PHASE 1 — Deliveries package flag (build now)

## Task 1.1: DB column + schema

**Files:** Create `packages/db/drizzle/0067_deliveries_package.sql`; Modify `packages/db/src/schema.ts:47`.

- [ ] **Step 1: Hand-write the migration** (generate is broken; mirror `0066`'s style)

`packages/db/drizzle/0067_deliveries_package.sql`:
```sql
ALTER TABLE "tenants" ADD COLUMN "deliveries_package_enabled" boolean DEFAULT true NOT NULL;
```

- [ ] **Step 2: Add the column to the schema** (after `deliveryEnabled`, line 47)

```ts
  // Super-admin „пакет Доставки" gate (farmer panel + deliveries add-on). When off,
  // the panel hides delivery config + the dostavki deep-link, the storefront offers
  // no courier methods, and the dostavki app denies access. Default true so existing
  // farms are unaffected; super-admin turns it off for panel-only tenants.
  deliveriesPackageEnabled: boolean('deliveries_package_enabled').notNull().default(true),
```

- [ ] **Step 3: Verify schema typechecks** — `cd packages/db && npx tsc --noEmit`.

## Task 1.2: Platform (super-admin) update + read

**Files:** `server/src/modules/platform/dto/update-tenant.dto.ts`, `platform.service.ts`, the tenant projection that admin reads.

- [ ] Add `@IsOptional() @IsBoolean() deliveriesPackageEnabled?: boolean;` to the update DTO.
- [ ] Persist it in the platform tenant-update service (mirror `deliveryEnabled` set).
- [ ] Include `deliveriesPackageEnabled` in the tenant detail projection the admin reads.
- [ ] Test: platform.service spec — updating the flag persists + is returned.

## Task 1.3: Admin toggle UI

**Files:** `admin/src/components/tenant-detail-client.tsx` (form lines ~148-204, flags ~259-265).

- [ ] Add `deliveriesPackageEnabled` to the form state + the PATCH body.
- [ ] Add a toggle control next to `deliveryEnabled` labelled „Пакет Доставки".
- [ ] Add a `<Flag>` badge.

## Task 1.4: Gate the farmer panel

**Files:** `client/src/app/(admin)/delivery/page.tsx`, `client/src/components/layout/admin-shell.tsx`, `sidebar.tsx`, the tenant profile read.

- [ ] Add `deliveriesPackageEnabled` to the `TenantProfile` type + the `/tenants/me` projection.
- [ ] Sidebar: hide the „Доставка" nav entry when `!deliveriesPackageEnabled`.
- [ ] Delivery page: if `!deliveriesPackageEnabled`, render a "пакетът не е активен — свържи се с екипа" notice instead of the config.

## Task 1.5: Gate the storefront

**Files:** `server/src/common/cache/public-cache.service.ts` (TenantMeta build ~39-115, 175+), `storefront/src/lib/api.ts`, `storefront/src/components/checkout-client.tsx`.

- [ ] In the public-cache profile builder: when `!deliveriesPackageEnabled`, force `econtEnabled=false`, speedy off, and courier methods off (leave pickup + self-delivery, which are not the carrier package). Mirror the existing `econtEnabled` derivation.
- [ ] Surface nothing new to the storefront type if the server already zeroes the methods — the checkout just won't show courier options. (Verify: `buildPublicMethods` output respects the gate.)

## Task 1.6: Gate dostavki (delivery-web) access

**Files:** `server/src/modules/econt-app/*` guard or the standalone controllers; `delivery-web` layout.

- [ ] Server: in the dostavki app's auth/activation path, deny (`403`) when the tenant's `deliveriesPackageEnabled` is false (mirror `ActivationGuard`). This is the authoritative gate.
- [ ] delivery-web: on a 403 package error, show "пакетът Доставки не е активен" instead of the panel.

## Phase 1 Verification
- [ ] `cd packages/db && npx tsc --noEmit`
- [ ] `cd server && npx jest` (full suite green + new platform flag test)
- [ ] `cd admin && npx tsc --noEmit && npm run build`
- [ ] `cd client && npx tsc --noEmit && npm run build`
- [ ] `cd storefront && npx tsc --noEmit && npm run build`
- [ ] Commit each task; final commit message references migration 0067.

---

# PHASE 2 — Panel deep-link + SSO handoff

## Task 2.1: Server — mint a dostavki handoff token
**Files:** `server/src/modules/auth/*` (new endpoint `POST /auth/delivery-handoff` → short-TTL JWT, audience `delivery`).
- Reuse the JWT signer; 5-min TTL; same tenant/user claims; `aud: 'delivery'`.

## Task 2.2: delivery-web — accept `?token=`
**Files:** `delivery-web/src/app/(auth)/login/page.tsx`, `delivery-web/src/lib/session.ts`.
- On `?token=<jwt>`: validate via the econt backend, set `ff_delivery_session` cookie, redirect to `/shipments`. Mirror editable-site `?edit=` flow.

## Task 2.3: Panel — status card + deep-link
**Files:** `client/src/components/delivery/delivery-client.tsx` (+ a new `DeliveryHandoffCard`).
- Card: badges „Еконт ✓ / Speedy ✓ / не свързан" (from `cfg.econt.configured`, `cfg.speedy?.configured`) + button "Управлявай доставки →" → calls handoff endpoint, opens `https://dostavki…/login?token=…`.

---

# PHASE 3 — Port sender editor to dostavki (removes the gap)

## Task 3.1: delivery-web settings — Еконт + Speedy sender/package/COD editors
**Files:** `delivery-web/src/components/settings-client.tsx`, `delivery-web/src/lib/*` (api-client additions).
- Port the sender-profile + default-package + COD blocks from `client/src/components/delivery/econt-section.tsx` (lines 254-432) and `speedy-section.tsx` (lines 204-380). Reuse the same backend endpoints (`econt/config`, `speedy/config`, city/site/office pickers) — all already exist on econt:3100.
- Verify: a farm can fully configure both carriers from dostavki alone.

---

# PHASE 4 — Remove carrier sections from the panel (now safe)

## Task 4.1: Strip the panel delivery page to light setup
**Files:** `client/src/components/delivery/delivery-client.tsx`; delete `econt-section.tsx`, `speedy-section.tsx` (keep `CarrierPolicySection` — it's setup), `office-picker-preview.tsx`, `shipments-table.tsx` from the panel render.
- Panel delivery page now renders: `MethodsSection` + `GlobalRulesSection` + `CarrierPolicySection` (when comparisonActive, from status read) + `DeliveryHandoffCard`.
- Carrier `configured` status comes from `/tenants/me` (already there), not from the removed sections.
- Verify: panel builds; no dangling imports; the heavy carrier UI is gone.

## Final Verification (all phases)
- All 5 apps `tsc` + build; server `jest` green; migration 0067 documented; live smoke per app before deploy (super-admin toggles package off → panel hides delivery, storefront drops courier, dostavki 403; handoff token logs into dostavki).

---

## Self-Review
- **Coverage:** package flag (P1), deep-link+SSO (P2), sender-port (P3), panel removal (P4) — maps to the user's "super-admin packages panel+deliveries; carrier UI → dostavki; deliveries from storefront (already true)".
- **Ordering safety:** destructive panel removal (P4) is gated behind the sender-editor port (P3) so farmers are never stranded.
- **Default-true flag** keeps the live system unbroken on deploy.
