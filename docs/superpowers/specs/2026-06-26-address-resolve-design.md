# Address Resolve — making import addresses Google-Maps-eligible

**Date:** 2026-06-26
**Component:** delivery-web bulk import + server (`modules/import`, `common/maps`)
**Status:** approved design

## Problem

Bulk-imported shipments with **address** delivery often carry messy, free-typed
addresses ("ул Граф Игнатиев бл3 до аптеката", typos, missing town context).
A courier label needs an address Google Maps / the carrier can actually resolve.
Today the import editor flags missing required fields but never checks whether an
**address-mode** row's address is geocodable. Bad addresses slip through to label
creation and fail or deliver to the wrong place.

We want an intermediate "is this address eligible?" check that runs **as part of
the existing upload validation** (alongside the missing-field check), proposes a
fix when the address is broken, and offers an optional autocomplete helper — all
cheap and fast even for large batches.

## Goals

- Mark each address-mode row as **address-eligible** (Google geocode finds a
  fine-grained point) or not, during the same validation pass that flags missing
  fields.
- For ineligible addresses, **suggest** a normalized address (via ChatGPT) that
  IS geocodable; the farmer accepts it with one click. Never silently replace.
- Optional **Places autocomplete** when the farmer focuses a flagged address
  field — server-proxied, session-tokened, on-demand only.
- Cheap and non-exhausting for many orders: cache-first geocode, batched AI,
  no per-keystroke autocomplete by default.

## Non-goals

- No change to office-mode rows (office delivery does not need a street geocode).
- No live per-keystroke autocomplete on every field.
- No new delivery flow screen — this lives inline in the existing editor.
- No pin/lat-lng stored on the shipment (eligibility is a yes/no gate; the
  carrier re-geocodes at label time). We only use the geocode to validate.

## Existing building blocks (reused)

- `common/maps/maps.service.ts` `geocode()` — Google Geocoding with a **30-day
  Redis cache**, a region-bias backstop, and a **coarse-result rejector**: it
  returns `null` when Google can only resolve to a town/postal/region centroid.
  That null IS our "not eligible" signal; a non-null fine point IS "eligible".
- `modules/import/import.ai.ts` — already calls OpenAI per upload to validate
  rows and return `issues[{field,message,suggestion?}]` + `normalized`. We extend
  this path with an address-repair step rather than adding a second AI roundtrip
  pattern.
- `modules/import/import.validate.ts` / `import.service.ts` — deterministic
  validation + the `createBatch` / `patchRow` pipelines we hook into.

## Architecture

### Unit: `AddressResolveService` (server, `modules/import/address-resolve.service.ts`)

Lives in `modules/import` (it orchestrates import-specific repair); depends on
the shared `MapsService` from `common/maps`.

Single clear purpose: decide if an address is map-eligible and, if not, try to
fix it.

```
resolve(address: string, city: string | null): Promise<AddressResolution>
resolveMany(items: {address, city}[]): Promise<AddressResolution[]>   // batched AI

type AddressResolution =
  | { status: 'ok' }                              // geocode found a fine point
  | { status: 'fixed'; suggestion: string }       // AI normalized → re-geocode ok
  | { status: 'unresolved' }                       // still not geocodable
```

Logic for `resolve`:
1. `geocode(address, city)` (cache-first). Non-null → `ok`.
2. Null → collect for AI repair. `resolveMany` sends ALL broken `{address,city}`
   in **one** OpenAI call asking for a normalized, geocodable Bulgarian address
   per item.
3. Re-geocode each AI candidate (cache-first). Eligible → `fixed{suggestion}`.
   Still null → `unresolved`.

Dependencies: `MapsService.geocode`, `OpenAI` client (reuse the one in
`ImportAiService` or inject the same config). Concurrency-pooled, per-call
timeout inherited from `maps.service` (8s).

### Integration into validation

- **`createBatch`**: after the existing det+AI validation produces rows, run
  `resolveMany` over the **address-mode rows with a non-empty address** (office
  rows and empty addresses skip). Fold the result into each row's
  `validation.issues`:
  - `ok` → no issue added.
  - `fixed` → warn issue `{ field: 'address', code: 'address_fixable',
    message: 'Адресът не се намира в Google — предложение по-долу',
    suggestion: <Y> }`.
  - `unresolved` → warn issue `{ field: 'address', code: 'address_unresolved',
    message: 'Адресът не се намира в Google — провери ръчно' }`.
  Address issues are **warn**, never **error**: the farmer can still send, but
  it is flagged. (Matches today's "warn" semantics.)
- **`patchRow`**: when a row's `address` or `city` changes and mode is address,
  re-run `resolve` for that single row and refresh its address issue. Single
  row, cache-first → negligible latency.
- Performance bound: `resolveMany` runs geocodes through a concurrency pool
  (~8). New addresses cost one geocode each (then cached 30d); broken ones share
  one AI call. Large all-new files add bounded latency on upload, consistent with
  today's single big AI validation call.

### Frontend (delivery-web `import-client.tsx`)

The address status surfaces in the existing **full-width "Проблеми" sub-row**
(just added) — no new column:
- `address_fixable` → amber line: `Адресът не се намира в Google. Предложение:
  „<Y>"` with an **„Приеми"** button. Click → set `address = Y`, `save(row)`
  (which re-validates → issue clears).
- `address_unresolved` → amber line: `Адресът не се намира в Google — провери
  ръчно.`
- ok → no line (same as any clean row).

**Places autocomplete on focus:** when the farmer focuses an address field that
has an `address_*` issue, show a small predictions dropdown:
- BFF endpoint `POST /bff/shipping/address-suggest` → server proxies Google
  **Places Autocomplete (New)** with a per-focus **session token** and BG region
  bias; returns `[{description, placeId}]`.
- Selecting a prediction fills the address textarea and `save(row)` →
  re-validate. The session token is minted on focus and discarded on
  blur/select, so billing is one session per manual fix, not per keystroke.
- Debounced (~250ms) so typing doesn't fire a request per character.
- If no Maps browser/proxy key is configured, the dropdown is simply absent
  (graceful — the AI suggestion + manual edit still work).

## Data model

No schema change. Eligibility is carried in the existing `validation.issues`
JSON (new `code` values `address_fixable` / `address_unresolved`, reusing the
existing `suggestion` field). Nothing is persisted on the shipment.

## Error handling

- Geocode failure/timeout → treated as `unresolved` (never blocks; warn only).
  A transient failure is not cached (existing maps.service behaviour).
- OpenAI unavailable → skip AI repair; ineligible rows become `unresolved`
  (degrade, like today's AI-degrade path).
- Autocomplete endpoint error → dropdown silently absent; no farmer-facing error.

## Testing

- `AddressResolveService` unit tests with a mocked `MapsService.geocode` and
  mocked OpenAI: `ok` (geocode hits), `fixed` (geocode null → AI candidate
  geocodes), `unresolved` (both null), `resolveMany` batching, office/empty skip.
- `import.service` tests: address-mode ineligible row gets a warn
  `address_*` issue; office row does not; `patchRow` refreshes the issue.
- Frontend: „Приеми" applies the suggestion and clears the issue; autocomplete
  absent when no key.

## Cost guardrails (summary)

| Action | Cost shape |
|---|---|
| Repeat address | geocode cache hit — free |
| New address | 1 geocode (~$5/1000), then cached 30d |
| Broken addresses in a batch | share **1** OpenAI call |
| Autocomplete | only on manual focus, 1 session token per fix |
| Office rows | skipped entirely |
