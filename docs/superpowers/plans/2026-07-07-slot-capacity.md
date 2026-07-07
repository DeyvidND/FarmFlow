# Slot Capacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a delivery slot accept N orders instead of exactly one, where N = how many people work that slot; set a default on the recurring rule plus a per-slot override.

**Architecture:** Add a `capacity` integer column to `delivery_slots` (default 1). Booked count is still computed live from non-cancelled orders — no counter column. Two existing "= 1" gates (booking check in `orders.service`, picker `HAVING` in `slots.service`) become capacity-aware. The recurring rule gains `defaultCapacity`, stamped onto every generated slot. Existing farms stay at 1 until they opt in.

**Tech Stack:** NestJS + Drizzle ORM (Postgres), Jest (server), Next.js + React + Vitest (client panel).

## Global Constraints

- Capacity range: **1–20**, clamped server-side (DTO + `normalizeRule`) and in the UI.
- Migration default `capacity = 1` — no behaviour change for existing slots/farms (opt-in).
- Model is a **plain number**. No named workers, no per-worker assignment, no storefront capacity exposure (`PublicSlot` stays trimmed).
- Farmer-facing label: **"Поръчки на слот"**, helper *"колко доставки поемаш едновременно (напр. 2 човека = 2)"*. No "capacity" jargon.
- Server tests: `cd server && npx jest <path>`. Client tests: `cd client && npx vitest run <path>`.
- Migrations are hand-written SQL + a `_journal.json` entry (no per-migration snapshot file is kept for recent migrations). Use `ADD COLUMN IF NOT EXISTS`.
- Commit after each task.

---

### Task 1: Add `capacity` column (migration + schema)

**Files:**
- Create: `packages/db/drizzle/0079_delivery_slot_capacity.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` (append entry idx 79)
- Modify: `packages/db/src/schema.ts:333` (add column in `deliverySlots`, after `generated`)

- [ ] **Step 1: Write the migration SQL**

Create `packages/db/drizzle/0079_delivery_slot_capacity.sql`:

```sql
ALTER TABLE "delivery_slots" ADD COLUMN IF NOT EXISTS "capacity" integer NOT NULL DEFAULT 1;
```

- [ ] **Step 2: Register the migration in the journal**

In `packages/db/drizzle/meta/_journal.json`, append to the `entries` array (after the `0078` object; add a comma after the previous closing brace):

```json
    {
      "idx": 79,
      "version": "7",
      "when": 1783328407000,
      "tag": "0079_delivery_slot_capacity",
      "breakpoints": true
    }
```

- [ ] **Step 3: Add the column to the Drizzle schema**

In `packages/db/src/schema.ts`, inside `deliverySlots` right after the `generated` column (line ~333):

```ts
    generated: boolean('generated').notNull().default(false),
    // How many orders this slot accepts (= how many people work it). Booked count
    // is computed live from non-cancelled orders; this is just the ceiling. Default
    // 1 preserves the historical one-order-per-slot behaviour. See migration 0079.
    capacity: integer('capacity').notNull().default(1),
```

Confirm `integer` is already imported at the top of `schema.ts` (it is — used by `orderNumber`). No new import needed.

- [ ] **Step 4: Build the db package to verify the schema compiles**

Run: `cd packages/db && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/0079_delivery_slot_capacity.sql packages/db/drizzle/meta/_journal.json packages/db/src/schema.ts
git commit -m "feat(slots): add capacity column to delivery_slots (migration 0079)"
```

---

### Task 2: `defaultCapacity` on the rule + `slotIsFull` helper (pure)

**Files:**
- Modify: `server/src/modules/slots/slot-rule.ts`
- Test: `server/src/modules/slots/slot-rule.spec.ts`

**Interfaces:**
- Produces:
  - `SlotRule.defaultCapacity?: number`
  - `clampCapacity(n: number | undefined): number` → returns an integer in [1, 20]
  - `slotIsFull(booked: number, capacity: number): boolean` → `booked >= clampCapacity(capacity)`

- [ ] **Step 1: Write the failing tests**

