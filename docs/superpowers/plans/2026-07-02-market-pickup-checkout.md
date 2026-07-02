# Market Pickup Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "Ела на пазара" (pickup) into a real, selectable checkout method on chaika's storefront — driven by the farmer's actual configured schedule (Добрич, Thursday 10:00–15:00) instead of a static, non-selectable info blurb.

**Architecture:** `pickup` already works end-to-end server-side (no slot, no route, turnover-counting, COD-eligible) and `checkout-page.ts` already fully implements it as a selectable `Method` — it just has no matching radio-card in the HTML, and the address/hours/schedule data never reaches the storefront at all. This plan: (1) adds an optional fixed weekday+time schedule to the pickup method's config, (2) exposes it through the public bootstrap API, (3) lets the farmer set it in the panel, (4) renders a real radio-card on chaika's checkout instead of the static div, (5) fixes the hardcoded "Чайка, Варна" text that gets submitted with every pickup order regardless of the real address.

**Tech Stack:** NestJS + Jest (server), Next.js/React (panel client), Astro + vanilla TS (chaika storefront, no test runner).

**Spec:** `docs/superpowers/specs/2026-07-02-market-pickup-checkout-design.md`

---

### Task 1: Server — pickup schedule fields + `buildPublicPickup`

**Files:**
- Modify: `server/src/modules/orders/delivery-pricing.ts`
- Test: `server/src/modules/orders/delivery-pricing.spec.ts`

- [ ] **Step 1: Write the failing tests**

Add to the bottom of `server/src/modules/orders/delivery-pricing.spec.ts` (inside the existing `describe('delivery-pricing', ...)` block, alongside the other `describe`s):

```ts
  describe('buildPublicPickup', () => {
    it('defaults to a generic label with no schedule when unset', () => {
      expect(buildPublicPickup(undefined)).toEqual({
        label: 'Вземане от място',
        address: null,
        hours: null,
        weekday: null,
        timeFrom: null,
        timeTo: null,
      });
    });
    it('surfaces the farmer-typed label/address/hours', () => {
      const cfg: DeliveryConfig = {
        methods: {
          pickup: { label: 'Ела на пазара', address: 'Добрич, пл. Свобода', hours: 'Всеки четвъртък' },
        },
      };
      expect(buildPublicPickup(cfg)).toEqual({
        label: 'Ела на пазара',
        address: 'Добрич, пл. Свобода',
        hours: 'Всеки четвъртък',
        weekday: null,
        timeFrom: null,
        timeTo: null,
      });
    });
    it('surfaces the fixed weekday+time schedule when set', () => {
      const cfg: DeliveryConfig = {
        methods: { pickup: { pickupWeekday: 4, pickupFrom: '10:00', pickupTo: '15:00' } },
      };
      expect(buildPublicPickup(cfg)).toEqual({
        label: 'Вземане от място',
        address: null,
        hours: null,
        weekday: 4,
        timeFrom: '10:00',
        timeTo: '15:00',
      });
    });
  });
```

Update the import at the top of the same file to include the new symbol:

```ts
import {
  methodBaseFee,
  freeThresholdStotinki,
  applyFreeThreshold,
  localFeeStotinki,
  econtFallbackFee,
  buildPublicDelivery,
  buildPublicPickup,
  courierMarkupStotinki,
  codEnabled,
  DELIVERY_DEFAULTS,
  type DeliveryConfig,
  speedyEnabled,
  comparisonActive,
  courierDoorEnabled,
  carrierPolicy,
} from './delivery-pricing';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest delivery-pricing.spec.ts`
Expected: FAIL — `buildPublicPickup is not a function` (or TS compile error: no exported member `buildPublicPickup`).

- [ ] **Step 3: Extend `MethodConfig` and add `buildPublicPickup`**

In `server/src/modules/orders/delivery-pricing.ts`, replace the `MethodConfig` interface:

