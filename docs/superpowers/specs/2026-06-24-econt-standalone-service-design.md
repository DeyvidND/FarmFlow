# Standalone Econt service — design

**Date:** 2026-06-24
**Status:** Approved for planning
**Supersedes:** the Phase D section of `docs/superpowers/specs/2026-06-23-econt-service-buildout-design.md`
(which documented direction only). The reusable-package extraction described there is
**dropped** in favour of the lower-complexity approach below.

## Vision

A small **standalone self-service Econt shipping app** for Bulgarian producers: the
farmer signs up, connects their Econt account, types in a delivery, and everything else
is handled — address validated, label printed, **a courier sent to the farm to collect**,
parcel tracked, COD reconciled. No storefront, no products, no orders required.

**Business goal:** a cheap, fast-to-ship product that earns a small **one-time payment**
and builds trust with producers — a front door that later upsells the full ФермериБГ
platform.

FarmFlow's existing in-panel Econt integration (build-out phases A–C, already shipped)
**stays exactly as it is**. The standalone app is additive and reuses the same code, so it
adds no complexity to FarmFlow. Pulling useful pieces of the standalone app back into the
FarmFlow farmer panel is a later, separate decision.

## Architecture

**Approach: a second bootstrap of the existing backend** (chosen over package extraction
and over a fully separate repo). Rationale: maximum reuse, least new code, fastest to
revenue, leaves the just-shipped A–C untouched, and — because it is the same codebase and
the same database — "bring useful parts into the farmer panel later" comes for free.

```
┌───────────────────────────┐        ┌────────────────────────────┐
│  FarmFlow API (server/)    │        │  Econt API (server/)        │
│  main.ts  · port 3000      │        │  main.econt.ts · port 3100  │
│  full AppModule            │        │  EcontAppModule (subset)    │
└─────────────┬──────────────┘        └──────────────┬─────────────┘
              │         shared, same process image    │
              │   ┌──────────────────────────────┐   │
              └──►│  @fermeribg/db  (one Postgres) │◄──┘
                  │  EcontService, Auth, Email,    │
                  │  Queue, Cache, Crypto (reused) │
                  └──────────────────────────────┘
  ┌────────────────────┐                 ┌────────────────────────┐
  │ FarmFlow web/admin  │                 │ econt-web (new Next.js)│
  │ app.fermeribg.com   │                 │ dostavki.fermeribg.com │
  └────────────────────┘                 └────────────────────────┘
```

- **Backend:** a new bootstrap `server/src/main.econt.ts` builds a Nest app from a new
  `EcontAppModule` that imports only what the standalone app needs — Drizzle, Config,
  Cache, Crypto, Email (`@Global`), Queue, the existing `EcontModule`, plus a new
  standalone-auth module and standalone controllers. Runs as its **own process on its own
  port** (same Docker image, different entry/command → a new compose service). Reuses the
  existing `EcontService` via DI; new capability is added as methods on `EcontService` (or
  a thin `EcontStandaloneService`) so FarmFlow benefits too.
- **Frontend:** a new minimal Next.js app `econt-web/` on its own subdomain, with the same
  `/bff` cookie→bearer proxy pattern FarmFlow web uses (so `window.open('/bff/...label.pdf')`
  prints directly). Pages: signup/login, connect Econt, create shipment, shipments list +
  tracking, COD overview.
- **Data:** the same Postgres. Migrations auto-run on the FarmFlow API boot (existing
  `runMigrations` in `main.ts`); the standalone process relies on the shared schema.

### Accounts & auth

Standalone accounts are **new sign-ups** (producers not yet on FarmFlow), reusing the
existing `tenants` + `users` tables and the existing `AuthModule` / JWT / `JwtAuthGuard` /
`@CurrentTenant`:

- **Signup** (`POST /auth/signup`, standalone): email + password + farm name + phone →
  creates a `tenants` row (slug from name, `settings.product = 'econt-standalone'`,
  `settings.econtApp = { active: false }`) and an owner `users` row (reuses the existing
  password hashing). Rate-limited.
- **Login** issues a JWT scoped to that tenant (reuses existing sign-in).
- A producer who later adopts the full platform keeps the **same tenant** — it is upgraded,
  not duplicated.

### Monetization (one-time payment)

**v1 = manual activation.** The activation flag lives in `tenants.settings.econtApp.active`
(no migration). The producer can sign up, connect Econt, validate addresses, and price
shipments for free; **creating a real waybill and requesting a courier are gated behind
`active === true`**. A super-admin flips the flag after payment is received (bank / Revolut /
a one-off Stripe link — handled out of band). This ships fastest and validates demand before
any billing code is written.

**v2** automates this with a Stripe one-time Checkout (reusing the existing Stripe module)
that flips the flag on webhook.

## Data model

One migration (**0055**) to let a shipment exist without a storefront order:

