# Courier delivery per farmer — design

Date: 2026-06-29
Status: approved (brainstorming) — pending spec review before implementation plan

## Context & goal

The marketplace (фермерски пазари, the "chaika" storefront) currently supports only
local delivery (recurring slots) and on-site market pickup — effectively limited to the
Varna/Dobrich area. We want customers **anywhere in Bulgaria** to be able to order, with
**each farmer shipping their own products via their own courier account** (Speedy/Econt),
reusing the already-built standalone delivery app (dostavki).

Two hard constraints come from accounting:

1. A courier order must **never mix products from multiple farmers**.
2. The platform must **not handle courier money and must not charge delivery** — each farmer
   (via their courier) collects directly.

## Roles

- **Super-admin** (Deyvid): platform owner.
- **Farmer-admin** (Vasil): tenant admin of фермерски пазари. Decides **which farmers offer
  courier**, from the tenant **"Фермери"** section.
- **Farmer**: a producer with a subaccount login (`users.farmer_id`). Connects their **own**
  carrier credentials and ships their **own** courier orders.

## Storefront delivery options (chaika)

Three options at checkout:

1. **Лична доставка** — existing local delivery (slots), run centrally by the marketplace.
   Always available to all farmers. Add info text: *"само за Варна, Добрич и околностите — или
   вземане на място от пазара."*
2. **Вземане от пазара** (`pickup`) — existing.
3. **Куриер** (NEW) — nationwide. Visible **only when every product in the cart is from a
   courier-enabled farmer** (decision (a) below).

## Key rules

- **Single farmer per courier order.** A multi-farmer cart that chooses courier is **split into
  one order per farmer** at checkout.
- **COD only** (наложен платеж). Each farmer/their courier collects that farmer's order total at
  delivery. The platform moves no money and adds no delivery fee.
- Each participating farmer ships from their **own delivery account** (own Speedy/Econt),
  reusing the dostavki app via SSO.

## Architecture / flow

```
Customer on chaika → picks delivery:
  1. Лична доставка   → info: only Varna/Dobrich + surroundings, or market pickup
  2. Вземане от пазара → pickup
  3. Куриер (NEW, nationwide)
        │
        ▼ checkout SPLITS the cart by farmer
  N single-farmer orders (delivery_type='courier', COD, no platform fee)
        │
        ▼ distribution engine (same backend)
  each → draft shipment in THAT farmer's delivery account
        │
        ▼ farmer: panel → "Доставки" button (SSO) → dostavki scoped to them
  sees today's drafts → picks carrier → ships → label + COD
```

## Components

### 1. Delivery account per farmer
- Generalize the delivery server's scope key from `tenantId` to **`deliveryAccountId`**. Today
  there is exactly one delivery account (== the marketplace tenant); we add one per
  participating farmer.
- New table `delivery_accounts`: `id` (uuid pk), `tenant_id` (marketplace tenant fk),
  `farmer_id` (fk, unique), `package_enabled` (bool), `created_at`.
- Carrier credentials and the sender/COD profile become keyed by `delivery_account_id` (today
  keyed by tenant). The existing single marketplace delivery account keeps working unchanged.
- **Interface:** the delivery modules (`econt-app`, `speedy`) accept a `deliveryAccountId`
  scope identical in shape to the current tenant scope — a drop-in substitution.

### 2. Per-farmer SSO into dostavki
- The farmer panel gets a **"Доставки"** button that mints a delivery-handoff token scoped to
  the farmer's `delivery_account_id`. The existing `/auth/delivery-handoff` mints
  `{sub, tid, type:'delivery-handoff'}`; here the scope is the delivery account, not the
  marketplace tenant.
- Opens the dostavki app scoped to that farmer's account.

### 3. Storefront courier option + cart split
- chaika renders the courier option per the eligibility rule.
- Checkout API: when `delivery=courier`, **split the cart by `farmer_id`** into N orders, each
  single-farmer, `delivery_type='courier'`, `payment_method='cod'`, **no platform delivery
  fee**. The customer is told: *"поръчката ще се раздели на N пратки — всяка с наложен платеж при
  доставка."*

