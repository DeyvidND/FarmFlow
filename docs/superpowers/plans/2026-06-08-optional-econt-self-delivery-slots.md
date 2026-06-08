# Optional Econt + recurring self-delivery slots — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Econt optional (default-off, accounting hidden when off) and turn bare delivery slots into a convenient self-delivery tool: per-slot customer + driver notes and one recurring rule that auto-fills slots forward.

**Architecture:** Slot rows stay the booking authority. A single recurrence rule lives in `settings.slotRule` (jsonb sibling of `settings.delivery`, managed only by the slots module — so the Delivery-page save never touches it). A pure date-math helper expands the rule; a service method materializes missing `generated` slots within a rolling horizon. Materialization runs on rule save, on admin slots-page load, and a daily cron — never on the public read path. Notes are two new columns; only `customer_note` is ever exposed to the storefront.

**Tech Stack:** NestJS + Drizzle (Postgres) server; Next.js admin (`client/`); Astro storefront (`fermerski-pazar-chaika/`); Jest for server specs.

**Note vs spec:** the spec said `settings.delivery.slotRule`; this plan stores it at `settings.slotRule` (sibling) so the Delivery page's blob save can't clobber it. Functionally identical, cleaner ownership.

---

## File structure

**Server (`server/`)**
- `packages/db/src/schema.ts` — add 3 columns to `deliverySlots`.
- `packages/db/migrations/0030_*.sql` + meta — DDL.
- `src/modules/slots/slot-rule.ts` *(new)* — `SlotRule` type, `slotRuleDates()`, `normalizeRule()`, date helpers. Pure, unit-tested.
- `src/modules/slots/slots.service.ts` — notes in create/update, `customerNote` in public shape, `getRule`/`saveRule`/`materializeRule`/`deleteFutureUnbookedGenerated`/`addSkipDate`, cron.
- `src/modules/slots/dto/create-slot.dto.ts` — `customerNote?`, `driverNote?`.
- `src/modules/slots/dto/slot-rule.dto.ts` *(new)* — rule request DTO.
- `src/modules/slots/slots.controller.ts` — `GET`/`PUT /slots/rule`; materialize on `GET /slots`.
- `src/modules/slots/slots.module.ts` — no structural change (verify ScheduleModule reachable).
- `src/modules/slots/slot-rule.spec.ts` *(new)* + `slots.service.spec.ts` *(new/extend)*.

**Admin (`client/`)**
- `src/lib/types.ts` — extend `Slot`; add `SlotRule`.
- `src/lib/api-client.ts` — `createSlot` (+notes), `updateSlot`, `getSlotRule`, `saveSlotRule`.
- `src/lib/delivery-data.ts` — Econt default-off.
- `src/components/delivery/delivery-client.tsx` — gate accounting UI on mode.
- `src/components/delivery/methods-section.tsx` — hide Econt rows when off.
- `src/components/slots/add-slot-dialog.tsx` — notes + edit mode.
- `src/components/slots/slot-pill.tsx` — generated/note markers + edit click.
- `src/components/slots/slots-client.tsx` — wire edit + rule card.
- `src/components/slots/recurrence-card.tsx` *(new)* — the rule editor.
- `src/app/(admin)/slots/page.tsx` — load the rule alongside slots.

**Storefront (`fermerski-pazar-chaika/`)**
- `src/lib/types.ts` — `Slot.customerNote?`.
- `src/scripts/checkout-page.ts` — render `customerNote` in the picker.

---

## Phase 1 — DB + schema

### Task 1: Add note + generated columns to `delivery_slots`

**Files:**
- Modify: `packages/db/src/schema.ts:145-161`
- Create: `packages/db/migrations/0030_slot_notes.sql`

- [ ] **Step 1: Add columns to the Drizzle schema**

In `packages/db/src/schema.ts`, inside the `deliverySlots` table (after `isActive`):

```ts
    isActive: boolean('is_active').default(true),
    // Customer-facing note shown in the storefront slot picker (e.g. "ще се обадя
    // преди доставка"). Safe to expose publicly.
    customerNote: text('customer_note'),
    // Private note for whoever drives the route (area, phone, order). Admin-only —
    // never serialized to the storefront.
    driverNote: text('driver_note'),
    // True for rows created by the recurrence rule (vs. one-off manual slots). The
    // generator only ever touches generated rows.
    generated: boolean('generated').notNull().default(false),
```

Confirm `text` is already imported in this file (it is — used by other tables).

- [ ] **Step 2: Write the migration SQL**

Create `packages/db/migrations/0030_slot_notes.sql`:

```sql
ALTER TABLE "delivery_slots" ADD COLUMN "customer_note" text;
ALTER TABLE "delivery_slots" ADD COLUMN "driver_note" text;
ALTER TABLE "delivery_slots" ADD COLUMN "generated" boolean DEFAULT false NOT NULL;
```

- [ ] **Step 3: Register the migration in the journal**

Open `packages/db/migrations/meta/_journal.json`, copy the last entry, and append a new one incrementing `idx` (to the next integer) and `tag` to `"0030_slot_notes"`. Use the same `version`/`when` style as the previous entry (reuse the previous `when` value — `Date.now()` is unavailable; a stale-but-valid timestamp is fine since the tag drives ordering).

- [ ] **Step 4: Build the db package and apply the migration**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow; npm --workspace @farmflow/db run build; npm --workspace @farmflow/db run migrate`
Expected: build succeeds; migrate prints `0030_slot_notes` applied (or "no pending" if already applied).

If the project uses `drizzle-kit generate` instead of hand-written SQL, regenerate instead: `npm --workspace @farmflow/db run generate` then `... run migrate`, and skip Steps 2–3. Check `packages/db/package.json` scripts first to confirm which path this repo uses.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations
git commit -m "feat(db): slot customer/driver notes + generated flag (0030)"
```

---

## Phase 2 — Server: slot notes

### Task 2: Accept notes in the slot DTOs

**Files:**
- Modify: `server/src/modules/slots/dto/create-slot.dto.ts:52` (append fields)

- [ ] **Step 1: Add the note fields**

At the end of `CreateSlotDto` (after `weekdays?`):

```ts
  @ApiPropertyOptional({ example: 'Ще се обадя преди доставка', description: 'Shown to the customer in the storefront slot picker.' })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  customerNote?: string;

  @ApiPropertyOptional({ example: 'Маршрут Чайка→Левски, тел. 0888…', description: 'Private note for the driver — never exposed to the storefront.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  driverNote?: string;
```

Add `MaxLength` to the `class-validator` import at the top of the file. `UpdateSlotDto` already inherits these via `PartialType`.

- [ ] **Step 2: Typecheck**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow; npm --workspace @farmflow/server run build`
Expected: compiles (no usage yet — just the DTO).

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/slots/dto/create-slot.dto.ts
git commit -m "feat(slots): accept customerNote/driverNote in slot DTO"
```

