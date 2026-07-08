# Courier shipment consolidation — admin merge + suggestions

**Date:** 2026-07-08
**Status:** Design approved
**Scope:** `packages/db` (one migration), `server` (shipments consolidation endpoints + suggestion query + waybill COD source fix), `delivery-web` (suggestion card + consolidate modal + debt breakdown). The storefront and checkout intake are untouched.

## Problem

A shopper on a marketplace storefront (e.g. пазар Чайка) can put products from several farmers into one cart and choose courier delivery. `createCourierOrders` ([server/src/modules/orders/orders.service.ts](../../../server/src/modules/orders/orders.service.ts)) then splits that cart into **one single-farmer COD order per farmer**, each with its own `draft` shipment. The split is correct for accounting (per-farmer turnover / Плащания read `orders.farmerId`), but it means the customer physically receives **N separate parcels**, pays **N courier fees**, on **N different days** — one from each farmer, who are at different locations (e.g. Варна, Добрич).

The farmers can, offline, bring their goods to one "collector" farmer who ships a single parcel. Nothing in the system lets the operator represent that: today N draft shipments each produce their own waybill.

## Objective

Let the operator merge several courier draft shipments (for the same customer) into **one physical waybill** — collected by one designated farmer (the sender), COD equal to the group's total — while keeping the N per-farmer orders intact for accounting. The system **suggests** which shipments to merge; the operator confirms and picks the collector. Money owed back to the non-collector farmers is shown but **not** settled by the platform (offline reconciliation).

Confirmed with the operator:
- Farmers are at different physical locations; consolidation only works with a "collector" farmer. Physical movement of goods to the collector is handled offline.
- The operator drives consolidation from the admin (tenant-wide) profile.
- COD reconciliation is offline — the system only **displays** each farmer's share of the collected COD.
- The merge is a manual post-checkout action (the operator waits until goods physically reach the collector before printing one waybill), assisted by an automatic suggestion.

## Non-goals (YAGNI)

- No settlement ledger, no inter-farmer payout tracking, no "mark settled" workflow. Debt is display-only.
- No regional/hub data model, no per-farmer geocoordinates. The collector is chosen by the operator per group.
- No checkout change. Orders still split per farmer exactly as today.
- No automatic consolidation at checkout time.
- No cross-customer or cross-address merging. A group is one customer + one destination.

## Design

### 1. Configuration option

`settings.delivery.consolidateCourier: boolean` (default `false`) — the "option on the delivery service".

- `false` → no suggestions surfaced; the consolidate endpoint refuses (404/hidden feature). Current N-parcel behavior unchanged.
- `true` → suggestions computed and the consolidate/undo actions are enabled.

Read via the existing `DeliveryConfig` accessors in [server/src/modules/orders/delivery-pricing.ts](../../../server/src/modules/orders/delivery-pricing.ts) (add a `consolidateCourierEnabled(cfg)` helper alongside `codEnabled` etc.).

### 2. Data model — one migration

Two additions to `shipments` ([packages/db/src/schema.ts](../../../packages/db/src/schema.ts)):

- `consolidation_group_id uuid` — nullable, references `shipments.id` (`on delete set null`). Every member of a consolidated group carries the **master's** shipment id here; the master carries **its own** id (so `consolidation_group_id = id` identifies the master, and a non-null value that differs from `id` identifies a child).
- New `status` value `'consolidated'` for **child** shipments — the superseded parcels that will never get their own waybill. (`status` is free-form `text`; no enum migration needed. Document the value.)

Index: `shipments_consolidation_group_idx` on `(consolidation_group_id)` for the debt-breakdown and undo lookups.

