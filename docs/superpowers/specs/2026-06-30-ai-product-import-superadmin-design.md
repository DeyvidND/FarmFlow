# AI Product Import — Super-Admin (Producer Detail)

**Date:** 2026-06-30
**Status:** Approved (design) — ready for plan
**Scope owner:** super-admin / platform module

## Problem

Onboarding a new farm is mostly manual. The operator handles the sales
conversation and the storefront setup by hand — that part stays manual by
choice. The one repetitive, automatable step is **entering the farm's product
catalog**. Today the operator either types products one by one in the panel, or
runs the `import-products.mjs` CLI (Anthropic, manual flags). We want a button in
the super-admin producer detail page: paste/upload the farm's price list → AI
extracts products → operator reviews/edits → create them in that farm's panel.

## Scope

In:
- Products only (not farmers / categories / contact — those stay CLI-only for now).
- Operator-driven, inside the super-admin panel (the operator is in the loop).
- Input: pasted **text** OR uploaded **file** (`.txt`, `.csv`, `.xlsx`).
- Extraction only — **no product photos**. Farmers add images themselves later
  in their own panel.

Out (explicitly not building now):
- Self-serve / farmer-facing intake.
- Vision/photo extraction of a price board.
- Persisted import batches / audit trail (stateless, browser-held preview).
- Auto-extract of categories or farmers alongside products.

## Key existing facts (reuse, don't rebuild)

- **Create endpoint already exists:** `POST /platform/tenants/:id/import`
  (`PlatformImportDto`) → `PlatformService.importTenant`. Guarded by
  `PlatformAdminGuard`. Reuses `CreateProductDto` per row, bypasses the new
  tenant's `mustChangePassword` lock. We send `{ products: [...] }` to it.
- **OpenAI already wired in the server:** `OPENAI_API_KEY` via `ConfigService`,
  default model `gpt-4o-mini` (`OPENAI_IMPORT_MODEL`). Pattern in
  `server/src/modules/import/import.ai.ts` — bounded timeout, `maxRetries`,
  `response_format: { type: 'json_object' }`, degrade-on-failure. This is the
  "ChatGPT key" the operator referred to. Use OpenAI, not Anthropic.
- **xlsx parsing available:** `exceljs` is already a server dependency
  (`import.controller.ts` uses it). No new dependency for `.xlsx`.
- **File upload pattern exists:** `FileInterceptor('file', { limits: { fileSize } })`
  + `@Throttle` in `import.controller.ts`.
- **CreateProductDto fields:** `name` (req), `priceStotinki` (int ≥0, req),
  `unit` (req string), `weight?`, `category?`, `description?`, `isActive?`.
  Extractor output maps 1:1.
- **UI home:** `admin/src/components/producer-detail.tsx` (the producer detail
  page shipped in `11e049e`), already scoped to one tenant → matches `:id`.

## Approach (chosen: A — stateless two-step)

```
operator pastes text / drops file
        │
        ▼
POST /platform/tenants/:id/products/extract   (multipart: file | text)
        │  parse file → text  (txt/csv decode; xlsx → exceljs → text)
        │  OpenAI gpt-4o-mini, forced JSON, product schema
        ▼
returns { products: [...] }   (NO db write)
        │
        ▼
editable preview table in browser  (operator fixes name/price/unit, deletes rows)
        │
        ▼  „Създай N продукта"
POST /platform/tenants/:id/import  { products: [...] }   (EXISTING)
        ▼
result: created / failed counts
```

Rejected:
- **B (persisted batch):** mirror the shipments-import batch tables. Adds a
  migration + patch/delete/commit endpoints. Overkill — operator does this in one
  sitting; the existing import endpoint already validates each row.
- **C (one-shot extract+create):** no preview → AI mistakes land in the farmer's
  live catalog. Unacceptable.

## Components

### 1. Backend — extraction endpoint + service

New, in the **platform** module (super-admin), alongside the existing import route.

**Endpoint:** `POST /platform/tenants/:id/products/extract`
- Guard: `PlatformAdminGuard` (inherited from `PlatformController`), `ParseUUIDPipe` on `:id`.
- `@Throttle({ default: { limit: 5, ttl: 60_000 } })` — each call hits OpenAI.
- `@UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))`.
- Body: optional `text` (string) + optional uploaded `file`. At least one required → `BadRequestException('Подайте текст или файл')`.
- Returns `{ products: ExtractedProduct[] }` — no DB write.

