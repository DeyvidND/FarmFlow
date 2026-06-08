# Farmer emails + per-farmer daily digest + production farmer filter

Date: 2026-06-08
Branch: `feat/farmer-emails-daily-digest`

## Problem

Products link to farmers (`products.farmerId`), but farmers have no email and
receive nothing. The farm owner gets one daily digest of all deliveries; there
is no per-farmer breakdown. On the "Подготви продукти" (production prep) page
there is no way to view only one farmer's products.

## Goal

1. Farmers can have an email address.
2. At the daily digest run, each farmer (with an email) also gets an email
   listing **their** products' deliveries for the day. The main owner digest
   stays unchanged — it still gets the full unfiltered list.
3. On the production prep page, when multi-farmer mode is on, a dropdown lets the
   user view **All** products or filter to a single farmer's products.

## Non-goals

- No per-farmer or per-tenant on/off toggle beyond email presence (email set =
  opt-in). YAGNI.
- No public exposure of farmer email on the storefront.
- No change to the main owner digest content or schedule.
- No separate evening cron — farmer emails ride the existing 07:00 run.

## Attribution chain

```
orderItems.productId → products.farmerId → farmers.id / farmers.name
```

Both `orderItems.productId` and `products.farmerId` are nullable. An item that
resolves to no farmer ("unassigned") appears only in the main owner digest and
under "All" / "Без фермер" on the production page — never in a farmer email.

## Design

### 1. Farmer email field

- **Migration `0031`**: `ALTER TABLE farmers ADD COLUMN email text;` (nullable).
- **`packages/db/src/schema.ts`** farmers table: add `email: text('email')`.
- **`client/src/lib/types.ts`** `Farmer`: add `email: string | null`.
- **`server/.../farmers/dto/create-farmer.dto.ts`**: add optional
  `email?: string` with `@IsOptional() @IsEmail()`. `UpdateFarmerDto` inherits
  via `PartialType`.
- **`farmers.service.ts`**: confirm create/update persist `email` (pass-through
  of the DTO; add the field explicitly if the service whitelists columns).
- **`farmer-panel.tsx`**: add an email `<input type="email">` after the phone
  field; include `email` in the `data` payload sent to `createFarmer` /
  `updateFarmer`.
- **`api-client.ts`**: extend the createFarmer/updateFarmer payload type with
  `email?`.

### 2. Per-farmer daily digest

Lives in the existing `DigestService` (`server/src/modules/digest/`). Reuses the
07:00 Europe/Sofia cron, `EmailService`, and the address-vs-Econt split logic.

**Gating** (per tenant, inside the existing cron loop):
- Only tenants with `multiFarmer = true`.
- For each farmer of that tenant with a non-null `email`.
- Skip the farmer if they have zero items in today's confirmed orders.

**`buildFarmerDigest(tenantId, farmerId, date): Promise<DigestResult | null>`**
- Returns `null` when the farmer has no items that day.
- Query A — orders for the day (confirmed, tenant-scoped) that contain ≥1 item
  whose `product.farmerId = farmerId`. Select the same delivery fields as
  `buildDigest` (id, deliveryType, customerName, deliveryAddress, deliveryCity,
  econtOffice, slotFrom, slotTo).
- Query B — that farmer's line items for those orders: `orderId, productName,
  sum(quantity)` grouped by `orderId, productName`.
- Compose:
  - **Prep summary**: farmer's products with total qty across the day
    (aggregate Query B by productName).
  - **Delivery breakdown**: per order, the existing address/Econt destination +
    slot, followed by that order's farmer-owned line items (product + qty).

**Rendering**: add `renderFarmerHtml` / `renderFarmerText` (or extend the
existing renderers to accept an optional per-order items list + a prep-summary
block). Keep the existing `renderHtml`/`renderText` for the owner digest intact.

**Cron** (`runDailyDigests`): after sending the owner digest for a tenant, if
the tenant has `multiFarmer`, load its farmers with email, call
`buildFarmerDigest` for each, and `sendMail` to `farmer.email`. Subject e.g.
`Твоите доставки за днес — FarmFlow`. Per-farmer try/catch so one failure does
not abort the rest. Log sent/skip per farmer.

**Test endpoint** `POST /digest/test`: after the owner test digest, also build +
send farmer digests for the tenant (so the feature is verifiable on demand).
Return counts, e.g. `{ sent, farmersSent, reason? }`.

**Privacy note**: a farmer email includes customer name + address/Econt
destination for orders that contain their products. Acceptable — the farm owner
controls who has an email set.

### 3. Production page farmer dropdown

- **`orders.service.ts` `production()`**: extend the query to
  `LEFT JOIN products ON orderItems.productId = products.id` and
  `LEFT JOIN farmers ON products.farmerId = farmers.id`. Group by
  `productName, farmers.id, farmers.name`. Each `ProductionItem` gains
  `farmerId: string | null` and `farmerName: string | null`.
- `ProductionSummary` gains `multiFarmer: boolean` (read `tenants.multiFarmer`).
- **`client/src/lib/types.ts`**: mirror the new `ProductionItem` fields and the
  `multiFarmer` flag.
- **`prep-list.tsx`**:
  - When `summary.multiFarmer` is true, render a dropdown: **Всички** + one
    entry per distinct farmer present in `items` (+ "Без фермер" if any item has
    a null farmer).
  - A `selectedFarmer` state (`'all' | farmerId | 'none'`) filters the rendered
    items. `totalQty` / `doneQty` / progress recompute on the filtered set.
  - localStorage tick state stays keyed by `productName` — unaffected by
    filtering.

## Edge cases

- Order spanning multiple farmers → each farmer email shows only their slice;
  owner digest shows the whole order.
- `productId` null (deleted product) or `farmerId` null → unassigned; excluded
  from all farmer emails; shown under "All"/"Без фермер" on production page.
- Farmer with email but no items today → no email (build returns null).
- `multiFarmer` off → no farmer emails at all; production dropdown hidden.
- Invalid email on a farmer → rejected at DTO validation (cannot be saved).

## Testing

- `production()` returns `farmerId`/`farmerName` per item and `multiFarmer`;
  groups unassigned items into the null bucket.
- `buildFarmerDigest`: correct filtering to the farmer's orders/items; prep
  summary totals; per-order item slicing; returns `null` when no items.
- Multi-farmer order: each farmer's digest contains only their items.
- DTO: valid email accepted, invalid rejected, omitted allowed.

## Files touched

- `packages/db/drizzle/0031_*.sql` (new)
- `packages/db/src/schema.ts`
- `server/src/modules/farmers/dto/create-farmer.dto.ts`
- `server/src/modules/farmers/farmers.service.ts` (verify email persists)
- `server/src/modules/digest/digest.service.ts`
- `server/src/modules/digest/digest.controller.ts` (test endpoint)
- `server/src/modules/orders/orders.service.ts`
- `client/src/lib/types.ts`
- `client/src/lib/api-client.ts`
- `client/src/components/farmers/farmer-panel.tsx`
- `client/src/components/production/prep-list.tsx`
- tests (digest, orders production, farmer DTO)
