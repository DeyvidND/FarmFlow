# Fully editable order (OrderPanel) — design

Date: 2026-07-07

## Problem

The order-detail panel (`client/src/components/orders/order-panel.tsx` →
`OrderPanel` / `OrderDetailBody`) is read-only. A farmer who takes an order by
phone, or needs to correct a customer typo (wrong phone, wrong flat number),
change the delivery slot, or adjust what was ordered (add a forgotten item, drop
an out-of-stock one, fix a quantity) has no way to do it from the panel. The
only mutations today are status (`PATCH /orders/:id/status`) and the наложен-
платеж outcome (`PATCH /orders/:id/cod-outcome`). Everything else — contact,
address, slot, notes, line items, total — is frozen at checkout.

## Scope

Make the order fully editable **in place** from the existing OrderPanel: a
single "Редактирай" toggle flips the whole panel body into a form, one **Запази**
persists all changes in one request, **Откажи** discards. Adds one backend
mutation endpoint (`PATCH /orders/:id`) plus its service logic and DTO.

Editable: customer contact (name / phone / email), delivery **values** (street +
бл./вх. note, or Econt office string), delivery **slot** (day + time window),
customer notes, and **line items** (add / remove products, change quantity) with
a fee-preserving total recompute.

Out of scope (explicit boundaries — see Decisions A & B):
- **Switching the delivery *method*** (pickup ↔ local ↔ Econt office ↔ Econt door
  ↔ per-farmer courier). You edit values *within* the order's current type only.
- **Item/total edits on card-paid orders** (`paidAt ≠ null`).
- No new DB migration (all target columns already exist on `orders` /
  `order_items`).
- No changes to the separate Доставки app / waybill creation.

## Decisions (confirmed with user)

1. **Edit coverage: everything, including products.** Contact, delivery values,
   slot, notes, and line items are all editable. Total is recomputed from the
   new item subtotal plus the preserved delivery fee.
2. **UX: one "Редактирай" toggle.** The whole panel body becomes a form; a
   single **Запази** saves all fields in one `PATCH`; **Откажи** discards. Not
   per-field inline pencils.
3. **Editable statuses: pending + confirmed only.** `delivered` and `cancelled`
   are read-only history — the **Редактирай** button is hidden and the backend
   rejects the edit.

### A. Delivery-**method** switch is OUT of v1

You can fix the address/office/slot of an order, but not convert it from (say)
local delivery to an Econt office order. Switching the method reshuffles the fee
(re-quote), the geocode/city, the Econt office **code** (needed for a real
waybill, sourced from the Econt office-search API), and per-farmer courier
eligibility — a materially larger, separate workflow. The panel's job here is
correcting an existing order, so type stays fixed and the fields *within* that
type are editable.

### B. Card-paid orders lock item/total edits

If `paidAt ≠ null` (Stripe card payment captured), the item list and therefore
the total are **read-only**; contact / address / slot / notes remain editable.
Rationale: the customer already paid a specific amount online — silently
changing the items would desync money owed vs money paid, with no refund/charge
path in this flow. COD (`payment_method='cod'`) and unpaid orders are fully
editable including items.

## Data model (no migration)

All target columns already exist:
- `orders`: `customerName`, `customerPhone`, `customerEmail`, `deliveryAddress`,
  `deliveryNote`, `deliveryCity`, `deliveryLat`, `deliveryLng`, `econtOffice`,
  `slotId`, `notes`, `totalStotinki`.
- `order_items`: `productId`, `productName`, `quantity`, `priceStotinki`,
  `variantId`, `variantLabel`.

Slot day/time come from the `deliverySlots` row joined via `orders.slotId`
(there is no denormalized slot time on `orders`).

**Fee handling (critical):** `totalStotinki = itemsSubtotal + shipping`, and
shipping is *folded in* at checkout, never stored on its own
(`checkout.service.ts` `createAndFold`). So on an item edit the fee is preserved
arithmetically:

```
oldSubtotal = Σ(old item qty × price)
shipping    = order.totalStotinki − oldSubtotal      // ≥ 0, clamp
newSubtotal = Σ(new item qty × price)
newTotal    = newSubtotal + shipping
```

We do **not** re-run the carrier quote on an item edit — the original shipping
component is carried over unchanged.

## Backend

### Endpoint

`PATCH /orders/:id` — **owner/admin only** (`@Roles('admin')`). Producer
sub-accounts (`role='farmer'`) do not get full edit; editing customer contact /
address / cross-farmer items is an owner action. (Contrast with `/status` and
`/cod-outcome`, which are farmer-scoped.)

### DTO — `UpdateOrderDto` (all fields optional; partial patch)

```
customerName?:  string
customerPhone?: string
customerEmail?: string | null
deliveryAddress?: string          // street only (address/econt_address/courier)
deliveryNote?:  string | null     // бл./вх./ет./ап.
econtOffice?:   string            // display string (econt type)
slotId?:        string | null     // reassign or clear the slot
notes?:         string | null
items?:         { productId: string; variantId?: string; quantity: number }[]
```

`items` present ⇒ **full replacement** of the order's lines. Each `quantity ≥ 1`;
empty array rejected (an order must have ≥ 1 line). Reuse the checkout item
validation (active product, mandatory variant selection when the product has
live variants).

### Service — `updateOrder(id, tenantId, dto)`

1. Load the order (tenant-scoped) + its items; `404` if missing.
2. **Guards:**
   - status ∈ {`delivered`, `cancelled`} → `400`/`409` "Поръчката не може да се
     редактира".
   - `dto.items` present **and** `paidAt ≠ null` → `400` "Платена поръчка —
     артикулите не могат да се променят".