**Service:** `PlatformProductExtractService` (new file in platform module).
- `parseToText(file, text)`:
  - `text` present → use it.
  - file `.txt` / `.csv` (or `text/*`) → `file.buffer.toString('utf8')`.
  - file `.xlsx` → `exceljs` workbook from buffer → for each sheet, join rows as
    tab/comma-separated lines → one text blob.
  - unknown type → `BadRequestException('Неподдържан файл — .txt, .csv или .xlsx')`.
  - cap parsed text length (e.g. 100k chars) to bound the prompt.
- `extract(text)`: OpenAI call mirroring `import.ai.ts` ergonomics —
  - client built from `OPENAI_API_KEY` with bounded `timeout` + `maxRetries`;
    if no key → `ServiceUnavailableException('AI импорт не е конфигуриран')`.
  - model `OPENAI_IMPORT_MODEL` default `gpt-4o-mini`.
  - `response_format: { type: 'json_object' }`.
  - System prompt (Bulgarian): extract every product; the file is roughly aligned
    to the fields name / price / unit / weight / category / description; price →
    stotinki (`6,50 → 650`, decimal ×100 rounded); default `unit` `"бр"`; skip
    non-product lines (headers, phones, addresses); return
    `{"products":[{name, priceStotinki, unit, weight, category, description}]}`.
  - Parse JSON defensively; coerce/clamp: `priceStotinki` integer ≥0, `name`
    required (drop nameless rows), `unit` fallback `"бр"`, optional fields → omit
    when empty. Cap to 1000 rows (matches `ArrayMaxSize`).
  - On OpenAI failure: throw a 502-ish error with a Bulgarian message (operator
    can retry) — this is a foreground operator action, not a background degrade.

`ExtractedProduct` shape = the subset of `CreateProductDto` we send:
`{ name; priceStotinki; unit; weight?; category?; description?; isActive: true }`.

### 2. Create — reuse existing endpoint

No backend change. Frontend posts the (edited) preview rows to
`POST /platform/tenants/:id/import` as `{ products }`. Each row re-validated by
`CreateProductDto`; malformed rows rejected exactly like a manual create.

### 3. Frontend — producer detail dialog

In `admin/src/components/producer-detail.tsx`, add an „Импорт на продукти (AI)"
action that opens a dialog:
- **Input step:** a paste `<textarea>` + a drag-drop / file picker (`.txt,.csv,.xlsx`).
  „Извлечи" → multipart POST to `/products/extract`. Loading state.
- **Preview step:** editable table — columns name / priceStotinki (shown as лв/€) /
  unit / weight / category / description. Operator can edit cells and delete rows.
  Row count shown. Empty result → message + back to input.
- **Commit:** „Създай N продукта" → POST `/import { products }`. On success: toast
  „Създадени N продукта" (+ any failed), close dialog, refresh the tenant's
  product count if shown.
- Follow existing admin dialog/table patterns + BG copy already in the panel.

### 4. Guards / limits (summary)

- `PlatformAdminGuard` (super-admin only).
- Throttle 5/min on extract (OpenAI cost), existing throttle on import.
- 2 MB file cap; 100k-char text cap; 1000-row cap.
- OpenAI key optional in env → endpoint returns a clear "not configured" error;
  add `OPENAI_IMPORT_MODEL` note to env docs (no new required var).

## Data flow / state

Stateless: extracted rows live only in the browser between extract and commit.
Refresh = redo. No new table, no migration.

## Error handling

- No input → 400 Bulgarian.
- Unsupported file type → 400 Bulgarian.
- OpenAI not configured → 503 Bulgarian.
- OpenAI call fails/times out → 502 Bulgarian, operator retries.
- Per-row create failure → surfaced in the commit result (created vs failed),
  same as the CLI's failed list.

## Testing

- `parseToText`: `.txt`, `.csv`, `.xlsx` (exceljs roundtrip), text-wins-over-file,
  unsupported type → throws, length cap.
- `extract` (OpenAI mocked): money `6,50 → 650`; nameless row dropped; missing
  unit → `"бр"`; non-product lines skipped; >1000 rows capped; malformed JSON → throws.
- Endpoint: guard rejects non-super-admin; no input → 400; happy path returns rows.
- Frontend: extract → edit a cell → delete a row → commit posts the edited set
  (component test / existing admin test harness).

## Acceptance

1. Super-admin opens a producer, pastes/uploads a price list, clicks „Извлечи".
2. Products appear in an editable preview with correct names + stotinki prices.
3. Operator edits/deletes as needed, clicks „Създай", products appear in that
   farm's panel (verified via the tenant's product list).
4. No photos set; farmer can add images later.
5. Full server suite green.
