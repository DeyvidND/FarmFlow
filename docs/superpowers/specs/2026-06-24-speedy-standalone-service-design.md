# Speedy Courier — Standalone Shipping Service (Design)

**Date:** 2026-06-24
**Branch:** `feat/econt-standalone-service`
**Status:** Approved — ready for implementation plan

## Goal

Add Speedy (speedy.bg) as a second Bulgarian courier in the **standalone shipping service** (:3100), at full feature parity with the existing standalone Econt integration: self-service producers create Speedy shipments (office + door delivery), print labels, track, manage cash-on-delivery (наложен платеж), request courier pickup, and benefit from the cross-tenant COD-risk system — all without a storefront order.

## Scope

- **In:** Speedy in the standalone service only (:3100). Full parity with standalone Econt.
- **Out:** Speedy in the FarmFlow farmer panel (storefront orders keep Econt-only). No checkout/storefront/chaika changes. No price-estimate at checkout (standalone has no checkout).
- **Architecture:** Mirror module — a `speedy/` module parallel to `econt/`, reusing shared infra. The shipped, green Econt integration is **not refactored** (zero regression risk).

## Speedy API facts (verified from official docs)

- **Base:** `https://api.speedy.bg/v1` (REST/JSON v1; the SOAP "EPS" service is legacy — ignore). No public sandbox host; Speedy issues demo credentials against the same host.
- **Auth:** per-call `userName` + `password` (+ optional `clientSystemId`, `language`) inside every JSON request body. No token/OAuth/API-key header.
- **Contract required:** an active Speedy contract + provisioned API user. COD / declared-value / third-party payout are gated per contract (`POST /client/contract/info`).
- **Addresses are id-based:** `siteId` (нас. място), `streetId` + `streetNo`, or `officeId` for office delivery. No free-text geocode — must back the picker with `/location/*` data and run `/validation/address` before create.
- **Currency:** Bulgaria adopted EUR on 2026-01-01 (fixed 1 EUR = 1.95583 BGN). Send `currencyCode: "EUR"` (or omit → destination default). Verify live before go-live (2026 is mid-transition).
- Docs: https://api.speedy.bg/web-api.html · examples: https://services.speedy.bg/api/api_examples.php

### Endpoint map (all `POST` JSON)

| Need | Endpoint |
|---|---|
| Create shipment/waybill | `/shipment` → returns `id` + `parcels[].barcode` |
| Print label PDF (raw bytes) | `/print` (`format:"pdf"`, `paperSize`, `parcels[].parcel.id`) |
| Track status (≤10 parcels/call) | `/track` (optional `lastOperationOnly`) |
| Cancel/void (pre-pickup) | `/shipment/cancel` |
| Request courier pickup | `/pickup` |
| Validate address | `/validation/address` |
| COD reconciliation / payout | `/payments` (`fromDate`/`toDate`, `includeDetails`) |
| Sender profiles (contract clients) | `/client/contract` |
| Site/office/street lookup | `/location/site`, `/location/office`, `/location/street` |
| (skipped v1) price calculation | `/calculate` |

### Create-shipment body (key fields)

```json
{
  "userName": "...", "password": "...", "language": "BG",
  "sender":    { "phone1": { "number": "0888..." }, "contactName": "..." },
  "recipient": { "phone1": { "number": "0899..." }, "privatePerson": true,
                 "clientName": "...",
                 "address": { "countryId": 100, "siteId": 68134,
                              "streetId": 3109, "streetNo": "1A" } },
  "service":   { "serviceId": 505, "autoAdjustPickupDate": true,
                 "additionalServices": { "cod": { "amount": 100, "processingType": "CASH" } } },
  "content":   { "parcelsCount": 1, "totalWeight": 0.6, "contents": "..." },
  "payment":   { "courierServicePayer": "RECIPIENT" },
  "ref1": "..."
}
```

COD: `service.additionalServices.cod = { amount, currencyCode?, processingType: "CASH"|"POSTAL_MONEY_TRANSFER", includeShippingPriceInCod? }`. Office delivery: recipient `address` uses an office id instead of `streetId`.

## Architecture

### Module layout — `server/src/modules/speedy/`

Mirrors `econt/` with the controller-less core split (same pattern as `econt-core.module.ts` + `cod-risk`):