### Task 3: Persist notes; expose only `customerNote` publicly

**Files:**
- Modify: `server/src/modules/slots/slots.service.ts` (`create`, `update`, `PublicSlot`, `findPublicBySlug`)
- Test: `server/src/modules/slots/slots.service.spec.ts`

- [ ] **Step 1: Write a failing spec for the public shape**

Create `server/src/modules/slots/slots.service.spec.ts` (if it doesn't exist) with a focused unit using a fake db. Keep it minimal — assert the SELECT shape includes `customerNote` and excludes `driverNote` by inspecting the column object the service builds. Simplest reliable approach: extract the public column list into an exported const and test that.

Add to `slots.service.ts` near `PublicSlot`:

```ts
/** Columns the storefront may read for a slot. driverNote is intentionally absent. */
export const PUBLIC_SLOT_COLUMNS = ['id', 'date', 'startTime', 'endTime', 'remaining', 'customerNote'] as const;
```

Spec:

```ts
import { PUBLIC_SLOT_COLUMNS } from './slots.service';

describe('PUBLIC_SLOT_COLUMNS', () => {
  it('exposes customerNote and never driverNote', () => {
    expect(PUBLIC_SLOT_COLUMNS).toContain('customerNote');
    expect(PUBLIC_SLOT_COLUMNS).not.toContain('driverNote');
  });
});
```

- [ ] **Step 2: Run it — fails (const not exported yet)**

Run: `npm --workspace @farmflow/server run test -- slots.service.spec`
Expected: FAIL (cannot find `PUBLIC_SLOT_COLUMNS`) until Step 3 adds it.

- [ ] **Step 3: Implement notes + public field**

In `slots.service.ts`:

1. Extend the `PublicSlot` interface with `customerNote: string | null;`.
2. Add the exported `PUBLIC_SLOT_COLUMNS` const from Step 1.
3. In `findPublicBySlug`, add to the `.select({...})`:

```ts
        remaining: sql<number>`(${deliverySlots.maxOrders} - count(${orders.id}))::int`,
        customerNote: deliverySlots.customerNote,
```

4. In `create`, include notes in the `base` object:

```ts
    const base = {
      tenantId,
      timeFrom: dto.timeFrom,
      timeTo: dto.timeTo,
      maxOrders: dto.maxOrders,
      customerNote: dto.customerNote ?? null,
      driverNote: dto.driverNote ?? null,
    };
```

5. `update` already spreads `dto` into `.set({ ...dto })`; strip the recurrence-only keys so a partial slot edit can't inject them. Replace the set call with an explicit allow-list:

```ts
  async update(id: string, tenantId: string, dto: UpdateSlotDto) {
    const patch: Record<string, unknown> = {};
    for (const k of ['timeFrom', 'timeTo', 'maxOrders', 'customerNote', 'driverNote'] as const) {
      if (dto[k] !== undefined) patch[k] = dto[k];
    }
    const [row] = await this.db
      .update(deliverySlots)
      .set(patch)
      .where(and(eq(deliverySlots.id, id), eq(deliverySlots.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Слотът не е намерен');
    return row;
  }
```

- [ ] **Step 4: Run the spec — passes**

Run: `npm --workspace @farmflow/server run test -- slots.service.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/slots/slots.service.ts server/src/modules/slots/slots.service.spec.ts
git commit -m "feat(slots): persist notes; expose only customerNote to storefront"
```

---

## Phase 3 — Server: recurrence rule

### Task 4: Rule type + pure date-math helper

**Files:**
- Create: `server/src/modules/slots/slot-rule.ts`
- Test: `server/src/modules/slots/slot-rule.spec.ts`

- [ ] **Step 1: Write the helper module**

Create `server/src/modules/slots/slot-rule.ts`:

```ts
/**
 * The single recurring self-delivery rule, stored at settings.slotRule. Pure
 * date math + validation — no db. The generator (slots.service) turns the dates
 * this produces into concrete `generated` slot rows.
 */
export interface SlotRule {
  active: boolean;
  repeat: 'weekdays' | 'interval';
  weekdays: number[]; // 0=Sun..6=Sat, for repeat:'weekdays'
  intervalDays: number; // >=1, for repeat:'interval'
  anchorDate: string; // YYYY-MM-DD; interval counts from here; also a lower bound
  timeFrom: string; // HH:MM
  timeTo: string; // HH:MM
  maxOrders: number;
  customerNote?: string;
  driverNote?: string;
  horizonDays: number; // how far ahead to keep filled
  skipDates: string[]; // dates the farmer deleted — never regenerate
  lastMaterializedDate?: string;
}

/** Add `n` days to an ISO date (UTC-stable, no TZ drift). */
export function isoAddDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isoMax = (a: string, b: string) => (a >= b ? a : b);

/**
 * Dates the rule should have slots on, within [max(today, anchor) … today+horizon],
 * minus skipDates. Bounded to 366 results. Returns [] for an inactive rule.
 */
export function slotRuleDates(rule: SlotRule, today: string): string[] {
  if (!rule.active) return [];
  const start = isoMax(today, rule.anchorDate);
  const end = isoAddDays(today, Math.max(0, rule.horizonDays));
  if (start > end) return [];
  const skip = new Set(rule.skipDates ?? []);
  const out: string[] = [];

  if (rule.repeat === 'weekdays') {
    const want = new Set(rule.weekdays ?? []);
    if (want.size === 0) return [];
    for (let iso = start; iso <= end; iso = isoAddDays(iso, 1)) {
      const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
      if (want.has(dow) && !skip.has(iso)) out.push(iso);
      if (out.length >= 366) break;
    }
  } else {
    const n = Math.max(1, Math.floor(rule.intervalDays || 1));
    let iso = rule.anchorDate;
    let guard = 0;
    while (iso < start && guard++ < 4000) iso = isoAddDays(iso, n);
    for (; iso <= end; iso = isoAddDays(iso, n)) {
      if (!skip.has(iso)) out.push(iso);
      if (out.length >= 366) break;
    }
  }
  return out;
}

const HHMM = /^\d{2}:\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate + clamp an incoming rule, preserving server-owned fields (skipDates)
 * from the previous stored rule. Throws Error('<bg message>') on invalid input;
 * the service maps it to BadRequestException.
 */
export function normalizeRule(input: Partial<SlotRule>, prev?: SlotRule | null): SlotRule {
  const repeat = input.repeat === 'interval' ? 'interval' : 'weekdays';
  const weekdays = Array.from(new Set((input.weekdays ?? []).filter((w) => Number.isInteger(w) && w >= 0 && w <= 6)));
  const intervalDays = Math.max(1, Math.floor(input.intervalDays ?? 1));
  const anchorDate = ISO.test(input.anchorDate ?? '') ? (input.anchorDate as string) : '';
  const timeFrom = input.timeFrom ?? '';
  const timeTo = input.timeTo ?? '';
  const maxOrders = Math.floor(input.maxOrders ?? 0);

  if (repeat === 'weekdays' && weekdays.length === 0) throw new Error('Избери поне един ден от седмицата');
  if (!ISO.test(anchorDate)) throw new Error('Невалидна начална дата');
  if (!HHMM.test(timeFrom) || !HHMM.test(timeTo)) throw new Error('Часът трябва да е ЧЧ:ММ');
  if (timeTo <= timeFrom) throw new Error('Краят трябва да е след началото');
  if (maxOrders < 1) throw new Error('Капацитетът трябва да е поне 1');

  return {
    active: input.active !== false,
    repeat,
    weekdays,
    intervalDays,
    anchorDate,
    timeFrom,
    timeTo,
    maxOrders,
    customerNote: input.customerNote?.slice(0, 280) || undefined,
    driverNote: input.driverNote?.slice(0, 500) || undefined,
    horizonDays: Math.min(60, Math.max(1, Math.floor(input.horizonDays ?? 28))),
    skipDates: prev?.skipDates ?? [],
    lastMaterializedDate: undefined,
  };
}
```

- [ ] **Step 2: Write the spec**

Create `server/src/modules/slots/slot-rule.spec.ts`:

```ts
import { slotRuleDates, normalizeRule, type SlotRule } from './slot-rule';

const base: SlotRule = {
  active: true, repeat: 'weekdays', weekdays: [1, 3, 5], intervalDays: 3,
  anchorDate: '2026-06-01', timeFrom: '10:00', timeTo: '12:00', maxOrders: 5,
  horizonDays: 14, skipDates: [],
};

describe('slotRuleDates', () => {
  it('weekday mode picks only matching weekdays in the horizon', () => {
    const d = slotRuleDates(base, '2026-06-08'); // 2026-06-08 is a Monday
    expect(d[0]).toBe('2026-06-08');
    // every date is Mon/Wed/Fri
    for (const iso of d) {
      const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
      expect([1, 3, 5]).toContain(dow);
    }
    expect(d[d.length - 1] <= '2026-06-22').toBe(true);
  });

  it('interval mode steps every N days from the anchor', () => {
    const r = { ...base, repeat: 'interval' as const, intervalDays: 3, anchorDate: '2026-06-02' };
    const d = slotRuleDates(r, '2026-06-08');
    expect(d).toEqual(['2026-06-08', '2026-06-11', '2026-06-14', '2026-06-17', '2026-06-20']);
  });

  it('excludes skipDates', () => {
    const d = slotRuleDates({ ...base, skipDates: ['2026-06-08'] }, '2026-06-08');
    expect(d).not.toContain('2026-06-08');
  });

  it('returns [] when inactive', () => {
    expect(slotRuleDates({ ...base, active: false }, '2026-06-08')).toEqual([]);
  });
});

describe('normalizeRule', () => {
  it('preserves prior skipDates', () => {
    const prev = { ...base, skipDates: ['2026-06-10'] };
    expect(normalizeRule(base, prev).skipDates).toEqual(['2026-06-10']);
  });
  it('rejects timeTo <= timeFrom', () => {
    expect(() => normalizeRule({ ...base, timeTo: '09:00' })).toThrow();
  });
  it('rejects empty weekdays in weekday mode', () => {
    expect(() => normalizeRule({ ...base, weekdays: [] })).toThrow();
  });
});
```

- [ ] **Step 3: Run — passes**

Run: `npm --workspace @farmflow/server run test -- slot-rule.spec`
Expected: PASS (4 + 3 assertions). If the interval-mode expected array differs, recompute by hand from the anchor and fix the expectation — do not weaken the test.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/slots/slot-rule.ts server/src/modules/slots/slot-rule.spec.ts
git commit -m "feat(slots): SlotRule type + pure date-expansion helper"
```

### Task 5: Service — load/save rule, materialize, skip-on-delete

**Files:**
- Modify: `server/src/modules/slots/slots.service.ts`
- Test: `server/src/modules/slots/slots.service.spec.ts`

- [ ] **Step 1: Add imports + a Sofia-today helper**

At the top of `slots.service.ts` extend the drizzle import to include `lt`/`notExists` as needed and import the rule module:

```ts
import { and, eq, ne, gte, lte, sql, getTableColumns } from 'drizzle-orm';
import { type Database, deliverySlots, orders, tenants } from '@farmflow/db';
import { SlotRule, slotRuleDates, normalizeRule } from './slot-rule';
```

Add a private helper inside the class:

```ts
  /** Today in Europe/Sofia as YYYY-MM-DD (matches the slots-page day grouping). */
  private bgToday(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }
```

- [ ] **Step 2: Add rule load/save/materialize methods**

Append these methods to `SlotsService`:

```ts
  /** The tenant's stored rule, or null. */
  async getRule(tenantId: string): Promise<SlotRule | null> {
    const [row] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const r = (row?.settings as Record<string, unknown> | null)?.slotRule;
    return (r as SlotRule) ?? null;
  }

  /**
   * Validate + persist the rule (preserving skipDates), then rebuild future
   * unbooked generated slots and materialize the horizon. Returns the saved rule.
   */
  async saveRule(tenantId: string, input: Partial<SlotRule>): Promise<SlotRule> {
    const prev = await this.getRule(tenantId);
    let rule: SlotRule;
    try {
      rule = normalizeRule(input, prev);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'Невалидно правило');
    }
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['slotRule'], ${JSON.stringify(rule)}::jsonb, true)`,
      })
      .where(eq(tenants.id, tenantId));

    await this.deleteFutureUnbookedGenerated(tenantId, this.bgToday());
    await this.materializeRule(tenantId);
    return rule;
  }

  /** Delete future generated slots that have no live order, so a rule edit can rebuild them. */
  private async deleteFutureUnbookedGenerated(tenantId: string, today: string): Promise<void> {
    await this.db.delete(deliverySlots).where(
      and(
        eq(deliverySlots.tenantId, tenantId),
        eq(deliverySlots.generated, true),
        gte(deliverySlots.date, today),
        sql`not exists (select 1 from ${orders} o where o.slot_id = ${deliverySlots.id} and o.status <> 'cancelled')`,
      ),
    );
  }

  /**
   * Insert any missing generated slots for the rule within its horizon. Idempotent
   * (diffs against existing generated rows in the window). Returns count inserted.
   * MUST NOT run on the public read path.
   */
  async materializeRule(tenantId: string, today = this.bgToday()): Promise<number> {
    const rule = await this.getRule(tenantId);
    if (!rule || !rule.active) return 0;
    const dates = slotRuleDates(rule, today);
    if (!dates.length) return 0;

    const existing = await this.db
      .select({ date: deliverySlots.date })
      .from(deliverySlots)
      .where(
        and(
          eq(deliverySlots.tenantId, tenantId),
          eq(deliverySlots.generated, true),
          gte(deliverySlots.date, dates[0]),
          lte(deliverySlots.date, dates[dates.length - 1]),
        ),
      );
    const have = new Set(existing.map((r) => r.date));
    const missing = dates.filter((d) => !have.has(d));
    if (missing.length) {
      await this.db.insert(deliverySlots).values(
        missing.map((date) => ({
          tenantId,
          date,
          timeFrom: rule.timeFrom,
          timeTo: rule.timeTo,
          maxOrders: rule.maxOrders,
          generated: true,
          customerNote: rule.customerNote ?? null,
          driverNote: rule.driverNote ?? null,
        })),
      );
    }
    if (rule.lastMaterializedDate !== today) {
      await this.db
        .update(tenants)
        .set({
          settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['slotRule','lastMaterializedDate'], to_jsonb(${today}::text), true)`,
        })
        .where(eq(tenants.id, tenantId));
    }
    return missing.length;
  }

  /** Append a date to the rule's skipDates so the generator won't recreate it. */
  private async addSkipDate(tenantId: string, date: string): Promise<void> {
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(
          coalesce(${tenants.settings}, '{}'::jsonb),
          array['slotRule','skipDates'],
          coalesce(${tenants.settings} -> 'slotRule' -> 'skipDates', '[]'::jsonb) || to_jsonb(${date}::text),
          true
        )`,
      })
      .where(and(eq(eq, eq), eq(tenants.id, tenantId))); // see Step 3 — fix the where clause
  }
```

- [ ] **Step 3: Fix the `addSkipDate` where clause and make `remove` record skips**

Correct `addSkipDate`'s where to just the tenant (the stray `eq(eq, eq)` above is a placeholder to force you to read this):

```ts
      .where(eq(tenants.id, tenantId));
```

Replace `remove` so deleting a generated slot records its date:

```ts
  async remove(id: string, tenantId: string): Promise<{ id: string }> {
    const [row] = await this.db
      .delete(deliverySlots)
      .where(and(eq(deliverySlots.id, id), eq(deliverySlots.tenantId, tenantId)))
      .returning({ id: deliverySlots.id, date: deliverySlots.date, generated: deliverySlots.generated });
    if (!row) throw new NotFoundException('Слотът не е намерен');
    if (row.generated) await this.addSkipDate(tenantId, row.date);
    return { id: row.id };
  }
```

Add `BadRequestException` to the `@nestjs/common` import if not present (it is already imported in this file).

- [ ] **Step 4: Write a service spec with a fake db**

Extend `slots.service.spec.ts`. Use a hand-rolled fake `Database` capturing inserts. Keep it tight — test that `materializeRule` skips already-present dates. Stub `getRule` by spying:

```ts
import { SlotsService } from './slots.service';

function fakeDb(existingDates: string[], inserted: any[]) {
  // minimal chainable stub matching the calls materializeRule makes
  const sel = {
    from: () => sel, where: async () => existingDates.map((date) => ({ date })),
  };
  const ins = { values: async (rows: any[]) => { inserted.push(...rows); } };
  const upd = { set: () => ({ where: async () => undefined }) };
  return { select: () => sel, insert: () => ins, update: () => upd } as any;
}

describe('SlotsService.materializeRule', () => {
  it('inserts only the missing dates', async () => {
    const inserted: any[] = [];
    const svc = new SlotsService(fakeDb(['2026-06-08'], inserted));
    jest.spyOn(svc, 'getRule').mockResolvedValue({
      active: true, repeat: 'interval', weekdays: [], intervalDays: 3,
      anchorDate: '2026-06-08', timeFrom: '10:00', timeTo: '12:00', maxOrders: 5,
      horizonDays: 9, skipDates: [],
    });
    const n = await svc.materializeRule('t1', '2026-06-08');
    // dates: 06-08, 06-11, 06-14, 06-17 ; 06-08 already exists → 3 inserted
    expect(n).toBe(3);
    expect(inserted.map((r) => r.date)).toEqual(['2026-06-11', '2026-06-14', '2026-06-17']);
    expect(inserted.every((r) => r.generated === true)).toBe(true);
  });
});
```

If the chainable stub proves brittle against the real call order, instead assert via a thin integration test against a test Postgres if the repo already has one (check `slots.service.spec.ts` siblings / `econt.service.spec.ts` for the established pattern and copy it). Do not skip the missing-date assertion.

- [ ] **Step 5: Run — passes**

Run: `npm --workspace @farmflow/server run test -- slots.service.spec`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/slots/slots.service.ts server/src/modules/slots/slots.service.spec.ts
git commit -m "feat(slots): recurrence rule load/save/materialize + skip-on-delete"
```

### Task 6: Controller — rule endpoints + materialize on GET /slots

**Files:**
- Create: `server/src/modules/slots/dto/slot-rule.dto.ts`
- Modify: `server/src/modules/slots/slots.controller.ts`
- Modify: `server/src/modules/slots/slots.service.ts` (`findAll` tops up)

- [ ] **Step 1: Rule request DTO**

Create `server/src/modules/slots/dto/slot-rule.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, MaxLength,
} from 'class-validator';

