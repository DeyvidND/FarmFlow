# Delivery Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify and improve the farmer-panel delivery config: consolidate the global pricing rules into one section (D), remove dead pricing types (E), then make Speedy a first-class configurable carrier with a carrier-policy selector (C+B).

**Architecture:** Delivery config is one JSONB blob `tenants.settings.delivery`, hydrated client-side (`hydrateDelivery`) and read server-side by pure functions in `delivery-pricing.ts`. The farmer edits it across two screens: `/settings?config=setup` (on/off toggles) and `/settings?config=delivery` (details). Money is integer stotinki end-to-end.

**Tech Stack:** Next.js (client panel) · NestJS + Drizzle (server) · Vitest (server tests) · TypeScript everywhere.

---

## Scope & sequencing (READ FIRST)

Discovery surfaced two hard dependencies that change the original B→D→E ordering:

1. **B depends on C.** The `carrierPolicy` dropdown only renders when `comparisonActive` = `econtMode==='auto' && speedy.configured`. Nothing in the farmer UI sets `speedy.configured` today — that is exactly what C builds. So shipping B alone produces an invisible/dead control. **B is folded into C.**
2. **C is not a pure frontend mirror.** Speedy sender/package/COD ride the generic `saveDelivery` blob, but `sanitizeDelivery`/`preserveEcontSecret` (`server/.../tenants.service.ts`) only protect **Econt**'s encrypted password. Saving Speedy sender via the panel would **clobber `speedy.passwordEnc`**. C requires a backend `preserveSpeedySecret` fix first.

**Therefore:**
- **Phase 1 — D + E** (this plan, executed now): independent, safe, verifiable via `tsc` + Vitest. Visible simplification for the farmer (D) + code hygiene (E).
- **Phase 2 — C (+B)**: Speedy farmer UI + carrier-policy selector. Larger, security-sensitive, needs live smoke before deploy. Fully specified below; execute as its own focused PR.
- **A (merge the two config screens): NOT recommended.** The split (toggles in `/setup`, details in `/delivery`) is intentional and documented (`delivery-client.tsx` header comment). After D the details screen is cleaner; a full merge is high-risk, low-reward churn. Left as-is by design.

---

## File Structure

**Phase 1 (D + E):**
- Modify `client/src/components/delivery/methods-section.tsx` — remove the per-card free-threshold + courier-markup inputs; add a shared `GlobalRulesSection`.
- Modify `client/src/components/delivery/delivery-client.tsx` — render `GlobalRulesSection` once, above the method cards.
- Modify `client/src/lib/types.ts` — drop `'freeOver'` from `PricingType`, drop `freeOverStotinki`.
- Modify `server/src/modules/orders/delivery-pricing.ts` — drop `'freeOver'` from `DeliveryPricingType`, drop `freeOverStotinki`, refresh comments.
- Modify `server/src/modules/orders/delivery-pricing.spec.ts` — keep legacy-coverage test, adjust literals to the narrowed types.

`normalizeMethod` in `delivery-data.ts` (the legacy `freeOver`/`byWeight` → `flat` migration) **stays** — it matches raw strings and is still needed for old saved blobs.

---

## Task 1 (E): Remove dead `freeOver` / `freeOverStotinki` types

**Files:**
- Modify: `client/src/lib/types.ts:180`, `:184-188`
- Modify: `server/src/modules/orders/delivery-pricing.ts:11`, `:13-17`, `:100-105`
- Modify: `server/src/modules/orders/delivery-pricing.spec.ts:31-34`

- [ ] **Step 1: Update the server spec to the narrowed types (test first)**

In `delivery-pricing.spec.ts`, the legacy-coverage test currently asserts a `freeOver` literal with a `freeOverStotinki` field. After the type narrows, `'freeOver'` and `freeOverStotinki` are no longer valid keys, so cast them. Replace lines 31-34:

