# Move orders to another day ("Премести поръчки на друг ден")

**Date:** 2026-07-08
**Status:** Approved design — ready for implementation plan
**Branch:** feat/courier-shipment-consolidation (current) → new feature branch

## Problem

A farmer running **own/personal delivery** (лична доставка) can end up with too many
orders on one delivery day (e.g. Vasil has many Thursday orders). Today the only way to
rebalance is to edit each order and reassign it to an **already-published** slot day. But
the farmer may want to move orders to a day that is **not** open for orders in the
storefront (e.g. an unopened Friday) — without exposing that day to shoppers.

We want a one-click bulk tool in the **Поръчки** (Orders) tab that lets the farmer pick a
source day, select its personal-delivery orders, and move them to **any** date. Customers
should be notified by email that the delivery day changed, with an invitation to call the
farm if the new day doesn't suit them.

## Scope / decisions (locked with the user)

- **Interaction:** one toolbar button, move **by day** (bulk). Not per-order.
- **Target day:** **any** future calendar date (free picker). The target need NOT be a
  published storefront day.
- **Selection:** show the source day's movable orders as checkboxes, **all pre-checked**;
  farmer can uncheck some.
- **No email address:** still move the order; the email is simply skipped.
- **Channel:** email only (Resend-over-SMTP, existing transport). **No SMS** in this
  iteration (no SMS provider exists yet; can be a follow-up task).
- **Gating:** the button shows only when own delivery is enabled
  (`tenant.deliveryEnabled && methods.ownSlots`).
- **Movable orders:** `deliveryType='address'` and status ∈ {`pending`, `confirmed`}
  (the already-editable states). Delivered/cancelled are never moved.
- **Migration:** none. No schema change is required (see mechanism below).

## Core mechanism — hidden slot via `isActive=false`

A local-delivery order's delivery day lives on its joined slot row:
`orders.slotId → delivery_slots.date` (`packages/db/src/schema.ts` L359, L316-345). Route
planning, the Плащания "day", the Orders "Доставка" cell, and `scheduledForDay` all derive
the day from that slot — so reassigning `slotId` moves the order everywhere at once, with
**zero** blast radius. That is why we key the feature on the slot, not on a new
`order.deliveryDate` column (which would force touching every one of those consumers).

To move an order to a day that is **not** open in the storefront, we **find-or-create** a
slot row for the target date and, when creating a new one, set **`isActive=false`**:

- Storefront picker `SlotsService.findPublicBySlug` filters `eq(deliverySlots.isActive, true)`
  (`server/src/modules/slots/slots.service.ts` L251) → a hidden slot is **invisible** to
  shoppers.
- Admin/list `SlotsService.findAll` does **not** filter on `isActive` (L60-79) → the farmer
  still sees the day and its orders.
- The order→slot join (`orderWithSlot`, `orders.service.ts` L67-74) carries `slotDate`
  regardless of `isActive` → the moved order shows its new day in the Orders screen.

If the target date **already** has a slot row (a genuinely-open day, or a hidden row from a
prior move), we **reuse** it — preserving the one-slot-row-per-`(tenant, date)` invariant
that `SlotsService.create` enforces (L110-120).

### Why no capacity / lead-time guard on the move

The existing edit path uses `lockAndCheckSlot` (`orders.service.ts` L1383-1413), which
rejects same-day and throws when the slot is full. The move is a **deliberate** farmer
action to pile orders onto their own day, so the reschedule path **does not** enforce
capacity or the "not today" rule. (A newly created move-target slot is hidden anyway, so it
can never over-expose the day on the storefront.) The reschedule still runs inside a
transaction; when reusing an existing slot we `SELECT ... FOR UPDATE` it to avoid races with
a concurrent checkout on that same day.

## Frontend

### Button placement
`client/src/components/orders/orders-client.tsx`, toolbar at L215-244 (search box · filter
tabs `ml-auto` · «Обяснения»). Add a **«Премести на друг ден»** button **between the filter
tabs and the «Обяснения» button**. Render it only when a new `ownDeliveryEnabled` prop is
true.

`OrdersClient` gains `ownDeliveryEnabled: boolean`, supplied by
`client/src/app/(admin)/orders/page.tsx` (SSR), computed from the same delivery-config
source the settings screen uses (`tenant.deliveryEnabled` + `methods.ownSlots`). The exact
fetch is pinned during planning (mirror how `methods-section.tsx` reads the config).

### Modal (`reschedule-orders-modal.tsx`, new)
On open, fetch movable orders (`GET /orders/reschedulable`) and group by `slotDate`.

1. **«От кой ден»** — a `<select>` of upcoming days that have movable orders, labelled
   `<weekday>, <dd.mm> · <n> поръчки` (e.g. `четвъртък, 10.07 · 8 поръчки`). Default: the
   nearest such day.
2. **Order checkboxes** — the selected day's movable orders, **all checked by default**:
   `#<orderNumber> · <customerName> · <total €>`. Farmer can uncheck.
3. **«За кой ден»** — a native `<input type="date">`, `min` = today (Europe/Sofia). Free
   choice. Must differ from the source day (validate).
