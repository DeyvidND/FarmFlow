# Econt service build-out — design (roadmap A–D)

**Date:** 2026-06-23
**Status:** Approved for planning
**Scope:** Build out the per-tenant Econt courier integration from "label creation works"
to a complete operational loop: real label printing, customer-facing tracking, and
COD reconciliation — plus a documented direction for extracting a reusable core.

## Background

Each farm connects its own Econt API account (Basic-auth credentials encrypted in
`tenants.settings.delivery.econt`). The platform already creates waybills, prices
shipping at checkout, voids labels, and refreshes status on demand. See
`docs/econt-service-context.md` for the full current-state map.

Васил (a real farm) is starting to use waybills now, so the gaps below are blocking
day-to-day use — chiefly that **the Print button does nothing**.

### Current gaps (grounded in code)

- **Print is fake.** `client/src/components/delivery/shipments-table.tsx` wires both the
  single (`:221`) and bulk (`:132`) print buttons to a `toast.info('Отваряне на PDF…')`
  with no actual PDF. `listShipments` (`econt.service.ts:647`) never returns
  `labelPdfUrl`, and the `Shipment` client type has no such field.
- **Tracking history is always empty.** `listShipments` hard-codes `history: []`.
  `refreshStatus` stores the raw status payload in `trackingJson` but nothing maps it to
  events, so `TrackingModal` always shows "няма събития".
- **`codAmountStotinki` is never persisted.** `createLabel`'s insert/update omits it,
  even though `buildLabel` already computes the COD amount and the column exists.
- **No customer "shipped" notification.**
- **Refresh is manual per-shipment** — no cron, although BullMQ repeatable infra exists.

## Guiding decisions (resolved during brainstorming)

| Fork | Decision |
| --- | --- |
| Phase A — PDF delivery | **Server proxy endpoint**, fetched as a blob through the authed api-client (see "bearer auth" note). Not a raw Econt URL opened directly. |
| Phase B — "shipped" email trigger | **On real ship** — the cron auto-refresh detects the transition to in-transit and sends one email. Not on label creation. |
| Phase C — COD reconciliation source | **Econt status/COD report data** (actual collected + paid-out), not status-derived guessing. Exact fields confirmed via a spike first. |
| Phase D — econt-core extraction | **Documented direction + boundaries only**; detailed spec deferred until A–C ship. |

## Architecture

`EcontService` stays the integration core. Phases A–C add capability incrementally with
no new module and no rework of what already works (credentials, nomenclature, checkout
estimate, auto-create, void). Phase D is a future `packages/econt-core` extraction.

### Key constraint: print + bearer auth

Admin auth is a **JWT in the `Authorization` header** (via `api-client`), not a cookie.
A plain `window.open`/`<a href>` cannot attach that header, so a JWT-protected proxy
endpoint alone is not openable by the browser.

**Print flow:** the proxy endpoint returns the PDF *bytes* (JWT-protected, tenant-scoped).
The client fetches it through `api-client` (which attaches the bearer), receives a
**blob**, creates an object URL (`URL.createObjectURL`), and opens it in a new tab for
printing. This keeps the PDF behind our auth, never exposes a raw Econt URL, and avoids
any token-in-URL pattern. Bulk print is a single server-merged PDF (one print job).

## Data model

`shipments` (`packages/db/src/schema.ts:368`) already has every column Phase A needs:
`labelPdfUrl`, `codAmountStotinki`, `trackingJson`, `courierPriceStotinki`,
`econtShipmentNumber`, `status`.

New columns (drizzle-kit generated; next sequential number is **0053**):

- **Phase B:** `customerNotifiedAt timestamptz null` — idempotency guard so the cron does
  not re-send the "shipped" email on every tick.
- **Phase C:** `codCollectedAt timestamptz null`, `codSettledAt timestamptz null` — when
  Econt collected COD from the customer, and when Econt settled (paid out) to the farm.

Phase A needs **no migration**.

## Phase A — Real print + COD persistence (no migration)

**Server**