Add to `server/src/modules/slots/slot-rule.spec.ts` (import `clampCapacity`, `slotIsFull` alongside the existing imports on line 1):

```ts
import {
  slotRuleSlots,
  normalizeRule,
  migrateRule,
  clampCapacity,
  slotIsFull,
  type SlotRule,
} from './slot-rule';
```

Then add a new describe block at the end of the file:

```ts
describe('capacity', () => {
  it('clampCapacity clamps to [1,20] and floors', () => {
    expect(clampCapacity(undefined)).toBe(1);
    expect(clampCapacity(0)).toBe(1);
    expect(clampCapacity(-5)).toBe(1);
    expect(clampCapacity(2.9)).toBe(2);
    expect(clampCapacity(99)).toBe(20);
  });

  it('slotIsFull compares booked against clamped capacity', () => {
    expect(slotIsFull(0, 1)).toBe(false);
    expect(slotIsFull(1, 1)).toBe(true);
    expect(slotIsFull(1, 2)).toBe(false);
    expect(slotIsFull(2, 2)).toBe(true);
    // capacity 0 clamps to 1 → one booked fills it
    expect(slotIsFull(1, 0)).toBe(true);
  });

  it('normalizeRule clamps defaultCapacity', () => {
    const out = normalizeRule({ ...baseInput, defaultCapacity: 99 });
    expect(out.defaultCapacity).toBe(20);
    const out2 = normalizeRule({ ...baseInput, defaultCapacity: 0 });
    expect(out2.defaultCapacity).toBe(1);
    const out3 = normalizeRule({ ...baseInput }); // absent → 1
    expect(out3.defaultCapacity).toBe(1);
  });
});
```

Add this helper object near the top of the spec (after the `base` const, ~line 18) so the `normalizeRule` calls have a valid input:

```ts
const baseInput = {
  active: true,
  repeat: 'weekdays' as const,
  days: [{ dow: 1, timeFrom: '10:00', timeTo: '12:00' }],
  intervalDays: 3,
  intervalWindow: { timeFrom: '10:00', timeTo: '12:00' },
  anchorDate: '2026-06-01',
  horizonDays: 14,
};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx jest slot-rule.spec.ts -t capacity`
Expected: FAIL — `clampCapacity`/`slotIsFull` are not exported.

- [ ] **Step 3: Implement in `slot-rule.ts`**

Add `defaultCapacity` to the `SlotRule` interface (after `slotMinutes?`, ~line 39):

```ts
  /**
   * Default number of orders each generated slot accepts (= people working it).
   * 1 = historical one-order behaviour. Clamped to [1,20]. Individual slots can
   * override via their own `capacity` column.
   */
  defaultCapacity?: number;
```

Add the two exported pure helpers (near the other pure helpers, e.g. after `minToHhmm`, ~line 66):

```ts
/** Clamp an incoming capacity to an integer in [1,20]; undefined/0/negative → 1. */
export function clampCapacity(n: number | undefined): number {
  const v = Math.floor(n ?? 1);
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(20, v);
}

/** A slot is full when its live booked count reaches its (clamped) capacity. */
export function slotIsFull(booked: number, capacity: number): boolean {
  return booked >= clampCapacity(capacity);
}
```

In `migrateRule`, ensure legacy rules get a value — the spread already carries it through when present; no change needed there because `slotRuleSlots`/consumers read via `clampCapacity`.

In `normalizeRule`, add before the `return` (after the `slotMinutes` clamp, ~line 237):

```ts
  const defaultCapacity = clampCapacity(migrated.defaultCapacity);
```

and include it in the returned object (after `slotMinutes,`):

```ts
    slotMinutes,
    defaultCapacity,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx jest slot-rule.spec.ts`
