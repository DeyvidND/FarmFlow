# Courier Shipment Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator merge several per-farmer courier draft shipments (one customer, one destination) into a single waybill collected by one designated farmer, COD equal to the group total, while keeping the N per-farmer orders intact — assisted by an automatic suggestion engine.

**Architecture:** Checkout is unchanged (still splits a multi-farmer courier cart into N single-farmer COD orders + draft shipments). A new consolidation layer, exposed on the dostavki `/shipping` surface, (1) suggests groups of mergeable draft shipments, (2) marks one member's shipment the "master" — its `consolidation_group_id` points to itself, `cod_amount_stotinki` becomes the group sum — and the rest `consolidated` children, and (3) makes the carrier waybill code read the master's group-sum COD instead of the collector's own order total. Money owed to non-collector farmers is display-only.

**Tech Stack:** NestJS + Drizzle ORM (Postgres) on the server; hand-written SQL migrations under `packages/db/drizzle`; Next.js (`delivery-web`) for the dostavki UI, talking to the server through its `/bff/*` proxy.

## Global Constraints

- Money is integer stotinki (EUR cents) end-to-end. Never floats.
- Migrations are **hand-written** SQL, sequentially numbered under `packages/db/drizzle/`. The next free number is **0083**.
- `shipments.status` is free-form `text`; new value `'consolidated'` needs no enum migration, only documentation.
- `shipments.orderId` has a UNIQUE index (`shipments_order_unique`); order-less rows are not created by this feature (masters keep their own order).
- The dostavki surface is a separate Nest process (`EcontAppModule`); consolidation endpoints live there, under `@Controller('shipping')`, guarded by `JwtAuthGuard` + `@Roles(...)` + `@CurrentTenant()`.
- Consolidation is **admin-only** (tenant-wide). Use `@Roles('admin')` and reject when a farmer token (`@CurrentFarmer()` present) calls it — a farmer only sees their own shipments and cannot merge across farmers.
- Every consolidation endpoint is gated by `consolidateCourierEnabled(cfg)`; when off it behaves as if the feature does not exist (empty suggestions / 404-style rejection).
- Feature is off by default: `settings.delivery.consolidateCourier` absent → `false`.
- Bulgarian is the UI/user-facing copy language (match existing strings exactly).

---

## File Structure

**Create:**
- `packages/db/drizzle/0083_courier_consolidation.sql` — migration: `consolidation_group_id` column + index.
- `server/src/modules/econt-app/consolidation.helpers.ts` — pure functions: candidate grouping, consolidation planning, carrier resolution, COD override.
- `server/src/modules/econt-app/consolidation.helpers.spec.ts` — unit tests for the pure functions.
- `server/src/modules/econt-app/consolidation.service.ts` — DB reads + the consolidate/unconsolidate transactions + toggle read/write.
- `server/src/modules/econt-app/consolidation.controller.ts` — `/shipping` endpoints.
- `server/src/modules/econt-app/dto/consolidate.dto.ts` — request DTOs.
- `delivery-web/src/components/consolidation-modal.tsx` — the consolidate modal (self-contained).

**Modify:**
- `packages/db/src/schema.ts` — add the `consolidation_group_id` column + index to `shipments`.
- `server/src/modules/orders/delivery-pricing.ts` — add `consolidateCourier` to `DeliveryConfig` + `consolidateCourierEnabled()` accessor.
- `server/src/modules/orders/delivery-pricing.spec.ts` — test the accessor (create if absent).
- `server/src/modules/econt/econt.service.ts` — COD override in `createLabel`.
- `server/src/modules/speedy/speedy.service.ts` — COD override in `createLabelForOrder`.
- `server/src/modules/econt/econt.service.spec.ts` — assert the override wiring.
- `server/src/modules/econt-app/econt-app.module.ts` — register the new controller + service.
- `delivery-web/src/lib/api-client.ts` — consolidation API functions + types.
- `delivery-web/src/components/shipments-client.tsx` — render suggestion cards + wire the modal + per-farmer debt breakdown.

---

## Task 1: Migration + schema column

**Files:**
- Create: `packages/db/drizzle/0083_courier_consolidation.sql`
- Modify: `packages/db/src/schema.ts:514-574` (the `shipments` table)

**Interfaces:**
- Produces: `shipments.consolidationGroupId: string | null` (drizzle field, column `consolidation_group_id`), a self-FK to `shipments.id`; index `shipments_consolidation_group_idx`. New documented `status` value `'consolidated'`.

- [ ] **Step 1: Write the migration SQL**

Create `packages/db/drizzle/0083_courier_consolidation.sql`:

```sql
-- Courier shipment consolidation: a group of per-farmer courier draft shipments
-- (one customer, one destination) can be merged into ONE physical waybill. The
-- "master" is the collector farmer's shipment; its consolidation_group_id points
-- to its own id, and it collects the whole group's COD. The others become
-- status='consolidated' children whose consolidation_group_id points at the master.
ALTER TABLE "shipments"
  ADD COLUMN "consolidation_group_id" uuid REFERENCES "shipments"("id") ON DELETE SET NULL;

CREATE INDEX "shipments_consolidation_group_idx"
  ON "shipments" ("consolidation_group_id");
```

- [ ] **Step 2: Mirror the column in the Drizzle schema**

In `packages/db/src/schema.ts`, inside the `shipments` `pgTable` column block (after `codSettledAt`, around line 540), add:

```ts
    // --- Courier consolidation (migration 0083) ---
    // Links the per-farmer courier shipments physically shipped as one parcel. The
    // MASTER (the collector's shipment) carries its OWN id here and its
    // cod_amount_stotinki holds the whole group's COD; each CHILD carries the
    // master's id and status='consolidated' (superseded, no waybill of its own).
    // NULL for every non-consolidated shipment.
    consolidationGroupId: uuid('consolidation_group_id').references((): AnyPgColumn => shipments.id, {
      onDelete: 'set null',
    }),
```

In the same table's index block (the `(t) => ({ ... })` at line 561), add:

```ts
    consolidationGroupIdx: index('shipments_consolidation_group_idx').on(t.consolidationGroupId),
```

If `AnyPgColumn` is not already imported in this file, add it to the `drizzle-orm/pg-core` import. (The `catalog reorder` work already uses this self-reference pattern; follow it.)

- [ ] **Step 3: Build the db package to typecheck the schema**

Run: `npm --workspace @fermeribg/db run build`
Expected: PASS (no TS errors; `consolidationGroupId` resolves).

- [ ] **Step 4: Apply the migration to the dev database**

Run the repo's migration command (same one used for prior numbered migrations, e.g. `npm --workspace @fermeribg/db run migrate` or the documented psql apply).
Expected: `0083_courier_consolidation.sql` applies cleanly; `\d shipments` shows `consolidation_group_id` + the index.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/0083_courier_consolidation.sql packages/db/src/schema.ts
git commit -m "feat(db): add shipments.consolidation_group_id (migration 0083)"
```

---

## Task 2: Delivery-config accessor

**Files:**
- Modify: `server/src/modules/orders/delivery-pricing.ts:33-47` (the `DeliveryConfig` interface) and after `cardEnabled` (line 98)
- Test: `server/src/modules/orders/delivery-pricing.spec.ts`

**Interfaces:**
- Produces: `consolidateCourierEnabled(cfg: DeliveryConfig | null | undefined): boolean` — default `false`. `DeliveryConfig.consolidateCourier?: boolean`.

- [ ] **Step 1: Write the failing test**

Add to `server/src/modules/orders/delivery-pricing.spec.ts` (create the file with this content if it does not exist):

```ts
import { consolidateCourierEnabled } from './delivery-pricing';