1. `createLabel` insert/update also writes `codAmountStotinki`, using the same rule as
   `buildLabel`'s COD branch: `order.paymentMethod === 'cod' && !order.paidAt ?
   order.totalStotinki : null`.
2. `listShipments` selects and returns `labelPdfUrl` and `codAmountStotinki` in the row
   shape.
3. New endpoint `GET /econt/shipments/:id/label.pdf` (JWT, tenant-scoped): loads the
   shipment row, fetches the Econt PDF server-side using the farm's resolved credentials,
   and streams it back as `application/pdf`. `404` if the shipment or its PDF URL is
   missing; `502` (clear Bulgarian message) if the Econt fetch fails.
4. Bulk endpoint `GET /econt/shipments/label.pdf?ids=a,b,c`: fetches each shipment's Econt
   PDF and merges them into one document with **pdf-lib** (new dependency), streamed as a
   single `application/pdf`. Tenant-scoped; silently skips ids not belonging to the tenant.

**Client**

5. Add `labelPdfUrl` (and `codAmountStotinki`) to the `Shipment` type.
6. Single and bulk print buttons fetch the proxy endpoint via `api-client` → blob →
   object URL → open in a new tab. Remove the fake toasts. Revoke the object URL after
   open.

## Phase B — Tracking events + "shipped" email + cron (migration: `customerNotifiedAt`)

**Server**

1. `mapTrackingEvents(trackingJson)` → `ShipmentEvent[]` (`{ label, location, at }`),
   parsing the Econt `getShipmentStatuses` status object's tracking history. Confirm the
   exact array shape against a live demo response before finalizing the mapping.
2. `listShipments` returns the real mapped `history` instead of `[]`.
3. BullMQ repeatable job `econt-refresh` (~every 30 min) iterates active shipments
   (status in `created`/`shipped`, excluding `delivered`/`cancelled`) and calls
   `refreshStatus`. Per-shipment `try/catch`; one failure never aborts the batch. Reuses
   the existing queue infra (`server/src/common/queue/queue.module.ts` and the repeatable
   pattern in `slots`/`digest`/`billing` processors).
4. When a shipment transitions to in-transit ("shipped") **and** `customerNotifiedAt` is
   null: enqueue the customer "shipped" email and stamp `customerNotifiedAt`. The template
   mirrors `server/src/modules/order-email/order-confirmation.service.ts` (Bulgarian,
   brand-aware) and includes the Econt tracking link
   `https://www.econt.com/services/track-shipment/<number>/`. Sent via the email queue.

**Client**

5. `TrackingModal` already renders `shipment.history`; it just begins receiving real data
   from `listShipments`. No structural UI change.

## Phase C — COD reconciliation (migration: `codCollectedAt`, `codSettledAt`)

**Spike first.** Confirm which fields in the Econt `getShipmentStatuses` response (or a
dedicated COD/financial report endpoint) carry: (a) COD collected from the customer, and
(b) COD settled/paid out to the farm, with dates and amounts. Do not assume field names —
verify against the Econt demo account. The spike's findings feed steps 2–3.

**Server**

1. Within the same refresh cycle from Phase B, parse the confirmed COD fields and persist
   `codCollectedAt` / `codSettledAt`.
2. `GET /econt/cod-reconciliation` returns rows `{ orderId, expectedStotinki,
   collectedStotinki, settledStotinki, status }` for the farm's COD-via-Econt orders.

**Client**

3. `client/src/components/payments/payments-client.tsx` gains a COD reconciliation view
   showing each order's lifecycle: Очаквано → Събрано → Преведено.

## Phase D — econt-core extraction (documented, deferred)

**Direction.** Extract the pure, framework-agnostic Econt client — `call`/auth,
`buildLabel`, nomenclature parsing, label create/calculate, status + tracking mapping, COD
parsing — into `packages/econt-core` with **no NestJS or DB dependencies**. `EcontService`
becomes a thin adapter over it (credential resolution, persistence, Redis caching,
graceful-degradation policy).

**Reuse targets.** A future standalone Econt microservice and a **quick-add / CSV import**
flow (create a shipment without a storefront order — manual receiver entry or CSV) both
consume the same core.

**Boundaries.** econt-core owns wire-format and business mapping; the platform adapter owns
credentials, storage, caching, and the "never break checkout/webhook" policy. A detailed
spec for D is written once A–C have shipped.

## Cross-cutting concerns

- **Graceful degradation (unchanged contract).** Econt errors must never break checkout or
  payment webhooks — keep the existing swallow-and-fallback behavior. The cron is
  non-throwing per shipment. Email send failure is logged and retried by the queue; it
  never blocks a status update.
- **Tenant isolation.** Every new endpoint resolves the shipment by `(id, tenantId)`; no
  cross-tenant PDF or COD access.
- **i18n.** All user-facing strings in Bulgarian, matching existing tone.

## Testing

Follow the existing jest patterns (`server/src/modules/econt/econt.service.spec.ts`).

- **A:** `createLabel` persists `codAmountStotinki` (COD and non-COD paths); `listShipments`
  includes `labelPdfUrl`; print endpoint returns PDF bytes, `404` (missing) and `502`
  (Econt failure) paths, and rejects another tenant's shipment; bulk merge produces one
  document and skips foreign ids.
- **B:** `mapTrackingEvents` shapes events from a representative payload; `uiShipmentStatus`
  still classifies correctly; cron selects only active shipments, is non-throwing, and the
  "shipped" email is idempotent (the `customerNotifiedAt` gate fires the email exactly
  once).
- **C:** COD field parsing from the confirmed payload; reconciliation endpoint returns
  correct expected/collected/settled per order.

## Conventions / gotchas

- Work on a branch — `main` auto-deploys to the Hetzner box via SSH on push.
- Build `packages/db` and `packages/types` dist before the server build; `pnpm install`
  for new deps (pdf-lib).
- Phase A ships with no migration; B and C each add one (next is 0053).
- One shipment per order (`shipments_order_unique`) → create stays idempotent.

## Out of scope

- Return-waybill flow (the `returned` status is defined client-side but unused).
- Multi-parcel shipments (`packCount` stays 1).
- The full Phase D implementation (extraction + standalone service + CSV import).