- `shipments.orderId` → **nullable** (currently NOT NULL). Keep the existing UNIQUE
  constraint (Postgres allows multiple NULLs, so order-less shipments don't collide).
- New columns on `shipments` (receiver snapshot for manually-entered shipments — FarmFlow
  shipments leave these NULL and keep deriving from `orders`):
  - `receiverName text`, `receiverPhone text`
  - `deliveryMode text` (`'office' | 'address'`)
  - `receiverOfficeCode text`, `receiverCity text`, `receiverAddress text`
  - `weightKg numeric` · `contents text` (explicit columns, so a shipment can be reprinted
    or re-created without re-typing)
  - `courierRequestId text`, `courierRequestStatus text` — the pickup-request lifecycle.

`codAmountStotinki`, `courierPriceStotinki`, `labelPdfUrl`, `trackingJson`,
`codCollectedAt`, `codSettledAt`, `customerNotifiedAt` already exist and are reused.

Account activation (`settings.econtApp`) and the product flag stay in `tenants.settings`
JSON → no extra migration.

## Feature set — v1 (small but compelling)

1. **Standalone signup / login** + manual activation gate (above).
2. **Connect Econt** — save credentials (reuse `saveCredentials`); on connect, call
   `getClientProfiles` to **auto-fill the sender profile** (name/phone/client number) so the
   farm types nothing, and to prove the credentials work.
3. **Create a shipment manually** — a form: receiver (office *or* door address), package
   (weight, contents), COD amount, and optional toggles. Before creating, the address is run
   through **`validateAddress`** and creation is blocked unless valid. Optional label
   services exposed as simple switches: **SMS to receiver** (`smsNotification`),
   **refrigerated/perishable** (`refrigeratedPack`), **declared value / insurance**
   (`declaredValueAmount` + currency). Reuses `buildLabel` (already generic over an
   order-like shape) + a new order-less `createManualShipment`.
4. **Request a courier to the farm** (headline automation) — one tap after creating
   shipments calls **`requestCourier`** with the farm's sender address and a pickup window;
   status surfaced via **`getRequestCourierStatus`** (`process → taken`). The farmer never
   drives to an office.
5. **Print label PDF** — single + bulk-merged, via the existing `getLabelPdf` /
   `getLabelsPdf` + `/bff` proxy (reuse phase A).
6. **Shipments list + tracking** — real tracking history via `mapTrackingEvents`; the
   30-min BullMQ auto-refresh cron (`refreshActiveShipments`, reuse phase B) keeps statuses
   and COD timestamps current.
7. **COD reconciliation** — per-shipment Очаквано → Събрано → Преведено (reuse phase C
   `codReconciliation` + `parseCodReconciliation`).

## Feature set — v2 (deferred, documented)

- **CSV bulk import** of shipments (`createLabels` bulk endpoint).
- **Account-level payout ledger** — `PaymentReport` (money Econt actually transferred) layered
  over per-shipment COD, plus one-time payout setup via `createCDAgreement` (IBAN/BIC).
- **Automated Stripe one-time payment** to self-activate.
- **`getMyAWB` sync / reprint** — Econt as the source of truth for the shipment list.
- **Returns / "inspect before pay"** (`payAfterAccept` / `payAfterTest`, return
  `instructions[]`).
- **Bring useful pieces into the FarmFlow farmer panel.**

## New Econt API calls (all reused-pattern POST via `callTenant`)

| Method on `EcontService` | Econt endpoint | Use |
| --- | --- | --- |
| `getClientProfiles(tenantId)` | `Profile/ProfileService.getClientProfiles.json` | Auto-fill sender; validate creds. |
| `validateAddress(tenantId, addr)` | `Nomenclatures/AddressService.validateAddress.json` | Gate label creation on a valid address. |
| `createManualShipment(tenantId, input)` | `Shipments/LabelService.createLabel.json` (mode `create`) | Order-less waybill; persists a shipment with `orderId = null`. |
| `requestCourier(tenantId, input)` | `Shipments/ShipmentService.requestCourier.json` | Book a pickup at the farm. |
| `getRequestCourierStatus(tenantId, id)` | `Shipments/ShipmentService.getRequestCourierStatus.json` | Pickup status. |

`buildLabel` gains the optional service flags (sms / refrigerated / declared value),
emitted only when set, so it stays valid for both FarmFlow and the standalone app.

## Spike — verify against the live demo before prod

We do **not** have live Econt credentials during the build (Васил holds the demo account).
Field names and enum casing below are confirmed from Econt's **OpenAPI spec**, not a live
payload, and Econt's models have known gaps. Implement **defensively** (tolerate missing
fields, never crash), and run a verification spike with the demo account before flipping any
producer to prod:

- `createLabel` COD: `services.cdAmount` / `cdType` (`get` collects from receiver — confirm
  `give` exists) / `cdCurrency`.
- "Open/test before pay" are **top-level** on `label` (`payAfterAccept` / `payAfterTest`),
  **not** under `services`.
- `requestCourier.shipmentType` casing — SDK shows `PACK` (upper), spec enum is lowercase
  `pack`. Test which the live endpoint accepts.
- `getMyAWB.side` accepted values; `getRequestCourierStatus` enum
  (`unprocess/process/taken/reject/reject_client`).
