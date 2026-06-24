# Bulk Import + Live Editor — Design

**Date:** 2026-06-24
**Branch:** `feat/econt-standalone-service`
**Status:** Approved design — ready for implementation plan

## Goal

Let a producer in the standalone delivery service (`:3100`) upload an Excel/CSV file of
recipients, have the file checked (deterministic + AI), review and edit the parsed rows in
a live editor, then create all carrier shipments at once and download labels + waybills —
instead of typing each shipment by hand.

## Scope

In scope:
- Backend: file parse (.xlsx/.csv) → normalize → validate → draft staging → live-edit
  CRUD → bulk create at carrier → bulk label/waybill (reuses existing `getLabelsPdf`).
- AI file check via OpenAI (ChatGPT), server-side, degrade-gracefully.
- Minimal UI served by the standalone Nest at `/app` (Alpine.js from CDN, no build step).

Out of scope (deferred):
- The full standalone Next.js frontend (`econt-web`) — the minimal `/app` UI is the seed.
- Recurring/scheduled imports, import history analytics, undo of a committed batch.
- Smart "create-with-cheapest" auto carrier pick (the quote feature stays separate).

## Architecture

```
upload (.xlsx/.csv)
  → parse (exceljs / papaparse) → normalized rows[]
  → deterministic validation (required fields, BG phone, mode, currency, numeric COD)
  → carrier resolve (Econt: free-text city / Speedy: city→siteId, office→officeId, street→streetId)
  → AI pass (OpenAI: normalize/explain/flag ambiguities) — merged, never authoritative for resolution
  → DRAFT persisted (import_batches + import_rows)
LIVE EDITOR
  GET batch+rows → PATCH a row (re-validate) → DELETE a row
  → POST commit → create shipments for ok rows → stamp shipmentId on each row
  → bulk label + bulk waybill (existing getLabelsPdf with the new shipmentIds)
```

### Components (files, one responsibility each)

- `modules/import/import.parse.ts` — pure: file buffer + mime → `RawRow[]` (header-keyed
  objects). exceljs for `.xlsx`, papaparse for `.csv`. Header aliasing (BG + EN).
- `modules/import/import.normalize.ts` — pure: `RawRow` + batch defaults → `NormalizedRow`
  (typed fields: name, phone, mode, city, office, address, weightGrams, contents,
  codAmountStotinki, declaredValueStotinki, carrier). Currency convert (BGN↔EUR→stotinki).
- `modules/import/import.validate.ts` — pure: `NormalizedRow` → `RowValidation`
  (`ok|warn|error` + `issues[{field,message,suggestion}]`). Deterministic only.
- `modules/import/import.ai.ts` — `ImportAiService`: batch of normalized rows → OpenAI →
  per-row AI verdicts; `mergeAi(validation, aiVerdict)` pure merge. Never throws to caller.
- `modules/import/import.resolve.ts` — `ImportResolveService`: per-carrier location
  resolution (calls EcontService/SpeedyService location lookups), returns `resolvedRefs` +
  ambiguity warnings (candidate lists for the editor dropdowns).
- `modules/import/import.service.ts` — orchestration + draft CRUD + commit. Tenant-scoped.
- `modules/import/import.controller.ts` — standalone endpoints (JWT + ActivationGuard on
  create/commit, mirroring the per-carrier create gating).
- `modules/import/dto/*` — upload settings, patch-row, commit DTOs.
- `public/econt-app/` — `index.html` + a small JS module (Alpine.js via CDN). Served at `/app`.

## Data model — migration 0058 (additive, two new tables)

**`import_batches`**
- `id` uuid pk, `tenant_id` uuid (fk-less, scoped like `shipments`), `file_name` text,
- `carrier_default` text (`econt|speedy`), `currency` text (`BGN|EUR`, default `EUR`),
- `status` text (`validating|ready|partial|done`), `settings` jsonb (sender override,
  package preset weight/contents, COD processing type, Speedy serviceId override),
- `ai_report` jsonb null (summary: counts ok/warn/error, ai availability),
- `created_at` timestamptz default now.

**`import_rows`**
- `id` uuid pk, `batch_id` uuid (fk → import_batches, on delete cascade), `tenant_id` uuid,
- `row_index` int, `raw` jsonb (original parsed cells),
- normalized columns: `receiver_name`, `receiver_phone`, `delivery_mode`,
  `city`, `office`, `address`, `street_no`, `weight_grams` int, `contents`,
  `cod_amount_stotinki` int, `declared_value_stotinki` int, `carrier`,
- `validation_status` text (`ok|warn|error`), `validation` jsonb (issues + ai verdict merged),
- `resolved_refs` jsonb (Econt office code; Speedy siteId/officeId/streetId; Speedy extra
  address parts blockNo/entranceNo/floorNo/apartmentNo; ambiguity candidate lists),
- `shipment_id` uuid null (set on successful create), `create_status` text null
  (`created|failed`), `create_error` text null,
- `created_at` timestamptz default now.

Drafts live in their own tables — `shipments` is untouched until commit creates real rows
via the existing `createManualShipment` paths. Existing migrations 0055–0057 unchanged.

## File format (shown on the upload page + a downloadable .xlsx template)

Column headers (BG primary, EN aliases accepted, case/space-insensitive match):