export class SaveSlotRuleDto {
  @ApiProperty() @IsBoolean() active: boolean;
  @ApiProperty({ enum: ['weekdays', 'interval'] }) @IsIn(['weekdays', 'interval']) repeat: 'weekdays' | 'interval';
  @ApiProperty({ example: [1, 3, 5] }) @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) weekdays: number[];
  @ApiProperty({ example: 3 }) @IsInt() @Min(1) intervalDays: number;
  @ApiProperty({ example: '2026-06-08' }) @IsDateString() anchorDate: string;
  @ApiProperty({ example: '10:00' }) @IsString() @Matches(/^\d{2}:\d{2}$/) timeFrom: string;
  @ApiProperty({ example: '12:00' }) @IsString() @Matches(/^\d{2}:\d{2}$/) timeTo: string;
  @ApiProperty({ example: 5 }) @IsInt() @Min(1) maxOrders: number;
  @ApiProperty({ example: 28 }) @IsInt() @Min(1) @Max(60) horizonDays: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(280) customerNote?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) driverNote?: string;
}
```

- [ ] **Step 2: Add controller routes**

In `slots.controller.ts`, import `SaveSlotRuleDto` and add to the authed `SlotsController`:

```ts
  @Get('rule')
  getRule(@CurrentTenant() tenantId: string) {
    return this.slotsService.getRule(tenantId);
  }

  @Put('rule')
  @UseGuards(ActiveSubscriptionGuard)
  saveRule(@CurrentTenant() tenantId: string, @Body() dto: SaveSlotRuleDto) {
    return this.slotsService.saveRule(tenantId, dto);
  }
