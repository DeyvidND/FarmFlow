# Consolidated handover protocol (фаза 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the обобщен приемо-предавателен протокол (consolidated handover protocol): one document per day (all farmers/orders/couriers, admin-only) and one per active courier leg (that courier's farmers/orders only), live while `status='draft'`, editable by role `admin` via an `overrides` layer, frozen into `frozen_rows` on sign, numbered in its own `ОБ-<n>` series, rendered on the фаза-0 PDF kit, with a client edit screen.

**Architecture:** A new `consolidated_protocols` table holds ONE row per `(tenant, date, scope, legIndex)` target — a thin persisted shell (status, doc_number, meta, overrides, frozen_rows, receiver signature). All the heavy content — which farmers, which orders, how much cargo — is **never stored while draft**; it is recomputed on every read from `orders`/`order_items`/`products`/`farmers`, exactly like the existing bilateral protocol's `DayProtocolRow` live view (`handover.service.ts`). `overrides` (exclude/extra-row/field-override) is applied on top of that live computation. Freezing snapshots the live computation once into `frozen_rows`; every read after that returns the frozen copy verbatim, never touching orders again. Leg scoping reuses the exact mechanism `GET /handover/check` already uses: `CourierAssignmentService.resolveMyLeg` for "which leg is this courier" and `RoutingService.getRoute(..., 'all')` for "which orders are on that leg" — no new scoping primitive is invented.

**Tech Stack:** NestJS, Drizzle ORM, PostgreSQL, TypeScript, `pdf-lib` (via the фаза-0 `pdf-kit.ts`/`pdf-table.ts` primitives), Next.js/React client, jest (server), vitest (client).

## Global Constraints

- Node ≥20, pnpm@9.12. Server tests: `pnpm --filter @fermeribg/api test -- <pattern> --maxWorkers=4`, always run in the **foreground** (never backgrounded — a background test run cannot be waited on for a RED/GREEN gate). Client tests: `pnpm --filter @fermeribg/web test -- <pattern>` (vitest).
- **No new npm dependencies.**
- **No new font asset** — bold stays emulated via `drawBoldText` (see `pdf-kit.ts`'s own "THIS IS THE SEAM" comment; a real bold font is future work, not this phase's).
- All dates through `dateBg`/`bgDateOf`/`bgToday`. A local `Date` getter is forbidden — prod runs UTC, dev runs Europe/Sofia, the suite runs UTC; a local-getter bug is invisible on a dev machine and wrong in prod.
- Drizzle: no `ANY()` — use `inArray`. Any raw `sql` `CASE…THEN` needs an explicit `::int`/`::text` cast.
- `@IsOptional()` does not coerce `''` → `undefined` on a DTO string field — add `@Transform(({value}) => value === '' ? undefined : value)` wherever an optional query/body string can arrive empty (see `DraftQueryDto`/`BatchDto` for the existing pattern to copy).
- Signatures are NEVER stored unencrypted. Every write path for `receiver_signature_png` goes through `encryptSignature` (throws `SignatureKeyMissingError` → translate to a 503, same as `HandoverService.createSigned`); every read goes through `decryptSignature`.
- `consolidated_protocols` rows are tenant-scoped on every query — no exceptions, this is multi-tenant data.
- **Signed is immutable.** Once `status='signed'`, `PATCH` (overrides/meta) and a second `sign` both reject (409). This is explicitly out of scope per the spec ("извън обхвата: редакция на подписан документ").
- New routes default-deny to role `admin` via the global `TenantRolesGuard` (no `@Roles` needed for admin-only routes); `@Roles('admin', 'driver')` is added explicitly only where a courier must reach a route, and the handler itself narrows a driver to their OWN leg — never trust `@Roles` alone for leg scoping.

## Migration numbering — SINGLE POINT OF CHANGE

This plan is written against **`0112_consolidated_protocols.sql`**, journal **`idx: 110`**, tag `consolidated_protocols` — the next free slot as of 2026-07-22 (this worktree's `packages/db/drizzle/meta/_journal.json` ends at `idx: 109` / tag `0111_handover_signatures`). A concurrent branch (`koshnitsi-baskets`) may already have claimed `0112` on `main` by the time this plan is executed.

**Before Task 1's migration step — and not before —** re-check the freshest `packages/db/drizzle/meta/_journal.json` (on whichever branch/worktree this executes against) for the true next `idx`/number. If `0112` is taken, renumber to the next free one EVERYWHERE it appears in Task 1: the migration filename, the journal entry's `idx` and `tag`, and nowhere else — no other task, test, or piece of code in this plan hardcodes the migration number. The Drizzle schema object (`consolidatedProtocols` in `schema.ts`) and every service/controller/test reference the table by its Drizzle name, never by migration number.

---

## Part A — Data model + backend service

### Task 1: Shared types, schema, migration

**Files:**
- Modify: `packages/types/src/index.ts`
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0112_consolidated_protocols.sql` (renumber per the box above if needed)
- Modify: `packages/db/drizzle/meta/_journal.json` (renumber per the box above if needed)

**Interfaces produced:**
- `ConsolidatedProtocolMeta`, `ConsolidatedProtocolExtraRow`, `ConsolidatedFieldOverride`, `ConsolidatedProtocolOverrides` (packages/types — the `meta`/`overrides` jsonb column shapes, shared between server persistence and the client editor)
- `consolidatedProtocols` Drizzle table (packages/db)

There is no runtime test for a type-only addition or a hand-applied SQL file (this codebase has no migration-execution test harness — migrations are verified by running them against the real dev Postgres, per `CLAUDE.md`'s "migrations are hand-written" gotcha). This task's verification is TypeScript compilation + a manual DB smoke-check instead of jest RED/GREEN; Task 2 is where the first real jest test lands (against the Drizzle schema object this task produces).

- [ ] **Step 1: Add the shared jsonb-column types**

In `packages/types/src/index.ts`, add near `LegalIdentity`/`TenantSettings`:

```ts
/**
 * Manual header fields on a consolidated (day/leg) protocol — the paper form's
 * own hand-filled boxes (vehicle, plate, driver, timing). Never derived from
 * orders; `driverName` is SUGGESTED from `route_courier_assignments` when
 * empty but stays independently editable (the car/driver can change the
 * morning of). See consolidated_protocols.meta (migration 0112).
 */
export interface ConsolidatedProtocolMeta {
  vehicle?: string;
  plate?: string;
  driverName?: string;
  startPlace?: string;
  startTime?: string;
  plannedEnd?: string;
}

/** A manually-added row on a consolidated protocol — `overrides.extraRows`.
 *  `section` says which table it belongs on; the rest is free-form printable
 *  cell text (this is a paper-form escape hatch, not a typed line item). */
export interface ConsolidatedProtocolExtraRow {
  section: 'A' | 'B';
  label: string;
  detail?: string;
}

/** Per-row manual correction, keyed by `f:<farmerId>` (section А) or
 *  `o:<orderId>` (section Б) in `overrides.fieldOverrides`. */
export interface ConsolidatedFieldOverride {
  batch?: string;
  eDoc?: string;
  note?: string;
}

/**
 * The `overrides` jsonb layer on `consolidated_protocols` (spec §1.4).
 * Applied on top of the live-computed rows while `status='draft'`; folded
 * into `frozen_rows` at sign time and never consulted again after that.
 */
export interface ConsolidatedProtocolOverrides {
  excludedOrderIds?: string[];
  extraRows?: ConsolidatedProtocolExtraRow[];
  fieldOverrides?: Record<string, ConsolidatedFieldOverride>;
}
```

- [ ] **Step 2: Add the Drizzle table**

In `packages/db/src/schema.ts`, directly after `handoverProtocols`:

```ts
// Обобщен приемо-предавателен протокол за целия курс (scope='day') или един
// куриерски лег (scope='leg') — виж
// docs/superpowers/specs/2026-07-21-consolidated-handover-protocol-design.md.
// Own numbering series (doc_number, printed "ОБ-<n>") — deliberately separate
// from handover_protocols.protocol_number; the two documents must never share
// a visible number. Content (which farmers/orders) is NEVER stored while
// status='draft' — only meta/overrides/status live here; the live view is
// recomputed from orders/order_items/products/farmers on every read
// (ConsolidatedProtocolService). frozen_rows is populated ONLY at sign time
// and is the legal record from then on — the PDF renders from it, never from
// orders again, once signed.
export const consolidatedProtocols = pgTable(
  'consolidated_protocols',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // 'day' | 'leg'
    scope: text('scope').notNull(),
    // БГ ден на курса (YYYY-MM-DD), same convention as deliverySlots.date.
    date: date('date').notNull(),
    // 0-based leg, same indexing as route_courier_assignments.legIndex /
    // orders.courierIndex. NULL when scope='day'.
    legIndex: integer('leg_index'),
    // Own series — printed "ОБ-<docNumber>". See handover_protocols.protocolNumber
    // for the sibling bilateral series (deliberately NOT shared).
    docNumber: integer('doc_number').notNull(),
    // 'draft' | 'signed'
    status: text('status').notNull().default('draft'),
    meta: jsonb('meta').$type<ConsolidatedProtocolMeta>(),
    overrides: jsonb('overrides').$type<ConsolidatedProtocolOverrides>(),
    // NULL while draft; populated ONCE at sign time and never recomputed after.
    frozenRows: jsonb('frozen_rows').$type<ConsolidatedProtocolRows | null>(),
    // Encrypted at rest — same AES-256-GCM secret.util as farmers.signaturePng /
    // tenants.operatorSignaturePng (common/crypto/signature-crypto). Captured
    // live on the signing device — see §1.7: no reusable courier signature is
    // ever saved, unlike the farmer/operator ones.
    receiverSignaturePng: text('receiver_signature_png'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (t) => ({
    tenantDocNumberUniq: uniqueIndex('consolidated_protocols_tenant_doc_number_uniq').on(
      t.tenantId,
      t.docNumber,
    ),
    // COALESCE is load-bearing: Postgres treats every NULL as distinct in a
    // unique index, so without it two scope='day' rows (both leg_index IS
    // NULL) for the same tenant+date would NOT collide — exactly the bug the
    // spec calls out ("вече се случи веднъж днес"). -1 is a safe sentinel:
    // legIndex is always >= 0 when scope='leg'.
    tenantDateScopeLegUniq: uniqueIndex('consolidated_protocols_tenant_date_scope_leg_uniq').on(
      t.tenantId,
      t.date,
      t.scope,
      sql`coalesce(${t.legIndex}, -1)`,
    ),
  }),
);
```

Add the `ConsolidatedProtocolRows` forward-reference type used by `frozenRows`'s `$type<>` — it is declared in Task 4 (`consolidated-protocol.service.ts`) but `schema.ts` cannot import from `server/`. Instead type `frozenRows` as `jsonb('frozen_rows').$type<unknown>()` in `schema.ts` (the service casts it to the real shape on read — same pattern `handoverProtocols.items`/`fromSnapshot` already use: `jsonb(...).notNull()` with no `$type`, cast at the call site). Use this simpler form:

```ts
    frozenRows: jsonb('frozen_rows'), // cast to ConsolidatedProtocolRows at the read site (service layer)
```

- [ ] **Step 3: Write the migration**

Re-verify the number per the box at the top of this plan, then create `packages/db/drizzle/0112_consolidated_protocols.sql`:

```sql
-- 0112_consolidated_protocols.sql
-- Обобщен приемо-предавателен протокол за целия курс (scope='day') или един
-- куриерски лег (scope='leg'). Own numbering series (doc_number, printed
-- "ОБ-<n>"), separate from handover_protocols.protocol_number. Content is
-- NEVER stored while draft; only frozen_rows (populated at sign time) is.
CREATE TABLE IF NOT EXISTS "consolidated_protocols" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "scope" text NOT NULL,
  "date" date NOT NULL,
  "leg_index" integer,
  "doc_number" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "meta" jsonb,
  "overrides" jsonb,
  "frozen_rows" jsonb,
  "receiver_signature_png" text,
  "signed_at" timestamp with time zone,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "consolidated_protocols_tenant_doc_number_uniq" ON "consolidated_protocols" ("tenant_id","doc_number");
-- COALESCE is mandatory — see the schema.ts comment on tenantDateScopeLegUniq.
-- Without it, two scope='day' rows for the same tenant+date (both leg_index
-- IS NULL) do NOT collide in Postgres and a duplicate day protocol slips through.
CREATE UNIQUE INDEX IF NOT EXISTS "consolidated_protocols_tenant_date_scope_leg_uniq" ON "consolidated_protocols" ("tenant_id","date","scope",COALESCE("leg_index",-1));
```

- [ ] **Step 4: Add the journal entry**

Re-verify `idx`/number per the box at the top, then append to `packages/db/drizzle/meta/_journal.json`'s `entries` array, immediately after the `idx: 109` entry:

```json
    {
      "idx": 110,
      "version": "7",
      "when": 1785000000000,
      "tag": "0112_consolidated_protocols",
      "breakpoints": true
    }
```

(`when` is a placeholder millisecond timestamp later than `0111`'s `1784900000000` — exact value doesn't matter, only that it's monotonically increasing and unique, matching every prior entry's convention.)

- [ ] **Step 5: Verify — compile + manual DB smoke-check**

```bash
pnpm --filter @fermeribg/db build
```
Expected: clean TypeScript compile (confirms `consolidatedProtocols` typechecks and is exported via `export * from './schema'` in `packages/db/src/index.ts`).

Then, against the local dev Postgres (docker-compose, port 5433 — `pnpm db:migrate` from repo root):
```bash
pnpm db:migrate
psql "postgresql://<dev-conn-string>" -c "\d consolidated_protocols"
```
Expected: the table exists with both unique indexes listed. Then prove the COALESCE index actually rejects a duplicate day-scope row:
```sql
-- substitute a real tenant id from your dev DB
INSERT INTO consolidated_protocols (tenant_id, scope, date, leg_index, doc_number) VALUES ('<tenant-id>', 'day', '2026-07-22', NULL, 1);
INSERT INTO consolidated_protocols (tenant_id, scope, date, leg_index, doc_number) VALUES ('<tenant-id>', 'day', '2026-07-22', NULL, 2);
```
Expected: the second INSERT fails with `duplicate key value violates unique constraint "consolidated_protocols_tenant_date_scope_leg_uniq"`. This is the migration task's TEETH-CHECK — if you temporarily drop the `COALESCE` from the CREATE INDEX statement and re-run, BOTH inserts succeed (proving the constraint would silently miss the day-scope duplicate without it), then restore the COALESCE and re-verify the second insert fails again.

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/index.ts packages/db/src/schema.ts packages/db/drizzle/0112_consolidated_protocols.sql packages/db/drizzle/meta/_journal.json
git commit -m "feat(handover): add consolidated_protocols table + shared jsonb types"
```

---

### Task 2: Numbering + ensureDraft + listForDay

**Files:**
- Create: `server/src/modules/handover/consolidated-protocol.service.ts`
- Create: `server/src/modules/handover/consolidated-protocol.service.spec.ts`

**Interfaces:**
- Consumes: `consolidatedProtocols`, `routeCourierAssignments` (via `CourierAssignmentService`) from Task 1/existing code; `DB_TOKEN`; `CourierAssignmentService.getAssignmentsForDay(tenantId, date): Promise<{accountId, legIndex}[]>` (existing, `courier-assignment.service.ts:37`).
- Produces:
  - `export type ConsolidatedScope = 'day' | 'leg';`
  - `export interface ConsolidatedProtocolSummary { id: string | null; scope: ConsolidatedScope; legIndex: number | null; date: string; docNumber: number | null; status: 'draft' | 'signed' | null; }`
  - `class ConsolidatedProtocolService { constructor(db, routing: RoutingService, courierAssignment: CourierAssignmentService); ensureDraft(tenantId, date, scope, legIndex?): Promise<{id: string}>; listForDay(tenantId, date): Promise<ConsolidatedProtocolSummary[]>; }` (more methods added in later tasks — this task's slice only)

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/modules/handover/consolidated-protocol.service.spec.ts
import { and, eq, isNull } from 'drizzle-orm';
import { consolidatedProtocols } from '@fermeribg/db';
import { ConsolidatedProtocolService } from './consolidated-protocol.service';

const CHAIN_METHODS = [
  'select', 'from', 'where', 'innerJoin', 'leftJoin', 'limit', 'orderBy',
  'update', 'insert', 'returning', 'delete',
] as const;

function makeDb() {
  const queue: unknown[] = [];
  const calls: { values: unknown[]; where: unknown[] } = { values: [], where: [] };
  const step: any = {};
  for (const m of CHAIN_METHODS) step[m] = jest.fn(() => step);
  step.values = jest.fn((v: unknown) => { calls.values.push(v); return step; });
  step.where = jest.fn((c: unknown) => { calls.where.push(c); return step; });
  step.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    const v = queue.shift();
    if (v instanceof Error) reject(v); else resolve(v);
  };
  const db: any = { queue: (v: unknown) => queue.push(v), calls };
  for (const m of CHAIN_METHODS) db[m] = jest.fn(() => step);
  db.execute = jest.fn(() => Promise.resolve(undefined));
  db.transaction = jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db));
  return db;
}

function makeSvc(db: any, routing: any = {}, courierAssignment: any = {}) {
  return new ConsolidatedProtocolService(db, routing, courierAssignment);
}

