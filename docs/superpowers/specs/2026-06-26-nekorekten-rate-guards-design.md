# Nekorekten Rate-Limit Guards — Design

**Date:** 2026-06-26
**Branch:** `feat/nekorekten-rate-guards` (from main @9795666, which already has the bulk-check feature)
**Status:** Approved (brainstorming) — ready for implementation

## Goal

Guard outbound Nekorekten API calls against the plan's documented rate limits so we
never silently turn a rate-limited response into a false "Чисто" verdict. When the
limit is hit, show a friendly „опитай след малко" (per-minute) / „опитай утре"
(daily) instead. Limits are **config-driven** (default = free tier) so upgrading the
Nekorekten plan is an env change, not a code change.

## Facts (from nekorekten.com/bg/api/doc + pricing)

- Limits are **plan-dependent**. Current plan = **Free: 5 req/min, 30 checks/day**
  (daily quota effective 01.02.2026). Старт 10/100, Стандарт 20/300, Бизнес 60/1000.
- Limits are **per API key** → our single platform key means the budget is **global**
  (shared across all tenants and all web replicas), NOT per-tenant.
- The API does **not** expose dynamic remaining quota (no `X-RateLimit-*` headers, no
  documented 429 body). So "let the API report it" is only possible as the documented
  constant → we encode it as config, default to free.
- Auth header `Api-Key`. GET `/api/v1/reports?phone=&searchMode=one-of`. searchMode
  `all`|`one-of`.

## Config (env) — `server/src/config/env.validation.ts`

```ts
NEKOREKTEN_RATE_PER_MIN: Joi.number().min(1).max(1000).default(5),
NEKOREKTEN_DAILY_QUOTA:  Joi.number().min(1).max(100000).default(30),
```
Upgrading plan = bump these two env vars. Document in the spec + a code comment.

## Global rate limiter — `server/src/modules/cod-risk/nekorekten-rate-limiter.ts` (new)

`@Injectable() NekorektenRateLimiter` injecting `@Inject(REDIS_TOKEN) redis: Redis`
(`server/src/common/redis/redis.constants.ts`) + `ConfigService`. Model the atomic
EVAL pattern on `server/src/common/throttler/redis-throttler.storage.ts`.

- Keys (global, NOT tenant-scoped): `nk:rl:min:<SofiaYYYYMMDDHHmm>` and
  `nk:rl:day:<SofiaYYYY-MM-DD>`. Sofia date/time via
  `Intl.DateTimeFormat('en-CA',{ timeZone:'Europe/Sofia', ... })` (DST-correct).
- `async reserve(): Promise<{ ok: boolean; limit: 'minute'|'day'|null; retryAfterSeconds: number }>`
  — one atomic Lua script:
  ```
  local m = redis.call('INCR', minKey); if m==1 then redis.call('EXPIRE', minKey, 60) end
  local d = redis.call('INCR', dayKey); if d==1 then redis.call('EXPIRE', dayKey, daySec) end
  if d > dayCap then redis.call('DECR', minKey); redis.call('DECR', dayKey)
     return {0,'day', redis.call('TTL', dayKey)} end
  if m > minCap then redis.call('DECR', minKey); redis.call('DECR', dayKey)
     return {0,'minute', redis.call('TTL', minKey)} end
  return {1,'',0}
  ```
  `daySec` = seconds until next Sofia midnight (compute in JS, pass in). Day checked
  before minute so an exhausted daily quota reports „утре" not „след малко".
- `async refund(): Promise<void>` — `DECR` both keys (best-effort, floor at 0 via the
  natural INCR/DECR balance; guard against going negative is unnecessary because we
  only refund a reservation we made). Used when a reserved call did NOT reach a real
  answer (network/timeout/5xx) so quota isn't wasted on a non-answer.
