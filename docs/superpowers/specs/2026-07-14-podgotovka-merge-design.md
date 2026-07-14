# Подготовка — merge Производство + Утре into one page

**Date:** 2026-07-14
**Branch:** feat/farmer-profile-v1-sections (or a fresh branch off main)
**Status:** design approved, spec for review

## Problem

The farmer panel has two adjacent screens that show the **same underlying data on
two different axes**:

- **Производство** (`/production`) — confirmed orders aggregated **by product**
  ("приготви 40 кайсии общо"). Any day (date-nav, default today). Tick per-product
  in **browser localStorage** (per-device, ephemeral). Aggregates across the whole
  tenant with a farmer filter. Shows a pending-confirm nudge + progress panel.
- **Утре** (`/tomorrow`) — confirmed orders split **by order** ("опаковай №123 за
  Иван, обади му се ако не смогваш"). Fixed to tomorrow. Per-order state
  Чака→В процес→Готово saved **server-side** (durable, cross-device). Scoped to one
  farmer (picker). Shows customer contact + a gap-call banner.

They overlap conceptually and confuse: two nav items, two progress systems that
can't reconcile, two mental models for "what do I prepare".

## Goal

One page, **Подготовка**, with a **view toggle**: `По поръчка` ⇄ `По продукт`.
Same dataset, two axes. One durable source of truth for "готово".

## Decisions (locked with the user)

1. **Single source of truth = orders.** The `По продукт` view is **read-only** — a
   harvest shopping list. All ticking happens in `По поръчка` (server-side
   per-order state). Product progress is **derived** from fulfilled orders, so the
   two views can never disagree. The old localStorage product-tick system is
   **removed**.
2. **Date:** keep a flexible date-nav, but **default to УТРЕ** (the main prep
   horizon — you harvest today for tomorrow's delivery).
3. **Name:** the merged nav item is **Подготовка**.
4. **Scoping:** everything is **per-farmer** (matches Утре). Single-farmer shop →
   auto-scoped, no picker. Multi-farmer shop → the existing farmer picker. The
   product view aggregates that one farmer's items. We **lose** Производство's
   "all farmers at once" cross-total — acceptable, since each farmer harvests their
   own. (Add an "Всички" option later only if asked. YAGNI.)

## Architecture

### One dataset powers both views

Both views render from a single per-order feed for `(farmerId, date)`. The product
view is that feed aggregated by product on the frontend. Because "готово" lives on
orders, product progress (`набрани/общо`) is computed from the same rows → it can
never drift from the order view.

### Backend

**New:** `GET /orders/prep?date=&farmerId=` → `PrepSummary`.

```ts
interface PrepSummary {
  date: string;              // yyyy-mm-dd (the queried day)
  day: string;               // display day of the orders (coalesce slot date / created)
  confirmedOrders: number;   // = orders.length
  pendingOrders: number;     // pending orders on the day that contain this farmer's items
  multiFarmer: boolean;
  orders: TomorrowOrder[];    // reuse the existing per-order shape (contact, slot, items, state)
}
```

- Implement `prepForFarmer(tenantId, farmerId, date?)` in `orders.service.ts` by
  generalizing `tomorrowForFarmer`: replace the hard-coded
  `bgAddDays(bgToday(), 1)` with a `date` param (default = tomorrow for safety),
  keep the exact same query (it already `leftJoin`s `deliverySlots` for
  `scheduledForDay` — **do not remove that join**, per the scheduledForDay JOIN
  contract).
- Add a `pendingOrders` count scoped to `(tenant, day, status='pending')` **and**
  this farmer's items (join `orderItems`→`products` on `products.farmerId`,
  `count(distinct orders.id)`). Mirror `production`'s pending query but farmer-scoped.
  Also needs the `deliverySlots` leftJoin for `scheduledForDay`.
- Reuse the existing `TomorrowOrder` / `TomorrowOrderItem` interfaces (rename is
  optional; keeping them avoids churn).
- Controller: add `@Get('prep')` (literal route — declare it **before** `:id`,
  same as the existing `tomorrow` route). Owner must scope to a farmer, mirroring
  the `tomorrow` handler's `farmerId` resolution.

**Unchanged:** `PATCH /orders/:id/fulfillment` (`setFulfillment`) already has no
date guard — it works for any day's order. No write-side change.

**Removed:** `GET /orders/production` and the `production()` service method +
`ProductionSummary` / `ProductionItem` types (product view is now derived
frontend-side). Grep for other callers first — if none outside `/production`,
delete; otherwise keep the method but drop the route. `orders.tomorrow.spec.ts`
becomes `orders.prep.spec.ts` (parameterize the date; add a pending-count case).

### Frontend

**New route** `client/src/app/(admin)/prep/page.tsx` (server component):
- Resolve `role` / `multiFarmer` / `farmers` / `defaultFarmerId` exactly as
  `tomorrow/page.tsx` does today.
- Default date = tomorrow (Europe/Sofia). Read `?date=` for the date-nav.
- Fetch `PrepSummary` from `orders/prep?date=&farmerId=`.
- Render `<PrepClient>`.

**New component** `client/src/components/prep/prep-client.tsx`:
- Header: `Подготовка` + farmer picker (owner + multiFarmer, ≥2 farmers) — reuse
  Утре's picker.
- Date-nav (reuse `DateNavBar`, generalized to push `?date=` on `/prep` instead of
  `/production`). Default view lands on tomorrow.
- Pending-confirm nudge from `pendingOrders` (link to `/orders`, as Производство
  does today).
- View toggle `[По поръчка] [По продукт]` + a derived `X/Y бр готови` summary.
- **По поръчка:** the existing `TomorrowClient` card list — customer тел/имейл,
  slot window, items, state buttons Започвам/Готово (calls `setFulfillment`), gap
  banner. This is the only place you tick.
- **По продукт:** the existing `PrepList` layout **but read-only** — group the
  order feed's items by `productName`, `totalQty = Σ qty`,
  `pickedQty = Σ qty where order.fulfillmentState==='fulfilled'`,
  `orderCount = distinct orders`. Show the progress panel + "преди бране" tip.
  Rows are not tappable (no localStorage).

Toggle state may persist in `localStorage` (which axis you last used) — cosmetic,
optional.

**Redirects:** `/tomorrow` and `/production` → `/prep` (preserve muscle memory and
any bookmarks). Use `redirect('/prep')` in the two old `page.tsx` files (keep the
`?date` query on the production one), or `next.config` redirects. Delete the old
`tomorrow/` and `production/` component folders after porting their logic into
`prep/`.

**Sidebar** (`client/src/components/layout/sidebar.tsx`): replace the two entries
(`/production` "Производство" and `/tomorrow` "Утре") with one:
`{ href: '/prep', label: 'Подготовка', Icon: CalendarCheck, desc: 'Какво да
приготвиш за деня — по поръчка или по продукт.' }`. Decide the `gated` flag:
Производство was `gated:true`, Утре was not — keep **not gated** (Утре's behavior)
so every farmer sees it, unless the gate is intentional (confirm during impl).

## Data flow

```
GET /orders/prep?date=&farmerId=  ──► PrepSummary { orders[], pending, ... }
        │
        ├─ По поръчка: render orders[] as cards; tick → PATCH /orders/:id/fulfillment
        │                                              (optimistic, re-derive product view)
        └─ По продукт: aggregate orders[].items by product;
                       pickedQty from orders where fulfillmentState==='fulfilled'
```

Ticking an order in `По поръчка` updates the in-memory `orders[]` → switching to
`По продукт` reflects it immediately (same state, no refetch).

## Edge cases

- **Empty day:** no confirmed orders → empty state in both views ("Няма поръчки за
  този ден"). Pending nudge still shows if there are pending orders.
- **Multi-farmer shared order:** the feed already returns only *this* farmer's line
  items on a shared order (`tomorrowForFarmer` filters `products.farmerId`). Product
  aggregation and progress use only those lines. Consistent.
- **Order fulfilled but has multiple products:** each of its products counts its
  full qty as picked. That's correct — the whole order is done.
- **Date with slot vs slotless orders:** `scheduledForDay` already handles the
  slot-date-vs-created-date rule via the `deliverySlots` leftJoin. Preserve the join.
- **Past dates:** allowed (you might review yesterday). `setFulfillment` still works
  (status guard, not date guard).

## Out of scope (YAGNI)

- "Всички фермери" cross-farmer aggregate in the product view.
- Bulk-confirm from the nudge (the `confirmPending` service method exists; wire
  later if wanted).
- Expanding a product row to see contributing orders.

## Testing

- **Backend:** `orders.prep.spec.ts` — port `orders.tomorrow.spec.ts`; assert the
  date param selects the right day, per-farmer item filtering holds, and
  `pendingOrders` counts only that farmer's pending orders on the day.
- **Frontend:** unit-test the order→product aggregation helper (pure fn):
  total/picked/orderCount from a fixture order list, incl. a fulfilled multi-product
  order and a shared-order single-farmer slice.
- **Manual (preview):** open `/prep` → lands on tomorrow, `По поръчка` default;
  tick an order Готово; switch to `По продукт` → its products show as picked and the
  progress bar moves; date-nav to today shows today's set; `/tomorrow` and
  `/production` redirect to `/prep`.

## Migration / deploy notes

- No DB migration (schema unchanged; `order_fulfillments` already exists).
- Backend adds a route and removes one — deploy **backend-first** if the frontend
  starts calling `/orders/prep` before the old `/production` route is gone (per the
  backend-first deploy rule).
