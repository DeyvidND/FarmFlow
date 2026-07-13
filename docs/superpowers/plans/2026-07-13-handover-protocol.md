# Приемо-предавателни протоколи — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate legally-adequate goods-handover documents for own delivery — a farmer→operator pickup protocol and an operator→customer delivery receipt — signed on-screen or batch-printed for wet signature, rendered as immutable server PDFs.

**Architecture:** One `handover_protocols` table + one NestJS `handover` module drive both document kinds via a `kind` discriminator. A protocol freezes snapshots of both parties (farmer `farmers.legal`, operator tenant `settings.legal`, customer from the order) and the item lines, then renders deterministically with pdf-lib (Cyrillic TTF via fontkit). Batch print reuses the existing `mergePdfs` helper. The admin (Next.js, mobile-first) captures signatures on a raw `<canvas>` or prints the day's protocols.

**Tech Stack:** NestJS + Drizzle (Postgres), `pdf-lib` + `@pdf-lib/fontkit`, Next.js admin client, Jest (server) with the repo's FIFO Drizzle mock harness.

## Global Constraints

- Money is integer **stotinki** everywhere (no floats). Copied from the codebase convention.
- Next migration number is **`0103`**; append journal entry `idx: 101`, `tag: "0103_handover_protocols"`. The journal must have no idx gap.
- DB access: `@Inject(DB_TOKEN) private readonly db: Database` from `../../common/drizzle/drizzle.constants`; tables/`Database` type from `@fermeribg/db`.
- Tenancy: every endpoint `@UseGuards(JwtAuthGuard)`, gated to operator/admin via `@Roles(...)`, scoped with `@CurrentTenant() tenantId: string`; every query filters on `tenant_id`.
- Service specs use the repo's FIFO `makeDb()` thenable mock + `Test.createTestingModule({ providers: [Svc, { provide: DB_TOKEN, useValue: db }] })` (see `server/src/modules/vendor-finance/commission.service.spec.ts`).
- UI copy in Bulgarian.
- **Immutability:** a row with `status='signed'` is never updated (except the one allowed `pending`→`signed` paper transition, which only sets status/sign_mode/signed_at).
- **Out of scope (do NOT build):** fiscal receipt (Наредба Н-18); prepaid/Stripe and courier variants; automated email; КЕП.

---

## File Structure