```ts
export interface MethodConfig {
  enabled?: boolean;
  label?: string;
  pricing?: MethodPricing;
  /** pickup only — free-text location + hours (unchanged, still the fallback). */
  address?: string;
  hours?: string;
  /** pickup only — optional fixed recurring schedule (0=Sun..6=Sat). When set,
   *  together with pickupFrom/pickupTo, this takes priority over `hours` for
   *  the customer-facing schedule text. */
  pickupWeekday?: number;
  pickupFrom?: string; // HH:MM
  pickupTo?: string; // HH:MM
}
```

Add, right after `buildPublicMethods` (after its closing `}`, currently ending around line 185):

```ts
/** Read-only pickup/market info for the storefront — address, hours and an
 *  optional fixed weekday+time schedule. `label` always has a value (falls
 *  back to the generic "Вземане от място" so the storefront never shows a
 *  blank title). */
export interface PublicPickup {
  label: string;
  address: string | null;
  hours: string | null;
  /** 0=Sun..6=Sat, or null when the farm hasn't set a fixed schedule. */
  weekday: number | null;
  timeFrom: string | null;
  timeTo: string | null;
}

export function buildPublicPickup(cfg: DeliveryConfig | null | undefined): PublicPickup {
  const m = cfg?.methods?.pickup;
  return {
    label: m?.label?.trim() || 'Вземане от място',
    address: m?.address?.trim() || null,
    hours: m?.hours?.trim() || null,
    weekday: typeof m?.pickupWeekday === 'number' ? m.pickupWeekday : null,
    timeFrom: m?.pickupFrom ?? null,
    timeTo: m?.pickupTo ?? null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest delivery-pricing.spec.ts`
Expected: PASS — all tests including the 3 new `buildPublicPickup` cases.

- [ ] **Step 5: Commit**

```bash
cd server
git add src/modules/orders/delivery-pricing.ts src/modules/orders/delivery-pricing.spec.ts
git commit -m "feat(orders): add buildPublicPickup with optional fixed schedule"
```

---

### Task 2: Server — wire `pickup` into the public bootstrap payload

**Files:**
- Modify: `server/src/common/cache/public-cache.service.ts`
- Modify: `server/src/modules/tenants/tenants.service.ts`

- [ ] **Step 1: Add `pickup` to `TenantMeta` and compute it**

In `server/src/common/cache/public-cache.service.ts`, update the import block (currently lines 6-20) to add `buildPublicPickup` and `type PublicPickup`:

```ts
import {
  buildPublicDelivery,
  buildPublicMethods,
  buildPublicPickup,
  econtMode,
  codEnabled,
  cardEnabled,
  speedyEnabled,
  carrierPolicy,
  courierMarkupStotinki,
  type PublicDelivery,
  type PublicMethods,
  type PublicPickup,
  type DeliveryConfig,
  type EcontMode,
  type CarrierPolicy,
} from '../../modules/orders/delivery-pricing';
```

In the `TenantMeta` interface, add a field right after `methods: PublicMethods;` (currently line 93):

```ts
  // Which delivery methods are switched on — the storefront shows only these, so
  // a disabled method (e.g. Econt 'до адрес' left off) never reaches a customer.
  methods: PublicMethods;
  // Pickup/market info (label, address, hours, optional fixed weekday+time) — so
  // the storefront can render a real schedule instead of static placeholder text.
  pickup: PublicPickup;
```

In the `meta` object construction (currently around lines 277-302), add `pickup` right after the `methods` computation:

```ts
      delivery: buildPublicDelivery(delivery),
      // Package off → force the courier methods off (keep pickup + self-delivery).
      methods: pkgOn
        ? buildPublicMethods(delivery)
        : { ...buildPublicMethods(delivery), econtOffice: false, econtAddress: false },
      pickup: buildPublicPickup(delivery),
```

- [ ] **Step 2: Add `pickup` to `PublicStorefront`**

In `server/src/modules/tenants/tenants.service.ts`, update the import at line 20:

```ts
import { type PublicDelivery, type PublicMethods, type PublicPickup, type EcontMode } from '../orders/delivery-pricing';
```

