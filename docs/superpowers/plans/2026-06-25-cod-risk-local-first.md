# COD-Risk Local-First + Unified Shape — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `CodRiskService.check()` read our DB first, skip the rate-limited nekorekten API when our strikes already flag the phone `high`, Redis-cache nekorekten results (7d), and return our records + theirs in one unified `RiskReport[]` shape.

**Architecture:** Pure mappers in `cod-risk.helpers.ts` turn our `cod_risk_events` and a `NekorektenCheck` into a shared `RiskReport`. `CodRiskService.check()` orchestrates: parallel DB reads → short-circuit → Redis cache (`PublicCacheService`, `@Global`) → merge. No DB migration; no write-path change.

**Tech Stack:** NestJS + Drizzle, Jest, Redis via `PublicCacheService`.

**Spec:** `docs/superpowers/specs/2026-06-25-cod-risk-local-first-design.md`

**Commands:**
- Typecheck: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
- Test: `pnpm --filter @fermeribg/api exec jest cod-risk --silent`
- Lint: `pnpm --filter @fermeribg/api exec eslint "src/modules/cod-risk/**/*.ts"`

---

## File structure

| File | Change |
|---|---|
| `server/src/modules/cod-risk/cod-risk.helpers.ts` | add `RiskReport`, `RiskCheckResult`, `toInternalReports`, `toNekorektenReports`, `mergeReports` |
| `server/src/modules/cod-risk/cod-risk.helpers.spec.ts` | extend — tests for the 3 mappers |
| `server/src/modules/cod-risk/cod-risk.service.ts` | inject `PublicCacheService`; rewrite `check()` |
| `server/src/modules/cod-risk/cod-risk.service.spec.ts` | **new** — `check()` flow tests |

No change to `nekorekten.client.ts`, `cod-risk.module.ts` (cache is `@Global`), the controller, or the DB schema.

---

## Task 1: Unified shape + pure mappers (TDD)

**Files:**
- Modify: `server/src/modules/cod-risk/cod-risk.helpers.ts`
- Test: `server/src/modules/cod-risk/cod-risk.helpers.spec.ts`

- [ ] **Step 1: Add the failing tests** — append to `cod-risk.helpers.spec.ts`.

First extend the import at the top of the spec to include the new symbols (keep whatever it already imports):
```ts
import {
  toInternalReports,
  toNekorektenReports,
  mergeReports,
  type RiskReport,
} from './cod-risk.helpers';
```

Then append:
```ts
describe('toInternalReports', () => {
  it('maps returned events to internal RiskReports (ISO date), filtering non-returned', () => {
    const out = toInternalReports(
      [
        { createdAt: new Date('2026-06-01T10:00:00.000Z'), phone: '+359888111222', type: 'returned' },
        { createdAt: new Date('2026-06-02T10:00:00.000Z'), phone: '+359888111222', type: 'reported' },
      ],
      '+359888000000',
    );
    expect(out).toEqual([
      { source: 'internal', date: '2026-06-01T10:00:00.000Z', phone: '+359888111222', description: 'Върната/невзета COD пратка' },
    ]);
  });

  it('falls back to the lookup phone + null date when the event lacks them', () => {
    expect(toInternalReports([{ createdAt: null, phone: null, type: 'returned' }], '+359888000000')[0]).toMatchObject({
      phone: '+359888000000',
      date: null,
    });
  });
});

describe('toNekorektenReports', () => {
  it('maps nekorekten reports to the unified shape', () => {
    expect(
      toNekorektenReports({
        configured: true,
        found: true,
        count: 1,
        reports: [{ date: '2026-05-01', phone: '+359888111222', description: 'Лош клиент' }],
      }),
    ).toEqual([{ source: 'nekorekten', date: '2026-05-01', phone: '+359888111222', description: 'Лош клиент' }]);
  });
});

describe('mergeReports', () => {
  it('concatenates internal first, then external', () => {
    const i: RiskReport[] = [{ source: 'internal', date: null, phone: 'a', description: 'x' }];
    const e: RiskReport[] = [{ source: 'nekorekten', date: null, phone: 'b', description: 'y' }];
    expect(mergeReports(i, e)).toEqual([...i, ...e]);
  });
  it('handles empty inputs', () => {
    expect(mergeReports([], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @fermeribg/api exec jest cod-risk.helpers --silent`