- Tracking events (`ShipmentTrackingEvent`): narrative is `destinationDetails`; there is **no
  status enum on the event** — derive narrative status from the parent `ShipmentStatus`
  (`shortDeliveryStatus`). (Already handled by the current `mapTrackingEvents`.)
- COD timing is split: per-shipment on `ShipmentStatus` (`cdCollectedTime` / `cdPaidTime`)
  vs account-level `PaymentReport` (thin schema — verify date format `YYYY-MM-DD` and row
  fields on demo).

## Reuse map (existing code leaned on)

`EcontService`: `saveCredentials`, `getConfig`, `resolveCreds`, `call` / `callTenant`,
`getCities` / `getOffices` / `searchCities` / `getOfficesForCity` / `getPublicOffices`,
`buildLabel`, `estimateShipping`, `createLabel`, `getLabelPdf` / `getLabelsPdf` /
`fetchLabelPdf` / `mergePdfs`, `refreshStatus`, `refreshActiveShipments`, `voidShipment`,
`codReconciliation`, `mapTrackingEvents`, `parseCodReconciliation`, `mapShipmentRow`.
`AuthModule` (JWT, guard, password hashing), `EmailModule` (`@Global`), `QueueModule`
(BullMQ repeatable), `PublicCacheService`, crypto `encryptSecret`/`decryptSecret`,
`DrizzleModule`. The `/bff` cookie→bearer PDF-proxy pattern from FarmFlow web.

## Deployment

- Same Docker image; a new compose service runs `node dist/main.econt.js` with
  `PORT=3100`, sharing the existing Postgres + Redis. A new compose service (or build) serves
  `econt-web`. A new Cloudflare-tunnel route maps the subdomain (default
  `dostavki.fermeribg.com`; name TBD) to the standalone API + web.
- `deploy.yml` extended to build/ship the new entry + frontend.
- Migration 0055 auto-applies on the FarmFlow API boot (shared DB) — deploy the API first.
- `ENCRYPTION_KEY`, `JWT_SECRET`, DB/Redis env shared with the main app.

## Cross-cutting concerns

- **Error surfacing (differs from FarmFlow).** In FarmFlow, Econt errors are swallowed so
  they can't break checkout/webhooks. In the standalone app, Econt **is** the product — errors
  must be surfaced as clear, actionable Bulgarian messages (never a silent fallback), but
  still must never crash the process. The shared `EcontService` already throws
  `BadRequestException` with Bulgarian text; the standalone controllers pass these through.
- **Tenant isolation.** Every standalone endpoint is JWT-scoped to its tenant; shipments,
  PDFs, COD, and courier requests resolve by `(…, tenantId)`. No cross-tenant access.
- **Security.** Rate-limit signup/login; credentials stay AES-encrypted (`ENCRYPTION_KEY`);
  the activation gate blocks paid actions until `active`. Reuse existing throttling.
- **i18n.** All user-facing strings in Bulgarian, matching existing tone.

## Testing

Follow existing jest patterns (`server/src/modules/econt/econt.service.spec.ts`):

- `createManualShipment` synthesizes the correct order-like shape (office vs address; COD vs
  none) and persists a shipment with `orderId = null` + receiver columns.
- `buildLabel` emits the new service flags only when set, and omits them otherwise.
- `validateAddress` / `requestCourier` payloads match the documented shapes; responses parse
  defensively (missing fields → safe defaults).
- The activation guard blocks waybill creation when `active !== true` and allows it when
  true.
- Standalone signup creates exactly one tenant + one owner user with the product flag.

## Phasing (for the plan)

1. **Data model + order-less create** — migration 0055; `createManualShipment`; tests.
2. **Standalone auth + activation gate** — signup/login module; `@CurrentTenant`; guard;
   super-admin activate endpoint.
3. **New Econt automations** — `getClientProfiles`, `validateAddress`, `requestCourier` /
   status; `buildLabel` flags.
4. **econt-web frontend** — signup/login, connect (+auto-fill), create shipment (+validate
   +flags), shipments list + tracking, COD, print, request courier.
5. **Deploy wiring** — `main.econt.ts`, compose service, subdomain, `deploy.yml`.
6. **Spike verification** with the demo account before any producer goes prod.

## Out of scope

- The reusable `packages/econt-core` extraction (dropped — see Supersedes).
- In-app billing in v1 (manual activation only).
- CSV import, `PaymentReport` ledger, returns, `getMyAWB` sync (all v2).
- Multi-parcel shipments (`packCount` stays 1, as in FarmFlow).
- Any change to FarmFlow's existing A–C integration.

## Conventions / gotchas

- Work on a branch — `main` auto-deploys to the Hetzner box via SSH on push.
- Build `packages/db` + `packages/types` dist before the server build; `pnpm install` for new
  deps.
- One Econt account per tenant; creds encrypted in `tenants.settings.delivery.econt`.
- Reuse `buildLabel`'s existing COD gate (`paymentMethod === 'cod' && !paidAt`) — for manual
  shipments, "COD" is whether the farmer entered a COD amount.
