# Carrier Handling Policy (Phase 1 — Econt) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give farmers two carrier-config toggles — „преглед/тест преди плащане" + „хладилна доставка" — that auto-apply to every Econt COD/storefront shipment, cutting COD refusals on perishable food.

**Architecture:** One carrier-agnostic policy at `settings.delivery.handling` (jsonb, no migration). The panel writes it; the Econt service reads it when building a waybill and emits `refrigeratedPack` + an inspect-before-pay service. Default off → existing shipments are byte-identical. Speedy (Phase 2) is deferred behind a live spike (see spec).

**Tech Stack:** NestJS + Drizzle (server), Next.js + React (panel), Jest (server tests; client has no unit runner → verify via `pnpm -C client lint` + `next build`).

**Spec:** `docs/superpowers/specs/2026-06-28-carrier-handling-policy-design.md`

---

## File Structure

- `client/src/lib/types.ts` — add `DeliveryConfig.handling`.
- `client/src/lib/delivery-data.ts` — default + hydrate `handling`.
- `client/src/components/delivery/handling-section.tsx` — **new** panel UI block.
- `client/src/components/delivery/delivery-client.tsx` — render the new section.
- `server/src/modules/econt/econt.service.ts` — `InspectMode`, `econtInspectService()`, `resolveHandling()`, emit in `buildLabel`, thread at `createLabel`, manual passthrough.
- `server/src/modules/econt/dto/manual-shipment.dto.ts` — add `inspectBeforePay`.
- `server/src/modules/econt/econt.service.spec.ts` — tests for the above.

---

## Task 1: Shared `handling` type + client defaults

No behavior change — type + hydration only, verified by build.

**Files:**
- Modify: `client/src/lib/types.ts:259-268`
- Modify: `client/src/lib/delivery-data.ts` (DEFAULT_DELIVERY ~line 82, hydrateDelivery ~line 126)

- [ ] **Step 1: Add the type to `DeliveryConfig`**

In `client/src/lib/types.ts`, add the `handling` field and its type just above `DeliveryConfig` (after `EcontConfig`, line 255):

```ts
/** Carrier-agnostic handling policy applied to every COD/courier shipment.
 *  inspectBeforePay only ever applies to наложен платеж; ignored on prepaid. */
export type InspectBeforePay = 'off' | 'open' | 'test';
export interface HandlingPolicy {
  inspectBeforePay: InspectBeforePay; // отвори / тествай преди плащане
  refrigerated: boolean;              // хладилна доставка
}
```

Then add the field inside `DeliveryConfig` (after the `card` line, before the closing brace at line 268):

```ts
  /** Shared handling policy (inspect-before-pay + refrigerated). Absent → all off. */
  handling?: HandlingPolicy;
```

- [ ] **Step 2: Default it in `DEFAULT_DELIVERY`**

In `client/src/lib/delivery-data.ts`, inside the `DEFAULT_DELIVERY` object, add after the `cod: { enabled: true }` line (~line 82):

```ts
  handling: { inspectBeforePay: 'off', refrigerated: false },
```

- [ ] **Step 3: Hydrate it**

In `hydrateDelivery` (`client/src/lib/delivery-data.ts`), add to the returned object after the `card:` line (~line 127):

```ts
    handling: {
      inspectBeforePay: saved?.handling?.inspectBeforePay ?? d.handling!.inspectBeforePay,
      refrigerated: saved?.handling?.refrigerated ?? d.handling!.refrigerated,
    },
```

- [ ] **Step 4: Verify the client compiles + lints**

Run: `pnpm -C client lint`
Expected: no errors referencing `handling` / `HandlingPolicy`.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/delivery-data.ts
git commit -m "feat(delivery): handling policy type + client defaults (inspect/refrigerated)"
```

---

## Task 2: Econt inspect-before-pay mapper + `buildLabel` emit

TDD. `buildLabel` already emits `refrigeratedPack` from `order.refrigerated`; this adds the inspect service, gated on COD.

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts` (buildLabel order param ~line 458-473; services block ~line 538-540; module-scope helper near other free functions, e.g. above `buildManualOrderShape` ~line 1276)
- Test: `server/src/modules/econt/econt.service.spec.ts` (in the `EcontService.buildLabel` describe)

