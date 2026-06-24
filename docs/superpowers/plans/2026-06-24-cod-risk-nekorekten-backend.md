# COD-risk + nekorekten — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cross-tenant COD-risk system (a strike per refused/returned COD parcel, keyed by normalized phone) plus a nekorekten.com bridge (check a phone before shipping; farmer-confirmed report of a bad payer), so the standalone Econt app warns farmers about risky cash-on-delivery customers.

**Architecture:** A new `server/src/modules/cod-risk/` module (pure helpers + `NekorektenClient` + `CodRiskService`), reused by the existing Econt refresh cron (to record strikes) and exposed via three standalone `/shipping/risk/*` endpoints. One platform-wide nekorekten key from env (`NEKOREKTEN_API_KEY`), graceful when absent. Warn-not-block; confirm-then-report.

**Tech Stack:** NestJS, Drizzle ORM (`@fermeribg/db`), Postgres, Jest, native `fetch`. Spec: `docs/superpowers/specs/2026-06-24-cod-risk-nekorekten-design.md`.

**Conventions (read before starting):**
- Branch `feat/econt-standalone-service` (already checked out). `main` auto-deploys.
- Build order: `pnpm --filter @fermeribg/db build && pnpm --filter @fermeribg/types build` before `pnpm --filter @fermeribg/api build`.
- Tests: `pnpm --filter @fermeribg/api test`. Money is integer stotinki (EUR cents). UI strings Bulgarian.
- Pattern: pure logic → exported functions (unit-tested); thin I/O methods. Mirror `server/src/modules/econt/econt.service.spec.ts`.
- `NEKOREKTEN_API_KEY` is **not** set yet — everything must work degraded without it.

---

## File structure

**Modify:**
- `packages/db/src/schema.ts` — add `codRisk` + `codRiskEvents` tables; add `shipments.reportStatus`.
- `server/src/modules/econt/econt-core.module.ts` — import + re-export `CodRiskModule`.
- `server/src/modules/econt/econt.service.ts` — inject `CodRiskService`; call the detection hook in `refreshStatus`.
- `server/src/modules/econt/econt.service.spec.ts` — update the `EcontService` constructor stubs (now 5 args).
- `server/src/modules/econt-app/econt-standalone.controller.ts` — add 3 `/shipping/risk/*` routes.

**Create:**
- `packages/db/drizzle/0056_*.sql` (generated).
- `server/src/modules/cod-risk/cod-risk.helpers.ts` (+ `.spec.ts`).
- `server/src/modules/cod-risk/nekorekten.client.ts` (+ `.spec.ts`).
- `server/src/modules/cod-risk/cod-risk.service.ts`.
- `server/src/modules/cod-risk/cod-risk.module.ts`.

---

## Task 1: Data model — `cod_risk`, `cod_risk_events`, `shipments.reportStatus` (migration 0056)

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0056_*.sql` (generated)

- [ ] **Step 1: Add the tables + column**

In `packages/db/src/schema.ts`, add `reportStatus` to the `shipments` table body (after `courierRequestStatus`, before `createdAt`):

```ts
    // nekorekten reporting lifecycle for a returned/refused COD parcel:
    // 'none' (default) → 'candidate' (cron flagged it) → 'reported' | 'refuted'.
    reportStatus: text('report_status').notNull().default('none'),
