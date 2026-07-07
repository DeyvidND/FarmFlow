# Drop per-farmer courier opt-in + courier markup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `farmers.courier_enabled` per-farmer opt-in (courier eligibility becomes "has a carrier connected") and remove `pricing.courierMarkupStotinki` (customer pays the raw courier price).

**Architecture:** Two independent removals across a pnpm monorepo (`packages/db`, `server`, `client`, `admin`, `packages/types`). Order the work so every reference to the DB column is gone before the column is dropped in the final task, keeping the tree compilable between tasks. The Econt/Speedy flat fallback fee and the free-over threshold stay.

**Tech Stack:** pnpm 9 workspace, NestJS + Drizzle (server), Next.js (client, admin), Jest.

## Global Constraints

- Money is integer stotinki (EUR cents) end-to-end. Never introduce floats.
- Migrations are numbered sequentially; the next number is **0080**. Verify the generated SQL by hand (this repo does not trust blind drizzle-kit output).
- Keep: `freeThresholdStotinki`, `ownSlots` local delivery fee, Econt/Speedy flat fallback fees (`econtFeeStotinki` / `econtAddressFeeStotinki`), `tenants.deliveries_package_enabled`, per-product `courier_disabled`.
- Bulgarian UI copy — match surrounding tone; do not translate existing strings.
- Test one workspace at a time: `pnpm --filter server test -- <pattern>`. Typecheck server: `pnpm --filter server build`. Build a frontend: `pnpm --filter client build` / `pnpm --filter admin build`.
- This work goes on a fresh branch off `main` (`feat/drop-farmer-courier-optin`), NOT on `feat/editable-orders`.

---

### Task 0: Branch

- [ ] **Step 1: Stash unrelated WIP and branch off main**

The current `feat/editable-orders` branch has unrelated uncommitted changes. Confirm with the operator how to preserve them (likely: commit them on that branch first, or `git stash`), then:

```bash
git checkout main
git pull
git checkout -b feat/drop-farmer-courier-optin
```

Expected: clean tree on the new branch.

---

### Task 1: Courier eligibility = carrier connected (drop `courierEnabled` from the gate)

**Files:**
- Modify: `server/src/modules/orders/courier-eligibility.ts`
- Test: `server/src/modules/orders/courier-eligibility.spec.ts`
- Modify: `server/src/modules/farmers/farmers.service.ts:478`
- Modify: `server/src/modules/orders/orders.service.ts:1900,1907`
- Test: `server/src/modules/orders/orders.courier.spec.ts`

**Interfaces:**
- Produces: `farmerCourierReady(ns: FarmerDeliveryNamespace | undefined): boolean` — a farmer can ship by courier iff a carrier is configured.

- [ ] **Step 1: Rewrite the eligibility spec for the 1-arg signature**

In `courier-eligibility.spec.ts`, replace the whole `describe('farmerCourierReady', …)` block with:

```ts
describe('farmerCourierReady', () => {
  it('false when no carrier configured', () => {
    expect(farmerCourierReady(undefined)).toBe(false);
    expect(farmerCourierReady({})).toBe(false);
    expect(farmerCourierReady({ econt: { configured: false } })).toBe(false);
  });
  it('true when econt OR speedy connected', () => {
    expect(farmerCourierReady({ econt: { configured: true } })).toBe(true);
    expect(farmerCourierReady({ speedy: { configured: true } })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the spec, expect FAIL**

Run: `pnpm --filter server test -- courier-eligibility`
Expected: FAIL (compile error — `farmerCourierReady` still takes 2 args).

- [ ] **Step 3: Change the signature**

In `courier-eligibility.ts`, replace the `farmerCourierReady` function + its docstring:

```ts
/**
 * Whether a farmer can ship via courier: they have at least one carrier
 * (Econt or Speedy) connected in their sub-namespace. There is no separate
 * per-farmer opt-in — connecting a carrier is the switch.
 */
export function farmerCourierReady(ns: FarmerDeliveryNamespace | undefined): boolean {
  return !!(ns?.econt?.configured || ns?.speedy?.configured);
}
```

- [ ] **Step 4: Update the two call sites**

`farmers.service.ts:478` — replace:

```ts
      const courierReady = farmerCourierReady(farmerDeliveryNamespace(settings, rest.id));
```

`orders.service.ts` — at :1900 drop `courierEnabled` from the select:

```ts
        .select({ id: farmers.id, name: farmers.name })
```

and at :1907 call with one arg:

```ts
          !!f && farmerCourierReady(farmerDeliveryNamespace(tenant.settings, fid));