```ts
    it('freeOver and legacy/unknown types are treated as flat (per-method free-over ignored)', () => {
      // `freeOver` was removed from the union but may still exist in old saved configs.
      expect(methodBaseFee({ type: 'freeOver' as never, feeStotinki: 700 }, 490)).toBe(700);
      // `byWeight` was removed from the union but may still exist in old saved configs.
      expect(methodBaseFee({ type: 'byWeight' as never, feeStotinki: 800 }, 490)).toBe(800);
```

- [ ] **Step 2: Run the spec to confirm it still passes against the OLD types**

Run: `cd server && npx vitest run src/modules/orders/delivery-pricing.spec.ts`
Expected: PASS (casts are valid against the wide types too).

- [ ] **Step 3: Narrow the server types**

In `delivery-pricing.ts`:
- Line 11: `export type DeliveryPricingType = 'free' | 'flat';`
- In `MethodPricing` (lines 13-17): delete the `freeOverStotinki?: number;` line.
- Update the `methodBaseFee` doc comment (lines ~100-105) to drop the `freeOver` wording — it now reads that any non-`free` type uses `feeStotinki ?? fallback`, and legacy/unknown stored types (`freeOver`, `byWeight`) still resolve to flat at runtime via the string fallthrough.

- [ ] **Step 4: Narrow the client types**

In `client/src/lib/types.ts`:
- Line 180: `export type PricingType = 'free' | 'flat';`
- In `MethodPricing` (lines 184-188): delete the `freeOverStotinki?: number;` line.

- [ ] **Step 5: Verify types + tests**

Run: `cd server && npx vitest run src/modules/orders/delivery-pricing.spec.ts && npx tsc --noEmit`
Run: `cd client && npx tsc --noEmit`
Expected: PASS / no errors. `normalizeMethod` still compiles (it compares `m.pricing?.type as string`).

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/types.ts server/src/modules/orders/delivery-pricing.ts server/src/modules/orders/delivery-pricing.spec.ts
git commit -m "refactor(delivery): drop dead freeOver/freeOverStotinki pricing types"
```

---

## Task 2 (D): Consolidate global rules into one section

**Rationale:** `pricing.freeThresholdStotinki` and `pricing.courierMarkupStotinki` are single global values, but the UI repeats them inside every method card (free-threshold in each flat method; markup in each of the 2 courier methods). A farmer editing "one card" silently changes the global value. Move both into one "Общи правила за доставка" section shown once.

**Files:**
- Modify: `client/src/components/delivery/methods-section.tsx`
- Modify: `client/src/components/delivery/delivery-client.tsx`

- [ ] **Step 1: Strip the per-card global inputs from `methods-section.tsx`**

In `MethodsSection`, drop the `freeThreshold`/`onFreeThresholdChange`/`markup`/`onMarkupChange` props threaded into `MethodCard` (the `<MethodCard ... freeThreshold=... markup=... />` call, lines ~83-86).

In `MethodCard`:
- Remove the `freeThreshold`, `onFreeThresholdChange`, `markup`, `onMarkupChange` params + their types.
- In the flat-pricing block (lines ~231-244): drop the second `LvInput` „Безплатно над сума"; keep only „Фиксирана такса". Collapse the grid to a single input:

```tsx
                {m.pricing?.type === 'flat' && (
                  <div className="mt-2.5 max-w-[220px]">
                    <LvInput
                      label="Фиксирана такса"
                      value={m.pricing.feeStotinki ?? 0}
                      onChange={(v) => patch((x) => (x.pricing!.feeStotinki = v))}
                    />
                  </div>
                )}
```

- Remove the entire `isCourier` markup block (lines ~265-276) and the `isCourier` const.

- [ ] **Step 2: Add a `GlobalRulesSection` export to `methods-section.tsx`**

Append a new exported component. It owns the two global values:

```tsx
/** The two delivery values that apply across all methods — kept in one place so a
 *  farmer doesn't edit „one card" and silently change a global rule. */