- [ ] **Step 1: Write the failing tests**

In `server/src/modules/econt/econt.service.spec.ts`, inside `describe('EcontService.buildLabel', …)` (after the test ending line 119), add:

```ts
  it('emits inspect-before-pay (open) on a COD order', () => {
    const label = build(
      { sender, defaultPackage: { weightKg: 1 } },
      {
        customerName: 'Х', customerPhone: '0', deliveryType: 'econt', econtOffice: '1',
        totalStotinki: 1000, paymentMethod: 'cod', inspectBeforePay: 'open',
      },
    );
    expect(label.services).toMatchObject({ invoiceBeforePayCD: 1 });
  });

  it('emits inspect-before-pay (test) on a COD order', () => {
    const label = build(
      { sender, defaultPackage: { weightKg: 1 } },
      {
        customerName: 'Х', customerPhone: '0', deliveryType: 'econt', econtOffice: '1',
        totalStotinki: 1000, paymentMethod: 'cod', inspectBeforePay: 'test',
      },
    );
    expect(label.services).toMatchObject({ invoiceBeforePayCD: 2 });
  });

  it('does NOT emit inspect on a prepaid order even when set', () => {
    const label = build(
      { sender, defaultPackage: { weightKg: 1 } },
      {
        customerName: 'Х', customerPhone: '0', deliveryType: 'econt', econtOffice: '1',
        totalStotinki: 1000, paymentMethod: 'online', inspectBeforePay: 'open',
      },
    );
    expect(label.services).toBeUndefined();
  });

  it('inspect off → no inspect service', () => {
    const label = build(
      { sender, defaultPackage: { weightKg: 1 } },
      {
        customerName: 'Х', customerPhone: '0', deliveryType: 'econt', econtOffice: '1',
        totalStotinki: 1000, paymentMethod: 'cod', inspectBeforePay: 'off',
      },
    );
    expect(label.services?.invoiceBeforePayCD).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C server test -- econt.service.spec`
Expected: the 3 positive/negative inspect tests FAIL (`invoiceBeforePayCD` undefined / present unexpectedly). Existing tests still pass.

- [ ] **Step 3: Add the mapper (module scope)**

In `server/src/modules/econt/econt.service.ts`, add this free function near the other module-scope helpers (e.g. directly above `export function buildManualOrderShape`, ~line 1276):

```ts
export type InspectMode = 'off' | 'open' | 'test';

/**
 * Econt „преглед/тест преди плащане" service fragment, merged into label.services.
 * Only meaningful on a COD shipment (the caller gates on collectCod).
 * // spike: confirm the exact Econt `services` key + values against the live API
 * // (demo) before the real-creds demo. Single source of truth → one-line fix here.
 */
export function econtInspectService(mode?: InspectMode | null): Record<string, unknown> | null {
  if (mode === 'open') return { invoiceBeforePayCD: 1 }; // отвори преди плащане
  if (mode === 'test') return { invoiceBeforePayCD: 2 }; // тествай преди плащане
  return null;
}
```

- [ ] **Step 4: Extend the `buildLabel` order param**

In the `buildLabel` `order` type (`server/src/modules/econt/econt.service.ts`, ~line 460-473), add after `refrigerated?: boolean | null;` (line 471):

```ts
      inspectBeforePay?: InspectMode | null;
```

- [ ] **Step 5: Emit the inspect service (COD-gated)**

In `buildLabel`, just after the refrigerated line (`if (order.refrigerated) services.refrigeratedPack = 1;`, line 540), add:

```ts
    // Преглед/тест преди плащане — only on a COD parcel (cuts refusals on food).
    if (collectCod) {
      const inspect = econtInspectService(order.inspectBeforePay);
      if (inspect) Object.assign(services, inspect);
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm -C server test -- econt.service.spec`
Expected: all `EcontService.buildLabel` tests PASS (new + existing).

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.service.spec.ts
git commit -m "feat(econt): inspect-before-pay service in buildLabel (COD-gated, spike field)"
```

---

## Task 3: Resolve handling + thread into the storefront waybill

TDD for the resolver; the `createLabel` wiring is verified by the resolver test + the full suite (it does live I/O so it isn't unit-tested directly).

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts` (`resolveHandling` helper; `createLabel` ~line 722-727)
- Test: `server/src/modules/econt/econt.service.spec.ts` (new describe)

