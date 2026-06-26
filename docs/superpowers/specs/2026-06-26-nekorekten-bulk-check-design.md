# Nekorekten Bulk Check (one-click) + Durable DB Store — Design

**Date:** 2026-06-26
**Branch:** `main` (delivery service)
**Status:** Approved (brainstorming) — ready for implementation plan

## Goal

In the delivery / waybill (товарителница) import flow, give the operator **one button** that checks **every phone in the imported batch** against the Nekorekten registry + our own COD-risk data, annotating each row with a risk verdict. Beside it, a link to check **manually** at https://nekorekten.com/bg/ (same information, two ways).

This is a **bulk CHECK (lookup)**, not a report. The existing per-shipment "Докладвай" (report) flow stays unchanged.

## Cost/quality strategy (the core decision)

Nekorekten free tier is scarce (~30 reads/day). Optimize spend with an **asymmetric, lazy, durable** approach:

1. **Persist results in our DB** (durable), not only in Redis. Survives restart/eviction; builds our own dataset ("записваме при нас"). Replaces the current 7-day Redis nekorekten cache.
2. **Adaptive TTL by verdict** — a flagged phone rarely "heals", a clean phone can turn bad:
   - `nk_found = true` (has reports) → `FLAGGED_TTL = 90 days`.
   - `nk_found = false` (clean / not-found) → `CLEAN_TTL = 30 days`.
3. **Lazy refresh (on-access only)** — re-query Nekorekten only when a phone is checked again past its TTL. No background cron sweeping the whole registry (that would waste quota on phones nobody is processing).
4. **Local-first short-circuit** — if our own `cod_risk.strikes` already make the verdict `high`, skip Nekorekten entirely (0 API calls).
5. **Batch dedupe** — one import file with duplicate phones → one API call per unique unknown phone.
6. **Manual "Провери наново"** — force-refresh a single phone regardless of TTL (for on-demand correction).

Net: at most **one Nekorekten call per unique unknown phone per TTL window**; flagged phones essentially never re-queried; the FIRST lookup of a genuinely unknown phone is unavoidable (you must ask to learn "not found").

## Data model — migration `0060`

Add durable Nekorekten snapshot columns to existing `cod_risk` (keyed by `phone`, cross-tenant):

```sql
ALTER TABLE cod_risk ADD COLUMN nk_found       BOOLEAN;
ALTER TABLE cod_risk ADD COLUMN nk_count       INTEGER;
ALTER TABLE cod_risk ADD COLUMN nk_reports     JSONB;        -- raw NekorektenReport[]
ALTER TABLE cod_risk ADD COLUMN nk_checked_at  TIMESTAMPTZ;  -- NULL = never checked
```

`cod_risk` already auto-creates a row per phone on a strike; bulk-check must **upsert** a row for phones with no prior strike (strikes default 0) to store the nekorekten snapshot. `schema.ts` updated to match.

## Backend

### `CodRiskService.check(rawPhone, opts?)` — rewrite the nekorekten side
1. `normalizePhone`. Null → empty `ok`.
2. Load our `cod_risk` row (`strikes`, `nk_*`) + recent `cod_risk_events` (as today).
3. `internalVerdict = riskVerdict(strikes, 0)`. If `high` → short-circuit, serve local-only (`cached=true`, no nekorekten).
4. Else decide freshness from DB row:
   - `fresh = nk_checked_at != null && age < ttlFor(nk_found)` where `ttlFor(found) = found ? FLAGGED_TTL : CLEAN_TTL`.
   - `opts.forceRefresh` (manual re-check) overrides `fresh = false`.
   - `fresh` → serve `nk_*` from DB (0 API). `cached=true`.
   - stale/never → `nk = await nekorekten.checkPhone(phone)`; if `nk.configured` && call ok → **upsert** `cod_risk` row setting `nk_found=nk.found`, `nk_count=nk.count`, `nk_reports=nk.reports`, `nk_checked_at=now`. `cached=false`.
5. Build unified `reports = mergeReports(toInternalReports(events,phone), toNekorektenReports(nk))`.
6. Return existing shape `{ phone, verdict, strikes, nekorektenCount, nekorektenConfigured, cached, reports }`.

Single-phone `GET /shipping/risk/check?phone=` gains optional `&refresh=1` → `opts.forceRefresh`.

Redis nekorekten cache (`codrisk:nk:<phone>`) removed — DB is the durable store.

### New: `CodRiskService.checkBulk(phones: string[])`
- Normalize + **dedupe** → unique phones.
- Map each unique phone through `check()` (reuses all logic above incl. DB persistence + adaptive TTL).
- Return `Array<{ phone, normalized, verdict, strikes, nekorektenCount, cached }>` keyed so the frontend can match input phones (including duplicates) back to a verdict.
- Cap batch size (e.g. 500) to bound quota burst; if a batch would exceed, process unique phones only and report how many API calls were spent.

### Controller (`econt-standalone.controller.ts`)
- `POST /shipping/risk/check-bulk` — JWT + `ActivationGuard` + Throttle (e.g. 5/min). Body `{ phones: string[] }` → `checkBulk`.
- Existing `GET /shipping/risk/check` — add optional `refresh` query passthrough.

## Frontend (`delivery-web`)

### `src/lib/api-client.ts`
- `riskCheckBulk(phones: string[])` → `POST /bff/shipping/risk/check-bulk`.
- `riskCheck(phone, { refresh })` → add `&refresh=1`.

### `src/components/import-client.tsx`
- Button **„Провери всички в Nekorekten"** above the staged rows → collects phones from rows → `riskCheckBulk` → maps verdict back onto each row.
- Per-row risk badge: Чисто / Внимание / Висок риск (reuse the verdict badge styling from `cod-risk-client.tsx`).
- Beside the button: link **„или провери ръчно на nekorekten.com/bg ↗"** (`target=_blank`, `rel=noopener`).
- Summary line: „X високорискови от Y проверени · Z заявки изхарчени".
- Spinner during the call; degrade-safe banner if `NEKOREKTEN_API_KEY` unconfigured (verdicts show local-only).

## Out of scope / unchanged
- `recordReturnIfApplicable`, `listCandidates`, `confirmReport` (the report flow) — unchanged.
- No new secret (`NEKOREKTEN_API_KEY` already optional, degrade-safe).
- No background cron.

## Testing
- Pure helpers already unit-tested; add tests for `checkBulk` dedupe + `ttlFor` adaptive freshness + force-refresh override.
- Service tests: stale → API + upsert; fresh → no API; `high` strikes → short-circuit; unconfigured key → degrade.
- Frontend: button maps verdicts to rows; manual link href correct.

## Constants
`FLAGGED_TTL = 90*24*3600`, `CLEAN_TTL = 30*24*3600`, `BULK_CAP = 500`.
