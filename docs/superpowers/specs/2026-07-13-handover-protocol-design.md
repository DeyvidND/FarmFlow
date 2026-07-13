# Приемо-предавателен протокол (goods handover protocol) — design

Date: 2026-07-13
Status: Approved (brainstorming), pending implementation plan
Repo: FarmFlow · Branch: `feat/handover-protocol`

## Problem

In the **farmer-as-seller** marketplace model (each farmer is the legal seller — own
Econt waybill, own COD/IBAN, self-reports to НАП), the platform operator physically
collects goods from a farmer and then does **лична доставка** (own delivery) to the end
customer. At the moment the operator takes another legal seller's goods, there is no
document recording the transfer. This is a chain-of-custody / legal gap: the operator
now holds goods it does not own, with no proof of what was handed over, by whom, when.

We need to generate a **приемо-предавателен протокол** (acceptance–handover protocol)
at pickup, documenting farmer → operator handover.

## Legal basis (research summary — юрист to confirm before go-live)

- The приемо-предавателен протокол is **not mandatory** under Bulgarian law, but is
  standard evidence to resolve disputes. Requisites are **not normatively fixed** — the
  document need only describe the transaction uniquely.
- Minimum content: **description of goods (type + quantity), date of transfer, signature
  of the receiving party**. Customarily two identical copies (one per party).
- Electronic signatures (ЗЕДЕУУ / eIDAS eqv.) have three tiers: ОЕП (simple), УЕП
  (advanced), КЕП (qualified). Only КЕП substitutes a handwritten signature **where the
  law requires written form**. This protocol has **no legally-required written form**, so
  an on-screen drawn signature + timestamp + captured metadata (ОЕП/УЕП-grade evidence)
  is sufficient. **КЕП is not required** (and farmers generally do not have one).

Decision: **on-screen (canvas) signature** captured at pickup, plus timestamp and
optional device/GPS metadata, rendered into an immutable PDF. This is legally adequate
for a non-written-form document and fits the online model (no printer at the farm).

> Owner has already stated a юрист + счетоводител must confirm the marketplace legal model
> before go-live. This spec is the engineering design; final wording of the protocol and
> the legal sufficiency of the signature approach are subject to that review.

## Decisions captured in brainstorming

- **Receiving party** = platform operator/admin who drives to the farmer (лична доставка),
  not a courier and not the end customer. (Courier / customer handover protocols are out
  of scope for this MVP.)
