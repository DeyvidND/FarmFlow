# Day-Based Slots + Multi-Courier Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace time-window delivery slots with per-day capacity ("Thursday = 40 deliveries") and split the delivery route between N couriers, all starting from the farm.

**Architecture:** `delivery_slots` is reused as "delivery days" (nullable `time_from`/`time_to`, one row per date, `capacity` = daily ceiling). The recurrence rule becomes `days: [{dow, capacity}]`. RoutingService gains a sweep-partition splitter (polar angle around the farm + workload balancing) producing N routes, each optimized by the existing Google-Routes pipeline. Storefront pickers become day pickers.

**Tech Stack:** NestJS + Drizzle (server), Next.js App Router (client panel + storefront), Astro (chaika, FarmFlow-Templates), PostgreSQL, Google Routes API.

**Spec:** `docs/superpowers/specs/2026-07-07-day-slots-multicourier-routes-design.md`

## Global Constraints

- Capacity clamp is **[1, 500]** everywhere (was [1, 20]).
- Couriers N clamp is **[1, 10]**; default from `settings.routing.courierCount`, fallback 1.
- All couriers start at the farm origin; end mode (`home`/`last`/`custom`) is shared.
- `orderMode` (`slots`|`distance`) is deleted — always shortest path.
- `PublicSlot` keeps its field names; `startTime`/`endTime` are `null` on day-rows.
- Same-day cutoff unchanged (today never bookable).
- Legacy rows keep their stored times; anything rendering slot times must handle NULL by showing the date only.
- Past dates (`date < CURRENT_DATE`) untouched by the migration.
- Monorepo commands run from repo root `C:\Users\Lenovo\source\repos\FarmFlow` unless stated. Server tests: `pnpm --filter @fermeribg/server test -- <pattern>` (verify the actual filter name in `server/package.json` first; if different use `pnpm -C server test -- <pattern>`).
- Commit messages: conventional commits, end body with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- UI copy is Bulgarian; keep the existing tone (говори се на „ти").

---

## Status (2026-07-08)

All 12 tasks shipped on `feat/day-slots-multicourier`. Every task went through implement → build/test → adversarial review → fix-if-needed. Task-level checkboxes above are left unticked (52 boxes across 12 tasks wasn't worth hand-marking); this ledger is the source of truth for what's done.

| Task | Repo | Commit(s) | Review outcome |
|---|---|---|---|
| 1. Migration 0081 | FarmFlow | `f6db90f` | — |
| 2. slot-rule per-day capacity | FarmFlow | `236fc39`, `d20af4b` | compile gap found pre-merge, fixed |
| 3. SlotsService/DTOs/public picker | FarmFlow | `96d2bb9`, `20ddd46` | dup-day generator bug found, fixed |
| 4. Sweep-partition splitter | FarmFlow | `b84d6c9` | clean |
| 5. Multi-courier RoutingService | FarmFlow | `befe025`, `6c6e215` | zero-order-day bug found, fixed |
| 6. Server null-safe slot rendering | FarmFlow | `868384b` | clean |
| 7. Client slots UI | FarmFlow | `a8a00a6`, `155a78c` | HIGH bug found (day-with-orders reopen crashed) — fixed; 2 cosmetic nits fixed |
| 8. Client multi-courier route UI | FarmFlow | `0550c3c` | clean (2 dead-code nits, not worth a fix commit) |
| 9. Storefront day picker | FarmFlow | `f33b0b2`, `9188aa1` | **security/data-leak bug found**: public ranged-slots endpoint let a caller-supplied `from` bypass the "never before today" floor — fixed server-side in `ddf9745` |
| 10. chaika day picker | fermerski-pazar-chaika | `b68864a`, `d8c91f3` (main, **not pushed**) | stale copy nit, fixed |
| 11. Templates day picker | FarmFlow-Templates | `8a48abf` (main, **not pushed**) | clean; confirmed a pre-existing (not new) gap — see follow-up below |
| 12. E2E verification + rollout | FarmFlow | this note | full server suite 146/146 · 1276/1276 green; `client`/`storefront` builds clean; chaika + Templates `check` clean. Live dev-stack E2E walkthrough was scoped out by the user for this pass — every task's server/build/lint/test gate passed individually instead. |

**Follow-up filed, out of scope for this branch:** local-delivery checkout in both chaika and FarmFlow-Templates lets a shopper submit without picking a delivery day even when the farm has slots configured (`selectedSlotId` is only conditionally attached, never required). Pre-existing before this rework, not a regression — flagged as a separate task.

**Deploy order** (per the original plan's Task 12 Step 3):
1. **FarmFlow server** first — migration 0081 + API. Old storefront bundles keep working during the gap (they render day-grouped slots with blank time labels).
2. **FarmFlow client + storefront** — same deploy as server (monorepo).
3. **chaika** — push `main` (2 commits ahead: `b68864a`, `d8c91f3`); deploys automatically via CF Workers Builds on push.
4. **FarmFlow-Templates** — push `main` (1 commit ahead: `8a48abf`); respects the factory's frozen-lockfile CI.

None of chaika/Templates have been pushed yet — that's a deliberate hold per the plan (Task 10 Step 4), pending explicit go-ahead.

---

### Task 1: Migration 0081 — nullable times + merge future slots into day-rows

**Files:**
- Create: `packages/db/drizzle/0081_day_slots.sql`
- Modify: `packages/db/drizzle/meta/_journal.json` (append entry, mirror how 0080 is registered)
- Modify: `packages/db/src/schema.ts:316-343` (deliverySlots table)

**Interfaces:**
- Produces: `deliverySlots.timeFrom`/`timeTo` typed nullable (`time('time_from')` without `.notNull()`). Later tasks rely on `Slot.timeFrom: string | null`.

- [ ] **Step 1: Write the migration SQL**

`packages/db/drizzle/0081_day_slots.sql`:

```sql
-- Day-based slots: a slot row is now a "delivery day" (date + capacity).
-- Times become nullable; NULL times = whole-day slot. Legacy rows keep times.
ALTER TABLE "delivery_slots" ALTER COLUMN "time_from" DROP NOT NULL;
ALTER TABLE "delivery_slots" ALTER COLUMN "time_to" DROP NOT NULL;

-- Merge every future (tenant, date) group of time slots into ONE day-row:
--  * canonical row = earliest time_from (NULLs first so an already-converted
--    day-row stays canonical; id tiebreak keeps it deterministic),
--  * orders repointed to the canonical row,
--  * canonical capacity = SUM of the group's capacities (day total preserved),
--  * times nulled, remaining rows deleted.
-- Past dates untouched (history keeps its hours).
CREATE TEMP TABLE _slot_canon AS
SELECT DISTINCT ON (tenant_id, date)
       id AS canon_id, tenant_id, date
FROM delivery_slots
WHERE date >= CURRENT_DATE
ORDER BY tenant_id, date, time_from ASC NULLS FIRST, id;

CREATE TEMP TABLE _slot_caps AS
SELECT tenant_id, date, SUM(capacity)::int AS total_cap
FROM delivery_slots
WHERE date >= CURRENT_DATE
GROUP BY tenant_id, date;

UPDATE orders o
SET slot_id = c.canon_id
FROM delivery_slots s
JOIN _slot_canon c
  ON c.tenant_id IS NOT DISTINCT FROM s.tenant_id AND c.date = s.date
WHERE o.slot_id = s.id
  AND s.id <> c.canon_id;

DELETE FROM delivery_slots s
USING _slot_canon c
WHERE c.tenant_id IS NOT DISTINCT FROM s.tenant_id
  AND c.date = s.date
  AND s.id <> c.canon_id;

UPDATE delivery_slots s
SET time_from = NULL,
    time_to   = NULL,
    is_active = true,
    capacity  = k.total_cap
FROM _slot_canon c
JOIN _slot_caps k
  ON k.tenant_id IS NOT DISTINCT FROM c.tenant_id AND k.date = c.date
WHERE s.id = c.canon_id;

DROP TABLE _slot_canon;
DROP TABLE _slot_caps;
```

- [ ] **Step 2: Register the migration in `_journal.json`**

Open `packages/db/drizzle/meta/_journal.json`, copy the 0080 entry shape, append one for `0081_day_slots` with the next `idx` and a fresh `when` timestamp.

- [ ] **Step 3: Update schema.ts**

In `deliverySlots` (schema.ts:322-323) replace:

```ts
    timeFrom: time('time_from').notNull(),
    timeTo: time('time_to').notNull(),
```

with:

```ts
    // NULL on day-based slots (one row per delivery day, no hours). Non-null
    // only on legacy pre-0081 rows, kept for history display.
    timeFrom: time('time_from'),
    timeTo: time('time_to'),
```

Also update the table's doc comment (schema.ts:334-336) to say capacity = daily order ceiling (see migration 0081), no longer "people working the slot".

- [ ] **Step 4: Typecheck + verify migration is idempotent-safe on a dev DB**

Run: `pnpm --filter @fermeribg/db build` (or `pnpm -C packages/db build`) → expect clean.
Then against the local dev DB (port 5433, see repo docker-compose): run the app's usual migration command (check `packages/db/package.json` scripts, e.g. `pnpm -C packages/db migrate`) → expect it to apply 0081 without error.
Sanity SQL: `SELECT count(*) FROM delivery_slots WHERE date >= CURRENT_DATE GROUP BY tenant_id, date HAVING count(*) > 1;` → expect zero rows.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): day-based delivery slots — nullable times + future-slot merge (migration 0081)"
```

---

### Task 2: slot-rule.ts rewrite — per-day capacity, no windows

**Files:**
- Modify: `server/src/modules/slots/slot-rule.ts` (full rewrite below)
- Modify: `server/src/modules/slots/slot-rule.spec.ts` (rewrite tests)

**Interfaces:**
- Produces (consumed by Task 3 and the client in Task 7):

```ts
export interface SlotDay { dow: number; capacity: number }
export interface SlotRule {
  active: boolean;
  repeat: 'weekdays' | 'interval';
  days: SlotDay[];              // weekdays mode
  intervalDays: number;
  intervalCapacity: number;     // interval mode
  anchorDate: string;
  customerNote?: string;
  driverNote?: string;
  horizonDays: number;
  skipDates: string[];
  lastMaterializedDate?: string;
}
export interface GenSlot { date: string; capacity: number }
export function clampCapacity(n: number | undefined): number      // [1,500]
export function slotIsFull(booked: number, capacity: number): boolean
export function migrateRule(raw: unknown): SlotRule | null         // upgrades BOTH old shapes
export function slotRuleSlots(rule: SlotRule, today: string): GenSlot[]  // one per date
export function normalizeRule(input: unknown, prev?: SlotRule | null): SlotRule
export function isoAddDays(iso: string, n: number): string         // keep as-is
```

- [ ] **Step 1: Write the failing tests**

Rewrite `slot-rule.spec.ts`. Keep any existing tests for `isoAddDays`. Core new tests (exact code — adapt describe/it style to the existing file):

```ts
import { migrateRule, normalizeRule, slotRuleSlots, clampCapacity, type SlotRule } from './slot-rule';

describe('clampCapacity', () => {
  it('clamps to [1,500]', () => {
    expect(clampCapacity(undefined)).toBe(1);
    expect(clampCapacity(0)).toBe(1);
    expect(clampCapacity(40)).toBe(40);
    expect(clampCapacity(9999)).toBe(500);
  });
});

describe('migrateRule', () => {
  it('passes a current day-capacity rule through unchanged', () => {
    const rule: SlotRule = {
      active: true, repeat: 'weekdays',
      days: [{ dow: 4, capacity: 40 }],
      intervalDays: 1, intervalCapacity: 10,
      anchorDate: '2026-07-01', horizonDays: 28, skipDates: [],
    };
    expect(migrateRule(rule)).toEqual(rule);
  });

  it('upgrades a windowed rule: day capacity = subslots × defaultCapacity', () => {
    // 10:00–18:00 at 60-min slots = 8 subslots; defaultCapacity 5 → 40.
    const old = {
      active: true, repeat: 'weekdays',
      days: [{ dow: 4, timeFrom: '10:00', timeTo: '18:00' }],
      intervalDays: 1, intervalWindow: { timeFrom: '10:00', timeTo: '12:00' },
      anchorDate: '2026-07-01', slotMinutes: 60, defaultCapacity: 5,
      horizonDays: 28, skipDates: [],
    };
    const m = migrateRule(old)!;
    expect(m.days).toEqual([{ dow: 4, capacity: 40 }]);
    // interval window 10–12 at 60 min = 2 subslots × 5 = 10.
    expect(m.intervalCapacity).toBe(10);
  });

  it('upgrades a windowed rule without slotMinutes: capacity = defaultCapacity', () => {
    const old = {
      active: true, repeat: 'weekdays',
      days: [{ dow: 1, timeFrom: '10:00', timeTo: '12:00' }],
      intervalDays: 3, intervalWindow: { timeFrom: '10:00', timeTo: '12:00' },
      anchorDate: '2026-07-01', defaultCapacity: 3, horizonDays: 28, skipDates: [],
    };
    expect(migrateRule(old)!.days).toEqual([{ dow: 1, capacity: 3 }]);
  });

  it('upgrades the legacy global-window shape (weekdays array)', () => {
    const legacy = { active: true, repeat: 'weekdays', weekdays: [1, 4], timeFrom: '10:00', timeTo: '12:00', anchorDate: '2026-07-01', horizonDays: 28, skipDates: [] };
    expect(migrateRule(legacy)!.days).toEqual([
      { dow: 1, capacity: 1 },
      { dow: 4, capacity: 1 },
    ]);
  });

  it('returns null for null/undefined', () => {
    expect(migrateRule(null)).toBeNull();
    expect(migrateRule(undefined)).toBeNull();
  });
});

describe('slotRuleSlots', () => {
  const base: SlotRule = {
    active: true, repeat: 'weekdays',
    days: [{ dow: 4, capacity: 40 }], // Thursday
    intervalDays: 1, intervalCapacity: 10,
    anchorDate: '2026-07-01', horizonDays: 14, skipDates: [],
  };
  it('emits ONE GenSlot per matching date with the day capacity', () => {
    // 2026-07-07 is a Tuesday; Thursdays in [07-07, 07-21]: 07-09, 07-16.
    expect(slotRuleSlots(base, '2026-07-07')).toEqual([
      { date: '2026-07-09', capacity: 40 },
      { date: '2026-07-16', capacity: 40 },
    ]);
  });
  it('respects skipDates', () => {
    expect(slotRuleSlots({ ...base, skipDates: ['2026-07-09'] }, '2026-07-07'))
      .toEqual([{ date: '2026-07-16', capacity: 40 }]);
  });
  it('interval mode uses intervalCapacity', () => {
    const r: SlotRule = { ...base, repeat: 'interval', intervalDays: 7, anchorDate: '2026-07-09' };
    expect(slotRuleSlots(r, '2026-07-07')).toEqual([
      { date: '2026-07-09', capacity: 10 },
      { date: '2026-07-16', capacity: 10 },
    ]);
  });
  it('inactive rule → []', () => {
    expect(slotRuleSlots({ ...base, active: false }, '2026-07-07')).toEqual([]);
  });
});

describe('normalizeRule', () => {
  it('requires ≥1 day in weekdays mode', () => {
    expect(() => normalizeRule({ active: true, repeat: 'weekdays', days: [], anchorDate: '2026-07-01' }))
      .toThrow('Избери поне един ден от седмицата');
  });
  it('clamps day capacities and preserves prev skipDates', () => {
    const prev = { skipDates: ['2026-07-09'] } as unknown as SlotRule;
    const r = normalizeRule(
      { active: true, repeat: 'weekdays', days: [{ dow: 4, capacity: 9999 }], anchorDate: '2026-07-01' },
      prev,
    );
    expect(r.days).toEqual([{ dow: 4, capacity: 500 }]);
    expect(r.skipDates).toEqual(['2026-07-09']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @fermeribg/server test -- slot-rule`
Expected: FAIL (old shape doesn't compile / assertions fail).

- [ ] **Step 3: Rewrite slot-rule.ts**

Full new content (keep the file's header-comment style; carry over `isoAddDays`, `isoMax`):

```ts
/**
 * The single recurring self-delivery rule, stored at settings.slotRule. Pure
 * date math + validation — no db. The generator (slots.service) turns the
 * GenSlots this produces into concrete `generated` day-rows: ONE slot row per
 * delivery date, whose `capacity` is the day's order ceiling. Time windows are
 * gone — the farmer plans the day as a whole and the route optimizer picks the
 * driving order.
 */
/** A day stops being pickable (storefront) and bookable (order creation) as
 *  soon as it starts — the last chance to book Thursday is Wednesday. The farm
 *  needs a full day's lead time to plan the route/prep. */

export interface SlotDay {
  dow: number; // 0=Sun..6=Sat
  capacity: number; // max orders that day
}

export interface SlotRule {
  active: boolean;
  repeat: 'weekdays' | 'interval';
  days: SlotDay[]; // weekdays mode — per-day capacity
  intervalDays: number; // >=1, for repeat:'interval'
  intervalCapacity: number; // interval mode — one capacity
  anchorDate: string; // YYYY-MM-DD; interval counts from here; also a lower bound
  customerNote?: string;
  driverNote?: string;
  horizonDays: number; // how far ahead to keep filled
  skipDates: string[]; // dates the farmer closed — never regenerate
  lastMaterializedDate?: string;
}

/** One concrete delivery day the rule wants to exist. */
export interface GenSlot {
  date: string; // YYYY-MM-DD
  capacity: number;
}

/** Add `n` days to an ISO date (UTC-stable, no TZ drift). */
export function isoAddDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isoMax = (a: string, b: string) => (a >= b ? a : b);

const hhmmToMin = (t: string) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);

/** Clamp an incoming capacity to an integer in [1,500]; undefined/0/negative → 1. */
export function clampCapacity(n: number | undefined): number {
  const v = Math.floor(n ?? 1);
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(500, v);
}

/** A day is full when its live booked count reaches its (clamped) capacity. */
export function slotIsFull(booked: number, capacity: number): boolean {
  return booked >= clampCapacity(capacity);
}

/** Windowed-era day shape (pre day-capacity): hours per weekday. */
interface WindowedDay {
  dow: number;
  timeFrom?: string;
  timeTo?: string;
}
/** Every historical rule shape this code has ever stored. */
interface AnyStoredRule extends Partial<Omit<SlotRule, 'days'>> {
  days?: (SlotDay | WindowedDay)[];
  // windowed era:
  intervalWindow?: { timeFrom?: string; timeTo?: string };
  slotMinutes?: number;
  defaultCapacity?: number;
  // legacy (global window) era:
  weekdays?: number[];
  timeFrom?: string;
  timeTo?: string;
  maxOrders?: number;
}

/** How many whole `slotMinutes` chunks fit a window; 1 when unset/too short. */
function windowSubslots(win: { timeFrom?: string; timeTo?: string }, slotMinutes: number): number {
  if (!slotMinutes || slotMinutes <= 0) return 1;
  if (!win.timeFrom || !win.timeTo) return 1;
  const span = hhmmToMin(win.timeTo) - hhmmToMin(win.timeFrom);
  return span >= slotMinutes ? Math.floor(span / slotMinutes) : 1;
}

/**
 * Upgrade any stored rule to the day-capacity shape. Windowed rules convert
 * honestly: a day that produced K sub-slots of capacity C becomes capacity K×C.
 * Idempotent — a current rule passes through unchanged. Null in → null out.
 */
export function migrateRule(raw: unknown): SlotRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as AnyStoredRule;

  const isCurrent =
    Array.isArray(r.days) &&
    r.days.every((d) => typeof (d as SlotDay).capacity === 'number') &&
    typeof r.intervalCapacity === 'number' &&
    r.intervalWindow === undefined &&
    r.slotMinutes === undefined;
  if (isCurrent) return r as SlotRule;

  const slotMinutes = Math.max(0, Math.floor(r.slotMinutes ?? 0));
  const perSlotCap = clampCapacity(r.defaultCapacity);

  // Windowed days (or legacy weekdays[] + global window) → per-day capacity.
  const sourceDays: WindowedDay[] = Array.isArray(r.days)
    ? (r.days as WindowedDay[])
    : (r.weekdays ?? []).map((dow) => ({ dow, timeFrom: r.timeFrom, timeTo: r.timeTo }));
  const days: SlotDay[] = sourceDays.map((d) => ({
    dow: d.dow,
    capacity:
      typeof (d as SlotDay).capacity === 'number'
        ? clampCapacity((d as SlotDay).capacity)
        : clampCapacity(windowSubslots(d, slotMinutes) * perSlotCap),
  }));

  const intervalCapacity =
    typeof r.intervalCapacity === 'number'
      ? clampCapacity(r.intervalCapacity)
      : clampCapacity(windowSubslots(r.intervalWindow ?? {}, slotMinutes) * perSlotCap);

  return {
    active: r.active !== false,
    repeat: r.repeat === 'interval' ? 'interval' : 'weekdays',
    days,
    intervalDays: Math.max(1, Math.floor(r.intervalDays ?? 1)),
    intervalCapacity,
    anchorDate: r.anchorDate ?? '',
    customerNote: r.customerNote,
    driverNote: r.driverNote,
    horizonDays: r.horizonDays ?? 28,
    skipDates: r.skipDates ?? [],
    lastMaterializedDate: r.lastMaterializedDate,
  };
}

/**
 * The delivery days the rule should produce within
 * [max(today, anchor) … today+horizon], minus skipDates. One GenSlot per date.
 * Returns [] for an inactive rule.
 */
export function slotRuleSlots(rule: SlotRule, today: string): GenSlot[] {
  if (!rule.active) return [];
  const start = isoMax(today, rule.anchorDate);
  const end = isoAddDays(today, Math.max(0, rule.horizonDays));
  if (start > end) return [];
  const skip = new Set(rule.skipDates ?? []);
  const out: GenSlot[] = [];

  if (rule.repeat === 'weekdays') {
    const byDow = new Map<number, number>();
    for (const d of rule.days ?? []) byDow.set(d.dow, clampCapacity(d.capacity));
    if (byDow.size === 0) return [];
    for (let iso = start; iso <= end; iso = isoAddDays(iso, 1)) {
      const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
      const cap = byDow.get(dow);
      if (cap !== undefined && !skip.has(iso)) out.push({ date: iso, capacity: cap });
    }
  } else {
    const cap = clampCapacity(rule.intervalCapacity);
    const n = Math.max(1, Math.floor(rule.intervalDays || 1));
    let iso = rule.anchorDate;
    let guard = 0;
    while (iso < start && guard++ < 4000) iso = isoAddDays(iso, n);
    for (; iso <= end; iso = isoAddDays(iso, n)) {
      if (!skip.has(iso)) out.push({ date: iso, capacity: cap });
    }
  }
  return out;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate + clamp an incoming rule, preserving server-owned fields (skipDates)
 * from the previous stored rule. Accepts older shapes too (auto-migrated).
 * Throws Error('<bg message>') on invalid input; the service maps it to
 * BadRequestException.
 */
export function normalizeRule(input: unknown, prev?: SlotRule | null): SlotRule {
  const migrated = migrateRule(input);
  if (!migrated) throw new Error('Невалидно правило');
  const repeat = migrated.repeat === 'interval' ? 'interval' : 'weekdays';
  const anchorDate = migrated.anchorDate ?? '';
  if (!ISO.test(anchorDate)) throw new Error('Невалидна начална дата');

  // Dedupe by dow (last wins), clamp capacities, week-sort.
  const byDow = new Map<number, SlotDay>();
  for (const d of migrated.days ?? []) {
    if (!Number.isInteger(d?.dow) || d.dow < 0 || d.dow > 6) continue;
    byDow.set(d.dow, { dow: d.dow, capacity: clampCapacity(d.capacity) });
  }
  const days = [...byDow.values()].sort((a, b) => a.dow - b.dow);
  if (repeat === 'weekdays' && days.length === 0) {
    throw new Error('Избери поне един ден от седмицата');
  }

  return {
    active: migrated.active !== false,
    repeat,
    days,
    intervalDays: Math.max(1, Math.floor(migrated.intervalDays ?? 1)),
    intervalCapacity: clampCapacity(migrated.intervalCapacity),
    anchorDate,
    customerNote: migrated.customerNote?.slice(0, 280) || undefined,
    driverNote: migrated.driverNote?.slice(0, 500) || undefined,
    horizonDays: Math.min(60, Math.max(1, Math.floor(migrated.horizonDays ?? 28))),
    skipDates: prev?.skipDates ?? [],
    lastMaterializedDate: undefined,
  };
}
```

Note: `splitWindow`, `SlotWindow`, `normalizeWindow`, `safeWindow`, `BG_WD` are deleted. Grep the server for imports of the deleted exports (`splitWindow`, `SlotWindow`) and remove/adjust those imports (Task 3 covers slots.service/processor; anything else found, fix here).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @fermeribg/server test -- slot-rule`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/slots/slot-rule.ts server/src/modules/slots/slot-rule.spec.ts
git commit -m "feat(slots): day-capacity slot rule — windows and slotMinutes removed, honest shape migration"
```

---

### Task 3: SlotsService + DTOs + controller — day rows end to end

**Files:**
- Modify: `server/src/modules/slots/slots.service.ts`
- Modify: `server/src/modules/slots/dto/create-slot.dto.ts`
- Modify: `server/src/modules/slots/dto/slot-rule.dto.ts` (mirror the new SlotRule shape; read the file first)
- Modify: `server/src/modules/slots/slots.service.spec.ts`, `server/src/modules/slots/slots.processor.spec.ts` (adapt fixtures)
- Modify: `server/src/modules/orders/orders.service.ts:1362-1392` (`lockAndCheckSlot`) + its spec fixtures
- Modify: `server/src/modules/orders/delivery-pricing.ts:220-254` (`buildPublicOwnSlots` + its local `OwnSlotsRule` type) + its spec: the public schedule text loses hours — weekdays mode → `всеки Пн, Ср и Чт` (weekday grouping collapses to one list, no time suffix); interval mode → `на всеки N дни`. `OwnSlotsRule.days` becomes `{dow: number}[]`; old stored rules still parse (dow present in every historical shape). `PublicOwnSlots` shape unchanged.

**Interfaces:**
- Consumes: `migrateRule`, `normalizeRule`, `slotRuleSlots`, `clampCapacity`, `GenSlot {date, capacity}` from Task 2.
- Produces: `PublicSlot` with `startTime: string | null; endTime: string | null`. `CreateSlotDto {date, dateTo?, weekdays?, capacity?, customerNote?, driverNote?}` (times gone). Everything else keeps its route paths.

- [ ] **Step 1: Update failing specs first**

In `slots.service.spec.ts` / `slots.processor.spec.ts`: change fixtures that insert/expect `timeFrom`/`timeTo` on created slots to day-rows (`date` + `capacity`, no times), and rule fixtures to the new shape (`days: [{dow, capacity}]`, `intervalCapacity`). Add one new test: `create` with `{date, capacity: 40}` returns a row with `timeFrom === null`. Add one for `findPublicBySlug` returning `startTime: null, endTime: null, remaining` for a day-row (mirror existing public-slot test setup).

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @fermeribg/server test -- slots`
Expected: FAIL (compile errors on removed DTO fields / shape).

- [ ] **Step 3: Implement**

`create-slot.dto.ts`: delete `timeFrom`/`timeTo` properties entirely; change capacity bounds to `@Min(1) @Max(500)` and description „Колко поръчки приема денят (1–500)". Keep `date`, `dateTo`, `weekdays`, notes.

`slots.service.ts` changes:

1. `create()` base object: drop `timeFrom/timeTo`; insert `{ tenantId, date, capacity: clampCapacity(dto.capacity), customerNote, driverNote }`. Bulk branch unchanged apart from that. **New guard:** one day-row per date — before insert, reject with `BadRequestException('Този ден вече е отворен — редактирай капацитета му')` when a row for `(tenantId, date)` already exists (single-date branch; for the bulk branch, silently skip existing dates).
2. `update()` allow-list becomes `['capacity', 'customerNote', 'driverNote']` (clamp capacity via `clampCapacity`).
3. `findAll()` `orderBy` drops `timeFrom` → `orderBy(deliverySlots.date)`.
4. `findPublicBySlug()`: `startTime`/`endTime` selects become `sql<string | null>` (substring of a NULL time is NULL — no code change beyond the type); `orderBy(deliverySlots.date)`; `PublicSlot` interface fields become `string | null`. Update the interface doc comment. `remaining` logic unchanged.
5. `materializeRule()`: `wanted` is now `GenSlot[] {date, capacity}`; the existing-rows diff keys on **date only**:

```ts
    const have = new Set(existing.map((r) => r.date));
    const missing = wanted.filter((w) => !have.has(w.date));
    if (missing.length) {
      await this.db.insert(deliverySlots).values(
        missing.map((w) => ({
          tenantId,
          date: w.date,
          generated: true,
          capacity: w.capacity,
          customerNote: rule.customerNote ?? null,
          driverNote: rule.driverNote ?? null,
        })),
      );
    }
```

   (existing select drops `timeFrom/timeTo`). Also: `saveRule`'s `deleteFutureUnbookedGenerated` stays as-is, BUT a rule edit that only changes capacity must propagate to future generated unbooked rows — the delete+rebuild already handles that. A future generated row **with** a live order is kept (its capacity stays; farmer edits it manually if needed) — add a code comment saying so.
6. `expandDates` helper unchanged.
7. Delete the import of removed symbols (`SlotRule` import stays; `slotRuleSlots` signature same name).

`dto/slot-rule.dto.ts`: mirror the new rule shape (days: array of `{dow: int 0..6, capacity: int 1..500}`, `intervalCapacity: int 1..500`, drop window/slotMinutes/defaultCapacity validators). Keep it strict (whitelist) like the current file.

`orders.service.ts` `lockAndCheckSlot`: return type becomes `{ date: string; capacity: number }` — drop `timeFrom/timeTo` from the return object (grep its callers and adjust; the same-day backstop + capacity check stay byte-identical). If callers use the returned times for email copy, they now pass the date only (order-email rendering is Task 9's concern — here just make it compile with date-only).

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @fermeribg/server test -- "slots|orders"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/slots server/src/modules/orders
git commit -m "feat(slots): day-row slots service — create/update/materialize/public picker without time windows"
```

---

### Task 4: Route splitting algorithm (pure) — sweep + workload balance

**Files:**
- Create: `server/src/modules/routing/route-split.ts`
- Create: `server/src/modules/routing/route-split.spec.ts`

**Interfaces:**
- Consumes: `RouteStop` (import type from `./routing.service`), `ptOf` re-implemented locally to avoid a cycle: accept generic `{lat, lng}`.
- Produces (consumed by Task 5):

```ts
export type Pt = { lat: number; lng: number };
export function haversineKm(a: Pt, b: Pt): number;      // MOVED here from routing.service
export function estimateWorkloadS(depot: Pt, stops: Pt[]): number;
export function sweepSplit<T extends { lat: number | null; lng: number | null }>(
  depot: Pt,
  stops: T[],          // caller passes ONLY geocoded stops
  couriers: number,
): T[][];              // length ≤ couriers, order of groups = angular order
```

- [ ] **Step 1: Write the failing tests**

`route-split.spec.ts` (exact code):

```ts
import { estimateWorkloadS, sweepSplit, type Pt } from './route-split';

const depot: Pt = { lat: 43.2, lng: 27.9 }; // Varna-ish

/** n stops on a circle around the depot, radius ~1km, evenly spaced angles. */
function ring(n: number, phase = 0): { id: number; lat: number; lng: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const a = phase + (2 * Math.PI * i) / n;
    return { id: i, lat: depot.lat + 0.009 * Math.sin(a), lng: depot.lng + 0.013 * Math.cos(a) };
  });
}

describe('estimateWorkloadS', () => {
  it('is zero for no stops and grows with stop count', () => {
    expect(estimateWorkloadS(depot, [])).toBe(0);
    const one = estimateWorkloadS(depot, ring(1));
    const four = estimateWorkloadS(depot, ring(4));
    expect(one).toBeGreaterThan(0);
    expect(four).toBeGreaterThan(one);
  });
});

describe('sweepSplit', () => {
  it('N=1 returns all stops in one group', () => {
    const stops = ring(7);
    const g = sweepSplit(depot, stops, 1);
    expect(g).toHaveLength(1);
    expect(g[0]).toHaveLength(7);
  });

  it('splits 12 ring stops into 3 balanced contiguous sectors', () => {
    const stops = ring(12);
    const g = sweepSplit(depot, stops, 3);
    expect(g).toHaveLength(3);
    expect(g.flat()).toHaveLength(12);
    // Perfect symmetry → perfect balance (4/4/4).
    expect(g.map((x) => x.length).sort()).toEqual([4, 4, 4]);
    // No stop appears twice.
    expect(new Set(g.flat().map((s) => s.id)).size).toBe(12);
  });

  it('more couriers than stops → one stop per group, no empty groups', () => {
    const g = sweepSplit(depot, ring(2), 5);
    expect(g).toHaveLength(2);
    expect(g.every((x) => x.length === 1)).toBe(true);
  });

  it('is deterministic', () => {
    const stops = ring(9, 0.3);
    expect(sweepSplit(depot, stops, 3)).toEqual(sweepSplit(depot, stops, 3));
  });

  it('a dense cluster + a far stop does not starve the far courier', () => {
    // 6 stops clustered east, 1 stop far west: with 2 couriers the far stop
    // should sit alone (its drive time ≈ a courier's whole workload).
    const cluster = Array.from({ length: 6 }, (_, i) => ({
      id: i, lat: depot.lat + 0.001 * i, lng: depot.lng + 0.02,
    }));
    const far = { id: 99, lat: depot.lat, lng: depot.lng - 0.3 };
    const g = sweepSplit(depot, [...cluster, far], 2);
    const wFar = g.find((x) => x.some((s) => s.id === 99))!;
    expect(wFar.length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @fermeribg/server test -- route-split`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement route-split.ts**

```ts
/**
 * Multi-courier stop partitioning. Pure math, no I/O — the caller feeds
 * geocoded stops and gets courier groups back, then optimizes each group's
 * visit order separately (Google / greedy — routing.service).
 *
 * Method: "sweep" — stops sorted by polar angle around the depot form a
 * circle; couriers get contiguous arcs. Arcs are cut to balance estimated
 * workload (drive time at urban speed + fixed service time per stop), then a
 * bounded local-improvement pass shifts border stops between neighbouring
 * arcs while the worst courier's workload keeps dropping. Deterministic.
 */

export type Pt = { lat: number; lng: number };

/** Straight-line distance (km). */
export function haversineKm(a: Pt, b: Pt): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const URBAN_KMH = 30; // pessimistic city driving speed for the estimate
const SERVICE_S = 300; // handover time per stop (park, ring, deliver)

const kmToS = (km: number) => (km / URBAN_KMH) * 3600;

type Geo = { lat: number | null; lng: number | null };
const pt = (s: Geo): Pt => ({ lat: s.lat as number, lng: s.lng as number });

/**
 * Estimated seconds to serve `stops` from `depot`: greedy nearest-neighbour
 * tour (depot → stops, one-way) + fixed service time per stop. Not a real
 * route — just a comparable workload number for balancing.
 */
export function estimateWorkloadS(depot: Pt, stops: Pt[]): number {
  if (!stops.length) return 0;
  const remaining = [...stops];
  let cursor = depot;
  let km = 0;
  while (remaining.length) {
    let best = 0;
    let bestD = Infinity;
    remaining.forEach((p, i) => {
      const d = haversineKm(cursor, p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    km += bestD;
    cursor = remaining.splice(best, 1)[0];
  }
  return kmToS(km) + stops.length * SERVICE_S;
}

/** Max estimated workload across groups — the number balancing minimizes. */
function maxWorkload(depot: Pt, groups: Geo[][]): number {
  return Math.max(0, ...groups.map((g) => estimateWorkloadS(depot, g.map(pt))));
}

/**
 * Cut an angle-sorted circle of stops into `couriers` contiguous arcs,
 * balancing estimated workload. Tries every rotation of the cut start (up to
 * 24 evenly-spaced candidates) and keeps the best; then shifts border stops
 * between neighbouring arcs while the max workload drops (≤2 passes).
 */
export function sweepSplit<T extends Geo>(depot: Pt, stops: T[], couriers: number): T[][] {
  const n = Math.max(1, Math.floor(couriers));
  if (stops.length === 0) return [];
  if (n === 1 || stops.length <= n) {
    return n === 1 ? [stops.slice()] : stops.map((s) => [s]);
  }

  const sorted = [...stops].sort((a, b) => {
    const aa = Math.atan2((a.lat as number) - depot.lat, (a.lng as number) - depot.lng);
    const ab = Math.atan2((b.lat as number) - depot.lat, (b.lng as number) - depot.lng);
    return aa - ab || (a.lat as number) - (b.lat as number) || (a.lng as number) - (b.lng as number);
  });

  // Greedy arc fill for one rotation: walk the circle, close an arc once its
  // workload reaches the remaining average.
  const fill = (offset: number): T[][] => {
    const seq = [...sorted.slice(offset), ...sorted.slice(0, offset)];
    const total = estimateWorkloadS(depot, seq.map(pt));
    const groups: T[][] = [];
    let current: T[] = [];
    let used = 0;
    for (const s of seq) {
      const left = n - groups.length - 1; // arcs still to open after the current one
      current.push(s);
      const w = estimateWorkloadS(depot, current.map(pt));
      const target = (total - used) / (left + 1);
      // Close the arc when it met its share, but never leave more arcs than stops.
      const remainingStops = seq.length - seq.indexOf(s) - 1;
      if (left > 0 && w >= target && remainingStops >= left) {
        groups.push(current);
        used += w;
        current = [];
      }
    }
    if (current.length) groups.push(current);
    return groups;
  };

  const rotations = Math.min(sorted.length, 24);
  let best: T[][] | null = null;
  let bestScore = Infinity;
  for (let r = 0; r < rotations; r++) {
    const offset = Math.floor((r * sorted.length) / rotations);
    const g = fill(offset);
    const score = maxWorkload(depot, g);
    if (score < bestScore) {
      bestScore = score;
      best = g;
    }
  }
  let groups = best!;

  // Border improvement: move an edge stop to the neighbouring arc when that
  // lowers the max workload. Two passes keep it bounded and deterministic.
  for (let pass = 0; pass < 2; pass++) {
    let improved = false;
    for (let i = 0; i < groups.length - 1; i++) {
      const a = groups[i];
      const b = groups[i + 1];
      // last of a → front of b
      if (a.length > 1) {
        const cand = [...groups];
        cand[i] = a.slice(0, -1);
        cand[i + 1] = [a[a.length - 1], ...b];
        if (maxWorkload(depot, cand) < maxWorkload(depot, groups)) {
          groups = cand;
          improved = true;
          continue;
        }
      }
      // front of b → end of a
      if (b.length > 1) {
        const cand = [...groups];
        cand[i] = [...a, b[0]];
        cand[i + 1] = b.slice(1);
        if (maxWorkload(depot, cand) < maxWorkload(depot, groups)) {
          groups = cand;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return groups;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @fermeribg/server test -- route-split`
Expected: PASS. If the "dense cluster" test is flaky against the implementation, fix the implementation (not the test) — the far stop must not drag 3+ cluster stops with it.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/routing/route-split.ts server/src/modules/routing/route-split.spec.ts
git commit -m "feat(routing): sweep-partition stop splitter with workload balancing for multi-courier routes"
```

---

### Task 5: RoutingService multi-courier + controller + courierCount setting

**Files:**
- Modify: `server/src/modules/routing/routing.service.ts` (major rework of `getRoute`)
- Modify: `server/src/modules/routing/routing.controller.ts`
- Modify: `server/src/modules/routing/routing.helpers.spec.ts`, `routing.adversarial.spec.ts` (adapt), `server/src/modules/tenants/tenants.service.ts:583+` (only if `resolveRouting` filters keys — verify `courierCount` survives the merge; it spreads `...routing`, so likely no change; confirm the PATCH DTO doesn't whitelist routing keys)

**Interfaces:**
- Consumes: `sweepSplit`, `estimateWorkloadS`, `haversineKm`, `Pt` from `./route-split` (delete the local `haversineKm` in routing.service and import instead).
- Produces (client Task 7-8 relies on these exact shapes):

```ts
export interface RouteStop {   // slotFrom/slotTo DELETED
  id: string; customer: string | null; phone: string | null; email: string | null;
  address: string | null; note: string | null; lat: number | null; lng: number | null;
  summary: string;
}
export interface CourierRoute {
  stops: RouteStop[];
  totalDistanceM: number | null;
  totalDurationS: number | null;
  optimized: boolean;
  polyline: string[] | null;
}
export interface MultiRouteResult {
  date: string;
  origin: RouteOrigin;
  end: RouteEnd;
  couriers: number;          // effective count = routes.length
  routes: CourierRoute[];
}
```

`GET /orders/route?date=&end=&couriers=N` → `MultiRouteResult`. `order=` query param and `RouteOrderMode` deleted.

- [ ] **Step 1: Adapt specs to fail first**

`routing.helpers.spec.ts`: `mergeBySlot` and `slotMinutes` are deleted → remove those tests; keep/adapt `greedyByDistance` + `endPoint` tests (both survive). Add a service-level test to `routing.adversarial.spec.ts` (mirror its existing mocking style): with 4 geocoded confirmed orders and `couriers=2`, `getRoute` returns 2 routes covering all 4 stop ids exactly once; with `couriers=1` returns 1 route (old behaviour); un-geocoded stop lands at the END of the smallest route's stop list.

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @fermeribg/server test -- routing`
Expected: FAIL.

- [ ] **Step 3: Rework routing.service.ts**

Deletions: `RouteOrderMode`, `slotMinutes()`, `mergeBySlot()`, local `haversineKm` (import from `./route-split`), `slotFrom/slotTo` from `RouteStop` + the DB select + the slots leftJoin **stays** (needed by `scheduledForDay`) but selects only `deliverySlots.date` implicitly via the join condition — i.e. keep the join, drop the two selected columns.

`getRoute` new signature and flow:

```ts
async getRoute(
  tenantId: string,
  date?: string,
  endMode?: RouteEndMode,
  couriers?: number,
): Promise<MultiRouteResult> {
```

1. Tenant + rows + items + `stops` build: unchanged apart from dropped slot fields.
2. `origin`, `end` resolution: unchanged.
3. Effective courier count:

```ts
    const cfgCount = Number((routingCfg.courierCount as number | string | undefined) ?? 1);
    const n = Math.min(10, Math.max(1, Math.floor(couriers ?? (Number.isFinite(cfgCount) ? cfgCount : 1))));
```

4. Split + per-group optimize:

```ts
    const located = stops.filter((s) => s.lat != null && s.lng != null);
    const unlocated = stops.filter((s) => s.lat == null || s.lng == null);

    // Partition among couriers (sweep needs a depot; without one, round-robin
    // over a greedy chain so groups still make geographic sense).
    let groups: RouteStop[][];
    if (originPt && located.length) {
      groups = sweepSplit(originPt, located, n);
    } else if (located.length) {
      const chain = greedyByDistance(null, located);
      groups = Array.from({ length: Math.min(n, chain.length) }, () => []);
      chain.forEach((s, i) => groups[i % groups.length].push(s));
    } else {
      groups = [];
    }
    if (!groups.length && unlocated.length) groups = [[]];

    const routes: CourierRoute[] = [];
    for (const group of groups) {
      routes.push(await this.optimizeGroup(originPt, group, mode, end));
    }

    // Un-geocoded stops: tail of the least-loaded route (they can't be placed).
    if (unlocated.length) {
      let idx = 0;
      let best = Infinity;
      routes.forEach((r, i) => {
        const w = r.totalDurationS ?? r.stops.length * 600;
        if (w < best) { best = w; idx = i; }
      });
      routes[idx] = { ...routes[idx], stops: [...routes[idx].stops, ...unlocated] };
    }

    return { date: day, origin, end, couriers: routes.length, routes };
```

5. Extract the existing single-route distance-mode pipeline into a private method — this is a **move**, not new logic (Google optimize ≤25 + greedy tail, fallback greedy, then `pathTotal` over the ordered points + end leg):

```ts
  /** Optimize ONE courier's stop group: Google visit order (≤25) + greedy tail,
   *  then measured road totals + polyline via pathTotal. Extracted verbatim from
   *  the old single-route distance mode. */
  private async optimizeGroup(
    originPt: Pt | null,
    group: RouteStop[],
    mode: RouteEndMode,
    end: RouteEnd,
  ): Promise<CourierRoute> {
    // ... (the body of the old `orderMode === 'distance'` branch + totals block,
    //      operating on `group` instead of `located`, returning CourierRoute)
  }
```

Keep `MAX_OPTIMIZE_STOPS`, `pathTotal`, `endPoint`, `greedyByDistance`, `ptOf` as they are. The old slots-ordering branch and `mergeBySlot` weaving are deleted.

`routing.controller.ts`: drop the `order` query param + `RouteOrderMode` import; add `couriers`:

```ts
  @Get('route')
  @UseGuards(ActiveSubscriptionGuard)
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({ name: 'end', required: false, enum: ['home', 'last', 'custom'] })
  @ApiQuery({ name: 'couriers', required: false, description: '1–10; default from settings.routing.courierCount' })
  getRoute(
    @CurrentTenant() tenantId: string,
    @Query('date') date?: string,
    @Query('end') end?: string,
    @Query('couriers') couriers?: string,
  ) {
    const endMode: RouteEndMode | undefined =
      end === 'home' || end === 'last' || end === 'custom' ? end : undefined;
    const parsed = couriers ? parseInt(couriers, 10) : undefined;
    return this.routingService.getRoute(
      tenantId, date, endMode,
      Number.isFinite(parsed) ? parsed : undefined,
    );
  }
```

`tenants.service.ts` `resolveRouting`: verify a PATCH with `routing: { courierCount: 3 }` persists (it spreads `...routing`); check `UpdateTenantDto` — if `routing` is validated with a nested DTO listing keys, add `courierCount?: number` with `@IsInt() @Min(1) @Max(10) @IsOptional()`; if it's a plain object, no change.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @fermeribg/server test -- routing`
Expected: PASS.
Also run the full server suite once: `pnpm --filter @fermeribg/server test` → fix any straggler compile errors from removed exports (`mergeBySlot`, `RouteOrderMode`, `slotFrom`).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/routing server/src/modules/tenants
git commit -m "feat(routing): multi-courier routes — sweep split + per-courier optimization, orderMode removed"
```

---

### Task 6: Server surfaces that rendered slot times (digest, dashboard, order email)

**Files:**
- Modify: `server/src/modules/dashboard/dashboard.service.ts:9,98-125` (today's slot list)
- Verify-only: `server/src/modules/digest/digest.service.ts` (already null-safe: renders `'—'` when times null — confirm, do not change)
- Modify: whatever `lockAndCheckSlot` callers / order-email templates print as the slot label (grep `slotFrom` and `timeFrom` under `server/src/modules/order-email` and `server/src/modules/orders`; render `date` only when times are null, e.g. `четвъртък, 10.07` via the existing bg date helpers)

**Interfaces:**
- Consumes: nullable `deliverySlots.timeFrom/timeTo` from Task 1.
- Produces: no new interfaces; dashboard summary rows become `{ date, booked, capacity }`-shaped where they were `{ timeFrom, timeTo, ... }` (read the file, keep the response field names the client already consumes where possible — if the client renders `timeFrom`, return `null` there and let Task 7 fix the client rendering).

- [ ] **Step 1: Grep every render site**

Run: `grep -rn "slotFrom\|slotTo\|timeFrom\|timeTo" server/src --include="*.ts" | grep -v spec | grep -v slots/ | grep -v routing/`
For each hit: times may now be null → the label falls back to the slot date (or drops the bracket entirely). Digest lines like `` o.slotFrom && o.slotTo ? `${hhmm(o.slotFrom)}–${hhmm(o.slotTo)}` : '—' `` are already correct — leave them.

- [ ] **Step 2: Dashboard "today's slots" block**

`dashboard.service.ts` — the block selecting `deliverySlots.timeFrom/timeTo` for today: keep the query but make the types `string | null`, order by `deliverySlots.date`, and let the summary show `booked/capacity` for the day (the time fields stay in the payload as null so the client contract doesn't break before Task 7).

- [ ] **Step 3: Typecheck + full server suite**

Run: `pnpm --filter @fermeribg/server test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src
git commit -m "feat(server): null-safe slot time rendering — day labels on dashboard/digest/order surfaces"
```

---

### Task 7: Client panel — slots UI (Доставка page) + types + api-client

**Files:**
- Modify: `client/src/lib/types.ts` (Slot, SlotRule, SlotDay; delete SlotWindow usage from rule; RouteResult → MultiRouteResult per Task 5 interfaces; delete RouteOrderMode, RouteStop.slotFrom/slotTo)
- Modify: `client/src/lib/api-client.ts` (`createSlot`/`updateSlot` payloads lose times; `saveSlotRule` new shape; route fetch gains `couriers`)
- Modify: `client/src/components/slots/recurrence-card.tsx` (rewrite form)
- Modify: `client/src/components/slots/add-slot-dialog.tsx` (date+capacity+notes)
- Modify: `client/src/components/slots/slot-pill.tsx` (day pill: „12/40", legacy times only when present)
- Modify: `client/src/components/slots/slots-client.tsx` (day grid: one pill per day; DayScheduleDialog loses windows, gains capacity; „Час" add-button → „Отвори ден", hidden when the day already has a row)
- Modify: `client/src/lib/slots.ts`, delete `client/src/lib/slot-chunks.ts` + its test if nothing else imports it (grep first — `splitWindowChunks` is used by slots-client and recurrence-card, both being rewritten; **`WindowFields` + `WD` from recurrence-card are reused by `client/src/components/delivery/methods-section.tsx` for the pickup schedule — keep both exports working**: keep `WindowFields` and its `SlotWindow` prop type intact in recurrence-card (or move them to `client/src/components/delivery/window-fields.tsx` and update the import in methods-section), even though the slot rule itself no longer uses windows)
- Modify: `client/src/components/orders/order-panel.tsx`, `order-edit-fields.tsx`, `orders-client.tsx`, `dashboard-client.tsx` — wherever slot labels render `timeFrom–timeTo`, show `ддmm(date)` when times are null (grep `hhmm(` in these files)
- Modify: `client/src/lib/delivery-data.ts` (SLOTS_HELP copy: часове → дни/капацитет)

**Interfaces:**
- Consumes (exact server shapes):
  - `Slot { id, tenantId, date, timeFrom: string | null, timeTo: string | null, isActive, customerNote, driverNote, generated, capacity, booked }`
  - `SlotRule` / `SlotDay {dow, capacity}` / `intervalCapacity` from Task 2.
  - `POST /slots {date, dateTo?, weekdays?, capacity?, customerNote?, driverNote?}`, `PATCH /slots/:id {capacity?, customerNote?, driverNote?}`.
- Produces: none beyond UI.

- [ ] **Step 1: types.ts + api-client.ts**

Update `Slot.timeFrom/timeTo` to `string | null`. `SlotDay` → `{dow: number; capacity: number}`. `SlotRule` per Task 2 (delete `intervalWindow`, `slotMinutes`, `defaultCapacity`; add `intervalCapacity`). `SlotRuleInput` stays the Omit. `RouteStop` loses `slotFrom/slotTo`; delete `RouteOrderMode`; replace `RouteResult` with:

```ts
export interface CourierRoute {
  stops: RouteStop[];
  totalDistanceM: number | null;
  totalDurationS: number | null;
  optimized: boolean;
  polyline: string[] | null;
}
export interface MultiRouteResult {
  date: string;
  origin: { address: string | null; lat: number | null; lng: number | null };
  end: RouteEnd;
  couriers: number;
  routes: CourierRoute[];
}
```

api-client: `createSlot(data: {date: string; dateTo?: string; weekdays?: number[]; capacity?: number; customerNote?: string; driverNote?: string})`; `updateSlot(id, {capacity?, customerNote?, driverNote?})`.

- [ ] **Step 2: RecurrenceCard rewrite**

Keep the card frame, toggle, repeat-mode buttons, weekday toggles, advanced fold (anchorDate + notes), save flow. Replace hours UI with capacity: „Еднакъв капацитет за всички дни" toggle (mirrors old sameHours pattern) + one number input, or per-day number inputs (label `Чт — колко доставки?`). Interval mode: single capacity input. Delete `TIMES`, `SLOT_LEN`, `slotMinutes` state, chunk preview; state becomes:

```ts
interface State {
  active: boolean;
  repeat: 'weekdays' | 'interval';
  days: SlotDay[];            // {dow, capacity}
  sameCapacity: boolean;
  sharedCapacity: number;
  intervalDays: number;
  intervalCapacity: number;
  anchorDate: string;
  customerNote: string;
  driverNote: string;
  horizonDays: number;
  skipDates: string[];
}
```

Save payload = new `SlotRuleInput`. Capacity inputs: `type="number" min={1} max={500}`, clamp on change like the old defaultCapacity input. Card copy: „Повтарящи се дни за доставка" / „Задай веднъж — дните се отварят напред автоматично. Клиентът избира ден, а не час; ти решаваш колко поръчки поемаш на ден."
Keep `WD` + `WindowFields` exports intact for methods-section (see Files note).

- [ ] **Step 3: AddSlotDialog + SlotPill + slots-client**

- AddSlotDialog (`SlotInput`): fields date (readonly, comes from the day column), capacity number, customerNote, driverNote. Editing an existing day = capacity+notes.
- SlotPill: line 1 shows `hhmm(timeFrom)–hhmm(timeTo)` only when `timeFrom != null`, otherwise „Цял ден"; the booked/capacity fraction becomes the primary line (`{booked}/{capacity} поръчки`). Keep the generated ↻ marker + note dot.
- slots-client: `byDay(d)` still works (one row per day now). „+ Час" button → „+ Отвори ден", rendered only when `byDay(d).length === 0`. `DayScheduleDialog`: replace the time window with a capacity input; `applyDay(d, working, capacity)` → `closeSlotDay(d)` then, when working, `createSlot({ date: d, capacity })` (single call, no chunks). Remove `splitWindowChunks` import + `slotMinutes` prop. Legend „свободно/заето" stays. Toasts: „часове" → „ден/дни" wording.
- delivery page (`client/src/app/(admin)/delivery/page.tsx`) — verify props still line up (it hosts the same components).

- [ ] **Step 4: Order surfaces**

In order-panel/order-edit-fields/orders-client/dashboard-client: every `${hhmm(slotFrom)}–${hhmm(slotTo)}` (or equivalent) becomes conditional — when times null, show the slot date (`ddmm(slotDate)` — the API already returns `slotDate`). The order-edit slot reassignment `<select>` options: label by `ддmm(date) · остават N` instead of times.

- [ ] **Step 5: Build + lint**

Run: `pnpm --filter client build` (or `pnpm -C client build`)
Expected: compiles clean. Fix all TS errors from the type changes (this step is the sweep that catches every straggler render site).

- [ ] **Step 6: Commit**

```bash
git add client/src
git commit -m "feat(client): day-based slots UI — per-day capacity rule, day pills, null-safe time labels"
```

---

### Task 8: Client panel — Маршрут page multi-courier

**Files:**
- Modify: `client/src/app/(admin)/route/page.tsx` (fetch `?couriers=` param; empty MultiRouteResult fallback)
- Modify: `client/src/components/route/route-client.tsx` (courier selector, per-courier tabs, aggregate summary; orderMode toggle deleted)
- Modify: `client/src/components/route/route-map.tsx` (all routes drawn, colored; numbered markers per route)
- Modify: `client/src/components/route/stop-list.tsx` (unchanged API — receives the ACTIVE courier's stops; only slot-time badge removal if present)
- Modify: `client/src/components/route/waze-stepper.tsx` + `waze.ts` (targets built per active courier; progress key includes courier index)
- Modify: `client/src/components/route/location-route-card.tsx` (add „Куриери по подразбиране" number input saving `routing.courierCount` via the existing settings PATCH — read the file to find the save call)

**Interfaces:**
- Consumes: `MultiRouteResult`/`CourierRoute` from Task 7 types; `GET /orders/route?date&end&couriers`.
- Produces: none.

- [ ] **Step 1: page.tsx**

Parse `searchParams.couriers` (int, clamp 1..10, omit when absent → server default). Empty fallback object becomes `{ date, origin: {...}, end: {...}, couriers: 1, routes: [] }`. Pass through to RouteClient.

- [ ] **Step 2: route-client.tsx rework**

- Delete `ORDER_OPTIONS`, `orderMode`, the „По час / Най-кратък път" toggle and its hints (route is always shortest); update the help modal copy accordingly (remove „По час" bullet, add „Куриери" bullet: „Раздели маршрута между няколко души — всеки получава балансирана част от спирките, всички тръгват от базата.").
- Courier count control next to the end-mode toggle: `<select>` 1..10 labelled „Куриери", navigating like `setEnd` does: `router.push(\`/route?date=${route.date}&end=${end.mode}&couriers=${n}\`)`.
- Active courier tabs above the stop list when `routes.length > 1`: „Маршрут 1 (12 спирки · 14,2 км · ~1 ч)" — active route's stops feed `StopList`, Waze, `openRoute` (Google Maps legs), `stopUrl`. `finishDay` iterates **all** routes' stops (flatten).
- Aggregate summary line: total stops across routes + per-route distance/duration chips.
- `unlocated` warning: compute across all routes.
- Waze progress localStorage key: `ff:waze:${route.date}:${activeCourierIdx}`.
- Colors: define `const ROUTE_COLORS = ['#2c7a3f', '#1d6fb8', '#c2571d', '#7b3fb8', '#b83f5e', '#3fb8a9', '#8a8f1d', '#5e5e5e', '#b89f1d', '#1db884'];` exported for the map.

- [ ] **Step 3: route-map.tsx**

Props change: `stops` → `routes: CourierRoute[]` + `activeRoute: number`. Draw every route's polyline (its own color from `ROUTE_COLORS`, active route full opacity, others 45%). Markers: number stops per route (1..n each), marker glyph background = route color. `activeId`/`onPick` unchanged (ids unique across routes). Keep origin ★ and custom-end ⚑ markers.

- [ ] **Step 4: Verify in dev**

Run: `pnpm -C client dev` against local API with seeded data (see `docs/` dev notes; API dev DB port 5433). On /route: create ≥6 confirmed address orders across the map, set couriers=2 → two colored routes, tabs switch lists, Google Maps opens the active route only. If seeding is impractical, cover the split rendering with a Storybook-less smoke: temporarily hardcode a 2-route fixture in page.tsx, verify, revert (do not commit the fixture).

- [ ] **Step 5: Build + commit**

Run: `pnpm -C client build` → clean.

```bash
git add client/src
git commit -m "feat(client): multi-courier route page — courier selector, per-route tabs, colored map routes"
```

---

### Task 9: FarmFlow/storefront day picker

**Files:**
- Modify: `storefront/src/components/slot-picker.tsx`
- Modify: `storefront/src/lib/api.ts` (`PublicSlot` type: `startTime/endTime: string | null`)
- Modify: `storefront/src/components/checkout-client.tsx` (label copy „ден за доставка"; grep `slot` usages)
- Modify: `storefront/src/app/confirmation/page.tsx` (render date-only when no times)

**Interfaces:**
- Consumes: `GET /public/:slug/slots` → `PublicSlot { id, date, startTime: string | null, endTime: string | null, customerNote, remaining }`.

- [ ] **Step 1: slot-picker.tsx → day picker**

The 7-day pill window stays, but a day IS the choice now: clicking an available date selects its (single) slot id directly — the second „hours" row dies. Concretely: keep `buildWindow()`/pill rendering; a date with `byDate[iso].length > 0` is pickable (pill gets `is-active` on selection + a ✓); `onChange(slot.id, \`${d.weekday}, ${d.display}\`)` fires with the day's first slot. Under the pills show the selected day's `customerNote` and „остават N места" when `remaining != null`. Remove the `activeSlots.map` time-buttons block. Extend the window to 14 days (day-granularity needs more reach than 7).

- [ ] **Step 2: checkout-client + confirmation**

Checkout copy: „Избери час за доставка" → „Избери ден за доставка" (grep the exact string). Confirmation: slot label renders `date`-based label; when legacy `startTime` present keep old format.

- [ ] **Step 3: Build + commit**

Run: `pnpm -C storefront build` → clean.

```bash
git add storefront/src
git commit -m "feat(storefront): day-based delivery picker — pick a day, not an hour"
```

---

### Task 10: chaika day picker (repo: `C:\Users\Lenovo\source\repos\fermerski-pazar-chaika`)

**Files:**
- Modify: `src/scripts/checkout-page.ts` (slot module, lines ~443–560)
- Modify: `src/pages/checkout.astro` (slot card markup: „Избери ден"; step-2 section becomes the note/remaining area)
- Modify: `src/lib/types.ts` (`Slot.startTime/endTime: string | null`)
- Modify: `src/scripts/confirmation-page.ts` (+ `src/pages/confirmation.astro` if labels are baked there): day-only label when no times

**Interfaces:**
- Consumes: same `PublicSlot` contract as Task 9. Order payload `slotId` unchanged.

- [ ] **Step 1: Rework `loadSlots()`**

Keep the ranged fetch (extend horizon 21 → 30 days). `byDate` map stays. Date pills become the selection itself:

- `renderPills()` — a pill click sets `selectedSlotId = byDate.get(d)![0].id` and `selectedSlotLabel = \`${WD[dt.getDay()]}, ${dt.getDate()} ${MO[dt.getMonth()]}\``, marks the pill `is-active`, and shows `slotChosen` („Избра: четвъртък, 10 юли").
- `renderSlots()` — repurpose the `#slots` box to show the selected day's `customerNote` + „остават N места" (`remaining != null`); no time buttons. Keep `esc()` on every interpolated value.
- Empty state copy: „Няма свободни часове" → „Няма свободни дни за доставка в момента — ще се свържем с теб за уговорка след поръчката."
- The submit guard (`slotsAvailable && !selectedSlotId`) and `payload.slotId` wiring stay as-is.

- [ ] **Step 2: checkout.astro + confirmation**

Slot card heading/step copy: „1. Избери дата → 2. Избери час" collapses to „Избери ден за доставка". Confirmation label: when the stored label has no hours it's already day-only (label built at pick time) — verify `confirmation-page.ts` renders `slot` label verbatim; if it re-derives times, make it fall back to date.

- [ ] **Step 3: Check + commit**

Run: `pnpm astro check` (or the repo's check script — see chaika `package.json`; memory: `astro check` is the repo's gate) → clean.

```bash
git add src
git commit -m "feat(checkout): day-based delivery picker — date pills select the day directly"
```

- [ ] **Step 4: DO NOT push yet** — the deploy is coordinated in Task 12.

---

### Task 11: FarmFlow-Templates day picker (repo: `C:\Users\Lenovo\source\repos\FarmFlow-Templates`)

**Files:**
- Modify: `src/scripts/checkout-page.ts`, `src/pages/checkout.astro`, `src/lib/types.ts`, `src/scripts/confirmation-page.ts`, `src/lib/demo-data.ts` (demo slots become day-rows: null times)

**Interfaces:** same as Task 10.

- [ ] **Step 1: Port the Task 10 changes**

The templates checkout script is a sibling of chaika's — apply the same rework (diff the two files first; where identical, port 1:1; where the template factory diverges — e.g. `client-api.ts` demo mode — update `demo-data.ts` slots to `{date, startTime: null, endTime: null, remaining}`).

- [ ] **Step 2: Check + commit**

Run the repo's check/build script (see its `package.json`; CI uses frozen-lockfile — don't touch deps).

```bash
git add src
git commit -m "feat(checkout): day-based delivery picker (port from chaika day-slots rework)"
```

---

### Task 12: End-to-end verification + rollout notes

**Files:**
- Verify-only across repos; no new code except fixes found.

- [ ] **Step 1: Full test suites**

- `pnpm --filter @fermeribg/server test` → all green.
- `pnpm -C client build`, `pnpm -C storefront build` → clean.
- chaika + Templates checks → clean.

- [ ] **Step 2: Local E2E happy path (FarmFlow repo, dev stack)**

1. Start dev stack (API + client; DB on :5433).
2. As farmer: save rule Чт=40 (weekdays mode) → Доставка page shows Thursday day-pills „0/40".
3. Public API: `GET /public/<slug>/slots` → day rows, `startTime: null`, `remaining: 40`.
4. Book an order via the storefront checkout for Thursday → panel shows „1/40"; digest/dashboard render day label without times.
5. Confirm ≥6 address orders with geocoded addresses on the same day; `/route?couriers=2` → 2 balanced colored routes; `couriers=1` → single route (legacy behaviour).
6. Migration check on a dev copy: seed 3 time slots on one future date with 2 orders across them → run 0081 → 1 day-row, capacity = sum, both orders repointed, past-date slots untouched.

- [ ] **Step 3: Deployment ordering note (write into the PR/commit description)**

Deploy order: **FarmFlow server first** (migration 0081 + API), then client panel (same deploy), then chaika + Templates + storefront pushes. Old storefront bundles keep working between the two steps (they render day-grouped slots whose time labels are blank strings — acceptable for the minutes-long window; chaika deploys automatically on push via CF Workers Builds).

- [ ] **Step 4: Final commit / merge prep**

Squash-free: history stays task-per-commit. Update memory file per session rules after user sign-off.
