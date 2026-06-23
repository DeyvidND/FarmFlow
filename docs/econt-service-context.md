# Econt service — full context (for building it out)

Per-tenant Econt courier integration. Each farm connects its **own** Econt API
account; the platform creates waybills (товарителници), prices shipping at
checkout, tracks parcels, and handles наложен платеж (COD). Talks to Econt's JSON
API (demo or prod) with the farm's Basic-auth credentials, stored **encrypted**
in `tenants.settings.delivery.econt`. Degrades gracefully — with no creds (or no
`ENCRYPTION_KEY`) every call throws a clear 400 and the rest of the app is
unaffected (orders still record `econtOffice`).

## File map

**Server** (`server/src/modules/econt/`)
- `econt.service.ts` — the core (all logic below).
- `econt.controller.ts` — `EcontController` (admin, JWT) + `PublicEcontController` (storefront office picker, throttled 30/min/IP).
- `econt.module.ts` — exports `EcontService` (consumed by Stripe + Orders modules).
- `dto/econt-credentials.dto.ts` — `{ env?: 'demo'|'prod', username (min2), password (min3) }`.
- `econt.service.spec.ts` — unit tests.

**Client** (`client/src/components/delivery/`)
- `econt-section.tsx` — connect account, manual/auto mode, sender profile, package + COD, advanced (dimensions, label paper A4/A6, auto-create), nomenclature sync.
- `shipments-table.tsx` — list orders, create waybill (single + bulk), filter, tracking modal, copy №, void, **print (broken)**.
- `client/src/lib/api-client.ts` — `getEcontConfig`, `saveEcontCredentials`, `syncEcontNomenclature`, `searchEcontCities`, `listEcontOffices`, `listShipments`, `createShipment`, `refreshShipment`, `voidShipment`.
- `client/src/lib/types.ts` — `Shipment`, `ShipmentStatus`, `ShipmentEvent`, `EcontConfig`, `EcontOfficeLive`, `DeliveryMethodKey`.
- `client/src/lib/delivery-data.ts` — `SHIPMENT_META`, `SHORT_METHOD`, `lv` (€ formatter), `ECONT_HELP`.

## Data model

**`shipments` table** (`packages/db/src/schema.ts`):
`id`, `tenantId`, `orderId` (UNIQUE → one shipment per order, idempotent), `econtShipmentNumber`, `status` (default 'pending'), `labelPdfUrl`, `courierPriceStotinki`, `codAmountStotinki`, `trackingJson` (jsonb), `createdAt`, `updatedAt`.

**Econt config blob** — `tenants.settings.delivery.econt` (`EcontStored`):
`env` ('demo'|'prod'), `username`, `passwordEnc` (AES, never returned), `configured`, `sender` ({ name, phone, cityId, cityName, mode: 'office'|'address', officeCode, address }), `defaultPackage` ({ weightKg, contents, dimensions "LxWxH" }), `cod` ({ enabled, feePayer: 'customer'|'farm' }), `label` ({ paper: 'A4'|'A6', autoCreate: boolean }), `nomenclature` ({ lastSyncedAt, cities, offices }). Client `EcontConfig` adds a `mode` ('off'|'manual'|'auto') field driving the UI.

## Server — service methods

- **Credentials**: `saveCredentials` (validates live via getCities, then stores username + encrypted password, busts tenant + nomenclature caches), `getConfig` (secret-free view), `resolveCreds` (decrypts).
- **HTTP core**: `call` / `callTenant` — POST to `{base}/{path}` with `Authorization: Basic`, 15s default timeout, parses JSON, throws `BadRequestException` on non-2xx. Bases: demo `https://demo.econt.com/ee/services`, prod `https://ee.econt.com/services`. Country `BGR`.
- **Nomenclature**: `getCities`, `getOffices`, `syncNomenclature` (→ Redis), `getPublicOffices` (storefront picker, cached + negative-cache), `searchCities` (admin autocomplete, ~5.6k rows cached), `getOfficesForCity` (offices + coords + hours).
- **Label**: `buildLabel` (order + sender → Econt label payload; senderClient/senderAgent, receiverClient, office vs address routing, COD via `services.cdAmount`, dimensions), `estimateShipping` (mode:`calculate`, price only, cached 8h by tenant+destination+weight-bucket, 6s timeout, null→flat-fee fallback).
- **Create / lifecycle**: `autoCreateForOrder` (idempotent, best-effort, gated on `econt.label.autoCreate`; skips if waybill exists), `createLabel` (mode:`create` → persists `shipments` row), `listShipments` (Econt orders ⨝ shipments → admin table shape), `refreshStatus` (getShipmentStatuses → updates status + trackingJson), `voidShipment` (deleteLabels + removes row).

