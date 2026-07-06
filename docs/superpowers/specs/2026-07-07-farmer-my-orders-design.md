# Farmer "Моите поръчки" screen — design

Date: 2026-07-07

## Problem

A producer sub-account (`role='farmer'`, a `farmers` catalog row with its own
login) currently has no fulfillment view. `/payments` (Плащания) exists but is
money-first: it only lists orders in `PAYMENT_COUNTED_STATUSES` (confirmed,
preparing, out_for_delivery, delivered) and folds each producer's line items
into a single subtotal — it never shows *what* to pack, and it hides
still-pending or cancelled orders entirely.

There is no screen where a farmer can see, per order, which of their own
products were ordered and in what quantity, across every status including
pending and cancelled — the actual "what do I need to prepare / did this get
cancelled" view.

## Scope

New read+act screen, **`/my-orders`** ("Моите поръчки"), additive to the
existing `/payments` screen — not a replacement. Farmer-only in practice
(route is opened to `admin` too, mirroring `/payments`, so an owner can preview
a specific producer's view via `?farmerId=`).

Out of scope: no new DB migration, no new courier/shipment logic, no changes to
`/payments`, no notifications/emails, no "Моите поръчки" equivalent for the
owner's tenant-wide `/orders` screen (that already shows everything).

## Decisions (confirmed with user)

1. **Coverage**: every order containing at least one of the farmer's own
   products — including orders shared with another producer. Shared orders are
   flagged (`shared: true`) and their action buttons are disabled, matching the
   existing IDOR gate in `updateStatusForFarmer` / `setCodOutcomeForFarmer`.
2. **Statuses**: all of them (pending, confirmed, preparing, out_for_delivery,
   delivered, cancelled) — this is the key difference from `/payments`, which
   deliberately excludes pending/cancelled. Actions (mark delivered, set COD
   outcome) reuse the existing `PATCH /orders/:id/status` and
   `PATCH /orders/:id/cod-outcome` endpoints; no new mutation endpoints.
3. **Navigation**: a new sidebar tab, `/payments` stays as-is. Two screens with
   distinct jobs: Моите поръчки = fulfillment, Плащания = money.

## Backend

### New service method: `ordersForFarmer`

`server/src/modules/orders/orders.service.ts`, next to `paymentsForFarmer`
(~line 558). Same keyset-pagination shape (`(created_at, id)` cursor, same
`cursorTs` / `decodeCursor` / `KEYSET_TS` helpers) but:

- **No status filter** — drop the `inArray(orders.status, PAYMENT_COUNTED_STATUSES)`
  condition that `paymentsForFarmer` applies. Optional `?status=` query param
  narrows to one status (pending/confirmed/preparing/out_for_delivery/delivered/cancelled),
  matching `OrdersQueryDto`'s existing status enum.
- **Line items, not just a subtotal**: select the farmer's own `orderItems` rows
  (product name, quantity, unit price) per order via a second query keyed by
  the page's order ids — a payments-style single aggregated `sum()` throws away
  exactly the "what do I pack" detail this screen exists to show.
- **`shared: boolean`** per order: `true` when the order has any `orderItems`
  row whose `products.farmerId` differs from the acting farmer. Computed with
  a `EXISTS` subquery (or a second grouped query over all `orderItems` for the
  page's order ids) — same join shape already used in `updateStatusForFarmer`'s
  ownership check, just read-only and batched for the page instead of
  one-order-at-a-time.
- Same free-text search (`paymentSearchCond`) and tenant/farmer scoping
  (`eq(orders.tenantId, tenantId)`, `eq(products.farmerId, farmerId)` via the
  join) as `paymentsForFarmer`.

New types in `orders.service.ts` (exported, next to `PaymentOrder`/`PaymentsPage`):

```ts
export interface FarmerOrderItem {
  productId: string;
  productName: string;
  quantity: number;
  priceStotinki: number;
}

export interface FarmerOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  status: string;
  deliveryType: string;
  paymentMethod: PaymentChannel;
  day: string;
  createdAt: string | null;
  slotFrom: string | null;
  slotTo: string | null;
  codOutcome: 'received' | 'refused' | null;
  codOutcomeReason: string | null;
  /** This farmer's own subtotal on the order (their items only). */
  subtotalStotinki: number;
  /** This farmer's own line items on the order. */
  items: FarmerOrderItem[];
  /** True when the order also contains another producer's items — mutation
   *  actions are disabled client-side and already 403 server-side. */
  shared: boolean;
}

export interface FarmerOrdersPage {
  orders: FarmerOrder[];
  nextCursor: string | null;
}
```

### New route: `GET /orders/mine`

`server/src/modules/orders/orders.controller.ts`, declared as a literal route
before `:id` (same reason `production` and `payments` are — otherwise `:id`
would capture it). `@Roles('admin', 'farmer')`, same `effectiveFarmerId`
pattern as `payments()`:

```ts
@Get('mine')
@Roles('admin', 'farmer')
@ApiQuery({ name: 'status', required: false })
@ApiQuery({ name: 'q', required: false })
@ApiQuery({ name: 'cursor', required: false })
@ApiQuery({ name: 'limit', required: false })
@ApiQuery({ name: 'farmerId', required: false, description: 'Owner-only: scope to one producer' })
mine(@CurrentUser() user: TenantRequestUser, @Query() query: MyOrdersQueryDto) {
  const scope = effectiveFarmerId(user.role, user.farmerId, query.farmerId);
  if (!scope) throw new BadRequestException('farmerId required for admin');
  return this.ordersService.ordersForFarmer(user.tenantId, scope, query);
}
```

An admin hitting `/orders/mine` without `?farmerId=` gets a 400 (there is no
tenant-wide "mine" for an owner — `/orders` already covers that; this route
only exists to preview one producer's view).

New `MyOrdersQueryDto` (`server/src/modules/orders/dto/my-orders-query.dto.ts`)
mirrors `PaymentsQueryDto` but with a `status` enum field instead of `method`.

### Actions: reuse, no new endpoints

`PATCH /orders/:id/status` and `PATCH /orders/:id/cod-outcome`
(`orders.controller.ts:89`, `:104`) already carry `@Roles('admin', 'farmer')`
and already branch to `updateStatusForFarmer` / `setCodOutcomeForFarmer` when
the caller is scoped — which already reject non-`delivered` transitions and
shared orders. The My Orders screen calls these exact same endpoints; no
backend changes needed here.

## Frontend

### New page: `client/src/app/(admin)/my-orders/page.tsx`

Server component, same shape as `payments/page.tsx`: SSR-fetch page 1 of
`GET /orders/mine` with the session token, pass to a client component.

### New component: `client/src/components/my-orders/my-orders-client.tsx`

Card-per-order list (not a table — mirrors the payments screen's card
layout for readability on a farmer's phone):

- Header: order number, day/date, status badge, payment-method badge.
- Customer: name + phone (click-to-call), matching `payments-client.tsx`'s
  existing customer-contact pattern.
- Line items: this farmer's own products with qty, e.g. "Домати × 3".
- Subtotal (this farmer's own, not the order total).
- **Shared badge**: when `shared: true`, an inline note ("Споделена поръчка —
  само собственикът може да я маркира") replaces the action buttons instead of
  rendering disabled buttons with no explanation — this directly fixes the UX
  gap flagged in the earlier audit (farmer hits a silent 403 with no context).
- Actions (hidden when `shared`):
  - "Маркирай доставена" — only shown when `status !== 'delivered'` and
    `status !== 'cancelled'`; calls `PATCH /orders/:id/status` with
    `{ status: 'delivered' }`, reusing the existing mutation helper from
    `payments-client.tsx` (`updateOrderStatus` / equivalent in `api-client.ts`).
  - COD outcome buttons ("Получих парите" / "Не получих") — only shown when
    `paymentMethod === 'cod'` and `codOutcome === null`; reuses the existing
    `PATCH /orders/:id/cod-outcome` mutation from the payments screen.
- Status filter (chips: Всички / Чакащи / Потвърдени / В процес / Доставени /
  Отказани) — client-side query param, refetches via `GET /orders/mine`.
- Free-text search box (name/phone/email/order number) — same debounce pattern
  as `payments-client.tsx`.
- "Зареди още" cursor-based load-more, same as payments.

### Navigation

`client/src/components/layout/sidebar.tsx`:
- Add to `FARMER_NAV` (after "Продукти", before "Плащания" — fulfillment
  belongs next to catalog management, not next to money):
  ```ts
  { href: '/my-orders', label: 'Моите поръчки', Icon: ClipboardList, desc: 'Какво трябва да приготвиш — по поръчка и статус.' },
  ```
- `client/src/components/layout/farmer-route-guard.tsx`: add `/my-orders` to
  `FARMER_ALLOWED`.

## Client types

`PaymentOrder`/`PaymentsPage` are not shared via `@fermeribg/types` — the
client redefines its own copies in `client/src/lib/api-client.ts:620,660`
alongside a `getPayments()` fetch helper. Follow the same pattern: add
`FarmerOrder`, `FarmerOrderItem`, `FarmerOrdersPage` interfaces and a
`getMyOrders()` helper next to them in `api-client.ts`.

## Testing

Existing coverage splits payments tests into `orders.payments.spec.ts`
(service-level keyset/scoping) and assertions in `orders.controller.spec.ts`
(route → service dispatch, incl. `effectiveFarmerId` branching). Mirror that
split for My Orders:

- New `orders.mine.spec.ts` (service-level, same shape as `orders.payments.spec.ts`):
  - Returns only orders containing the farmer's own products.
  - Includes pending and cancelled orders (unlike `paymentsForFarmer`).
  - `shared: true` set correctly when another farmer's item is present on the
    order; `items`/`subtotalStotinki` still reflect only the acting farmer's
    own lines in that case.
  - `status` query param narrows correctly.
  - Cursor pagination round-trips (copy `orders.payments.spec.ts`'s keyset
    cursor test shape).
- `orders.controller.spec.ts` additions (same pattern as its existing
  `payments()` assertions at lines 10–45):
  - Farmer token → `ordersForFarmer` called with the token's own `farmerId`,
    query `farmerId` ignored.
  - Admin token with `?farmerId=` → `ordersForFarmer` called with that id.
  - Admin token without `?farmerId=` → 400, `ordersForFarmer` never called.
- No new E2E required beyond manual verification in the dev preview (existing
  farmer sub-account test fixtures from the subaccount-logins work should
  already provide a login to click through with).

## Non-goals / explicitly deferred

- No bulk actions (mark-all-delivered) — out of scope, not asked for.
- No push/email notification when a new order lands — out of scope.
- No change to how `/orders` (owner's tenant-wide screen) displays shared
  orders — that screen already sees everything and needs no shared-order
  affordance.