- `packages/db/src/schema.ts` — add `handoverProtocols` pgTable (near `orders`).
- `packages/db/drizzle/0103_handover_protocols.sql` — CREATE TABLE + indexes.
- `packages/db/drizzle/meta/_journal.json` — append idx 101.
- `packages/types/…` (or wherever `PublicFarmer`/legal types live) — add a shared `LegalIdentity` type + tenant `settings.legal` typing. (Confirm the types package path; `farmers.legal`'s inline type is the shape to mirror.)
- `server/src/modules/handover/handover.module.ts`
- `server/src/modules/handover/handover.service.ts`
- `server/src/modules/handover/handover.service.spec.ts`
- `server/src/modules/handover/handover.controller.ts`
- `server/src/modules/handover/handover.controller.spec.ts`
- `server/src/modules/handover/handover-pdf.ts`
- `server/src/modules/handover/handover-pdf.spec.ts`
- `server/src/modules/handover/dto/create-protocol.dto.ts`
- `server/src/modules/handover/dto/draft-query.dto.ts`
- `server/src/modules/handover/dto/batch.dto.ts`
- `server/src/assets/fonts/DejaVuSans.ttf` — bundled Cyrillic font.
- `server/src/app.module.ts` — register `HandoverModule`.
- Frontend files — see Frontend section (paths from client exploration).

---

## Task 1: Schema + migration for `handover_protocols`

**Files:**
- Modify: `packages/db/src/schema.ts` (add table + export)
- Create: `packages/db/drizzle/0103_handover_protocols.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `handoverProtocols` table export from `@fermeribg/db`; columns per the spec.

- [ ] **Step 1: Add the table to `schema.ts`** (place after the `orderItems` table, ~line 528)

```ts
export const handoverProtocols = pgTable(
  'handover_protocols',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    // 'farmer_to_operator' | 'operator_to_customer'
    kind: text('kind').notNull(),
    farmerId: uuid('farmer_id').references(() => farmers.id, { onDelete: 'set null' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    slotId: uuid('slot_id').references(() => deliverySlots.id, { onDelete: 'set null' }),
    protocolNumber: integer('protocol_number'),
    fromSnapshot: jsonb('from_snapshot').notNull(),
    toSnapshot: jsonb('to_snapshot').notNull(),
    items: jsonb('items').notNull(),
    orderIds: uuid('order_ids').array(),
    totalStotinki: integer('total_stotinki').notNull().default(0),
    fromSignaturePng: text('from_signature_png'),
    toSignaturePng: text('to_signature_png'),
    // 'digital' | 'paper' | 'pending'
    signMode: text('sign_mode').notNull().default('pending'),
    meta: jsonb('meta'),
    // 'draft' | 'signed'
    status: text('status').notNull().default('draft'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    tenantCreatedIdx: index('handover_tenant_created_idx').on(t.tenantId, t.createdAt, t.id),
    tenantNumberUnique: uniqueIndex('handover_tenant_number_unique').on(t.tenantId, t.protocolNumber),
    farmerIdx: index('handover_farmer_idx').on(t.farmerId),
    orderIdx: index('handover_order_idx').on(t.orderId),
  }),
);
```

Then add `handoverProtocols` to the barrel export list at the bottom of `schema.ts` (the same list that already exports `orderItems`).

- [ ] **Step 2: Create the migration SQL** `packages/db/drizzle/0103_handover_protocols.sql`

```sql
-- Goods handover documents for own delivery: farmer→operator pickup protocol and
-- operator→customer delivery receipt, one table discriminated by `kind`. Snapshots freeze
-- both parties' legal/identity and the item lines at signing so a later edit can't mutate a
-- signed record; the PDF is regenerated deterministically from the row. `protocol_number` is
-- a per-tenant human sequence (like orders.order_number). NOT a fiscal receipt (Наредба Н-18).
CREATE TABLE IF NOT EXISTS "handover_protocols" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "tenant_id" uuid REFERENCES "tenants"("id"),
  "kind" text NOT NULL,
  "farmer_id" uuid REFERENCES "farmers"("id") ON DELETE SET NULL,
  "order_id" uuid REFERENCES "orders"("id") ON DELETE SET NULL,
  "slot_id" uuid REFERENCES "delivery_slots"("id") ON DELETE SET NULL,
  "protocol_number" integer,
  "from_snapshot" jsonb NOT NULL,
  "to_snapshot" jsonb NOT NULL,
  "items" jsonb NOT NULL,
  "order_ids" uuid[],
  "total_stotinki" integer NOT NULL DEFAULT 0,
  "from_signature_png" text,
  "to_signature_png" text,
  "sign_mode" text NOT NULL DEFAULT 'pending',
  "meta" jsonb,
  "status" text NOT NULL DEFAULT 'draft',
  "signed_at" timestamp with time zone,
  "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "handover_tenant_created_idx" ON "handover_protocols" ("tenant_id","created_at","id");
CREATE UNIQUE INDEX IF NOT EXISTS "handover_tenant_number_unique" ON "handover_protocols" ("tenant_id","protocol_number");
CREATE INDEX IF NOT EXISTS "handover_farmer_idx" ON "handover_protocols" ("farmer_id");
CREATE INDEX IF NOT EXISTS "handover_order_idx" ON "handover_protocols" ("order_id");
```

- [ ] **Step 3: Append the journal entry** to `packages/db/drizzle/meta/_journal.json` — add after the `0102_farmer_geo` object (mind the comma):

```json
    {
      "idx": 101,
      "version": "7",
      "when": 1784000000000,
      "tag": "0103_handover_protocols",
      "breakpoints": true
    }
```

- [ ] **Step 4: Build the db package + verify migration applies**

Run: `pnpm --filter @fermeribg/db build` then bring up the server against a scratch DB (or the repo's test DB script) and confirm the migrator runs `0103` with no journal-gap error.
Expected: server boots; `handover_protocols` exists.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0103_handover_protocols.sql packages/db/drizzle/meta/_journal.json
git commit -m "feat(db): handover_protocols table + migration 0103"
```

---

## Task 2: Shared `LegalIdentity` type + tenant `settings.legal`

**Files:**
- Modify: the types package where `farmers.legal`'s shape is declared (confirm path — likely `packages/types`), add an exported `LegalIdentity`.
- Modify: the tenant settings type to include `legal?: LegalIdentity`.
- Test: `server/src/modules/handover/legal.util.spec.ts`
- Create: `server/src/modules/handover/legal.util.ts`

**Interfaces:**
- Produces:
  - `type LegalIdentity = { kind?: 'individual'|'sole_trader'|'company'; name?: string; eik?: string; vatNumber?: string; address?: string; regNo?: string; confirmedAt?: string }`
  - `requireLegal(l: LegalIdentity | null | undefined, who: string): LegalIdentity` — throws `BadRequestException` if `name` missing.

- [ ] **Step 1: Write the failing test** `legal.util.spec.ts`

```ts
import { BadRequestException } from '@nestjs/common';
import { requireLegal } from './legal.util';

describe('requireLegal', () => {
  it('returns the identity when name is present', () => {
    const l = { kind: 'sole_trader' as const, name: 'ЕТ Васил', eik: '203912345' };
    expect(requireLegal(l, 'фермер')).toBe(l);
  });
  it('throws when null', () => {
    expect(() => requireLegal(null, 'фермер')).toThrow(BadRequestException);
  });
  it('throws when name is blank', () => {
    expect(() => requireLegal({ name: '  ' }, 'оператор')).toThrow(/оператор/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test -- legal.util`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `legal.util.ts`**

```ts
import { BadRequestException } from '@nestjs/common';

export interface LegalIdentity {
  kind?: 'individual' | 'sole_trader' | 'company';
  name?: string;
  eik?: string;
  vatNumber?: string;
  address?: string;
  regNo?: string;
  confirmedAt?: string;
}

/** Guard: a protocol party must have at least a legal name. `who` is used in the error. */
export function requireLegal(l: LegalIdentity | null | undefined, who: string): LegalIdentity {
  if (!l || !l.name || !l.name.trim()) {
    throw new BadRequestException(`Липсват легални данни за ${who}.`);
  }
  return l;
}
```

- [ ] **Step 4: Add `legal?: LegalIdentity` to the tenant settings type** and export `LegalIdentity` from the shared types package so both `farmers.legal` and `tenants.settings.legal` reference one shape. (Follow the existing `settings.vendorFinance` typing precedent.)

- [ ] **Step 5: Run test to verify it passes + commit**

Run: `pnpm --filter server test -- legal.util`
Expected: PASS.

```bash
git add server/src/modules/handover/legal.util.ts server/src/modules/handover/legal.util.spec.ts packages/types
git commit -m "feat(handover): shared LegalIdentity + requireLegal guard, tenant settings.legal"
```

---

## Task 3: DTOs + module scaffold

**Files:**
- Create: `server/src/modules/handover/dto/draft-query.dto.ts`, `dto/create-protocol.dto.ts`, `dto/batch.dto.ts`
- Create: `server/src/modules/handover/handover.module.ts`
- Modify: `server/src/app.module.ts` (register module)

**Interfaces:**
- Produces:
  - `DraftQueryDto { kind: 'farmer_to_operator'|'operator_to_customer'; farmerId?: string; orderId?: string; slotId?: string }`
  - `ProtocolItemDto { productName: string; variantLabel?: string; quantity: number; unit?: string; priceStotinki: number; orderNumber?: number }`
  - `CreateProtocolDto { kind; farmerId?; orderId?; slotId?; items: ProtocolItemDto[]; fromSignaturePng?: string; toSignaturePng?: string; meta?: Record<string, unknown> }`
  - `BatchDto { slotId?: string; date?: string }`

- [ ] **Step 1: Write the DTOs** using `class-validator`, following the repo's DTO style (see `orders/dto/*`). Empty-string→undefined transform where optional (repo gotcha: `@IsOptional` does not stop `''`; use `@Transform(({value}) => value === '' ? undefined : value)`).

```ts
// dto/draft-query.dto.ts
import { IsIn, IsOptional, IsUUID } from 'class-validator';
export class DraftQueryDto {
  @IsIn(['farmer_to_operator', 'operator_to_customer']) kind!: string;
  @IsOptional() @IsUUID() farmerId?: string;
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @IsUUID() slotId?: string;
}
```

```ts
// dto/create-protocol.dto.ts
import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Min, ValidateNested } from 'class-validator';

export class ProtocolItemDto {
  @IsString() productName!: string;
  @IsOptional() @IsString() variantLabel?: string;
  @IsInt() @Min(1) quantity!: number;
  @IsOptional() @IsString() unit?: string;
  @IsInt() @Min(0) priceStotinki!: number;
  @IsOptional() @IsInt() orderNumber?: number;
}

export class CreateProtocolDto {
  @IsIn(['farmer_to_operator', 'operator_to_customer']) kind!: string;
  @IsOptional() @IsUUID() farmerId?: string;
  @IsOptional() @IsUUID() orderId?: string;
  @IsOptional() @IsUUID() slotId?: string;
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => ProtocolItemDto)
  items!: ProtocolItemDto[];
  @IsOptional() @IsString() fromSignaturePng?: string;
  @IsOptional() @IsString() toSignaturePng?: string;
  @IsOptional() meta?: Record<string, unknown>;
}
```

```ts
// dto/batch.dto.ts
import { IsOptional, IsString, IsUUID } from 'class-validator';
export class BatchDto {
  @IsOptional() @IsUUID() slotId?: string;
  @IsOptional() @IsString() date?: string; // YYYY-MM-DD (Europe/Sofia)
}
```

- [ ] **Step 2: Scaffold the module** `handover.module.ts` (imports DB provider module the same way peer modules do; wires `HandoverService`, `HandoverController`). Register in `app.module.ts` imports array.

- [ ] **Step 3: Build to verify it compiles**

Run: `pnpm --filter server build`
Expected: no TS errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/handover/dto server/src/modules/handover/handover.module.ts server/src/app.module.ts
git commit -m "feat(handover): DTOs + module scaffold"
```

---

## Task 4: Service — farmer-leg draft aggregation

**Files:**
- Create: `server/src/modules/handover/handover.service.ts`
- Test: `server/src/modules/handover/handover.service.spec.ts`

**Interfaces:**
- Consumes: `Database`/`DB_TOKEN`, `requireLegal`, tables `orders, orderItems, products, farmers, tenants`.
- Produces: `buildDraft(tenantId, q: DraftQueryDto): Promise<{ kind; from: LegalIdentity; to: LegalIdentity | CustomerParty; items: ProtocolItemDto[]; total: number }>` — this task implements only the `farmer_to_operator` branch.

- [ ] **Step 1: Write the failing test** (uses the FIFO `makeDb()` harness — copy the harness from `commission.service.spec.ts`)

```ts
// handover.service.spec.ts (harness copied from commission.service.spec.ts: makeDb/build)
describe('HandoverService.buildDraft farmer_to_operator', () => {
  it('aggregates one farmer\'s items across the slot and freezes both legal parties', async () => {
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор', eik: '111' } }]);            // tenant settings.legal
    db.queue([{ id: 'f1', legal: { name: 'ЕТ Васил', eik: '203912345' } }]); // farmer
    db.queue([                                                                // order_items ⋈ products
      { productName: 'Домати', variantLabel: null, quantity: 2, unit: 'кг', priceStotinki: 300, orderNumber: 5 },
      { productName: 'Домати', variantLabel: null, quantity: 3, unit: 'кг', priceStotinki: 300, orderNumber: 7 },
      { productName: 'Краставици', variantLabel: null, quantity: 1, unit: 'бр', priceStotinki: 120, orderNumber: 5 },
    ]);
    const svc = await build(db);
    const draft = await svc.buildDraft('t1', { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1' });
    expect(draft.from).toEqual({ name: 'ЕТ Васил', eik: '203912345' });
    expect(draft.to).toEqual({ name: 'ЕТ Оператор', eik: '111' });
    expect(draft.items).toEqual([
      { productName: 'Домати', variantLabel: undefined, quantity: 5, unit: 'кг', priceStotinki: 300, orderNumber: undefined },
      { productName: 'Краставици', variantLabel: undefined, quantity: 1, unit: 'бр', priceStotinki: 120, orderNumber: undefined },
    ]);
    expect(draft.total).toBe(5 * 300 + 1 * 120);
  });

  it('throws 400 when the farmer has no legal identity', async () => {
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]); // tenant ok
    db.queue([{ id: 'f1', legal: null }]);          // farmer missing
    const svc = await build(db);
    await expect(svc.buildDraft('t1', { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1' }))
      .rejects.toThrow(/фермер/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test -- handover.service`
Expected: FAIL (method/class missing).

- [ ] **Step 3: Implement `buildDraft` (farmer branch)** — load tenant `settings.legal`, load farmer `legal`, `requireLegal` both; query `orderItems ⋈ products` where `products.farmerId=:farmerId` and the parent orders belong to the tenant + slot + status in (`confirmed`,`preparing`); group in JS by `(productName, variantLabel)`, sum `quantity`, keep first `unit`/`priceStotinki`; compute `total = Σ quantity*priceStotinki`. Return `{ kind, from: farmerLegal, to: operatorLegal, items, total }`. Normalize `null`→`undefined` on optional item fields.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter server test -- handover.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/handover/handover.service.ts server/src/modules/handover/handover.service.spec.ts
git commit -m "feat(handover): farmer-leg draft aggregation"
```

---

## Task 5: Service — customer-leg draft

**Files:**
- Modify: `handover.service.ts`, `handover.service.spec.ts`

**Interfaces:**
- Produces: `CustomerParty = { name?: string; phone?: string; address?: string }`; `buildDraft` now also handles `operator_to_customer`.

- [ ] **Step 1: Write the failing test**

```ts
describe('HandoverService.buildDraft operator_to_customer', () => {
  it('uses the order items + customer identity; total is the COD amount', async () => {
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]); // tenant settings.legal
    db.queue([{ id: 'o9', customerName: 'Иван Петров', customerPhone: '0888', deliveryAddress: 'ул. Роза 1', totalStotinki: 720 }]); // order
    db.queue([
      { productName: 'Домати', variantLabel: null, quantity: 2, priceStotinki: 300 },
      { productName: 'Краставици', variantLabel: null, quantity: 1, priceStotinki: 120 },
    ]); // order_items
    const svc = await build(db);
    const draft = await svc.buildDraft('t1', { kind: 'operator_to_customer', orderId: 'o9' });
    expect(draft.from).toEqual({ name: 'ЕТ Оператор' });
    expect(draft.to).toEqual({ name: 'Иван Петров', phone: '0888', address: 'ул. Роза 1' });
    expect(draft.items.map((i) => i.quantity)).toEqual([2, 1]);
    expect(draft.total).toBe(720);
  });
});
```

- [ ] **Step 2: Run → FAIL.** Run: `pnpm --filter server test -- handover.service`

- [ ] **Step 3: Implement the `operator_to_customer` branch** — `requireLegal(tenant.settings.legal, 'оператор')` for `from`; load the order (scoped to tenant), build `to` from `customerName/customerPhone/deliveryAddress`; load its `orderItems`; `items` = the order's lines (no cross-farmer aggregation); `total = order.totalStotinki`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/handover/handover.service.ts server/src/modules/handover/handover.service.spec.ts
git commit -m "feat(handover): customer-leg draft"
```

---

## Task 6: Service — create/sign (immutable, numbered, validated)

**Files:**
- Modify: `handover.service.ts`, `handover.service.spec.ts`

**Interfaces:**
- Produces: `createSigned(tenantId, dto: CreateProtocolDto): Promise<{ id: string; protocolNumber: number }>`. Freezes `fromSnapshot`/`toSnapshot` from current data (re-derives via `buildDraft`, ignores client-supplied totals), assigns the next per-tenant `protocol_number`, inserts `status='signed'`, `sign_mode='digital'`, `signed_at=now()`. Rejects a duplicate signed protocol for the same `(kind, farmerId|orderId, slotId)`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('HandoverService.createSigned', () => {
  it('assigns the next per-tenant protocol_number and stores digital signatures', async () => {
    const db = makeDb();
    // buildDraft re-derivation (farmer leg):
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]);
    db.queue([{ id: 'f1', legal: { name: 'ЕТ Васил' } }]);
    db.queue([{ productName: 'Домати', variantLabel: null, quantity: 5, unit: 'кг', priceStotinki: 300, orderNumber: 5 }]);
    db.queue([{ max: 40 }]);                       // current max protocol_number
    db.queue([{ id: 'p1', protocolNumber: 41 }]);  // insert ... returning
    const svc = await build(db);
    const res = await svc.createSigned('t1', {
      kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1',
      items: [{ productName: 'Домати', quantity: 5, priceStotinki: 300 }],
      fromSignaturePng: 'data:image/png;base64,AAA', toSignaturePng: 'data:image/png;base64,BBB',
    });
    expect(res.protocolNumber).toBe(41);
    const inserted = db.calls.values[0] as any;
    expect(inserted.status).toBe('signed');
    expect(inserted.signMode).toBe('digital');
    expect(inserted.protocolNumber).toBe(41);
    expect(inserted.fromSnapshot).toEqual({ name: 'ЕТ Васил' });      // frozen, not client-supplied
    expect(inserted.totalStotinki).toBe(1500);                        // re-derived, not trusted from client
  });

  it('rejects a duplicate signed protocol for the same target', async () => {
    const db = makeDb();
    db.queue([{ legal: { name: 'ЕТ Оператор' } }]);
    db.queue([{ id: 'f1', legal: { name: 'ЕТ Васил' } }]);
    db.queue([{ productName: 'Домати', variantLabel: null, quantity: 1, unit: 'кг', priceStotinki: 300 }]);
    db.queue([{ max: 5 }]);
    db.queue([{ id: 'dup' }]); // existing signed protocol found
    const svc = await build(db);
    await expect(svc.createSigned('t1', {
      kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1',
      items: [{ productName: 'Домати', quantity: 1, priceStotinki: 300 }],
    })).rejects.toThrow(/вече/);
  });
});
```

> Note: the exact `db.queue(...)` ordering must match the query order in the implementation. Adjust the queued rows to the real sequence when implementing; the assertions on `db.calls.values[0]` and the thrown message are the contract.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `createSigned`** — call `buildDraft` to re-derive `from`/`to`/`items`/`total` (authoritative); check for an existing signed row with the same `(tenantId, kind, farmerId|orderId, slotId)` → `ConflictException('Протокол вече е издаден за това предаване.')`; `SELECT max(protocol_number)` for the tenant → `next = (max ?? 0) + 1`; insert with frozen snapshots, `orderIds`, `totalStotinki`, signatures, `status='signed'`, `signMode='digital'`, `signedAt=new Date()`; return `{ id, protocolNumber: next }`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/handover/handover.service.ts server/src/modules/handover/handover.service.spec.ts
git commit -m "feat(handover): create signed protocol (numbered, frozen snapshots, dup guard)"
```

---

## Task 7: Service — batch create + mark-signed(paper) + list/get

**Files:**
- Modify: `handover.service.ts`, `handover.service.spec.ts`

**Interfaces:**
- Produces:
  - `createBatch(tenantId, b: BatchDto): Promise<{ ids: string[] }>` — one `pending` protocol per farmer pickup + per customer order for the day/slot, idempotent (skip targets that already have a row).
  - `markSigned(tenantId, id): Promise<void>` — `pending`→`signed`, `sign_mode='paper'`, `signed_at=now()`; throws if already signed.
  - `list(tenantId, { slotId?, date?, kind? })` and `getById(tenantId, id)`.

- [ ] **Step 1: Write the failing tests** — (a) `createBatch` inserts one row per uncovered target and skips covered ones; (b) `markSigned` flips a pending row and is rejected on an already-signed row.

```ts
describe('HandoverService.markSigned', () => {
  it('flips pending → signed(paper) and rejects a second call', async () => {
    const db = makeDb();
    db.queue([{ id: 'p1', status: 'pending' }]); // load
    db.queue([{ id: 'p1' }]);                    // update returning
    const svc = await build(db);
    await svc.markSigned('t1', 'p1');
    const set = db.calls.set[0] as any;
    expect(set.status).toBe('signed');
    expect(set.signMode).toBe('paper');

    const db2 = makeDb();
    db2.queue([{ id: 'p1', status: 'signed' }]);
    const svc2 = await build(db2);
    await expect(svc2.markSigned('t1', 'p1')).rejects.toThrow(/подписан/);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `createBatch`, `markSigned`, `list`, `getById`.** `createBatch`: resolve the day's farmers-to-collect (distinct `products.farmerId` over the slot's confirmed/preparing orders) and the day's customer orders; for each target with no existing protocol row (same `(kind,target,slot)`), build the draft, insert `status='draft'`, `sign_mode='pending'` with a `protocol_number` assigned at creation; return ids. `markSigned`: load row scoped to tenant; if `status==='signed'` → `ConflictException('Протоколът вече е подписан.')`; else `UPDATE ... SET status='signed', sign_mode='paper', signed_at=now()`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/handover/handover.service.ts server/src/modules/handover/handover.service.spec.ts
git commit -m "feat(handover): batch create, mark-signed(paper), list/get"
```

---

## Task 8: PDF authoring (pdf-lib + fontkit + Cyrillic)

**Files:**
- Create: `server/src/modules/handover/handover-pdf.ts`
- Create: `server/src/assets/fonts/DejaVuSans.ttf`
- Test: `server/src/modules/handover/handover-pdf.spec.ts`
- Modify: `server/package.json` (add `@pdf-lib/fontkit`)

**Interfaces:**
- Consumes: a stored/loaded protocol row shape `{ kind, protocolNumber, signedAt, createdAt, fromSnapshot, toSnapshot, items, totalStotinki, fromSignaturePng, toSignaturePng, signMode }`.
- Produces: `renderProtocolPdf(row): Promise<Buffer>`.

- [ ] **Step 1: Add the dependency + font**

Run: `pnpm --filter server add @pdf-lib/fontkit` and place a Cyrillic TTF at `server/src/assets/fonts/DejaVuSans.ttf` (DejaVu Sans, public domain). Ensure the assets folder is copied on build (nest-cli `assets` glob) — add it to `nest-cli.json` `compilerOptions.assets` if not already covered.

- [ ] **Step 2: Write the failing test**

```ts
import { renderProtocolPdf } from './handover-pdf';

const ROW = {
  kind: 'farmer_to_operator', protocolNumber: 41,
  signedAt: new Date('2026-07-13T09:00:00Z'), createdAt: new Date('2026-07-13T08:00:00Z'),
  fromSnapshot: { name: 'ЕТ Васил Петров', eik: '203912345', address: 'с. Розино' },
  toSnapshot: { name: 'ЕТ Оператор', eik: '111222333' },
  items: [{ productName: 'Домати', quantity: 5, unit: 'кг', priceStotinki: 300 }],
  totalStotinki: 1500, fromSignaturePng: null, toSignaturePng: null, signMode: 'pending',
};

describe('renderProtocolPdf', () => {
  it('produces a non-empty PDF for a Cyrillic farmer protocol (no encoding error)', async () => {
    const buf = await renderProtocolPdf(ROW as any);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
  it('renders the customer-receipt title for the customer kind', async () => {
    const buf = await renderProtocolPdf({ ...ROW, kind: 'operator_to_customer',
      toSnapshot: { name: 'Иван Петров', phone: '0888' } } as any);
    expect(buf.length).toBeGreaterThan(1000);
  });
});
```

- [ ] **Step 3: Run → FAIL.**

- [ ] **Step 4: Implement `renderProtocolPdf`**

```ts
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'fs';
import { join } from 'path';

const FONT = readFileSync(join(__dirname, '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf'));
const lv = (st: number) => (st / 100).toFixed(2).replace('.', ',') + ' лв.';

export async function renderProtocolPdf(row: any): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(FONT);
  const page = doc.addPage([595, 842]); // A4
  const ink = rgb(0.11, 0.1, 0.09);
  let y = 800;
  const line = (text: string, size = 11, dx = 40) => {
    page.drawText(text, { x: dx, y, size, font, color: ink });
    y -= size + 6;
  };
  const title = row.kind === 'operator_to_customer'
    ? 'РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА'
    : 'ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ';
  line(`${title} № ${row.protocolNumber ?? '—'}`, 15);
  line(`Дата: ${new Date(row.signedAt ?? row.createdAt).toLocaleString('bg-BG')}`, 10);
  y -= 6;
  line('Предал:', 11); line(partyLine(row.fromSnapshot), 10);
  y -= 2;
  line('Приел:', 11); line(partyLine(row.toSnapshot), 10);
  y -= 8;
  line('Стока:', 11);
  for (const it of row.items) {
    line(`• ${it.productName}${it.variantLabel ? ' · ' + it.variantLabel : ''} — ${it.quantity} ${it.unit ?? ''} × ${lv(it.priceStotinki)}`, 10, 52);
  }
  y -= 4;
  line(`Общо: ${lv(row.totalStotinki)}`, 12);
  y -= 20;
  await sigBlock(doc, page, font, 40, y, 'Предал', row.fromSignaturePng);
  await sigBlock(doc, page, font, 320, y, 'Приел', row.toSignaturePng);
  return Buffer.from(await doc.save());
}

function partyLine(s: any): string {
  const parts = [s?.name, s?.eik && 'ЕИК ' + s.eik, s?.regNo && 'рег.№ ' + s.regNo, s?.address, s?.phone]
    .filter(Boolean);
  return parts.join(', ');
}

async function sigBlock(doc: any, page: any, font: any, x: number, y: number, label: string, png: string | null) {
  page.drawText(`${label}: ______________________`, { x, y, size: 10, font });
  if (png) {
    const bytes = Buffer.from(png.split(',').pop()!, 'base64');
    const img = await doc.embedPng(bytes);
    page.drawImage(img, { x, y: y + 6, width: 120, height: 40 });
  }
}
```

- [ ] **Step 5: Run → PASS. Commit**

```bash
git add server/src/modules/handover/handover-pdf.ts server/src/modules/handover/handover-pdf.spec.ts server/src/assets/fonts/DejaVuSans.ttf server/package.json server/nest-cli.json
git commit -m "feat(handover): PDF authoring with embedded Cyrillic font"
```

---

## Task 9: Batch PDF merge

**Files:**
- Modify: `handover.service.ts` (add `renderSinglePdf`, `renderBatchPdf`), `handover.service.spec.ts`
- Reuse: `mergePdfs` from `../econt/econt.mappers`

**Interfaces:**
- Produces: `renderPdf(tenantId, id): Promise<Buffer>`; `renderBatchPdf(tenantId, b: BatchDto): Promise<Buffer>` (loads the day's rows, renders each via `renderProtocolPdf`, merges via `mergePdfs`).

- [ ] **Step 1: Write the failing test** — `renderBatchPdf` merges N protocol rows into one `%PDF-` buffer (mock `list` to return 2 rows; assert non-empty PDF).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `renderPdf` (load row scoped to tenant → `renderProtocolPdf`) and `renderBatchPdf` (load rows → map `renderProtocolPdf` → `mergePdfs`).

- [ ] **Step 4: Run → PASS. Commit**

```bash
git add server/src/modules/handover/handover.service.ts server/src/modules/handover/handover.service.spec.ts
git commit -m "feat(handover): single + batch PDF rendering (reuse econt mergePdfs)"
```

---

## Task 10: Controller — endpoints, guards, tenancy

**Files:**
- Create: `server/src/modules/handover/handover.controller.ts`
- Test: `server/src/modules/handover/handover.controller.spec.ts`

**Interfaces:**
- Endpoints (all `@UseGuards(JwtAuthGuard)`, `@Roles('operator','admin')`, `@CurrentTenant()`):
  - `GET /handover/draft` (`DraftQueryDto`) → `buildDraft`
  - `POST /handover` (`CreateProtocolDto`) → `createSigned`
  - `GET /handover` (`?slotId&date&kind`) → `list`
  - `GET /handover/:id/pdf` → `renderPdf` (StreamableFile, `application/pdf`, inline)
  - `POST /handover/batch` (`BatchDto`) → `createBatch`
  - `GET /handover/batch.pdf` (`?slotId&date`) → `renderBatchPdf` (StreamableFile)
  - `PATCH /handover/:id/mark-signed` → `markSigned`

- [ ] **Step 1: Write the failing test** — assert the controller delegates with the injected `tenantId` (mock the service), and that the PDF route returns a `StreamableFile` with `application/pdf`. Mirror an existing controller spec (e.g. `econt.controller.spec.ts` if present, else `reviews.controller` pattern).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement the controller.** For PDF routes set the response header and return `new StreamableFile(buffer, { type: 'application/pdf', disposition: 'inline; filename="protocol.pdf"' })` — mirror `econt-standalone.controller.ts:254-266`.

- [ ] **Step 4: Run → PASS. Commit**

```bash
git add server/src/modules/handover/handover.controller.ts server/src/modules/handover/handover.controller.spec.ts
git commit -m "feat(handover): controller endpoints with tenancy + role guards"
```

---

## Task 11: Full server suite + tsc gate

- [ ] **Step 1:** Run: `pnpm --filter server test` → all green (incl. new handover specs).
- [ ] **Step 2:** Run: `pnpm --filter server tsc --noEmit` (or the repo's typecheck script) → clean.
- [ ] **Step 3: Commit** any fixups.

```bash
git commit -am "test(handover): server suite + tsc green" || true
```

---

## Frontend integration facts (from client exploration)

- Admin = Next.js **App Router**, route group `src/app/(admin)/<feature>/page.tsx` (server component, `force-dynamic`) → `'use client'` component in `src/components/<feature>/<feature>-client.tsx`. Auth-gated by `(admin)/layout.tsx`; nav in `src/components/layout/sidebar.tsx`.
- **API:** `apiFetch<T>(path, init?, errCtx?)` in `src/lib/api-client.ts` calls `/bff/<path>` (BFF `src/app/bff/[...path]/route.ts` injects the `ff_session`→`Bearer` JWT; streams upstream `content-type` verbatim, so a `/bff/handover/:id/pdf` GET renders as `application/pdf`). JSON POST helper: `json(data)`.
- **Customer-leg action slot:** the `OrderPanel` footer, `src/components/orders/order-panel.tsx:86-110` (order rows have no inline actions — the whole row opens the panel). Delivery mark-done already lives here.
- **Farmer-leg has NO existing UI** — the route screen is customer stops only, no farmer-collection concept. The farmer pickups + batch print need a **new „Протоколи за деня" page**.
- **PDF open idiom:** `window.open('/bff/handover/…','_blank','noopener')` (no in-client blob/canvas pattern exists — both are greenfield).
- **Mobile:** dual desktop-table / mobile-card render (`max-[680px]:hidden`); panel full-width on mobile. Tailwind + `ff-*` tokens; `sonner` toasts; `lucide-react` icons.

---

## Task 12: Client API helpers + types

**Files:**
- Modify: `client/src/lib/api-client.ts` (add helpers near `createShipment`, ~:1154)
- Modify: `client/src/lib/types.ts` (add `ProtocolDraft`, `ProtocolRow`, `ProtocolItem`, `LegalIdentity`)

**Interfaces:**
- Produces:
  - `getProtocolDraft(q)` → `GET handover/draft?…`
  - `createProtocol(body)` → `POST handover` → `{ id, protocolNumber }`
  - `listProtocols(q)` → `GET handover?…`
  - `createProtocolBatch(body)` → `POST handover/batch` → `{ ids }`
  - `markProtocolSigned(id)` → `PATCH handover/:id/mark-signed`
  - `protocolPdfHref(id)` = `/bff/handover/${id}/pdf`; `protocolBatchPdfHref(q)` = `/bff/handover/batch.pdf?…`

- [ ] **Step 1: Add types** to `types.ts`

```ts
export interface LegalIdentity { kind?: 'individual'|'sole_trader'|'company'; name?: string; eik?: string; vatNumber?: string; address?: string; regNo?: string; phone?: string }
export interface ProtocolItem { productName: string; variantLabel?: string; quantity: number; unit?: string; priceStotinki: number; orderNumber?: number }
export interface ProtocolDraft { kind: string; from: LegalIdentity; to: LegalIdentity; items: ProtocolItem[]; total: number }
export interface ProtocolRow { id: string; kind: string; protocolNumber: number | null; status: string; signMode: string; totalStotinki: number; createdAt: string; toSnapshot: LegalIdentity }
```

- [ ] **Step 2: Add API helpers** to `api-client.ts` (mirror `listOrders`/`rescheduleOrders` style)

```ts
export const getProtocolDraft = (q: { kind: string; farmerId?: string; orderId?: string; slotId?: string }) =>
  apiFetch<ProtocolDraft>('handover/draft?' + new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]));
export const createProtocol = (body: unknown) =>
  apiFetch<{ id: string; protocolNumber: number }>('handover', { method: 'POST', ...json(body) }, 'Протоколът не беше записан');
export const listProtocols = (q: { slotId?: string; date?: string; kind?: string }) =>
  apiFetch<ProtocolRow[]>('handover?' + new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]));
export const createProtocolBatch = (body: { slotId?: string; date?: string }) =>
  apiFetch<{ ids: string[] }>('handover/batch', { method: 'POST', ...json(body) }, 'Батчът не беше създаден');
export const markProtocolSigned = (id: string) =>
  apiFetch<void>(`handover/${id}/mark-signed`, { method: 'PATCH' }, 'Неуспешно маркиране');
export const protocolPdfHref = (id: string) => `/bff/handover/${id}/pdf`;
export const protocolBatchPdfHref = (q: { slotId?: string; date?: string }) =>
  '/bff/handover/batch.pdf?' + new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
```

- [ ] **Step 3: Build** `pnpm --filter client build` (or `tsc --noEmit`) → clean.
- [ ] **Step 4: Commit**

```bash
git add client/src/lib/api-client.ts client/src/lib/types.ts
git commit -m "feat(client): handover protocol API helpers + types"
```

---

## Task 13: Signature-pad component (`<canvas>`)

**Files:**
- Create: `client/src/components/handover/signature-pad.tsx`

**Interfaces:**
- Produces: `<SignaturePad label="Предал" onChange={(png: string|null) => …} />` — captures pointer strokes, exposes the drawn image as a PNG data URL via `onChange`; „Изчисти" button resets.

- [ ] **Step 1: Implement** (pointer events; `'use client'`)

```tsx
'use client';
import { useRef, useState } from 'react';

export function SignaturePad({ label, onChange }: { label: string; onChange: (png: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [dirty, setDirty] = useState(false);

  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: React.PointerEvent) => {
    drawing.current = true;
    const ctx = ref.current!.getContext('2d')!;
    const { x, y } = pos(e);
    ctx.beginPath(); ctx.moveTo(x, y);
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = ref.current!.getContext('2d')!;
    const { x, y } = pos(e);
    ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#1c1a17';
    ctx.lineTo(x, y); ctx.stroke();
    if (!dirty) setDirty(true);
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    onChange(ref.current!.toDataURL('image/png'));
  };
  const clear = () => {
    const c = ref.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    setDirty(false); onChange(null);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-sm">
        <span>{label}</span>
        {dirty && <button type="button" onClick={clear} className="text-ff-green-700 underline">Изчисти</button>}
      </div>
      <canvas ref={ref} width={280} height={110}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}
        className="w-full touch-none rounded-lg border border-ff-border bg-white" />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/components/handover/signature-pad.tsx
git commit -m "feat(client): canvas signature pad"
```

---

## Task 14: Customer-leg — „Протокол" in the OrderPanel

**Files:**
- Create: `client/src/components/handover/protocol-dialog.tsx` (draft review + two `SignaturePad`s + submit)
- Modify: `client/src/components/orders/order-panel.tsx:86-110` (add the „Протокол за клиента" button)

**Interfaces:**
- `<ProtocolDialog kind="operator_to_customer" orderId={order.id} onClose={…} />` — on open calls `getProtocolDraft`, shows items + parties, captures both signatures, `createProtocol`, then `window.open(protocolPdfHref(id))`.

- [ ] **Step 1: Implement `ProtocolDialog`** — fetch draft on mount (`getProtocolDraft({ kind, orderId })`), render parties + item list + total, two `SignaturePad`s (Предал=оператор, Приел=клиент), „Запиши и отвори PDF" → `createProtocol({ kind, orderId, items: draft.items, fromSignaturePng, toSignaturePng, meta })` → `window.open(protocolPdfHref(res.id),'_blank','noopener')` → toast + `onClose`. Customer-not-present: a „Получено без подпис" checkbox submits with null signatures (server records `sign_mode='digital'` with blank sigs; still timestamped). Mobile: full-width sheet (`max-w-[94vw]`).

- [ ] **Step 2: Add the button** to `order-panel.tsx` footer (after „Маркирай доставена", ~:97):

```tsx
<button type="button" onClick={() => setProtocolOpen(true)}
  className="ff-btn-secondary">Протокол за клиента</button>
{protocolOpen && <ProtocolDialog kind="operator_to_customer" orderId={order.id} onClose={() => setProtocolOpen(false)} />}
```

(Add `const [protocolOpen, setProtocolOpen] = useState(false);` to the panel.)

- [ ] **Step 3: Verify in the browser** — open an order, click „Протокол за клиента", sign, save; confirm the PDF opens and shows Cyrillic + items. (See Task 16.)

- [ ] **Step 4: Commit**

```bash
git add client/src/components/handover/protocol-dialog.tsx client/src/components/orders/order-panel.tsx
git commit -m "feat(client): customer delivery protocol from the order panel"
```

---

## Task 15: „Протоколи за деня" page (farmer pickups + batch print)

**Files:**
- Create: `client/src/app/(admin)/protocols/page.tsx` (server component, `force-dynamic`)
- Create: `client/src/components/handover/protocols-client.tsx`
- Modify: `client/src/components/layout/sidebar.tsx` (nav entry „Протоколи")

**Interfaces:**
- The page shows a date picker (default today), the day's **farmer pickups** (each → digital-sign via `ProtocolDialog kind="farmer_to_operator"`) and a **„Печат за деня"** button → `createProtocolBatch({ date })` then `window.open(protocolBatchPdfHref({ date }))`. A list of the day's protocols with status + „Свали PDF" + „Маркирай подписан (хартия)" (`markProtocolSigned`).

- [ ] **Step 1: Create the page** `(admin)/protocols/page.tsx` rendering `<ProtocolsClient />` (mirror `farmer-delivery/page.tsx`).
- [ ] **Step 2: Implement `protocols-client.tsx`** — `DateNavBar`-style date state; „Печат за деня" (batch create → open batch PDF); the day's farmer-pickup rows each open `ProtocolDialog kind="farmer_to_operator" farmerId=… slotId=…`; `listProtocols({ date })` table with download (`protocolPdfHref`) + „Маркирай подписан (хартия)" (`markProtocolSigned` → refresh). Desktop table / mobile cards per the repo idiom.
- [ ] **Step 3: Add sidebar nav** entry „Протоколи" → `/protocols` in `sidebar.tsx` (mirror an existing entry).
- [ ] **Step 4: Verify in the browser** (Task 16).
- [ ] **Step 5: Commit**

```bash
git add "client/src/app/(admin)/protocols/page.tsx" client/src/components/handover/protocols-client.tsx client/src/components/layout/sidebar.tsx
git commit -m "feat(client): 'Протоколи за деня' page — farmer pickups + batch print"
```

---

## Task 16: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Start the stack** via the repo's dev launcher (`.claude/launch.json` server + client) — never Bash. Seed/ensure tenant `settings.legal` and at least one farmer `farmers.legal` are set (add via DB or the existing settings UI).
- [ ] **Step 2: Customer leg** — open a confirmed own-delivery order → „Протокол за клиента" → sign both pads → save → confirm a `%PDF-` opens with the „РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА", correct items, total = COD amount, Cyrillic legible, both signature images present. Re-open the same order → second attempt is rejected (dup guard).
- [ ] **Step 3: Farmer leg** — on „Протоколи за деня" pick today → a farmer pickup row → sign → PDF „ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ" aggregates that farmer's items across the day's orders.
- [ ] **Step 4: Batch print** — „Печат за деня" → confirm one merged PDF contains a page per farmer pickup + per customer delivery, with blank signature lines. Then „Маркирай подписан (хартия)" on one → status flips to signed.
- [ ] **Step 5: Guards** — confirm a non-operator role gets 403; confirm a missing tenant `settings.legal` yields the Bulgarian 400 message.
- [ ] **Step 6: Watch console + server logs** for errors; fix any; re-verify.

---

## Self-review

- **Spec coverage:** farmer leg (Tasks 4,15) · customer leg (Tasks 5,14) · immutable numbered record (Task 6) · batch print + mark-signed(paper) (Tasks 7,9,15) · operator `settings.legal` (Task 2) · Cyrillic PDF (Task 8) · tenancy/role guards (Task 10) · fiscal-receipt explicitly out of scope (Global Constraints). Covered.
- **Placeholder scan:** none — every step has concrete code/commands. Two soft confirmations flagged inline (types-package path in Task 2; exact `db.queue` ordering in Task 6) are implementation-time adjustments, not missing content.
- **Type consistency:** `LegalIdentity`/`ProtocolItem`/`ProtocolDraft` names match across server (Task 2) and client (Task 12); `buildDraft`/`createSigned`/`createBatch`/`markSigned`/`renderProtocolPdf`/`renderBatchPdf` names are consistent across Tasks 4–10 and the controller.

---

## Open confirmations for the implementer (non-blocking)

- Confirm the shared types-package path for `LegalIdentity` (Task 2) — mirror wherever `farmers.legal`'s type currently lives.
- When wiring `HandoverModule`, follow a peer module (e.g. `orders.module.ts`) for the exact DB-provider import.
- `ff-btn-secondary` in Task 14 is illustrative — use the actual button token/class used elsewhere in `order-panel.tsx`.