3. **Geocode** (only if `deliveryAddress` changed and the type geocodes —
   `address` / `econt_address` / `courier`): call `MapsService` **before** the
   transaction (network I/O outside locks). On success set
   `deliveryLat/Lng/deliveryCity`; on failure keep the old coords and return a
   soft warning flag (non-fatal — the text still saves).
4. **Transaction:**
   - Set scalar fields present in the DTO (contact, address, note, econtOffice,
     notes, geocode result).
   - **Slot reassign** (if `slotId` in DTO and differs from current):
     - `null` → clear `slotId`.
     - value → lock the target `deliverySlots` row; reject if its date is today
       (`Слотът вече не е достъпен за днес`) or if a non-cancelled order **other
       than this one** already holds it (`ConflictException 'Слотът е запълнен'`).
       Then set `slotId`.
   - **Items replace** (if `dto.items` present):
     - **Restore** the OLD items' reserved stock — active availability windows
       (`restoreRemaining`) and variant `stockQuantity` — reusing the logic from
       the `updateStatus` cancel branch (extract a private `restoreItemsStock(tx,
       items)` helper so cancel and edit share it).
     - **Re-reserve** the NEW items through the existing `reserveCartItems`
       locking path (variant validation, availability decrement, variant stock
       decrement, courier-disabled backstop when the order is carrier delivery),
       but **skip its slot block**. Item edits never change slot occupancy, so
       the slot today-guard and one-per-slot capacity must NOT be re-checked here
       — re-running them would wrongly reject a same-day order or self-conflict on
       the order's own slot. Slot capacity is enforced *only* in the slot-reassign
       step above, and only when moving to a genuinely different slot. Add a
       `slotCheck?: { skip?: boolean }` param to `reserveCartItems`, passing
       `skip: true` on the edit path (checkout intake keeps the check).
     - Delete old `order_items`, insert the new priced lines (snapshot
       `productName`, `priceStotinki` via `effectivePriceStotinki`, `variantLabel`).
     - Recompute `totalStotinki` with the fee-preserving formula above.
5. Return the serialized updated order (same shape `findOne` returns).

**Locking / ordering:** the restore + re-reserve both run inside the one
transaction, acquiring row locks in the same id-ordered discipline as
`reserveCartItems` (deadlock-free). Restoring old stock before re-decrementing
means editing an order that keeps most of its items nets to roughly zero stock
movement and won't spuriously trip an availability limit.

### api-client

`export const updateOrder = (id: string, body: UpdateOrderInput) =>
  apiFetch<Order>(\`orders/${id}\`, { method: 'PATCH', body });`

## Frontend

### OrderPanel

- Local `editing` state. **Редактирай** button (pencil) in the header, rendered
  only when `status ∈ {pending, confirmed}`.
- While `editing`: `OrderDetailBody` renders its edit form; the footer's
  status-action cluster is replaced by **Запази** / **Откажи**.
- One `updateOrder` call on Запази; on success replace the panel's order with the
  response, exit edit mode, `toast.success('Запазено')`. On error `toast.error`.

### Edit form (inside OrderDetailBody, edit mode)

- **Клиент:** name / phone / email text inputs. Phone required.
- **Доставка:**
  - `address` / `econt_address` / `courier`: street input + бл./вх. note input.
  - `econt`: office string input.
  - `pickup`: read-only "Вземане от място".
  - Small note under a changed address: "Адресът ще се геокодира при запис".
- **Ден и час** (local-delivery types only): `<select>` of the farm's upcoming
  free slots (`listSlots(from, to)` over the next ~14 days, excluding today and
  already-full slots), current slot preselected, plus a "Без час" option to
  clear. Hidden for Econt/courier.
- **Бележка:** notes `<textarea>`.
- **Продукти:** each line = name + qty stepper (− / value / +) + remove ×.
  "Добави продукт" opens a product picker (reuse the existing product list/search
  source); products with live variants require a variant choice. Live subtotal +
  recomputed total (subtotal + carried fee) shown beneath. Whole block hidden /
  read-only when `paidAt ≠ null`, with a one-line "Платена поръчка — артикулите
  са заключени" hint.
- Inline validation: phone non-empty, ≥ 1 item, every qty ≥ 1, variant chosen
  where required. Запази disabled until valid.

## Testing

Backend e2e (`server`), reusing the existing orders e2e harness:
- contact-only edit persists.
- address edit triggers geocode → lat/lng/city updated.
- slot reassign to a free slot succeeds; to a full slot → `409`; re-saving the
  order onto its **own** current slot does **not** conflict.
- items replace: total = new subtotal + preserved fee; old stock restored + new
  decremented; empty items rejected.
- guards: editing a `delivered`/`cancelled` order rejected; item edit on a
  card-paid (`paidAt`) order rejected while a contact edit on it succeeds.

Frontend: drive the panel in preview — toggle edit, change a field / qty / slot,
Запази, confirm the panel reflects the update and the list total changes.

## Files touched

- `server/src/modules/orders/dto/update-order.dto.ts` (new)
- `server/src/modules/orders/orders.controller.ts` (add `PATCH :id`)
- `server/src/modules/orders/orders.service.ts` (`updateOrder`, extract
  `restoreItemsStock`, add `excludeOrderId` to the slot-capacity check)
- `client/src/lib/api-client.ts` (`updateOrder`)
- `client/src/lib/types.ts` (`UpdateOrderInput`)
- `client/src/components/orders/order-panel.tsx` (edit mode + form)
- possibly a small `slot-picker` / `product-picker` helper under
  `client/src/components/orders/`
- `server/test/orders*.e2e-spec.ts` (edit cases)