The **master** is the collector farmer's existing draft shipment. On consolidation it gets:
- `consolidation_group_id = <its own id>`
- `cod_amount_stotinki = <sum of every member order's total>` (what the courier collects)
- `carrier = <collector's chosen carrier>` (Econt/Speedy from the collector's sub-namespace)

The master keeps its own `order_id` (the collector's order) — so accounting for the collector's own share is unchanged. The COD it *collects* (group sum) is deliberately larger than its own order total; the difference is what it owes the sibling farmers, shown in the breakdown.

No new table, no order-less master row. One nullable self-referencing column + one documented status value.

### 3. Suggestion engine

`GET /shipments/consolidation-suggestions` — tenant-scoped, returns candidate groups of draft courier shipments for the same customer + destination.

Grouping key (in priority order):
1. `orders.visitor_hash` when present — this is the strongest signal, because `createCourierOrders` stamps the **same** visitor hash on every split leg of one checkout.
2. Fallback for null visitor hash: `(normalized customer_phone, delivery_city, delivery_address)`.

Filters:
- `orders.delivery_type = 'courier'`, `shipments.status = 'draft'`, `shipments.consolidation_group_id IS NULL` (not already merged), `orders.status` not `cancelled`.
- Only groups with **≥ 2** members are returned.

Shape:
```
{ suggestions: [
  { key, customerName, customerPhone, deliveryCity, deliveryAddress,
    sumStotinki,
    members: [ { shipmentId, orderId, orderNumber, farmerId, farmerName, totalStotinki } ] }
] }
```

Gated on `consolidateCourierEnabled(cfg)` — returns `{ suggestions: [] }` when off.

### 4. Consolidate + undo endpoints

**`POST /shipments/consolidate`** — body `{ collectorFarmerId: string, memberOrderIds: string[], carrier?: 'econt' | 'speedy' }`.

Validation (all-or-nothing, 400 on any failure, nothing mutated):
- Every `memberOrderIds` resolves to a tenant-scoped order that is `delivery_type='courier'`, whose shipment is `status='draft'` with no waybill (`econt_shipment_number` / `tracking_number` null) and `consolidation_group_id IS NULL`.
- `collectorFarmerId` is the farmer of one of the members **and** is courier-ready (`farmerCourierReady`, [server/src/modules/orders/courier-eligibility.ts](../../../server/src/modules/orders/courier-eligibility.ts)).
- `carrier`, if given, is one the collector has configured; else default to the collector's single configured carrier (400 if ambiguous/none).
- ≥ 2 members.

Transaction:
- Master = the collector member's shipment → set `consolidation_group_id = master.id`, `cod_amount_stotinki = Σ member order totals`, `carrier = <resolved>`.
- Each other member shipment → `consolidation_group_id = master.id`, `status = 'consolidated'`.
- **No carrier call.** This only groups. The waybill is created later through the existing master finalize/ship flow, producing one parcel with the group COD.

Returns the resulting group (master + members + per-farmer breakdown).

**`POST /shipments/:masterId/unconsolidate`** — only while the master is still `draft` with no waybill. Clears `consolidation_group_id` on the master and all children, restores children to `status='draft'`, resets `master.cod_amount_stotinki` to its own order's COD. 400 if the master already has a waybill (physical parcel already dispatched — undo would desync the courier).

Both endpoints gated on `consolidateCourierEnabled(cfg)`.

### 5. Waybill COD source fix

Today the carrier waybill COD comes from the **order** total (`EcontService.codAmountFor(order)` reads `order.totalStotinki`; Speedy mirrors this). For a consolidated master, the waybill must collect the **group sum**, which lives on `shipment.cod_amount_stotinki`, not the collector's order total.

Change: when creating the waybill, prefer `shipment.cod_amount_stotinki` as the COD when the shipment is a consolidation master (`consolidation_group_id = id`); otherwise keep deriving from the order (unchanged for every non-consolidated shipment). Apply in both `EcontService` and `SpeedyService` waybill-creation paths (the shared `codAmountFor` helper is the natural seam). Keep the existing "no COD when `paidAt` set / payment is online" guards — consolidated courier is always COD, so this is additive.

### 6. delivery-web UI (dostavki)

In [delivery-web/src/components/shipments-client.tsx](../../../delivery-web/src/components/shipments-client.tsx) and the shipments page:

- **Suggestion card** at the top of the shipments list (one per suggested group): "Обедини N пратки · <клиент> · <адрес> → 1 товарителница", with the group total. Rendered only when `consolidateCourier` is on and suggestions exist.
- **Consolidate modal**: lists members (farmer name + amount), a radio/select to choose the **collector** (sender) from the members (only courier-ready farmers selectable), a carrier pick when the collector has both. Confirm → `POST /shipments/consolidate`.
- **After consolidation**: the master row shows a **per-farmer debt breakdown** — "дължи се: Ферма A €5, Ферма B €8" — computed from the group members' order totals. Child rows are badged "обединена" (or collapsed under the master). An "Раздели" (unconsolidate) action on the master while it is still draft.

All calls go through [delivery-web/src/lib/api-client.ts](../../../delivery-web/src/lib/api-client.ts).

### 7. Debt display (money stays offline)

For a master shipment: the members are `shipments WHERE consolidation_group_id = master.id` plus the master's own order. Each member's share = its `order.totalStotinki` under `order.farmerId`. The courier collects `master.cod_amount_stotinki` (the sum). The breakdown is pure display — no `codSettledAt` writes, no payout records. Existing per-order COD outcome tracking (`codCollectedAt`, cod-risk) stays on the master shipment as-is.

## Edge cases

- Toggle `consolidateCourier` off → suggestions empty, consolidate/undo refuse. Existing orders already consolidated stay consolidated (data survives a toggle flip).
- A member order is cancelled after consolidation → excluded from the debt breakdown (breakdown filters `order.status != 'cancelled'`); the master COD is **not** auto-recomputed (operator un-consolidates and re-does if the parcel changed). Document this.
- Collector farmer not courier-ready (carrier disconnected between checkout and merge) → consolidate 400.
- Single-member "group" → never suggested, consolidate rejects (< 2).
- Master already has a waybill → unconsolidate 400.
- Un-geocoded / missing `delivery_city` → the members still group by the available key; the waybill create path already derives the city (unchanged).
- Two independent checkouts by the same customer to the same address → distinct `visitor_hash` (daily-rotating, per checkout) keeps them separate; only same-checkout legs group. If both hashes are null, the phone+address fallback would merge them — acceptable (same customer, same destination, same day is a reasonable merge; operator can un-consolidate).

## Testing

Server:
- **Suggestion grouping:** three courier draft shipments from one checkout (shared visitor hash) → one suggestion of 3; a shipped/consolidated/non-courier shipment is excluded; a lone farmer yields no suggestion.
- **Fallback key:** null visitor hash → grouped by phone + city + address.
- **Consolidate happy path:** master gets `cod = Σ`, `consolidation_group_id = self.id`, children `status='consolidated'` + `group_id = master.id`; N orders untouched.
- **Consolidate guards:** shipped member → 400; non-ready collector → 400; collector not in group → 400; < 2 members → 400; cross-tenant member → rejected.
- **Waybill COD:** finalizing a consolidated master creates a waybill whose COD equals the group sum (not the collector's order total); a normal shipment still uses the order total.
- **Undo:** draft master → restores children to draft, clears group, resets master COD; master with waybill → 400.
- **Toggle gating:** off → suggestions empty + endpoints refuse.
- **Debt breakdown:** per-farmer shares sum to the master COD; a cancelled member drops out.

delivery-web:
- Suggestion card renders only when enabled and a group exists; consolidate modal restricts collector to courier-ready members; post-merge breakdown renders the per-farmer amounts.

Existing checkout / `createCourierOrders` specs stay green (checkout path unchanged).