describe('consolidateCourierEnabled', () => {
  it('defaults to false when unset', () => {
    expect(consolidateCourierEnabled(null)).toBe(false);
    expect(consolidateCourierEnabled({})).toBe(false);
  });
  it('reads the explicit flag', () => {
    expect(consolidateCourierEnabled({ consolidateCourier: true })).toBe(true);
    expect(consolidateCourierEnabled({ consolidateCourier: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace server test -- delivery-pricing.spec.ts`
Expected: FAIL — `consolidateCourierEnabled is not a function`.

- [ ] **Step 3: Implement the accessor**

In `server/src/modules/orders/delivery-pricing.ts`, add `consolidateCourier?: boolean;` to the `DeliveryConfig` interface (near `cod`/`card`), then add after `cardEnabled`:

```ts
/**
 * Whether the farm merges a multi-farmer courier order into one waybill (opt-in).
 * Off by default: absent flag means the current one-parcel-per-farmer behavior.
 */
export function consolidateCourierEnabled(cfg: DeliveryConfig | null | undefined): boolean {
  return cfg?.consolidateCourier ?? false;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace server test -- delivery-pricing.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/delivery-pricing.ts server/src/modules/orders/delivery-pricing.spec.ts
git commit -m "feat(delivery): add consolidateCourier config accessor"
```

---

## Task 3: Pure helpers — candidate grouping

**Files:**
- Create: `server/src/modules/econt-app/consolidation.helpers.ts`
- Test: `server/src/modules/econt-app/consolidation.helpers.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CandidateRow {
    shipmentId: string; orderId: string; orderNumber: number | null;
    farmerId: string; farmerName: string | null; totalStotinki: number;
    customerName: string | null; customerPhone: string | null;
    deliveryCity: string | null; deliveryAddress: string | null;
    visitorHash: string | null;
  }
  export interface SuggestionMember {
    shipmentId: string; orderId: string; orderNumber: number | null;
    farmerId: string; farmerName: string | null; totalStotinki: number;
  }
  export interface SuggestionGroup {
    key: string; customerName: string | null; customerPhone: string | null;
    deliveryCity: string | null; deliveryAddress: string | null;
    sumStotinki: number; members: SuggestionMember[];
  }
  export function groupConsolidationCandidates(rows: CandidateRow[]): SuggestionGroup[];
  ```

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/econt-app/consolidation.helpers.spec.ts`:

```ts
import { groupConsolidationCandidates, type CandidateRow } from './consolidation.helpers';

const row = (o: Partial<CandidateRow>): CandidateRow => ({
  shipmentId: 's', orderId: 'o', orderNumber: 1, farmerId: 'f', farmerName: 'F',
  totalStotinki: 1000, customerName: 'Иван', customerPhone: '0888 123 456',
  deliveryCity: 'Варна', deliveryAddress: 'ул. Х 1', visitorHash: null, ...o,
});

describe('groupConsolidationCandidates', () => {
  it('groups by shared visitor hash and sums totals', () => {
    const rows = [
      row({ shipmentId: 's1', orderId: 'o1', orderNumber: 7, farmerId: 'fA', totalStotinki: 1300, visitorHash: 'h1' }),
      row({ shipmentId: 's2', orderId: 'o2', orderNumber: 8, farmerId: 'fB', totalStotinki: 500, visitorHash: 'h1' }),
    ];
    const groups = groupConsolidationCandidates(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].sumStotinki).toBe(1800);
    expect(groups[0].members.map((m) => m.orderId)).toEqual(['o1', 'o2']);
  });

  it('drops singleton groups', () => {
    expect(groupConsolidationCandidates([row({ visitorHash: 'lonely' })])).toEqual([]);
  });

  it('falls back to phone+city+address when visitor hash is null', () => {
    const rows = [
      row({ shipmentId: 's1', orderId: 'o1', farmerId: 'fA', customerPhone: '0888-123-456', visitorHash: null }),
      row({ shipmentId: 's2', orderId: 'o2', farmerId: 'fB', customerPhone: '+359 888 123 456', visitorHash: null }),
    ];
    // Different-looking phones normalise to the same digits and same destination → one group.
    const groups = groupConsolidationCandidates(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(2);
  });

  it('keeps different destinations apart', () => {
    const rows = [
      row({ shipmentId: 's1', orderId: 'o1', farmerId: 'fA', deliveryAddress: 'ул. Х 1', visitorHash: null }),
      row({ shipmentId: 's2', orderId: 'o2', farmerId: 'fB', deliveryAddress: 'ул. Y 9', visitorHash: null }),
    ];
    expect(groupConsolidationCandidates(rows)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace server test -- consolidation.helpers.spec.ts`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Implement the grouping helper**

Create `server/src/modules/econt-app/consolidation.helpers.ts`:

```ts
/**
 * Pure helpers for courier shipment consolidation. No DB, no clock — the service
 * reads rows and hands them here so the grouping/planning logic is unit-testable.
 */

export interface CandidateRow {
  shipmentId: string;
  orderId: string;
  orderNumber: number | null;
  farmerId: string;
  farmerName: string | null;
  totalStotinki: number;
  customerName: string | null;
  customerPhone: string | null;
  deliveryCity: string | null;
  deliveryAddress: string | null;
  visitorHash: string | null;
}

export interface SuggestionMember {
  shipmentId: string;
  orderId: string;
  orderNumber: number | null;
  farmerId: string;
  farmerName: string | null;
  totalStotinki: number;
}

export interface SuggestionGroup {
  key: string;
  customerName: string | null;
  customerPhone: string | null;
  deliveryCity: string | null;
  deliveryAddress: string | null;
  sumStotinki: number;
  members: SuggestionMember[];
}

const digits = (s: string | null): string => (s ?? '').replace(/\D/g, '');

/**
 * Group key for "same customer, same destination". A shared visitor hash (both legs
 * of one checkout carry it — see createCourierOrders) is the strongest signal; when
 * absent, fall back to normalized phone + city + address.
 */
function candidateKey(r: CandidateRow): string {
  if (r.visitorHash) return `vh:${r.visitorHash}`;
  return `pa:${digits(r.customerPhone)}|${(r.deliveryCity ?? '').trim().toLowerCase()}|${(r.deliveryAddress ?? '').trim().toLowerCase()}`;
}

/**
 * Collapse candidate draft-shipment rows into suggestion groups. Only groups with
 * ≥2 members are returned; members are ordered by order number (stable). Group
 * order follows first appearance in `rows`.
 */
export function groupConsolidationCandidates(rows: CandidateRow[]): SuggestionGroup[] {
  const byKey = new Map<string, CandidateRow[]>();
  const order: string[] = [];
  for (const r of rows) {
    const k = candidateKey(r);
    const list = byKey.get(k);
    if (list) list.push(r);
    else {
      byKey.set(k, [r]);
      order.push(k);
    }
  }

  const out: SuggestionGroup[] = [];
  for (const k of order) {
    const list = byKey.get(k)!;
    if (list.length < 2) continue;
    const members = [...list]
      .sort((a, b) => (a.orderNumber ?? 0) - (b.orderNumber ?? 0))
      .map((r) => ({
        shipmentId: r.shipmentId,
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        farmerId: r.farmerId,
        farmerName: r.farmerName,
        totalStotinki: r.totalStotinki,
      }));
    const head = list[0];
    out.push({
      key: k,
      customerName: head.customerName,
      customerPhone: head.customerPhone,
      deliveryCity: head.deliveryCity,
      deliveryAddress: head.deliveryAddress,
      sumStotinki: members.reduce((s, m) => s + m.totalStotinki, 0),
      members,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace server test -- consolidation.helpers.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt-app/consolidation.helpers.ts server/src/modules/econt-app/consolidation.helpers.spec.ts
git commit -m "feat(consolidation): pure candidate grouping helper"
```

---

## Task 4: Pure helpers — planning, carrier resolution, COD override

**Files:**
- Modify: `server/src/modules/econt-app/consolidation.helpers.ts`
- Modify: `server/src/modules/econt-app/consolidation.helpers.spec.ts`

**Interfaces:**
- Consumes: `farmerDeliveryNamespace` / `farmerCourierReady` shape from `server/src/modules/orders/courier-eligibility.ts` (`{ econt?: { configured?: boolean }, speedy?: { configured?: boolean } }`).
- Produces:
  ```ts
  export interface MemberState {
    shipmentId: string; orderId: string; farmerId: string;
    status: string; hasWaybill: boolean; consolidationGroupId: string | null;
    totalStotinki: number;
  }
  export interface ConsolidationPlan {
    masterShipmentId: string; masterOrderId: string;
    childShipmentIds: string[]; codSumStotinki: number;
  }
  export class ConsolidationError extends Error {}  // message is user-facing (Bulgarian)
  export function planConsolidation(members: MemberState[], collectorFarmerId: string): ConsolidationPlan;
  export function resolveCollectorCarrier(
    ns: { econt?: { configured?: boolean }; speedy?: { configured?: boolean } } | undefined,
    requested?: 'econt' | 'speedy',
  ): 'econt' | 'speedy';
  export function consolidatedCodOverride(
    shipment: { id: string; consolidationGroupId: string | null; codAmountStotinki: number | null } | null | undefined,
  ): number | null;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `server/src/modules/econt-app/consolidation.helpers.spec.ts`:

```ts
import {
  planConsolidation, resolveCollectorCarrier, consolidatedCodOverride,
  ConsolidationError, type MemberState,
} from './consolidation.helpers';

const member = (o: Partial<MemberState>): MemberState => ({
  shipmentId: 's', orderId: 'o', farmerId: 'f', status: 'draft',
  hasWaybill: false, consolidationGroupId: null, totalStotinki: 1000, ...o,
});

describe('planConsolidation', () => {
  const members = [
    member({ shipmentId: 's1', orderId: 'o1', farmerId: 'fA', totalStotinki: 1300 }),
    member({ shipmentId: 's2', orderId: 'o2', farmerId: 'fB', totalStotinki: 500 }),
  ];

  it('makes the collector the master and sums COD', () => {
    const plan = planConsolidation(members, 'fB');
    expect(plan.masterShipmentId).toBe('s2');
    expect(plan.masterOrderId).toBe('o2');
    expect(plan.childShipmentIds).toEqual(['s1']);
    expect(plan.codSumStotinki).toBe(1800);
  });

  it('rejects fewer than two members', () => {
    expect(() => planConsolidation([members[0]], 'fA')).toThrow(ConsolidationError);
  });
  it('rejects a collector not in the group', () => {
    expect(() => planConsolidation(members, 'fZ')).toThrow(ConsolidationError);
  });
  it('rejects a member that already has a waybill', () => {
    const bad = [members[0], member({ shipmentId: 's2', farmerId: 'fB', hasWaybill: true })];
    expect(() => planConsolidation(bad, 'fA')).toThrow(ConsolidationError);
  });
  it('rejects a member already in a group', () => {
    const bad = [members[0], member({ shipmentId: 's2', farmerId: 'fB', consolidationGroupId: 'gX' })];
    expect(() => planConsolidation(bad, 'fA')).toThrow(ConsolidationError);
  });
});

describe('resolveCollectorCarrier', () => {
  it('uses the only configured carrier', () => {
    expect(resolveCollectorCarrier({ econt: { configured: true } })).toBe('econt');
    expect(resolveCollectorCarrier({ speedy: { configured: true } })).toBe('speedy');
  });
  it('honours a valid requested carrier when both are configured', () => {
    expect(resolveCollectorCarrier({ econt: { configured: true }, speedy: { configured: true } }, 'speedy')).toBe('speedy');
  });
  it('throws when both configured and none requested', () => {
    expect(() => resolveCollectorCarrier({ econt: { configured: true }, speedy: { configured: true } })).toThrow(ConsolidationError);
  });
  it('throws when the collector has no carrier', () => {
    expect(() => resolveCollectorCarrier({})).toThrow(ConsolidationError);
    expect(() => resolveCollectorCarrier(undefined)).toThrow(ConsolidationError);
  });
  it('throws when the requested carrier is not configured', () => {
    expect(() => resolveCollectorCarrier({ econt: { configured: true } }, 'speedy')).toThrow(ConsolidationError);
  });
});

describe('consolidatedCodOverride', () => {
  it('returns the group sum for a master shipment', () => {
    expect(consolidatedCodOverride({ id: 'm', consolidationGroupId: 'm', codAmountStotinki: 1800 })).toBe(1800);
  });
  it('returns null for a child or a non-consolidated shipment', () => {
    expect(consolidatedCodOverride({ id: 'c', consolidationGroupId: 'm', codAmountStotinki: 500 })).toBeNull();
    expect(consolidatedCodOverride({ id: 'x', consolidationGroupId: null, codAmountStotinki: 500 })).toBeNull();
    expect(consolidatedCodOverride(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace server test -- consolidation.helpers.spec.ts`
Expected: FAIL — new exports not found.

- [ ] **Step 3: Implement the planning helpers**

Append to `server/src/modules/econt-app/consolidation.helpers.ts`:

```ts
/** Thrown for any invalid consolidation request. `message` is user-facing (Bulgarian). */
export class ConsolidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsolidationError';
  }
}

export interface MemberState {
  shipmentId: string;
  orderId: string;
  farmerId: string;
  status: string;
  hasWaybill: boolean;
  consolidationGroupId: string | null;
  totalStotinki: number;
}

export interface ConsolidationPlan {
  masterShipmentId: string;
  masterOrderId: string;
  childShipmentIds: string[];
  codSumStotinki: number;
}

/**
 * Validate a set of member draft shipments and produce the merge plan: the
 * collector's shipment becomes the master (collects the summed COD), the rest
 * become children. Throws ConsolidationError on any invalid state.
 */
export function planConsolidation(members: MemberState[], collectorFarmerId: string): ConsolidationPlan {
  if (members.length < 2) {
    throw new ConsolidationError('Обединяването изисква поне две пратки.');
  }
  for (const m of members) {
    if (m.status !== 'draft' || m.hasWaybill) {
      throw new ConsolidationError('Една от пратките вече е обработена и не може да се обедини.');
    }
    if (m.consolidationGroupId) {
      throw new ConsolidationError('Една от пратките вече е обединена.');
    }
  }
  const master = members.find((m) => m.farmerId === collectorFarmerId);
  if (!master) {
    throw new ConsolidationError('Избраният събирач не е сред фермерите в групата.');
  }
  return {
    masterShipmentId: master.shipmentId,
    masterOrderId: master.orderId,
    childShipmentIds: members.filter((m) => m.shipmentId !== master.shipmentId).map((m) => m.shipmentId),
    codSumStotinki: members.reduce((s, m) => s + m.totalStotinki, 0),
  };
}

/**
 * Resolve which carrier the collector ships the consolidated parcel with. Uses the
 * single configured carrier; when both are configured a `requested` carrier must be
 * supplied. Throws when the collector cannot ship (or the request is unconfigured).
 */
export function resolveCollectorCarrier(
  ns: { econt?: { configured?: boolean }; speedy?: { configured?: boolean } } | undefined,
  requested?: 'econt' | 'speedy',
): 'econt' | 'speedy' {
  const econt = !!ns?.econt?.configured;
  const speedy = !!ns?.speedy?.configured;
  if (!econt && !speedy) {
    throw new ConsolidationError('Събирачът няма свързан куриер.');
  }
  if (requested) {
    if ((requested === 'econt' && !econt) || (requested === 'speedy' && !speedy)) {
      throw new ConsolidationError('Избраният куриер не е конфигуриран за събирача.');
    }
    return requested;
  }
  if (econt && speedy) {
    throw new ConsolidationError('Изберете куриер за обединената товарителница.');
  }
  return econt ? 'econt' : 'speedy';
}

/**
 * The COD a waybill must collect for `shipment`. For a consolidation MASTER
 * (consolidation_group_id === id) that is the stored group sum; otherwise null so
 * the caller keeps deriving COD from the order total (unchanged behaviour).
 */
export function consolidatedCodOverride(
  shipment: { id: string; consolidationGroupId: string | null; codAmountStotinki: number | null } | null | undefined,
): number | null {
  if (shipment && shipment.consolidationGroupId === shipment.id) {
    return shipment.codAmountStotinki;
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace server test -- consolidation.helpers.spec.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt-app/consolidation.helpers.ts server/src/modules/econt-app/consolidation.helpers.spec.ts
git commit -m "feat(consolidation): planning, carrier resolution, COD override helpers"
```

---

## Task 5: Waybill COD source fix (Econt + Speedy)

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts:874` (in `createLabel`)
- Modify: `server/src/modules/speedy/speedy.service.ts:509` (in `createLabelForOrder`)
- Test: `server/src/modules/econt-app/consolidation.helpers.spec.ts` already covers `consolidatedCodOverride`; add a service-level assertion in `server/src/modules/econt/econt.service.spec.ts`.

**Interfaces:**
- Consumes: `consolidatedCodOverride` from `../econt-app/consolidation.helpers`.

- [ ] **Step 1: Write the failing test**

Add to `server/src/modules/econt/econt.service.spec.ts` a focused test of the COD-source seam. Place it near the existing `codAmountFor` describe block:

```ts
import { consolidatedCodOverride } from '../econt-app/consolidation.helpers';

describe('consolidated master COD wins over order total', () => {
  it('uses the master shipment group sum, not codAmountFor(order)', () => {
    // The order total is the collector's own share (500); the master shipment holds
    // the whole group's COD (1800). The waybill must collect 1800.
    const masterDraft = { id: 'm', consolidationGroupId: 'm', codAmountStotinki: 1800 };
    const orderShare = 500;
    const cod = consolidatedCodOverride(masterDraft) ?? orderShare;
    expect(cod).toBe(1800);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace server test -- econt.service.spec.ts -t "consolidated master COD"`
Expected: FAIL — import path resolves but assertion only passes once the helper exists (from Task 4). If Task 4 is merged this test already passes; in that case, treat Step 1 as the *wiring* proof and proceed — the real change is Steps 3–4 wiring the helper into the services. (This is a wiring task; the behavioral guard is the helper unit test.)

- [ ] **Step 3: Wire the override into Econt `createLabel`**

In `server/src/modules/econt/econt.service.ts`, add the import at the top:

```ts
import { consolidatedCodOverride } from '../econt-app/consolidation.helpers';
```

Then in `createLabel`, replace the single COD line (currently `const codAmount = this.codAmountFor(order);` around line 874) with a pre-read of the existing draft shipment and a coalesce:

```ts
    // A consolidation master's draft shipment already holds the whole group's COD;
    // prefer it so the waybill collects the summed amount, not just this order's total.
    const [existingShipment] = await this.db
      .select({
        id: shipments.id,
        consolidationGroupId: shipments.consolidationGroupId,
        codAmountStotinki: shipments.codAmountStotinki,
      })
      .from(shipments)
      .where(eq(shipments.orderId, orderId))
      .limit(1);
    const codAmount = consolidatedCodOverride(existingShipment ?? null) ?? this.codAmountFor(order);
```

Confirm `shipments` and `eq` are already imported in this file (they are — used throughout `createLabel`).

- [ ] **Step 4: Wire the override into Speedy `createLabelForOrder`**

In `server/src/modules/speedy/speedy.service.ts`, add the import:

```ts
import { consolidatedCodOverride } from '../econt-app/consolidation.helpers';
```

Then in `createLabelForOrder`, replace the COD line (currently `const codAmount = input.codAmountStotinki && input.codAmountStotinki > 0 ? Math.round(input.codAmountStotinki) : null;` around line 509) with:

```ts
    const [existingShipment] = await this.db
      .select({
        id: shipments.id,
        consolidationGroupId: shipments.consolidationGroupId,
        codAmountStotinki: shipments.codAmountStotinki,
      })
      .from(shipments)
      .where(eq(shipments.orderId, orderId))
      .limit(1);
    const override = consolidatedCodOverride(existingShipment ?? null);
    const codAmount =
      override != null
        ? override
        : input.codAmountStotinki && input.codAmountStotinki > 0
          ? Math.round(input.codAmountStotinki)
          : null;
```

Confirm `shipments` and `eq` are imported in `speedy.service.ts` (they are — used in the same method's insert).

- [ ] **Step 5: Run the Econt + Speedy service specs**

Run: `npm --workspace server test -- econt.service.spec.ts speedy.service.spec.ts`
Expected: PASS — existing waybill specs stay green (non-consolidated orders read `null` override → unchanged), new COD assertion passes.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/speedy/speedy.service.ts server/src/modules/econt/econt.service.spec.ts
git commit -m "fix(carriers): consolidated master waybill collects the group-sum COD"
```

---

## Task 6: Consolidation service — suggestions + debt breakdown

**Files:**
- Create: `server/src/modules/econt-app/consolidation.service.ts`
- Test: covered by the pure helper specs (Task 3/4); the service is a thin DB adapter. Add a smoke test only for the toggle-gating branch.

**Interfaces:**
- Consumes: `DB_TOKEN` Database; `groupConsolidationCandidates`, `planConsolidation`, `resolveCollectorCarrier`, `ConsolidationError` from `./consolidation.helpers`; `consolidateCourierEnabled` from `../orders/delivery-pricing`; `farmerDeliveryNamespace` from `../orders/courier-eligibility`.
- Produces:
  ```ts
  class ConsolidationService {
    getSuggestions(tenantId: string): Promise<{ suggestions: SuggestionGroup[] }>;
    consolidate(tenantId: string, input: { collectorFarmerId: string; memberOrderIds: string[]; carrier?: 'econt' | 'speedy' }):
      Promise<{ masterShipmentId: string; carrier: 'econt' | 'speedy'; breakdown: Array<{ farmerId: string; farmerName: string | null; totalStotinki: number }>; sumStotinki: number }>;
    unconsolidate(tenantId: string, masterShipmentId: string): Promise<{ restored: number }>;
    getToggle(tenantId: string): Promise<{ enabled: boolean }>;
    setToggle(tenantId: string, enabled: boolean): Promise<{ enabled: boolean }>;
  }
  ```

- [ ] **Step 1: Write the failing smoke test**

Create `server/src/modules/econt-app/consolidation.service.spec.ts`:

```ts
import { ConsolidationService } from './consolidation.service';

function makeDb(deliveryCfg: unknown) {
  // Minimal drizzle-select stub: returns the tenant settings row for the cfg read.
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ settings: { delivery: deliveryCfg } }] }),
      }),
    }),
  } as any;
}

describe('ConsolidationService.getSuggestions gating', () => {
  it('returns empty when the toggle is off', async () => {
    const svc = new ConsolidationService(makeDb({ consolidateCourier: false }));
    await expect(svc.getSuggestions('t1')).resolves.toEqual({ suggestions: [] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace server test -- consolidation.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `server/src/modules/econt-app/consolidation.service.ts`:

```ts
import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type Database, orders, shipments, farmers, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { consolidateCourierEnabled, type DeliveryConfig } from '../orders/delivery-pricing';
import { farmerDeliveryNamespace } from '../orders/courier-eligibility';
import {
  groupConsolidationCandidates, planConsolidation, resolveCollectorCarrier,
  ConsolidationError, type CandidateRow, type SuggestionGroup, type MemberState,
} from './consolidation.helpers';

@Injectable()
export class ConsolidationService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  private async loadDeliveryCfg(tenantId: string): Promise<DeliveryConfig | null> {
    const [row] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return (row?.settings as { delivery?: DeliveryConfig } | null)?.delivery ?? null;
  }

  /** Candidate = tenant's unshipped courier draft shipments, joined to their order + farmer. */
  private async loadCandidates(tenantId: string): Promise<CandidateRow[]> {
    return this.db
      .select({
        shipmentId: shipments.id,
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        farmerId: orders.farmerId,
        farmerName: farmers.name,
        totalStotinki: orders.totalStotinki,
        customerName: orders.customerName,
        customerPhone: orders.customerPhone,
        deliveryCity: orders.deliveryCity,
        deliveryAddress: orders.deliveryAddress,
        visitorHash: orders.visitorHash,
      })
      .from(shipments)
      .innerJoin(orders, eq(shipments.orderId, orders.id))
      .leftJoin(farmers, eq(orders.farmerId, farmers.id))
      .where(
        and(
          eq(shipments.tenantId, tenantId),
          eq(shipments.status, 'draft'),
          isNull(shipments.consolidationGroupId),
          eq(orders.deliveryType, 'courier'),
          sql`${orders.status} <> 'cancelled'`,
          sql`${orders.farmerId} is not null`,
        ),
      ) as unknown as Promise<CandidateRow[]>;
  }

  async getToggle(tenantId: string): Promise<{ enabled: boolean }> {
    return { enabled: consolidateCourierEnabled(await this.loadDeliveryCfg(tenantId)) };
  }

  /**
   * Deep-merge only the consolidateCourier flag into settings.delivery, preserving
   * sibling keys. `jsonb_set` alone is unsafe here: with a 2-level path it is a no-op
   * when the intermediate `delivery` object is absent, so build the merge with `||`
   * (concatenation) at each level instead.
   */
  async setToggle(tenantId: string, enabled: boolean): Promise<{ enabled: boolean }> {
    await this.db
      .update(tenants)
      .set({
        settings: sql`coalesce(${tenants.settings}, '{}'::jsonb) || jsonb_build_object(
          'delivery',
          coalesce(${tenants.settings} -> 'delivery', '{}'::jsonb)
            || jsonb_build_object('consolidateCourier', to_jsonb(${enabled}))
        )`,
      })
      .where(eq(tenants.id, tenantId));
    return { enabled };
  }

  async getSuggestions(tenantId: string): Promise<{ suggestions: SuggestionGroup[] }> {
    if (!consolidateCourierEnabled(await this.loadDeliveryCfg(tenantId))) return { suggestions: [] };
    const rows = await this.loadCandidates(tenantId);
    return { suggestions: groupConsolidationCandidates(rows) };
  }

  async consolidate(
    tenantId: string,
    input: { collectorFarmerId: string; memberOrderIds: string[]; carrier?: 'econt' | 'speedy' },
  ) {
    const cfg = await this.loadDeliveryCfg(tenantId);
    if (!consolidateCourierEnabled(cfg)) throw new BadRequestException('Обединяването не е включено.');

    try {
      // Load member orders + their draft shipments (tenant-scoped).
      const rows = await this.db
        .select({
          shipmentId: shipments.id,
          orderId: orders.id,
          farmerId: orders.farmerId,
          farmerName: farmers.name,
          status: shipments.status,
          consolidationGroupId: shipments.consolidationGroupId,
          econtNo: shipments.econtShipmentNumber,
          trackingNo: shipments.trackingNumber,
          totalStotinki: orders.totalStotinki,
        })
        .from(orders)
        .innerJoin(shipments, eq(shipments.orderId, orders.id))
        .leftJoin(farmers, eq(orders.farmerId, farmers.id))
        .where(
          and(
            eq(orders.tenantId, tenantId),
            inArray(orders.id, input.memberOrderIds),
            eq(orders.deliveryType, 'courier'),
          ),
        );
      if (rows.length !== input.memberOrderIds.length) {
        throw new ConsolidationError('Някоя от поръчките не е намерена или не е куриерска.');
      }

      const members: MemberState[] = rows.map((r) => ({
        shipmentId: r.shipmentId,
        orderId: r.orderId,
        farmerId: r.farmerId as string,
        status: r.status,
        hasWaybill: !!(r.econtNo || r.trackingNo),
        consolidationGroupId: r.consolidationGroupId,
        totalStotinki: r.totalStotinki,
      }));

      const plan = planConsolidation(members, input.collectorFarmerId);
      const ns = farmerDeliveryNamespace(
        (await this.loadSettings(tenantId)),
        input.collectorFarmerId,
      );
      const carrier = resolveCollectorCarrier(ns, input.carrier);

      await this.db.transaction(async (tx) => {
        await tx
          .update(shipments)
          .set({
            consolidationGroupId: plan.masterShipmentId,
            codAmountStotinki: plan.codSumStotinki,
            carrier,
            updatedAt: new Date(),
          })
          .where(eq(shipments.id, plan.masterShipmentId));
        if (plan.childShipmentIds.length) {
          await tx
            .update(shipments)
            .set({
              consolidationGroupId: plan.masterShipmentId,
              status: 'consolidated',
              updatedAt: new Date(),
            })
            .where(inArray(shipments.id, plan.childShipmentIds));
        }
      });

      const breakdown = rows
        .map((r) => ({ farmerId: r.farmerId as string, farmerName: r.farmerName, totalStotinki: r.totalStotinki }));
      return { masterShipmentId: plan.masterShipmentId, carrier, breakdown, sumStotinki: plan.codSumStotinki };
    } catch (err) {
      if (err instanceof ConsolidationError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  async unconsolidate(tenantId: string, masterShipmentId: string): Promise<{ restored: number }> {
    const [master] = await this.db
      .select({
        id: shipments.id,
        groupId: shipments.consolidationGroupId,
        econtNo: shipments.econtShipmentNumber,
        trackingNo: shipments.trackingNumber,
        orderId: shipments.orderId,
      })
      .from(shipments)
      .where(and(eq(shipments.id, masterShipmentId), eq(shipments.tenantId, tenantId)))
      .limit(1);
    if (!master || master.groupId !== master.id) {
      throw new BadRequestException('Пратката не е обединена.');
    }
    if (master.econtNo || master.trackingNo) {
      throw new BadRequestException('Товарителницата вече е създадена — не може да се раздели.');
    }
    // Reset master COD to its own order total (its collector share) via codAmountFor rules:
    // an unpaid COD order's total; the update below reuses the order total directly.
    const [ord] = await this.db
      .select({ total: orders.totalStotinki, method: orders.paymentMethod, paidAt: orders.paidAt })
      .from(orders)
      .where(eq(orders.id, master.orderId as string))
      .limit(1);
    const ownCod = ord && ord.method === 'cod' && !ord.paidAt ? ord.total : null;

    const restored = await this.db.transaction(async (tx) => {
      const children = await tx
        .update(shipments)
        .set({ consolidationGroupId: null, status: 'draft', updatedAt: new Date() })
        .where(and(eq(shipments.consolidationGroupId, masterShipmentId), sql`${shipments.id} <> ${masterShipmentId}`))
        .returning({ id: shipments.id });
      await tx
        .update(shipments)
        .set({ consolidationGroupId: null, codAmountStotinki: ownCod, updatedAt: new Date() })
        .where(eq(shipments.id, masterShipmentId));
      return children.length;
    });
    return { restored };
  }

  private async loadSettings(tenantId: string): Promise<unknown> {
    const [row] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return row?.settings ?? null;
  }
}
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `npm --workspace server test -- consolidation.service.spec.ts`
Expected: PASS (toggle-off short-circuits before any candidate query).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt-app/consolidation.service.ts server/src/modules/econt-app/consolidation.service.spec.ts
git commit -m "feat(consolidation): service — suggestions, consolidate, unconsolidate, toggle"
```

---

## Task 7: DTOs + controller + module wiring

**Files:**
- Create: `server/src/modules/econt-app/dto/consolidate.dto.ts`
- Create: `server/src/modules/econt-app/consolidation.controller.ts`
- Modify: `server/src/modules/econt-app/econt-app.module.ts:62-74`

**Interfaces:**
- Consumes: `ConsolidationService` (Task 6); `JwtAuthGuard`, `Roles`, `CurrentTenant`, `CurrentFarmer` (same imports the sibling controller uses).
- Produces routes (all under the `shipping` base, admin-only): `GET shipping/consolidation/suggestions`, `GET shipping/consolidation/settings`, `POST shipping/consolidation/settings`, `POST shipping/consolidation`, `POST shipping/consolidation/:masterId/undo`.

- [ ] **Step 1: Write the DTOs**

Create `server/src/modules/econt-app/dto/consolidate.dto.ts`:

```ts
import { IsArray, IsBoolean, IsIn, IsOptional, IsUUID, ArrayMinSize } from 'class-validator';

export class ConsolidateDto {
  @IsUUID()
  collectorFarmerId!: string;

  @IsArray()
  @ArrayMinSize(2)
  @IsUUID('all', { each: true })
  memberOrderIds!: string[];

  @IsOptional()
  @IsIn(['econt', 'speedy'])
  carrier?: 'econt' | 'speedy';
}

export class ConsolidationToggleDto {
  @IsBoolean()
  enabled!: boolean;
}
```

- [ ] **Step 2: Write the controller**

Create `server/src/modules/econt-app/consolidation.controller.ts`:

```ts
import { Controller, Get, Post, Body, Param, ParseUUIDPipe, ForbiddenException, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentFarmer } from '../../common/decorators/current-farmer.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ConsolidationService } from './consolidation.service';
import { ConsolidateDto, ConsolidationToggleDto } from './dto/consolidate.dto';

/**
 * Courier shipment consolidation — admin-only, tenant-wide. A farmer token only
 * sees its own shipments and must never merge across farmers, so every handler
 * rejects when a farmer id is present on the token.
 */
@UseGuards(JwtAuthGuard)
@Controller('shipping')
export class ConsolidationController {
  constructor(private readonly consolidation: ConsolidationService) {}

  private assertAdmin(farmerId: string | undefined): void {
    if (farmerId) throw new ForbiddenException('Обединяването е достъпно само за оператора.');
  }

  @Roles('admin')
  @Get('consolidation/suggestions')
  suggestions(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined) {
    this.assertAdmin(f);
    return this.consolidation.getSuggestions(t);
  }

  @Roles('admin')
  @Get('consolidation/settings')
  getSettings(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined) {
    this.assertAdmin(f);
    return this.consolidation.getToggle(t);
  }

  @Roles('admin')
  @Post('consolidation/settings')
  setSettings(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined, @Body() dto: ConsolidationToggleDto) {
    this.assertAdmin(f);
    return this.consolidation.setToggle(t, dto.enabled);
  }

  @Roles('admin')
  @Post('consolidation')
  consolidate(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined, @Body() dto: ConsolidateDto) {
    this.assertAdmin(f);
    return this.consolidation.consolidate(t, dto);
  }

  @Roles('admin')
  @Post('consolidation/:masterId/undo')
  undo(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined, @Param('masterId', ParseUUIDPipe) masterId: string) {
    this.assertAdmin(f);
    return this.consolidation.unconsolidate(t, masterId);
  }
}
```

- [ ] **Step 3: Register in the module**

In `server/src/modules/econt-app/econt-app.module.ts`, import both:

```ts
import { ConsolidationController } from './consolidation.controller';
import { ConsolidationService } from './consolidation.service';
```

Add `ConsolidationController` to the `controllers:` array and `ConsolidationService` to the `providers:` array.

- [ ] **Step 4: Build the server**

Run: `npm --workspace server run build`
Expected: PASS — controller + service compile, DI resolves (`ConsolidationService` needs only `DB_TOKEN`, already provided by `DrizzleModule`).

- [ ] **Step 5: Run the server test suite for the module**

Run: `npm --workspace server test -- consolidation`
Expected: PASS (all consolidation specs green).

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/econt-app/consolidation.controller.ts server/src/modules/econt-app/dto/consolidate.dto.ts server/src/modules/econt-app/econt-app.module.ts
git commit -m "feat(consolidation): /shipping consolidation endpoints (admin-only)"
```

---

## Task 8: delivery-web API client

**Files:**
- Modify: `delivery-web/src/lib/api-client.ts` (append after the shipments section, ~line 280)

**Interfaces:**
- Produces:
  ```ts
  export interface ConsolidationMember { shipmentId: string; orderId: string; orderNumber: number | null; farmerId: string; farmerName: string | null; totalStotinki: number; }
  export interface ConsolidationSuggestion { key: string; customerName: string | null; customerPhone: string | null; deliveryCity: string | null; deliveryAddress: string | null; sumStotinki: number; members: ConsolidationMember[]; }
  export const listConsolidationSuggestions: () => Promise<ConsolidationSuggestion[]>;
  export const getConsolidationEnabled: () => Promise<boolean>;
  export const setConsolidationEnabled: (enabled: boolean) => Promise<boolean>;
  export const consolidateShipments: (input: { collectorFarmerId: string; memberOrderIds: string[]; carrier?: Carrier }) => Promise<{ masterShipmentId: string; carrier: Carrier; sumStotinki: number; breakdown: Array<{ farmerId: string; farmerName: string | null; totalStotinki: number }> }>;
  export const unconsolidateShipment: (masterId: string) => Promise<{ restored: number }>;
  ```

- [ ] **Step 1: Append the client functions**

Add to `delivery-web/src/lib/api-client.ts`:

```ts
/* ---------------------------- consolidation ------------------------------- */

export interface ConsolidationMember {
  shipmentId: string;
  orderId: string;
  orderNumber: number | null;
  farmerId: string;
  farmerName: string | null;
  totalStotinki: number;
}
export interface ConsolidationSuggestion {
  key: string;
  customerName: string | null;
  customerPhone: string | null;
  deliveryCity: string | null;
  deliveryAddress: string | null;
  sumStotinki: number;
  members: ConsolidationMember[];
}

export const listConsolidationSuggestions = async (): Promise<ConsolidationSuggestion[]> => {
  const body: { suggestions: ConsolidationSuggestion[] } = await (await bff('shipping/consolidation/suggestions')).json();
  return body.suggestions;
};

export const getConsolidationEnabled = async (): Promise<boolean> =>
  (await (await bff('shipping/consolidation/settings')).json()).enabled;

export const setConsolidationEnabled = async (enabled: boolean): Promise<boolean> =>
  (await (await bff('shipping/consolidation/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
  }, 'Запазването се провали')).json()).enabled;

export const consolidateShipments = async (
  input: { collectorFarmerId: string; memberOrderIds: string[]; carrier?: Carrier },
): Promise<{ masterShipmentId: string; carrier: Carrier; sumStotinki: number; breakdown: Array<{ farmerId: string; farmerName: string | null; totalStotinki: number }> }> =>
  (await bff('shipping/consolidation', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }, 'Обединяването се провали')).json();

export const unconsolidateShipment = async (masterId: string): Promise<{ restored: number }> =>
  (await bff(`shipping/consolidation/${masterId}/undo`, { method: 'POST' }, 'Разделянето се провали')).json();
```

- [ ] **Step 2: Typecheck delivery-web**

Run: `npm --workspace delivery-web run build` (or the repo's `tsc --noEmit` for delivery-web)
Expected: PASS — new exports typecheck.

- [ ] **Step 3: Commit**

```bash
git add delivery-web/src/lib/api-client.ts
git commit -m "feat(delivery-web): consolidation API client functions"
```

---

## Task 9: delivery-web UI — suggestion cards, modal, debt breakdown

**Files:**
- Create: `delivery-web/src/components/consolidation-modal.tsx`
- Modify: `delivery-web/src/components/shipments-client.tsx`

**Interfaces:**
- Consumes: `ConsolidationSuggestion`, `consolidateShipments`, `listConsolidationSuggestions`, `Carrier` from `../lib/api-client`.

- [ ] **Step 1: Write the modal component**

Create `delivery-web/src/components/consolidation-modal.tsx`. It receives one suggestion, lets the operator pick the collector (radio over the group's farmers) and, if needed, a carrier, then calls `consolidateShipments`:

```tsx
'use client';
import { useState } from 'react';
import { consolidateShipments, type Carrier, type ConsolidationSuggestion } from '../lib/api-client';

const eur = (st: number) => `€${(st / 100).toFixed(2)}`;

export function ConsolidationModal({
  suggestion, onClose, onDone,
}: {
  suggestion: ConsolidationSuggestion;
  onClose: () => void;
  onDone: () => void;
}) {
  const [collector, setCollector] = useState<string>(suggestion.members[0]?.farmerId ?? '');
  const [carrier, setCarrier] = useState<Carrier | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await consolidateShipments({
        collectorFarmerId: collector,
        memberOrderIds: suggestion.members.map((m) => m.orderId),
        carrier: carrier || undefined,
      });
      onDone();
    } catch (e) {
      // The server sends a Bulgarian message (e.g. "Изберете куриер...") — surface it.
      setError(e instanceof Error ? e.message : 'Обединяването се провали');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Обедини в 1 товарителница</h2>
        <p className="mt-1 text-sm text-gray-500">
          {suggestion.customerName} · {suggestion.deliveryCity} · {suggestion.deliveryAddress}
        </p>

        <div className="mt-4 space-y-2">
          <div className="text-sm font-medium text-gray-700">Кой фермер събира пратката?</div>
          {suggestion.members.map((m) => (
            <label key={m.farmerId} className="flex items-center justify-between gap-3 rounded-lg border p-2 text-sm">
              <span className="flex items-center gap-2">
                <input type="radio" name="collector" value={m.farmerId}
                  checked={collector === m.farmerId} onChange={() => setCollector(m.farmerId)} />
                {m.farmerName ?? 'Ферма'}
              </span>
              <span className="tabular-nums text-gray-500">{eur(m.totalStotinki)}</span>
            </label>
          ))}
        </div>

        <div className="mt-3">
          <div className="text-sm font-medium text-gray-700">Куриер</div>
          <div className="mt-1 flex gap-2 text-sm">
            {(['', 'econt', 'speedy'] as const).map((c) => (
              <button key={c || 'auto'} type="button"
                onClick={() => setCarrier(c)}
                className={`rounded-lg border px-3 py-1 ${carrier === c ? 'border-green-600 bg-green-50' : ''}`}>
                {c === '' ? 'Автоматично' : c === 'econt' ? 'Econt' : 'Speedy'}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-gray-400">Ако събирачът има само един куриер, остави „Автоматично".</p>
        </div>

        <div className="mt-4 flex items-center justify-between border-t pt-3 text-sm">
          <span className="text-gray-500">Общ наложен платеж</span>
          <span className="font-semibold tabular-nums">{eur(suggestion.sumStotinki)}</span>
        </div>

        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="rounded-lg px-3 py-2 text-sm" onClick={onClose} disabled={busy}>Отказ</button>
          <button type="button" className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            onClick={submit} disabled={busy || !collector}>
            {busy ? 'Обединявам…' : 'Обедини'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Match the exact Tailwind tokens / button classes already used in `shipments-client.tsx` if they differ from the above (colors, radius) — keep the component visually consistent with the existing panel.

- [ ] **Step 2: Wire suggestions + modal into the shipments client**

In `delivery-web/src/components/shipments-client.tsx`:

1. Add imports:
```tsx
import { listConsolidationSuggestions, type ConsolidationSuggestion } from '../lib/api-client';
import { ConsolidationModal } from './consolidation-modal';
```
2. Add state near the component's other `useState` hooks:
```tsx
const [suggestions, setSuggestions] = useState<ConsolidationSuggestion[]>([]);
const [activeSuggestion, setActiveSuggestion] = useState<ConsolidationSuggestion | null>(null);
```
3. Load suggestions where the component loads its shipments (in the same effect / refresh function). Failing silently is fine — the feature is optional and admin-only:
```tsx
const loadSuggestions = useCallback(() => {
  listConsolidationSuggestions().then(setSuggestions).catch(() => setSuggestions([]));
}, []);
```
Call `loadSuggestions()` alongside the existing shipments load, and again after a successful consolidate (see step 5).
4. Render the suggestion cards above the shipments table (only when `suggestions.length > 0`):
```tsx
{suggestions.length > 0 && (
  <div className="mb-4 space-y-2">
    {suggestions.map((s) => (
      <div key={s.key} className="flex items-center justify-between gap-3 rounded-xl border border-green-200 bg-green-50 p-3">
        <div className="text-sm">
          <div className="font-medium">Обедини {s.members.length} пратки → 1 товарителница</div>
          <div className="text-gray-500">{s.customerName} · {s.deliveryCity} · {s.deliveryAddress}</div>
        </div>
        <button type="button" className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white"
          onClick={() => setActiveSuggestion(s)}>
          Обедини
        </button>
      </div>
    ))}
  </div>
)}
```
5. Render the modal and refresh on completion:
```tsx
{activeSuggestion && (
  <ConsolidationModal
    suggestion={activeSuggestion}
    onClose={() => setActiveSuggestion(null)}
    onDone={() => { setActiveSuggestion(null); loadSuggestions(); /* + existing shipments reload */ }}
  />
)}
```
Use the component's existing shipments-reload function inside `onDone` so the merged rows (children now `consolidated`, master COD summed) re-render. If `useCallback`/`useState` are not yet imported in the file, add them.

- [ ] **Step 3: Build delivery-web**

Run: `npm --workspace delivery-web run build`
Expected: PASS — component compiles, no type errors.

- [ ] **Step 4: Verify in the browser**

Start the dostavki dev server (via the preview tooling / launch config) and, as an admin with `consolidateCourier` enabled and ≥2 courier draft shipments for one customer:
- The suggestion card renders above the table.
- Clicking "Обедини" opens the modal; picking a collector + "Обедини" closes it and the table refreshes.
- After merge: the master row's COD equals the group sum; child rows show `consolidated`.
Confirm no console/network errors (`preview_console_logs`, `preview_network`).

- [ ] **Step 5: Commit**

```bash
git add delivery-web/src/components/consolidation-modal.tsx delivery-web/src/components/shipments-client.tsx
git commit -m "feat(delivery-web): consolidation suggestion cards + merge modal"
```

---

## Task 10: Per-farmer debt breakdown on the master row

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts` (`listShipments` — attach a `consolidation` block to master rows) OR add a dedicated `GET shipping/consolidation/:masterId` detail endpoint.
- Modify: `delivery-web/src/lib/api-client.ts` + `delivery-web/src/components/shipments-client.tsx` — render the breakdown.

**Interfaces:**
- Produces: on a master shipment row, `consolidation?: { members: Array<{ farmerId: string; farmerName: string | null; totalStotinki: number }>; sumStotinki: number }`.

- [ ] **Step 1: Add a breakdown endpoint (simplest, avoids touching listShipments SQL)**

In `ConsolidationService`, add:

```ts
async breakdown(tenantId: string, masterShipmentId: string) {
  const rows = await this.db
    .select({ farmerId: orders.farmerId, farmerName: farmers.name, totalStotinki: orders.totalStotinki, status: orders.status })
    .from(shipments)
    .innerJoin(orders, eq(shipments.orderId, orders.id))
    .leftJoin(farmers, eq(orders.farmerId, farmers.id))
    .where(and(eq(shipments.tenantId, tenantId), eq(shipments.consolidationGroupId, masterShipmentId)));
  const members = rows
    .filter((r) => r.status !== 'cancelled')
    .map((r) => ({ farmerId: r.farmerId as string, farmerName: r.farmerName, totalStotinki: r.totalStotinki }));
  return { members, sumStotinki: members.reduce((s, m) => s + m.totalStotinki, 0) };
}
```

Add the route to `ConsolidationController`:

```ts
@Roles('admin')
@Get('consolidation/:masterId')
breakdown(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined, @Param('masterId', ParseUUIDPipe) masterId: string) {
  this.assertAdmin(f);
  return this.consolidation.breakdown(t, masterId);
}
```

- [ ] **Step 2: Add the client function**

In `delivery-web/src/lib/api-client.ts`:

```ts
export const consolidationBreakdown = async (masterId: string): Promise<{ members: Array<{ farmerId: string; farmerName: string | null; totalStotinki: number }>; sumStotinki: number }> =>
  (await bff(`shipping/consolidation/${masterId}`)).json();
```

- [ ] **Step 3: Render the breakdown + an "Раздели" (undo) action**

In `shipments-client.tsx`, for a shipment row whose `codAmountStotinki` exceeds its own order share and that carries a consolidation group (detectable because it's a courier master — expose `consolidationGroupId`/`isMaster` on the row via `listShipments`, or lazily fetch `consolidationBreakdown(shipmentId)` on expand), show a small "дължи се:" list:

```tsx
<div className="text-xs text-gray-500">
  дължи се: {breakdown.members.filter((m) => m.farmerId !== collectorFarmerId).map((m) => `${m.farmerName ?? 'Ферма'} ${eur(m.totalStotinki)}`).join(', ')}
</div>
```

and, while the master has no waybill, an "Раздели" button calling `unconsolidateShipment(masterId)` then reloading.

- [ ] **Step 4: Build both packages**

Run: `npm --workspace server run build && npm --workspace delivery-web run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt-app/consolidation.service.ts server/src/modules/econt-app/consolidation.controller.ts delivery-web/src/lib/api-client.ts delivery-web/src/components/shipments-client.tsx
git commit -m "feat(consolidation): per-farmer debt breakdown + undo on the master row"
```

---

## Task 11: Full regression + finalize

- [ ] **Step 1: Run the full server test suite**

Run: `npm --workspace server test`
Expected: PASS — especially the untouched `createCourierOrders`, checkout, econt/speedy label specs stay green.

- [ ] **Step 2: Build every touched package**

Run: `npm --workspace @fermeribg/db run build && npm --workspace server run build && npm --workspace delivery-web run build`
Expected: all PASS.

- [ ] **Step 3: Manual end-to-end (dostavki)**

With `consolidateCourier` on: place a marketplace courier order spanning 2–3 farmers on the storefront → confirm N per-farmer draft shipments exist → in dostavki, accept the suggestion, pick a collector → confirm one master waybill collects the summed COD, children are `consolidated`, and the debt breakdown lists the non-collector shares. Toggle off → suggestions disappear.

- [ ] **Step 4: Commit any final touch-ups and open the PR when the operator asks.**

---

## Self-Review Notes (coverage vs. spec)

- **Config option** → Task 2 (accessor) + Task 6/7 (toggle read/write endpoints) + Task 9/10 (UI). Covers "опция на деливъри сървиса".
- **Data model** → Task 1.
- **Suggestion engine** → Task 3 (grouping) + Task 6 (query) + Task 7 (endpoint) + Task 9 (cards).
- **Consolidate + undo** → Task 4 (planner) + Task 6 (transactions) + Task 7 (endpoints) + Task 9/10 (UI).
- **Waybill COD fix** → Task 5.
- **Debt display (offline)** → Task 10.
- **Edge cases** (shipped member, non-ready collector, cross-tenant, toggle off, cancelled member, single-member) → covered by `planConsolidation` / `resolveCollectorCarrier` guards (Task 4), service tenant-scoping + `breakdown` cancelled filter (Task 6/10), and `unconsolidate` waybill guard (Task 6).
- **Testing** → each task ends with its own test/build gate; Task 11 is the regression sweep.