In the `PublicStorefront` interface, add a field right after `methods: PublicMethods;` (currently line 76):

```ts
  delivery: PublicDelivery;
  methods: PublicMethods;
  pickup: PublicPickup;
```

No changes needed in `findPublicProfileBySlug` — it returns `{ ...profile, stripeEnabled }`, and `profile` already carries whatever `TenantMeta` has once Step 1 lands.

- [ ] **Step 3: Typecheck the server**

Run: `cd server && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Run the full server test suite (regression check)**

Run: `cd server && npx jest public-cache`
Expected: PASS (no existing test asserts the exact shape of `meta`/`TenantMeta` in a way that would break from an added field — if one does, extend its expected object with the new `pickup` key rather than removing the assertion).

- [ ] **Step 5: Commit**

```bash
cd server
git add src/common/cache/public-cache.service.ts src/modules/tenants/tenants.service.ts
git commit -m "feat(orders): expose pickup schedule on the public storefront payload"
```

---

### Task 3: Panel — pickup weekday+time picker

**Files:**
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/components/slots/recurrence-card.tsx`
- Modify: `client/src/components/delivery/methods-section.tsx`

- [ ] **Step 1: Add the new optional fields to `DeliveryMethod`**

In `client/src/lib/types.ts`, replace the `DeliveryMethod` interface (currently lines 197-207):

```ts
export interface DeliveryMethod {
  enabled: boolean;
  label: string;
  pricing?: MethodPricing;
  etaText?: string;
  payer?: Payer;
  minOrderStotinki?: number;
  /** pickup only */
  address?: string;
  hours?: string;
  /** pickup only — optional fixed recurring schedule (0=Sun..6=Sat). When set,
   *  the storefront shows a computed schedule line instead of `hours`. */
  pickupWeekday?: number;
  pickupFrom?: string; // HH:MM
  pickupTo?: string; // HH:MM
}
```

(Keep whatever fields already exist between `minOrderStotinki` and `address` — only the block from `/** pickup only */` down needs the 3 new lines appended.)

- [ ] **Step 2: Export `WD` and `WindowFields` from `recurrence-card.tsx`**

In `client/src/components/slots/recurrence-card.tsx`:
- Line 18: change `const WD = [` to `export const WD = [`
- Line 70: change `function WindowFields({` to `export function WindowFields({`

No other changes in this file — purely adding two `export` keywords, zero behavior change.

- [ ] **Step 3: Typecheck after the export change**