- [ ] **Step 1: Write the failing test**

In `server/src/modules/econt/econt.service.spec.ts`, add a new describe block (e.g. after the `EcontService.buildLabel` describe):

```ts
describe('EcontService.resolveHandling', () => {
  const svc = new EcontService(
    {} as never, { get: () => '' } as never, {} as never, {} as never, {} as never,
  );
  const resolve = (settings: unknown): { refrigerated: boolean; inspectBeforePay: string } =>
    (svc as unknown as { resolveHandling: (s: unknown) => { refrigerated: boolean; inspectBeforePay: string } })
      .resolveHandling(settings);

  it('reads handling from settings.delivery.handling', () => {
    expect(resolve({ delivery: { handling: { inspectBeforePay: 'open', refrigerated: true } } }))
      .toEqual({ refrigerated: true, inspectBeforePay: 'open' });
  });

  it('defaults to off/false when absent or shapeless', () => {
    expect(resolve({})).toEqual({ refrigerated: false, inspectBeforePay: 'off' });
    expect(resolve(null)).toEqual({ refrigerated: false, inspectBeforePay: 'off' });
    expect(resolve({ delivery: {} })).toEqual({ refrigerated: false, inspectBeforePay: 'off' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C server test -- econt.service.spec`
Expected: FAIL — `resolveHandling is not a function`.

- [ ] **Step 3: Implement `resolveHandling` (private method)**

In `server/src/modules/econt/econt.service.ts`, add this private method to the `EcontService` class (near `orderForShipment`, ~line 431):

```ts
  /** Read the carrier-agnostic handling policy off the tenant settings blob.
   *  Defensive: any missing/odd shape → everything off. */
  private resolveHandling(settings: unknown): { refrigerated: boolean; inspectBeforePay: InspectMode } {
    const s = (settings as Record<string, unknown> | null) ?? {};
    const delivery = (s.delivery as Record<string, unknown> | null) ?? {};
    const h = (delivery.handling as Record<string, unknown> | null) ?? {};
    const mode = h.inspectBeforePay;
    return {
      refrigerated: h.refrigerated === true,
      inspectBeforePay: mode === 'open' || mode === 'test' ? mode : 'off',
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C server test -- econt.service.spec`
Expected: PASS.

- [ ] **Step 5: Thread handling into `createLabel`**

In `server/src/modules/econt/econt.service.ts`, change the `createLabel` body (lines 725-727) from:

```ts
    const { econt } = await this.loadStored(tenantId, store);
    const { order, items } = await this.orderForShipment(tenantId, orderId);
    const label = this.buildLabel(econt, order, items);
```

to:

```ts
    const { tenant, econt } = await this.loadStored(tenantId, store);
    const { order, items } = await this.orderForShipment(tenantId, orderId);
    const handling = this.resolveHandling(tenant.settings);
    const label = this.buildLabel(
      econt,
      { ...order, refrigerated: handling.refrigerated, inspectBeforePay: handling.inspectBeforePay },
      items,
    );
```

- [ ] **Step 6: Run the full Econt suite (no regression)**