```

Add `Put` to the `@nestjs/common` import. **Order matters:** declare `@Get('rule')` *before* any `@Get(':id')` route — there is none here (`@Get()` is the list), so `rule` won't be shadowed, but keep `@Get('rule')` above `@Patch(':id')`/`@Delete(':id')` for clarity.

- [ ] **Step 3: Materialize on the admin list load**

Make `findAll` top up first. Change its signature to `async` and prepend the materialize call:

```ts
  async findAll(tenantId: string, from?: string, to?: string): Promise<SlotWithBooked[]> {
    await this.materializeRule(tenantId); // idempotent top-up so the rule's slots show
    const filters = [eq(deliverySlots.tenantId, tenantId)];
    // …unchanged…
    return this.db.select({ /* …unchanged… */ }) /* … */;
  }
```

(The method already returns the query promise; wrap the existing body so the `await` precedes it.)

- [ ] **Step 4: Build + run all slot tests**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow; npm --workspace @farmflow/server run build; npm --workspace @farmflow/server run test -- slots`
Expected: build OK; specs PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/slots
git commit -m "feat(slots): GET/PUT /slots/rule + materialize on list load"
```

### Task 7: Daily cron to roll the horizon forward

**Files:**
- Modify: `server/src/modules/slots/slots.service.ts`
- Modify: `server/src/modules/slots/slots.module.ts` (only if ScheduleModule isn't globally available)

- [ ] **Step 1: Confirm ScheduleModule is registered**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow; rg -n "ScheduleModule" server/src`
Expected: a `ScheduleModule.forRoot()` in `app.module.ts` (the digest cron relies on it). If present, no module change needed. If it's only imported in the digest module, add `ScheduleModule` to `imports` in `slots.module.ts` (`import { ScheduleModule } from '@nestjs/schedule';`).