Run: `cd client && npx tsc --noEmit -p tsconfig.json`
Expected: no errors (these exports don't change any existing call site).

- [ ] **Step 4: Add the weekday+time picker to the pickup case**

In `client/src/components/delivery/methods-section.tsx`, update the import from `@/lib/delivery-data`... no — update the import of `RecurrenceCard`:

```ts
import { RecurrenceCard, WD, WindowFields } from '@/components/slots/recurrence-card';
```

Replace the pickup case (currently lines 137-156):

```tsx
        {mkey === 'pickup' ? (
          <>
            <div className="sm:col-span-2">
              <DLabel label="Адрес за вземане">
                <textarea
                  value={m.address ?? ''}
                  rows={2}
                  onChange={(e) => patch((x) => (x.address = e.target.value))}
                  className={cn(fieldCls, 'resize-y font-medium')}
                />
              </DLabel>
            </div>
            <DLabel label="Работно време">
              <input
                value={m.hours ?? ''}
                onChange={(e) => patch((x) => (x.hours = e.target.value))}
                className={fieldCls}
              />
            </DLabel>
            <div className="sm:col-span-2 flex flex-col gap-2 rounded-[10px] border border-ff-border bg-ff-surface-2 px-3.5 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] font-bold text-ff-ink-2">
                  Фиксиран ден и час (по желание — напр. пазар)
                </span>
                {m.pickupWeekday != null && (
                  <button
                    type="button"
                    onClick={() =>
                      patch((x) => {
                        x.pickupWeekday = undefined;
                        x.pickupFrom = undefined;
                        x.pickupTo = undefined;
                      })
                    }
                    className="text-[12px] font-bold text-ff-ink-2 underline-offset-2 hover:text-ff-green-700 hover:underline"
                  >
                    Изчисти
                  </button>
                )}
              </div>
              <p className="text-[12px] text-ff-muted">
                Зададеш ли ден и час, клиентите виждат точен график вместо текста в „Работно време“.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {WD.map((d) => (
                  <button
                    key={d.i}
                    type="button"
                    onClick={() => patch((x) => (x.pickupWeekday = d.i))}
                    className={cn(
                      'h-9 w-9 rounded-lg border text-[12.5px] font-bold transition-colors',
                      m.pickupWeekday === d.i
                        ? 'border-ff-green-500 bg-ff-green-50 text-ff-green-700'
                        : 'border-ff-border text-ff-ink-2 hover:border-ff-green-300',
                    )}
                  >
                    {d.l}
                  </button>
                ))}
              </div>
              {m.pickupWeekday != null && (
                <WindowFields
                  win={{ timeFrom: m.pickupFrom ?? '10:00', timeTo: m.pickupTo ?? '15:00' }}
                  onChange={(w) =>
                    patch((x) => {
                      x.pickupFrom = w.timeFrom;
                      x.pickupTo = w.timeTo;
                    })
                  }
                />
              )}
            </div>
          </>
        ) : (
```

(This replaces only the `{mkey === 'pickup' ? (...` through its closing `) : (` — the rest of the ternary's `else` branch, starting with `{mkey === 'ownSlots' && (...`, is unchanged.)

- [ ] **Step 5: Typecheck and lint**

Run: `cd client && npx tsc --noEmit -p tsconfig.json && npx eslint src/lib/types.ts src/components/slots/recurrence-card.tsx src/components/delivery/methods-section.tsx`
Expected: both clean.

- [ ] **Step 6: Manual verification**

Start `web-dev` + `api-dev` (or use the running dev servers), log in as a tenant admin, go to Настройки → Цени и правила → "Вземане от място" method card. Confirm:
- Address/hours fields unchanged.
- New "Фиксиран ден и час" block appears with 7 weekday pills, none selected by default.
- Click "Чт" (Thursday) → two time selects appear (default 10:00–15:00).
- Change to 10:00–15:00, save, reload the page → selection persists.
- Click "Изчисти" → weekday/time clear, time selects disappear.

- [ ] **Step 7: Commit**

```bash
cd client
git add src/lib/types.ts src/components/slots/recurrence-card.tsx src/components/delivery/methods-section.tsx
git commit -m "feat(delivery): optional fixed weekday+time schedule for pickup method"
```

---

### Task 4: chaika — real pickup radio-card on checkout

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/pages/checkout.astro`
- Modify: `src/scripts/checkout-page.ts`

(All paths relative to `fermerski-pazar-chaika/`.)

- [ ] **Step 1: Add `PickupInfo` to the `Storefront` type**

In `src/lib/types.ts`, add a new interface right after `DeliveryMethods` (currently lines 125-131):

```ts
/** Per-method on/off flags from the farm's config. */
export interface DeliveryMethods {
  ownSlots: boolean;
  pickup: boolean;
  econtOffice: boolean;
  econtAddress: boolean;
}

/** Pickup/market info (label, address, hours, optional fixed weekday+time
 *  schedule). Optional (older backend) → checkout falls back to a generic label
 *  and no schedule line. */
export interface PickupInfo {
  label: string;
  address: string | null;
  hours: string | null;
  /** 0=Sun..6=Sat, or null when the farm hasn't set a fixed schedule. */
  weekday: number | null;
  timeFrom: string | null;
  timeTo: string | null;
}
```

In the `Storefront` interface, add a field right after `methods?: DeliveryMethods;` (currently line 42):

```ts
  methods?: DeliveryMethods;
  pickup?: PickupInfo;
```

- [ ] **Step 2: Add `pickup` to `FALLBACK_STOREFRONT`**

In `src/lib/api.ts`, add a field right after `methods: { ownSlots: false, pickup: true, econtOffice: false, econtAddress: false },` (currently line 314):

```ts
  methods: { ownSlots: false, pickup: true, econtOffice: false, econtAddress: false },
  pickup: {
    label: 'Вземане от място',
    address: 'кв. Чайка, бул. „Ал. Стамболийски" (пред „Фратели")',
    hours: 'Всеки петък · 11:00–18:00',
    weekday: 5,
    timeFrom: '11:00',
    timeTo: '18:00',
  },
```

- [ ] **Step 3: Typecheck chaika**

Run: `cd fermerski-pazar-chaika && npx astro check`
Expected: no new errors (pre-existing unrelated warnings, if any, are fine).

- [ ] **Step 4: Compute the pickup label/schedule in checkout.astro's frontmatter**

In `src/pages/checkout.astro`, add right after the existing `const addrFeeTxt = ...` line (currently line 31):

```ts
const pickup = sf.pickup;
// Bulgarian grammatical gender varies by weekday ("Всеки понеделник" vs "Всяка
// сряда") — spell out each phrase rather than trying to conjugate generically.
const WD_NAMES = [
  'Всяка неделя', 'Всеки понеделник', 'Всеки вторник', 'Всяка сряда',
  'Всеки четвъртък', 'Всеки петък', 'Всяка събота',
];
const pickupLabel = pickup?.label || 'Вземане от място';
const pickupSchedule =
  pickup && pickup.weekday != null && pickup.timeFrom && pickup.timeTo
    ? `${WD_NAMES[pickup.weekday]} · ${pickup.timeFrom}–${pickup.timeTo}`
    : pickup?.hours || null;
const pickupSubtitle = [pickupSchedule, 'без такса', 'плащаш на място'].filter(Boolean).join(' · ');
```

- [ ] **Step 5: Add pickup data attributes to the checkout form**

In the same file, in the `<form>` tag's data attributes (currently lines 59-69), add two more:

```astro
        <form class="commerce-grid" id="checkoutForm" data-delivery={delivery ? '1' : '0'}
          data-econt-mode={sf.econtMode}
          data-stripe={stripeEnabled ? '1' : '0'}
          data-cod={codEnabled ? '1' : '0'}
          data-free-over={lvNum(d.freeThresholdStotinki)}
          data-ship-address={lvNum(d.addressFeeStotinki)}
          data-ship-econt={lvNum(d.econtFeeStotinki)}
          data-ship-econt-address={lvNum(d.econtAddressFeeStotinki)}
          data-comparison={sf.comparisonActive ? '1' : '0'}
          data-carrier-policy={sf.carrierPolicy ?? 'customer'}
          data-maps-key={mapsKey}
          data-pickup-label={pickupLabel}
          data-pickup-address={pickup?.address ?? ''}>
```

- [ ] **Step 6: Replace the static info div with a real radio-card**

Replace the block currently at lines 116-120:

```astro
              <!-- Вземане от пазара: само информация, НЕ е checkout опция. -->
              <div style="margin-top:14px;padding:12px 14px;border:1px dashed var(--line);border-radius:12px;background:var(--primary-050)">
                <div style="font-weight:700;margin-bottom:2px">Или ела на пазара · Чайка, Варна</div>
                <span class="muted" style="font-size:14px">Всеки петък 11:00–18:00 · без такса · плащаш на място. Това е само информация — за онлайн поръчка избери „Местна доставка до адрес“ горе.</span>
              </div>
```

with a real radio-card, moved up next to the other method radios inside `#deliveryMethod` — insert it right after the `econtAddress` card's closing `)}` (currently line 105), so it becomes the 4th radio option:

```astro
                {methods.pickup && (
                  <label class="radio-card" data-method="pickup">
                    <span class="dot"></span>
                    <span>
                      <b>{pickupLabel}</b><br>
                      <span class="muted" style="font-size:14px">{pickupSubtitle}</span>
                      {pickup?.address && <br />}
                      {pickup?.address && <span class="muted" style="font-size:13px">{pickup.address}</span>}
                    </span>
                  </label>
                )}
```

Delete the old lines 116-120 entirely (do not leave the static div in place — it would now duplicate the real radio-card above it).

- [ ] **Step 7: Replace the hardcoded `MARKET` constant in checkout-page.ts**

In `src/scripts/checkout-page.ts`, delete line 16:

```ts
const MARKET = 'Вземане от пазара · Чайка, Варна';
```

Add, right after the existing `const SHIP_ECONT_ADDRESS = num(...)` line (currently line 45):

```ts
// Real pickup label/address from the farm's config, server-rendered as data-*
// (see checkout.astro). Falls back to the label itself if no address is set.
const PICKUP_LABEL = form.dataset.pickupLabel || 'Вземане от място';
const PICKUP_ADDRESS = form.dataset.pickupAddress || PICKUP_LABEL;
```

Replace the pickup branch in the submit handler (currently lines 525-528):

```ts
  if (method === 'pickup') {
    payload.deliveryType = 'pickup';
    payload.deliveryAddress = PICKUP_ADDRESS;
    payload.notes = PICKUP_LABEL;
  } else if (method === 'courier') {
```

- [ ] **Step 8: Typecheck chaika again**

Run: `cd fermerski-pazar-chaika && npx astro check`
Expected: no errors.

- [ ] **Step 9: Manual end-to-end verification**

Start the chaika dev server (`npm run dev`) against a backend with a tenant whose pickup method has `pickupWeekday: 4, pickupFrom: '10:00', pickupTo: '15:00', address: 'Добрич, ...'`. On `/checkout`:
- Confirm a real, clickable "Вземане от място" (or whatever label was set) radio-card appears, showing "Всеки четвъртък · 10:00–15:00 · без такса · плащаш на място" and the address on its own line.
- Confirm the old static "Или ела на пазара" box is gone.
- Select it, confirm address fields and the slot picker stay hidden (no `usesAddress`/slot UI shown for pickup).
- Fill contact fields, submit with COD. Confirm the created order has `deliveryType: 'pickup'` and `deliveryAddress`/`notes` reflecting the real Добрич address/label, not "Чайка, Варна".
- Confirm the order counts toward turnover and does NOT appear in route planning (dostavki/route screen) — it has no slot and no geocoded address.

- [ ] **Step 10: Commit**

```bash
cd fermerski-pazar-chaika
git add src/lib/types.ts src/lib/api.ts src/pages/checkout.astro src/scripts/checkout-page.ts
git commit -m "feat(checkout): real pickup radio-card driven by the farm's configured schedule"
```

---

### Task 5: Push

- [ ] **Step 1: Push FarmFlow**

```bash
cd "C:\Users\Lenovo\source\repos\FarmFlow"
git push origin main
```

- [ ] **Step 2: Push chaika**

```bash
cd "C:\Users\Lenovo\source\repos\fermerski-pazar-chaika"
git push origin main
```

---

## Deferred (per user decision — do NOT include here)

Item A: ✅ DONE (2026-07-03). Fixed the hardcoded "петък 11:00–20:00" text on the
"Местна доставка до адрес" (own-slots) card in `checkout.astro`. Added
`buildPublicOwnSlots(SlotRule)` in `delivery-pricing.ts` (formats weekdays-mode
days grouped by shared window, or interval-mode as "на всеки N дни"), wired
through `TenantMeta.ownSlots` / `PublicStorefront.ownSlots`, and consumed in
chaika as `sf.ownSlots.schedule`. No schedule configured → the line is dropped
entirely rather than showing a wrong day/time.
FarmFlow: 7ec90c3, d12a739. chaika: 1ed1664. Not pushed yet.
