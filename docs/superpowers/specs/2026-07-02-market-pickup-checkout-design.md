# Ела на пазара (market pickup) as a real checkout method

Date: 2026-07-02
Repos touched: FarmFlow (server + client panel), fermerski-pazar-chaika (storefront checkout)

## Problem

"Вземане от място" (pickup) already exists end-to-end as a delivery method —
panel toggle, address/hours config, server-side handling (no slot, no route,
counts toward turnover, works with COD) — but on chaika's checkout page it was
demoted to a static, non-selectable info div ("Или ела на пазара · Чайка,
Варна — Всеки петък 11:00–18:00 · без такса · плащаш на място. Това е само
информация…"). `checkout-page.ts` already fully implements `pickup` as a
selectable method (defaults to it, submits `deliveryType: 'pickup'`, gates
pickup-only products) — it just has no matching radio-card in the HTML to
attach to.

The farmer wants a real market-pickup option for Добрич, every Thursday
10:00–15:00, that customers can actually select and order against — same
business rules as today's pickup (turnover-counting COD order, no delivery,
excluded from route planning).

## Scope

One pickup location (Добрич) for now. Data model should not hardcode "exactly
one" but a multi-location list UI is explicitly NOT built in this pass — YAGNI.

Out of scope (tracked separately, not built here):
- Multiple simultaneous markets / a location picker at checkout.
- Fixing the hardcoded "петък 11:00–20:00" text on the "Местна доставка до
  адрес" (own-slots) card — separate bug, different data source (SlotRule).
- Any other storefront repo (storefront-template / FarmFlow-Templates) — this
  spec covers chaika only.

## Design

### 1. Data model — `DeliveryMethod` (pickup only)

Add three optional fields alongside the existing `address`/`hours` free text:

```ts
export interface DeliveryMethod {
  // ...existing fields unchanged...
  address?: string;   // pickup only — unchanged
  hours?: string;     // pickup only — unchanged, used as fallback text
  /** pickup only — optional fixed recurring schedule (0=Sun..6=Sat) */
  pickupWeekday?: number;
  pickupFrom?: string; // HH:MM
  pickupTo?: string;   // HH:MM
}
```

All three are optional and additive — a farm using pickup as a plain
"come by anytime, Mon–Fri 9–18" address keeps typing that into `hours` and
never touches the new fields. When `pickupWeekday` + `pickupFrom` + `pickupTo`
are all set, they take priority for the customer-facing schedule line; `hours`
becomes a secondary note.

Server `DeliveryConfig`/DTO mirrors the same three optional fields on the
pickup method's validation schema (class-validator `@IsOptional()` /
`@IsInt() @Min(0) @Max(6)` for weekday, `@Matches(/^\d{2}:\d{2}$/)` for the
times — same pattern already used for slot windows).

No order-schema change. `deliveryType: 'pickup'` already means exactly this
(no slot, no route, turnover-counting, COD-eligible) — verified in
`orders.service.ts` (`assertMethodAllowed`, `reserveCartItems`, the
"slotless orders (market pickup) fall back to creation day" comment).

### 2. Panel UI — `methods-section.tsx` pickup case

Under the existing "Адрес за вземане" textarea and "Работно време" input, add
an optional block: weekday pills (Пн–Нд, single-select, same visual pattern
as `RecurrenceCard`'s `WD` picker) + two time selects (reuse the `TIMES`
30-minute-step list from `recurrence-card.tsx`). A "Изчисти" control clears
back to no fixed schedule (falls back to freeform `hours`).

Hint copy: "По желание — зададеш ли ден и час, клиентите виждат точен график
вместо текста по-горе." Keeps the existing `hours` field's label/behavior
unchanged; it just becomes secondary once weekday+time are set.

### 3. Public API surface

`PublicMethods` (delivery-pricing.ts) currently exposes booleans only — no
farm ever sends pickup's address/hours/schedule to the storefront. Add:

```ts
export interface PublicPickup {
  label: string;
  address: string | null;
  hours: string | null;
  weekday: number | null;
  timeFrom: string | null;
  timeTo: string | null;
}

export function buildPublicPickup(cfg: DeliveryConfig | null | undefined): PublicPickup { ... }
```

Wired into `public-cache.service.ts`'s bootstrap payload alongside the
existing `methods` key, e.g. `pickup: buildPublicPickup(delivery)`. Gated the
same way `methods` already is (courier package off doesn't affect pickup —
matches existing "package off keeps pickup + self-delivery" comment).

### 4. chaika checkout UI

`checkout.astro`:
- Delete the static info div (lines ~116-120, "Или ела на пазара… само
  информация, НЕ е checkout опция").
- Add a real `radio-card` with `data-method="pickup"`, gated on
  `methods.pickup`, positioned in the `deliveryMethod` list alongside the
  address/econt cards. Title = `sf.pickup.label` (fallback "Вземане от
  място"). Subtitle = computed schedule line when weekday/timeFrom/timeTo are
  set (`Всеки <ден> · <from>–<to> · без такса · плащаш на място`, using a
  small BG weekday-name array), else falls back to `sf.pickup.hours`, else
  just `sf.pickup.address`.
- No changes needed to `checkout-page.ts` — it already handles `pickup` as a
  first-class method (default selection, `payload.deliveryType='pickup'`,
  pickup-only product gating). Adding the radio-card is what activates it.
- `orders.astro`'s existing "Вземане от пазара" marketing block (editable
  copy slots `orders.pickup.*`) is left as-is — separate, farmer-edited
  marketing copy, not the live checkout data. Not touched by this spec.

`api.ts`/`types.ts` (chaika): extend the `Storefront` type + bootstrap fetch
mapping to carry the new `pickup` object from the public API.

### 5. Farmer setup for Добрич

No hardcoding — farmer fills in address="Добрич, ...", picks weekday=Thursday,
timeFrom=10:00, timeTo=15:00 via the panel UI in part 2, then toggles
"Вземане от място" on (already exists in `setup-panel.tsx`).

## Testing

- Server: unit tests for `buildPublicPickup` (weekday/time present vs absent,
  falls back correctly) and DTO validation (weekday range, time format).
- Panel: existing methods-section pattern — no new test infra needed, cover
  save round-trip in an existing delivery-config spec if one exists.
- chaika: manual checkout smoke test — select pickup, submit, confirm order
  lands with `deliveryType: 'pickup'`, no slot, no address, doesn't appear in
  route planning.