- [ ] **Step 2: Add the cron**

Import `Cron` and add the method to `SlotsService`:

```ts
import { Cron } from '@nestjs/schedule';
```

```ts
  /** Daily 06:30 Europe/Sofia: roll every active rule's horizon forward. */
  @Cron('30 6 * * *', { timeZone: 'Europe/Sofia' })
  async materializeAllRules(): Promise<void> {
    const rows = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(sql`${tenants.settings} -> 'slotRule' ->> 'active' = 'true'`);
    for (const t of rows) {
      try {
        await this.materializeRule(t.id);
      } catch {
        // one tenant's bad rule must not stop the others
      }
    }
  }
```

- [ ] **Step 3: Build**

Run: `npm --workspace @farmflow/server run build`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/slots
git commit -m "feat(slots): daily cron to materialize active rules"
```

---

## Phase 4 — Admin client

### Task 8: Client types + api-client

**Files:**
- Modify: `client/src/lib/types.ts:279-288` (`Slot`) + add `SlotRule`
- Modify: `client/src/lib/api-client.ts:273-281` (slots section)

- [ ] **Step 1: Extend the `Slot` type and add `SlotRule`**

In `client/src/lib/types.ts`, add to the `Slot` interface (after `booked`):

```ts
  customerNote: string | null;
  driverNote: string | null;
  generated: boolean;
```

Add a `SlotRule` interface near it:

```ts
export interface SlotRule {
  active: boolean;
  repeat: 'weekdays' | 'interval';
  weekdays: number[];
  intervalDays: number;
  anchorDate: string;
  timeFrom: string;
  timeTo: string;
  maxOrders: number;
  customerNote?: string;
  driverNote?: string;
  horizonDays: number;
  skipDates: string[];
  lastMaterializedDate?: string;
}
```

- [ ] **Step 2: Update api-client slot functions**

In `client/src/lib/api-client.ts`, replace `createSlot` and add `updateSlot` + rule calls; import `SlotRule`:

```ts
export const createSlot = (data: {
  date: string;
  timeFrom: string;
  timeTo: string;
  maxOrders: number;
  customerNote?: string;
  driverNote?: string;
}) => apiFetch<Slot>('slots', { method: 'POST', ...json(data) }, 'Неуспешно създаване на слот');

export const updateSlot = (
  id: string,
  data: { timeFrom?: string; timeTo?: string; maxOrders?: number; customerNote?: string; driverNote?: string },
) => apiFetch<Slot>(`slots/${id}`, { method: 'PATCH', ...json(data) }, 'Неуспешна промяна на слот');

export const getSlotRule = () => apiFetch<SlotRule | null>('slots/rule');

export const saveSlotRule = (rule: SlotRule) =>
  apiFetch<SlotRule>('slots/rule', { method: 'PUT', ...json(rule) }, 'Неуспешно записване на правилото');
```

Confirm `Slot` and now `SlotRule` are imported at the top of `api-client.ts` from `./types`.

- [ ] **Step 3: Typecheck**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow; npm --workspace @farmflow/client run build`
Expected: compiles (existing `createSlot` caller in slots-client still type-checks — notes are optional).

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/api-client.ts
git commit -m "feat(client): Slot notes/generated + SlotRule api-client"
```

### Task 9: Econt default-off + hide accounting when off

**Files:**
- Modify: `client/src/lib/delivery-data.ts:18-39,66-83`
- Modify: `client/src/components/delivery/delivery-client.tsx:147-160`
- Modify: `client/src/components/delivery/methods-section.tsx`

- [ ] **Step 1: Flip the defaults**

In `delivery-data.ts` `DEFAULT_DELIVERY`:
- `econtOffice.enabled` → `false`
- `econtAddress.enabled` → `false`
- `pickup.enabled` → `true`
- in the `econt` block add `mode: 'off' as const,` (alongside `env`/`configured`).

Reorder `methods.order` so self-delivery leads: `order: ['ownSlots', 'pickup', 'econtOffice', 'econtAddress']`.

- [ ] **Step 2: Gate the accounting UI on mode**

In `delivery-client.tsx`, import the mode resolver and compute it:

```ts
import { econtMode } from '@/lib/delivery-helpers'; // see Step 3 for where this lives
```

Add near the other derived values (after `econtReady`):

```ts
  const mode = cfg.econt.mode ?? (cfg.econt.configured ? 'auto' : 'off');
```

Then make the Econt-only pieces conditional:

```tsx
        <MethodsSection cfg={cfg} mut={mut} econtReady={econtReady} noMethods={noMethods} slotFreeCount={slotFreeCount} />
        <ScheduleSection cfg={cfg} mut={mut} />
        <PricingSection cfg={cfg} mut={mut} />
        <EcontConnectionSection cfg={cfg} mut={mut} toast={toastAdapter} />
        {mode === 'auto' && <OfficePickerPreview configured={econtReady} />}
        {mode === 'auto' && <ShipmentsTable toast={toastAdapter} />}
```

(Compute `mode` inline as above — no new import needed; the econt-section already uses the same expression.)

- [ ] **Step 3: Hide the Econt method rows when off**

Open `methods-section.tsx`. It renders rows from `cfg.methods.order` / `METHOD_META`. Add a filter so Econt rows are skipped when the mode is off. At the top of the component compute:

```ts
  const mode = cfg.econt.mode ?? (cfg.econt.configured ? 'auto' : 'off');
  const visibleKeys = cfg.methods.order.filter(
    (k) => !(mode === 'off' && (k === 'econtOffice' || k === 'econtAddress')),
  );