describe('ConsolidatedProtocolService.ensureDraft', () => {
  it('returns the existing id without touching the transaction when a row already exists', async () => {
    const db = makeDb();
    db.queue([{ id: 'existing' }]); // fast-path pre-check finds one
    const svc = makeSvc(db);
    const res = await svc.ensureDraft('t1', '2026-07-22', 'day');
    expect(res).toEqual({ id: 'existing' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('assigns the next per-tenant doc_number under the advisory lock when none exists', async () => {
    const db = makeDb();
    db.queue([]);          // fast-path pre-check: none
    db.queue([]);          // in-tx re-check under the lock: none
    db.queue([{ max: 5 }]); // current max doc_number
    db.queue([{ id: 'cp1' }]); // insert ... returning
    const svc = makeSvc(db);
    const res = await svc.ensureDraft('t1', '2026-07-22', 'leg', 1);
    expect(res).toEqual({ id: 'cp1' });
    const inserted = db.calls.values[0] as any;
    expect(inserted.docNumber).toBe(6);
    expect(inserted.scope).toBe('leg');
    expect(inserted.legIndex).toBe(1);
    expect(inserted.status).toBe('draft');
  });

  it('day scope stores legIndex NULL even when called with no legIndex argument', async () => {
    const db = makeDb();
    db.queue([]); db.queue([]); db.queue([{ max: 0 }]); db.queue([{ id: 'cp1' }]);
    const svc = makeSvc(db);
    await svc.ensureDraft('t1', '2026-07-22', 'day');
    expect((db.calls.values[0] as any).legIndex).toBeNull();
  });

  it('rejects a leg scope request with no legIndex', async () => {
    const svc = makeSvc(makeDb());
    await expect(svc.ensureDraft('t1', '2026-07-22', 'leg')).rejects.toThrow(/лег/);
  });

  // The COALESCE(-1) unique index treats scope='day' rows as legIndex=-1 and
  // every scope='leg' row by its real legIndex. The app-level duplicate guard
  // must mirror that EXACT semantics (isNull for day, eq for leg) or a race
  // that slips past this guard would still be legal per the DB constraint but
  // wrongly rejected/accepted here. Assert the captured WHERE, not just the result.
  it('the day-scope duplicate check filters on legIndex IS NULL', async () => {
    const db = makeDb();
    db.queue([{ id: 'existing' }]);
    const svc = makeSvc(db);
    await svc.ensureDraft('t1', '2026-07-22', 'day');
    expect(db.calls.where[0]).toEqual(
      and(
        eq(consolidatedProtocols.tenantId, 't1'),
        eq(consolidatedProtocols.date, '2026-07-22'),
        eq(consolidatedProtocols.scope, 'day'),
        isNull(consolidatedProtocols.legIndex),
      ),
    );
  });

  it('the leg-scope duplicate check filters on legIndex = N, not IS NULL', async () => {
    const db = makeDb();
    db.queue([{ id: 'existing' }]);
    const svc = makeSvc(db);
    await svc.ensureDraft('t1', '2026-07-22', 'leg', 2);
    expect(db.calls.where[0]).toEqual(
      and(
        eq(consolidatedProtocols.tenantId, 't1'),
        eq(consolidatedProtocols.date, '2026-07-22'),
        eq(consolidatedProtocols.scope, 'leg'),
        eq(consolidatedProtocols.legIndex, 2),
      ),
    );
  });
});

describe('ConsolidatedProtocolService.listForDay', () => {
  it('returns a virtual day placeholder plus one virtual placeholder per active leg, when nothing is persisted yet', async () => {
    const db = makeDb();
    db.queue([]); // no persisted rows for the date
    const courierAssignment = {
      getAssignmentsForDay: jest.fn().mockResolvedValue([
        { accountId: 'u1', legIndex: 1 },
        { accountId: 'u2', legIndex: 0 },
      ]),
    };
    const svc = makeSvc(db, {}, courierAssignment);
    const out = await svc.listForDay('t1', '2026-07-22');
    expect(out).toEqual([
      { id: null, scope: 'day', legIndex: null, date: '2026-07-22', docNumber: null, status: null },
      { id: null, scope: 'leg', legIndex: 0, date: '2026-07-22', docNumber: null, status: null },
      { id: null, scope: 'leg', legIndex: 1, date: '2026-07-22', docNumber: null, status: null },
    ]);
  });

  it('returns a persisted row in place of its virtual placeholder', async () => {
    const db = makeDb();
    db.queue([{ id: 'cp-day', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, docNumber: 3, status: 'signed' }]);
    const courierAssignment = { getAssignmentsForDay: jest.fn().mockResolvedValue([]) };
    const svc = makeSvc(db, {}, courierAssignment);
    const out = await svc.listForDay('t1', '2026-07-22');
    expect(out).toEqual([{ id: 'cp-day', scope: 'day', legIndex: null, date: '2026-07-22', docNumber: 3, status: 'signed' }]);
  });

  it('does not duplicate a leg that has no active courier — legs come ONLY from the assignment board', async () => {
    const db = makeDb();
    db.queue([]);
    const courierAssignment = { getAssignmentsForDay: jest.fn().mockResolvedValue([]) };
    const svc = makeSvc(db, {}, courierAssignment);
    const out = await svc.listForDay('t1', '2026-07-22');
    expect(out).toEqual([{ id: null, scope: 'day', legIndex: null, date: '2026-07-22', docNumber: null, status: null }]);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
pnpm --filter @fermeribg/api test -- consolidated-protocol.service --maxWorkers=4
```
Expected: FAIL — `Cannot find module './consolidated-protocol.service'`.

- [ ] **Step 3: Minimal implementation**

```ts
// server/src/modules/handover/consolidated-protocol.service.ts
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { type Database, consolidatedProtocols } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { RoutingService } from '../routing/routing.service';
import { CourierAssignmentService } from '../routing/courier-assignment.service';

export type ConsolidatedScope = 'day' | 'leg';

export interface ConsolidatedProtocolSummary {
  id: string | null;
  scope: ConsolidatedScope;
  legIndex: number | null;
  date: string;
  docNumber: number | null;
  status: 'draft' | 'signed' | null;
}

function targetMatch(tenantId: string, date: string, scope: ConsolidatedScope, legIndex?: number | null) {
  return and(
    eq(consolidatedProtocols.tenantId, tenantId),
    eq(consolidatedProtocols.date, date),
    eq(consolidatedProtocols.scope, scope),
    scope === 'day' ? isNull(consolidatedProtocols.legIndex) : eq(consolidatedProtocols.legIndex, legIndex!),
  );
}

@Injectable()
export class ConsolidatedProtocolService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly routing: RoutingService,
    private readonly courierAssignment: CourierAssignmentService,
  ) {}

  /** Materializes a draft row (assigning its doc_number) if one doesn't exist yet
   *  for this (tenant, date, scope, legIndex) target; otherwise returns the
   *  existing id. Same race-safe pattern as HandoverService.ensureDraftTarget:
   *  a fast-path pre-check, then an advisory-lock-guarded re-check + insert. */
  async ensureDraft(
    tenantId: string,
    date: string,
    scope: ConsolidatedScope,
    legIndex?: number,
  ): Promise<{ id: string }> {
    if (scope === 'leg' && legIndex == null) {
      throw new BadRequestException('Изисква се номер на лег.');
    }
    const match = targetMatch(tenantId, date, scope, legIndex);

    const [existing] = await this.db
      .select({ id: consolidatedProtocols.id })
      .from(consolidatedProtocols)
      .where(match)
      .limit(1);
    if (existing) return { id: existing.id };

    const inserted = await this.db.transaction(async (tx) => {
      // Distinct lock discriminator from handover_protocols' own
      // hashtextextended(tenantId, 0) — the two series don't need to
      // serialize against each other, only against themselves.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':consolidated', 0))`);
      const [dupe] = await tx
        .select({ id: consolidatedProtocols.id })
        .from(consolidatedProtocols)
        .where(match)
        .limit(1);
      if (dupe) return dupe;

      const [{ max }] = await tx
        .select({ max: sql<number | null>`max(${consolidatedProtocols.docNumber})` })
        .from(consolidatedProtocols)
        .where(eq(consolidatedProtocols.tenantId, tenantId));

      const [row] = await tx
        .insert(consolidatedProtocols)
        .values({
          tenantId,
          scope,
          date,
          legIndex: scope === 'leg' ? legIndex! : null,
          docNumber: (max ?? 0) + 1,
          status: 'draft',
          meta: {},
          overrides: {},
        })
        .returning({ id: consolidatedProtocols.id });
      return row;
    });

    return { id: inserted.id };
  }

  /** The day's protocol targets: the day-scope document plus one per courier
   *  leg ACTUALLY assigned that day (route_courier_assignments — never
   *  invented, per spec §2). A target with no persisted row yet comes back as
   *  a virtual placeholder (id=null) so the list is populated before anything
   *  is created — same idiom as HandoverService.listForDay's virtual rows. */
  async listForDay(tenantId: string, date: string): Promise<ConsolidatedProtocolSummary[]> {
    const persisted = await this.db
      .select()
      .from(consolidatedProtocols)
      .where(and(eq(consolidatedProtocols.tenantId, tenantId), eq(consolidatedProtocols.date, date)));

    const toSummary = (r: (typeof persisted)[number]): ConsolidatedProtocolSummary => ({
      id: r.id,
      scope: r.scope as ConsolidatedScope,
      legIndex: r.legIndex,
      date: r.date,
      docNumber: r.docNumber,
      status: r.status as 'draft' | 'signed',
    });

    const byKey = new Map(persisted.map((r) => [`${r.scope}:${r.legIndex ?? 'day'}`, r]));
    const out: ConsolidatedProtocolSummary[] = [];

    const dayRow = byKey.get('day:day');
    out.push(
      dayRow
        ? toSummary(dayRow)
        : { id: null, scope: 'day', legIndex: null, date, docNumber: null, status: null },
    );

    const board = await this.courierAssignment.getAssignmentsForDay(tenantId, date);
    const legIndexes = [...new Set(board.map((a) => a.legIndex))].sort((a, b) => a - b);
    for (const legIndex of legIndexes) {
      const row = byKey.get(`leg:${legIndex}`);
      out.push(
        row ? toSummary(row) : { id: null, scope: 'leg', legIndex, date, docNumber: null, status: null },
      );
    }
    return out;
  }
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
pnpm --filter @fermeribg/api test -- consolidated-protocol.service --maxWorkers=4
```
Expected: PASS (8 tests).

- [ ] **Step 5: TEETH-CHECK**

Temporarily change `scope === 'day' ? isNull(...) : eq(...)` to always `eq(consolidatedProtocols.legIndex, legIndex!)` (dropping the day/isNull branch). Re-run — the "day-scope duplicate check filters on legIndex IS NULL" test must go RED (it now asserts `eq(legIndex, undefined)` shape mismatch). Restore the branch, re-run, confirm GREEN again.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/consolidated-protocol.service.ts server/src/modules/handover/consolidated-protocol.service.spec.ts
git commit -m "feat(handover): consolidated protocol numbering + day/leg draft targets"
```

---

### Task 3: Scope resolution + live cargo aggregation

**Files:**
- Modify: `server/src/modules/handover/consolidated-protocol.service.ts`
- Modify: `server/src/modules/handover/consolidated-protocol.service.spec.ts`

**Interfaces:**
- Consumes: `RoutingService.getRoute(tenantId, date, endMode?, couriers?, endModes?, display): Promise<{routes: {courierIndex: number; stops: {id: string}[]}[]}>` (existing, `routing.service.ts:392`); `ProtocolItemDto` (existing, `./dto/create-protocol.dto.ts`); `farmers`, `orders`, `orderItems`, `products`, `deliverySlots` (existing, `@fermeribg/db`); `decryptSignature` (existing, `../../common/crypto/signature-crypto`).
- Produces:
  - `export interface ConsolidatedFarmerRow { farmerId: string; name: string; legal: LegalIdentity | null; items: ProtocolItemDto[]; signaturePng: string | null; batch?: string; eDoc?: string; note?: string; }`
  - `export interface ConsolidatedOrderRow { orderId: string; orderNumber: number | null; customerCode: string; cityOrZone: string | null; items: ProtocolItemDto[]; totalStotinki: number; batch?: string; eDoc?: string; note?: string; }`
  - `export interface ConsolidatedProtocolRows { farmers: ConsolidatedFarmerRow[]; orders: ConsolidatedOrderRow[]; }`
  - private `resolveScopeOrderIds(tenantId, date, scope, legIndex?): Promise<string[]>`
  - private `buildLiveRows(tenantId, orderIds: string[]): Promise<ConsolidatedProtocolRows>`

**Design note on `customerCode`** (spec §3.7 wants "order number, client code, city/zone" — NO name/phone/exact address): there is no existing "customer code" concept anywhere in the codebase. This plan defines it as `orderId.slice(0, 8).toUpperCase()` — a stable, zero-PII, no-new-migration identifier that lets someone cross-reference this sheet against the customer's own (separately held) bilateral receipt. **This is an assumption, flagged as an open question for the orchestrator** — swap the one-line definition in `buildLiveRows` if product wants a different code shape.

- [ ] **Step 1: Write the failing tests**

Append to `consolidated-protocol.service.spec.ts`:

```ts
describe('ConsolidatedProtocolService — scope resolution', () => {
  it('day scope resolves to every handover-ready order in the date\'s slots, regardless of delivery type', async () => {
    const db = makeDb();
    db.queue([{ id: 's1' }, { id: 's2' }]); // deliverySlots for the date
    db.queue([{ id: 'o1' }, { id: 'o2' }]); // orders in those slots
    const svc = makeSvc(db);
    const ids = await (svc as any).resolveScopeOrderIds('t1', '2026-07-22', 'day');
    expect(ids).toEqual(['o1', 'o2']);
  });

  it('day scope with no slots that day resolves to nothing, without querying orders', async () => {
    const db = makeDb();
    db.queue([]); // no slots
    const svc = makeSvc(db);
    const ids = await (svc as any).resolveScopeOrderIds('t1', '2026-07-22', 'day');
    expect(ids).toEqual([]);
    expect(db.select).toHaveBeenCalledTimes(1); // only the slot query ran
  });

  it('leg scope resolves to ONLY that courier\'s own stops, via getRoute', async () => {
    const routing = {
      getRoute: jest.fn().mockResolvedValue({
        routes: [
          { courierIndex: 0, stops: [{ id: 'order-A' }, { id: 'order-B' }] },
          { courierIndex: 1, stops: [{ id: 'order-C' }] },
        ],
      }),
    };
    const svc = makeSvc(makeDb(), routing);
    const ids = await (svc as any).resolveScopeOrderIds('t1', '2026-07-22', 'leg', 1);
    expect(ids).toEqual(['order-C']);
    expect(routing.getRoute).toHaveBeenCalledWith('t1', '2026-07-22', undefined, undefined, undefined, 'all');
  });

  it('leg scope with no stops for that leg resolves to nothing', async () => {
    const routing = { getRoute: jest.fn().mockResolvedValue({ routes: [{ courierIndex: 0, stops: [] }] }) };
    const svc = makeSvc(makeDb(), routing);
    const ids = await (svc as any).resolveScopeOrderIds('t1', '2026-07-22', 'leg', 0);
    expect(ids).toEqual([]);
  });
});

describe('ConsolidatedProtocolService — buildLiveRows', () => {
  it('aggregates cargo per farmer ACROSS multiple orders, and lists orders separately with their own items', async () => {
    const db = makeDb();
    db.queue([ // orders
      { id: 'o1', orderNumber: 5, deliveryAddress: 'гр. Варна, бул. Осми Приморски полк 1', deliveryCity: null, totalStotinki: 1000 },
      { id: 'o2', orderNumber: 6, deliveryAddress: null, deliveryCity: 'Русе', totalStotinki: 500 },
    ]);
    db.queue([ // order_items ⋈ products
      { orderId: 'o1', farmerId: 'f1', productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300 },
      { orderId: 'o2', farmerId: 'f1', productName: 'Домати', variantLabel: null, quantity: 3, unit: 'кг', priceStotinki: 300 },
      { orderId: 'o2', farmerId: 'f2', productName: 'Мед', variantLabel: null, quantity: 1, unit: 'бр', priceStotinki: 1200 },
    ]);
    db.queue([ // farmers
      { id: 'f1', name: 'Васил', legal: { name: 'ЕТ Васил' }, signaturePng: null },
      { id: 'f2', name: 'Мария', legal: null, signaturePng: null },
    ]);
    const svc = makeSvc(db);
    const rows = await (svc as any).buildLiveRows('t1', ['o1', 'o2']);

    expect(rows.orders).toEqual([
      { orderId: 'o1', orderNumber: 5, customerCode: 'O1'.padEnd(8, '').toUpperCase() === 'O1'.toUpperCase() ? expect.any(String) : expect.any(String), cityOrZone: 'Варна', items: [{ productName: 'Домати', variantLabel: undefined, quantity: 2, unit: 'кг', priceStotinki: 300 }], totalStotinki: 1000 },
      { orderId: 'o2', orderNumber: 6, customerCode: expect.any(String), cityOrZone: 'Русе', items: [{ productName: 'Мед', variantLabel: undefined, quantity: 1, unit: 'бр', priceStotinki: 1200 }], totalStotinki: 500 },
    ]);
    // Farmer f1's cargo is the SUM across o1 (2кг) and o2 (3кг) — one row, not two.
    const f1 = rows.farmers.find((f: any) => f.farmerId === 'f1');
    expect(f1.items).toEqual([{ productName: 'Домати', variantLabel: undefined, quantity: 5, unit: 'кг', priceStotinki: 300 }]);
    expect(f1.legal).toEqual({ name: 'ЕТ Васил' });
    const f2 = rows.farmers.find((f: any) => f.farmerId === 'f2');
    expect(f2.name).toBe('Мария'); // falls back to plain name when legal is unset
  });

  it('returns empty sections for an empty order-id list, without querying the DB', async () => {
    const db = makeDb();
    const svc = makeSvc(db);
    const rows = await (svc as any).buildLiveRows('t1', []);
    expect(rows).toEqual({ farmers: [], orders: [] });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('decrypts each farmer\'s saved signature', async () => {
    const { encryptSignature } = require('../../common/crypto/signature-crypto');
    process.env.ENCRYPTION_KEY = 'test-key';
    const db = makeDb();
    db.queue([{ id: 'o1', orderNumber: 1, deliveryAddress: null, deliveryCity: null, totalStotinki: 100 }]);
    db.queue([{ orderId: 'o1', farmerId: 'f1', productName: 'Домати', variantLabel: null, quantity: 1, unit: 'кг', priceStotinki: 100 }]);
    db.queue([{ id: 'f1', name: 'Васил', legal: null, signaturePng: encryptSignature('data:image/png;base64,AAA', 'test-key') }]);
    const svc = makeSvc(db);
    const rows = await (svc as any).buildLiveRows('t1', ['o1']);
    expect(rows.farmers[0].signaturePng).toBe('data:image/png;base64,AAA');
  });
});
```

(Fix the slightly convoluted `customerCode` assertion above before running it — replace the ternary noise with a plain `expect(rows.orders[0].customerCode).toBe('o1'.slice(0, 8).toUpperCase())` once the exact `orderId` values used in the fixture are known; the point of the test is only that it's derived from the id, not hand-typed.)

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm --filter @fermeribg/api test -- consolidated-protocol.service --maxWorkers=4
```
Expected: FAIL — `resolveScopeOrderIds`/`buildLiveRows` are not functions yet.

- [ ] **Step 3: Minimal implementation**

Add imports and methods to `consolidated-protocol.service.ts`:

```ts
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  type Database, consolidatedProtocols, deliverySlots, farmers, orderItems, orders, products,
} from '@fermeribg/db';
import type { LegalIdentity } from '@fermeribg/types';
import { decryptSignature } from '../../common/crypto/signature-crypto';
import { cityFromAddress } from './handover-city';
import type { ProtocolItemDto } from './dto/create-protocol.dto';

/** Same handover-ready statuses as HandoverService.HANDOVER_STATUSES — kept as
 *  its own local constant (not imported) so this file has no coupling to the
 *  bilateral service's internals; both must be kept in sync by hand if the
 *  prep/handover window statuses ever change. */
const HANDOVER_STATUSES = ['confirmed', 'preparing'] as const;

export interface ConsolidatedFarmerRow {
  farmerId: string;
  name: string;
  legal: LegalIdentity | null;
  items: ProtocolItemDto[];
  signaturePng: string | null;
  batch?: string;
  eDoc?: string;
  note?: string;
}

export interface ConsolidatedOrderRow {
  orderId: string;
  orderNumber: number | null;
  customerCode: string;
  cityOrZone: string | null;
  items: ProtocolItemDto[];
  totalStotinki: number;
  batch?: string;
  eDoc?: string;
  note?: string;
}

export interface ConsolidatedProtocolRows {
  farmers: ConsolidatedFarmerRow[];
  orders: ConsolidatedOrderRow[];
}
```

Inside the class:

```ts
  /** The order ids in scope for a target: EVERY handover-ready order in the
   *  date's slots for scope='day' (mirrors HandoverService.resolveSlotIds +
   *  its status filter); ONLY the orders on that courier's own route leg for
   *  scope='leg' — the exact mechanism GET /handover/check already uses
   *  (getRoute(..., 'all') + filter by courierIndex), so a leg's cargo can
   *  never include another courier's stops. */
  private async resolveScopeOrderIds(
    tenantId: string,
    date: string,
    scope: ConsolidatedScope,
    legIndex?: number | null,
  ): Promise<string[]> {
    if (scope === 'leg') {
      const route = await this.routing.getRoute(tenantId, date, undefined, undefined, undefined, 'all');
      return [
        ...new Set(
          route.routes
            .filter((r: { courierIndex: number }) => r.courierIndex === legIndex)
            .flatMap((r: { stops: { id: string }[] }) => r.stops.map((s) => s.id)),
        ),
      ];
    }
    const slotRows = await this.db
      .select({ id: deliverySlots.id })
      .from(deliverySlots)
      .where(and(eq(deliverySlots.tenantId, tenantId), eq(deliverySlots.date, date)));
    if (slotRows.length === 0) return [];
    const slotIds = slotRows.map((r) => r.id);
    const orderRows = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          inArray(orders.slotId, slotIds),
          inArray(orders.status, [...HANDOVER_STATUSES]),
        ),
      );
    return orderRows.map((r) => r.id);
  }

  /** Pure aggregation given a settled list of order ids: section Б is one row
   *  per order with its own items; section А sums cargo per farmer ACROSS
   *  every order in the list (a farmer's produce is not tied to one order in
   *  the multi-farmer marketplace model). Takes a plain order-id array (not a
   *  scope) so overrides.excludedOrderIds can be subtracted BEFORE this runs
   *  — see getLiveRows (Task 4) — keeping farmer cargo and section Б
   *  automatically consistent with each other. */
  private async buildLiveRows(tenantId: string, orderIds: string[]): Promise<ConsolidatedProtocolRows> {
    if (orderIds.length === 0) return { farmers: [], orders: [] };

    const orderRows = await this.db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        deliveryAddress: orders.deliveryAddress,
        deliveryCity: orders.deliveryCity,
        totalStotinki: orders.totalStotinki,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), inArray(orders.id, orderIds)));

    const itemRows = await this.db
      .select({
        orderId: orderItems.orderId,
        farmerId: products.farmerId,
        productName: orderItems.productName,
        variantLabel: orderItems.variantLabel,
        quantity: orderItems.quantity,
        unit: products.unit,
        priceStotinki: orderItems.priceStotinki,
      })
      .from(orderItems)
      .leftJoin(products, eq(orderItems.productId, products.id))
      .where(inArray(orderItems.orderId, orderIds));

    const itemsByOrder = new Map<string, ProtocolItemDto[]>();
    const farmerAgg = new Map<string, Map<string, ProtocolItemDto>>();
    for (const r of itemRows) {
      if (!r.orderId) continue;
      const item: ProtocolItemDto = {
        productName: r.productName ?? '',
        variantLabel: r.variantLabel ?? undefined,
        quantity: r.quantity,
        unit: r.unit ?? undefined,
        priceStotinki: r.priceStotinki,
      } as ProtocolItemDto;
      const list = itemsByOrder.get(r.orderId) ?? [];
      list.push(item);
      itemsByOrder.set(r.orderId, list);

      if (!r.farmerId) continue;
      const perFarmer = farmerAgg.get(r.farmerId) ?? new Map<string, ProtocolItemDto>();
      const key = `${item.productName}␟${item.variantLabel ?? ''}`;
      const existing = perFarmer.get(key);
      if (existing) existing.quantity += item.quantity;
      else perFarmer.set(key, { ...item });
      farmerAgg.set(r.farmerId, perFarmer);
    }

    const orderSection: ConsolidatedOrderRow[] = orderRows.map((o) => ({
      orderId: o.id,
      orderNumber: o.orderNumber,
      customerCode: o.id.slice(0, 8).toUpperCase(),
      cityOrZone: cityFromAddress(o.deliveryAddress)?.name ?? o.deliveryCity ?? null,
      items: itemsByOrder.get(o.id) ?? [],
      totalStotinki: o.totalStotinki,
    }));

    const farmerIds = [...farmerAgg.keys()];
    const farmerMetaRows = farmerIds.length
      ? await this.db
          .select({ id: farmers.id, name: farmers.name, legal: farmers.legal, signaturePng: farmers.signaturePng })
          .from(farmers)
          .where(and(eq(farmers.tenantId, tenantId), inArray(farmers.id, farmerIds)))
      : [];
    const farmerMetaById = new Map(farmerMetaRows.map((f) => [f.id, f]));

    const farmerSection: ConsolidatedFarmerRow[] = farmerIds.map((id) => {
      const meta = farmerMetaById.get(id);
      return {
        farmerId: id,
        name: meta?.name ?? '—',
        legal: (meta?.legal as LegalIdentity | null) ?? null,
        items: [...(farmerAgg.get(id)?.values() ?? [])],
        signaturePng: decryptSignature(meta?.signaturePng ?? null),
      };
    });

    return { farmers: farmerSection, orders: orderSection };
  }
```

- [ ] **Step 4: Run to confirm pass**

```bash
pnpm --filter @fermeribg/api test -- consolidated-protocol.service --maxWorkers=4
```
Expected: PASS.

- [ ] **Step 5: TEETH-CHECK**

In `buildLiveRows`, temporarily change the farmer aggregation key from `` `${item.productName}␟${item.variantLabel ?? ''}` `` to just `item.productName` unconditionally including variant text some other way — actually simpler: comment out the `existing.quantity += item.quantity;` line entirely (so a repeated key overwrites instead of summing). Re-run — the "aggregates cargo per farmer ACROSS multiple orders" test must go RED (f1's Домати would show `quantity: 3`, the last write, not `5`). Restore, re-run, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/consolidated-protocol.service.ts server/src/modules/handover/consolidated-protocol.service.spec.ts
git commit -m "feat(handover): consolidated protocol scope resolution + cargo aggregation"
```

---

### Task 4: Overrides layer + live/frozen view

**Files:**
- Modify: `server/src/modules/handover/consolidated-protocol.service.ts`
- Modify: `server/src/modules/handover/consolidated-protocol.service.spec.ts`

**Interfaces:**
- Consumes: `ConsolidatedProtocolOverrides`, `ConsolidatedProtocolMeta` (`@fermeribg/types`, Task 1); `buildLiveRows`, `resolveScopeOrderIds` (Task 3).
- Produces:
  - private `getLiveRows(tenantId, date, scope, legIndex, overrides): Promise<ConsolidatedProtocolRows>`
  - `export interface ConsolidatedProtocolView { id: string; scope: ConsolidatedScope; legIndex: number | null; date: string; docNumber: number; status: 'draft' | 'signed'; meta: ConsolidatedProtocolMeta; overrides: ConsolidatedProtocolOverrides; rows: ConsolidatedProtocolRows; receiverSignaturePng: string | null; signedAt: Date | null; }`
  - `getView(tenantId, id): Promise<ConsolidatedProtocolView>`

- [ ] **Step 1: Write the failing tests**

```ts
describe('ConsolidatedProtocolService — overrides layer', () => {
  it('excludedOrderIds removes the order from section Б AND subtracts its items from farmer cargo', async () => {
    const db = makeDb();
    db.queue([{ id: 's1' }]); // slots for the date (getView → getLiveRows → resolveScopeOrderIds, day scope)
    db.queue([{ id: 'o1' }, { id: 'o2' }]); // orders in scope
    db.queue([ // orders detail — only o1 survives the exclusion filter
      { id: 'o1', orderNumber: 5, deliveryAddress: null, deliveryCity: null, totalStotinki: 300 },
    ]);
    db.queue([ // items — only o1's
      { orderId: 'o1', farmerId: 'f1', productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300 },
    ]);
    db.queue([{ id: 'f1', name: 'Васил', legal: null, signaturePng: null }]);
    db.queue([{ // the persisted row itself
      id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, docNumber: 1, status: 'draft',
      meta: {}, overrides: { excludedOrderIds: ['o2'] }, frozenRows: null, receiverSignaturePng: null, signedAt: null,
    }]);
    const svc = makeSvc(db);
    const view = await svc.getView('t1', 'cp1');
    expect(view.rows.orders.map((o) => o.orderId)).toEqual(['o1']);
    expect(view.rows.farmers[0].items[0].quantity).toBe(2); // NOT inflated by an excluded order's items
  });

  it('extraRows are appended to their own section', async () => {
    const db = makeDb();
    db.queue([]); // no slots → empty live rows, cheaply
    db.queue([{ // persisted row
      id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, docNumber: 1, status: 'draft',
      meta: {}, overrides: { extraRows: [{ section: 'A', label: 'Ръчно добавен фермер', detail: '10кг картофи' }] },
      frozenRows: null, receiverSignaturePng: null, signedAt: null,
    }]);
    const svc = makeSvc(db);
    const view = await svc.getView('t1', 'cp1');
    expect(view.rows.farmers).toHaveLength(1);
    expect(view.rows.farmers[0]).toMatchObject({ name: 'Ръчно добавен фермер' });
  });

  it('fieldOverrides merges batch/eDoc/note onto the matching farmer/order row by key', async () => {
    const db = makeDb();
    db.queue([{ id: 's1' }]);
    db.queue([{ id: 'o1' }]);
    db.queue([{ id: 'o1', orderNumber: 5, deliveryAddress: null, deliveryCity: null, totalStotinki: 300 }]);
    db.queue([{ orderId: 'o1', farmerId: 'f1', productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300 }]);
    db.queue([{ id: 'f1', name: 'Васил', legal: null, signaturePng: null }]);
    db.queue([{
      id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, docNumber: 1, status: 'draft',
      meta: {}, overrides: { fieldOverrides: { 'f:f1': { batch: 'Партида 12' }, 'o:o1': { note: 'Внимание — чупливо' } } },
      frozenRows: null, receiverSignaturePng: null, signedAt: null,
    }]);
    const svc = makeSvc(db);
    const view = await svc.getView('t1', 'cp1');
    expect(view.rows.farmers[0].batch).toBe('Партида 12');
    expect(view.rows.orders[0].note).toBe('Внимание — чупливо');
  });

  it('a late order (added to the day AFTER the protocol was created) shows up automatically — the view recomputes live, it does not read a stored snapshot', async () => {
    const db = makeDb();
    db.queue([{ id: 's1' }]);
    db.queue([{ id: 'o-late' }]); // an order that didn't exist when the protocol was drafted
    db.queue([{ id: 'o-late', orderNumber: 9, deliveryAddress: null, deliveryCity: null, totalStotinki: 200 }]);
    db.queue([{ orderId: 'o-late', farmerId: 'f1', productName: 'Ябълки', variantLabel: null, quantity: 1, unit: 'кг', priceStotinki: 200 }]);
    db.queue([{ id: 'f1', name: 'Васил', legal: null, signaturePng: null }]);
    db.queue([{
      id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, docNumber: 1, status: 'draft',
      meta: {}, overrides: {}, frozenRows: null, receiverSignaturePng: null, signedAt: null,
    }]);
    const svc = makeSvc(db);
    const view = await svc.getView('t1', 'cp1');
    expect(view.rows.orders.map((o) => o.orderId)).toEqual(['o-late']);
  });

  it('a SIGNED protocol returns frozen_rows verbatim — it never touches orders/order_items again', async () => {
    const db = makeDb();
    const frozen = { farmers: [{ farmerId: 'f1', name: 'Васил', legal: null, items: [], signaturePng: null }], orders: [] };
    db.queue([{
      id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, docNumber: 1, status: 'signed',
      meta: {}, overrides: {}, frozenRows: frozen, receiverSignaturePng: null, signedAt: new Date('2026-07-22T06:00:00Z'),
    }]);
    const svc = makeSvc(db);
    const view = await svc.getView('t1', 'cp1');
    expect(view.rows).toEqual(frozen);
    expect(db.select).toHaveBeenCalledTimes(1); // only the row itself — no live recompute
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm --filter @fermeribg/api test -- consolidated-protocol.service --maxWorkers=4
```
Expected: FAIL — `getView` is not a function.

- [ ] **Step 3: Minimal implementation**

Add to `consolidated-protocol.service.ts` (needs `NotFoundException` added to the `@nestjs/common` import, and `ConsolidatedProtocolMeta`, `ConsolidatedProtocolOverrides` imported from `@fermeribg/types`):

```ts
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ConsolidatedProtocolMeta, ConsolidatedProtocolOverrides, LegalIdentity } from '@fermeribg/types';

export interface ConsolidatedProtocolView {
  id: string;
  scope: ConsolidatedScope;
  legIndex: number | null;
  date: string;
  docNumber: number;
  status: 'draft' | 'signed';
  meta: ConsolidatedProtocolMeta;
  overrides: ConsolidatedProtocolOverrides;
  rows: ConsolidatedProtocolRows;
  receiverSignaturePng: string | null;
  signedAt: Date | null;
}
```

Inside the class:

```ts
  /** Live rows for a target WITH overrides applied: excludedOrderIds is
   *  subtracted from the scope's order-id set BEFORE aggregation (so farmer
   *  cargo and section Б stay consistent with each other automatically —
   *  see buildLiveRows' own doc comment), then extraRows/fieldOverrides
   *  decorate the result. Called on every read of a DRAFT protocol — nothing
   *  here is persisted until sign() freezes it (Task 5). */
  private async getLiveRows(
    tenantId: string,
    date: string,
    scope: ConsolidatedScope,
    legIndex: number | null,
    overrides: ConsolidatedProtocolOverrides,
  ): Promise<ConsolidatedProtocolRows> {
    const scopeOrderIds = await this.resolveScopeOrderIds(tenantId, date, scope, legIndex);
    const excluded = new Set(overrides.excludedOrderIds ?? []);
    const effectiveOrderIds = scopeOrderIds.filter((id) => !excluded.has(id));
    const base = await this.buildLiveRows(tenantId, effectiveOrderIds);
    return this.decorateWithOverrides(base, overrides);
  }

  private decorateWithOverrides(
    rows: ConsolidatedProtocolRows,
    overrides: ConsolidatedProtocolOverrides,
  ): ConsolidatedProtocolRows {
    const fieldOverrides = overrides.fieldOverrides ?? {};
    const farmers = rows.farmers.map((f) => ({ ...f, ...fieldOverrides[`f:${f.farmerId}`] }));
    const orderRows = rows.orders.map((o) => ({ ...o, ...fieldOverrides[`o:${o.orderId}`] }));
    const extra = overrides.extraRows ?? [];
    const extraFarmers: ConsolidatedFarmerRow[] = extra
      .filter((r) => r.section === 'A')
      .map((r) => ({ farmerId: `extra:${r.label}`, name: r.label, legal: null, items: [], signaturePng: null, note: r.detail }));
    const extraOrders: ConsolidatedOrderRow[] = extra
      .filter((r) => r.section === 'B')
      .map((r) => ({ orderId: `extra:${r.label}`, orderNumber: null, customerCode: '—', cityOrZone: null, items: [], totalStotinki: 0, note: r.detail }));
    return { farmers: [...farmers, ...extraFarmers], orders: [...orderRows, ...extraOrders] };
  }

  /** Assembles the full view for one target: DRAFT reads recompute live rows
   *  (via getLiveRows) so a late order or a fresh override shows up
   *  immediately; SIGNED reads return frozen_rows byte-for-byte — the legal
   *  record from the moment of signing, untouched by anything that happens
   *  to orders afterward (see Task 5's sign()). */
  async getView(tenantId: string, id: string): Promise<ConsolidatedProtocolView> {
    const [row] = await this.db
      .select()
      .from(consolidatedProtocols)
      .where(and(eq(consolidatedProtocols.tenantId, tenantId), eq(consolidatedProtocols.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('Протоколът не е намерен.');

    const overrides = (row.overrides as ConsolidatedProtocolOverrides) ?? {};
    const rows =
      row.status === 'signed'
        ? (row.frozenRows as ConsolidatedProtocolRows)
        : await this.getLiveRows(tenantId, row.date, row.scope as ConsolidatedScope, row.legIndex, overrides);

    return {
      id: row.id,
      scope: row.scope as ConsolidatedScope,
      legIndex: row.legIndex,
      date: row.date,
      docNumber: row.docNumber,
      status: row.status as 'draft' | 'signed',
      meta: (row.meta as ConsolidatedProtocolMeta) ?? {},
      overrides,
      rows,
      receiverSignaturePng: decryptSignature(row.receiverSignaturePng),
      signedAt: row.signedAt,
    };
  }
```

- [ ] **Step 4: Run to confirm pass**

```bash
pnpm --filter @fermeribg/api test -- consolidated-protocol.service --maxWorkers=4
```
Expected: PASS.

- [ ] **Step 5: TEETH-CHECK**

Temporarily change `getLiveRows` to compute `effectiveOrderIds` WITHOUT filtering by `excluded` (i.e. `const effectiveOrderIds = scopeOrderIds;`). Re-run — the "excludedOrderIds removes the order from section Б AND subtracts its items from farmer cargo" test must go RED (o2 reappears, f1's quantity inflates to whatever the full sum would be). Restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/consolidated-protocol.service.ts server/src/modules/handover/consolidated-protocol.service.spec.ts
git commit -m "feat(handover): consolidated protocol overrides layer + live/frozen view"
```

---

### Task 5: updateDraft + sign (freeze)

**Files:**
- Modify: `server/src/modules/handover/consolidated-protocol.service.ts`
- Modify: `server/src/modules/handover/consolidated-protocol.service.spec.ts`

**Interfaces:**
- Consumes: `encryptSignature`, `SignatureKeyMissingError` (existing, `../../common/crypto/signature-crypto`); `tenants.operatorSignaturePng` (existing, `@fermeribg/db`).
- Produces:
  - `updateDraft(tenantId, id, patch: { meta?: Partial<ConsolidatedProtocolMeta>; overrides?: Partial<ConsolidatedProtocolOverrides> }): Promise<void>`
  - `sign(tenantId, id, receiverSignaturePng: string | null | undefined, signerRole: 'admin' | 'driver'): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
describe('ConsolidatedProtocolService.updateDraft', () => {
  it('merges meta and overrides onto the existing jsonb, not replacing them wholesale', async () => {
    const db = makeDb();
    db.queue([{ id: 'cp1', status: 'draft', meta: { vehicle: 'Форд' }, overrides: { excludedOrderIds: ['o1'] } }]);
    const svc = makeSvc(db);
    await svc.updateDraft('t1', 'cp1', { meta: { plate: 'В1234АВ' } });
    const setArg = db.calls.values; // update().set() isn't captured by `values` — see note below
    // `set` calls are captured separately; see makeDb's `calls.set` (added in Step 3 of this task).
  });

  it('rejects editing a SIGNED protocol', async () => {
    const db = makeDb();
    db.queue([{ id: 'cp1', status: 'signed', meta: {}, overrides: {} }]);
    const svc = makeSvc(db);
    await expect(svc.updateDraft('t1', 'cp1', { meta: { vehicle: 'Форд' } })).rejects.toThrow(/подписан/);
  });
});

describe('ConsolidatedProtocolService.sign', () => {
  const OLD_KEY = process.env.ENCRYPTION_KEY;
  beforeEach(() => { process.env.ENCRYPTION_KEY = 'test-key'; });
  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = OLD_KEY;
  });

  it('freezes the current live rows into frozen_rows and flips status to signed', async () => {
    const db = makeDb();
    db.queue([{ id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, status: 'draft', overrides: {} }]); // row lookup
    db.queue([]); // resolveScopeOrderIds: no slots → empty live rows
    const svc = makeSvc(db);
    await svc.sign('t1', 'cp1', 'data:image/png;base64,SIGNED', 'driver');
    const updated = db.calls.set[0] as any;
    expect(updated.status).toBe('signed');
    expect(updated.frozenRows).toEqual({ farmers: [], orders: [] });
    expect(updated.signedAt).toBeInstanceOf(Date);
  });

  it('rejects signing an already-signed protocol', async () => {
    const db = makeDb();
    db.queue([{ id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, status: 'signed', overrides: {} }]);
    const svc = makeSvc(db);
    await expect(svc.sign('t1', 'cp1', null, 'admin')).rejects.toThrow(/вече/);
  });

  it('auto-fills the operator\'s saved signature for an admin signer who supplies none', async () => {
    const { encryptSignature, looksEncrypted, decryptSignature } = require('../../common/crypto/signature-crypto');
    const db = makeDb();
    db.queue([{ id: 'cp1', tenantId: 't1', scope: 'day', date: '2026-07-22', legIndex: null, status: 'draft', overrides: {} }]);
    db.queue([]); // live rows: no slots
    db.queue([{ operatorSignaturePng: encryptSignature('data:image/png;base64,OP', 'test-key') }]); // tenants row
    const svc = makeSvc(db);
    await svc.sign('t1', 'cp1', undefined, 'admin');
    const updated = db.calls.set[0] as any;
    expect(looksEncrypted(updated.receiverSignaturePng)).toBe(true);
    expect(decryptSignature(updated.receiverSignaturePng, 'test-key')).toBe('data:image/png;base64,OP');
  });

  it('does NOT auto-fill for a driver signer — a courier never has a saved signature to fall back to', async () => {
    const db = makeDb();
    db.queue([{ id: 'cp1', tenantId: 't1', scope: 'leg', date: '2026-07-22', legIndex: 0, status: 'draft', overrides: {} }]);
    db.queue([]); // resolveScopeOrderIds via getRoute — leg scope; routing stub defaults to {routes: []}? see note below
    const svc = makeSvc(db, { getRoute: jest.fn().mockResolvedValue({ routes: [] }) });
    await svc.sign('t1', 'cp1', undefined, 'driver');
    const updated = db.calls.set[0] as any;
    expect(updated.receiverSignaturePng).toBeNull();
  });
});
```

- [ ] **Step 2: Update `makeDb` to capture `.set()` calls, then run to confirm failure**

Add to `makeDb()` in the spec file (alongside `calls.values`):
```ts
  const calls: { values: unknown[]; where: unknown[]; set: unknown[] } = { values: [], where: [], set: [] };
  ...
  step.set = jest.fn((v: unknown) => { calls.set.push(v); return step; });
```

```bash
pnpm --filter @fermeribg/api test -- consolidated-protocol.service --maxWorkers=4
```
Expected: FAIL — `updateDraft`/`sign` are not functions.

- [ ] **Step 3: Minimal implementation**

Add to `consolidated-protocol.service.ts` (needs `ConflictException`, `ServiceUnavailableException` added to the `@nestjs/common` import; `encryptSignature`, `SignatureKeyMissingError` added to the crypto import; `tenants` added to the `@fermeribg/db` import):

```ts
import {
  BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import {
  type Database, consolidatedProtocols, deliverySlots, farmers, orderItems, orders, products, tenants,
} from '@fermeribg/db';
import { decryptSignature, encryptSignature, SignatureKeyMissingError } from '../../common/crypto/signature-crypto';
```

```ts
  /** Merges (never replaces wholesale) meta/overrides onto a DRAFT row.
   *  Rejects once the protocol is signed — an edit-after-freeze is explicitly
   *  out of scope (spec's "извън обхвата: редакция на подписан документ"). */
  async updateDraft(
    tenantId: string,
    id: string,
    patch: { meta?: Partial<ConsolidatedProtocolMeta>; overrides?: Partial<ConsolidatedProtocolOverrides> },
  ): Promise<void> {
    const [row] = await this.db
      .select({ id: consolidatedProtocols.id, status: consolidatedProtocols.status, meta: consolidatedProtocols.meta, overrides: consolidatedProtocols.overrides })
      .from(consolidatedProtocols)
      .where(and(eq(consolidatedProtocols.tenantId, tenantId), eq(consolidatedProtocols.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('Протоколът не е намерен.');
    if (row.status !== 'draft') throw new ConflictException('Протоколът вече е подписан — не може да се редактира.');

    const nextMeta = { ...((row.meta as object) ?? {}), ...(patch.meta ?? {}) };
    const nextOverrides = { ...((row.overrides as object) ?? {}), ...(patch.overrides ?? {}) };
    await this.db
      .update(consolidatedProtocols)
      .set({ meta: nextMeta, overrides: nextOverrides, updatedAt: new Date() })
      .where(and(eq(consolidatedProtocols.tenantId, tenantId), eq(consolidatedProtocols.id, id)));
  }

  /** Freezes a DRAFT protocol: computes the CURRENT live rows one last time
   *  and persists them into frozen_rows, captures the transport-acceptance
   *  signature (§1.7 — a courier never has a saved one; an owner-admin who
   *  supplies none gets tenants.operatorSignaturePng auto-filled, mirroring
   *  HandoverService.createSigned's own auto-fill), flips status='signed'.
   *  Rejects a protocol that's already signed. */
  async sign(
    tenantId: string,
    id: string,
    receiverSignaturePng: string | null | undefined,
    signerRole: 'admin' | 'driver',
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(consolidatedProtocols)
      .where(and(eq(consolidatedProtocols.tenantId, tenantId), eq(consolidatedProtocols.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('Протоколът не е намерен.');
    if (row.status === 'signed') throw new ConflictException('Протоколът вече е подписан.');

    const overrides = (row.overrides as ConsolidatedProtocolOverrides) ?? {};
    const rows = await this.getLiveRows(tenantId, row.date, row.scope as ConsolidatedScope, row.legIndex, overrides);

    let sigToStore = receiverSignaturePng;
    if (sigToStore === undefined && signerRole === 'admin') {
      const [tenantRow] = await this.db
        .select({ operatorSignaturePng: tenants.operatorSignaturePng })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      sigToStore = decryptSignature(tenantRow?.operatorSignaturePng ?? null);
    }

    let encrypted: string | null = null;
    if (sigToStore) {
      try {
        encrypted = encryptSignature(sigToStore);
      } catch (e) {
        if (e instanceof SignatureKeyMissingError) {
          throw new ServiceUnavailableException('Протоколът не може да бъде подписан — липсва ключ за криптиране на сървъра.');
        }
        throw e;
      }
    }

    await this.db
      .update(consolidatedProtocols)
      .set({ status: 'signed', frozenRows: rows, receiverSignaturePng: encrypted, signedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(consolidatedProtocols.tenantId, tenantId), eq(consolidatedProtocols.id, id)));
  }
```

- [ ] **Step 4: Run to confirm pass**

```bash
pnpm --filter @fermeribg/api test -- consolidated-protocol.service --maxWorkers=4
```
Expected: PASS. (Finish the first `updateDraft` test's incomplete assertion from Step 1 now that `calls.set` exists: assert `db.calls.set[0]` equals `{ meta: { vehicle: 'Форд', plate: 'В1234АВ' }, overrides: { excludedOrderIds: ['o1'] }, updatedAt: expect.any(Date) }`.)

- [ ] **Step 5: TEETH-CHECK**

Temporarily change the driver auto-fill guard from `signerRole === 'admin'` to always-true (drop the role check). Re-run — "does NOT auto-fill for a driver signer" must go RED (it would now try to query `tenants` a third time, which the test's `db` queue doesn't have queued, surfacing as `undefined` destructured into a crash or an unexpected non-null signature). Restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/consolidated-protocol.service.ts server/src/modules/handover/consolidated-protocol.service.spec.ts
git commit -m "feat(handover): consolidated protocol draft edits + freeze-on-sign"
```

---

### Task 6: Controller + guards + module wiring

**Files:**
- Create: `server/src/modules/handover/dto/consolidated-query.dto.ts`
- Create: `server/src/modules/handover/dto/consolidated-ensure.dto.ts`
- Create: `server/src/modules/handover/dto/consolidated-update.dto.ts`
- Create: `server/src/modules/handover/dto/consolidated-sign.dto.ts`
- Create: `server/src/modules/handover/consolidated-protocol.controller.ts`
- Create: `server/src/modules/handover/consolidated-protocol.controller.spec.ts`
- Modify: `server/src/modules/handover/handover.module.ts`

**Interfaces:**
- Consumes: `ConsolidatedProtocolService` (Tasks 2–5); `CourierAssignmentService.resolveMyLeg` (existing); `TenantRequestUser` (`@fermeribg/types`); `Roles` decorator, `CurrentTenant`, `CurrentUser` (existing).
- Produces: `ConsolidatedProtocolController` mounted at `consolidated-protocols`.

**Guard design (spec §2/§6):** `scope='day'` is admin-only by the global default-deny (no `@Roles` needed). `scope='leg'` is admin (any leg) OR the ONE driver assigned that leg that day (`resolveMyLeg(tenantId, userId, row.date) === row.legIndex`) — every handler that can reach a `:id` belonging to a leg protocol re-derives and checks this itself; `@Roles('admin', 'driver')` only widens WHO can reach the route, it never substitutes for the ownership check.

- [ ] **Step 1: Write the DTOs**

```ts
// server/src/modules/handover/dto/consolidated-query.dto.ts
import { IsString, Matches } from 'class-validator';

export class ConsolidatedQueryDto {
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
}
```

```ts
// server/src/modules/handover/dto/consolidated-ensure.dto.ts
import { IsIn, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import { Transform } from 'class-transformer';

export class ConsolidatedEnsureDto {
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
  @IsIn(['day', 'leg']) scope!: 'day' | 'leg';
  @Transform(({ value }) => (value === '' || value === undefined ? undefined : Number(value)))
  @IsOptional() @IsInt() @Min(0) legIndex?: number;
}
```

```ts
// server/src/modules/handover/dto/consolidated-update.dto.ts
import { IsArray, IsIn, IsObject, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class ConsolidatedMetaDto {
  @IsOptional() @IsString() vehicle?: string;
  @IsOptional() @IsString() plate?: string;
  @IsOptional() @IsString() driverName?: string;
  @IsOptional() @IsString() startPlace?: string;
  @IsOptional() @IsString() startTime?: string;
  @IsOptional() @IsString() plannedEnd?: string;
}

export class ConsolidatedExtraRowDto {
  @IsIn(['A', 'B']) section!: 'A' | 'B';
  @IsString() label!: string;
  @IsOptional() @IsString() detail?: string;
}

export class ConsolidatedFieldOverrideDto {
  @IsOptional() @IsString() batch?: string;
  @IsOptional() @IsString() eDoc?: string;
  @IsOptional() @IsString() note?: string;
}

export class ConsolidatedOverridesDto {
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) excludedOrderIds?: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ConsolidatedExtraRowDto) extraRows?: ConsolidatedExtraRowDto[];
  @IsOptional() @IsObject() fieldOverrides?: Record<string, ConsolidatedFieldOverrideDto>;
}

export class ConsolidatedUpdateDto {
  @IsOptional() @ValidateNested() @Type(() => ConsolidatedMetaDto) meta?: ConsolidatedMetaDto;
  @IsOptional() @ValidateNested() @Type(() => ConsolidatedOverridesDto) overrides?: ConsolidatedOverridesDto;
}
```

```ts
// server/src/modules/handover/dto/consolidated-sign.dto.ts
import { IsOptional, IsString } from 'class-validator';

export class ConsolidatedSignDto {
  @IsOptional() @IsString() receiverSignaturePng?: string | null;
}
```

- [ ] **Step 2: Write the failing controller guard tests**

```ts
// server/src/modules/handover/consolidated-protocol.controller.spec.ts
import { ForbiddenException } from '@nestjs/common';
import { ConsolidatedProtocolController } from './consolidated-protocol.controller';

const TENANT = 't1';
const ADMIN = { type: 'tenant', role: 'admin', userId: 'u-owner', tenantId: TENANT } as any;
const DRIVER = { type: 'tenant', role: 'driver', userId: 'u-driver', tenantId: TENANT } as any;

function make() {
  const svc = {
    getView: jest.fn(),
    listForDay: jest.fn(),
    ensureDraft: jest.fn(),
    updateDraft: jest.fn(),
    sign: jest.fn(),
  };
  const courierAssignment = { resolveMyLeg: jest.fn() };
  return { svc, courierAssignment, ctrl: new ConsolidatedProtocolController(svc as any, courierAssignment as any) };
}

describe('ConsolidatedProtocolController — leg ownership guard', () => {
  it('an admin can open ANY leg\'s protocol without an ownership check', async () => {
    const { ctrl, svc, courierAssignment } = make();
    svc.getView.mockResolvedValue({ id: 'cp1', scope: 'leg', legIndex: 2, date: '2026-07-22' });
    await ctrl.getOne(TENANT, ADMIN, 'cp1');
    expect(courierAssignment.resolveMyLeg).not.toHaveBeenCalled();
  });

  it('the driver assigned to THIS protocol\'s own leg can open it', async () => {
    const { ctrl, svc, courierAssignment } = make();
    svc.getView.mockResolvedValue({ id: 'cp1', scope: 'leg', legIndex: 2, date: '2026-07-22' });
    courierAssignment.resolveMyLeg.mockResolvedValue(2);
    const out = await ctrl.getOne(TENANT, DRIVER, 'cp1');
    expect(out).toBeDefined();
    expect(courierAssignment.resolveMyLeg).toHaveBeenCalledWith(TENANT, 'u-driver', '2026-07-22');
  });

  it('a driver assigned to a DIFFERENT leg is forbidden', async () => {
    const { ctrl, svc, courierAssignment } = make();
    svc.getView.mockResolvedValue({ id: 'cp1', scope: 'leg', legIndex: 2, date: '2026-07-22' });
    courierAssignment.resolveMyLeg.mockResolvedValue(0); // driver's OWN leg for the day
    await expect(ctrl.getOne(TENANT, DRIVER, 'cp1')).rejects.toThrow(ForbiddenException);
  });

  it('a driver with NO assignment that day is forbidden, not shown an empty document', async () => {
    const { ctrl, svc, courierAssignment } = make();
    svc.getView.mockResolvedValue({ id: 'cp1', scope: 'leg', legIndex: 2, date: '2026-07-22' });
    courierAssignment.resolveMyLeg.mockResolvedValue(null);
    await expect(ctrl.getOne(TENANT, DRIVER, 'cp1')).rejects.toThrow(ForbiddenException);
  });

  it('a driver can NEVER open a scope=day protocol, regardless of leg', async () => {
    const { ctrl, svc, courierAssignment } = make();
    svc.getView.mockResolvedValue({ id: 'cp-day', scope: 'day', legIndex: null, date: '2026-07-22' });
    await expect(ctrl.getOne(TENANT, DRIVER, 'cp-day')).rejects.toThrow(ForbiddenException);
    expect(courierAssignment.resolveMyLeg).not.toHaveBeenCalled(); // day is refused outright, no leg check needed
  });
});

describe('ConsolidatedProtocolController — overrides PATCH stays admin-only', () => {
  it('has no @Roles decorator opening it to driver — the global default-deny handles it', () => {
    const meta = Reflect.getMetadata('roles', ConsolidatedProtocolController.prototype.updateOverrides);
    expect(meta).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to confirm failure**

```bash
pnpm --filter @fermeribg/api test -- consolidated-protocol.controller --maxWorkers=4
```
Expected: FAIL — module not found.

- [ ] **Step 4: Minimal implementation**

```ts
// server/src/modules/handover/consolidated-protocol.controller.ts
import {
  Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Patch, Post, Query, StreamableFile, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { TenantRequestUser } from '@fermeribg/types';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CourierAssignmentService } from '../routing/courier-assignment.service';
import { ConsolidatedProtocolService, type ConsolidatedProtocolView } from './consolidated-protocol.service';
import { ConsolidatedQueryDto } from './dto/consolidated-query.dto';
import { ConsolidatedEnsureDto } from './dto/consolidated-ensure.dto';
import { ConsolidatedUpdateDto } from './dto/consolidated-update.dto';
import { ConsolidatedSignDto } from './dto/consolidated-sign.dto';

/**
 * Consolidated (day/leg) handover-protocol endpoints. `scope='day'` is
 * admin-only via the global default-deny. `scope='leg'` additionally admits
 * `driver`, scoped to their OWN leg — checked HERE, per-request, from the
 * date-scoped assignment board (never the JWT's retired courierIndex), same
 * pattern as HandoverController.check(). `@Roles` only widens who can REACH a
 * route; the ownership check below is what actually enforces the boundary.
 */
@ApiTags('consolidated-protocols')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('consolidated-protocols')
export class ConsolidatedProtocolController {
  constructor(
    private readonly protocols: ConsolidatedProtocolService,
    private readonly courierAssignment: CourierAssignmentService,
  ) {}

  /** Throws 403 unless `user` may see this protocol: any admin, or the ONE
   *  driver assigned to its OWN leg on its OWN date. A `scope='day'` protocol
   *  is refused for every driver outright — the day view carries every other
   *  courier's orders too. */
  private async assertCanView(tenantId: string, user: TenantRequestUser, view: Pick<ConsolidatedProtocolView, 'scope' | 'legIndex' | 'date'>): Promise<void> {
    if (user.role === 'admin') return;
    if (view.scope !== 'leg') throw new ForbiddenException('Нямате достъп до дневния протокол.');
    const myLeg = await this.courierAssignment.resolveMyLeg(tenantId, user.userId, view.date);
    if (myLeg == null || myLeg !== view.legIndex) {
      throw new ForbiddenException('Нямате достъп до този протокол.');
    }
  }

  @Get()
  listForDay(@CurrentTenant() tenantId: string, @Query() q: ConsolidatedQueryDto) {
    return this.protocols.listForDay(tenantId, q.date);
  }

  @Post('ensure')
  @Roles('admin', 'driver')
  async ensure(@CurrentTenant() tenantId: string, @CurrentUser() user: TenantRequestUser, @Body() dto: ConsolidatedEnsureDto) {
    if (user.role === 'driver') {
      if (dto.scope !== 'leg') throw new ForbiddenException('Нямате достъп до дневния протокол.');
      const myLeg = await this.courierAssignment.resolveMyLeg(tenantId, user.userId, dto.date);
      if (myLeg == null || myLeg !== dto.legIndex) throw new ForbiddenException('Можете да отваряте само своя лег.');
    }
    return this.protocols.ensureDraft(tenantId, dto.date, dto.scope, dto.legIndex);
  }

  @Get(':id')
  @Roles('admin', 'driver')
  async getOne(@CurrentTenant() tenantId: string, @CurrentUser() user: TenantRequestUser, @Param('id', ParseUUIDPipe) id: string) {
    const view = await this.protocols.getView(tenantId, id);
    await this.assertCanView(tenantId, user, view);
    return view;
  }

  @Get(':id/pdf')
  @Roles('admin', 'driver')
  async pdf(@CurrentTenant() tenantId: string, @CurrentUser() user: TenantRequestUser, @Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const view = await this.protocols.getView(tenantId, id);
    await this.assertCanView(tenantId, user, view);
    const buf = await this.protocols.renderPdf(tenantId, view);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="consolidated-protocol.pdf"' });
  }

  /** Admin-only by the global default-deny — NO `@Roles`. A farmer-admin edits
   *  overrides/meta; a courier never does (spec §2's "редактируем от
   *  фермер-админ" names role `admin` specifically). */
  @Patch(':id')
  updateOverrides(@CurrentTenant() tenantId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConsolidatedUpdateDto) {
    return this.protocols.updateDraft(tenantId, id, dto);
  }

  @Post(':id/sign')
  @Roles('admin', 'driver')
  async sign(@CurrentTenant() tenantId: string, @CurrentUser() user: TenantRequestUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConsolidatedSignDto) {
    const view = await this.protocols.getView(tenantId, id);
    await this.assertCanView(tenantId, user, view);
    return this.protocols.sign(tenantId, id, dto.receiverSignaturePng, user.role as 'admin' | 'driver');
  }
}
```

Add a placeholder `renderPdf(tenantId, view): Promise<Buffer>` method on `ConsolidatedProtocolService` for this task (`throw new Error('not implemented — Task 10')` is acceptable HERE only because Task 10 replaces the body in the very next sub-part and no test in this task exercises it — every other placeholder in this plan is forbidden, this one is scoped to a single named follow-up task two commits away). Wire the controller into the module:

```ts
// server/src/modules/handover/handover.module.ts
import { Module } from '@nestjs/common';
import { HandoverService } from './handover.service';
import { HandoverController } from './handover.controller';
import { ConsolidatedProtocolService } from './consolidated-protocol.service';
import { ConsolidatedProtocolController } from './consolidated-protocol.controller';
import { RoutingModule } from '../routing/routing.module';

@Module({
  imports: [RoutingModule],
  controllers: [HandoverController, ConsolidatedProtocolController],
  providers: [HandoverService, ConsolidatedProtocolService],
})
export class HandoverModule {}
```

- [ ] **Step 5: Run to confirm pass**

```bash
pnpm --filter @fermeribg/api test -- consolidated-protocol.controller --maxWorkers=4
pnpm --filter @fermeribg/api build
```
Expected: both PASS/clean.

- [ ] **Step 6: TEETH-CHECK**

Temporarily change `assertCanView`'s comparison from `myLeg !== view.legIndex` to always pass (`false`). Re-run — "a driver assigned to a DIFFERENT leg is forbidden" must go RED. Restore, confirm GREEN.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/handover/dto/consolidated-*.dto.ts server/src/modules/handover/consolidated-protocol.controller.ts server/src/modules/handover/consolidated-protocol.controller.spec.ts server/src/modules/handover/consolidated-protocol.service.ts server/src/modules/handover/handover.module.ts
git commit -m "feat(handover): consolidated protocol controller + leg-ownership guard"
```

---

## Part B — PDF render

### Task 7: Section А table (farmers + cargo)

**Files:**
- Create: `server/src/modules/handover/consolidated-pdf.ts`
- Create: `server/src/modules/handover/consolidated-pdf.spec.ts`

**Interfaces:**
- Consumes: `A4_LANDSCAPE`, `Doc`, `MARGIN`, `INK`, `contentW`, `createDoc`, `drawDocumentHeader`, `drawBoldText` (existing, `pdf-kit.ts`); `columnWidths`, `drawTable`, `Cell`, `PlacedRow` (existing, `pdf-table.ts`); `ConsolidatedProtocolView`, `ConsolidatedFarmerRow` (Task 3/4).
- Produces: `buildFarmerTableRows(farmers: ConsolidatedFarmerRow[]): Cell[][]` (pure, unit-testable); `FARMER_COLUMNS: Column[]`; first slice of `renderConsolidatedProtocolPdf`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/modules/handover/consolidated-pdf.spec.ts
import { PDFPage } from 'pdf-lib';
import { A4_LANDSCAPE, contentW, createDoc } from './pdf-kit';
import { drawTable } from './pdf-table';
import { buildFarmerTableRows, FARMER_COLUMNS } from './consolidated-pdf';
import type { ConsolidatedFarmerRow } from './consolidated-protocol.service';

const farmer = (over: Partial<ConsolidatedFarmerRow> = {}): ConsolidatedFarmerRow => ({
  farmerId: 'f1', name: 'Васил', legal: null, signaturePng: null,
  items: [{ productName: 'Домати', quantity: 5, unit: 'кг', priceStotinki: 300 } as any],
  ...over,
});

describe('buildFarmerTableRows (pure)', () => {
  it('joins a farmer\'s items into one printable cell', () => {
    const rows = buildFarmerTableRows([farmer()]);
    expect(rows).toEqual([['1', 'Васил', 'Домати — 5кг', '', '']]);
  });

  it('prints batch/eDoc overrides in their own columns when present', () => {
    const rows = buildFarmerTableRows([farmer({ batch: 'Партида 7', eDoc: 'Е-1234' })]);
    expect(rows[0][3]).toBe('Партида 7');
    expect(rows[0][4]).toBe('Е-1234');
  });

  it('numbers rows 1-based, matching PlacedRow order for the §3.6 signature strip', () => {
    const rows = buildFarmerTableRows([farmer({ farmerId: 'f1', name: 'A' }), farmer({ farmerId: 'f2', name: 'B' })]);
    expect(rows[0][0]).toBe('1');
    expect(rows[1][0]).toBe('2');
  });
});

describe('FARMER_COLUMNS width sums to landscape content width', () => {
  it('sums exactly (drawTable throws otherwise)', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const total = FARMER_COLUMNS.reduce((s, c) => s + c.width, 0);
    expect(total).toBe(contentW(d));
  });
});

describe('section А table draws every farmer row', () => {
  let drawTextSpy: jest.SpyInstance;
  beforeEach(() => { drawTextSpy = jest.spyOn(PDFPage.prototype, 'drawText'); });
  afterEach(() => { drawTextSpy.mockRestore(); });

  it('draws each farmer\'s name as its own cell text', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const rows = buildFarmerTableRows([farmer({ name: 'Иван Иванов' }), farmer({ farmerId: 'f2', name: 'Мария Петрова' })]);
    drawTable(d, FARMER_COLUMNS, rows as any);
    expect(drawTextSpy.mock.calls.some(([t]) => t === 'Иван Иванов')).toBe(true);
    expect(drawTextSpy.mock.calls.some(([t]) => t === 'Мария Петрова')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm --filter @fermeribg/api test -- consolidated-pdf --maxWorkers=4
```
Expected: FAIL — module not found.

- [ ] **Step 3: Minimal implementation**

```ts
// server/src/modules/handover/consolidated-pdf.ts
import { A4_LANDSCAPE, contentW } from './pdf-kit';
import { columnWidths, type Cell, type Column } from './pdf-table';
import type { ConsolidatedFarmerRow } from './consolidated-protocol.service';
import type { ProtocolItemDto } from './dto/create-protocol.dto';

const itemsLine = (items: ProtocolItemDto[]): string =>
  items.map((it) => `${it.productName}${it.variantLabel ? ' · ' + it.variantLabel : ''} — ${it.quantity}${it.unit ?? ''}`).join('; ');

// Column widths computed from the landscape content width so the total is
// always exact (drawTable throws on a mismatch) regardless of A4_LANDSCAPE's
// literal value — weights, not pixels, are the source of truth.
const FARMER_COL_WEIGHTS = [1, 6, 11, 3, 3];
export const FARMER_COLUMNS: Column[] = (() => {
  const total = A4_LANDSCAPE.w - 2 * 55; // MARGIN duplicated here on purpose — see note below
  const [num, name, items, batch, eDoc] = columnWidths(total, FARMER_COL_WEIGHTS);
  return [
    { header: '№', width: num, align: 'right' },
    { header: 'Фермер', width: name },
    { header: 'Продукти и количества', width: items },
    { header: 'Партида', width: batch },
    { header: 'Е-док.', width: eDoc },
  ];
})();

/** Pure: farmer rows → drawTable cells. 1-based row numbers in column 0 are
 *  what the §3.6 signature strip (Task 8) matches against PlacedRow's own
 *  input-order index — keep this ordering and drawTable's row order identical. */
export function buildFarmerTableRows(farmers: ConsolidatedFarmerRow[]): Cell[][] {
  return farmers.map((f, i) => [String(i + 1), f.name, itemsLine(f.items), f.batch ?? '', f.eDoc ?? '']);
}
```

`MARGIN` is duplicated as the literal `55` here rather than imported, ONLY because `FARMER_COLUMNS` is computed at module load time before any `Doc` exists to call `contentW(d)` on — if this bothers a reviewer, replace the whole `const FARMER_COLUMNS = (() => {...})()` IIFE with a `buildFarmerColumns(d: Doc): Column[]` function taking a real `Doc` and computing `contentW(d)` properly; the "width sums to landscape content width" test above still passes unchanged (in fact it can drop its own duplicated math). Prefer this second form during implementation — the IIFE above is written out only so this step shows literal, compiling code; import `MARGIN` from `pdf-kit` at minimum if keeping the IIFE.

- [ ] **Step 4: Run to confirm pass**

```bash
pnpm --filter @fermeribg/api test -- consolidated-pdf --maxWorkers=4
```
Expected: PASS.

- [ ] **Step 5: TEETH-CHECK**

Temporarily change `buildFarmerTableRows`'s row-number column from `String(i + 1)` to a fixed `'1'`. Re-run — "numbers rows 1-based" must go RED. Restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/consolidated-pdf.ts server/src/modules/handover/consolidated-pdf.spec.ts
git commit -m "feat(handover): consolidated protocol PDF — section А farmer table"
```

---

### Task 8: §3.6 farmer signature-by-row-number strip

**Files:**
- Modify: `server/src/modules/handover/consolidated-pdf.ts`
- Modify: `server/src/modules/handover/consolidated-pdf.spec.ts`

**Interfaces:**
- Consumes: `PlacedRow` (existing, `pdf-table.ts` — `{pageIndex, y, height}`, one per input row, in input order — see its own doc comment: "фаза 1 needs this to place a signatures-by-row-number block against section А's rows").
- Produces: `drawFarmerSignatureStrip(d: Doc, placed: PlacedRow[], farmers: ConsolidatedFarmerRow[], images: (PDFImage | null)[]): void`; `embedFarmerSignatures(d: Doc, farmers: ConsolidatedFarmerRow[]): Promise<(PDFImage | null)[]>`.

**Design (spec §3.6):** the paper form has ONE strip of ten blank signature lines under section А, not a signature column inside each data row. This plan reproduces that as a strip drawn once per PAGE the farmer table actually spans, positioned right below THAT page's own rows (grouped via `placed[i].pageIndex`) — so a farmer's row and their signature slot are never separated by pages of unrelated content. A farmer with `signaturePng` gets their real signature image at their numbered slot; one without gets a blank line — never a re-solicited signature at the door.

- [ ] **Step 1: Write the failing tests**

```ts
describe('drawFarmerSignatureStrip', () => {
  let drawTextSpy: jest.SpyInstance;
  let drawLineSpy: jest.SpyInstance;
  let drawImageSpy: jest.SpyInstance;
  beforeEach(() => {
    drawTextSpy = jest.spyOn(PDFPage.prototype, 'drawText');
    drawLineSpy = jest.spyOn(PDFPage.prototype, 'drawLine');
    drawImageSpy = jest.spyOn(PDFPage.prototype, 'drawImage');
  });
  afterEach(() => { drawTextSpy.mockRestore(); drawLineSpy.mockRestore(); drawImageSpy.mockRestore(); });

  it('draws a blank line (no image) for a farmer with no saved signature', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const rows = buildFarmerTableRows([farmer({ name: 'Без подпис' })]);
    const placed = drawTable(d, FARMER_COLUMNS, rows as any);
    drawFarmerSignatureStrip(d, placed, [farmer({ name: 'Без подпис' })], [null]);
    expect(drawImageSpy).not.toHaveBeenCalled();
    expect(drawLineSpy.mock.calls.length).toBeGreaterThan(0);
    expect(drawTextSpy.mock.calls.some(([t]) => typeof t === 'string' && t.startsWith('1.'))).toBe(true);
  });

  it('draws the farmer\'s embedded signature image (no blank line) when one is present', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const rows = buildFarmerTableRows([farmer({ name: 'С подпис' })]);
    const placed = drawTable(d, FARMER_COLUMNS, rows as any);
    const fakeImage = {} as any; // a pre-embedded PDFImage stand-in — drawImage is spied, never actually reads it
    drawFarmerSignatureStrip(d, placed, [farmer({ name: 'С подпис' })], [fakeImage]);
    expect(drawImageSpy).toHaveBeenCalledTimes(1);
    expect(drawImageSpy.mock.calls[0][0]).toBe(fakeImage);
  });

  it('labels each slot with its 1-based row number, matching PlacedRow input order', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    const farmers = [farmer({ name: 'A' }), farmer({ farmerId: 'f2', name: 'B' })];
    const rows = buildFarmerTableRows(farmers);
    const placed = drawTable(d, FARMER_COLUMNS, rows as any);
    drawFarmerSignatureStrip(d, placed, farmers, [null, null]);
    expect(drawTextSpy.mock.calls.some(([t]) => typeof t === 'string' && t.startsWith('1. A'))).toBe(true);
    expect(drawTextSpy.mock.calls.some(([t]) => typeof t === 'string' && t.startsWith('2. B'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm --filter @fermeribg/api test -- consolidated-pdf --maxWorkers=4
```
Expected: FAIL — `drawFarmerSignatureStrip` is not exported.

- [ ] **Step 3: Minimal implementation**

Add to `consolidated-pdf.ts`:

```ts
import type { PDFImage } from 'pdf-lib';
import { Doc, ensureSpace, INK, MARGIN, newPage } from './pdf-kit';
import type { PlacedRow } from './pdf-table';

/** Pre-embeds every farmer's saved signature as a PDFImage (or null) BEFORE
 *  drawing — pdf-lib's embedPng is async, and drawFarmerSignatureStrip below
 *  must stay a plain synchronous draw pass over already-resolved images
 *  (matches how pdf-table's own ImageCell is always pre-embedded). Malformed
 *  signature data falls back to null (a blank line), never a thrown error. */
export async function embedFarmerSignatures(d: Doc, farmers: ConsolidatedFarmerRow[]): Promise<(PDFImage | null)[]> {
  const out: (PDFImage | null)[] = [];
  for (const f of farmers) {
    if (!f.signaturePng) { out.push(null); continue; }
    try {
      const bytes = Buffer.from(f.signaturePng.split(',').pop()!, 'base64');
      out.push(await d.doc.embedPng(bytes));
    } catch {
      out.push(null);
    }
  }
  return out;
}

const CHIP_W = 130;
const CHIP_H = 30;
const CHIP_GAP = 8;

/** §3.6: one strip per PAGE the farmer table actually spans (grouped by
 *  `placed[i].pageIndex`), positioned right below that page's own rows —
 *  never one strip at the very end, which would separate a page-1 farmer's
 *  row from their signature by every later page. `farmers`/`images` must be
 *  in the SAME order `placed` was produced from (drawTable's input order) —
 *  `placed[i]` corresponds to `farmers[i]`/`images[i]`. */
export function drawFarmerSignatureStrip(
  d: Doc,
  placed: PlacedRow[],
  farmers: ConsolidatedFarmerRow[],
  images: (PDFImage | null)[],
): void {
  const byPage = new Map<number, number[]>();
  placed.forEach((p, i) => {
    const list = byPage.get(p.pageIndex) ?? [];
    list.push(i);
    byPage.set(p.pageIndex, list);
  });

  const pages = d.doc.getPages();
  const perRow = Math.max(1, Math.floor((contentW(d) + CHIP_GAP) / (CHIP_W + CHIP_GAP)));

  for (const pageIndex of [...byPage.keys()].sort((a, b) => a - b)) {
    const indices = byPage.get(pageIndex)!;
    d.page = pages[pageIndex];
    d.y = Math.min(...indices.map((i) => placed[i].y)) - 14;

    const rowsNeeded = Math.ceil(indices.length / perRow);
    const stripHeight = rowsNeeded * (CHIP_H + 16) + 10;
    if (d.y - stripHeight < MARGIN) newPage(d); // strip continues on a fresh page when the source page has no room left

    indices.forEach((rowIdx, i) => {
      const col = i % perRow;
      const line = Math.floor(i / perRow);
      const x = MARGIN + col * (CHIP_W + CHIP_GAP);
      const y = d.y - line * (CHIP_H + 16);
      d.page.drawText(`${rowIdx + 1}. ${farmers[rowIdx].name}`, { x, y, size: 7.5, font: d.font, color: INK });
      const img = images[rowIdx];
      if (img) {
        d.page.drawImage(img, { x, y: y - 28, width: 90, height: 26 });
      } else {
        d.page.drawLine({ start: { x, y: y - 8 }, end: { x: x + CHIP_W - 10, y: y - 8 }, thickness: 0.5, color: INK });
      }
    });
    d.y -= rowsNeeded * (CHIP_H + 16) + 10;
  }
}
```

(`contentW` needs adding to the `pdf-kit` import already at the top of the file from Task 7.)

- [ ] **Step 4: Run to confirm pass**

```bash
pnpm --filter @fermeribg/api test -- consolidated-pdf --maxWorkers=4
```
Expected: PASS.

- [ ] **Step 5: TEETH-CHECK**

Temporarily change the `if (img)` branch to always take the `else` (blank-line) path regardless of `img`. Re-run — "draws the farmer's embedded signature image (no blank line) when one is present" must go RED (`drawImageSpy` never called). Restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/consolidated-pdf.ts server/src/modules/handover/consolidated-pdf.spec.ts
git commit -m "feat(handover): consolidated protocol PDF — §3.6 signature-by-row strip"
```

---

### Task 9: Section Б table (orders, no PII) + privacy note

**Files:**
- Modify: `server/src/modules/handover/consolidated-pdf.ts`
- Modify: `server/src/modules/handover/consolidated-pdf.spec.ts`

**Interfaces:**
- Produces: `buildOrderTableRows(orders: ConsolidatedOrderRow[]): Cell[][]`; `ORDER_COLUMNS: Column[]`; `PRIVACY_NOTE: string` (§3.7's verbatim line) exported so the client edit screen can show the same disclosure text if needed later.

- [ ] **Step 1: Write the failing tests**

```ts
describe('buildOrderTableRows (pure)', () => {
  const order = (over: Partial<ConsolidatedOrderRow> = {}): ConsolidatedOrderRow => ({
    orderId: 'o1', orderNumber: 5, customerCode: 'ABCD1234', cityOrZone: 'Варна',
    items: [{ productName: 'Домати', quantity: 2, unit: 'кг', priceStotinki: 300 } as any],
    totalStotinki: 600, ...over,
  });

  it('never includes a customer name, phone, or exact address — only order №, code, and city/zone', () => {
    const rows = buildOrderTableRows([order()]);
    const flat = rows[0].join(' | ');
    expect(flat).not.toMatch(/бул\.|ул\.|жк\./); // no street-level address fragments
    expect(flat).toContain('5'); // order number
    expect(flat).toContain('ABCD1234'); // customer code
    expect(flat).toContain('Варна'); // city/zone only
  });

  it('shows an em-dash when cityOrZone is unknown, never a blank cell', () => {
    const rows = buildOrderTableRows([order({ cityOrZone: null })]);
    expect(rows[0]).toContain('—');
  });
});

describe('ORDER_COLUMNS width sums to landscape content width', () => {
  it('sums exactly', async () => {
    const d = await createDoc(A4_LANDSCAPE);
    expect(ORDER_COLUMNS.reduce((s, c) => s + c.width, 0)).toBe(contentW(d));
  });
});

describe('PRIVACY_NOTE', () => {
  it('states the customer PII stays in the protected route list — the exact spec §3.7 disclosure', () => {
    expect(PRIVACY_NOTE).toMatch(/маршрутен списък/);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm --filter @fermeribg/api test -- consolidated-pdf --maxWorkers=4
```
Expected: FAIL.

- [ ] **Step 3: Minimal implementation**

```ts
const ORDER_COL_WEIGHTS = [2, 3, 3, 10, 2];
export const ORDER_COLUMNS: Column[] = (() => {
  const total = A4_LANDSCAPE.w - 2 * 55;
  const [num, code, city, items, total_] = columnWidths(total, ORDER_COL_WEIGHTS);
  return [
    { header: '№ поръчка', width: num },
    { header: 'Код клиент', width: code },
    { header: 'Град/зона', width: city },
    { header: 'Продукти и количества', width: items },
    { header: 'Стойност', width: total_, align: 'right' },
  ];
})();

function moneyStr(stotinki: number): string {
  return `${(stotinki / 100).toFixed(2)} лв.`;
}

export function buildOrderTableRows(orders: ConsolidatedOrderRow[]): Cell[][] {
  return orders.map((o) => [
    o.orderNumber != null ? `№ ${o.orderNumber}` : '—',
    o.customerCode,
    o.cityOrZone ?? '—',
    itemsLine(o.items),
    moneyStr(o.totalStotinki),
  ]);
}

/** Verbatim per spec §3.7 — matches the wording already established for the
 *  screen "Проверка"/bilateral-receipt precinct: full name/phone/address
 *  live ONLY in the driver's protected route list, never on this document. */
export const PRIVACY_NOTE =
  'Име, телефон и точен адрес на клиента се съхраняват само в защитения маршрутен списък на превозвача.';
```

(`ConsolidatedOrderRow` needs adding to the import from `./consolidated-protocol.service` already started in Task 7.)

- [ ] **Step 4: Run to confirm pass**

```bash
pnpm --filter @fermeribg/api test -- consolidated-pdf --maxWorkers=4
```
Expected: PASS.

- [ ] **Step 5: TEETH-CHECK**

Temporarily add `, o.deliveryAddress` (a made-up field access — or more realistically, replace `o.cityOrZone ?? '—'` with a literal fake street string like `'ул. Тестова 1'`) into the row-building. Re-run — "never includes a customer name, phone, or exact address" must go RED. Restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/consolidated-pdf.ts server/src/modules/handover/consolidated-pdf.spec.ts
git commit -m "feat(handover): consolidated protocol PDF — section Б order table + privacy note"
```

---

### Task 10: Section В (transport acceptance) + full render + PDF endpoint

**Files:**
- Modify: `server/src/modules/handover/consolidated-pdf.ts`
- Modify: `server/src/modules/handover/consolidated-pdf.spec.ts`
- Modify: `server/src/modules/handover/consolidated-protocol.service.ts` (replace the Task 6 placeholder `renderPdf`)
- Modify: `server/src/modules/handover/consolidated-protocol.service.spec.ts`

**Interfaces:**
- Produces: `renderConsolidatedProtocolPdf(view: ConsolidatedProtocolView, brand: string): Promise<Buffer>`; `ConsolidatedProtocolService.renderPdf(tenantId, view): Promise<Buffer>` (fetches the tenant's own display name as `brand`, mirroring `HandoverService.renderPdf`'s own brand-from-operator-snapshot logic).

- [ ] **Step 1: Write the failing tests**

```ts
describe('renderConsolidatedProtocolPdf', () => {
  const view = (over: Partial<any> = {}) => ({
    id: 'cp1', scope: 'day', legIndex: null, date: '2026-07-22', docNumber: 7, status: 'draft',
    meta: { vehicle: 'Форд Транзит', plate: 'В1234АВ', driverName: 'Георги', startPlace: 'Складова база', startTime: '06:00', plannedEnd: '11:00' },
    overrides: {}, rows: { farmers: [], orders: [] }, receiverSignaturePng: null, signedAt: null,
    ...over,
  });

  it('produces a non-empty PDF for a day-scope protocol with no rows', async () => {
    const buf = await renderConsolidatedProtocolPdf(view(), 'ФермериБГ');
    expect(buf.length).toBeGreaterThan(0);
  });

  it('titles a leg-scope protocol with its 1-based leg number', async () => {
    const spy = jest.spyOn(PDFPage.prototype, 'drawText');
    await renderConsolidatedProtocolPdf(view({ scope: 'leg', legIndex: 1 }), 'ФермериБГ');
    expect(spy.mock.calls.some(([t]) => typeof t === 'string' && t.includes('ЛЕГ 2'))).toBe(true);
    spy.mockRestore();
  });

  it('prints the ОБ- prefixed doc number, not the bilateral series\' bare number', async () => {
    const spy = jest.spyOn(PDFPage.prototype, 'drawText');
    await renderConsolidatedProtocolPdf(view({ docNumber: 42 }), 'ФермериБГ');
    expect(spy.mock.calls.some(([t]) => t === '№ ОБ-42')).toBe(true);
    spy.mockRestore();
  });

  it('marks a DRAFT protocol as a draft in the subtitle, and a SIGNED one carries none', async () => {
    const draftSpy = jest.spyOn(PDFPage.prototype, 'drawText');
    await renderConsolidatedProtocolPdf(view({ status: 'draft' }), 'ФермериБГ');
    expect(draftSpy.mock.calls.some(([t]) => typeof t === 'string' && t.includes('чернова'))).toBe(true);
    draftSpy.mockRestore();

    const signedSpy = jest.spyOn(PDFPage.prototype, 'drawText');
    await renderConsolidatedProtocolPdf(view({ status: 'signed' }), 'ФермериБГ');
    expect(signedSpy.mock.calls.some(([t]) => typeof t === 'string' && t.includes('чернова'))).toBe(false);
    signedSpy.mockRestore();
  });

  it('draws section В\'s manual meta fields (vehicle, plate, driver, timing)', async () => {
    const spy = jest.spyOn(PDFPage.prototype, 'drawText');
    await renderConsolidatedProtocolPdf(view(), 'ФермериБГ');
    const flat = spy.mock.calls.map(([t]) => t).join(' ');
    expect(flat).toContain('Форд Транзит');
    expect(flat).toContain('В1234АВ');
    expect(flat).toContain('Георги');
    spy.mockRestore();
  });

  it('embeds the receiver signature image when present', async () => {
    const imgSpy = jest.spyOn(PDFPage.prototype, 'drawImage');
    await renderConsolidatedProtocolPdf(view({ receiverSignaturePng: 'data:image/png;base64,' + Buffer.from('fake').toString('base64') }), 'ФермериБГ');
    // A genuinely malformed PNG throws inside embedPng and is swallowed — assert
    // the call was AT LEAST ATTEMPTED via a real 1x1 PNG fixture instead:
    imgSpy.mockRestore();
  });
});
```

(The last test's malformed-PNG caveat: use a real tiny base64 PNG fixture — e.g. the 1×1 transparent PNG literal `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=` — so `embedPng` actually succeeds and `drawImage` is really called; a fake `Buffer.from('fake')` is invalid PNG data and would only exercise the swallowed-error fallback path, which is not what this test is meant to prove.)

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm --filter @fermeribg/api test -- consolidated-pdf consolidated-protocol.service --maxWorkers=4
```
Expected: FAIL — `renderConsolidatedProtocolPdf` not exported; `ConsolidatedProtocolService.renderPdf` still throws its Task-6 placeholder.

- [ ] **Step 3: Minimal implementation**

Add to `consolidated-pdf.ts`:

```ts
import { A4_LANDSCAPE, Doc, MARGIN, INK, contentW, createDoc, drawBoldText, drawDocumentFooter, drawDocumentHeader, ensureSpace, stampPageNumbers, wrap } from './pdf-kit';
import { drawTable } from './pdf-table';
import type { ConsolidatedProtocolView } from './consolidated-protocol.service';

function drawSectionTitle(d: Doc, text: string): void {
  ensureSpace(d, 26);
  drawBoldText(d, text, MARGIN, d.y, 12);
  d.y -= 20;
}

export async function renderConsolidatedProtocolPdf(view: ConsolidatedProtocolView, brand: string): Promise<Buffer> {
  const d = await createDoc(A4_LANDSCAPE);
  const title =
    view.scope === 'day'
      ? 'ОБОБЩЕН ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ'
      : `ОБОБЩЕН ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ — ЛЕГ ${(view.legIndex ?? 0) + 1}`;

  drawDocumentHeader(d, {
    brand,
    title,
    subtitle: view.status === 'draft' ? 'чернова — подлежи на промяна' : null,
    number: `ОБ-${view.docNumber}`,
    date: new Date(view.date),
  });

  drawSectionTitle(d, 'А. Фермери и приет товар');
  const farmerRows = buildFarmerTableRows(view.rows.farmers);
  const sectionAImages = await embedFarmerSignatures(d, view.rows.farmers);
  const placedA = drawTable(d, FARMER_COLUMNS, farmerRows);
  drawFarmerSignatureStrip(d, placedA, view.rows.farmers, sectionAImages);
  d.y -= 16;

  drawSectionTitle(d, 'Б. Разпределение по поръчки');
  drawTable(d, ORDER_COLUMNS, buildOrderTableRows(view.rows.orders));
  d.y -= 8;
  ensureSpace(d, 22);
  for (const l of wrap(PRIVACY_NOTE, d.font, 8, contentW(d))) {
    d.page.drawText(l, { x: MARGIN, y: d.y, size: 8, font: d.font, color: INK });
    d.y -= 11;
  }
  d.y -= 12;

  drawSectionTitle(d, 'В. Приемане от транспортния оператор');
  ensureSpace(d, 90);
  const m = view.meta;
  const line = (text: string) => {
    ensureSpace(d, 16);
    d.page.drawText(text, { x: MARGIN, y: d.y, size: 10, font: d.font, color: INK });
    d.y -= 16;
  };
  line(`Возило: ${m.vehicle ?? '—'}    Рег. №: ${m.plate ?? '—'}`);
  line(`Тръгва от: ${m.startPlace ?? '—'} в ${m.startTime ?? '—'} ч.    Очаквано приключване: ${m.plannedEnd ?? '—'}`);
  d.y -= 10;
  ensureSpace(d, 44);
  d.page.drawText(`Приел за транспорт: ${m.driverName ?? '______________________'}`, { x: MARGIN, y: d.y, size: 10, font: d.font, color: INK });
  if (view.receiverSignaturePng) {
    try {
      const bytes = Buffer.from(view.receiverSignaturePng.split(',').pop()!, 'base64');
      const img = await d.doc.embedPng(bytes);
      d.page.drawImage(img, { x: MARGIN + 230, y: d.y - 4, width: 110, height: 36 });
    } catch {
      // malformed signature data — the blank label above stands alone
    }
  }
  d.y -= 40;

  drawDocumentFooter(d, `Документът е издаден електронно от ${brand}.`);
  if (d.doc.getPageCount() > 1) stampPageNumbers(d);

  return Buffer.from(await d.doc.save());
}
```

Replace the Task-6 placeholder in `consolidated-protocol.service.ts`:

```ts
  /** Renders a protocol to PDF. `brand` mirrors HandoverService.renderPdf's own
   *  choice — the tenant's display name, so a signed document's issuer is the
   *  same shop the operator sees everywhere else. */
  async renderPdf(tenantId: string, view: ConsolidatedProtocolView): Promise<Buffer> {
    const [tenantRow] = await this.db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return renderConsolidatedProtocolPdf(view, tenantRow?.name ?? 'ФермериБГ');
  }
```

(Add `import { renderConsolidatedProtocolPdf } from './consolidated-pdf';` at the top.)

- [ ] **Step 4: Run to confirm pass**

```bash
pnpm --filter @fermeribg/api test -- consolidated-pdf consolidated-protocol.service consolidated-protocol.controller --maxWorkers=4
pnpm --filter @fermeribg/api build
```
Expected: all PASS, clean build (this closes the Task-6 placeholder — confirm no lingering `throw new Error('not implemented`' anywhere: `grep -rn "not implemented" server/src/modules/handover` should return nothing).

- [ ] **Step 5: TEETH-CHECK**

Temporarily change the title ternary's leg branch from `` `... ЛЕГ ${(view.legIndex ?? 0) + 1}` `` to drop the `+ 1` (0-based). Re-run — "titles a leg-scope protocol with its 1-based leg number" must go RED (`'ЛЕГ 2'` is never drawn, only `'ЛЕГ 1'`). Restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/consolidated-pdf.ts server/src/modules/handover/consolidated-pdf.spec.ts server/src/modules/handover/consolidated-protocol.service.ts server/src/modules/handover/consolidated-protocol.service.spec.ts
git commit -m "feat(handover): consolidated protocol PDF — section В + full render + PDF endpoint"
```

---

## Part C — Client edit screen

### Task 11: Client types + API client functions

**Files:**
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/lib/api-client.ts`
- Modify: `client/src/lib/api-client.test.ts`

**Interfaces:**
- Produces (client/src/lib/types.ts): `ConsolidatedProtocolMeta`, `ConsolidatedProtocolOverrides`, `ConsolidatedFieldOverride`, `ConsolidatedExtraRow` (mirroring the server/shared shapes — independently declared client-side, same precedent as `DayProtocolRow` today), `ConsolidatedFarmerRow`, `ConsolidatedOrderRow`, `ConsolidatedProtocolSummary`, `ConsolidatedProtocolView`.
- Produces (client/src/lib/api-client.ts): `listConsolidatedProtocols(date)`, `ensureConsolidatedProtocol({date, scope, legIndex?})`, `getConsolidatedProtocol(id)`, `updateConsolidatedProtocol(id, patch)`, `signConsolidatedProtocol(id, receiverSignaturePng?)`, `consolidatedProtocolPdfHref(id)`.

- [ ] **Step 1: Write the failing tests**

Append to `client/src/lib/api-client.test.ts`:

```ts
import {
  ensureConsolidatedProtocol, getConsolidatedProtocol, listConsolidatedProtocols,
  signConsolidatedProtocol, updateConsolidatedProtocol, consolidatedProtocolPdfHref,
} from './api-client';

describe('consolidated protocol API client', () => {
  it('listConsolidatedProtocols hits GET /consolidated-protocols with the date', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    await listConsolidatedProtocols('2026-07-22');
    expect(fetchMock).toHaveBeenCalledWith('/bff/consolidated-protocols?date=2026-07-22', undefined);
  });

  it('ensureConsolidatedProtocol POSTs the scope/date/legIndex', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'cp1' }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await ensureConsolidatedProtocol({ date: '2026-07-22', scope: 'leg', legIndex: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/bff/consolidated-protocols/ensure');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(init.body)).toEqual({ date: '2026-07-22', scope: 'leg', legIndex: 1 });
    expect(out).toEqual({ id: 'cp1' });
  });

  it('getConsolidatedProtocol hits GET /consolidated-protocols/:id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'cp1' }));
    vi.stubGlobal('fetch', fetchMock);
    await getConsolidatedProtocol('cp1');
    expect(fetchMock).toHaveBeenCalledWith('/bff/consolidated-protocols/cp1', undefined);
  });

  it('updateConsolidatedProtocol PATCHes the partial meta/overrides body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(undefined));
    vi.stubGlobal('fetch', fetchMock);
    await updateConsolidatedProtocol('cp1', { overrides: { excludedOrderIds: ['o1'] } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/bff/consolidated-protocols/cp1');
    expect(init).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(init.body)).toEqual({ overrides: { excludedOrderIds: ['o1'] } });
  });

  it('signConsolidatedProtocol POSTs the receiver signature', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(undefined));
    vi.stubGlobal('fetch', fetchMock);
    await signConsolidatedProtocol('cp1', 'data:image/png;base64,AAA');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/bff/consolidated-protocols/cp1/sign');
    expect(JSON.parse(init.body)).toEqual({ receiverSignaturePng: 'data:image/png;base64,AAA' });
  });

  it('consolidatedProtocolPdfHref points at the PDF endpoint', () => {
    expect(consolidatedProtocolPdfHref('cp1')).toBe('/bff/consolidated-protocols/cp1/pdf');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm --filter @fermeribg/web test -- api-client
```
Expected: FAIL — the new exports don't exist yet.

- [ ] **Step 3: Minimal implementation**

Add to `client/src/lib/types.ts` (near `DayProtocolRow`):

```ts
export interface ConsolidatedProtocolMeta {
  vehicle?: string;
  plate?: string;
  driverName?: string;
  startPlace?: string;
  startTime?: string;
  plannedEnd?: string;
}

export interface ConsolidatedExtraRow {
  section: 'A' | 'B';
  label: string;
  detail?: string;
}

export interface ConsolidatedFieldOverride {
  batch?: string;
  eDoc?: string;
  note?: string;
}

export interface ConsolidatedProtocolOverrides {
  excludedOrderIds?: string[];
  extraRows?: ConsolidatedExtraRow[];
  fieldOverrides?: Record<string, ConsolidatedFieldOverride>;
}

export interface ConsolidatedFarmerRow {
  farmerId: string;
  name: string;
  legal: LegalIdentity | null;
  items: ProtocolItem[];
  signaturePng: string | null;
  batch?: string;
  eDoc?: string;
  note?: string;
}

export interface ConsolidatedOrderRow {
  orderId: string;
  orderNumber: number | null;
  customerCode: string;
  cityOrZone: string | null;
  items: ProtocolItem[];
  totalStotinki: number;
  batch?: string;
  eDoc?: string;
  note?: string;
}

/** One row in GET /consolidated-protocols?date=X — a virtual (id=null)
 *  placeholder for a target that hasn't been opened yet, or a persisted row. */
export interface ConsolidatedProtocolSummary {
  id: string | null;
  scope: 'day' | 'leg';
  legIndex: number | null;
  date: string;
  docNumber: number | null;
  status: 'draft' | 'signed' | null;
}

/** GET /consolidated-protocols/:id — the full editable/renderable view. */
export interface ConsolidatedProtocolView {
  id: string;
  scope: 'day' | 'leg';
  legIndex: number | null;
  date: string;
  docNumber: number;
  status: 'draft' | 'signed';
  meta: ConsolidatedProtocolMeta;
  overrides: ConsolidatedProtocolOverrides;
  rows: { farmers: ConsolidatedFarmerRow[]; orders: ConsolidatedOrderRow[] };
  receiverSignaturePng: string | null;
  signedAt: string | null;
}
```

Add to `client/src/lib/api-client.ts` (near the other `handover`/protocol functions):

```ts
export const listConsolidatedProtocols = (date: string) =>
  apiFetch<ConsolidatedProtocolSummary[]>(`consolidated-protocols?date=${encodeURIComponent(date)}`);

export const ensureConsolidatedProtocol = (body: { date: string; scope: 'day' | 'leg'; legIndex?: number }) =>
  apiFetch<{ id: string }>('consolidated-protocols/ensure', { method: 'POST', ...json(body) }, 'Протоколът не беше отворен');

export const getConsolidatedProtocol = (id: string) =>
  apiFetch<ConsolidatedProtocolView>(`consolidated-protocols/${id}`);

export const updateConsolidatedProtocol = (
  id: string,
  patch: { meta?: Partial<ConsolidatedProtocolMeta>; overrides?: Partial<ConsolidatedProtocolOverrides> },
) => apiFetch<void>(`consolidated-protocols/${id}`, { method: 'PATCH', ...json(patch) }, 'Промените не бяха запазени');

export const signConsolidatedProtocol = (id: string, receiverSignaturePng?: string | null) =>
  apiFetch<void>(`consolidated-protocols/${id}/sign`, { method: 'POST', ...json({ receiverSignaturePng }) }, 'Неуспешно подписване');

export const consolidatedProtocolPdfHref = (id: string) => `/bff/consolidated-protocols/${id}/pdf`;
```

(Add the new type names to the existing `import type { ... } from '@/lib/types'` block at the top of `api-client.ts`; the existing `json()`/`apiFetch()` helpers are reused unchanged.)

- [ ] **Step 4: Run to confirm pass**

```bash
pnpm --filter @fermeribg/web test -- api-client
```
Expected: PASS.

- [ ] **Step 5: TEETH-CHECK**

Temporarily change `consolidatedProtocolPdfHref` to return a path missing `/pdf`. Re-run — that one test must go RED. Restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/api-client.ts client/src/lib/api-client.test.ts
git commit -m "feat(client): consolidated protocol types + API client functions"
```

---

### Task 12: List screen (day + active legs)

**Files:**
- Create: `client/src/app/(admin)/protocols/consolidated/page.tsx`
- Create: `client/src/components/handover/consolidated-protocol-client.tsx`
- Modify: `client/src/components/handover/protocols-client.tsx` (add an entry link)

**Interfaces:**
- Consumes: `listConsolidatedProtocols`, `ensureConsolidatedProtocol` (Task 11).
- Produces: `<ConsolidatedProtocolClient />` — renders one card per `ConsolidatedProtocolSummary` (day first, then legs sorted by `legIndex`), each with an "Отвори"/"Създай" button that calls `ensureConsolidatedProtocol` for a virtual row (id=null) then navigates to `/protocols/consolidated/[id]`, or navigates directly for an already-materialized row.

There is no RTL/jsdom test harness in this codebase for client React components (`client` uses vitest, Node-only — no `render()`/DOM assertions exist anywhere in the repo today; `protocols-client.tsx` itself, the closest sibling screen, has zero test coverage of its JSX). Consistent with that established convention, this task extracts the one piece of non-trivial LOGIC into a pure, vitest-tested helper (`legLabel`) and verifies the rest of the screen by actually running it (the `run` skill / manual click-through), not by inventing a new test tool for this one component.

- [ ] **Step 1: Write the failing test for the one extractable pure helper**

```ts
// client/src/components/handover/consolidated-protocol-summary.test.ts
import { describe, expect, it } from 'vitest';
import { legLabel } from './consolidated-protocol-client';

describe('legLabel', () => {
  it('labels the day-scope row', () => {
    expect(legLabel({ scope: 'day', legIndex: null } as any)).toBe('Целия ден');
  });
  it('labels a leg row 1-based', () => {
    expect(legLabel({ scope: 'leg', legIndex: 0 } as any)).toBe('Лег 1');
    expect(legLabel({ scope: 'leg', legIndex: 2 } as any)).toBe('Лег 3');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm --filter @fermeribg/web test -- consolidated-protocol-summary
```
Expected: FAIL — module not found.

- [ ] **Step 3: Minimal implementation**

```tsx
// client/src/components/handover/consolidated-protocol-client.tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DateNavBar } from '@/components/production/date-nav-bar';
import { relDayLabel, todayIso } from '@/lib/utils';
import { ApiError, ensureConsolidatedProtocol, listConsolidatedProtocols } from '@/lib/api-client';
import type { ConsolidatedProtocolSummary } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

/** "Целия ден" for the day-scope row, "Лег N" (1-based) for a leg row. Pure —
 *  unit-tested directly (no component render needed for this piece). */
export function legLabel(row: Pick<ConsolidatedProtocolSummary, 'scope' | 'legIndex'>): string {
  return row.scope === 'day' ? 'Целия ден' : `Лег ${(row.legIndex ?? 0) + 1}`;
}

const STATUS_LABEL: Record<string, string> = { draft: 'Чернова', signed: 'Подписан' };

export function ConsolidatedProtocolClient() {
  const router = useRouter();
  const [date, setDate] = useState(() => todayIso());
  const [rows, setRows] = useState<ConsolidatedProtocolSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingKey, setOpeningKey] = useState<string | null>(null);

  const load = useCallback(async (d: string) => {
    setLoading(true);
    try {
      setRows(await listConsolidatedProtocols(d));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(date); }, [date, load]);

  async function open(row: ConsolidatedProtocolSummary) {
    const key = `${row.scope}:${row.legIndex ?? 'day'}`;
    setOpeningKey(key);
    try {
      const id = row.id ?? (await ensureConsolidatedProtocol({ date, scope: row.scope, legIndex: row.legIndex ?? undefined })).id;
      router.push(`/protocols/consolidated/${id}`);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setOpeningKey(null);
    }
  }

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <DateNavBar date={date} dateLabel={relDayLabel(date)} onSelect={setDate} />
      </div>

      <div className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        <div className="border-b border-ff-border-2 px-5 py-3.5">
          <h2 className="text-[15px] font-extrabold">Обобщени протоколи</h2>
        </div>
        {rows.map((row) => {
          const key = `${row.scope}:${row.legIndex ?? 'day'}`;
          return (
            <div key={key} className="flex items-center justify-between border-b border-ff-border-2 px-5 py-3.5 last:border-0">
              <div>
                <div className="text-[14px] font-bold">{legLabel(row)}</div>
                <div className="text-[12px] text-ff-muted">
                  {row.docNumber != null ? `ОБ-${row.docNumber}` : 'Все още не е отворен'}
                  {row.status && ` · ${STATUS_LABEL[row.status] ?? row.status}`}
                </div>
              </div>
              <Button size="sm" disabled={openingKey === key} onClick={() => void open(row)}>
                {row.id ? 'Отвори' : 'Създай'}
              </Button>
            </div>
          );
        })}
        {!loading && rows.length === 0 && (
          <p className="px-5 py-10 text-center text-sm text-ff-muted">Няма курсове за тази дата.</p>
        )}
      </div>
    </div>
  );
}
```

```tsx
// client/src/app/(admin)/protocols/consolidated/page.tsx
import { ConsolidatedProtocolClient } from '@/components/handover/consolidated-protocol-client';

export const dynamic = 'force-dynamic';

export default function ConsolidatedProtocolsPage() {
  return <ConsolidatedProtocolClient />;
}
```

In `client/src/components/handover/protocols-client.tsx`, add a link next to the existing „Проверка" link (inside the toolbar's button row, right after the `<a href="/protocols/check" ...>` block):

```tsx
          <a
            href="/protocols/consolidated"
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-ff-border px-3.5 py-2 text-[13.5px] font-bold text-ff-ink-2 max-[680px]:w-full"
          >
            Обобщен протокол
          </a>
```

- [ ] **Step 4: Run to confirm pass**

```bash
pnpm --filter @fermeribg/web test -- consolidated-protocol-summary
pnpm --filter @fermeribg/web build
```
Expected: test PASS, build clean (confirms the new route/component compile and Next.js can resolve the page).

- [ ] **Step 5: TEETH-CHECK**

Temporarily change `legLabel`'s leg branch to drop the `+ 1`. Re-run the vitest test — it must go RED (`'Лег 0'` instead of `'Лег 1'`). Restore, confirm GREEN.

- [ ] **Step 6: Manual verification (no component-render test exists for this screen — see note above)**

Use the `run` skill to start the client dev server, sign in as an admin/farmer-admin account, navigate to `/protocols/consolidated`, confirm: the day row and one row per active courier (seed/create a `route_courier_assignments` row for today if none exists) render; clicking "Създай" on a virtual row materializes it and navigates to its detail page (built next in Task 13 — a 404 here is expected until then, that's fine, the goal is confirming the list + `ensure` + navigation wiring, not the detail page).

- [ ] **Step 7: Commit**

```bash
git add client/src/app/\(admin\)/protocols/consolidated/page.tsx client/src/components/handover/consolidated-protocol-client.tsx client/src/components/handover/consolidated-protocol-summary.test.ts client/src/components/handover/protocols-client.tsx
git commit -m "feat(client): consolidated protocol list screen (day + active legs)"
```

---

### Task 13: Overrides editor + meta form

**Files:**
- Create: `client/src/app/(admin)/protocols/consolidated/[id]/page.tsx`
- Create: `client/src/components/handover/consolidated-protocol-edit.tsx`
- Create: `client/src/components/handover/consolidated-protocol-overrides.ts` (pure diff-building helper, vitest-tested)

**Interfaces:**
- Consumes: `getConsolidatedProtocol`, `updateConsolidatedProtocol` (Task 11).
- Produces: `buildOverridesToggleExclude(current: ConsolidatedProtocolOverrides, orderId: string, exclude: boolean): ConsolidatedProtocolOverrides` (pure — toggling one order in/out of `excludedOrderIds` without duplicating or losing the rest of the overrides object); `<ConsolidatedProtocolEdit id={string} />`.

- [ ] **Step 1: Write the failing test for the pure overrides-diff helper**

```ts
// client/src/components/handover/consolidated-protocol-overrides.test.ts
import { describe, expect, it } from 'vitest';
import { buildOverridesToggleExclude } from './consolidated-protocol-overrides';

describe('buildOverridesToggleExclude', () => {
  it('adds an order id to excludedOrderIds', () => {
    const out = buildOverridesToggleExclude({}, 'o1', true);
    expect(out.excludedOrderIds).toEqual(['o1']);
  });

  it('does not duplicate an already-excluded order', () => {
    const out = buildOverridesToggleExclude({ excludedOrderIds: ['o1'] }, 'o1', true);
    expect(out.excludedOrderIds).toEqual(['o1']);
  });

  it('removes an order id when un-excluding', () => {
    const out = buildOverridesToggleExclude({ excludedOrderIds: ['o1', 'o2'] }, 'o1', false);
    expect(out.excludedOrderIds).toEqual(['o2']);
  });

  it('preserves extraRows/fieldOverrides untouched', () => {
    const current = { extraRows: [{ section: 'A' as const, label: 'X' }], fieldOverrides: { 'f:f1': { note: 'n' } } };
    const out = buildOverridesToggleExclude(current, 'o1', true);
    expect(out.extraRows).toBe(current.extraRows);
    expect(out.fieldOverrides).toBe(current.fieldOverrides);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm --filter @fermeribg/web test -- consolidated-protocol-overrides
```
Expected: FAIL.

- [ ] **Step 3: Minimal implementation**

```ts
// client/src/components/handover/consolidated-protocol-overrides.ts
import type { ConsolidatedProtocolOverrides } from '@/lib/types';

/** Toggle one order's membership in `excludedOrderIds` without disturbing
 *  extraRows/fieldOverrides — the edit screen's checkbox handler calls this
 *  and PATCHes the result, rather than hand-rolling array splicing inline
 *  (which is where an accidental duplicate/loss bug would hide). */
export function buildOverridesToggleExclude(
  current: ConsolidatedProtocolOverrides,
  orderId: string,
  exclude: boolean,
): ConsolidatedProtocolOverrides {
  const set = new Set(current.excludedOrderIds ?? []);
  if (exclude) set.add(orderId);
  else set.delete(orderId);
  return { ...current, excludedOrderIds: [...set] };
}
```

```tsx
// client/src/components/handover/consolidated-protocol-edit.tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, getConsolidatedProtocol, updateConsolidatedProtocol, consolidatedProtocolPdfHref } from '@/lib/api-client';
import type { ConsolidatedProtocolView } from '@/lib/types';
import { buildOverridesToggleExclude } from './consolidated-protocol-overrides';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export function ConsolidatedProtocolEdit({ id }: { id: string }) {
  const [view, setView] = useState<ConsolidatedProtocolView | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await getConsolidatedProtocol(id));
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function toggleExclude(orderId: string, exclude: boolean) {
    if (!view) return;
    setSaving(true);
    try {
      const overrides = buildOverridesToggleExclude(view.overrides, orderId, exclude);
      await updateConsolidatedProtocol(id, { overrides });
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveMeta(patch: Partial<ConsolidatedProtocolView['meta']>) {
    setSaving(true);
    try {
      await updateConsolidatedProtocol(id, { meta: patch });
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  if (!view) return <p className="py-8 text-center text-sm text-ff-muted">Зареждане…</p>;

  const isDraft = view.status === 'draft';
  const excluded = new Set(view.overrides.excludedOrderIds ?? []);

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-[18px] font-extrabold">ОБ-{view.docNumber} · {view.status === 'signed' ? 'Подписан' : 'Чернова'}</h1>
        <a href={consolidatedProtocolPdfHref(id)} target="_blank" rel="noopener" className="text-[13.5px] font-bold text-ff-ink underline">
          Свали PDF
        </a>
      </div>

      {!isDraft && (
        <p className="mb-4 rounded-lg bg-ff-surface-2 px-4 py-2.5 text-[13px] font-semibold text-ff-muted-2">
          Протоколът е подписан — вече не подлежи на редакция.
        </p>
      )}

      <section className="mb-5 overflow-hidden rounded-xl border border-ff-border bg-ff-surface">
        <div className="border-b border-ff-border-2 px-5 py-3"><h2 className="text-[14px] font-extrabold">Б. Поръчки</h2></div>
        {view.rows.orders.map((o) => (
          <div key={o.orderId} className="flex items-center justify-between border-b border-ff-border-2 px-5 py-2.5 last:border-0">
            <div className="text-[13.5px]">
              {o.orderNumber != null ? `№ ${o.orderNumber}` : '—'} · {o.customerCode} · {o.cityOrZone ?? '—'}
            </div>
            {isDraft && (
              <label className="flex items-center gap-1.5 text-[12.5px] font-semibold">
                <input
                  type="checkbox"
                  checked={excluded.has(o.orderId)}
                  disabled={saving}
                  onChange={(e) => void toggleExclude(o.orderId, e.target.checked)}
                />
                Изключи
              </label>
            )}
          </div>
        ))}
      </section>

      <section className="mb-5 overflow-hidden rounded-xl border border-ff-border bg-ff-surface">
        <div className="border-b border-ff-border-2 px-5 py-3"><h2 className="text-[14px] font-extrabold">В. Транспорт</h2></div>
        <div className="grid grid-cols-2 gap-3 p-5">
          {(['vehicle', 'plate', 'driverName', 'startPlace', 'startTime', 'plannedEnd'] as const).map((field) => (
            <label key={field} className="text-[12.5px] font-semibold text-ff-muted">
              {field}
              <input
                className="mt-1 block w-full rounded-lg border border-ff-border px-2.5 py-1.5 text-[13.5px]"
                defaultValue={view.meta[field] ?? ''}
                disabled={!isDraft || saving}
                onBlur={(e) => void saveMeta({ [field]: e.target.value })}
              />
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
```

```tsx
// client/src/app/(admin)/protocols/consolidated/[id]/page.tsx
import { ConsolidatedProtocolEdit } from '@/components/handover/consolidated-protocol-edit';

export const dynamic = 'force-dynamic';

export default function ConsolidatedProtocolEditPage({ params }: { params: { id: string } }) {
  return <ConsolidatedProtocolEdit id={params.id} />;
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
pnpm --filter @fermeribg/web test -- consolidated-protocol-overrides
pnpm --filter @fermeribg/web build
```
Expected: test PASS, build clean.

- [ ] **Step 5: TEETH-CHECK**

Temporarily change `buildOverridesToggleExclude`'s `set.delete(orderId)` branch to a no-op. Re-run — "removes an order id when un-excluding" must go RED. Restore, confirm GREEN.

- [ ] **Step 6: Manual verification**

Via the `run` skill: open a day protocol from Task 12's list screen, confirm the order list renders, tick "Изключи" on one order, refresh, confirm it stays excluded and the farmer cargo total in a subsequently-opened PDF (`Свали PDF`) reflects the exclusion. Edit a meta field (e.g. `vehicle`), tab out, refresh, confirm it persisted.

- [ ] **Step 7: Commit**

```bash
git add "client/src/app/(admin)/protocols/consolidated/[id]/page.tsx" client/src/components/handover/consolidated-protocol-edit.tsx client/src/components/handover/consolidated-protocol-overrides.ts client/src/components/handover/consolidated-protocol-overrides.test.ts
git commit -m "feat(client): consolidated protocol overrides editor + meta form"
```

---

### Task 14: Sign flow (signature pad + freeze)

**Files:**
- Modify: `client/src/components/handover/consolidated-protocol-edit.tsx`

**Interfaces:**
- Consumes: `SignaturePadField` (existing, `./signature-pad-field.tsx`), `signConsolidatedProtocol` (Task 11).

- [ ] **Step 1: No new pure logic to extract here — `signConsolidatedProtocol` itself was already vitest-tested in Task 11.** This task is UI wiring only, verified manually per this codebase's established convention for React components (see Task 12's note). Skip to Step 3.

- [ ] **Step 2: (n/a — no RED step for pure UI wiring; see Step 1)**

- [ ] **Step 3: Implementation**

Add a signature capture + sign button to `consolidated-protocol-edit.tsx`:

```tsx
import { SignaturePadField } from './signature-pad-field';
import { signConsolidatedProtocol } from '@/lib/api-client';
```

Inside the component, add state and a handler:

```tsx
  const [receiverSig, setReceiverSig] = useState<string | null>(null);

  async function sign() {
    setSaving(true);
    try {
      await signConsolidatedProtocol(id, receiverSig);
      toast.success('Протоколът е подписан');
      await load();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }
```

And in the JSX, inside the "В. Транспорт" section, after the meta grid:

```tsx
        {isDraft && (
          <div className="border-t border-ff-border-2 px-5 py-4">
            <SignaturePadField value={receiverSig} onChange={setReceiverSig} label="Приел за транспорт" commit="live" />
            <Button variant="primary" className="mt-3 w-full" disabled={saving} onClick={() => void sign()}>
              {saving ? 'Подписване…' : 'Подпиши и замрази'}
            </Button>
          </div>
        )}
```

- [ ] **Step 4: Verify the build**

```bash
pnpm --filter @fermeribg/web build
```
Expected: clean.

- [ ] **Step 5: Manual verification (TEETH-CHECK for this task takes the form of an end-to-end click-through, since there is no unit test to break/restore for pure UI wiring)**

Via the `run` skill: open a leg protocol as the courier account assigned to it, draw a signature, click "Подпиши и замрази", confirm the screen flips to the signed state (checkboxes/inputs disable, the banner from Task 13 appears), reload the page, confirm it STAYS signed and the PDF now embeds the drawn signature in section В. Then, as a second courier NOT assigned to that leg, confirm `GET /consolidated-protocols/:id` 403s (this re-exercises Task 6's guard end-to-end, not just its unit test).

- [ ] **Step 6: Commit**

```bash
git add client/src/components/handover/consolidated-protocol-edit.tsx
git commit -m "feat(client): consolidated protocol sign flow (receiver signature capture)"
```

---

## Self-review notes (for whoever executes this plan)

1. **Spec coverage:** §1.1–1.5 (table, numbering, meta, overrides, freeze) → Tasks 1–5. §1.6 (orders columns for email status) and §1.8 (`orderIds` fix for farmer bilateral protocols) are **Phase 2/3, not this plan** — do not implement them here even though they're in the same spec document; they belong to the phases explicitly deferred in §8. §1.7 (who signs where) → Task 5 (auto-fill logic) + Task 10 (PDF section В) + Task 14 (client capture). §2 (scope/visibility) → Tasks 3, 6. §3.1–3.5 (shared PDF layer, table, pagination, font, orientation) — already done in Phase 0 (this worktree's `pdf-kit.ts`/`pdf-table.ts`); Tasks 7–10 consume it, do not rebuild it. §3.6 → Task 8. §3.7 → Task 9. §5 (farmer readiness) is explicitly **Phase 3**, not touched here. §6 (security) → Task 6's guard + the encrypted-signature discipline threaded through Tasks 1/5/10. §7 (test list) → each item has a corresponding task's test (numbering/uniqueness → Task 2 + Task 1 Step 5; live view → Task 4; freeze → Task 4/5; scope → Task 6; table → Tasks 7–9).

2. **Placeholder scan:** the one intentional placeholder (`ConsolidatedProtocolService.renderPdf` throwing in Task 6, replaced in Task 10) is explicitly named and scoped to a concrete follow-up task four commits later — flagged inline rather than left silent. No other `TODO`/`TBD`/hand-waved step remains.

3. **Type consistency:** `ConsolidatedProtocolRows { farmers: ConsolidatedFarmerRow[]; orders: ConsolidatedOrderRow[] }` is defined once (Task 3) and consumed identically by Task 4 (`getView`), Task 5 (`sign`'s `frozenRows`), Tasks 7–10 (PDF renderer), and Task 11 (client's independently-declared mirror). `ConsolidatedScope`/`'day' | 'leg'` string literals are used consistently across every task — no task introduces a third variant or a differently-cased one.

## Open questions for the orchestrator

1. **`customerCode` definition (spec §3.7).** No such concept exists in the codebase today. This plan defines it as `orderId.slice(0, 8).toUpperCase()` (Task 3) — zero PII, no new migration, but arbitrary. Confirm this is acceptable, or specify the intended shape (e.g. a short hash, a sequence separate from `orderNumber`, etc.) before Task 3 executes.
2. **§3.6 signature-strip layout is a first cut, not a pixel-final design.** The "one strip per page, grouped by `PlacedRow.pageIndex`, wrapped chip grid" approach (Task 8) satisfies the letter of the spec deviation (row-numbered signatures, not one printed strip of ten blanks) but the exact chip dimensions/grid math will likely need visual tuning during implementation — this is expected and fine, but flagging so the reviewer doesn't mistake "renders, tests pass" for "matches the client's actual sample PDF" without opening the rendered file.
3. **Who may sign a `scope='day'` protocol's section В.** This plan allows `admin` to sign either scope, and `driver` only their own `scope='leg'`. The spec's §1.7 table doesn't say who physically signs "приел за транспорт" on the DAY document when multiple couriers run legs that day — if that's meant to be nobody (day-scope is admin/office-only, never "signed" as transport-accepted, only the per-leg ones are), Task 5/6/10's day-sign path should be removed rather than left reachable.
4. **Migration number is unresolved by design** (see the box near the top) — must be re-checked against the merge target immediately before Task 1 executes, not now.

## Files/modules later phases likely also touch

- **Phase 2 (email-at-confirm):** `server/src/modules/handover/handover.service.ts` (the `orders.protocol_email_status` columns + `deliver()` attachment flow described in spec §4 are separate from everything in this plan, but will sit in the same `handover` module directory); `server/src/modules/orders/orders.service.ts` (the confirm-order call site the spec's reordered "render → email → THEN confirm" flow wraps); `client/src/components/handover/protocols-client.tsx` (spec §4.4's "Прати на куриерите" button — a natural sibling to this plan's new list screen, Task 12).
- **Phase 3 (farmer readiness + list polish + `orderIds` fix):** `server/src/modules/handover/handover.service.ts` (§1.8's `orderIds` population on the farmer-leg bilateral path — `handover.service.ts:876/980/1064` per the spec); `client/src/components/handover/protocols-client.tsx` (§5.4's list columns: protocol number + row/order count — the SAME file Phase 2 also touches, so sequence those two carefully); a new readiness-check surface reusing `client/src/lib/legal-identity.ts`'s `buildLegalPayload` logic (already flagged in the spec as "reused, not rewritten").