export function GlobalRulesSection({ cfg, mut }: { cfg: DeliveryConfig; mut: Mut }) {
  const econtMode = cfg.econt.mode ?? (cfg.econt.configured ? 'auto' : 'off');
  const courierOn = econtMode !== 'off';
  return (
    <DSection
      title="Общи правила"
      helper="Важат за всички методи наведнъж."
      info={<>„Безплатно над сума" и надценката върху куриера са общи — задаваш ги веднъж, не за всеки метод.</>}
    >
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <div>
          <LvInput
            label="Безплатна доставка над сума"
            value={cfg.pricing.freeThresholdStotinki}
            onChange={(v) => mut((d) => (d.pricing.freeThresholdStotinki = v))}
          />
          <p className="mt-1.5 text-[12.5px] text-ff-muted">
            Поръчка над тази сума пътува безплатно с всеки метод. 0 = без безплатна доставка.
          </p>
        </div>
        {courierOn && (
          <div>
            <LvInput
              label="Надценка върху куриерската цена"
              value={cfg.pricing.courierMarkupStotinki ?? 0}
              onChange={(v) => mut((d) => (d.pricing.courierMarkupStotinki = v))}
            />
            <p className="mt-1.5 text-[12.5px] text-ff-muted">
              Твоят марж върху цената на Еконт/Speedy, която клиентът плаща. 0 = без надценка.
            </p>
          </div>
        )}
      </div>
    </DSection>
  );
}
```

Ensure `DeliveryConfig` and `LvInput`/`DSection` are imported (they already are).

- [ ] **Step 3: Render `GlobalRulesSection` once in `delivery-client.tsx`**

Import it alongside `MethodsSection`:

```tsx
import { MethodsSection, GlobalRulesSection } from './methods-section';
```

Render it directly under `MethodsSection` (after line 100):

```tsx
        <MethodsSection cfg={cfg} mut={mut} slotFreeCount={slotFreeCount} />
        <GlobalRulesSection cfg={cfg} mut={mut} />
```

- [ ] **Step 4: Update the Econt help copy that points at the old location**

In `client/src/lib/delivery-data.ts`, the `ECONT_HELP.tips` last line says free-over is set "веднъж за всички методи" — still true, no change needed. No edit. (Verification step only.)

- [ ] **Step 5: Verify client builds**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: no type errors; build succeeds. No references remain to the removed `MethodCard` props.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/delivery/methods-section.tsx client/src/components/delivery/delivery-client.tsx
git commit -m "feat(delivery): one „Общи правила\" section for free-over + courier markup"
```

---

## Phase 1 Final Verification

- [ ] `cd server && npx vitest run` — full server suite green (baseline 947).
- [ ] `cd server && npx tsc --noEmit` — clean.
- [ ] `cd client && npx tsc --noEmit && npm run build` — clean + builds.
- [ ] `git log --oneline -2` — two commits present.

---

## Phase 2 — C (+B): Speedy as a configurable carrier + policy selector

> Specified for a follow-up focused PR. Needs live smoke against Speedy demo creds before deploy.

### C-Task 1: Backend — protect the Speedy secret (MUST land first)

**Files:** `server/src/modules/tenants/tenants.service.ts`, new `*.spec.ts`.

- Add `preserveSpeedySecret(existingDelivery, incoming)` mirroring `preserveEcontSecret` (lines ~625): if the incoming `delivery.speedy` omits `passwordEnc`, copy it from `existingDelivery.speedy.passwordEnc`.
- Extend `sanitizeDelivery` (line ~605) to also strip incoming `speedy.{password,passwordEnc,userName?}` credential writes — the encrypted slot is owned solely by `SpeedyService.saveCredentials`.
- Wire into `updateMe` (line ~201): `nextSettings.delivery = preserveSpeedySecret(existing.delivery, preserveEcontSecret(existing.delivery, sanitizeDelivery(delivery)))`.
- Test: saving a delivery blob with `speedy.sender` set and no `passwordEnc` keeps the stored `passwordEnc`; a blob trying to write `speedy.passwordEnc` is ignored.

### C-Task 2: Client types + api wiring

**Files:** `client/src/lib/types.ts`, `client/src/lib/api-client.ts`, `client/src/lib/delivery-data.ts`.

- Add to `DeliveryConfig`: `speedy?: SpeedyConfig;` and `carrierPolicy?: 'customer' | 'cheapest' | 'econt' | 'speedy';`.
- Add `SpeedyConfig` interface mirroring server `SpeedyStored` (env, configured, userName, clientSystemId, defaultServiceId, sender {contactName, phone, mode, officeId, siteId, streetId, streetNo}, defaultPackage {parcelsCount, weightKg, contents}, cod {enabled, processingType}, label {autoCreate}).
- Add `SpeedySite`/`SpeedyOffice`/`SpeedyStreet`/`SpeedySenderSuggestion` view types.
- api-client: `getSpeedyConfig()` → `GET speedy/config`; `saveSpeedyCredentials({env,userName,password,clientSystemId,defaultServiceId})` → `POST speedy/credentials`; `listSpeedySites(q)` → `GET speedy/sites?q=`; `listSpeedyOffices(siteId)` → `GET speedy/offices?siteId=`; `listSpeedyProfiles()` → `GET speedy/profiles`.
- `hydrateDelivery`: default `speedy` block (configured:false) + `carrierPolicy: 'customer'`.

### C-Task 3: `speedy-section.tsx` (mirror `econt-section.tsx`)

**Files:** new `client/src/components/delivery/speedy-section.tsx`.

Mirror the Econt section structure: (1) connect account (userName/password/clientSystemId/defaultServiceId + „Провери връзката" → `saveSpeedyCredentials`), (2) sender profile (contactName, phone, mode office/address, site autocomplete via `listSpeedySites`, office picker via `listSpeedyOffices`), (3) package & COD (weightKg, parcelsCount, contents, COD enabled + processingType CASH/POSTAL_MONEY_TRANSFER). Sender/package/COD persist via the normal `saveDelivery` blob (now secret-safe after C-Task 1). Speedy has no demo host — env is account-derived, no manual/auto mode (configured-or-not only).

### C-Task 4 (B): Carrier-policy selector + setup toggle

**Files:** `client/src/components/delivery/delivery-client.tsx`, `client/src/components/panels/setup-panel.tsx`.

- In `setup-panel.tsx`: add a Speedy enable affordance (or generalize „Доставка до адрес с куриер" to cover Econt and/or Speedy) so the farmer can turn Speedy on; render `<SpeedyConnectionSection>` in `delivery-client.tsx` when Speedy is on.
- In `delivery-client.tsx`: render a `CarrierPolicySection` (Segmented: По избор на клиента / По-евтиния / Само Еконт / Само Speedy → `cfg.carrierPolicy`) **only when `comparisonActive`** (both carriers live). Hidden otherwise so it's never a dead control.

### Phase 2 Verification

- Backend: full Vitest suite + new `preserveSpeedySecret` spec green.
- Client: `tsc --noEmit` + `npm run build`.
- Live smoke (pre-deploy): connect Speedy demo creds, save sender, confirm `passwordEnc` survives a subsequent delivery-settings save; enable both carriers, confirm the policy selector appears and persists.

---

## Self-Review Notes

- **Spec coverage:** D (Task 2), E (Task 1) fully covered with executable steps. B+C specified at task granularity for the follow-up PR with the secret-preservation gotcha called out. A explicitly decided (skip, with reason).
- **Type consistency:** `GlobalRulesSection`/`MethodsSection` props match `delivery-client.tsx` call sites; removed `MethodCard` props removed at both definition and call site. `PricingType`/`DeliveryPricingType` narrowed in lockstep (client + server) and the legacy migration (`normalizeMethod`) + legacy test (`as never`) keep old blobs working.
- **No placeholders:** all Phase 1 steps carry real code + exact commands.