| File | Responsibility |
|---|---|
| `speedy.client.ts` | HTTP client to Speedy v1. Injects `userName`/`password`/`clientSystemId` into each JSON body. Demo vs prod base URL. Per-call timeout. Throws on HTTP error for hard calls; never-throws for degradable lookups. |
| `speedy.service.ts` | Business logic (methods below). Resolves + decrypts per-tenant credentials. |
| `speedy.helpers.ts` | **Pure functions**, heavily unit-tested: `buildShipmentRequest(cfg, input)` (→ Speedy JSON), `parseTrackStatus(operations)` (→ canonical status), `trackingUrl(barcode)`, `parsePayouts(report)`, location slimmers. |
| `speedy-core.module.ts` | Controller-less. Provides SpeedyService + SpeedyClient + SpeedyProcessor + registers `SPEEDY_QUEUE`. Imports + re-exports CodRiskModule. Reuses `ShipmentEmailService`. |
| `speedy.processor.ts` | BullMQ worker. Cron `*/30 * * * *` → `refreshActiveShipments()`. Gated on `RUN_WORKERS`. |
| `dto/speedy-credentials.dto.ts` | `{ env?, userName, password, clientSystemId? }` |
| `dto/speedy-manual-shipment.dto.ts` | id-based receiver: `{ receiverName, receiverPhone, deliveryMode, officeId?, siteId?, streetId?, streetNo?, blockNo?, entranceNo?, floorNo?, apartmentNo?, serviceId, weightKg?, contents?, parcelsCount?, codAmountStotinki?, declaredValueStotinki? }` |
| `dto/speedy-validate-address.dto.ts` | `{ siteId, streetId?, streetNo?, officeId? }` |
| `dto/speedy-courier-request.dto.ts` | `{ shipmentIds: string[], timeFrom?, timeTo? }` |

### SpeedyService public methods

- `saveCredentials(tenantId, dto)` — validate via a live cheap call (`/location/site` with a known id, or `/client`), encrypt password, store at `tenants.settings.delivery.speedy`, bust caches.
- `getConfig(tenantId)` — public config view (no secrets).
- `createManualShipment(tenantId, dto)` — `POST /shipment`; persist `shipments` row (`carrier:'speedy'`, `carrierShipmentId`=shipment id, `trackingNumber`=parcel barcode, `orderId:null`, receiver snapshot, COD).
- `refreshStatus(tenantId, shipmentId)` / `refreshActiveShipments()` — `POST /track` (chunk ≤10), `parseTrackStatus` → canonical status, persist; fire shipped-email + `codRisk.recordReturnIfApplicable` (best-effort try/catch).
- `codReconciliation(tenantId)` — `POST /payments` date-range → Очаквано→Събрано→Преведено rows (same shape as Econt screen).
- `requestCourier(tenantId, dto)` / `getRequestCourierStatus(tenantId, requestId)` — `POST /pickup`.
- `validateAddress(tenantId, dto)` — `POST /validation/address`.
- `getClientProfiles(tenantId)` — `POST /client/contract` (sender auto-fill).
- `searchSites(tenantId, q)` / `getOffices(tenantId, siteId)` / `getStreets(tenantId, siteId, q)` — `/location/*`, Redis-cached.
- `getLabelPdf(tenantId, shipmentId)` / `getLabelsPdf(tenantId, ids)` — `POST /print` (raw PDF bytes; bulk merge via existing pdf util, max 50).
- `voidShipment(tenantId, shipmentId)` — `POST /shipment/cancel` (if waybill exists) + remove row. Tenant-scoped.
- `listShipments(tenantId)` — Speedy shipments for this tenant, UI-shaped.

### Reused as-is (no fork)

Encryption util (`secret.util.ts`), PDF-merge util (`mergePdfs`, already exported from `econt.service.ts`), `CodRiskService.recordReturnIfApplicable` (operates on a generic `shipments` row + canonical status — no edit needed), `ActivationGuard`, standalone signup/auth, super-admin activate endpoint.

**Not needed for Speedy:** the shipped-email (`ShipmentEmailService`) — every Speedy shipment is order-less (`orderId` null), so there is no storefront order/customer-email to notify; skipped (revisit only if Speedy ever ships FarmFlow orders).

**COD-risk endpoints are not duplicated.** The existing standalone risk surface (`/shipping/risk/{check,candidates,reports/:id}` on the Econt controller) is carrier-agnostic and account-level: `check` keys on phone; `listCandidates`/`confirmReport` read the `shipments` table by tenant/id, so Speedy candidates (flagged by the shared `recordReturnIfApplicable`) and Speedy reports already work through it. No `/speedy/risk/*` routes.

## Data model — generalize `shipments` (migration 0057)

**Additive-only** (no column rename — a Drizzle rename forces an interactive prompt and would churn the shipped Econt code; additive columns generalize the table with zero Econt risk):