4. **Notice** — "Клиентите с имейл ще получат известие, че поръчката е преместена, и покана
   да се обадят, ако денят не им е удобен."
5. **Confirm** — «Премести N поръчки» → `POST /orders/reschedule`. Toast success, refresh
   the orders list (`load()`), close modal.

### API client (`client/src/lib/api-client.ts`) + types
- `listReschedulableOrders(): Promise<ReschedulableOrder[]>` → `GET orders/reschedulable`.
- `rescheduleOrders(orderIds: string[], toDate: string): Promise<{ moved: number; toDate: string }>`
  → `POST orders/reschedule`.
- Types: `ReschedulableOrder = { id, orderNumber, customerName, customerPhone, totalStotinki, status, slotDate }`.

## Backend (`orders` module, admin-only)

### `GET /orders/reschedulable`
Literal route declared **before** `:id` (like `production` / `payments` / `mine`,
`orders.controller.ts` L46-98). `@Roles('admin')`, tenant-scoped. Returns movable orders:
`deliveryType='address'`, status ∈ {pending, confirmed}, `slotDate >= today`
(Europe/Sofia), joined to their slot for `slotDate`. Shape = `ReschedulableOrder` above.
Client groups by `slotDate`.

### `POST /orders/reschedule`
`@Roles('admin')`, tenant-scoped. DTO `RescheduleOrdersDto`:
- `orderIds: string[]` — 1..N uuids (`@IsUUID('all', { each: true })`, `@ArrayNotEmpty`).
- `toDate: string` — `YYYY-MM-DD` (`@Matches(/^\d{4}-\d{2}-\d{2}$/)`).

`OrdersService.rescheduleOrders(tenantId, dto)`:
1. Reject `toDate < bgToday()`.
2. In a transaction:
   - Load the orders `WHERE id IN (orderIds) AND tenantId = tenant`, joined to their current
     slot for `fromDate`. Keep only `deliveryType='address'` & status ∈ {pending, confirmed}.
     Throw `BadRequestException` if none remain.
   - **find-or-create** the target slot for `(tenant, toDate)`: `SELECT ... FOR UPDATE`; if
     absent `INSERT { tenantId, date: toDate, isActive: false, generated: false, capacity }`
     (capacity is cosmetic here — the row is hidden and the move skips the capacity check; a
     sensible default such as the moved-order count keeps the admin view honest). Optionally
     stamp `driverNote='Преместени поръчки'` for farmer context.
   - For each order not already on the target slot: record `fromDate`, `set slotId = target.id`.
   - `bustPayments(tenantId)`.
3. After commit, fire-and-forget per moved order **with** a `customerEmail`:
   `orderEmail.sendMoved(order.id, fromDate, toDate)` (mirrors the `sendForOrder` call at
   `orders.service.ts` ~L1104). Orders without an email are moved but not emailed.
4. Return `{ moved: <count>, toDate }`.

## Email (`OrderConfirmationService.sendMoved`)

`server/src/modules/order-email/order-confirmation.service.ts`. Add a public
`sendMoved(orderId, fromDate, toDate)` that reuses `withImages` / `deliveryLine` / the
branded green template. Two changes to the existing render helpers:
- Extend the `phase` union (or add a dedicated small render branch) to cover `'moved'`, with
  a subject and an intro paragraph naming the old → new day and the call-to-action.
- Also select `tenants.settings` in the tenant lookup so we can read
  `settings.contact.phone` (jsonb; see `project_farmflow_contacts_favicon`) for the "call us"
  line. If no phone is set, omit that clause gracefully.

Copy:
- **Subject:** `Промяна в деня на доставка — <farmName>`
- **Body:** "Здравей, <име>! Денят за доставка на поръчка #N е променен от **<fromDate>** на
  **<toDate>**. Ако този ден не ти е удобен, обади се на **<телефон>**, за да се уговорим за
  друг ден."

Dates are rendered server-side as `dd.mm (weekday)` via a small Europe/Sofia `bg-BG`
`Intl.DateTimeFormat` helper (client `relDayLabel` is not available on the server). Stream:
`'transactional'`.

## Testing

- **Unit (service):** `rescheduleOrders` — (a) creates a hidden `isActive=false` slot for an
  unopened date and reassigns; (b) reuses an existing slot for the target date (no duplicate
  row); (c) filters out non-address / delivered / cancelled ids; (d) rejects a past `toDate`;
  (e) no-ops an order already on the target day; (f) leaves orders without email moved and
  unemailed.
- **Slot leak guard:** a `isActive=false` slot created by a move does **not** appear in
  `findPublicBySlug` but **does** appear in `findAll`.
- **Email:** `sendMoved` builds the from→to subject/body and includes the farm phone when
  present; skips silently when the order has no email.
- **Frontend:** modal groups by day, pre-checks all, disables confirm when target = source
  or no orders selected.

## Out of scope (possible follow-ups)

- SMS notification channel (no provider yet).
- Per-order "move" button inside the order side-panel.
- An audit trail column (`previous_slot_id` / `rescheduled_at`).
