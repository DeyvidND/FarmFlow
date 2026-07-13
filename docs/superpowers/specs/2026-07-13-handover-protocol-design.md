# Приемо-предавателни протоколи (goods handover + delivery receipt) — design

Date: 2026-07-13
Status: Approved (brainstorming), pending implementation plan
Repo: FarmFlow · Branch: `feat/handover-protocol`

## Problem

In the **farmer-as-seller** marketplace model (each farmer is the legal seller — own
COD/IBAN, self-reports to НАП), the platform operator does **лична доставка** (own
delivery): the operator physically collects goods from each farmer, then delivers to the
end customers, collecting **наложен платеж (cash on delivery)**. Two moments of custody
transfer currently have no document:

1. **Farmer → Operator** at pickup — the operator takes another legal seller's goods with
   no record of what/when/by whom (chain-of-custody gap).
2. **Operator → Customer** at delivery — no proof the customer received the goods (needed
   for disputes, the ЗЗП 14-day withdrawal clock, and the 2-year warranty).

We generate an **приемо-предавателен протокол** for (1) and a **разписка за получена
стока / приемо-предавателен протокол** for (2).

## Current operating mode (2026-07-13)

**Наложен платеж (COD, cash at handover) + лична доставка (own delivery) only.** No
prepaid/Stripe, no courier path for this feature's scope.

## Legal basis (research summary — юрист + счетоводител to confirm before go-live)

### Handover / delivery protocols (both documents)
- The приемо-предавателен протокол / стокова разписка is **not mandatory** under Bulgarian
  law, but is standard evidence to resolve disputes. Requisites are **not normatively
  fixed** — the document need only describe the transaction uniquely.
- Minimum content: **description of goods (type + quantity), date of transfer, signature
  of the receiving party**. Customarily two identical copies (one per party).
- For the customer leg it additionally serves as proof of delivery: start of the **ЗЗП
  14-day right-of-withdrawal** period and the **2-year legal warranty**.
- Electronic signatures (ЗЕДЕУУ / eIDAS): tiers ОЕП / УЕП / КЕП. Only КЕП substitutes a
  handwritten signature **where the law requires written form**. These protocols have **no
  legally-required written form**, so an on-screen drawn signature + timestamp + metadata
  (ОЕП/УЕП-grade) is sufficient; **КЕП is not required**. Wet signature on a printed copy
  is equally valid.

### ⚠️ Fiscal receipt (касова бележка, Наредба Н-18) — SEPARATE, MANDATORY, NOT built here
- НАП rule: the **customer's payment method** determines the fiscal-receipt obligation,
  not how the merchant receives the funds.
- **Cash collected on own delivery** → the seller (**each farmer**, as the legal seller)
  **must issue a fiscal receipt** from a **фискално устройство / СУПТО** (with QR).
- **Exception (does NOT apply here):** if COD runs through a **licensed postal operator
  with пощенски паричен превод** (Econt/Speedy), the courier's transfer receipt serves as
  the cash receipt and the seller need not issue a fiscal receipt. Own delivery collecting
  cash directly does not qualify for this exception.
- **Consequence for the current mode (COD + own delivery):** a fiscal receipt is legally
  required per farmer. The app's разписка is **evidence of delivery, not a fiscal receipt**
  and does NOT satisfy Н-18. Resolving this (касов апарат/СУПТО per farmer, or moving COD
  onto Econt пощенски превод) is an **accountant/owner compliance decision**, tracked in
  "Open items" — it is **out of scope for this build**.

> Owner has stated a юрист + счетоводител must confirm the marketplace legal model before
> go-live. This spec is the engineering design; final protocol wording, signature
> sufficiency, and the Н-18 fiscal-receipt path are subject to that review.

## Decisions captured in brainstorming

- **Two document kinds**, one engine:
  - `farmer_to_operator` — farmer (предал, `farmers.legal`) → operator (приел, tenant
    `settings.legal`). Unit = **one per farmer per pickup** (aggregates all that farmer's
    items across the slot's orders).
  - `operator_to_customer` — operator (предал) → customer (приел, from the order). Unit =
    **one per order/delivery** (the items of that one customer order).
- **Two signing modes:**
  - **Individual digital** — on-screen `<canvas>` signature per stop.
  - **Batch print** — one merged PDF of ALL of the day's protocols (every farmer pickup +
    every customer delivery for a date/slot) for the operator to carry and collect **wet
    signatures** on the round.
- **Approach A** (server-rendered immutable PDF, pdf-lib + Cyrillic) chosen over client
  HTML print and paper-only.

## Existing foundation (grounded in code)

- `farmers.legal` jsonb (`packages/db/src/schema.ts:1084-1099`, migration `0092_farmer_legal.sql`):
  seller legal identity — `kind` (individual/sole_trader/company), `name`, `eik`,
  `vatNumber`, `address`, `regNo`, `confirmedAt`.