- Add `carrier text NOT NULL DEFAULT 'econt'`. Existing rows + all Econt inserts stay `'econt'` via the default; Speedy inserts set `'speedy'`.
- Add `trackingNumber text` — the Speedy parcel **barcode** (the trackable number). Econt keeps using its existing `econtShipmentNumber` column; the two coexist and each carrier reads only its own.
- Add `carrierShipmentId text` — the Speedy **shipment id** (needed for cancel/print/info). Econt leaves it null.
- **Reused unchanged:** `labelPdfUrl` (null for Speedy — `/print` returns bytes, fetched on demand), `courierPriceStotinki`, `codAmountStotinki`, `trackingJson`, `courierRequestId`/`courierRequestStatus`, `codCollectedAt`/`codSettledAt`, `receiver*`, `weightKg`, `contents`, `reportStatus`.
- **Econt code is not touched** — it never reads `carrier`/`trackingNumber`/`carrierShipmentId`; Speedy never reads `econtShipmentNumber`.
- Speedy config shape at `tenants.settings.delivery.speedy`: `{ env, userName, passwordEnc, clientSystemId?, configured, sender{ contactName, phone, mode, officeId?, siteId?, streetId? }, defaultPackage{ weightKg?, contents?, parcelsCount? }, cod{ enabled?, processingType? } }`.

### Canonical status

`parseTrackStatus` maps Speedy operation codes → the SAME vocabulary Econt uses: `pending | created | shipped | delivered | returned | refused`. Because cod-risk, shipped-email, and reconciliation all read this canonical status, they work for Speedy **without modification** (`isReturnedStatus` already keys off `returned`/`refused`).

## Location / address picker (Redis-cached, no new tables)

- `searchSites(q)` → `POST /location/site`, Redis 24h.
- `getOffices(siteId)` → `POST /location/office`, Redis per-site 24h.
- `getStreets(siteId, q)` → `POST /location/street`, Redis per-site 24h + in-memory filter.
- Speedy's CSV bulk export needs separate enrollment — out of scope; live + cache is enough.
- Cache key prefix `speedy:` (e.g. `speedy:sites:<slug>`, `speedy:offices:<slug>:<siteId>`). Negative-cache empty results 60s (mirror Econt).

## Standalone wiring

- New `SpeedyStandaloneController` @ `/speedy/*`, guarded `JwtAuthGuard` + `ActivationGuard` on paid actions (`POST /speedy/shipments`, `POST /speedy/courier`). Read/lookup routes JWT-only.
- Standalone app module imports `SpeedyCoreModule` and mounts the new controller alongside the Econt one. Econt stays at `/shipping/*` untouched (cosmetic prefix asymmetry; acceptable — standalone not yet deployed, can unify later).
- **Activation is account-level:** one paid activation unlocks the whole shipping service (both couriers). Reuse the existing `econtApp.active` flag, `ActivationGuard`, and super-admin `PATCH /platform/econt-accounts/:id/activate` as-is.
- **Cron placement:** the Speedy refresh cron must run in the worker process — the main FarmFlow API (`RUN_WORKERS=true`), NOT the standalone (deployed `APP_ROLE=web`, no workers; else the Econt cron double-runs). Add `SpeedyCoreModule` to FarmFlow `AppModule` (controller-less → no Speedy UI leaks into the FarmFlow panel; the shared worker just runs the cron). Same worker model as Econt.

## Error handling

- Standalone errors surface to the user (`BadRequest`/`NotFound`) but never crash — the global exception filter is already mounted.
- Location / track / payout failures degrade (null/empty), never block.
- cod-risk + shipped-email hooks stay best-effort (try/catch, log-and-continue).
- Credentials operations require `ENCRYPTION_KEY` (throw `BadRequest` if missing).

## Testing

- Pure helpers heavily unit-tested: `buildShipmentRequest` (office vs address, COD on/off, EUR currency), `parseTrackStatus` (each Speedy code → canonical), `trackingUrl`, `parsePayouts`, location slimmers.
- Service methods follow repo convention (skip db-mock tests, as the cod-risk round did).
- Gate to ship: `tsc` + lint + full Jest suite green + boot smoke on :3100 (DI graph resolves, Speedy controller mounts, a create call hits `ActivationGuard` → 403 pre-activation).

## Pending before prod (spikes / provisioning)

- **Speedy demo credentials** → verify live JSON field names for create/track/print/payments vs the DTOs, and confirm **EUR currency** behavior (2026 mid-transition). Same docs-vs-live caveat flagged for Econt.
- Confirm valid `serviceId` per route via `/services/destination` (the create call needs a real service code).
- Frontend + deploy: the standalone shipping web UI gains a Speedy tab (connect creds, create shipment, address picker, labels, COD, pickup) — separate plan.

## Out of scope (explicit)

Price estimate at checkout, Speedy in FarmFlow farmer panel, storefront/chaika changes, CSV location bulk-import, generic courier abstraction (chose mirror), refactoring the shipped Econt code.