| Header (BG) | EN aliases | Required | Notes |
|---|---|---|---|
| Получател | name, recipient | yes | recipient name |
| Телефон | phone | yes | BG mobile; normalized to `+359…` |
| Доставка | mode, delivery | yes* | `офис`/`office` or `адрес`/`address`; blank → batch default |
| Град | city | for address + for office lookup | free text; resolved per carrier |
| Офис | office | for office mode | Econt code/name, Speedy office name |
| Адрес | address | for address mode | street + № (+ block/ent/floor/apt for Speedy) |
| Тегло (кг) | weight | no | blank → batch default |
| Съдържание | contents | no | blank → batch default |
| Наложен платеж | cod | no | numeric in batch currency; 0/blank → no COD |
| Обявена стойност | declared | no | numeric; optional insurance |
| Куриер | carrier | no | `Econt`/`Speedy`; blank → batch default |

Required per row: Получател, Телефон, Доставка, and (Офис **or** Адрес by mode).

## AI check (OpenAI / ChatGPT)

- `ImportAiService` sends a compact JSON of the normalized rows + a fixed system prompt to
  OpenAI (`openai` SDK, model `gpt-4o-mini`, JSON response format). Returns per row:
  `{index, status, issues:[{field,message,suggestion}], normalized:{…}}`.
- Catches: missing fields, invalid BG phone, unparseable mode, unrecognized city,
  non-numeric COD, mode/field mismatch (office mode but only an address given).
- Merge rule: deterministic validation is authoritative for resolution/blocking; AI adds
  explanations and suggested normalized values (shown as one-click "apply suggestion" in the
  editor). AI status can raise `ok`→`warn` (advisory) but cannot downgrade a hard `error`.
- Degrade: no `OPENAI_API_KEY` or API error → skip AI entirely, `ai_report.aiAvailable=false`,
  rows keep deterministic validation, UI banner "AI проверка недостъпна". **Never blocks import.**
- Config: `OPENAI_API_KEY` (platform env), `OPENAI_IMPORT_MODEL` (default `gpt-4o-mini`).
  Row cap per AI call (e.g. 200) — same as the import row cap; one call per batch.

## Carrier resolve

- **Econt:** city = free text (passed through to `receiverCity`). Office = code passed
  through, or a name → resolved to a code; >1 match → warn + candidate list.
- **Speedy:** city → `searchSites` → `siteId`; office → `getOffices` → `officeId`; street →
  `getStreets` → `streetId`. No/many matches → `warn` + candidates for the editor dropdown.
  `serviceId` from row → batch `settings` → Speedy stored `defaultServiceId`.

## Commit (draft → real shipments)

For each `ok` (and user-accepted `warn`) row, by carrier:
- **Econt** → build `ManualShipmentDto` (`receiverName`, `receiverPhone`, `deliveryMode`,
  `receiverOfficeCode` from resolvedRefs, `receiverCity`, `receiverAddress`, `weightGrams`,
  `contents`, `codAmountStotinki`, `declaredValueStotinki`) → `EcontService.createManualShipment`.
- **Speedy** → build `SpeedyManualShipmentDto` (`siteId`/`officeId`/`streetId`/`streetNo`,
  `serviceId`, weight/contents/cod/declared) → `SpeedyService.createManualShipment`.
- Stamp `shipment_id` + `create_status` on the row. Per-row try/catch: one failure marks
  that row `failed` (with `create_error`) and continues; the rest succeed (partial commit).
- Batch `status` → `done` if all created, else `partial`.

Then the UI calls existing bulk label / waybill endpoints with the collected `shipment_id`s
(Econt + Speedy each have their own `getLabelsPdf`; the controller groups by carrier).

## UI (minimal, Alpine.js, served at `/app`)

- Login (existing standalone JWT) → token in memory/localStorage → Bearer on every call.
- Upload screen: drag-drop file, batch-defaults bar (carrier, currency, weight/contents,
  COD type, Speedy serviceId), download-template button, column guide.
- Review table: one row per recipient, colored by status (green ok / amber warn / red error),
  inline-editable cells, dropdown for ambiguous city/office (from candidates), "apply AI
  suggestion" chips, "Провери пак" (re-validate), error/warn counts.
- Actions: "Създай пратки" (commit) → shows per-row result → "Свали етикети" + "Свали
  товарителници".
- Served same-origin from `:3100/app` (no CORS). `helmet` CSP already disabled in
  `main.econt.ts`, so the Alpine.js CDN script loads fine.

## Errors / edge cases

- Parse failure → `400` naming the offending row/column; empty file → clear message.
- Row cap (200/file) → reject with count.
- AI down → degrade (above).
- Ambiguous/unresolved location → `warn` (not blocked); user picks in editor before commit.
- Partial commit → per-row `failed` surfaced; never loses the successful ones.
- Tenant isolation on every batch/row/commit query (`tenant_id` scoped, like all standalone).
- Activation gate on commit (creating real shipments = paid action), mirroring per-carrier create.

## Testing

- Pure: `import.parse` (xlsx+csv→rows, aliasing), `import.normalize` (defaults, currency),
  `import.validate` (each rule, ok/warn/error), `mergeAi`, resolve mapping (candidates) → unit.
- Service: draft CRUD + commit mapping (Econt/Speedy DTO shape) + partial-commit path.
- UI: manual smoke at `:3100/app` (upload sample → edit → commit → download).
- Follows the established pattern: pure helpers TDD, service integration, UI manual.

## Open spikes (deferred, like prior features)

- OpenAI cost/latency on real farmer files; tune model if needed.
- Econt office-name→code lookup endpoint shape (may need office-search call) — verify live.
- Currency: confirm farmers' files are EUR vs BGN in practice (batch toggle covers both).