Run: `pnpm -C server test -- econt.service.spec`
Expected: PASS (all). Also confirm `pnpm -C server build` succeeds (the `tenant` destructure + spread type-check).

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.service.spec.ts
git commit -m "feat(econt): thread farm handling policy into the storefront waybill"
```

---

## Task 4: Manual-shipment inspect passthrough (dostavki hand-entered)

TDD via `buildManualOrderShape`, so a manually created Econt label also honours inspect.

**Files:**
- Modify: `server/src/modules/econt/dto/manual-shipment.dto.ts`
- Modify: `server/src/modules/econt/econt.service.ts` (`ManualOrderShape` ~line 1271-1276 region + `buildManualOrderShape` body ~line 1288-1293; the function `input` param type)
- Test: `server/src/modules/econt/econt.service.spec.ts` (`describe('buildManualOrderShape')`, ~line 373)

- [ ] **Step 1: Write the failing test**

In `server/src/modules/econt/econt.service.spec.ts`, inside `describe('buildManualOrderShape', …)`, add:

```ts
  it('passes inspectBeforePay through to the order shape', () => {
    const o = buildManualOrderShape({
      receiverName: 'Х', receiverPhone: '0', deliveryMode: 'office',
      receiverOfficeCode: '1', codAmountStotinki: 1000, inspectBeforePay: 'open',
    });
    expect(o.inspectBeforePay).toBe('open');
  });

  it('omits inspectBeforePay when off/absent', () => {
    const o = buildManualOrderShape({ receiverName: 'Х', receiverPhone: '0', deliveryMode: 'office' });
    expect(o.inspectBeforePay).toBeUndefined();
  });
```

> The existing tests in this describe call `buildManualOrderShape(...)` directly (no wrapper) — match that.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C server test -- econt.service.spec`
Expected: FAIL — `shape.inspectBeforePay` is undefined when 'open' expected.

- [ ] **Step 3: Add the DTO field**

In `server/src/modules/econt/dto/manual-shipment.dto.ts`, add after `refrigerated?: boolean;`:

```ts
  @IsOptional() @IsIn(['off', 'open', 'test']) inspectBeforePay?: 'off' | 'open' | 'test';
```

(`IsIn` is already imported in that file.)

- [ ] **Step 4: Thread through `buildManualOrderShape`**

In `server/src/modules/econt/econt.service.ts`:

a) Add `inspectBeforePay?: InspectMode;` to the `ManualOrderShape` interface (the order-shape type ~line 1254-1259, alongside `refrigerated?`).

b) Add `inspectBeforePay?: InspectMode;` to the `buildManualOrderShape` `input` param type (~line 1271-1276, alongside `refrigerated?`).

c) In the returned object (~line 1290-1292), add after the `refrigerated` spread line:

```ts
    ...(input.inspectBeforePay && input.inspectBeforePay !== 'off'
      ? { inspectBeforePay: input.inspectBeforePay }
      : {}),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -C server test -- econt.service.spec`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/econt/dto/manual-shipment.dto.ts server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.service.spec.ts
git commit -m "feat(econt): inspect-before-pay on the manual (dostavki) shipment path"
```

---

## Task 5: Panel „Обработка на пратката" UI section

New carrier-agnostic config block, wired into the Доставка page. Client has no unit runner → verified by lint + build.

**Files:**
- Create: `client/src/components/delivery/handling-section.tsx`
- Modify: `client/src/components/delivery/delivery-client.tsx`

- [ ] **Step 1: Create the section component**

Create `client/src/components/delivery/handling-section.tsx`:

```tsx
'use client';

import * as React from 'react';
import type { DeliveryConfig, InspectBeforePay } from '@/lib/types';
import { DSection, DLabel, Segmented } from './ui';

/**
 * Carrier-agnostic handling policy. Set once here; auto-applied to every COD/courier
 * shipment (storefront auto-orders included). Inspect-before-pay only affects наложен
 * платеж — it is ignored on a prepaid order.
 */