```

Then add two new tables (place them right after the `shipments` table definition):

```ts
// Cross-tenant COD-risk registry: one row per normalized customer phone, counting
// refused/returned cash-on-delivery parcels seen across ALL farms (network effect).
export const codRisk = pgTable('cod_risk', {
  phone: text('phone').primaryKey(), // normalized E.164 BG, e.g. +359888123456
  strikes: integer('strikes').notNull().default(0),
  lastEventType: text('last_event_type'),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Append-only provenance for each strike / report (who saw it, on which shipment).
export const codRiskEvents = pgTable(
  'cod_risk_events',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    phone: text('phone').notNull(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    shipmentId: uuid('shipment_id').references(() => shipments.id),
    type: text('type').notNull(), // 'returned' | 'refused' | 'reported'
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    phoneIdx: index('cod_risk_events_phone_idx').on(t.phone),
  }),
);
```

Confirm `pgTable`, `text`, `integer`, `uuid`, `timestamp`, `index`, `sql` are already imported at the top of `schema.ts` (they are — used throughout).

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @fermeribg/db generate`
Expected: a new `packages/db/drizzle/0056_*.sql` is created.

- [ ] **Step 3: Verify the SQL**

Open the new `0056_*.sql`. It MUST contain:
- `CREATE TABLE ... "cod_risk" (...)` with `"phone" text PRIMARY KEY`
- `CREATE TABLE ... "cod_risk_events" (...)`
- `ALTER TABLE "shipments" ADD COLUMN "report_status" text DEFAULT 'none' NOT NULL;`

- [ ] **Step 4: Build the db package**

Run: `pnpm --filter @fermeribg/db build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle
git commit -m "feat(db): cod_risk registry + cod_risk_events + shipments.reportStatus (migration 0056)"
```

---

## Task 2: Pure helpers — phone, verdict, returned-status, parse, report-text

**Files:**
- Create: `server/src/modules/cod-risk/cod-risk.helpers.ts`
- Create: `server/src/modules/cod-risk/cod-risk.helpers.spec.ts`

- [ ] **Step 1: Write the failing tests**

`server/src/modules/cod-risk/cod-risk.helpers.spec.ts`:

```ts
import { normalizePhone, riskVerdict, isReturnedStatus, parseReports, buildReportText } from './cod-risk.helpers';

describe('normalizePhone', () => {
  it('canonicalizes BG forms to +359XXXXXXXXX', () => {
    expect(normalizePhone('0888123456')).toBe('+359888123456');
    expect(normalizePhone('+359888123456')).toBe('+359888123456');
    expect(normalizePhone('0888 123 456')).toBe('+359888123456');
    expect(normalizePhone('00359888123456')).toBe('+359888123456');
    expect(normalizePhone('888123456')).toBe('+359888123456');
  });
  it('returns null for unparseable input', () => {
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('not a phone')).toBeNull();
  });
});

describe('riskVerdict', () => {
  it('escalates with strikes / report count', () => {
    expect(riskVerdict(0, 0)).toBe('ok');
    expect(riskVerdict(1, 0)).toBe('caution');
    expect(riskVerdict(0, 1)).toBe('caution');
    expect(riskVerdict(2, 0)).toBe('high');
    expect(riskVerdict(0, 3)).toBe('high');
  });
});

describe('isReturnedStatus', () => {
  it('detects Bulgarian returned/refused statuses', () => {
    expect(isReturnedStatus('Пратката е върната на подателя')).toBe(true);
    expect(isReturnedStatus('Отказана от получателя')).toBe(true);
    expect(isReturnedStatus('returned to sender')).toBe(true);
    expect(isReturnedStatus('refused')).toBe(true);
  });
  it('is false for normal / null statuses', () => {
    expect(isReturnedStatus('Доставена')).toBe(false);
    expect(isReturnedStatus('В транзит')).toBe(false);
    expect(isReturnedStatus(null)).toBe(false);
  });
});

describe('parseReports', () => {
  it('reads a list under reports / data / array root, defensively', () => {
    expect(parseReports({ reports: [{ phone: '0888', text: 'отказа' }] }).count).toBe(1);
    expect(parseReports([{ phone: '0888' }]).count).toBe(1);
    expect(parseReports({ data: [{}, {}] }).count).toBe(2);
    expect(parseReports({ reports: [] }).found).toBe(false);
    expect(parseReports(null).found).toBe(false);
  });
});

describe('buildReportText', () => {
  it('describes the refused COD parcel in Bulgarian', () => {
    const txt = buildReportText({ codAmountStotinki: 2400, receiverName: 'Иван' });
    expect(txt).toContain('наложен платеж');
    expect(txt.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @fermeribg/api test -- cod-risk.helpers`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`server/src/modules/cod-risk/cod-risk.helpers.ts`:

```ts
/** Canonicalize a Bulgarian phone to E.164 (+359XXXXXXXXX), or null if unparseable. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^\d+]/g, ''); // keep digits + leading plus
  if (d.startsWith('+359')) d = d.slice(4);
  else if (d.startsWith('00359')) d = d.slice(5);
  else if (d.startsWith('359') && d.length === 12) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  d = d.replace(/\D/g, '');
  // BG national numbers are 9 digits after the country/trunk prefix.
  if (d.length !== 9) return null;
  return `+359${d}`;
}

export type RiskVerdict = 'ok' | 'caution' | 'high';

/** Combine our own strike count + nekorekten report count into a verdict. */
export function riskVerdict(internalStrikes: number, nekorektenCount: number): RiskVerdict {
  if (internalStrikes >= 2 || nekorektenCount >= 2) return 'high';
  if (internalStrikes >= 1 || nekorektenCount >= 1) return 'caution';
  return 'ok';
}

/** True when an Econt status string means the parcel came back / was refused. */
export function isReturnedStatus(status: string | null | undefined): boolean {
  const s = (status ?? '').toLowerCase();
  if (!s) return false;
  return (
    s.includes('върнат') || s.includes('отказ') || s.includes('return') || s.includes('refus')
  );
}

export interface NekorektenReport {
  date: string | null;
  phone: string | null;
  description: string | null;
}
export interface NekorektenCheck {
  configured: boolean;
  found: boolean;
  count: number;
  reports: NekorektenReport[];
}

/** Defensively read nekorekten's GET /reports response (shape unconfirmed vs live). */
export function parseReports(res: unknown): NekorektenCheck {
  const r = (res ?? {}) as Record<string, any>;
  const list: any[] = Array.isArray(r)
    ? r
    : Array.isArray(r.reports)
      ? r.reports
      : Array.isArray(r.data)
        ? r.data
        : [];
  const reports: NekorektenReport[] = list.map((x) => ({
    date: x?.createdAt ?? x?.date ?? null,
    phone: x?.phone ?? null,
    description: x?.text ?? x?.description ?? null,
  }));
  return { configured: true, found: reports.length > 0, count: reports.length, reports };
}

/** The Bulgarian report text sent to nekorekten for a refused COD parcel. */
export function buildReportText(shipment: {
  codAmountStotinki: number | null;
  receiverName?: string | null;
}): string {
  const amount = shipment.codAmountStotinki != null ? ` (${(shipment.codAmountStotinki / 100).toFixed(2)} EUR)` : '';
  return `Отказана/невзета пратка с наложен платеж${amount}. Клиентът не получи пратката.`;
}
```

- [ ] **Step 4: Run tests** → `pnpm --filter @fermeribg/api test -- cod-risk.helpers` → PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/cod-risk/cod-risk.helpers.ts server/src/modules/cod-risk/cod-risk.helpers.spec.ts
git commit -m "feat(cod-risk): pure helpers — phone normalize, verdict, returned-status, parse, report text"
```

---

## Task 3: `NekorektenClient` (check + report; platform key from env)

**Files:**
- Create: `server/src/modules/cod-risk/nekorekten.client.ts`
- Create: `server/src/modules/cod-risk/nekorekten.client.spec.ts`

- [ ] **Step 1: Write the failing test (no-key degraded path)**

`server/src/modules/cod-risk/nekorekten.client.spec.ts`:

```ts
import { NekorektenClient } from './nekorekten.client';

const cfg = (key: string) => ({ get: () => key }) as never;

describe('NekorektenClient (no key)', () => {
  it('checkPhone returns unconfigured + empty, never throws', async () => {
    const c = new NekorektenClient(cfg(''));
    const out = await c.checkPhone('+359888123456');
    expect(out).toEqual({ configured: false, found: false, count: 0, reports: [] });
  });
  it('reportPhone throws a clear error when unconfigured', async () => {
    const c = new NekorektenClient(cfg(''));
    await expect(c.reportPhone({ phone: '+359888123456', text: 'x' })).rejects.toThrow('nekorekten');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @fermeribg/api test -- nekorekten.client`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`server/src/modules/cod-risk/nekorekten.client.ts`:

```ts
import { Injectable, Inject, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NekorektenCheck, parseReports } from './cod-risk.helpers';

const BASE = 'https://api.nekorekten.com/api/v1';

/**
 * Thin client for nekorekten.com (BG bad-COD-customer registry). One platform-wide
 * key from env `NEKOREKTEN_API_KEY` (+ server IP whitelisted in their dashboard).
 * Reads never throw (degrade to empty); a report throws a clear error if unconfigured
 * or the call fails, so the caller can keep the candidate for retry.
 */
@Injectable()
export class NekorektenClient {
  private readonly logger = new Logger(NekorektenClient.name);
  private readonly apiKey: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.apiKey = config.get<string>('NEKOREKTEN_API_KEY', '');
  }

  get configured(): boolean {
    return !!this.apiKey;
  }

  /** Check a phone against the registry. Never throws — degrades to empty. */
  async checkPhone(phone: string): Promise<NekorektenCheck> {
    if (!this.apiKey) return { configured: false, found: false, count: 0, reports: [] };
    try {
      const res = await fetch(`${BASE}/reports?phone=${encodeURIComponent(phone)}&searchMode=one-of`, {
        headers: { 'Api-Key': this.apiKey },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        this.logger.warn(`nekorekten check ${res.status}`);
        return { configured: true, found: false, count: 0, reports: [] };
      }
      return parseReports(await res.json());
    } catch (err) {
      this.logger.warn(`nekorekten check failed: ${err instanceof Error ? err.message : err}`);
      return { configured: true, found: false, count: 0, reports: [] };
    }
  }

  /** Report a bad payer. Throws on unconfigured / failure (caller keeps the candidate). */
  async reportPhone(input: { phone: string; text: string; name?: string }): Promise<{ ok: true }> {
    if (!this.apiKey) throw new BadRequestException('nekorekten не е конфигуриран');
    const body: Record<string, unknown> = { phone: input.phone, text: input.text };
    if (input.name) body.firstName = input.name;
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(`${BASE}/reports`, {
        method: 'POST',
        headers: { 'Api-Key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      throw new BadRequestException(`nekorekten недостъпен: ${err instanceof Error ? err.message : 'network'}`);
    }
    if (!res.ok) throw new BadRequestException(`nekorekten грешка (${res.status})`);
    return { ok: true };
  }
}
```

- [ ] **Step 4: Run tests** → `pnpm --filter @fermeribg/api test -- nekorekten.client` → PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/cod-risk/nekorekten.client.ts server/src/modules/cod-risk/nekorekten.client.spec.ts
git commit -m "feat(cod-risk): NekorektenClient — check + report via platform key, graceful when unset"
```

---

## Task 4: `CodRiskService` + `CodRiskModule`

**Files:**
- Create: `server/src/modules/cod-risk/cod-risk.service.ts`
- Create: `server/src/modules/cod-risk/cod-risk.module.ts`

The service is thin I/O over the already-unit-tested pure helpers (Task 2), so it has no dedicated unit test; it's covered by the typecheck/build here and the full suite + boot smoke in Task 7. Keep all branching logic in the helpers, not inlined here.

- [ ] **Step 1: Implement `CodRiskService`**

`server/src/modules/cod-risk/cod-risk.service.ts`:

```ts
import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { type Database, shipments, orders, codRisk, codRiskEvents } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { NekorektenClient } from './nekorekten.client';
import { normalizePhone, riskVerdict, isReturnedStatus, buildReportText, type RiskVerdict, type NekorektenCheck } from './cod-risk.helpers';

@Injectable()
export class CodRiskService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly nekorekten: NekorektenClient,
  ) {}

  /** Combined risk view for a phone: our strikes + nekorekten reports + a verdict. */
  async check(rawPhone: string): Promise<{
    phone: string | null;
    internalStrikes: number;
    nekorekten: NekorektenCheck;
    verdict: RiskVerdict;
  }> {
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      return { phone: null, internalStrikes: 0, nekorekten: { configured: this.nekorekten.configured, found: false, count: 0, reports: [] }, verdict: 'ok' };
    }
    const [row] = await this.db
      .select({ strikes: codRisk.strikes })
      .from(codRisk)
      .where(eq(codRisk.phone, phone))
      .limit(1);
    const internalStrikes = row?.strikes ?? 0;
    const nk = await this.nekorekten.checkPhone(phone);
    return { phone, internalStrikes, nekorekten: nk, verdict: riskVerdict(internalStrikes, nk.count) };
  }

  /** Called from the Econt refresh hook. Idempotent: only the first transition of a
   *  COD shipment into a returned/refused status records a strike + a candidate. */
  async recordReturnIfApplicable(shipment: typeof shipments.$inferSelect): Promise<void> {
    if (shipment.codAmountStotinki == null) return; // not a COD parcel
    if (!isReturnedStatus(shipment.status)) return;
    if (shipment.reportStatus && shipment.reportStatus !== 'none') return; // already handled

    let rawPhone: string | null = shipment.receiverPhone;
    if (!rawPhone && shipment.orderId) {
      const [o] = await this.db
        .select({ phone: orders.customerPhone })
        .from(orders)
        .where(eq(orders.id, shipment.orderId))
        .limit(1);
      rawPhone = o?.phone ?? null;
    }
    const phone = normalizePhone(rawPhone ?? '');

    // Mark the shipment so we never re-process it, even if we couldn't key a phone.
    await this.db.update(shipments).set({ reportStatus: 'candidate' }).where(eq(shipments.id, shipment.id));
    if (!phone) return;

    await this.db
      .insert(codRisk)
      .values({ phone, strikes: 1, lastEventType: 'returned', lastEventAt: new Date() })
      .onConflictDoUpdate({
        target: codRisk.phone,
        set: { strikes: sql`${codRisk.strikes} + 1`, lastEventType: 'returned', lastEventAt: new Date(), updatedAt: new Date() },
      });
    await this.db.insert(codRiskEvents).values({ phone, tenantId: shipment.tenantId, shipmentId: shipment.id, type: 'returned' });
  }

  /** Returned-COD shipments for this tenant awaiting a report decision. */
  async listCandidates(tenantId: string): Promise<Array<{ shipmentId: string; receiverName: string | null; phone: string | null; codAmountStotinki: number | null }>> {
    const rows = await this.db
      .select({
        shipmentId: shipments.id,
        receiverName: shipments.receiverName,
        receiverPhone: shipments.receiverPhone,
        codAmountStotinki: shipments.codAmountStotinki,
      })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), eq(shipments.reportStatus, 'candidate')));
    return rows.map((r) => ({
      shipmentId: r.shipmentId,
      receiverName: r.receiverName,
      phone: normalizePhone(r.receiverPhone ?? ''),
      codAmountStotinki: r.codAmountStotinki,
    }));
  }

  /** Farmer-confirmed: report this returned COD shipment to nekorekten (under the
   *  platform account). Tenant-scoped. Keeps the candidate on failure for retry. */
  async confirmReport(tenantId: string, shipmentId: string): Promise<{ reported: true }> {
    const [s] = await this.db
      .select()
      .from(shipments)
      .where(and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId)))
      .limit(1);
    if (!s) throw new NotFoundException('Пратката не е намерена');

    let rawPhone: string | null = s.receiverPhone;
    if (!rawPhone && s.orderId) {
      const [o] = await this.db.select({ phone: orders.customerPhone }).from(orders).where(eq(orders.id, s.orderId)).limit(1);
      rawPhone = o?.phone ?? null;
    }
    const phone = normalizePhone(rawPhone ?? '');
    if (!phone) throw new BadRequestException('Няма валиден телефон за докладване');

    await this.nekorekten.reportPhone({ phone, text: buildReportText(s), name: s.receiverName ?? undefined });

    await this.db.update(shipments).set({ reportStatus: 'reported' }).where(eq(shipments.id, shipmentId));
    await this.db.insert(codRiskEvents).values({ phone, tenantId, shipmentId, type: 'reported' });
    return { reported: true };
  }
}
```

- [ ] **Step 2: Implement `CodRiskModule`**

`server/src/modules/cod-risk/cod-risk.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { CodRiskService } from './cod-risk.service';
import { NekorektenClient } from './nekorekten.client';

@Module({
  providers: [CodRiskService, NekorektenClient],
  exports: [CodRiskService],
})
export class CodRiskModule {}
```

(`ConfigService` is global — `NekorektenClient` can inject it without importing ConfigModule. `DB_TOKEN` is provided by the global `DrizzleModule`.)

- [ ] **Step 3: Build to typecheck**

Run: `pnpm --filter @fermeribg/db build && pnpm --filter @fermeribg/types build && pnpm --filter @fermeribg/api build`
Expected: clean (the new `codRisk`/`codRiskEvents` are exported from `@fermeribg/db` after Task 1's build).

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/cod-risk/cod-risk.service.ts server/src/modules/cod-risk/cod-risk.module.ts
git commit -m "feat(cod-risk): CodRiskService (check / record-return / candidates / confirm-report) + module"
```

---

## Task 5: Wire detection into the Econt refresh + update spec stubs

**Files:**
- Modify: `server/src/modules/econt/econt-core.module.ts`
- Modify: `server/src/modules/econt/econt.service.ts`
- Modify: `server/src/modules/econt/econt.service.spec.ts`

- [ ] **Step 1: Import + re-export `CodRiskModule` in `EcontCoreModule`**

In `server/src/modules/econt/econt-core.module.ts`, add the import and wire it:

```ts
import { CodRiskModule } from '../cod-risk/cod-risk.module';
```
Add `CodRiskModule` to `imports` and `exports`:
```ts
  imports: [
    CodRiskModule,
    BullModule.registerQueue({ /* unchanged */ }),
  ],
  providers: [EcontService, ShipmentEmailService, ...(RUN_WORKERS ? [EcontProcessor] : [])],
  exports: [EcontService, ShipmentEmailService, CodRiskModule],
```
(Re-exporting `CodRiskModule` makes `CodRiskService` available to `EcontAppModule`, which imports `EcontCoreModule`.)

- [ ] **Step 2: Inject `CodRiskService` into `EcontService` + call the hook**

In `server/src/modules/econt/econt.service.ts`:

Add the import:
```ts
import { CodRiskService } from '../cod-risk/cod-risk.service';
```
Add the constructor param (after `shipmentEmail`):
```ts
    private readonly shipmentEmail: ShipmentEmailService,
    private readonly codRisk: CodRiskService,
  ) {
```
In `refreshStatus`, just before `return updated;` (after the shipped-email block), add:
```ts
    // COD-risk: a returned/refused COD parcel becomes a strike + a report candidate.
    await this.codRisk.recordReturnIfApplicable(updated);
```

- [ ] **Step 3: Update the spec constructor stubs (now 5 args)**

In `server/src/modules/econt/econt.service.spec.ts`, every `new EcontService(...)` currently passes 4 stubbed args. Add a 5th `{} as never` to each (there are constructions in the `describe('EcontService.buildLabel')` and `describe('EcontService.codAmountFor')` blocks):

```ts
  const svc = new EcontService(
    {} as never,
    { get: () => '' } as never,
    {} as never,
    {} as never,
    {} as never,
  );
```

- [ ] **Step 4: Build + run the full econt suite**

Run: `pnpm --filter @fermeribg/api build` → clean
Run: `pnpm --filter @fermeribg/api test -- econt.service.spec` → PASS (constructor stubs updated)

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt
git commit -m "feat(econt): record COD-risk strike on returned/refused parcels in refreshStatus"
```

---

## Task 6: Standalone `/shipping/risk/*` endpoints

**Files:**
- Modify: `server/src/modules/econt-app/econt-standalone.controller.ts`

- [ ] **Step 1: Add the routes**

In `server/src/modules/econt-app/econt-standalone.controller.ts`:

Add the import:
```ts
import { CodRiskService } from '../cod-risk/cod-risk.service';
```
Inject it in the constructor (alongside `EcontService`):
```ts
  constructor(
    private readonly econt: EcontService,
    private readonly risk: CodRiskService,
  ) {}
```
Add three routes (inside the class, near the shipments routes):
```ts
  // --- COD risk ---
  @Get('risk/check')
  riskCheck(@CurrentTenant() _t: string, @Query('phone') phone: string) {
    return this.risk.check(phone ?? '');
  }
  @Get('risk/candidates')
  riskCandidates(@CurrentTenant() t: string) {
    return this.risk.listCandidates(t);
  }
  @Post('risk/reports/:shipmentId')
  riskReport(@CurrentTenant() t: string, @Param('shipmentId', ParseUUIDPipe) shipmentId: string) {
    return this.risk.confirmReport(t, shipmentId);
  }
```
(`Get`, `Post`, `Param`, `Query`, `ParseUUIDPipe`, `CurrentTenant` are already imported in this controller.)

- [ ] **Step 2: Build**

Run: `pnpm --filter @fermeribg/api build`
Expected: clean. (`CodRiskService` resolves in `EcontAppModule` via `EcontCoreModule`'s re-export from Task 5.)

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/econt-app/econt-standalone.controller.ts
git commit -m "feat(econt-app): /shipping/risk check + candidates + confirm-report endpoints"
```

---

## Task 7: Final verification + lint

- [ ] **Step 1: Full build**

Run: `pnpm --filter @fermeribg/db build && pnpm --filter @fermeribg/types build && pnpm --filter @fermeribg/api build`
Expected: all clean.

- [ ] **Step 2: Full test suite**

Run: `pnpm --filter @fermeribg/api test`
Expected: all green (prior 675 + the new cod-risk helper/client tests).

- [ ] **Step 3: Lint**

Run: `pnpm --filter @fermeribg/api lint`
Expected: no errors.

- [ ] **Step 4: Review the diff**

Run: `git diff --stat main..HEAD` and confirm only `cod-risk`, `econt`, `econt-app`, and the 0056 migration changed for this feature.

---

## Spike (before prod — not a code task)

With a real `NEKOREKTEN_API_KEY` (+ the server IP whitelisted in the nekorekten dashboard):
- `GET /api/v1/reports?phone=...&searchMode=one-of` → confirm the JSON shape against `parseReports` (does the list sit under `reports`/`data`/root? field names `phone`/`text`/`createdAt`?). Adjust if different.
- `POST /api/v1/reports` with `{phone, text, firstName}` → confirm it succeeds + required fields. Add `cityID`/`files` only if rejected without them.

All parsers degrade safely on mismatch (empty check, report throws → candidate kept), so nothing breaks before the spike — the feature just stays inert until the key + field names are confirmed.

## Out of scope (this plan)

- Frontend (risk badge at create, "Докладвай" button, candidates screen) — next plan.
- Per-tenant nekorekten keys; auto-reporting without confirmation; hard-blocking on risk.
- `cities`/`files` nekorekten endpoints (not needed for a text+phone report in v1).