- **Signature** = digital, drawn on screen by both parties at pickup.
- **Unit** = one protocol per **farmer per pickup** — aggregates all items the operator
  collects from ONE farmer in one visit (across all that farmer's orders in the slot/day).
- **Approach A** (server-rendered immutable PDF) chosen over B (client HTML print) and C
  (paper, wet signature).

## Existing foundation (grounded in code)

- `farmers.legal` jsonb (`packages/db/src/schema.ts:1084-1099`, migration `0092_farmer_legal.sql`)
  holds the seller (предавач) legal identity: `kind` (individual/sole_trader/company),
  `name`, `eik`, `vatNumber`, `address`, `regNo`, `confirmedAt`. PUBLIC seller disclosure.
- `orders` + `order_items` (`schema.ts:392-527`). `order_items` snapshots `productName`,
  `quantity`, `priceStotinki`, `variantLabel`. **Note:** `order_items` has **no** `unit`
  and **no** `farmerId` column — the unit lives on `products`, and for **local delivery**
  the order is a single row spanning multiple farmers (`orders.farmerId` is set only on
  `delivery_type='courier'` split orders). Therefore per-farmer aggregation for a local
  pickup must join `order_items → products → products.farmerId`.
- `pdf-lib ^1.17.1` is present in `server` (`server/package.json:69`), used only to MERGE
  carrier label PDFs (`econt.mappers.ts:77-91`). Authoring a PDF from scratch is a NEW
  path. Serving pattern to reuse: `StreamableFile`, `application/pdf`, `disposition:inline`
  (`econt-standalone.controller.ts:254-266`).
- Latest migration `0102_farmer_geo`; journal (`packages/db/drizzle/meta/_journal.json`)
  has no idx gaps. **Next migration = `0103`.**
- Tenancy: `tenant_id` on every core entity; guards `@CurrentTenant()` / `@CurrentFarmer()`
  / `@Roles()`; service methods take `tenantId` first and scope every query.
- Per-tenant sequence precedent: `orders.orderNumber` (assigned on create, unique per tenant).

## Data model — `handover_protocols` (migration 0103)

```
id                     uuid pk        default uuid_generate_v4()
tenant_id              uuid           → tenants
farmer_id              uuid           → farmers (предавач)
slot_id                uuid null      → delivery_slots (onDelete set null) — which pickup
protocol_number        integer        per-tenant sequence (unique per tenant, like orders)
seller_snapshot        jsonb          frozen farmer legal identity at signing
receiver_snapshot      jsonb          frozen operator legal identity at signing
items                  jsonb          [{ productName, variantLabel, quantity, unit, priceStotinki, orderNumber }]
order_ids              uuid[]         orders that contributed (traceability)
seller_signature_png   text           base64 PNG (предал)
receiver_signature_png text           base64 PNG (приел)
meta                   jsonb null     { device?, gps?: {lat,lng}, userAgent? } — evidence trail
status                 text           'draft' | 'signed'
signed_at              timestamptz null
created_at             timestamptz    default now()
```

Indexes: `(tenant_id, created_at, id)` for the admin list keyset; unique
`(tenant_id, protocol_number)`; `(farmer_id)`.

**Immutability:** once `status='signed'`, the row is never updated. The record is the
source of truth; the PDF is a deterministic rendering regenerated on demand from the
snapshots + signatures. Snapshots freeze data at signing time (mirrors the
`order_items.productName` snapshot rationale).

## Receiver (operator) legal identity

`farmers.legal` covers the предавач. The приемащ (operator/platform) has no such field
yet. **Source = tenant settings** — add `settings.legal` on the tenant, mirroring the
`farmers.legal` shape (kind/name/eik/vatNumber/address). One-time operator configuration.
A protocol cannot be signed until the tenant has `settings.legal` filled (and the farmer
has `farmers.legal`), same gating rationale as "a farmer without legal can't be a live
seller".

## Flow + API (new NestJS module `handover`)

Module: `server/src/modules/handover/` — controller + service, `@UseGuards(JwtAuthGuard)`,
operator/admin role, `@CurrentTenant()` scoping.

1. Admin route/pickup screen shows, per farmer in the slot, a
   **„Приемо-предавателен протокол"** action.
2. `GET /handover/draft?farmerId=&slotId=` → aggregates `order_items → products` where
   `products.farmerId = :farmerId` across that slot's orders in status `confirmed`/
   `preparing`; groups by product (+variant), sums quantity; returns
   `{ seller, receiver, items }` for on-site review. 400 if farmer or tenant legal missing.
3. Both parties sign on-screen (two canvases: предал / приел).
4. `POST /handover` `{ farmerId, slotId, items, sellerSignaturePng, receiverSignaturePng,
   meta }` → validates, re-derives/verifies items server-side (don't trust client totals),
   assigns `protocol_number`, freezes snapshots from current `farmers.legal` +
   tenant `settings.legal`, inserts with `status='signed'`, `signed_at=now()`. Rejects if
   a signed protocol already exists for the same (farmer, slot) unless explicitly re-issued.
5. `GET /handover/:id/pdf` → regenerates the PDF via pdf-lib and streams it
   (`StreamableFile`, `application/pdf`, inline). Deterministic from the stored row.
6. `GET /handover?slotId=` / list for the admin; download later. **Email to farmer = phase 2.**

## PDF authoring

`server/src/modules/handover/handover-pdf.ts`:
- pdf-lib + **`@pdf-lib/fontkit`** (new dep) + a bundled Cyrillic TTF (DejaVu Sans or Noto
  Sans) in `server` assets — pdf-lib's standard fonts are Latin-only, so a Unicode TTF must
  be embedded via `registerFontkit` for Cyrillic to render.
- Layout: title „ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ" + № + date/time; **Предал** block (farmer
  legal: name, ЕИК/рег.№, address); **Приел** block (operator legal); items table
  (артикул | вариант | количество | ед. | ед. цена); total line; two signature blocks
  with the embedded PNGs + printed names; footer note ("Настоящият протокол удостоверява
  предаването на описаната стока…").

## Frontend surface

Admin (`client/`, Next.js), mobile-first (operator is on a phone at the farm):
- New draft-review + signature screen. Signature capture = **raw `<canvas>` pointer
  events** (no new dependency); export `toDataURL('image/png')`.
- Entry point: a per-farmer action on the delivery/route (own-delivery) screen.
- States: draft (review items) → signing (two pads) → signed (show №, download PDF).

## Scope (YAGNI)

**In MVP:** local-delivery pickup; single operator receiver; on-screen signatures;
deterministic server PDF (Cyrillic); admin list + download; per-farmer-per-pickup unit.

**Out of MVP:** КЕП / qualified signatures; admin→customer delivery protocol; automated
email of the PDF (phase 2); paper print stylesheet; Econt/Speedy courier-handover variant;
consolidation grouping; multi-language.

## Testing (TDD)

Service:
- aggregation groups items by `products.farmerId` correctly across multiple local-delivery
  orders in a slot; sums quantities; pulls `unit` from products.
- reject draft/sign when `farmers.legal` or tenant `settings.legal` is missing (400).
- `protocol_number` sequence is per-tenant and monotonic.
- snapshots freeze legal + items (later farmer legal edit does not mutate a signed row).
- reject a second signed protocol for the same (farmer, slot) without explicit re-issue.

Controller / tenancy:
- generating/reading a protocol for another tenant's farmer → 403.
- role gate: non-operator → 403.

PDF:
- produces a non-empty `application/pdf`.
- Cyrillic smoke: embedded TTF renders (no WinAnsi encoding error thrown).

## Open items for the юрист / owner

- Final legal wording of the protocol body and footer.
- Confirm on-screen (drawn) signature is acceptable evidence for this document, or whether
  a stronger tier is desired.
- Whether the operator must also produce an admin→customer delivery protocol (currently out
  of scope).