```

Replace the iteration source (`cfg.methods.order.map(...)`) with `visibleKeys.map(...)`. If the section currently maps over a different array, adapt the same filter to it. Read the file first to match its exact structure.

- [ ] **Step 4: Verify in the running admin**

Run the admin per the project's dev flow (see `project_farmflow_dev_verify` memory — preview runs `next start`, so rebuild). Then: a fresh tenant's Delivery page shows self-delivery + pickup as default-enabled, Econt mode = Изключено, and no Shipments table / office preview / Econt method rows. Switching mode → Автоматично reveals them again.

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow; npm --workspace @farmflow/client run build`
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/delivery-data.ts client/src/components/delivery/delivery-client.tsx client/src/components/delivery/methods-section.tsx
git commit -m "feat(delivery): Econt default-off; hide shipments/office/rows when off"
```

### Task 10: Slot add/edit dialog with notes + pill markers

**Files:**
- Modify: `client/src/components/slots/add-slot-dialog.tsx`
- Modify: `client/src/components/slots/slot-pill.tsx`
- Modify: `client/src/components/slots/slots-client.tsx`

- [ ] **Step 1: Make the dialog do add *and* edit, with notes**

Rewrite `add-slot-dialog.tsx` to accept an optional `slot` to edit and note fields. Full file:

```tsx
'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { bgWeekdayShort, ddmm, hhmm } from '@/lib/utils';
import type { Slot } from '@/lib/types';

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] font-bold text-ff-ink outline-none focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

export type SlotInput = {
  date: string;
  timeFrom: string;
  timeTo: string;
  maxOrders: number;
  customerNote?: string;
  driverNote?: string;
};

export function AddSlotDialog({
  date,
  slot,
  onClose,
  onSubmit,
}: {
  date: string | null;
  slot?: Slot | null;
  onClose: () => void;
  onSubmit: (d: SlotInput, editingId: string | null) => Promise<void>;
}) {
  const editing = !!slot;
  const [from, setFrom] = useState(slot ? hhmm(slot.timeFrom) : '09:00');
  const [to, setTo] = useState(slot ? hhmm(slot.timeTo) : '10:00');
  const [cap, setCap] = useState(slot ? String(slot.maxOrders) : '5');
  const [cNote, setCNote] = useState(slot?.customerNote ?? '');
  const [dNote, setDNote] = useState(slot?.driverNote ?? '');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const theDate = slot?.date ?? date;
  if (!theDate) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to)) return setErr('Часът трябва да е ЧЧ:ММ');
    if (to <= from) return setErr('Краят трябва да е след началото');
    const m = parseInt(cap, 10);
    if (!m || m < 1) return setErr('Невалиден капацитет');
    setLoading(true);
    try {
      await onSubmit(
        { date: theDate as string, timeFrom: from, timeTo: to, maxOrders: m, customerNote: cNote.trim() || undefined, driverNote: dNote.trim() || undefined },
        slot?.id ?? null,
      );
      onClose();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : 'Грешка');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="animate-ff-pop w-[400px] max-w-full rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-[18px] font-extrabold">{editing ? 'Редактирай слот' : 'Нов слот'}</h2>
          <button onClick={onClose} aria-label="Затвори" className="grid h-8 w-8 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2">
            <X size={18} />
          </button>
        </div>
        <p className="mb-4 text-[13px] text-ff-muted">{bgWeekdayShort(theDate)} · {ddmm(theDate)}</p>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>Начало<input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className={field} /></label>
            <label className={labelCls}>Край<input type="time" value={to} onChange={(e) => setTo(e.target.value)} className={field} /></label>
          </div>
          <label className={labelCls}>Капацитет (поръчки)<input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="numeric" className={field} /></label>
          <label className={labelCls}>
            Бележка за клиента <span className="font-normal text-ff-muted">(вижда се в магазина)</span>
            <input value={cNote} onChange={(e) => setCNote(e.target.value)} maxLength={280} placeholder="напр. Ще се обадя преди доставка" className={field} />
          </label>
          <label className={labelCls}>
            Бележка за доставчика <span className="font-normal text-ff-muted">(само за теб)</span>
            <input value={dNote} onChange={(e) => setDNote(e.target.value)} maxLength={500} placeholder="напр. Маршрут Чайка→Левски, тел. 0888…" className={field} />
          </label>

          {err && <p className="text-[13px] font-semibold text-ff-red">{err}</p>}

          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={onClose} className="rounded-sm">Отказ</Button>
            <Button variant="primary" type="submit" disabled={loading} className="rounded-sm">
              {loading ? 'Запазване…' : editing ? 'Запази' : 'Добави'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

Confirm `hhmm` is exported from `@/lib/utils` (it's used by `slot-pill.tsx`).

- [ ] **Step 2: Pill — generated badge, note dot, click-to-edit**

In `slot-pill.tsx`, add an `onEdit` prop and visual markers. Change the signature and body:

```tsx
export function SlotPill({ slot, onDelete, onEdit, busy }: { slot: Slot; onDelete: () => void; onEdit: () => void; busy?: boolean }) {
  const c = slotColor(slot.booked, slot.maxOrders);
  const pct = slot.maxOrders > 0 ? Math.round((slot.booked / slot.maxOrders) * 100) : 0;
  const hasNote = !!(slot.customerNote || slot.driverNote);

  return (
    <div className="group relative rounded-[10px] px-[9px] py-2" style={{ background: c.bg }}>
      <button onClick={onDelete} disabled={busy} aria-label="Изтрий слот" className="absolute right-1 top-1 hidden h-4 w-4 place-items-center rounded-full bg-white/70 text-ff-muted hover:text-ff-red group-hover:grid [@media(hover:none)]:grid">
        <X size={11} />
      </button>
      <button type="button" onClick={onEdit} className="block w-full text-left">
        <div className="flex items-center gap-1 whitespace-nowrap text-[11.5px] font-bold text-ff-ink">
          {hhmm(slot.timeFrom)} – {hhmm(slot.timeTo)}
          {slot.generated && <span title="Автоматичен слот" className="text-[9px] font-extrabold text-ff-green-700">↻</span>}
          {hasNote && <span title={slot.driverNote || slot.customerNote || ''} className="h-[5px] w-[5px] rounded-full bg-ff-green-600" />}
        </div>
        <div className="mt-1 flex items-center justify-between">
          <div className="mr-[7px] h-[5px] flex-1 overflow-hidden rounded-full" style={{ background: 'rgba(0,0,0,0.07)' }}>
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: c.bar }} />
          </div>
          <span className="text-[11.5px] font-extrabold" style={{ color: c.ink }}>{slot.booked}/{slot.maxOrders}</span>
        </div>
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Wire add/edit in slots-client**

In `slots-client.tsx`:
- import `updateSlot` and the `SlotInput` type; keep `createSlot`, `deleteSlot`.
- add state `const [editSlot, setEditSlot] = useState<Slot | null>(null);`
- replace `onAdd` with a unified `onSubmit`:

```tsx
  async function onSubmit(data: SlotInput, editingId: string | null) {
    if (editingId) {
      const updated = await updateSlot(editingId, data);
      setSlots((prev) => prev.map((s) => (s.id === editingId ? updated : s)));
      toast.success('Слотът е обновен');
    } else {
      const created = await createSlot(data);
      setSlots((prev) => [...prev, created]);
      toast.success('Слотът е добавен');
    }
  }
```

- pass `onEdit={() => setEditSlot(s)}` to `<SlotPill>`.
- replace the dialog render:

```tsx
      <AddSlotDialog
        date={editSlot ? null : addDate}
        slot={editSlot}
        onClose={() => { setAddDate(null); setEditSlot(null); }}
        onSubmit={onSubmit}
      />
```

- [ ] **Step 4: Build**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow; npm --workspace @farmflow/client run build`
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/slots
git commit -m "feat(slots-admin): editable slots + customer/driver notes + pill markers"
```

### Task 11: Recurrence-rule card on the slots page

**Files:**
- Create: `client/src/components/slots/recurrence-card.tsx`
- Modify: `client/src/components/slots/slots-client.tsx`
- Modify: `client/src/app/(admin)/slots/page.tsx`

- [ ] **Step 1: Load the rule server-side**

In `slots/page.tsx`, fetch the rule alongside slots. Add to the `Promise.all` in `load`:

```ts
  const [sRes, tRes, rRes] = await Promise.all([
    fetch(`${API_BASE}/slots?from=${week[0]}&to=${week[6]}`, { headers, cache: 'no-store' }),
    fetch(`${API_BASE}/tenants/me`, { headers, cache: 'no-store' }),
    fetch(`${API_BASE}/slots/rule`, { headers, cache: 'no-store' }),
  ]);
  const rule = rRes.ok ? await rRes.json() : null;
  return { slots, delivery: !!tenant.deliveryEnabled, rule };
```

Update the return type to include `rule: SlotRule | null` (import `SlotRule` from `@/lib/types`) and pass `rule` into `<SlotsClient … initialRule={rule} />`.

- [ ] **Step 2: Build the card**

Create `client/src/components/slots/recurrence-card.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Repeat, Check } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ApiError, saveSlotRule } from '@/lib/api-client';
import type { SlotRule } from '@/lib/types';

