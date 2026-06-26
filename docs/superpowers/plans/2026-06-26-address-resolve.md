# Address Resolve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flag bulk-import address-mode rows whose address Google Maps cannot resolve, propose a geocodable fix via ChatGPT that the farmer accepts with one click, and offer an on-focus Places autocomplete helper.

**Architecture:** A new server `AddressGeoService` (in `modules/import`) checks each address-mode row's address with the existing cache-backed `MapsService.geocode` (non-null = eligible). Ineligible addresses are batched into one ChatGPT repair call (`ImportAiService.repairAddresses`), re-geocoded, and classified `ok`/`fixed`/`unresolved`. Results fold into the existing per-row `validation.issues` during `createBatch` and `patchRow`. The frontend renders the suggestion + an „Приеми" button in the existing full-width „Проблеми" sub-row, and a server-proxied Places autocomplete dropdown appears only when a flagged address field is focused.

**Tech Stack:** NestJS (server), Drizzle, OpenAI SDK, Google Maps Geocoding + Places Autocomplete (New), Next.js (delivery-web), Tailwind, Jest.

**Spec:** [docs/superpowers/specs/2026-06-26-address-resolve-design.md](../specs/2026-06-26-address-resolve-design.md)

---

## File Structure

**Server (`server/src`):**
- Create: `modules/import/address-geo.service.ts` — geocode-eligibility + AI-repair orchestration
- Create: `modules/import/address-geo.service.spec.ts` — unit tests
- Modify: `modules/import/import.ai.ts` — add `repairAddresses()` + prompt
- Modify: `modules/import/import.types.ts` — add `code?` to `RowIssue`
- Modify: `modules/import/import.service.ts` — fold geo results into `createBatch` + `patchRow`
- Modify: `modules/import/import.module.ts` — provide `AddressGeoService`
- Modify: `common/maps/maps.service.ts` — add `placeAutocomplete()`
- Modify: `common/maps/maps.service.spec.ts` — test `placeAutocomplete` (create if absent)
- Modify: `modules/econt-app/shipping-quote.controller.ts` — add `POST /shipping/address-suggest`
- Create: `modules/econt-app/dto/address-suggest.dto.ts` — request DTO

**Frontend (`delivery-web/src`):**
- Modify: `lib/api-client.ts` — extend `ImportRow` issue type + add `addressSuggest()`
- Modify: `components/import-client.tsx` — „Приеми" accept button + on-focus autocomplete dropdown

---

## PHASE 1 — Server: address eligibility + AI repair

### Task 1: `RowIssue.code` + AI `repairAddresses`

**Files:**
- Modify: `server/src/modules/import/import.types.ts`
- Modify: `server/src/modules/import/import.ai.ts`
- Test: `server/src/modules/import/import.ai.spec.ts`

- [ ] **Step 1: Add optional `code` to RowIssue**

In `import.types.ts`, replace the `RowIssue` interface:

```ts
export interface RowIssue {
  field: string;
  message: string;
  suggestion?: string;
  /** Machine code so the frontend can target specific issues (e.g. address fixes). */
  code?: string;
}
```

- [ ] **Step 2: Write the failing test for `repairAddresses`**

Append to `server/src/modules/import/import.ai.spec.ts` (create the describe block if the file lacks one — match the existing imports/style in that file):

```ts
describe('ImportAiService.repairAddresses', () => {
  it('returns [] when no OpenAI key is configured (degrade)', async () => {
    const svc = new ImportAiService({ get: () => undefined } as unknown as ConfigService);
    const out = await svc.repairAddresses([{ index: 1, address: 'ул Граф Игнатиев', city: 'София' }]);
    expect(out).toEqual([]);
  });
});
```

(Use the same `ConfigService` import the existing spec uses: `import { ConfigService } from '@nestjs/config';`.)

- [ ] **Step 3: Run the test, expect FAIL**

Run: `cd server && npx jest src/modules/import/import.ai.spec.ts -t repairAddresses`
Expected: FAIL — `repairAddresses` is not a function.

- [ ] **Step 4: Implement `repairAddresses` + prompt**