- If Redis itself errors, `reserve()` returns `{ ok:true }` (fail-open — don't block
  checks on a cache outage; the per-key limit on Nekorekten's side is the backstop).

## Client — `server/src/modules/cod-risk/nekorekten.client.ts`

Extend `NekorektenCheck` (in `cod-risk.helpers.ts`) with:
```ts
status: 'ok' | 'not_found' | 'rate_limited' | 'unavailable' | 'unconfigured';
retryAfterSeconds?: number;
```
(Keep `configured/found/count/reports` for back-compat.)

Inject `NekorektenRateLimiter`. New flow in `checkPhone`:
1. No key → `{ status:'unconfigured', configured:false, found:false, count:0, reports:[] }`.
2. `const r = await limiter.reserve()`. If `!r.ok` → return WITHOUT fetching:
   `{ status:'rate_limited', retryAfterSeconds:r.retryAfterSeconds, configured:true, found:false, count:0, reports:[] }`.
3. fetch. Then:
   - HTTP 429 → keep the reservation (we did hit their limit); read `Retry-After`
     header if present else default to seconds-to-next-minute; return
     `{ status:'rate_limited', retryAfterSeconds, ... }`.
   - network error / timeout / 5xx / other non-ok → `await limiter.refund()`; return
     `{ status:'unavailable', ... }`.
   - 200 → parse; `status = count>0 ? 'ok' : 'not_found'`. Reservation consumed.

## Service — `server/src/modules/cod-risk/cod-risk.service.ts`

- **Remove** the per-tenant budget block + constants `MAX_LIVE_CALLS` and
  `DAILY_NK_BUDGET` and the `nk:budget:*` PublicCacheService logic — the global
  limiter replaces them. Keep `FLAGGED_TTL`, `CLEAN_TTL`, `BULK_CAP`, `CONCURRENCY`.
- `RiskCheckResult` (helpers) gains optional `nkStatus?: NekorektenCheck['status']`
  and `retryAfterSeconds?: number`.
- `check()`:
  - On `nk.status === 'rate_limited'` or `'unavailable'`: do **NOT** persist (no
    `nk_checked_at` write — never cache a non-answer as clean). Serve the existing DB
    snapshot if the row already has `nk_*` (verdict from stored count); else fall back
    to internal-strikes-only verdict. Set `nkStatus` + `retryAfterSeconds` on the
    result. `cached` stays true (no successful live write).
  - On `ok`/`not_found`: persist as today (upsert nk_* + nk_checked_at). `nkStatus`
    set accordingly.
  - `skipApi` path unchanged → `nkStatus` omitted/`cached`.
- `checkBulk(tenantId, phones)` → return shape changes to:
  ```ts
  { results: BulkRiskResult[]; meta: { checked: number; rateLimited: number;
    limit: 'minute'|'day'|null; retryAfterSeconds: number } }
  ```
  - `BulkRiskResult` gains `status: 'ok'|'caution'|'high'|'rate_limited'|'unavailable'`
    (verdict for answered, or the non-answer status) + `retryAfterSeconds?`.
  - Dedupe + bounded concurrency as today. Cached/local phones are free + instant.
  - **Stop-on-limit (chosen behavior A):** the first time a `check()` comes back
    `rate_limited`, set a `stopped` flag + capture `limit`/`retryAfterSeconds`; all
    not-yet-processed unique phones are emitted as `status:'rate_limited'` WITHOUT
    calling `check()` (pass `skipApi:true` so they only read DB/local — a stale DB hit
    still yields a verdict; a never-checked phone yields `rate_limited`). Map results
    back to all inputs (incl. duplicates) as today.
  - `meta.checked` = phones that got a real verdict this run; `meta.rateLimited` =
    phones returned as rate_limited; `meta.limit`/`retryAfterSeconds` from the first
    limit hit.

## Controller — `econt-standalone.controller.ts`

`riskCheckBulk` returns the new `{ results, meta }` object (pass-through). Throttle +
ActivationGuard unchanged. `GET risk/check` returns the richer `RiskCheckResult`
(now with optional `nkStatus`/`retryAfterSeconds`) — no signature change.

## Frontend — make it look good

### `delivery-web/src/lib/api-client.ts`
- `RiskBulkEntry` gains `status: 'ok'|'caution'|'high'|'rate_limited'|'unavailable'`
  and `retryAfterSeconds?: number`.
- `riskCheckBulk` return type → `{ results: RiskBulkEntry[]; meta: { checked: number;
  rateLimited: number; limit: 'minute'|'day'|null; retryAfterSeconds: number } }`.

### `delivery-web/src/components/import-client.tsx`
- `checkAllRisk` consumes `{ results, meta }`; map `results` to rows (unchanged keying),
  store `meta` in state.
- **RiskBadge**: add two non-verdict states, visually distinct from risk verdicts:
  - `rate_limited` → neutral/amber pill, **Clock** icon (lucide), label „Изчакай"
    (tooltip „Лимит на Nekorekten — опитай пак след малко"). Muted, not alarming.
  - `unavailable` → grey pill, **CloudOff**/**WifiOff** icon, label „Няма връзка".
  - Keep the 3 verdict styles (RISK_VERDICT) exactly.
- **Banner** above the table when `meta.rateLimited > 0`: a calm info banner (amber-soft
  bg, rounded, Clock/Info icon), text:
  - per-minute: „Проверени {checked} от {total}. Достигнат лимитът на Nekorekten
    (безплатен план: 5/мин, 30/ден). Останалите {rateLimited} — опитай пак след ~{N}с."
    with a live ticking countdown (setInterval, clears at 0, re-enables the button).
  - daily: „…изчерпан дневен лимит — опитай пак утре." (no countdown, or show hours).
- Disable the „Провери всички" button while a per-minute countdown is active; re-enable
  at 0. Keep the manual nekorekten.com/bg link.
- Summary line keeps high-count, plus „· {rateLimited} изчакват" when present.
- Polish: consistent pill sizing/spacing with existing badges, lucide icons, Bulgarian
  copy matching the app, no layout shift when badges appear, mobile cards updated too.

## Tests
- Limiter: reserve allows up to cap then denies with correct `limit`+`retryAfterSeconds`;
  day checked before minute; refund decrements; Redis-error → fail-open. Mock ioredis
  `eval`/`decr`.
- Client: limiter-deny → no fetch, status rate_limited; HTTP 429 → rate_limited +
  Retry-After parse; 5xx/network → unavailable + refund called; 200 count>0 → ok;
  200 count0 → not_found.
- Service: rate_limited/unavailable → not persisted, serves DB snapshot, sets nkStatus;
  checkBulk stop-on-limit marks remaining rate_limited + correct meta; ok path persists.
- Update existing checkBulk tests to the new `{ results, meta }` shape + drop the
  removed budget tests.

## Out of scope / unchanged
- No DB migration (limiter is Redis-only; nk_* columns from 0061 reused).
- Report flow (`confirmReport`/`recordReturnIfApplicable`) unchanged.
- No background drain / auto-retry (chosen behavior A = stop + user retries).

## Constants
`RATE_PER_MIN`/`DAILY_QUOTA` from env. Keep `CONCURRENCY=5`, `BULK_CAP=500`.
