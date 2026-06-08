# наложен платеж (Cash on Delivery) as a checkout payment choice

**Date:** 2026-06-08
**Status:** Approved, ready for planning

## Goal

Let a customer pick how to pay at checkout: **Карта (онлайн)** via Stripe, or
**Наложен платеж** (cash on delivery) — pay at handover, no card. Pairs with
manual Econt delivery: the farm ships via Econt without the Econt API, the
customer collects at the Econt office and pays cash there.

This is a payment feature. Delivery is unchanged: manual Econt mode already
exists (`EcontMode = 'manual'`, flat fee, no API call — see
`server/src/modules/orders/delivery-pricing.ts`). The only delivery action is to
confirm the farm runs Econt in `manual` mode.

## Scope

- COD is selectable for **all** delivery methods (Econt office/door, own
  delivery, address, pickup), not Econt-only.
- The farm can turn COD on/off from the admin delivery page.
- No in-app COD fee. The farmer arranges Econt's наложен-платеж taxa manually
  when dropping the parcel. (Revisit later if needed.)
- Two storefronts consume the new API field: the in-repo `storefront/` (Next.js)
  and the separate **chaika** repo (`fermerski-pazar-chaika`, Astro). The chaika
  change is a separate commit in that repo — out of scope for this repo's PR but
  documented here so it isn't dropped.

## Data model

### Order column
- New column `payment_method` on `orders`: text, `NOT NULL DEFAULT 'online'`,
  values `'online' | 'cod'`. Drizzle migration in `packages/db`.
- Backfill: existing rows default to `'online'` (informational going forward; no
  attempt to reclassify historical cash orders).

### Tenant setting
- New flag `settings.delivery.cod = { enabled: boolean }`.
- Default **on** — production already runs cash-first (no Stripe). Absent →
  treated as enabled.
- Distinct from the existing `settings.delivery.econt.cod` (`{ enabled, feePayer }`),
  which only governs who pays Econt's COD taxa in **auto** API mode. The new flag
  is the customer-facing "offer наложен платеж" switch. Naming kept separate to
  avoid the collision; the new one lives at `delivery.cod.enabled`.

## Server

### DTO
- `CreateOrderDto` gains `paymentMethod?: 'online' | 'cod'` (`@IsEnum`,
  `@IsOptional`, default `'online'`).

### Intake
- `OrdersService.create` persists `payment_method` from the DTO on the new order
  row.

### Checkout branching (`CheckoutService.create`)
- `paymentMethod === 'cod'` → never open a Stripe session; leave the order
  `pending` with `payment_method='cod'`; return `{ orderId, checkoutUrl: null }`.
  Customer lands on the confirmation page.
- `paymentMethod === 'online'` → existing Stripe flow when the farm has a
  connected account.
- **Normalization for reality:** if `'online'` is requested but the farm has no
  usable Stripe account, fall back to today's cash-pending behavior; if COD is
  enabled, record the order as `'cod'` so the farmer sees "collect cash" rather
  than a misleading "paid online". At least one payment path is always available.

### Public profile (`TenantMeta` / `GET /public/:slug`)
- Add `codEnabled: boolean` — from `settings.delivery.cod.enabled` (default true).
- Add `stripeEnabled: boolean` — whether the farm can take cards
  (`stripeAccountId` present + platform Stripe configured). Not exposed today;
  the storefront needs it to decide which payment radios to render. Derived in
  `resolveTenant` from a newly-selected `stripeAccountId`; cached with the rest of
  the profile (TTL 300s, busted on profile write).

## Farmer-facing

- **Admin delivery page:** a toggle "Наложен платеж — плащане при доставка"
  writing `settings.delivery.cod.enabled`.
- **Order list / detail** (`client/.../orders`): badge per order —
  «Наложен платеж · събери X €» vs «Платено онлайн» — driven by `payment_method`
  (+ `paidAt`). So the farmer knows to flag COD when handing the parcel to Econt.
- **Daily digest email** (`server/src/modules/digest`): each COD line shows
  «наложен платеж — X €» so the morning ship-list says what to collect.

## Storefront (main `storefront/` + chaika)

- New **payment-method** section on checkout, after delivery method:
  - radios «Карта (онлайн)» and «Наложен платеж».
  - «Карта» shown only when `stripeEnabled`; «Наложен платеж» only when
    `codEnabled`. If exactly one is available it is preselected and the section
    can collapse to a one-line note. If neither (shouldn't happen — COD defaults
    on), fall back to current cash-pending submit.
  - available regardless of delivery method.
- Submit passes `paymentMethod`. COD → no Stripe redirect; go straight to
  confirmation (cart cleared). Online → existing `checkoutUrl` redirect.
- The public profile fetch (`storefront/src/lib/api.ts`) gains `codEnabled` +
  `stripeEnabled`.

## Delivery (no behavior change)

Confirm/seed the farm's Econt mode = `manual`. The flat-fee, no-API path in
`shippingStotinki` already handles it. No Econt code changes.

## Out of scope / deferred

- In-app COD fee or feePayer logic for наложен платеж.
- Reclassifying historical orders.
- chaika repo edits (tracked separately; needs that repo checked out).

## Testing

- `delivery-pricing` / checkout unit tests: COD path returns `checkoutUrl: null`
  and never calls Stripe; `payment_method` persisted; online path unchanged.
- DTO validation: rejects bad `paymentMethod`.
- Public profile: `codEnabled` / `stripeEnabled` reflect settings + Stripe state.
- Normalization: `online` + no Stripe + COD enabled → recorded `cod`.

## Alternatives considered

- **(A, chosen)** flag in `settings.delivery` + `orders.payment_method` column —
  reuses the delivery config already exposed to the storefront; least plumbing.
- **(B)** new `settings.payments` namespace + public payload section — cleaner
  payments/delivery split but more wiring; YAGNI now.
- **(C)** per-delivery-method COD matrix — contradicts the "all methods"
  decision and adds needless combinatorics.