```

- [ ] **Step 5: Fix the courier spec fixtures**

In `orders.courier.spec.ts`, remove `courierEnabled` from the `farmerRows` helper type (:55) and every fixture (:140,141,221,253,280,307,337). For the "not ready" farmer at :308–309, drop `courierEnabled: false` and instead ensure that farmer has **no** configured carrier in whatever settings the test builds (that is now the sole reason it is not ready) — read the surrounding test to see how the namespace is seeded and mirror it.

- [ ] **Step 6: Run the affected specs, expect PASS**

Run: `pnpm --filter server test -- courier-eligibility orders.courier`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/orders/courier-eligibility.ts server/src/modules/orders/courier-eligibility.spec.ts server/src/modules/farmers/farmers.service.ts server/src/modules/orders/orders.service.ts server/src/modules/orders/orders.courier.spec.ts
git commit -m "refactor(courier): eligibility = carrier connected, drop courierEnabled from gate"
```

---

### Task 2: Remove the courier markup (server)

**Files:**
- Modify: `server/src/modules/orders/delivery-pricing.ts`
- Test: `server/src/modules/orders/delivery-pricing.spec.ts`
- Modify: `server/src/modules/orders/checkout.service.ts:26,329,354`
- Modify: `server/src/common/cache/public-cache.service.ts:16,80,299`
- Modify: `server/src/modules/econt-app/shipping-quote.service.ts:32,45`
- Modify: `server/src/modules/econt-app/shipping-quote.helpers.ts:33-43`
- Test: `server/src/modules/econt-app/shipping-quote.helpers.spec.ts:67-73`
- Test: `server/src/modules/econt-app/public-shipping-quote.controller.spec.ts:45,64`

**Interfaces:**
- Produces: `buildPublicDelivery(cfg)` courier fees = fallback fee only (no markup added). `buildQuoteResult(econtStotinki, speedyStotinki, policy?)` — 3-arg, no markup.

- [ ] **Step 1: Update the pricing spec to drop markup**

In `delivery-pricing.spec.ts`: delete the `courierMarkupStotinki` import (:10), delete the `'courierMarkupStotinki defaults to 0…'` test (:196–202), and replace the `'buildPublicDelivery adds markup…'` test (:203–210) with:

```ts
  it('buildPublicDelivery courier fees = fallback fee, local self-delivery unchanged', () => {
    const pub = buildPublicDelivery({} as any);
    expect(pub.econtFeeStotinki).toBe(DELIVERY_DEFAULTS.econtFeeStotinki);
    expect(pub.econtAddressFeeStotinki).toBe(DELIVERY_DEFAULTS.econtAddressFeeStotinki);
    expect(pub.addressFeeStotinki).toBe(DELIVERY_DEFAULTS.addressFeeStotinki);
  });
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `pnpm --filter server test -- delivery-pricing`
Expected: FAIL (compile error — `courierMarkupStotinki` still exported/used).

- [ ] **Step 3: Remove the markup from `delivery-pricing.ts`**

- Delete the `courierMarkupStotinki(cfg)` function (the block at :126–136 incl. its docstring).
- In `DeliveryConfig.pricing` (:40) remove `courierMarkupStotinki?: number` — leave `{ freeThresholdStotinki?: number }`.
- In `buildPublicDelivery` (:164–174) drop the markup:

```ts
export function buildPublicDelivery(cfg: DeliveryConfig | null | undefined): PublicDelivery {
  return {
    freeThresholdStotinki: freeThresholdStotinki(cfg),
    addressFeeStotinki: methodBaseFee(cfg?.methods?.ownSlots?.pricing, DELIVERY_DEFAULTS.addressFeeStotinki),
    econtFeeStotinki: econtFallbackFee(cfg, false),
    econtAddressFeeStotinki: econtFallbackFee(cfg, true),
  };
}
```

- [ ] **Step 4: Update `checkout.service.ts`**

Remove the `courierMarkupStotinki` import (:26). At :329 and :354 drop `+ courierMarkupStotinki(cfg)`:

```ts
        return applyFreeThreshold(picked.fee, subtotal, freeThresholdStotinki(cfg));
```
```ts
    return applyFreeThreshold(fee, subtotal, freeThresholdStotinki(cfg));