## Server — endpoints

Admin (`/econt`, JWT, tenant-scoped): `POST credentials`, `GET config`, `POST nomenclature/sync`, `GET cities?q`, `GET offices?cityId`, `GET shipments`, `POST shipments/:orderId` (create), `POST shipments/:id/refresh`, `DELETE shipments/:id` (void).
Public: `GET public/:slug/econt/offices?city` (throttle 30/min/IP).

## Econt API endpoints used
`Nomenclatures/NomenclaturesService.getCities.json`, `.getOffices.json`,
`Shipments/LabelService.createLabel.json` (mode `calculate` | `create`),
`Shipments/ShipmentService.getShipmentStatuses.json`,
`Shipments/LabelService.deleteLabels.json`. Auth = HTTP Basic, farm's API user/pass.

## Triggers / wiring
- `autoCreateForOrder` fired from: **Stripe webhook** (paid online — `stripe.service.ts:744`) and **Orders** (COD/cash Econt orders — `orders.service.ts:644` and on status transition `:870`). Both best-effort / non-throwing.
- `estimateShipping` runs **inline at checkout** (`checkout.service.ts`).
- `createLabel` from the admin "Създай товарителница" button (single + bulk).

## Current state

**Works**: connect account · nomenclature + storefront office picker · checkout price estimate (cached) · auto-create waybill on paid/COD order · manual create (single + bulk) · void · refresh status (stores JSON) · COD on the label.

**Broken / missing**:
- 🔴 **Print does nothing** — `listShipments` omits `labelPdfUrl`; the Print buttons only fire a toast. Farmer can't print the waybill. → **PHASE A** (in progress, separate session).
- 🔴 **Tracking history always empty** — `listShipments` hard-codes `history: []`; `trackingJson` from `refreshStatus` is never mapped to events. The TrackingModal therefore always shows "няма събития".
- 🟠 **`codAmountStotinki` never persisted** — computed in `buildLabel`, never written to the row. Blocks COD reconciliation. → fixed in PHASE A.
- 🟠 **No customer "shipped" email / tracking link.**
- 🟠 **Refresh is manual per-shipment** — no cron auto-refresh (BullMQ repeatable infra exists).
- 🟠 **`returned` status** defined client-side but `uiShipmentStatus` never returns it — no return-waybill flow.

## Roadmap

- **A — Real print (in progress)**: return `labelPdfUrl` + persist `codAmountStotinki`; wire Print (single + bulk) to open the PDF.
- **B — Tracking + shipped email**: map `trackingJson` → `history` events; email the customer their Econt tracking link (`https://www.econt.com/services/track-shipment/<number>/`) on create/ship; optional BullMQ cron to auto-refresh active shipments.
- **C — COD reconciliation**: expected `codAmountStotinki` vs delivery status, tied into `client/src/components/payments/payments-client.tsx`.
- **D — Quick-add / CSV shipment** (no storefront order): bridge toward extracting an `econt-core` package reused by both the platform and a future standalone Econt service.

## Conventions / gotchas
- `ENCRYPTION_KEY` required to save/read creds.
- Econt errors **must never** break checkout or webhooks (existing code swallows them — keep it).
- UI strings in Bulgarian; match existing tone.
- `mode` 'manual' (clerk/list-by-email) vs 'auto' (connected account creates waybills).
- One shipment per order (`shipments_order_unique`) → create is idempotent.
- Build `packages/db` + `packages/types` dist before the server build; `pnpm install` if deps missing.
- FarmFlow `main` auto-deploys to a Hetzner box via SSH on push — work on a branch.
