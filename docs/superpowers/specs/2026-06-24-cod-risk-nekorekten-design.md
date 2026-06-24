# COD-risk system + nekorekten integration — design

**Date:** 2026-06-24
**Status:** Approved for planning
**Branch:** `feat/econt-standalone-service` (extends the standalone Econt backend)

## Vision

Make the standalone Econt shipping app protect producers from the #1 cost of
cash-on-delivery (наложен платеж) selling in Bulgaria: **customers who refuse or
don't collect COD parcels** (a refused COD parcel costs the farmer return shipping +
lost time). Two complementary layers:

- **A — Our own COD-risk system** (central, cross-tenant): every refused/returned COD
  parcel detected from Econt status increments a strike against that customer's phone.
  This grows with every farmer on the platform (network effect) and is a GDPR-clean,
  dependency-free signal we fully own.
- **B — nekorekten.com bridge** (the established Bulgarian bad-COD-customer registry):
  **check** a phone before shipping, and **report** confirmed bad payers back to the
  registry. Both directions run through a single **platform-wide** nekorekten account
  (the farmers are not expected to register there themselves).

## nekorekten.com API (researched)

Operator ЧЕК ЕНД ПРОТЕКТ ООД. Documented REST API, base `https://api.nekorekten.com`,
docs `https://nekorekten.com/bg/api/doc`. Auth = `Api-Key: <40-char>` header **+ server
IP whitelist** (configured in the nekorekten dashboard). Tiers: Free 30 req/day (5/min),
Start €3 100/day, Standard €6 300/day, Business €10 1000/day.

- **Check (read):** `GET /api/v1/reports?phone={p}&searchMode=one-of` → list of reports
  (reporter, date, contacts, description, files, cityID, refutations).
- **Report (write):** `POST /api/v1/reports` — `text` required; optional `phone`,
  `email`, `firstName`, `lastName`, `siteUrl`, `facebookUrl`, `cityID`, `files[]`.
  Files via `POST /api/v1/files` (JPEG/PNG → ids). Cities via `GET /api/v1/cities`.
- Field/response shapes are from the **docs, not a live payload** → code defensively;
  confirm exact JSON with a real key in a spike before prod.

## Key decisions (resolved in brainstorming)

| Decision | Choice |
| --- | --- |
| Whose nekorekten account | **One platform-wide key** (ours). All checks + reports under our name. Farmers don't touch nekorekten. |
| Where the key lives | **Env** `NEKOREKTEN_API_KEY` (single platform secret, like other platform creds). Not per-tenant. **Provisioned later** (ops); code degrades gracefully when absent. |
| On risk at ship time | **Warn, never hard-block.** Show the risk (our strikes + nekorekten reports); the farmer decides. Avoids false-positive lockouts + automated-decision GDPR issues. |
| Reporting to nekorekten | **Confirm-then-report.** Auto-detect a returned COD → create an internal candidate → the farmer taps "Докладвай" to confirm a real refusal → we POST under the platform name. No auto-firing (protects our account reputation + GDPR; never report ambiguous "wrong address" failures). |
| Our own strike system | Always-on, central, cross-tenant — independent of nekorekten (works during its downtime, GDPR-clean fallback). |

## Architecture

A new module `server/src/modules/cod-risk/` with one service (`CodRiskService`) and a
thin nekorekten client (`NekorektenClient`). Wired into both apps via the existing
`EcontCoreModule` path so the standalone app and (later) FarmFlow can consume it. The
strike-detection hooks into the **existing** Econt 30-min refresh cron — no new cron.

### Data model (one migration — **0056**)

- **`cod_risk`** — one row per normalized phone: `phone` (PK/unique, normalized),
  `strikes int default 0`, `lastEventType text`, `lastEventAt timestamptz`,
  `createdAt`, `updatedAt`. Cross-tenant (the registry is platform-wide on purpose).
- **`cod_risk_events`** — append-only audit: `id`, `phone`, `tenantId`, `shipmentId`,
  `type` (`returned` | `refused` | `reported`), `createdAt`. Feeds the strike count +
  gives provenance for a report.
- **`shipments.reportStatus text`** (`none` default | `candidate` | `reported` |
  `refuted`) — tracks a shipment's nekorekten reporting lifecycle so a returned COD
  surfaces as a candidate exactly once and can't be double-reported.

Phone normalization (BG: `0XXXXXXXXX` ↔ `+359XXXXXXXXX`) is a **pure exported
function** (unit-tested) used by every read/write/strike path so checks and strikes
always key identically.

### Components

