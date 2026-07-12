# Marketplace finance → super-admin console

**Date:** 2026-07-12 · **Status:** approved (design), implementing.

## Problem
„Финанси на пазара" (marketplace commission + monthly vendor charges) lives in the
**farmer/tenant panel** (`client/`, route `/marketplace-finance`, `multiFarmer`-gated).
Owner's model: the **platform (us)** runs the marketplace and takes commission
**from the brand**; a brand hosts many farmers and sorts money among them.
Marketplace management therefore belongs in the **super-admin console** (`admin/`),
not the tenant panel. Current storefront is still chaika (single tenant); a real
multi-brand marketplace + per-brand „organizer" accounts come later.

## Scope (this iteration)
Relocate the EXISTING finance surface (level 2 = brand↔its-farmers: commission
summary + monthly subscription charges) into the super-admin, cross-brand.
Remove it from the farmer panel. NOT building level 1 (brand-owes-platform take
rate) now — that is future marketplace work.

## Approach — per-brand drill (chosen)
Super-admin page lists the marketplace **brands** (`tenants.multiFarmer = true`,
≈1 today) with their commission totals; select a brand → its per-producer
commission table + monthly charges (the same view the brand used). Reuses the
already-tested `CommissionService` / `VendorSubscriptionService` via new
platform-authenticated endpoints scoped to a chosen `tenantId`. Aggregate roll-up
(option B) deferred.

## Design

### Server (`server/src/modules`)
- `vendor-finance/vendor-finance.module.ts`: also `exports` `VendorSubscriptionService`
  (currently only `CommissionService` is exported).
- New `platform/marketplace-finance.service.ts` — `PlatformMarketplaceFinanceService`
  (`@Inject(DB_TOKEN)` + `CommissionService`): `listBrands()` → select
  `tenants` where `multiFarmer = true` `(id, name, slug, isDemo)`, map each with
  `commission.summary(id)` totals (`commissionEnabled`, `defaultRateBps`,
  `farmerCount`, `totalGrossStotinki`, `totalCommissionStotinki`).
- New `platform/marketplace-finance.controller.ts` —
  `PlatformMarketplaceFinanceController`, `@UseGuards(PlatformAdminGuard)`,
  `@Controller('platform/marketplace')`:
  - `GET brands` → `service.listBrands()`
  - `GET brands/:id/commission` → `commission.summary(id, {from,to})`
  - `GET brands/:id/subscriptions?period=` → `subs.list(id, period)`
  - `POST brands/:id/subscriptions/generate` → `subs.generateForPeriod(id, period)`
  - `PATCH brands/:id/subscriptions/:chargeId` → `subs.setStatus(chargeId, id, status, note)`
  Reuses vendor-finance DTOs (`GenerateChargesDto`, `ListChargesQueryDto`, `UpdateChargeDto`).
  `:id`/`:chargeId` `ParseUUIDPipe`. Route prefix avoids colliding with `platform/tenants/:id`.
- `platform/platform.module.ts`: `imports` `VendorFinanceModule`; add the new
  service to `providers` and the new controller to `controllers`.
- Old tenant-scoped `vendor-finance.controller.ts` stays (dormant, unused by UI).

### Admin (`admin/src`)
- `lib/api-client.ts`: `MarketplaceBrand`, `CommissionSummary`, `VendorCharge`
  types + `listMarketplaceBrands`, `getBrandCommission`, `listBrandCharges`,
  `generateBrandCharges`, `updateBrandCharge` (via `/bff` proxy).
- `app/(panel)/marketplace-finance/page.tsx` (server: prefetch brands) +
  `components/marketplace-finance-client.tsx`: brand list → select → commission
  table + charges (generate month / mark paid / waive). Styled in the console's
  design language (ff-tokens, dark sidebar already global).
- `components/panel-sidebar.tsx`: nav item „Финанси на пазара" (HandCoins) in the
  „Анализ и пари" group.

### Client farmer panel (`client/src`)
- `components/layout/sidebar.tsx`: remove the `/marketplace-finance` NAV item and
  its `multiFarmer` gate line.
- Delete `app/(admin)/marketplace-finance/` + `components/marketplace-finance/`.
- Remove now-dead `vendor-finance` client api funcs/types if unused elsewhere.

## Testing
- New service unit spec: `listBrands()` includes only `multiFarmer` tenants and
  maps summary totals. Controller endpoints are guarded by `PlatformAdminGuard`
  (existing guard, already covered) and scope by path `:id`.
- Reused services keep their existing specs. `tsc --noEmit` on server + admin.

## Out of scope / future
Level-1 brand→platform take-rate ledger; aggregate cross-brand roll-up; organizer
role + real multi-brand marketplace storefront.