- `orders` + `order_items` (`schema.ts:392-527`). `order_items` snapshots `productName`,
  `quantity`, `priceStotinki`, `variantLabel`. **No `unit` and no `farmerId` on
  `order_items`** — `unit` lives on `products`; for local delivery the order is a single
  row spanning farmers (`orders.farmerId` is set only on `delivery_type='courier'` split
  orders). Per-farmer pickup aggregation therefore joins
  `order_items → products → products.farmerId`. Customer-side uses the order's own items +
  `customerName/customerPhone/deliveryAddress`.
- `pdf-lib ^1.17.1` present in `server` (`server/package.json:69`); currently only MERGES
  carrier label PDFs via `econt.mappers.ts:77-91 mergePdfs(buffers)`. Authoring is NEW.
  **`mergePdfs` is reused for batch print.** Serving pattern: `StreamableFile`,
  `application/pdf`, inline (`econt-standalone.controller.ts:254-266`).
- Latest migration `0102_farmer_geo`; journal has no idx gaps. **Next migration = `0103`.**
- Tenancy: `tenant_id` everywhere; guards `@CurrentTenant()`/`@CurrentFarmer()`/`@Roles()`;
  services take `tenantId` first and scope every query. Per-tenant sequence precedent:
  `orders.orderNumber`.

## Data model — `handover_protocols` (migration 0103)

```
id                 uuid pk        default uuid_generate_v4()
tenant_id          uuid           → tenants
kind               text           'farmer_to_operator' | 'operator_to_customer'
farmer_id          uuid null      → farmers (set for farmer_to_operator; NULL for customer)
order_id           uuid null      → orders  (set for operator_to_customer; NULL for farmer)
slot_id            uuid null      → delivery_slots (onDelete set null) — the day/pickup batch
protocol_number    integer        per-tenant sequence (unique per tenant, like orders)
from_snapshot      jsonb          frozen legal/identity of the handing-over party
to_snapshot        jsonb          frozen legal/identity of the receiving party
items              jsonb          [{ productName, variantLabel, quantity, unit, priceStotinki, orderNumber }]
order_ids          uuid[]         orders that contributed (traceability; 1 for customer, N for farmer)
total_stotinki     integer        sum of items (COD amount for the customer leg)
from_signature_png text null      base64 PNG (digital) — null if paper/pending
to_signature_png   text null      base64 PNG (digital) — null if paper/pending
sign_mode          text           'digital' | 'paper' | 'pending'
meta               jsonb null     { device?, gps?: {lat,lng}, userAgent? }
status             text           'draft' | 'signed'
signed_at          timestamptz null
created_at         timestamptz    default now()
```

Roles by `kind`:
- `farmer_to_operator`: `from` = farmer (`farmers.legal`), `to` = operator (tenant
  `settings.legal`).
- `operator_to_customer`: `from` = operator (tenant `settings.legal`), `to` = customer
  (`orders.customerName/customerPhone/deliveryAddress`).

Indexes: `(tenant_id, created_at, id)` (admin list keyset); unique `(tenant_id,
protocol_number)`; `(farmer_id)`; `(order_id)`.

**Immutability:** once `status='signed'`, the row is never updated. The record is the
source of truth; the PDF is a deterministic rendering regenerated on demand. Snapshots
freeze data at signing (mirrors `order_items.productName`). A `pending` batch-printed
protocol may later be marked `signed` with `sign_mode='paper'` (records that a wet
signature was collected; no PNG stored).

## Receiver-legal (operator) identity

`farmers.legal` covers the farmer party. The operator has no such field yet. **Source =
tenant settings** — add `settings.legal` on the tenant, mirroring the `farmers.legal` shape
(kind/name/eik/vatNumber/address). One-time operator configuration. A `farmer_to_operator`
protocol cannot be created until both `farmers.legal` and tenant `settings.legal` exist; an
`operator_to_customer` protocol needs tenant `settings.legal` + the order's customer data.

## Flow + API (new NestJS module `handover`)

Module: `server/src/modules/handover/` — controller + service, `@UseGuards(JwtAuthGuard)`,
operator/admin role, `@CurrentTenant()` scoping.

### Individual (digital)
1. Admin route/pickup screen shows, per farmer (pickup) and per order (delivery), a
   **„Протокол"** action.
2. `GET /handover/draft?kind=&farmerId=&orderId=&slotId=` → builds the draft:
   - farmer leg: aggregate `order_items → products` where `products.farmerId=:farmerId`
     across the slot's orders in status `confirmed`/`preparing`; group by product(+variant),
     sum quantity, pull `unit` from products.
   - customer leg: the order's own items.
   Returns `{ kind, from, to, items, total }` for on-site review. 400 if required legal
   identity (farmer/tenant/customer) is missing.
3. Party signs on-screen (`from` and/or `to` canvases).
4. `POST /handover` `{ kind, farmerId?, orderId?, slotId?, items, fromSignaturePng?,
   toSignaturePng?, meta }` → validates, re-derives/verifies items server-side (never trust
   client totals), assigns `protocol_number`, freezes snapshots, inserts
   `status='signed'`, `sign_mode='digital'`, `signed_at=now()`. Rejects a duplicate signed
   protocol for the same (kind, farmerId|orderId, slotId) unless explicitly re-issued.
