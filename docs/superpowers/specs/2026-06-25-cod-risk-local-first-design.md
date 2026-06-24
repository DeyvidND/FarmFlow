# COD-Risk Local-First + Unified Shape — Design

**Date:** 2026-06-25
**Branch:** `feat/econt-standalone-service`
**Status:** Approved (brainstorming) — ready for implementation plan

## Goal

Make the COD-risk phone check **local-first and quota-thrifty**: read our own data first, only call the rate-limited nekorekten.com API when needed (and at most once per phone per cache window), and return our records and theirs in **one unified report shape** so a single frontend component renders both.

## Context (as-built)

`CodRiskService.check(rawPhone)` (`server/src/modules/cod-risk/cod-risk.service.ts`):
- reads our `cod_risk.strikes` for the phone, then **always** calls `nekorekten.checkPhone()` (one external call every check), and
- returns `{ phone, internalStrikes: number, nekorekten: NekorektenCheck, verdict }` — our side is a bare count, their side is `NekorektenCheck { configured, found, count, reports: NekorektenReport[] }`. Two different shapes → can't share a component.

`nekorekten.com` free tier is ~30 reads/day. Every `check` spends one. `cod_risk` (our strikes, cross-tenant) and `cod_risk_events` (append-only provenance: `type`, `phone`, `tenantId`, `shipmentId`, `createdAt`) already persist our reports. `PublicCacheService` (Redis; `get<T>`, `set(key,val,ttlSeconds)`, `del(...keys)`) is `@Global`.

## Decisions (from brainstorming)

1. **Our reports stay in our DB** (`cod_risk` + `cod_risk_events`, unchanged write path). **Their data is Redis-cached** (no DB migration / durable mirror). **Short-circuit** skips their API when our strikes already flag the phone `high`.
2. **Unified `RiskReport` shape** — our records and theirs map to the same fields so the frontend uses one component.
3. **No migration.**

## Flow — `check(rawPhone)`

1. `normalizePhone`. If null → return empty/`ok`.
2. **Our DB first (parallel):** load `cod_risk.strikes` for the phone AND the phone's `cod_risk_events` of `type='returned'` (newest first, cap 20).
3. `internalStrikes` + `internalVerdict = riskVerdict(internalStrikes, 0)`.
4. Decide the nekorekten side:
   - **Short-circuit:** if `internalVerdict === 'high'` → do NOT touch nekorekten (skip Redis + API). `nk = empty`, `cached = true` (we deliberately served local-only).
   - Else **Redis** `codrisk:nk:<phone>` (TTL 7d):
     - hit → `nk = cached`, `cached = true` (no API call).
     - miss → `nk = await nekorekten.checkPhone(phone)`; if `nk.configured` and the call succeeded, `SET codrisk:nk:<phone> = nk` (TTL 7d). `cached = false`. (`checkPhone` already never throws — degrades to empty.)
5. Build unified `reports = mergeReports(toInternalReports(events, phone), toNekorektenReports(nk))` (internal first, then nekorekten; each list newest-first).
6. Return `{ phone, verdict: riskVerdict(internalStrikes, nk.count), strikes: internalStrikes, nekorektenCount: nk.count, nekorektenConfigured: nk.configured, cached, reports }`.

Quota effect: a phone is hit at most once per 7 days, and never when our own strikes already say `high`.

## Unified shape + pure helpers (`cod-risk.helpers.ts`)

```ts
export interface RiskReport {
  source: 'internal' | 'nekorekten';
  date: string | null;        // ISO
  phone: string | null;
  description: string | null;
  amountStotinki?: number | null;  // internal only; nekorekten reports omit it
}
```

New pure functions (all unit-tested, no I/O):
- `toInternalReports(events: Array<{ createdAt: Date|string|null; phone: string|null; type: string|null }>, phone: string): RiskReport[]` — map each `type==='returned'` event → `{ source:'internal', date: ISO(createdAt), phone, description: 'Върната/невзета COD пратка' }`. (`amountStotinki` left undefined — the event table doesn't carry it.)
- `toNekorektenReports(nk: NekorektenCheck): RiskReport[]` — map each `NekorektenReport` → `{ source:'nekorekten', date, phone, description }`.
- `mergeReports(internal: RiskReport[], external: RiskReport[]): RiskReport[]` — concat internal-first; stable.

Keep `normalizePhone`, `riskVerdict`, `isReturnedStatus`, `parseReports`, `buildReportText`, `NekorektenReport`, `NekorektenCheck` unchanged.

## Service + wiring

- `CodRiskService` constructor adds `private readonly cache: PublicCacheService` (`@Global`, no module import needed). `check()` rewritten per the flow; `recordReturnIfApplicable`, `listCandidates`, `confirmReport` unchanged.
- `cod-risk.module.ts` — no change (PublicCacheService is global).
- Controller `GET /shipping/risk/check` — unchanged signature; it just returns the new richer object.
- Cache key constant `NK_CACHE_PREFIX = 'codrisk:nk:'`, `NK_CACHE_TTL = 7 * 24 * 3600`.

### check() response type
```ts
{
  phone: string | null;
  verdict: RiskVerdict;
  strikes: number;
  nekorektenCount: number;
  nekorektenConfigured: boolean;
  cached: boolean;            // true = no nekorekten API call this request
  reports: RiskReport[];
}
```
(Replaces the old `{ internalStrikes, nekorekten }` shape. No other caller depends on the old shape — only the standalone controller passes it through.)

## Error handling / degradation

- `nekorekten.checkPhone` already never throws (returns empty on unconfigured/failure) — the cache `SET` only happens on a configured, successful result, so failures aren't cached (next check retries).
- Redis `get`/`set` wrapped so a cache outage falls back to a live call (never breaks the check). A short-circuited `high` phone needs neither.
- Unconfigured nekorekten → `nekorektenConfigured:false`, `reports` = internal only. The check still works (our DB).

## Testing

- `cod-risk.helpers.spec.ts` (extend): `toInternalReports` (returned events → shape, non-returned filtered, ISO dates, null-safe), `toNekorektenReports`, `mergeReports` (order, empties).
- `cod-risk.service.spec.ts` (new or extend): mock DB + `NekorektenClient` + `PublicCacheService`:
  - short-circuit: `internalStrikes>=2` → `nekorekten.checkPhone` NOT called, `reports` internal-only, `verdict:'high'`.
  - cache hit: `cache.get` returns reports → `checkPhone` NOT called, reports merged.
  - cache miss: `cache.get` null → `checkPhone` called once → `cache.set` called → reports merged.
  - unconfigured: `checkPhone` returns `{configured:false,…}` → not cached, internal-only.
  - bad phone → empty/`ok`, no DB/API.

## Out of scope (YAGNI)

DB migration / durable mirror of nekorekten data (Redis cache is the store, per decision); the report-write path (`recordReturnIfApplicable`/`confirmReport`); any frontend; per-tenant nekorekten keys.

## Files

- `server/src/modules/cod-risk/cod-risk.helpers.ts` (+ `.spec.ts`) — `RiskReport` + 3 mappers.
- `server/src/modules/cod-risk/cod-risk.service.ts` (+ `.spec.ts`) — inject cache, rewrite `check()`.