### 4. Order distribution / auto-feed engine
- On creation of a courier order, create **one draft shipment** in the target farmer's delivery
  account: recipient = customer (name, phone, address, city), **COD = order total** (stotinki),
  weight (sum of product weights, or a configurable default), contents (summary).
  **Idempotent**: exactly one draft per order (keyed by order id).
- The draft lands in the farmer's dostavki *"днешни доставки"* queue. The farmer reviews, picks
  the carrier, ships, prints the label; COD is set on the waybill.
- **Carrier is chosen by the farmer at ship time** (not by the customer), so `orders.carrier`
  stays null until shipped.

### 5. Carrier-connect, two synced surfaces
- A farmer can enter Speedy/Econt credentials from **two places**: the **farmer panel**
  (`client/`) and **dostavki**.
- **Single source of truth:** credentials live once per `delivery_account_id`. Both surfaces
  read/write the same store. After saving in one, the other reflects a **"вече свързан"** / saved
  state (it pulls the current connection status).

### 6. Vasil's courier management (tenant "Фермери")
- In the tenant **"Фермери"** section, Vasil toggles `farmers.courier_enabled` per farmer.
- Enabling provisions the farmer's `delivery_account` (`package_enabled = true`) if absent.
- **Eligibility** for the storefront = `courier_enabled` AND a `delivery_account` exists AND
  ≥1 carrier credential connected.

## Data model changes

- `farmers.courier_enabled` boolean not null default false.
- New `delivery_accounts` (`id`, `tenant_id`, `farmer_id` unique, `package_enabled`, `created_at`).
- Carrier credential / profile storage gains a `delivery_account_id` scope (back-compatible with
  the existing marketplace account).
- `orders.farmer_id` uuid nullable — set for courier/split orders, null for legacy mixed/local
  orders.
- `delivery_type` enum gains `'courier'`.
- Link order → draft shipment (the shipment carries `order_id`).

All migrations are **hand-written** (drizzle-kit generate has been unreliable since 0059); the
runtime migrator only needs the `.sql` files + `_journal.json`.

## Edge / error handling

- **Mixed-eligibility cart** (decision a): courier is hidden unless all cart farmers are
  courier-enabled. Surface a short hint when it is hidden.
- **Farmer enabled but no carrier connected**: storefront eligibility requires ≥1 connected
  carrier, so this is prevented at order time; if it still happens, the draft is created and the
  farmer is prompted to connect a carrier before shipping.
- **COD amount excludes any platform delivery fee** (there is none for courier).
- **Weight unknown**: a configurable default weight per draft.
- **Idempotency**: re-processing an order never creates duplicate drafts.

## Testing

- **Unit:** cart split by farmer; eligibility logic; distribution creates exactly one draft per
  courier order with correct COD/recipient; credential store shared across both surfaces; SSO
  token scoped to `delivery_account_id`.
- **E2E:** a multi-farmer courier checkout → N single-farmer orders → N drafts land in N delivery
  accounts → each farmer ships via dostavki (label + COD) against the live carrier sandboxes,
  then voids.

## Phasing

- **Phase 1 (foundation):** `delivery_accounts` + scope generalization; carrier-connect on both
  surfaces (synced store); Vasil's courier toggle in "Фермери"; per-farmer SSO "Доставки" button.
- **Phase 2 (storefront):** courier delivery option + eligibility + cart split into single-farmer
  COD orders.
- **Phase 3 (automation):** order distribution engine — courier orders auto-create drafts in the
  farmer delivery accounts.

## Non-goals (YAGNI)

- Card payment for courier (COD only for now).
- Partial-cart courier for mixed-eligibility carts (decision a keeps it all-or-nothing).
- Platform-charged delivery fees / markup on courier.
- Cross-farmer consolidated shipping.