5. `GET /handover/:id/pdf` → regenerates + streams the single PDF (`StreamableFile`,
   `application/pdf`, inline). Deterministic from the row.
6. `GET /handover?slotId=&date=&kind=` → admin list.

### Batch print
- `POST /handover/batch` `{ date | slotId }` → for that day/slot, enumerate every farmer
  to be collected from and every customer order to be delivered; create any missing
  protocol rows as `status='draft'`, `sign_mode='pending'` (snapshots frozen at creation);
  return their ids.
- `GET /handover/batch.pdf?date=|slotId=` → render each of the day's protocols to a PDF
  and **merge them into one document** via `mergePdfs` (reused from `econt.mappers.ts`);
  stream `application/pdf`. Batch pages render blank signature lines for wet signing.
- After the round, the operator marks collected protocols signed:
  `PATCH /handover/:id/mark-signed` `{ sign_mode: 'paper' }` → sets `status='signed'`,
  `sign_mode='paper'`, `signed_at=now()` (no PNG). Immutable thereafter.

## PDF authoring

`server/src/modules/handover/handover-pdf.ts`:
- pdf-lib + **`@pdf-lib/fontkit`** (new dep) + a bundled Cyrillic TTF (DejaVu Sans or Noto
  Sans) in `server` assets — pdf-lib's standard fonts are Latin-only; embed a Unicode TTF
  via `registerFontkit` for Cyrillic.
- Title differs by kind: „ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ" (farmer leg) /
  „РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА" (customer leg) + № + date/time.
- Blocks: **Предал** (from_snapshot) / **Приел** (to_snapshot); items table (артикул |
  вариант | количество | ед. | ед. цена); total line (COD amount on the customer leg);
  two signature blocks — embedded PNG when `sign_mode='digital'`, else blank ruled lines
  (paper/pending) — plus printed party names; footer note.
- Batch = each protocol's single-PDF bytes merged with `mergePdfs`.

## Frontend surface

Admin (`client/`, Next.js), mobile-first (operator on a phone during the round):
- Per-farmer (pickup) and per-order (delivery) **„Протокол"** action → draft review +
  signature capture (**raw `<canvas>` pointer events**, `toDataURL('image/png')`, no new
  dep) → submit.
- A **„Печат за деня"** action on the route/day screen → calls `POST /handover/batch` then
  opens `GET /handover/batch.pdf` for printing.
- Protocol list for the day with per-row download + „маркирай подписан (хартия)".

## Scope (YAGNI)

**In MVP:** COD + own-delivery only; two kinds (`farmer_to_operator`,
`operator_to_customer`); individual digital signature; batch print (merged day PDF, wet
sign) + mark-signed(paper); deterministic server PDF (Cyrillic); admin list + download.

**Out of MVP:** КЕП/qualified signatures; **fiscal receipt (Н-18) — separate compliance,
NOT built**; prepaid/Stripe and courier-handover variants; automated email of PDFs;
consolidation grouping; multi-language.

## Testing (TDD)

Service:
- farmer-leg aggregation groups items by `products.farmerId` across multiple local-delivery
  orders in a slot; sums quantities; pulls `unit` from products.
- customer-leg draft uses the order's own items + customer identity; total = COD amount.
- reject draft/sign when required legal identity is missing (farmer/tenant `settings.legal`/
  customer) → 400.
- `protocol_number` is per-tenant and monotonic.
- snapshots freeze legal + items (a later farmer-legal edit does not mutate a signed row).
- reject a second signed protocol for the same (kind, target, slot) without re-issue.
- batch: `POST /handover/batch` creates one `pending` row per farmer pickup + per customer
  delivery for the day, idempotently (re-running does not duplicate).
- `mark-signed` flips `pending`→`signed` with `sign_mode='paper'`; a signed row is immutable.

Controller / tenancy:
- generating/reading a protocol for another tenant's farmer/order → 403.
- role gate: non-operator → 403.

PDF:
- single PDF is a non-empty `application/pdf`; correct title per kind.
- batch PDF merges N protocols into one non-empty document.
- Cyrillic smoke: embedded TTF renders (no WinAnsi encoding error thrown).

## Open items for the юрист / счетоводител / owner

- **Fiscal receipt (Н-18) for COD + own delivery** — decide: касов апарат/СУПТО per farmer,
  or route COD through Econt пощенски паричен превод. The app's разписка does not satisfy
  this. **Blocking for legal go-live, not for building the protocols.**
- Final legal wording of both protocol bodies + footers.
- Confirm on-screen (drawn) signature is acceptable evidence, or whether a stronger tier is
  wanted.
- Customer not present at delivery (left with a household member / at the door): confirm the
  "received without signature" + timestamp handling is acceptable.