In `import.ai.ts`, add the prompt constant after `SYSTEM_PROMPT`:

```ts
const ADDRESS_REPAIR_PROMPT = `Ти си помощник за нормализиране на адреси за доставка в България.
За всеки подаден адрес върни ПОДОБРЕНА версия, която Google Maps може да намери: пълно име на улица/булевард + номер + град, без излишни думи (вход, етаж, апартамент, ориентири като „до аптеката" премахни).
Запази същия index. Ако не можеш да подобриш — върни най-добрия си опит.
Връщай само JSON: {"addresses":[{"index":число,"suggestion":"..."}]}. Без друг текст. Всичко на български.`;
```

Add the method inside `ImportAiService` (after `review`):

```ts
/** Batch-normalize messy addresses into geocodable ones. Never throws — [] on failure. */
async repairAddresses(
  items: { index: number; address: string; city: string | null }[],
): Promise<{ index: number; suggestion: string }[]> {
  if (!this.client || !items.length) return [];
  try {
    const res = await this.client.chat.completions.create({
      model: this.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: ADDRESS_REPAIR_PROMPT },
        { role: 'user', content: JSON.stringify({ addresses: items }) },
      ],
    });
    const txt = res.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(txt) as { addresses?: { index: number; suggestion: string }[] };
    return Array.isArray(parsed.addresses)
      ? parsed.addresses.filter((a) => typeof a.index === 'number' && typeof a.suggestion === 'string' && a.suggestion.trim().length > 0)
      : [];
  } catch (e) {
    this.log.warn(`OpenAI address repair failed, degrading: ${String((e as Error)?.message ?? e)}`);
    return [];
  }
}
```

- [ ] **Step 5: Run the test, expect PASS**

Run: `cd server && npx jest src/modules/import/import.ai.spec.ts -t repairAddresses`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/import/import.types.ts server/src/modules/import/import.ai.ts server/src/modules/import/import.ai.spec.ts
git commit -m "feat(import): RowIssue.code + ImportAiService.repairAddresses (batched address normalization)"
```

---

### Task 2: `AddressGeoService`

**Files:**
- Create: `server/src/modules/import/address-geo.service.ts`
- Test: `server/src/modules/import/address-geo.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/modules/import/address-geo.service.spec.ts`:

```ts
import { AddressGeoService } from './address-geo.service';
import type { MapsService } from '../../common/maps/maps.service';
import type { ImportAiService } from './import.ai';

const POINT = { lat: 42.69, lng: 23.32 };

function make(geocode: jest.Mock, repair: jest.Mock = jest.fn().mockResolvedValue([])) {
  const maps = { geocode } as unknown as MapsService;
  const ai = { repairAddresses: repair } as unknown as ImportAiService;
  return new AddressGeoService(maps, ai);
}

describe('AddressGeoService', () => {
  it('checkOne → ok when geocode finds a point', async () => {
    const svc = make(jest.fn().mockResolvedValue(POINT));
    expect(await svc.checkOne('ул. Витоша 1', 'София')).toEqual({ status: 'ok' });
  });

  it('checkOne → fixed when AI suggestion geocodes', async () => {
    const geocode = jest.fn()
      .mockResolvedValueOnce(null)   // original fails
      .mockResolvedValueOnce(POINT); // suggestion succeeds
    const repair = jest.fn().mockResolvedValue([{ index: 0, suggestion: 'бул. Витоша 1, София' }]);
    const svc = make(geocode, repair);
    expect(await svc.checkOne('Витоша бл до аптеката', 'София')).toEqual({ status: 'fixed', suggestion: 'бул. Витоша 1, София' });
  });

  it('checkOne → unresolved when neither original nor suggestion geocodes', async () => {
    const svc = make(jest.fn().mockResolvedValue(null), jest.fn().mockResolvedValue([{ index: 0, suggestion: 'xxx' }]));
    expect(await svc.checkOne('zzz', 'София')).toEqual({ status: 'unresolved' });
  });

  it('checkMany → one AI call for all broken rows', async () => {
    const geocode = jest.fn()
      .mockResolvedValueOnce(POINT) // row 1 ok
      .mockResolvedValueOnce(null)  // row 2 broken
      .mockResolvedValueOnce(POINT);// row 2 suggestion ok
    const repair = jest.fn().mockResolvedValue([{ index: 2, suggestion: 'fixed addr' }]);
    const svc = make(geocode, repair);
    const out = await svc.checkMany([
      { rowIndex: 1, address: 'good', city: 'София' },
      { rowIndex: 2, address: 'bad', city: 'София' },
    ]);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(out.get(1)).toEqual({ status: 'ok' });
    expect(out.get(2)).toEqual({ status: 'fixed', suggestion: 'fixed addr' });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd server && npx jest src/modules/import/address-geo.service.spec.ts`
Expected: FAIL — cannot find `./address-geo.service`.

- [ ] **Step 3: Implement `AddressGeoService`**

Create `server/src/modules/import/address-geo.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { MapsService } from '../../common/maps/maps.service';
import { ImportAiService } from './import.ai';

export type AddressGeo =
  | { status: 'ok' }
  | { status: 'fixed'; suggestion: string }
  | { status: 'unresolved' };

/** Pooled geocode concurrency — matches MapsService's 8s per-call timeout budget. */
const POOL = 8;

/** Decides whether an address-mode address is resolvable by Google Maps, and if
 *  not, asks ChatGPT (batched) for a geocodable rewrite. Geocode is cache-first
 *  (30-day Redis) so repeat addresses are free. */
@Injectable()
export class AddressGeoService {
  private readonly log = new Logger(AddressGeoService.name);

  constructor(
    private readonly maps: MapsService,
    private readonly ai: ImportAiService,
  ) {}

  /** A fine-grained Google point (not a town centroid) means the carrier can find it. */
  private async eligible(address: string, city: string | null): Promise<boolean> {
    const point = await this.maps.geocode(address, undefined, city ? { locality: city } : undefined);
    return point != null;
  }

  async checkOne(address: string, city: string | null): Promise<AddressGeo> {
    if (!address?.trim()) return { status: 'unresolved' };
    if (await this.eligible(address, city)) return { status: 'ok' };
    const [fix] = await this.ai.repairAddresses([{ index: 0, address, city }]);
    if (fix?.suggestion && (await this.eligible(fix.suggestion, city))) {
      return { status: 'fixed', suggestion: fix.suggestion };
    }
    return { status: 'unresolved' };
  }

  /** Eligibility for many rows with a SINGLE batched AI repair call for the broken ones. */
  async checkMany(
    items: { rowIndex: number; address: string; city: string | null }[],
  ): Promise<Map<number, AddressGeo>> {
    const out = new Map<number, AddressGeo>();
    const broken: { index: number; address: string; city: string | null }[] = [];

    // Pass 1 — pooled eligibility.
    const queue = [...items];
    const elig = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        if (it.address?.trim() && (await this.eligible(it.address, it.city))) out.set(it.rowIndex, { status: 'ok' });
        else broken.push({ index: it.rowIndex, address: it.address ?? '', city: it.city });
      }
    };
    await Promise.all(Array.from({ length: POOL }, elig));
    if (!broken.length) return out;

    // Pass 2 — ONE AI repair call for every broken address.
    const fixes = await this.ai.repairAddresses(broken);
    const fixByIndex = new Map(fixes.map((f) => [f.index, f.suggestion]));

    // Pass 3 — pooled re-geocode of the candidates.
    const bq = [...broken];
    const verify = async () => {
      for (let b = bq.shift(); b; b = bq.shift()) {
        const sug = fixByIndex.get(b.index);
        if (sug && (await this.eligible(sug, b.city))) out.set(b.index, { status: 'fixed', suggestion: sug });
        else out.set(b.index, { status: 'unresolved' });
      }
    };
    await Promise.all(Array.from({ length: POOL }, verify));
    return out;
  }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd server && npx jest src/modules/import/address-geo.service.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/import/address-geo.service.ts server/src/modules/import/address-geo.service.spec.ts
git commit -m "feat(import): AddressGeoService — geocode-eligibility + batched AI repair"
```

---

### Task 3: Provide `AddressGeoService` in the module

**Files:**
- Modify: `server/src/modules/import/import.module.ts`

- [ ] **Step 1: Register the provider**

In `import.module.ts`, add the import and provider:

```ts
import { AddressGeoService } from './address-geo.service';
```

and add `AddressGeoService` to the `providers` array:

```ts
  providers: [ImportService, ImportAiService, ImportResolveService, AddressGeoService, ActivationGuard],
```

(`MapsService` is already available app-wide — `MapsModule` is `@Global`.)

- [ ] **Step 2: Verify the app compiles**

Run: `cd server && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/import/import.module.ts
git commit -m "feat(import): register AddressGeoService provider"
```

---

### Task 4: Fold eligibility into `createBatch`

**Files:**
- Modify: `server/src/modules/import/import.service.ts`
- Test: `server/src/modules/import/import.service.spec.ts`

- [ ] **Step 1: Inject `AddressGeoService`**

In `import.service.ts`, add the import:

```ts
import { AddressGeoService } from './address-geo.service';
```

and add the constructor param (after `resolver`):

```ts
    private readonly resolver: ImportResolveService,
    private readonly addressGeo: AddressGeoService,
```

- [ ] **Step 2: Collect processed rows, then run a batched geo check**

In `createBatch`, replace the chunk loop body that pushes directly to `rowsToInsert` so it first collects all processed rows. Replace:

```ts
    const CONCURRENCY = 8;
    const processRow = async (row: NormalizedRow) => {
      ...
    };
    for (let i = 0; i < normalized.length; i += CONCURRENCY) {
      const chunk = normalized.slice(i, i + CONCURRENCY);
      const processed = await Promise.all(chunk.map(processRow));
      for (const p of processed) {
        counts[p.validation.status]++;
        rowsToInsert.push(this.toRowInsert(batch.id, tenantId, p.row, p.validation, p.refs));
      }
    }
```

with:

```ts
    const CONCURRENCY = 8;
    const processRow = async (row: NormalizedRow) => {
      const det = validateRow(row);
      const resolved = det.status === 'error'
        ? { refs: {}, ambiguous: false, unresolved: null as string | null }
        : await this.resolver.resolve(tenantId, row);
      let validation = mergeAi(det, verdictByIndex.get(row.rowIndex));
      if (resolved.ambiguous || resolved.unresolved) {
        const status: RowStatus = validation.status === 'error' ? 'error' : 'warn';
        validation = {
          status,
          issues: [...validation.issues, {
            field: resolved.unresolved ?? 'city',
            message: resolved.ambiguous ? 'Няколко съвпадения — избери' : 'Не е намерено — провери',
          }],
        };
      }
      return { row, validation, refs: resolved.refs };
    };

    const allProcessed: Array<{ row: NormalizedRow; validation: { status: RowStatus; issues: import('./import.types').RowIssue[] }; refs: Record<string, unknown> }> = [];
    for (let i = 0; i < normalized.length; i += CONCURRENCY) {
      const chunk = normalized.slice(i, i + CONCURRENCY);
      allProcessed.push(...(await Promise.all(chunk.map(processRow))));
    }

    // Address-eligibility: only address-mode, non-error rows with an address. One
    // batched AI repair call for all broken addresses (see AddressGeoService).
    const geoCands = allProcessed.filter(
      (p) => p.validation.status !== 'error' && p.row.deliveryMode === 'address' && p.row.address,
    );
    const geo = await this.addressGeo.checkMany(
      geoCands.map((p) => ({ rowIndex: p.row.rowIndex, address: p.row.address!, city: p.row.city })),
    );
    for (const p of allProcessed) {
      const g = geo.get(p.row.rowIndex);
      if (g && g.status !== 'ok') {
        p.validation = {
          status: 'warn',
          issues: [...p.validation.issues, g.status === 'fixed'
            ? { field: 'address', code: 'address_fixable', message: 'Адресът не се намира в Google — предложение по-долу', suggestion: g.suggestion }
            : { field: 'address', code: 'address_unresolved', message: 'Адресът не се намира в Google — провери ръчно' }],
        };
      }
      counts[p.validation.status]++;
      rowsToInsert.push(this.toRowInsert(batch.id, tenantId, p.row, p.validation, p.refs));
    }
```

(The `processRow` body is unchanged — it is shown in full because it now lives just before the new collect loop. The only structural change: collect into `allProcessed`, then geo-fold, then count + insert.)

- [ ] **Step 3: Write a test that an ineligible address row gets an `address_*` warn**

Add to `server/src/modules/import/import.service.spec.ts` (mirror how that spec already constructs `ImportService` with mocked deps — pass a mocked `AddressGeoService` whose `checkMany` returns a `fixed` result for the row, and assert the inserted row's `validation.issues` contains a `code: 'address_fixable'` issue and `validationStatus: 'warn'`). Use the existing spec's DB/insert capture pattern.

```ts
// inside the existing createBatch describe — add a mocked addressGeo and a row:
// addressGeo.checkMany = jest.fn().mockResolvedValue(new Map([[1, { status: 'fixed', suggestion: 'бул. Витоша 1, София' }]]));
// expect the captured insert for rowIndex 1 to have an issue with code 'address_fixable' + suggestion, status 'warn'.
```

- [ ] **Step 4: Run the import.service tests, expect PASS**

Run: `cd server && npx jest src/modules/import/import.service.spec.ts`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/import/import.service.ts server/src/modules/import/import.service.spec.ts
git commit -m "feat(import): fold Google-eligibility + AI fix into createBatch validation"
```

---

### Task 5: Fold eligibility into `patchRow`

**Files:**
- Modify: `server/src/modules/import/import.service.ts`

- [ ] **Step 1: Re-check the single edited row's address**

In `patchRow`, after the resolver block and BEFORE the `db.update(...)` call (i.e. just before `const [updated] = await this.db.update(importRows).set({`), insert:

```ts
    // Re-check Google-eligibility for the edited address (single row, cache-first → cheap).
    if (det.status !== 'error' && merged.deliveryMode === 'address' && merged.address) {
      const g = await this.addressGeo.checkOne(merged.address, merged.city);
      if (g.status !== 'ok') {
        validation = {
          status: 'warn',
          issues: [...validation.issues, g.status === 'fixed'
            ? { field: 'address', code: 'address_fixable', message: 'Адресът не се намира в Google — предложение по-долу', suggestion: g.suggestion }
            : { field: 'address', code: 'address_unresolved', message: 'Адресът не се намира в Google — провери ръчно' }],
        };
      }
    }
```

(`validation` is the `let validation = det` already declared above; this widens it to `warn` and appends the issue, consistent with the resolver block right before it.)

- [ ] **Step 2: Verify compile + import tests**

Run: `cd server && npx tsc --noEmit && npx jest src/modules/import`
Expected: exit 0, all import tests PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/import/import.service.ts
git commit -m "feat(import): re-check address eligibility on patchRow edit"
```

---

## PHASE 2 — Frontend: accept the suggested fix

### Task 6: Extend the frontend issue type + render „Приеми"

**Files:**
- Modify: `delivery-web/src/lib/api-client.ts`
- Modify: `delivery-web/src/components/import-client.tsx`

- [ ] **Step 1: Widen `ImportRow.validation` issue shape**

In `api-client.ts`, find the `ImportRow` interface and replace its `validation` field:

```ts
  validation?: { issues?: Array<{ message: string; field?: string; code?: string; suggestion?: string }> } | null;
```

- [ ] **Step 2: Render the suggestion + accept button in the „Проблеми" sub-row**

In `import-client.tsx`, the desktop table currently renders the problems sub-row like:

```tsx
                      {issues.length > 0 && (
                        <tr className={`border-b border-ff-border-2 last:border-0 ${rowBg(r.validationStatus)}`}>
                          <td />
                          <td colSpan={9} className={`px-3 pb-2.5 pt-0 text-[12.5px] leading-snug ${r.validationStatus === 'error' ? 'text-ff-red' : 'text-ff-amber-600'}`}>
                            <span className="font-bold">Проблеми:</span> {issues.join('; ')}
                          </td>
                        </tr>
                      )}
```

Replace that block with one that pulls the full issue objects and adds an accept button when a `suggestion` exists:

```tsx
                      {(() => {
                        const all = r.validation?.issues ?? [];
                        if (!all.length) return null;
                        const fix = all.find((i) => i.suggestion);
                        return (
                          <tr className={`border-b border-ff-border-2 last:border-0 ${rowBg(r.validationStatus)}`}>
                            <td />
                            <td colSpan={9} className={`px-3 pb-2.5 pt-0 text-[12.5px] leading-snug ${r.validationStatus === 'error' ? 'text-ff-red' : 'text-ff-amber-600'}`}>
                              <span className="font-bold">Проблеми:</span> {all.map((i) => i.message).filter(Boolean).join('; ')}
                              {fix?.suggestion && (
                                <span className="ml-1 inline-flex items-center gap-1.5">
                                  <span className="text-ff-ink-2">Предложение: <b>„{fix.suggestion}"</b></span>
                                  <button
                                    type="button"
                                    onClick={() => { const v = fix.suggestion!; patch(r, 'address', v); save({ ...r, address: v }); }}
                                    className="rounded-md bg-ff-green-700 px-2 py-0.5 text-[11.5px] font-bold text-white hover:brightness-95"
                                  >Приеми</button>
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })()}
```

- [ ] **Step 3: Mirror it in the mobile card problems line**

In the mobile card block, replace:

```tsx
                {(r.validation?.issues ?? []).length > 0 && <p className="text-[12.5px] text-ff-red">{(r.validation?.issues ?? []).map((i) => i.message).join('; ')}</p>}
```

with:

```tsx
                {(r.validation?.issues ?? []).length > 0 && (
                  <div className="text-[12.5px] text-ff-red">
                    {(r.validation?.issues ?? []).map((i) => i.message).filter(Boolean).join('; ')}
                    {(() => {
                      const fix = (r.validation?.issues ?? []).find((i) => i.suggestion);
                      return fix?.suggestion ? (
                        <button
                          type="button"
                          onClick={() => { const v = fix.suggestion!; patch(r, 'address', v); save({ ...r, address: v }); }}
                          className="ml-1.5 rounded-md bg-ff-green-700 px-2 py-0.5 text-[11.5px] font-bold text-white hover:brightness-95"
                        >Приеми „{fix.suggestion}"</button>
                      ) : null;
                    })()}
                  </div>
                )}
```

- [ ] **Step 4: Typecheck + lint**

Run: `cd delivery-web && npx tsc --noEmit && npx next lint --file src/components/import-client.tsx`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add delivery-web/src/lib/api-client.ts delivery-web/src/components/import-client.tsx
git commit -m "feat(import): show AI address suggestion + one-click Приеми in problems row"
```

---

## PHASE 3 — Places autocomplete on focus

### Task 7: `MapsService.placeAutocomplete`

**Files:**
- Modify: `server/src/common/maps/maps.service.ts`
- Test: `server/src/common/maps/maps.service.spec.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

In `server/src/common/maps/maps.service.spec.ts`, add (constructing `MapsService` the way the file's other tests do — with a stub `ConfigService` returning a key and a stub cache):

```ts
describe('MapsService.placeAutocomplete', () => {
  it('returns [] when no key configured (stub mode)', async () => {
    const svc = new MapsService(
      { get: () => '' } as unknown as ConfigService,
      { get: jest.fn(), set: jest.fn() } as unknown as PublicCacheService,
    );
    expect(await svc.placeAutocomplete('Витоша', 'sess-1')).toEqual([]);
  });
});
```

(Match the real constructor signature of `MapsService` — check its `constructor(...)` params and pass matching stubs.)

- [ ] **Step 2: Run, expect FAIL**

Run: `cd server && npx jest src/common/maps/maps.service.spec.ts -t placeAutocomplete`
Expected: FAIL — `placeAutocomplete` is not a function.

- [ ] **Step 3: Implement `placeAutocomplete`**

In `maps.service.ts`, add the constant near the other URLs:

```ts
const PLACES_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
```

Add the method inside `MapsService`:

```ts
/** Google Places Autocomplete (New), biased to Bulgaria. Returns [] in stub mode
 *  or on any error (graceful). `sessionToken` groups keystrokes into one billed
 *  session — mint one per focus on the client. */
async placeAutocomplete(query: string, sessionToken: string): Promise<{ description: string; placeId: string }[]> {
  const q = query?.trim();
  if (!this.enabled || !q || q.length < 2) return [];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(PLACES_AUTOCOMPLETE_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.apiKey },
      body: JSON.stringify({
        input: q,
        sessionToken,
        includedRegionCodes: ['bg'],
        languageCode: 'bg',
      }),
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return [];
    const json = (await res.json()) as {
      suggestions?: { placePrediction?: { placeId?: string; text?: { text?: string } } }[];
    };
    return (json.suggestions ?? [])
      .map((s) => ({ description: s.placePrediction?.text?.text ?? '', placeId: s.placePrediction?.placeId ?? '' }))
      .filter((p) => p.description && p.placeId);
  } catch (err) {
    this.logger.warn(`Places autocomplete error for "${q}": ${(err as Error).message}`);
    return [];
  }
}
```

(If `this.apiKey` / `this.enabled` / `this.logger` field names differ in the file, use the actual ones — they are visible in the class.)

- [ ] **Step 4: Run, expect PASS**

Run: `cd server && npx jest src/common/maps/maps.service.spec.ts -t placeAutocomplete`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/common/maps/maps.service.ts server/src/common/maps/maps.service.spec.ts
git commit -m "feat(maps): placeAutocomplete (Places New, BG-biased, session-tokened)"
```

---

### Task 8: `POST /shipping/address-suggest`

**Files:**
- Create: `server/src/modules/econt-app/dto/address-suggest.dto.ts`
- Modify: `server/src/modules/econt-app/shipping-quote.controller.ts`

- [ ] **Step 1: Create the DTO**

Create `server/src/modules/econt-app/dto/address-suggest.dto.ts`:

```ts
import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';

export class AddressSuggestDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  query!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  sessionToken?: string;
}
```

- [ ] **Step 2: Add the endpoint**

In `shipping-quote.controller.ts`, inject `MapsService` and add the route. Update imports + constructor + add method:

```ts
import { MapsService } from '../../common/maps/maps.service';
import { AddressSuggestDto } from './dto/address-suggest.dto';
```

```ts
  constructor(
    private readonly quote: ShippingQuoteService,
    private readonly maps: MapsService,
  ) {}
```

```ts
  // Address autocomplete for the import editor — JWT only, throttled. Proxies Google
  // Places so the key stays server-side and billing is session-grouped on the client.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(200)
  @Post('address-suggest')
  addressSuggest(@Body() dto: AddressSuggestDto) {
    return this.maps.placeAutocomplete(dto.query, dto.sessionToken ?? '');
  }
```

(`MapsService` is global — no module import change needed.)

- [ ] **Step 3: Verify compile**

Run: `cd server && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/econt-app/dto/address-suggest.dto.ts server/src/modules/econt-app/shipping-quote.controller.ts
git commit -m "feat(shipping): POST /shipping/address-suggest (Places proxy)"
```

---

### Task 9: Frontend autocomplete on focus of a flagged address

**Files:**
- Modify: `delivery-web/src/lib/api-client.ts`
- Modify: `delivery-web/src/components/import-client.tsx`

- [ ] **Step 1: Add the api-client call**

In `api-client.ts`, add near the other shipping calls:

```ts
export interface AddressPrediction { description: string; placeId: string; }

/** Google Places autocomplete proxied by the API (key stays server-side). */
export const addressSuggest = async (query: string, sessionToken: string): Promise<AddressPrediction[]> =>
  (await bff('shipping/address-suggest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, sessionToken }),
  }, 'Грешка при предложенията')).json();
```

- [ ] **Step 2: Build an `AddressAutocomplete` component**

In `import-client.tsx`, add this component near `AutoTextarea` (it wraps it and shows a dropdown). Import `addressSuggest` + `AddressPrediction` from `@/lib/api-client`, and `useRef`/`useState`/`useEffect` are already imported:

```tsx
function AddressAutocomplete({ value, onCommit, className, placeholder }: {
  value: string; onCommit: (v: string) => void; className: string; placeholder?: string;
}) {
  const [text, setText] = useState(value);
  const [preds, setPreds] = useState<AddressPrediction[]>([]);
  const [open, setOpen] = useState(false);
  const session = useRef<string>('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { setText(value); }, [value]);

  function onType(v: string) {
    setText(v);
    if (timer.current) clearTimeout(timer.current);
    if (v.trim().length < 3) { setPreds([]); return; }
    timer.current = setTimeout(async () => {
      if (!session.current) session.current = (crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 36);
      try { const p = await addressSuggest(v, session.current); setPreds(p); setOpen(true); } catch { setPreds([]); }
    }, 250);
  }
  function choose(p: AddressPrediction) {
    setText(p.description); setOpen(false); setPreds([]); session.current = '';
    onCommit(p.description);
  }
  return (
    <div className="relative">
      <AutoTextarea
        className={className} placeholder={placeholder} value={text}
        onChange={onType}
        onBlur={() => { setTimeout(() => setOpen(false), 150); if (text !== value) onCommit(text); }}
      />
      {open && preds.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-56 w-[280px] overflow-auto rounded-lg border border-ff-border bg-ff-surface shadow-ff-lg">
          {preds.map((p) => (
            <li key={p.placeId}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); choose(p); }}
                className="block w-full px-3 py-2 text-left text-[12.5px] hover:bg-ff-green-50">{p.description}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Use it for the address cell ONLY when the row has an address issue**

In the desktop table Офис/Адрес cell, change the address branch (the `r.deliveryMode !== 'office'` case) so a flagged address uses autocomplete:

```tsx
                          {r.deliveryMode === 'office'
                            ? <AutoTextarea className={inpTa} placeholder="Офис" value={r.office ?? ''} onChange={(v) => patch(r, 'office', v)} onBlur={() => save(r)} />
                            : (r.validation?.issues ?? []).some((i) => i.code === 'address_unresolved' || i.code === 'address_fixable')
                              ? <AddressAutocomplete className={inpTa} placeholder="Адрес" value={r.address ?? ''} onCommit={(v) => { patch(r, 'address', v); save({ ...r, address: v }); }} />
                              : <AutoTextarea className={inpTa} placeholder="Адрес" value={r.address ?? ''} onChange={(v) => patch(r, 'address', v)} onBlur={() => save(r)} />}
```

- [ ] **Step 4: Typecheck + lint**

Run: `cd delivery-web && npx tsc --noEmit && npx next lint --file src/components/import-client.tsx`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add delivery-web/src/lib/api-client.ts delivery-web/src/components/import-client.tsx
git commit -m "feat(import): Places autocomplete on focus of a flagged address field"
```

---

## Final verification

- [ ] **Server suite**: `cd server && npx jest src/modules/import src/common/maps`
- [ ] **Frontend**: `cd delivery-web && npx tsc --noEmit && npx next lint`
- [ ] **Manual smoke (after deploy)**: upload a file with one messy address (e.g. `ул Граф Игнатиев бл до аптеката`) and one clean one. Expect the messy row flagged warn with „Адресът не се намира в Google — предложение…" + „Приеми"; accepting clears the issue. Focusing the messy address shows BG autocomplete suggestions. Office rows show no address issue.

## Notes / guardrails

- Eligibility is **warn**, never **error** — the farmer can still ship a flagged row.
- Geocode is 30-day cached, so repeat addresses cost nothing; broken addresses share one OpenAI call per upload; autocomplete bills one session per manual focus.
- If `GOOGLE_MAPS_API_KEY` is unset, `geocode`/`placeAutocomplete` return null/[] → every address is treated as eligible and no dropdown shows (graceful — matches existing stub behaviour). Confirm the key is set on the `dostavki` API before relying on the check.