const field = 'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2 text-[14px] font-bold text-ff-ink outline-none focus:border-ff-green-500';
const lbl = 'flex flex-col gap-1 text-[12.5px] font-bold text-ff-ink-2';
const WD = [{ i: 1, l: 'Пн' }, { i: 2, l: 'Вт' }, { i: 3, l: 'Ср' }, { i: 4, l: 'Чт' }, { i: 5, l: 'Пт' }, { i: 6, l: 'Сб' }, { i: 0, l: 'Нд' }];

function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const EMPTY: SlotRule = {
  active: false, repeat: 'weekdays', weekdays: [1, 3, 5], intervalDays: 3,
  anchorDate: todayIso(), timeFrom: '10:00', timeTo: '12:00', maxOrders: 5,
  horizonDays: 28, skipDates: [],
};

export function RecurrenceCard({ initial, onSaved }: { initial: SlotRule | null; onSaved: () => void }) {
  const [r, setR] = useState<SlotRule>(initial ?? EMPTY);
  const [saving, setSaving] = useState(false);
  const set = (p: Partial<SlotRule>) => setR((prev) => ({ ...prev, ...p }));
  const toggleWd = (i: number) => set({ weekdays: r.weekdays.includes(i) ? r.weekdays.filter((x) => x !== i) : [...r.weekdays, i] });

  async function save() {
    setSaving(true);
    try {
      await saveSlotRule(r);
      toast.success(r.active ? 'Правилото е запазено — слотовете се попълват' : 'Правилото е изключено');
      onSaved();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Грешка');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-4 rounded-[14px] border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-ff-green-50 text-ff-green-700"><Repeat size={18} /></span>
          <div>
            <div className="text-[15px] font-extrabold text-ff-ink">Повтарящи се слотове</div>
            <div className="text-[12.5px] text-ff-muted">Задай веднъж — слотовете се появяват напред автоматично.</div>
          </div>
        </div>
        <ToggleSwitch checked={r.active} onChange={(v) => set({ active: v })} />
      </div>

      <div className={cn('flex flex-col gap-3', !r.active && 'pointer-events-none opacity-50')}>
        <div className="flex gap-2">
          {(['weekdays', 'interval'] as const).map((m) => (
            <button key={m} type="button" onClick={() => set({ repeat: m })} className={cn('rounded-lg border px-3 py-1.5 text-[13px] font-bold', r.repeat === m ? 'border-ff-green-500 bg-ff-green-50 text-ff-green-700' : 'border-ff-border text-ff-ink-2')}>
              {m === 'weekdays' ? 'По дни от седмицата' : 'През N дни'}
            </button>
          ))}
        </div>

        {r.repeat === 'weekdays' ? (
          <div className="flex flex-wrap gap-1.5">
            {WD.map((d) => (
              <button key={d.i} type="button" onClick={() => toggleWd(d.i)} className={cn('h-9 w-9 rounded-lg border text-[12.5px] font-bold', r.weekdays.includes(d.i) ? 'border-ff-green-500 bg-ff-green-50 text-ff-green-700' : 'border-ff-border text-ff-ink-2')}>
                {d.l}
              </button>
            ))}
          </div>
        ) : (
          <label className={lbl}>През колко дни<input value={String(r.intervalDays)} onChange={(e) => set({ intervalDays: Math.max(1, parseInt(e.target.value, 10) || 1) })} inputMode="numeric" className={cn(field, 'w-24')} /></label>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className={lbl}>Начало<input type="time" value={r.timeFrom} onChange={(e) => set({ timeFrom: e.target.value })} className={field} /></label>
          <label className={lbl}>Край<input type="time" value={r.timeTo} onChange={(e) => set({ timeTo: e.target.value })} className={field} /></label>
          <label className={lbl}>Капацитет<input value={String(r.maxOrders)} onChange={(e) => set({ maxOrders: Math.max(1, parseInt(e.target.value, 10) || 1) })} inputMode="numeric" className={field} /></label>
          <label className={lbl}>Започва от<input type="date" value={r.anchorDate} onChange={(e) => set({ anchorDate: e.target.value })} className={field} /></label>
        </div>

        <label className={lbl}>Бележка за клиента <span className="font-normal text-ff-muted">(в магазина)</span>
          <input value={r.customerNote ?? ''} onChange={(e) => set({ customerNote: e.target.value })} maxLength={280} placeholder="напр. Ще се обадя преди доставка" className={field} />
        </label>
        <label className={lbl}>Бележка за доставчика <span className="font-normal text-ff-muted">(само за теб)</span>
          <input value={r.driverNote ?? ''} onChange={(e) => set({ driverNote: e.target.value })} maxLength={500} placeholder="напр. маршрут + телефон" className={field} />
        </label>
      </div>

      <div className="mt-4 flex justify-end">
        <Button variant="primary" size="sm" onClick={save} disabled={saving} className="rounded-sm">
          <Check size={16} /> {saving ? 'Записване…' : 'Запази правилото'}
        </Button>
      </div>
    </div>
  );
}
```

If `ToggleSwitch`/`Button` import paths differ, match the ones already used in `slots-client.tsx` / `delivery-client.tsx`.

- [ ] **Step 3: Mount the card + refresh after save**

In `slots-client.tsx`: accept `initialRule: SlotRule | null` in props; import `RecurrenceCard` and `useRouter` from `next/navigation`. Render the card just under the `InfoNote`:

```tsx
      <RecurrenceCard initial={initialRule} onSaved={() => router.refresh()} />
```

`router.refresh()` re-runs the server `load`, which now materializes (via `findAll`) and returns the freshly generated slots. Add `const router = useRouter();` at the top of the component.

- [ ] **Step 4: Build + verify**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow; npm --workspace @farmflow/client run build`
Expected: compiles. Then in the running admin: enable the rule (Mon/Wed/Fri, 10:00–12:00, note "Ще се обадя"), save → the week grid fills with `↻` slots carrying the note dot. Delete one → it stays gone after refresh (skipDate). Toggle the rule off + save → no new slots generated.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/slots/recurrence-card.tsx client/src/components/slots/slots-client.tsx "client/src/app/(admin)/slots/page.tsx"
git commit -m "feat(slots-admin): recurring-rule editor card"
```

---

## Phase 5 — chaika storefront

### Task 12: Show the customer note in the storefront slot picker

**Files:**
- Modify: `fermerski-pazar-chaika/src/lib/types.ts` (`Slot`)
- Modify: `fermerski-pazar-chaika/src/scripts/checkout-page.ts:189-212` (`renderSlots`)

- [ ] **Step 1: Add `customerNote` to the chaika `Slot` type**

In `fermerski-pazar-chaika/src/lib/types.ts`, add to the `Slot` interface (after `endTime`/`remaining`):

```ts
  customerNote?: string | null;
```

- [ ] **Step 2: Render the note**

In `checkout-page.ts`, the `renderSlots` builder currently emits a button per slot. Show the chosen slot's note in the `slotChosen` confirmation, and a small line under the picker. In the slot-click handler (where `selectedSlotLabel`/`slotChosen` is set), append the note:

```ts
        const chosen = document.getElementById('slotChosen')!;
        chosen.style.display = '';
        const note = b.dataset.note ? ` · <span class="muted">${esc(b.dataset.note)}</span>` : '';
        chosen.innerHTML = ICONS.check + ` Избра: ${esc(selectedSlotLabel)}${note}`;
```

And add `data-note` to the button template so it's available on click:

```ts
          `<button type="button" class="slot" data-id="${esc(s.id)}" data-note="${esc(s.customerNote ?? '')}" data-label="${esc(s.startTime)}–${esc(s.endTime)}">${esc(s.startTime)}–${esc(s.endTime)}</button>`,
```

(Read the exact current template string first and preserve its surrounding markup — only add the `data-note` attribute and the note span.)

- [ ] **Step 3: Build chaika**

Run: `cd C:\Users\Lenovo\source\repos\fermerski-pazar-chaika; npm run build`
Expected: Astro build succeeds.

- [ ] **Step 4: Commit (in the chaika repo)**

```bash
cd C:\Users\Lenovo\source\repos\fermerski-pazar-chaika
git add src/lib/types.ts src/scripts/checkout-page.ts
git commit -m "feat(checkout): show per-slot customer note in the slot picker"
```

---

## Phase 6 — Full verification

### Task 13: Run the suite + end-to-end manual check

- [ ] **Step 1: Server tests + build**

Run: `cd C:\Users\Lenovo\source\repos\FarmFlow; npm --workspace @farmflow/server run test; npm --workspace @farmflow/server run build`
Expected: all specs PASS (the prior 132 + the new slot specs); build OK.

- [ ] **Step 2: Client + db builds**

Run: `npm --workspace @farmflow/db run build; npm --workspace @farmflow/client run build`
Expected: both compile.

- [ ] **Step 3: Manual end-to-end (running stack + chaika)**

Verify, in order:
1. Fresh tenant Delivery page: Econt = Изключено; self-delivery + pickup enabled; no shipments/office/Econt rows.
2. Slots page: set a Mon/Wed/Fri rule with a customer note → grid fills with `↻` note-dot slots. Add a one-off slot with both notes. Edit a slot's time/notes. Delete a generated slot → stays gone after refresh.
3. chaika checkout with that tenant: Econt options absent; "Местна доставка до адрес" present; slot picker lists the generated slots; picking one shows the customer note in the confirmation; the private driver note never appears in the page source (view-source / network: `/public/<slug>/slots` payload has `customerNote`, no `driverNote`).
4. Switch Econt to Автоматично on Delivery → shipments/office/Econt rows reappear; chaika shows Econt options again.

- [ ] **Step 4: Finish the branch**

Use the superpowers:finishing-a-development-branch skill to decide merge/PR. Do not merge without the user's go-ahead.

---

## Self-review (author checklist — completed)

- **Spec coverage:** Econt default-off (Task 9) ✓; hide accounting when off (Task 9) ✓; customer note (Tasks 1–3, 12) ✓; driver note private (Tasks 1–3, never in `PUBLIC_SLOT_COLUMNS`/`findPublicBySlug`) ✓; recurring auto-fill rule (Tasks 4–7, 11) ✓; editable slots (Task 10) ✓; chaika wiring (Task 12) ✓; tests (Tasks 3, 4, 5, 13) ✓.
- **Placeholder scan:** the one deliberate `eq(eq, eq)` in Task 5 Step 2 is flagged and fixed in Step 3 (forces the implementer to read the where clause); no other placeholders.
- **Type consistency:** `SlotRule` fields identical across `slot-rule.ts`, client `types.ts`, `SaveSlotRuleDto`; `materializeRule`/`getRule`/`saveRule`/`slotRuleDates`/`normalizeRule` names consistent across tasks; `SlotInput`/`onSubmit(d, editingId)` consistent between dialog and `slots-client`.
- **Storage note:** rule at `settings.slotRule` (sibling) — documented in the header; Delivery-page blob save (`settings.delivery`) never touches it.