Expected: FAIL — `toInternalReports` / `toNekorektenReports` / `mergeReports` not exported.

- [ ] **Step 3: Implement** — append to `cod-risk.helpers.ts` (after the existing exports; `NekorektenCheck` + `RiskVerdict` are already defined above in the file):

```ts
/** Unified risk record — our strikes and nekorekten reports share this shape so one
 *  frontend component renders both. `source` is the only discriminator. */
export interface RiskReport {
  source: 'internal' | 'nekorekten';
  date: string | null; // ISO
  phone: string | null;
  description: string | null;
  amountStotinki?: number | null; // internal extra; nekorekten reports omit it
}

export interface RiskCheckResult {
  phone: string | null;
  verdict: RiskVerdict;
  strikes: number;
  nekorektenCount: number;
  nekorektenConfigured: boolean;
  cached: boolean; // true = no nekorekten API call was made this request
  reports: RiskReport[];
}

function toIso(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/** Our returned-COD events → unified reports. Non-`returned` rows are dropped. */
export function toInternalReports(
  events: Array<{ createdAt: Date | string | null; phone: string | null; type: string | null }>,
  phone: string,
): RiskReport[] {
  return events
    .filter((e) => (e.type ?? '') === 'returned')
    .map((e) => ({
      source: 'internal' as const,
      date: toIso(e.createdAt),
      phone: e.phone ?? phone,
      description: 'Върната/невзета COD пратка',
    }));
}

/** nekorekten reports → unified reports. */
export function toNekorektenReports(nk: NekorektenCheck): RiskReport[] {
  return nk.reports.map((r) => ({
    source: 'nekorekten' as const,
    date: r.date,
    phone: r.phone,
    description: r.description,
  }));
}

/** Internal records first, then external. */
export function mergeReports(internal: RiskReport[], external: RiskReport[]): RiskReport[] {
  return [...internal, ...external];
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @fermeribg/api exec jest cod-risk.helpers --silent`
Expected: PASS (existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/cod-risk/cod-risk.helpers.ts server/src/modules/cod-risk/cod-risk.helpers.spec.ts
git commit -m "feat(cod-risk): unified RiskReport shape + pure mappers"
```

---

## Task 2: Local-first `check()` with short-circuit + Redis cache (TDD)

**Files:**
- Modify: `server/src/modules/cod-risk/cod-risk.service.ts`
- Test (new): `server/src/modules/cod-risk/cod-risk.service.spec.ts`

- [ ] **Step 1: Write the failing test** — create `cod-risk.service.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { CodRiskService } from './cod-risk.service';
import { NekorektenClient } from './nekorekten.client';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';

// Chainable mock: select→from→where→orderBy return `this`; the terminal `.limit()`
// resolves. check() runs two queries, both ending in .limit → two mockResolvedValueOnce.
function makeDb() {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn(),
  };
}