Expected: PASS (new capacity block + all existing slot-rule tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/slots/slot-rule.ts server/src/modules/slots/slot-rule.spec.ts
git commit -m "feat(slots): defaultCapacity on rule + clampCapacity/slotIsFull helpers"
```

---

### Task 3: Generator stamps `capacity` on generated slots

**Files:**
- Modify: `server/src/modules/slots/slots.service.ts:364-374` (`materializeRule` insert)
- Test: `server/src/modules/slots/slots.service.spec.ts`

**Interfaces:**
- Consumes: `SlotRule.defaultCapacity`, `clampCapacity` (Task 2).

- [ ] **Step 1: Write the failing test**

In `server/src/modules/slots/slots.service.spec.ts`, add a test in the `SlotsService.materializeRule` describe block:

```ts
it('stamps defaultCapacity onto generated slots', async () => {
  const inserted: Record<string, unknown>[] = [];
  const svc = new SlotsService(fakeDb([], inserted), {} as never);
  jest.spyOn(svc, 'getRule').mockResolvedValue({
    active: true,
    repeat: 'interval',
    days: [],
    intervalDays: 3,
    intervalWindow: { timeFrom: '10:00', timeTo: '12:00' },
    anchorDate: '2026-06-08',
    horizonDays: 3,
    skipDates: [],
    defaultCapacity: 2,
  });
  await svc.materializeRule('t1', '2026-06-08');
  expect(inserted.length).toBeGreaterThan(0);
  expect(inserted.every((r) => r.capacity === 2)).toBe(true);
});

it('defaults capacity to 1 when the rule has no defaultCapacity', async () => {
  const inserted: Record<string, unknown>[] = [];
  const svc = new SlotsService(fakeDb([], inserted), {} as never);
  jest.spyOn(svc, 'getRule').mockResolvedValue({
    active: true,
    repeat: 'interval',
    days: [],
    intervalDays: 3,
    intervalWindow: { timeFrom: '10:00', timeTo: '12:00' },
    anchorDate: '2026-06-08',
    horizonDays: 3,
    skipDates: [],
  });
  await svc.materializeRule('t1', '2026-06-08');
  expect(inserted.every((r) => r.capacity === 1)).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx jest slots.service.spec.ts -t "stamps defaultCapacity"`
Expected: FAIL — inserted rows have no `capacity`.

- [ ] **Step 3: Implement**

In `slots.service.ts`, import `clampCapacity` from `./slot-rule` (extend the existing import on line 13):

```ts
import { SlotRule, slotRuleSlots, normalizeRule, migrateRule, clampCapacity } from './slot-rule';
```

In `materializeRule`, add `capacity` to the inserted row (inside the `missing.map`, ~line 365):

```ts
      await this.db.insert(deliverySlots).values(
        missing.map((w) => ({
          tenantId,
          date: w.date,
          timeFrom: w.timeFrom,
          timeTo: w.timeTo,
          generated: true,
          capacity: clampCapacity(rule.defaultCapacity),
          customerNote: rule.customerNote ?? null,
          driverNote: rule.driverNote ?? null,
        })),
      );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx jest slots.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/slots/slots.service.ts server/src/modules/slots/slots.service.spec.ts
git commit -m "feat(slots): generator stamps defaultCapacity onto generated slots"
```

---

### Task 4: DTOs + manual-slot create/update persist `capacity`

**Files:**
- Modify: `server/src/modules/slots/dto/create-slot.dto.ts`
- Modify: `server/src/modules/slots/dto/slot-rule.dto.ts`
- Modify: `server/src/modules/slots/slots.service.ts:74-115` (`create` base + `update` allow-list)
- (`update-slot.dto.ts` needs no change — it is `PartialType(CreateSlotDto)`, so it inherits `capacity`.)

**Interfaces:**
- Produces: `CreateSlotDto.capacity?: number`, `SaveSlotRuleDto.defaultCapacity?: number`.

- [ ] **Step 1: Add `capacity` to `CreateSlotDto`**

In `create-slot.dto.ts`, add after `timeTo` (line 28), before `dateTo`:

```ts
  @ApiPropertyOptional({
    example: 2,
    description: 'Колко поръчки приема слотът (1–20). По подразбиране 1.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  capacity?: number;
```

`IsInt`, `Min`, `Max`, `IsOptional`, `ApiPropertyOptional` are already imported.

- [ ] **Step 2: Add `defaultCapacity` to `SaveSlotRuleDto`**

In `slot-rule.dto.ts`, add after the `slotMinutes` block (line 60):

```ts
  @ApiPropertyOptional({
    example: 2,
    description: 'Колко поръчки приема всеки автоматичен слот (1–20). По подразбиране 1.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  defaultCapacity?: number;
```

- [ ] **Step 3: Persist `capacity` in `slots.service.create` and `update`**

In `slots.service.ts` `create`, add to the `base` object (~line 75):

```ts
    const base = {
      tenantId,
      timeFrom: dto.timeFrom,
      timeTo: dto.timeTo,
      capacity: dto.capacity ?? 1,
      customerNote: dto.customerNote ?? null,
      driverNote: dto.driverNote ?? null,
    };
```

In `update`, add `'capacity'` to the allow-list loop (~line 105):

```ts
    for (const k of ['timeFrom', 'timeTo', 'capacity', 'customerNote', 'driverNote'] as const) {
      if (dto[k] !== undefined) patch[k] = dto[k];
    }
```

- [ ] **Step 4: Build the server to verify types**

Run: `cd server && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/slots/dto/create-slot.dto.ts server/src/modules/slots/dto/slot-rule.dto.ts server/src/modules/slots/slots.service.ts
git commit -m "feat(slots): accept capacity on manual slots + defaultCapacity on rule DTO"
```

---

### Task 5: Booking gate honours slot capacity

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts:1374-1378`

**Interfaces:**
- Consumes: `slotIsFull` (Task 2), `slot.capacity` (Task 1 column, selected by the existing `.select()` on the locked row).

- [ ] **Step 1: Import `slotIsFull`**

In `orders.service.ts`, add an import (near the top with the other module imports):

```ts
import { slotIsFull } from '../slots/slot-rule';
```

- [ ] **Step 2: Change the gate**

Replace the count check (~line 1374-1378). The `slot` row is already selected `.for('update')`, so `slot.capacity` is available and the write is serialized:

```ts
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .where(and(eq(orders.slotId, slotId), ne(orders.status, 'cancelled')));
      if (slotIsFull(count, slot.capacity)) throw new ConflictException('Слотът е запълнен');
```

- [ ] **Step 3: Build + run the orders spec**

Run: `cd server && npx tsc -p tsconfig.json --noEmit && npx jest orders.service.spec.ts`
Expected: compiles; existing order specs PASS (no regression — capacity-1 slots still reject a second order because `slotIsFull(1, 1)` is true).

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/orders/orders.service.ts
git commit -m "feat(orders): booking gate allows up to slot.capacity orders"
```

---

### Task 6: Public picker returns a slot until it is full

**Files:**
- Modify: `server/src/modules/slots/slots.service.ts:235-253` (`findPublicBySlug` query)

- [ ] **Step 1: Change the HAVING to compare against capacity**

In `findPublicBySlug`, the grouped query currently filters `having count = 0`. Change it so a slot shows while it has room. The `HAVING` can reference the grouped-by column `deliverySlots.capacity` (add it to `groupBy` if grouping is by id only — Postgres allows referencing a column functionally dependent on the grouped PK, but be explicit to avoid ambiguity):

```ts
    const rows = await this.db
      .select({
        id: deliverySlots.id,
        date: deliverySlots.date,
        startTime: sql<string>`substring(${deliverySlots.timeFrom}::text from 1 for 5)`,
        endTime: sql<string>`substring(${deliverySlots.timeTo}::text from 1 for 5)`,
        customerNote: deliverySlots.customerNote,
      })
      .from(deliverySlots)
      .leftJoin(
        orders,
        and(eq(orders.slotId, deliverySlots.id), ne(orders.status, 'cancelled')),
      )
      .where(and(...filters))
      .groupBy(deliverySlots.id, deliverySlots.capacity)
      // A slot shows while its live order count is below its capacity.
      .having(sql`count(${orders.id}) < ${deliverySlots.capacity}`)
      .orderBy(deliverySlots.date, deliverySlots.timeFrom);
```

Note: `PublicSlot` is unchanged — `capacity` is used only in the `HAVING`, never selected/returned. The doc comment on `PublicSlot` (line 22) should be softened: change "A slot holds exactly one order, so only free slots … are returned" → "Only slots with remaining capacity (booked < capacity) are returned; capacity itself is never exposed."

- [ ] **Step 2: Build to verify the query compiles**

Run: `cd server && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual verification note**

The existing `slots.service.spec.ts` fakeDb does not model `leftJoin`/`groupBy`/`having`, so this SQL change is verified by build + the integration behaviour in Task 5's booking gate (both read the same `capacity`). Confirm intent by reading the query: a capacity-2 slot with 1 booked order → `count = 1 < 2` → returned; with 2 booked → `2 < 2` false → hidden. No new unit test (matches the file's existing coverage boundary for this method).

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/slots/slots.service.ts
git commit -m "feat(slots): storefront picker shows a slot until capacity is reached"
```

---

### Task 7: Client — capacity in types, colour, pill, free/next-free counters

**Files:**
- Modify: `client/src/lib/types.ts` (`Slot`, `SlotRule`, `DashboardSlot`)
- Modify: `client/src/lib/slots.ts` (`slotColor`)
- Modify: `client/src/components/slots/slot-pill.tsx`
- Modify: `client/src/app/(admin)/delivery/page.tsx:68`
- Modify: `client/src/components/dashboard/dashboard-client.tsx:300`
- Modify: `client/src/components/layout/topbar.tsx:68`
- Modify: `client/src/components/settings/config-sections.tsx:56,102`
- Test: `client/src/lib/slots.test.ts` (new)

**Interfaces:**
- Produces: `Slot.capacity: number`, `SlotRule.defaultCapacity?: number`, `DashboardSlot.capacity: number`, `slotColor(booked: number, capacity: number)`.

- [ ] **Step 1: Write the failing test**

Create `client/src/lib/slots.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { slotColor } from './slots';

describe('slotColor', () => {
  it('is green (free) while booked < capacity', () => {
    expect(slotColor(0, 1).bg).toContain('green');
    expect(slotColor(1, 2).bg).toContain('green');
  });
  it('is gray (full) when booked >= capacity', () => {
    expect(slotColor(1, 1).bg).not.toContain('green');
    expect(slotColor(2, 2).bg).not.toContain('green');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd client && npx vitest run src/lib/slots.test.ts`
Expected: FAIL — `slotColor` takes one argument / signature mismatch.

- [ ] **Step 3: Update types**

In `client/src/lib/types.ts`, add `capacity` to `Slot` (after `booked`, ~line 444):

```ts
  booked: number;
  capacity: number;
```

Add `capacity` to `DashboardSlot` (after its `booked`, ~line 494):

```ts
  booked: number;
  capacity: number;
```

Add `defaultCapacity` to the client `SlotRule` interface (find it in this file; add next to `slotMinutes?`):

```ts
  slotMinutes?: number;
  defaultCapacity?: number;
```

- [ ] **Step 4: Update `slotColor`**

Replace `client/src/lib/slots.ts`:

```ts
/** Slot pill palette. A slot is free while booked < capacity (green), else full (gray). */
export function slotColor(booked: number, capacity: number): { bg: string; ink: string } {
  if (booked >= Math.max(1, capacity)) {
    return { bg: 'var(--ff-gray-badge-bg)', ink: 'var(--ff-gray-badge-ink)' };
  }
  return { bg: 'var(--ff-green-50)', ink: 'var(--ff-green-700)' };
}
```

- [ ] **Step 5: Update `slot-pill.tsx`**

In `client/src/components/slots/slot-pill.tsx`, change the derived values and the status line:

```ts
  const cap = slot.capacity ?? 1;
  const c = slotColor(slot.booked, cap);
  const full = slot.booked >= cap;
```

Change the status line (~line 48-52) to show `booked/capacity` when capacity > 1, and the plain label otherwise:

```tsx
        <div className="mt-1 flex items-center justify-end">
          <span className="text-[11.5px] font-extrabold" style={{ color: c.ink }}>
            {cap > 1 ? `${slot.booked}/${cap}` : full ? 'Зает' : 'Свободен'}
          </span>
        </div>
```

- [ ] **Step 6: Update the free / next-free counters**

Each of these treats a slot as taken when `booked >= 1`; change to `booked >= capacity`.

`client/src/app/(admin)/delivery/page.tsx:68`:

```ts
  const freeThisWeek = slots.reduce((sum, s) => sum + ((s.booked ?? 0) >= (s.capacity ?? 1) ? 0 : 1), 0);
```

`client/src/components/dashboard/dashboard-client.tsx:300`:

```ts
                const taken = s.booked >= (s.capacity ?? 1);
```

`client/src/components/layout/topbar.tsx:68`:

```ts
      if (s.booked >= (s.capacity ?? 1)) {
```

`client/src/components/settings/config-sections.tsx:56` and `:102` (both identical lines):

```ts
        const freeThisWeek = slots.reduce((sum, sl) => sum + ((sl.booked ?? 0) >= (sl.capacity ?? 1) ? 0 : 1), 0);
```

- [ ] **Step 7: Run the test + typecheck**

Run: `cd client && npx vitest run src/lib/slots.test.ts`
Expected: PASS.
Run: `cd client && npx tsc -p tsconfig.json --noEmit`
Expected: no errors (all `slotColor` callers now pass capacity; `Slot.capacity` exists).

- [ ] **Step 8: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/slots.ts client/src/lib/slots.test.ts client/src/components/slots/slot-pill.tsx "client/src/app/(admin)/delivery/page.tsx" client/src/components/dashboard/dashboard-client.tsx client/src/components/layout/topbar.tsx client/src/components/settings/config-sections.tsx
git commit -m "feat(client): capacity-aware slot pill + free/next-free counters"
```

---

### Task 8: Client — capacity input in the add-slot dialog

**Files:**
- Modify: `client/src/components/slots/add-slot-dialog.tsx`
- Modify: `client/src/lib/api-client.ts` (createSlot / updateSlot body — include `capacity`)

**Interfaces:**
- Consumes: `SlotInput` gains `capacity: number`; the API layer sends it to `POST /slots` and `PATCH /slots/:id`.

- [ ] **Step 1: Add `capacity` to `SlotInput` and dialog state**

In `add-slot-dialog.tsx`, extend `SlotInput` (line 14):

```ts
export type SlotInput = {
  date: string;
  timeFrom: string;
  timeTo: string;
  capacity: number;
  customerNote?: string;
  driverNote?: string;
};
```

Add state (after the `to` state, ~line 35):

```ts
  const [capacity, setCapacity] = useState(slot?.capacity ?? 1);
```

- [ ] **Step 2: Add the input to the form**

Insert after the time grid (after line 99, before the customer-note label):

```tsx
          <label className={labelCls}>
            Поръчки на слот <span className="font-normal text-ff-muted">(колко доставки поемаш едновременно · напр. 2 човека = 2)</span>
            <input
              type="number"
              min={1}
              max={20}
              value={capacity}
              onChange={(e) => setCapacity(Math.min(20, Math.max(1, parseInt(e.target.value, 10) || 1)))}
              className={field}
            />
          </label>
```

- [ ] **Step 3: Pass it through `onSubmit`**

In `submit`, add `capacity` to the payload (~line 52):

```ts
        {
          date: theDate as string,
          timeFrom: from,
          timeTo: to,
          capacity,
          customerNote: cNote.trim() || undefined,
          driverNote: dNote.trim() || undefined,
        },
```

- [ ] **Step 4: Send `capacity` in the API client**

In `client/src/lib/api-client.ts`, find the create-slot and update-slot functions (they POST/PATCH to `/slots`). Ensure the request body forwards `capacity` from the `SlotInput`. If the body is built by spreading the input, no change is needed; if fields are listed explicitly, add `capacity: input.capacity`. Verify by grep:

Run: `cd client && grep -n "capacity\|timeFrom" src/lib/api-client.ts | head`
Expected: after the edit, the slot create/update body includes `capacity`.

- [ ] **Step 5: Typecheck**

Run: `cd client && npx tsc -p tsconfig.json --noEmit`
Expected: no errors (every `onSubmit`/`SlotInput` construction now provides `capacity`; if the slots-client day-schedule builder constructs `SlotInput` without capacity, add `capacity: 1` there).

- [ ] **Step 6: Commit**

```bash
git add client/src/components/slots/add-slot-dialog.tsx client/src/lib/api-client.ts
git commit -m "feat(client): capacity input on the add/edit slot dialog"
```

---

### Task 9: Client — default capacity in the recurrence card

**Files:**
- Modify: `client/src/components/slots/recurrence-card.tsx`

**Interfaces:**
- Consumes: `SlotRule.defaultCapacity` (client type, Task 7); `SaveSlotRuleDto.defaultCapacity` (server, Task 4).

- [ ] **Step 1: Add `defaultCapacity` to the card's `State`**

In `recurrence-card.tsx`, add to the `State` interface (after `slotMinutes`, ~line 125):

```ts
  slotMinutes: number;
  defaultCapacity: number;
```

- [ ] **Step 2: Seed it in `initialState`**

In the `!initial` branch (~line 143) add:

```ts
      slotMinutes: 0,
      defaultCapacity: 1,
```

In the populated branch (~line 161) add:

```ts
    slotMinutes: initial.slotMinutes ?? 0,
    defaultCapacity: initial.defaultCapacity ?? 1,
```

- [ ] **Step 3: Add the input inside the advanced section**

In the advanced block, right after the "Колко трае една доставка" `<label>…</label>` and its preview `<p>` (after line 401, inside the returned fragment of the IIFE — place it as a sibling after the IIFE call, ~after line 402):

```tsx
        <label className={cn(lbl, 'max-w-[14rem]')}>
          Поръчки на слот <span className="font-normal text-ff-muted">(колко доставки поемаш едновременно · напр. 2 човека = 2)</span>
          <input
            type="number"
            min={1}
            max={20}
            value={s.defaultCapacity}
            onChange={(e) => set({ defaultCapacity: Math.min(20, Math.max(1, parseInt(e.target.value, 10) || 1)) })}
            className={field}
          />
        </label>
```

- [ ] **Step 4: Include it in the save payload**

Find where the card builds the `SaveSlotRule` body (the object with `slotMinutes: s.slotMinutes`, ~line 237). Add:

```ts
        slotMinutes: s.slotMinutes,
        defaultCapacity: s.defaultCapacity,
```

If `api-client.ts` types the saveSlotRule argument explicitly, add `defaultCapacity?: number` to that type so the field is accepted.

- [ ] **Step 5: Typecheck**

Run: `cd client && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/slots/recurrence-card.tsx client/src/lib/api-client.ts
git commit -m "feat(client): default capacity control in the recurring-slot card"
```

---

## Final verification

- [ ] Server: `cd server && npx jest slot-rule.spec.ts slots.service.spec.ts orders.service.spec.ts` → all PASS.
- [ ] Server build: `cd server && npx tsc -p tsconfig.json --noEmit` → clean.
- [ ] Client: `cd client && npx vitest run && npx tsc -p tsconfig.json --noEmit` → all PASS, clean.
- [ ] Manual smoke (dev): set rule default capacity 2 → generated slots show `0/2`; book one order → `1/2`, slot still offered in the storefront picker; book second → `2/2`, slot disappears from the picker and a third booking returns "Слотът е запълнен".

## Self-review notes (coverage vs. spec)

- Data model (column + rule field): Tasks 1, 2. ✓
- Enforcement gates (booking, picker): Tasks 5, 6. ✓
- API/DTOs + generator + persistence: Tasks 2, 3, 4. ✓
- Client (types, pill, counters, both config inputs): Tasks 7, 8, 9. ✓
- Storefront unchanged: Task 6 keeps `PublicSlot` trimmed. ✓
- Edge cases (lower-below-booked, manual default 1, cancel frees unit): handled by `>=` gate + `DEFAULT 1` + live booked count — no extra task needed. ✓
- Copy string consistent across dialog + card + DTO descriptions. ✓