- **`normalizePhone(raw)`** — pure; canonical BG phone (or null if unparseable).
- **`NekorektenClient`** — `checkPhone(phone)`, `reportPhone({phone,text,name?,cityId?,fileIds?})`,
  `getCities()`, `uploadFile(buf)`. Reads `NEKOREKTEN_API_KEY`; if unset, `checkPhone`
  returns `{configured:false, found:false, reports:[]}` and `reportPhone` throws a clear
  "nekorekten не е конфигуриран". 8s timeout; never throws on network error for reads
  (returns empty). Defensive response parsing (`parseReports`, pure + tested).
- **`CodRiskService`** —
  - `check(phone)` → `{ phone, internalStrikes, nekorekten: {configured, found, count, reports[]}, verdict: 'ok'|'caution'|'high' }` (verdict is a pure helper combining internal strikes + nekorekten count against thresholds).
  - `recordReturn(tenantId, shipmentId, phone, type)` → upsert `cod_risk` (+1 strike), insert `cod_risk_events`, set `shipments.reportStatus='candidate'` — idempotent per shipment.
  - `listCandidates(tenantId)` → returned-COD shipments awaiting a report decision.
  - `confirmReport(tenantId, shipmentId)` → builds the report text from the shipment, POSTs to nekorekten **inline**, sets `reportStatus='reported'` + records a `reported` event on success. On nekorekten failure it throws a clear Bulgarian error and leaves `reportStatus='candidate'` so the farmer can retry — no queue/processor for v1 (report volume is low; the candidate is the durable retry state).

### Detection hook

In the existing Econt refresh path (`refreshStatus` / `refreshActiveShipments`), when a
COD shipment (`codAmountStotinki != null`) transitions to a returned/refused UI status,
call `recordReturn(...)`. Needs a `uiShipmentStatus` value for returned/refused — today
`uiShipmentStatus` only emits pending/created/shipped/delivered, so add detection of the
Econt "върната/отказана" status strings (extend the classifier; keep existing outputs).
Idempotent via `reportStatus` (only the first transition creates a candidate/strike).

### Endpoints (standalone app `/shipping`, JWT + tenant-scoped)

- `GET /shipping/risk/check?phone=` → `CodRiskService.check`.
- `GET /shipping/risk/candidates` → `listCandidates` (returned COD awaiting report).
- `POST /shipping/risk/reports/:shipmentId` → `confirmReport` (tenant-scoped: the
  shipment must belong to the caller).

The manual-create flow does **not** block on risk; the frontend (next plan) calls
`/risk/check` and shows a warning banner. A returned COD becomes a candidate via the
cron, surfaced by `/risk/candidates`.

## Cross-cutting

- **Graceful degradation:** nekorekten errors/absence never block shipping or the cron.
  `check` returns internal-only data; `recordReturn` always runs (internal system is the
  source of truth). A report failure surfaces to the farmer (candidate kept for retry);
  the cron's strike detection never throws.
- **GDPR:** legitimate-interest basis; disclose the check + reporting in the privacy
  policy; warn-not-block (no solely-automated adverse decision); only report
  farmer-confirmed real refusals; never auto-report ambiguous failures.
- **Tenant isolation:** every endpoint resolves the shipment by `(id, tenantId)`. The
  `cod_risk` registry itself is intentionally cross-tenant (read by all, the network
  effect), but write provenance (`cod_risk_events.tenantId`) is recorded.
- **i18n:** Bulgarian strings.

## Testing

- `normalizePhone` (0/+359/garbage), `riskVerdict` thresholds, `parseReports` (defensive
  shapes incl. null/empty), the extended status classifier (returned/refused), and
  `recordReturn` idempotency (pure parts unit-tested; I/O methods thin). Follow the
  existing `econt.service.spec.ts` style.

## Spike (before prod)

With a real `NEKOREKTEN_API_KEY` (+ whitelisted server IP), confirm the live JSON of
`GET /reports` and `POST /reports` against `parseReports` / the report payload, and the
`cities` shape. Adjust the defensive parsers if fields differ.

## Out of scope

- Frontend (risk badge at create, "Докладвай" button, candidates screen) — next plan.
- Per-tenant nekorekten keys (platform key only for now).
- Auto-reporting without confirmation; hard-blocking shipments on risk.
- Second courier (Speedy), order import, invoicing (separate future features).

## Conventions / gotchas

- Branch `feat/econt-standalone-service`; `main` auto-deploys.
- Build `packages/db` + `packages/types` before the server build.
- `NEKOREKTEN_API_KEY` provisioned later — everything must work (degraded) without it.
- Reuse the existing Econt refresh cron; do not add a new scheduler.