```

Update the comment above :354 that mentions "carry the farm's markup" → note the fee is the raw courier price zeroed by the free-over threshold.

- [ ] **Step 5: Update `public-cache.service.ts`**

Remove the `courierMarkupStotinki` import (:16), the `courierMarkupStotinki: number` field from the public payload type (:80 + its comment :78–79), and the `courierMarkupStotinki: courierMarkupStotinki(delivery)` line (:299).

- [ ] **Step 6: Update the quote helper + service (drop the markup param)**

In `shipping-quote.helpers.ts`, replace `buildQuoteResult`'s signature/body head (:33–43):

```ts
export function buildQuoteResult(
  econtStotinki: number | null,
  speedyStotinki: number | null,
  policy: CarrierPolicy = 'customer',
): QuoteResult {
  const econt = econtStotinki;
  const speedy = speedyStotinki;
```

(the rest of the function is unchanged). In `shipping-quote.service.ts`, drop the `markupStotinki = 0` param (:32) and pass 3 args (:45): `return buildQuoteResult(econtStotinki, speedyStotinki, policy);`. Grep the service file for any other `markup` references and remove them.

- [ ] **Step 7: Fix the quote + controller specs**

In `shipping-quote.helpers.spec.ts`, replace the `describe('courier markup', …)` block (:67+) so calls use 3 args and prices carry no markup:

```ts
  describe('pricing', () => {
    it('orders cheapest first, no markup', () => {
      const r = buildQuoteResult(450, 390, 'customer');
      expect(r.quotes.find((q) => q.carrier === 'econt')!.priceStotinki).toBe(450);
      expect(r.quotes.find((q) => q.carrier === 'speedy')!.priceStotinki).toBe(390);
      expect(r.cheapest).toBe('speedy');
    });
    it('leaves an unavailable (null) carrier null', () => {
      const r = buildQuoteResult(450, null, 'customer');
      expect(r.quotes.find((q) => q.carrier === 'speedy')!.priceStotinki).toBeNull();
    });
  });
```

In `public-shipping-quote.controller.spec.ts`, remove the `courierMarkupStotinki: 200` / `: 0` keys from the two public-delivery mock objects (:45,:64) and any assertion that the quote call received a markup arg.

- [ ] **Step 8: Run all affected specs, expect PASS**

Run: `pnpm --filter server test -- delivery-pricing shipping-quote public-shipping-quote checkout`
Expected: PASS.

- [ ] **Step 9: Typecheck the server**

Run: `pnpm --filter server build`
Expected: build succeeds (no dangling `courierMarkupStotinki`).

- [ ] **Step 10: Commit**

```bash
git add server
git commit -m "feat(delivery): remove courier markup — customer pays the raw courier price"
```

---

### Task 3: Remove the markup input from the panel

**Files:**
- Modify: `client/src/components/delivery/methods-section.tsx:355-385`
- Modify: `client/src/lib/types.ts:234-236`

- [ ] **Step 1: Remove the markup field + the `courierOn` block**

In `methods-section.tsx`, delete the `{courierOn && ( … )}` block (:373–384) and its now-unused `const courierOn = …` (:350) if nothing else uses it (grep the file first). Simplify the section `info` copy (:356–359) to drop "и надценката върху куриера":

```tsx
      info={<>„Безплатно над сума“ важи за всички методи — задаваш го веднъж тук.</>}
```

The grid at :362 now holds a single column; that is fine (leave `sm:grid-cols-2` or change to one column — pick whichever keeps the layout clean).

- [ ] **Step 2: Remove the type field**

In `client/src/lib/types.ts`, delete the `courierMarkupStotinki?: number` field (:236) and its doc comment (:234–235).

- [ ] **Step 3: Build the client**

Run: `pnpm --filter client build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/delivery/methods-section.tsx client/src/lib/types.ts
git commit -m "feat(delivery): drop the courier markup input from the panel"
```

---

### Task 4: Remove the per-farmer courier checkbox (panel + product screens)

**Files:**
- Modify: `client/src/components/farmers/farmer-panel.tsx:61,106,273-281`
- Modify: `client/src/lib/types.ts:117`
- Modify: `client/src/components/products/product-dialog.tsx:64,…`
- Modify: `client/src/components/products/courier-settings-modal.tsx:41,100`
- Modify: `client/src/app/(admin)/products/page.tsx:24`

- [ ] **Step 1: Remove the checkbox from the farmer panel**

In `farmer-panel.tsx`: delete the `courierEnabled` state (:61), the `courierEnabled,` line in the save payload (:106), and the whole `<label>…Куриерска доставка…</label>` block (:273–281).

- [ ] **Step 2: Remove the client type field**

In `client/src/lib/types.ts`, delete `courierEnabled?: boolean;` (:117).

- [ ] **Step 3: Un-gate the per-product courier toggle from the farmer flag**

In `product-dialog.tsx`, delete `const farmerHasCourier = farmers.find((f) => f.id === farmerId)?.courierEnabled ?? false;` (:64). Grep the file for `farmerHasCourier`; wherever it disabled/greyed the per-product courier toggle or drove helper text, remove that condition so the `courierDisabled` toggle is always available (the local `courierEnabled = !courierDisabled` variable at :62 is unrelated and stays). Keep the toggle's own behaviour otherwise unchanged.

- [ ] **Step 4: Un-gate the courier-settings modal**

In `courier-settings-modal.tsx`, delete the `farmerCourier` map (:41) and the `noFarmerHasCourier` warning (:100) plus the JSX that rendered that warning. Grep for both identifiers and remove all uses; the modal's per-product toggles no longer depend on a farmer flag.

- [ ] **Step 5: Fix the products page comment**

In `products/page.tsx:24`, remove/adjust the comment referencing farmers' `courierEnabled`.

- [ ] **Step 6: Build the client**

Run: `pnpm --filter client build`
Expected: build succeeds (no `courierEnabled` on `Farmer`).

- [ ] **Step 7: Commit**

```bash
git add client
git commit -m "feat(farmers): remove the per-farmer courier checkbox; courier follows carrier connection"
```

---

### Task 5: Remove `courierEnabled` from the admin app

**Files:**
- Modify: `admin/src/lib/api-client.ts:70,98,211`
- Modify: `admin/src/components/producers-client.tsx:45,149,152`
- Modify: `admin/src/components/producer-detail.tsx:99,102`
- Modify: `admin/src/components/tenant-detail-client.tsx:423,466,469`

- [ ] **Step 1: Drop the type fields**

In `admin/src/lib/api-client.ts`, remove `courierEnabled: boolean;` from all three farmer shapes (:70,:98,:211).

- [ ] **Step 2: Remove the producers-list UI**

In `producers-client.tsx`: delete the `withCourier` count (:45) and wherever it was rendered; delete the Вкл/Изкл courier badge (:149–152).

- [ ] **Step 3: Remove the producer-detail flag**

In `producer-detail.tsx`, delete the "Куриер вкл/изкл" badge (:99–102).

- [ ] **Step 4: Remove the tenant-detail UI**

In `tenant-detail-client.tsx`: delete the "N с куриер" count (:423) and the per-farmer Вкл/Изкл badge (:466–469).

- [ ] **Step 5: Build the admin app**

Run: `pnpm --filter admin build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add admin
git commit -m "feat(admin): drop the per-farmer courier flag from producer/tenant views"
```

---

### Task 6: Remove `courierEnabled` from platform.service, DTOs, and remaining server references

**Files:**
- Modify: `server/src/modules/platform/platform.service.ts` (interfaces :203,:227,:262; selects :570,:689,:836; builders :627,:750,:906)
- Test: `server/src/modules/platform/platform.service.spec.ts` (:383,:396,:424,:455,:476,:503)
- Modify: `server/src/modules/farmers/dto/create-farmer.dto.ts:73`
- Modify: `server/src/modules/farmers/dto/update-farmer.dto.ts` (comment :4)
- Modify: `server/src/modules/farmers/farmers.controller.ts:34` (comment)
- Test: delete `server/src/modules/farmers/farmers.update.spec.ts` courierEnabled test (:23–36)
- Modify: `packages/types/src/index.ts:148` (comment)

- [ ] **Step 1: Strip the platform.service interfaces + queries + builders**

In `platform.service.ts`: remove `courierEnabled: boolean;` from `PlatformTenantDetail.farmers` (:203), `GlobalFarmerRow` (:227), `FarmerDetail` (:262); remove `courierEnabled: farmers.courierEnabled,` from the three selects (:570,:689,:836); remove `courierEnabled: !!f.courierEnabled` / `!!r.courierEnabled` / `!!base.courierEnabled` from the three row builders (:627,:750,:906).

- [ ] **Step 2: Fix the platform spec**

In `platform.service.spec.ts`, remove `courierEnabled` from the farmer-row fixture (:383) and every `courierEnabled: true` expectation (:396,:424,:455,:476,:503).

- [ ] **Step 3: Remove the DTO field + stale comments**

Delete `courierEnabled?: boolean;` from `create-farmer.dto.ts:73` (UpdateFarmerDto inherits, so it drops too). Update the `update-farmer.dto.ts:4` comment and the `farmers.controller.ts:34` comment that mention `courierEnabled`. Update the `packages/types/src/index.ts:148` doc comment from "courier_enabled AND ≥1 carrier" to "≥1 carrier connected".

Note: `farmers.service.ts` `create`/`update` spread `{ ...dto }`, so dropping the DTO field removes persistence automatically — no service edit needed here.

- [ ] **Step 4: Delete the obsolete persistence test**

In `farmers.update.spec.ts`, delete the entire `describe('FarmersService.update — courierEnabled', …)` block (and the mock plumbing that only served it, :15). If the file becomes empty, delete the file.

- [ ] **Step 5: Run server specs + typecheck**

Run: `pnpm --filter server test -- platform.service farmers`
Then: `pnpm --filter server build`
Expected: PASS + build succeeds. Grep confirms no `courierEnabled` / `farmers.courierEnabled` remains in `server/`.

- [ ] **Step 6: Commit**

```bash
git add server packages/types
git commit -m "refactor(platform): drop courierEnabled from platform views, DTOs, and types"
```

---

### Task 7: Drop the `farmers.courier_enabled` column

**Files:**
- Modify: `packages/db/src/schema.ts:906`
- Create: `packages/db/drizzle/0080_drop_farmers_courier_enabled.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` + new snapshot under `packages/db/drizzle/meta/`

**Interfaces:**
- Consumes: nothing else reads `farmers.courierEnabled` after Tasks 1 & 6 — verify with grep before dropping.

- [ ] **Step 1: Confirm no remaining references**

Run: `git grep -n "courierEnabled\|courier_enabled" -- server client admin packages/types` 
Expected: no hits (docs/plans may still mention it — those are fine). If any code hit remains, fix it before proceeding.

- [ ] **Step 2: Remove the column from the schema**

In `packages/db/src/schema.ts`, delete the `courierEnabled: boolean('courier_enabled').notNull().default(false),` line (:906) and its comment block above it (:52-53 region referencing courier_enabled, if present near the farmers table).

- [ ] **Step 3: Generate the migration, then verify by hand**

Run: `pnpm db:generate`
Open the newly created `packages/db/drizzle/0080_*.sql`. It MUST contain exactly:

```sql
ALTER TABLE "farmers" DROP COLUMN "courier_enabled";
```

If drizzle-kit emitted anything else (unrelated column churn, reordering), discard and hand-write the file as `0080_drop_farmers_courier_enabled.sql` with only the statement above, and add the matching `_journal.json` entry + snapshot by mirroring the previous drop migration `0047_drop_slot_capacity.sql` and its journal/snapshot entries.

- [ ] **Step 4: Apply the migration to the dev DB**

Run: `pnpm db:migrate`
Expected: migration `0080` applies cleanly.

- [ ] **Step 5: Full server test + build**

Run: `pnpm --filter server test`
Then: `pnpm --filter server build`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "feat(db): drop farmers.courier_enabled (migration 0080)"
```

---

### Task 8: Full verification

- [ ] **Step 1: Build everything**

Run: `pnpm build` (turbo runs all workspaces).
Expected: server, client, admin, db all build.

- [ ] **Step 2: Manual smoke (dev)**

- Farmer with a connected carrier → storefront product shows the "Куриер" option; there is no per-farmer courier checkbox anywhere in the panel, and no "с куриер" flag in admin.
- Checkout a courier order → the fee equals the raw courier price (no markup), and is free above the free-over threshold.
- Local (own) delivery fee and pickup are unchanged.
- A per-product „без куриер" (`courierDisabled`) product is still pickup-only.

---

## Self-Review

**Spec coverage:**
- Change 1 (drop `courier_enabled`): gate → Task 1; panel + product screens → Task 4; admin → Task 5; platform/DTO/types → Task 6; column drop → Task 7. ✓
- Change 2 (remove markup): pricing/checkout/quote/cache → Task 2; panel UI + client type → Task 3. ✓
- Keep fallback fee / threshold / local fee: Task 2 explicitly preserves `econtFallbackFee` and `freeThresholdStotinki`. ✓
- Out-of-scope (deliveries package, carrier policy, product courier_disabled) — untouched. ✓

**Placeholder scan:** none — every code step shows the edit.

**Type consistency:** `farmerCourierReady(ns)` (1-arg) defined in Task 1 and used only there. `buildQuoteResult(e, s, policy?)` (3-arg) defined in Task 2 Step 6, its specs updated in the same task. `buildPublicDelivery` return shape unchanged (fields kept, markup removed from their computation) so `public-cache` consumers stay valid apart from the removed `courierMarkupStotinki` payload field handled in Task 2 Step 5.