export function HandlingSection({
  cfg,
  mut,
}: {
  cfg: DeliveryConfig;
  mut: (fn: (d: DeliveryConfig) => void) => void;
}) {
  const h = cfg.handling ?? { inspectBeforePay: 'off' as InspectBeforePay, refrigerated: false };

  const setInspect = (v: InspectBeforePay) =>
    mut((d) => {
      d.handling = { ...(d.handling ?? { inspectBeforePay: 'off', refrigerated: false }), inspectBeforePay: v };
    });
  const setRefrigerated = (v: string) =>
    mut((d) => {
      d.handling = {
        ...(d.handling ?? { inspectBeforePay: 'off', refrigerated: false }),
        refrigerated: v === 'yes',
      };
    });

  return (
    <DSection
      title="Обработка на пратката"
      helper="Прилага се автоматично към всяка поръчка с куриер. Прегледът/тестът важи само при наложен платеж."
    >
      <div className="flex flex-col gap-5">
        <DLabel
          label="Преглед преди плащане (наложен платеж)"
          hint="Клиентът може да отвори (или тества) пратката, преди да плати. Намалява отказите при храна."
        >
          <Segmented<InspectBeforePay>
            value={h.inspectBeforePay}
            onChange={setInspect}
            options={[
              { value: 'off', label: 'Изключено' },
              { value: 'open', label: 'Преглед (отвори)' },
              { value: 'test', label: 'Тест' },
            ]}
          />
        </DLabel>

        <DLabel label="Хладилна доставка" hint="Маркира пратките като хладилни/нетрайни (Еконт).">
          <Segmented<string>
            value={h.refrigerated ? 'yes' : 'no'}
            onChange={setRefrigerated}
            options={[
              { value: 'no', label: 'Не' },
              { value: 'yes', label: 'Да' },
            ]}
          />
        </DLabel>
      </div>
    </DSection>
  );
}
```

> `DLabel` (`ui.tsx:23`) is a `<label>` wrapper: it takes `label: string` + optional `hint: string` and renders its `children` (the control) between them. So the `Segmented` control goes as children and the description text goes in `hint`.

- [ ] **Step 2: Render it in the Доставка page**

In `client/src/components/delivery/delivery-client.tsx`:

a) Add the import after the other section imports (~line 16):

```tsx
import { HandlingSection } from './handling-section';
```

b) Render it inside the sections `div`, after `<MethodsSection … />` (line 100):

```tsx
        <HandlingSection cfg={cfg} mut={mut} />
```

- [ ] **Step 3: Verify lint + build**

Run: `pnpm -C client lint`
Then: `pnpm -C client build`
Expected: both succeed; no TS errors on `handling` / `InspectBeforePay` / `HandlingSection`.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/delivery/handling-section.tsx client/src/components/delivery/delivery-client.tsx
git commit -m "feat(delivery): panel „Обработка на пратката\" handling config section"
```

---

## Task 6: Full verification

- [ ] **Step 1: Server suite green**

Run: `pnpm -C server test`
Expected: all PASS (baseline 947/947 on main + the new tests).

- [ ] **Step 2: Server + client build**

Run: `pnpm -C server build` and `pnpm -C client build`
Expected: both succeed.

- [ ] **Step 3: Manual live-smoke checklist (do with real creds, not automated)**

1. In the panel → Доставка → „Обработка на пратката": set Преглед = „Преглед (отвори)", Хладилна = „Да", save.
2. Place a storefront COD Econt order on that farm.
3. Create the waybill (dostavki / createLabel) and inspect the outgoing Econt `label.services` payload (server log) — confirm `refrigeratedPack: 1` is present and the inspect field is accepted by the live API.
4. **Spike confirmation:** verify the real Econt `services` key/value for преглед/тест. If it is NOT `invoiceBeforePayCD`, correct `econtInspectService()` (single place) + the two `buildLabel` inspect tests, re-run `pnpm -C server test -- econt.service.spec`, recommit.
5. Plain prepaid order → confirm no `services` regression.

- [ ] **Step 4: Update memory + spec status**

Mark the spec/plan shipped in `project_farmflow_deliveries_package_cut` (or a new memory) once live-smoked; note Phase 2 (Speedy `obpd`/refrigerated) still pending the live spike.

---

## Self-review notes

- **Spec coverage:** handling type (T1), Econt inspect payload + COD gate (T2), storefront threading (T3), manual path (T4), panel UI (T5), tests + live spike (T2/T6). Speedy = Phase 2, intentionally out of this plan per spec.
- **Type consistency:** `InspectMode` (server) / `InspectBeforePay` (client) are the same union `'off'|'open'|'test'`; `resolveHandling` returns `inspectBeforePay`; `buildLabel` reads `order.inspectBeforePay`; `econtInspectService` takes the same union. `handling` shape `{ inspectBeforePay, refrigerated }` identical client + server.
- **Default-off safety:** every reader defaults to off/false; a farm with no `handling` produces an unchanged payload (covered by the existing "no flags + no COD → no services" test staying green).