describe('CodRiskService.check', () => {
  let svc: CodRiskService;
  let db: ReturnType<typeof makeDb>;
  let nk: { configured: boolean; checkPhone: jest.Mock };
  let cache: { get: jest.Mock; set: jest.Mock };

  beforeEach(async () => {
    db = makeDb();
    nk = { configured: true, checkPhone: jest.fn().mockResolvedValue({ configured: true, found: false, count: 0, reports: [] }) };
    cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
    const mod = await Test.createTestingModule({
      providers: [
        CodRiskService,
        { provide: DB_TOKEN, useValue: db },
        { provide: NekorektenClient, useValue: nk },
        { provide: PublicCacheService, useValue: cache },
      ],
    }).compile();
    svc = mod.get(CodRiskService);
  });

  it('returns empty/ok for an unparseable phone (no DB, no API)', async () => {
    const r = await svc.check('abc');
    expect(r.phone).toBeNull();
    expect(r.verdict).toBe('ok');
    expect(nk.checkPhone).not.toHaveBeenCalled();
  });

  it('short-circuits nekorekten when our strikes already flag high', async () => {
    db.limit
      .mockResolvedValueOnce([{ strikes: 2 }])
      .mockResolvedValueOnce([{ createdAt: new Date('2026-06-01T00:00:00.000Z'), phone: '+359888111222', type: 'returned' }]);
    const r = await svc.check('0888111222');
    expect(nk.checkPhone).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(r.verdict).toBe('high');
    expect(r.cached).toBe(true);
    expect(r.reports.every((x) => x.source === 'internal')).toBe(true);
    expect(r.reports).toHaveLength(1);
  });

  it('serves nekorekten from cache without calling the API', async () => {
    db.limit.mockResolvedValueOnce([{ strikes: 0 }]).mockResolvedValueOnce([]);
    cache.get.mockResolvedValueOnce({ configured: true, found: true, count: 1, reports: [{ date: '2026-05-01', phone: '+359888111222', description: 'лош' }] });
    const r = await svc.check('0888111222');
    expect(nk.checkPhone).not.toHaveBeenCalled();
    expect(r.cached).toBe(true);
    expect(r.nekorektenCount).toBe(1);
    expect(r.reports).toEqual([{ source: 'nekorekten', date: '2026-05-01', phone: '+359888111222', description: 'лош' }]);
  });

  it('calls + caches nekorekten on a cache miss', async () => {
    db.limit.mockResolvedValueOnce([{ strikes: 0 }]).mockResolvedValueOnce([]);
    cache.get.mockResolvedValueOnce(null);
    nk.checkPhone.mockResolvedValueOnce({ configured: true, found: true, count: 1, reports: [{ date: '2026-05-02', phone: '+359888111222', description: 'x' }] });
    const r = await svc.check('0888111222');
    expect(nk.checkPhone).toHaveBeenCalledWith('+359888111222');
    expect(cache.set).toHaveBeenCalled();
    expect(r.cached).toBe(false);
    expect(r.verdict).toBe('caution');
  });

  it('does not cache an unconfigured nekorekten result', async () => {
    db.limit.mockResolvedValueOnce([{ strikes: 0 }]).mockResolvedValueOnce([]);
    cache.get.mockResolvedValueOnce(null);
    nk.checkPhone.mockResolvedValueOnce({ configured: false, found: false, count: 0, reports: [] });
    const r = await svc.check('0888111222');
    expect(cache.set).not.toHaveBeenCalled();
    expect(r.nekorektenConfigured).toBe(false);
    expect(r.reports).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm --filter @fermeribg/api exec jest cod-risk.service --silent`
Expected: FAIL — current `check()` always calls `checkPhone` / returns the old shape.

- [ ] **Step 3: Implement** — edit `cod-risk.service.ts`.

3a. Imports — change the drizzle import to add `desc`, add `PublicCacheService`, and extend the helpers import:
```ts
import { and, eq, sql, desc } from 'drizzle-orm';
```
```ts
import { PublicCacheService } from '../../common/cache/public-cache.service';
import {
  normalizePhone,
  riskVerdict,
  isReturnedStatus,
  buildReportText,
  toInternalReports,
  toNekorektenReports,
  mergeReports,
  type NekorektenCheck,
  type RiskCheckResult,
} from './cod-risk.helpers';
```
(Drop `RiskVerdict` from the import if it becomes unused after the rewrite; keep `isReturnedStatus`/`buildReportText` — still used by the other methods.)

3b. Add the cache to the constructor + cache constants above the class:
```ts
const NK_CACHE_PREFIX = 'codrisk:nk:';
const NK_CACHE_TTL = 7 * 24 * 3600; // 7 days
```
```ts
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly nekorekten: NekorektenClient,
    private readonly cache: PublicCacheService,
  ) {}
```

3c. Replace the whole `check()` method with:
```ts
  /** Combined risk view for a phone — OUR DB first, then nekorekten only when needed
   *  (short-circuit when our strikes already flag `high`; otherwise a 7d Redis cache
   *  means at most one API call per phone per week). Our records + theirs come back in
   *  one unified `reports[]` shape. */
  async check(rawPhone: string): Promise<RiskCheckResult> {
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      return {
        phone: null,
        verdict: 'ok',
        strikes: 0,
        nekorektenCount: 0,
        nekorektenConfigured: this.nekorekten.configured,
        cached: true,
        reports: [],
      };
    }

    // Our DB first: strike count + the phone's returned-COD events (newest first).
    const [strikeRows, events] = await Promise.all([
      this.db.select({ strikes: codRisk.strikes }).from(codRisk).where(eq(codRisk.phone, phone)).limit(1),
      this.db
        .select({ createdAt: codRiskEvents.createdAt, phone: codRiskEvents.phone, type: codRiskEvents.type })
        .from(codRiskEvents)
        .where(and(eq(codRiskEvents.phone, phone), eq(codRiskEvents.type, 'returned')))
        .orderBy(desc(codRiskEvents.createdAt))
        .limit(20),
    ]);
    const strikes = strikeRows[0]?.strikes ?? 0;

    let nk: NekorektenCheck;
    let cached: boolean;
    if (riskVerdict(strikes, 0) === 'high') {
      // Already flagged by our own strikes — don't spend nekorekten quota.
      nk = { configured: this.nekorekten.configured, found: false, count: 0, reports: [] };
      cached = true;
    } else {
      const key = `${NK_CACHE_PREFIX}${phone}`;
      const hit = await this.cache.get<NekorektenCheck>(key).catch(() => null);
      if (hit) {
        nk = hit;
        cached = true;
      } else {
        nk = await this.nekorekten.checkPhone(phone);
        cached = false;
        // Only cache a real (configured) answer — failures degrade to empty and must retry.
        if (nk.configured) await this.cache.set(key, nk, NK_CACHE_TTL).catch(() => undefined);
      }
    }

    return {
      phone,
      verdict: riskVerdict(strikes, nk.count),
      strikes,
      nekorektenCount: nk.count,
      nekorektenConfigured: nk.configured,
      cached,
      reports: mergeReports(toInternalReports(events, phone), toNekorektenReports(nk)),
    };
  }
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm --filter @fermeribg/api exec jest cod-risk.service --silent`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/cod-risk/cod-risk.service.ts server/src/modules/cod-risk/cod-risk.service.spec.ts
git commit -m "feat(cod-risk): local-first check — short-circuit + 7d Redis cache + unified reports"
```

---

## Task 3: Verify

**Files:** none.

- [ ] **Step 1: Typecheck** — `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json` → exit 0.
- [ ] **Step 2: Lint** — `pnpm --filter @fermeribg/api exec eslint "src/modules/cod-risk/**/*.ts"` → exit 0.
- [ ] **Step 3: Full suite** — `pnpm --filter @fermeribg/api exec jest --silent` → all green (prior + new cod-risk.service + helper tests).
- [ ] **Step 4: Boot smoke (optional)** — boot `:3100` (`DATABASE_URL="postgresql://farmflow:fermeribg@localhost:5433/farmflow" node server/dist/main.econt.js` after `pnpm --filter @fermeribg/api build`) and `GET /shipping/risk/check?phone=0888123456` with a token → 200 with `{ verdict, reports, cached, … }`; no token → 401. Stop the server after.
- [ ] **Step 5: Commit any fixups** — `git add -A && git commit -m "chore(cod-risk): verification green" || echo "nothing to commit"`.

---

## Self-review checklist

- **Spec coverage:** local-first (Task 2 parallel DB reads) · short-circuit (Task 2) · Redis cache 7d (Task 2) · unified shape (Task 1) · degrade/unconfigured (Task 2 test) · no migration / write-path untouched (only `check()` changed). ✓
- **Type consistency:** `RiskReport`/`RiskCheckResult`/`NekorektenCheck` shared between helpers, service, and tests; cache `get<T>`/`set(key,val,ttl)` match `PublicCacheService`; `desc` imported.
- **Money:** `amountStotinki` optional, unused this round (events carry no amount) — left undefined, not faked.
