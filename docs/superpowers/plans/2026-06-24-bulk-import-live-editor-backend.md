# Bulk Import + Live Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a standalone producer upload an Excel/CSV of recipients, check it (deterministic + OpenAI), review/edit rows in a live editor, then bulk-create Econt/Speedy shipments and download labels.

**Architecture:** New `modules/import/` in the server. Pure helpers (parse → normalize → validate → AI merge → resolve) are unit-tested; an `ImportService` orchestrates them, persists drafts to two new tables (`import_batches`, `import_rows`), and on commit calls the existing `EcontService.createManualShipment` / `SpeedyService.createManualShipment`. Endpoints mount only on the standalone app. A minimal Alpine.js UI is served same-origin at `:3100/app`.

**Tech Stack:** NestJS, Drizzle (`@fermeribg/db`), `exceljs` (.xlsx), `papaparse` (.csv), `openai` SDK, `@nestjs/platform-express` (multer file upload), Alpine.js (CDN).

**Reference docs:** `docs/superpowers/specs/2026-06-24-bulk-import-live-editor-design.md`

**Conventions (read before starting):**
- Server package is `@fermeribg/api`. Typecheck: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`. Test: `pnpm --filter @fermeribg/api exec jest <pattern> --silent`. Lint: `pnpm --filter @fermeribg/api exec eslint <path>`.
- Money is integer **stotinki** (EUR cents) everywhere internally. Courier APIs use decimal EUR.
- All DB queries are tenant-scoped: every `import_batches`/`import_rows` read/write filters `tenant_id`.
- Errors must never crash the standalone; AI/resolve failures degrade, they don't throw to the user.
- Branch is `feat/econt-standalone-service` (already checked out). Do NOT switch branches.

---

## File Structure

- `packages/db/src/schema.ts` — MODIFY: add `importBatches` + `importRows` tables.
- `packages/db/migrations/0058_*.sql` — CREATE (generated): the two tables.
- `server/src/modules/import/import.types.ts` — CREATE: shared types.
- `server/src/modules/import/import.parse.ts` (+ `.spec.ts`) — CREATE: file buffer → `RawRow[]`.
- `server/src/modules/import/import.normalize.ts` (+ `.spec.ts`) — CREATE: `RawRow` → `NormalizedRow` (phone + currency).
- `server/src/modules/import/import.validate.ts` (+ `.spec.ts`) — CREATE: deterministic `RowValidation`.
- `server/src/modules/import/import.ai.ts` (+ `.spec.ts`) — CREATE: `mergeAi` (pure) + `ImportAiService` (OpenAI).
- `server/src/modules/import/import.resolve.ts` (+ `.spec.ts`) — CREATE: pure candidate matchers + `ImportResolveService`.
- `server/src/modules/import/dto/*.ts` — CREATE: upload-settings, patch-row, commit DTOs.
- `server/src/modules/import/import.service.ts` — CREATE: orchestration + draft CRUD + commit.
- `server/src/modules/import/import.controller.ts` — CREATE: standalone endpoints.
- `server/src/modules/import/import.module.ts` — CREATE: wires the above.
- `server/src/modules/econt-app/econt-app.module.ts` — MODIFY: import `ImportModule`.
- `server/src/config/env.validation.ts` — MODIFY: optional `OPENAI_API_KEY`, `OPENAI_IMPORT_MODEL`.
- `server/src/main.econt.ts` — MODIFY: serve `public/econt-app` static at `/app`.
- `server/public/econt-app/index.html` + `app.js` — CREATE: minimal UI.
- `server/package.json` — MODIFY: add `exceljs`, `papaparse`, `openai`, `@types/papaparse`, `@types/multer`.

---

## Task IM-1: Deps + schema + migration 0058 + shared types

**Files:**
- Modify: `server/package.json`
- Modify: `packages/db/src/schema.ts:416` (after the `shipments` table block)
- Create: `packages/db/migrations/0058_*.sql` (generated)
- Create: `server/src/modules/import/import.types.ts`

- [ ] **Step 1: Add dependencies**

In `server/package.json` add to `dependencies`: `"exceljs": "^4.4.0"`, `"papaparse": "^5.4.1"`, `"openai": "^4.67.0"`. Add to `devDependencies`: `"@types/papaparse": "^5.3.14"`, `"@types/multer": "^1.4.12"`.

Run: `pnpm install`
Expected: lockfile updates, no errors.

- [ ] **Step 2: Add the two tables to `packages/db/src/schema.ts`**

Insert directly after the `shipments` table block (after line 416, before the `codRisk` comment):

```ts
// --- Bulk import (standalone): staging for an uploaded Excel/CSV of recipients ---
// A batch holds one uploaded file; rows are editable drafts until committed into
// real `shipments`. Tenant-scoped like everything else in the standalone surface.
export const importBatches = pgTable(
  'import_batches',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    fileName: text('file_name'),
    carrierDefault: text('carrier_default').notNull().default('econt'), // 'econt' | 'speedy'
    currency: text('currency').notNull().default('EUR'), // 'BGN' | 'EUR'
    status: text('status').notNull().default('validating'), // validating|ready|partial|done
    settings: jsonb('settings'), // sender override, package preset, COD type, speedyServiceId
    aiReport: jsonb('ai_report'), // { aiAvailable, ok, warn, error }
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    tenantIdx: index('import_batches_tenant_idx').on(t.tenantId),
  }),
);

export const importRows = pgTable(
  'import_rows',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    rowIndex: integer('row_index').notNull(),
    raw: jsonb('raw'),
    receiverName: text('receiver_name'),
    receiverPhone: text('receiver_phone'),
    deliveryMode: text('delivery_mode'), // 'office' | 'address'
    city: text('city'),
    office: text('office'),
    address: text('address'),
    streetNo: text('street_no'),
    weightGrams: integer('weight_grams'),
    contents: text('contents'),
    codAmountStotinki: integer('cod_amount_stotinki'),
    declaredValueStotinki: integer('declared_value_stotinki'),
    carrier: text('carrier').notNull().default('econt'),
    validationStatus: text('validation_status').notNull().default('error'), // ok|warn|error
    validation: jsonb('validation'), // { issues: [...] }
    resolvedRefs: jsonb('resolved_refs'), // econtOfficeCode / siteId / officeId / streetId / candidates
    shipmentId: uuid('shipment_id').references(() => shipments.id),
    createStatus: text('create_status'), // null | 'created' | 'failed'
    createError: text('create_error'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    batchIdx: index('import_rows_batch_idx').on(t.batchId),
    tenantIdx: index('import_rows_tenant_idx').on(t.tenantId),
  }),
);
```

(`pgTable`, `uuid`, `text`, `integer`, `jsonb`, `timestamp`, `index`, `sql` are already imported at the top of `schema.ts` — confirm; all are used by existing tables.)

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter @fermeribg/db generate`
Expected: a new `packages/db/migrations/0058_*.sql` creating both tables. **Verify the file is purely additive** (two `CREATE TABLE` + indexes, no `ALTER`/`DROP` on existing tables). If drizzle-kit prompts interactively, abort and re-check the schema for accidental renames.

- [ ] **Step 4: Build the db dist + apply migration locally**

Run: `pnpm --filter @fermeribg/db build`
Then ensure local Postgres is up (compose at repo root: PG `127.0.0.1:5433`, db/user `farmflow`, pass `fermeribg`), and run: `pnpm --filter @fermeribg/db migrate`
Expected: migration 0058 applied, no errors.

- [ ] **Step 5: Create shared types `server/src/modules/import/import.types.ts`**

```ts
export type Carrier = 'econt' | 'speedy';
export type DeliveryMode = 'office' | 'address';
export type RowStatus = 'ok' | 'warn' | 'error';

/** A raw parsed row: header → cell value (string after parse). */
export interface RawRow {
  [header: string]: string;
}

/** Per-batch defaults applied to blank cells. */
export interface BatchDefaults {
  carrier: Carrier;
  currency: 'BGN' | 'EUR';
  weightGrams?: number;
  contents?: string;
  codProcessingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER';
  speedyServiceId?: number;
}

/** A row after header-mapping + typing + defaults. Money already in stotinki. */
export interface NormalizedRow {
  rowIndex: number;
  receiverName: string;
  receiverPhone: string;
  deliveryMode: DeliveryMode | null;
  city: string | null;
  office: string | null;
  address: string | null;
  streetNo: string | null;
  weightGrams: number | null;
  contents: string | null;
  codAmountStotinki: number | null;
  declaredValueStotinki: number | null;
  carrier: Carrier;
  raw: RawRow;
}

export interface RowIssue {
  field: string;
  message: string;
  suggestion?: string;
}

export interface RowValidation {
  status: RowStatus;
  issues: RowIssue[];
}

/** One row's AI verdict from OpenAI. */
export interface AiVerdict {
  index: number;
  status: RowStatus;
  issues: RowIssue[];
  normalized?: Partial<NormalizedRow>;
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
Expected: PASS (types file compiles; tables referenced later).

```bash
git add server/package.json pnpm-lock.yaml packages/db/src/schema.ts packages/db/migrations server/src/modules/import/import.types.ts
git commit -m "feat(import): deps + schema (import_batches/import_rows, migr 0058) + types"
```

---

## Task IM-2: File parse (pure, TDD)

**Files:**
- Create: `server/src/modules/import/import.parse.ts`
- Test: `server/src/modules/import/import.parse.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { parseFile, HEADER_ALIASES } from './import.parse';
import * as ExcelJS from 'exceljs';

describe('parseFile', () => {
  it('parses CSV into header-keyed rows, mapping BG + EN aliases to canonical keys', async () => {
    const csv = 'Получател,Телефон,Доставка,Град\nИван,0888123456,офис,Бургас\n';
    const rows = await parseFile(Buffer.from(csv, 'utf8'), 'list.csv');
    expect(rows).toEqual([
      { name: 'Иван', phone: '0888123456', mode: 'офис', city: 'Бургас' },
    ]);
  });

  it('maps English headers via aliases', async () => {
    const csv = 'name,phone,mode,city\nIvan,0888,address,Sofia\n';
    const rows = await parseFile(Buffer.from(csv, 'utf8'), 'list.csv');
    expect(rows[0]).toMatchObject({ name: 'Ivan', phone: '0888', mode: 'address', city: 'Sofia' });
  });

  it('skips fully-empty rows', async () => {
    const csv = 'name,phone\nIvan,0888\n,\n';
    const rows = await parseFile(Buffer.from(csv, 'utf8'), 'list.csv');
    expect(rows).toHaveLength(1);
  });

  it('parses XLSX with the first row as headers', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s');
    ws.addRow(['Получател', 'Телефон']);
    ws.addRow(['Мария', '0899111222']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const rows = await parseFile(buf, 'list.xlsx');
    expect(rows).toEqual([{ name: 'Мария', phone: '0899111222' }]);
  });

  it('exposes a canonical alias map', () => {
    expect(HEADER_ALIASES.name).toContain('получател');
    expect(HEADER_ALIASES.carrier).toContain('куриер');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api exec jest import.parse --silent`
Expected: FAIL (`parseFile` not defined).

- [ ] **Step 3: Implement `import.parse.ts`**

```ts
import * as Papa from 'papaparse';
import * as ExcelJS from 'exceljs';
import type { RawRow } from './import.types';

/** Canonical column key → accepted header spellings (lowercased, space/punct-stripped). */
export const HEADER_ALIASES: Record<string, string[]> = {
  name: ['получател', 'име', 'name', 'recipient', 'клиент'],
  phone: ['телефон', 'тел', 'phone', 'gsm'],
  mode: ['доставка', 'режим', 'mode', 'delivery', 'типдоставка'],
  city: ['град', 'населеномясто', 'city', 'town'],
  office: ['офис', 'office', 'офискод'],
  address: ['адрес', 'address', 'улица'],
  weight: ['тегло', 'теглокг', 'weight', 'kg'],
  contents: ['съдържание', 'contents', 'описание'],
  cod: ['наложенплатеж', 'нп', 'cod', 'наложен'],
  declared: ['обявенастойност', 'declared', 'застраховка'],
  carrier: ['куриер', 'carrier', 'превозвач'],
};

/** Normalize a header cell for matching: lowercase, strip spaces + punctuation. */
function normHeader(h: string): string {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[\s./_-]+/g, '')
    .trim();
}

/** Build header-index → canonical-key map. Unknown headers are dropped. */
function mapHeaders(headers: string[]): (string | null)[] {
  return headers.map((h) => {
    const n = normHeader(h);
    for (const [canon, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(n)) return canon;
    }
    return null;
  });
}

function rowFromCells(cells: string[], keys: (string | null)[]): RawRow | null {
  const row: RawRow = {};
  let hasValue = false;
  keys.forEach((k, i) => {
    if (!k) return;
    const v = (cells[i] ?? '').toString().trim();
    if (v) hasValue = true;
    row[k] = v;
  });
  return hasValue ? row : null;
}

/** Parse an uploaded .csv/.xlsx buffer into canonical header-keyed rows. */
export async function parseFile(buffer: Buffer, fileName: string): Promise<RawRow[]> {
  const isXlsx = /\.xlsx$/i.test(fileName);
  if (isXlsx) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const rows: string[][] = [];
    ws.eachRow((r) => {
      const cells: string[] = [];
      // exceljs is 1-indexed; values[0] is unused.
      const values = Array.isArray(r.values) ? r.values.slice(1) : [];
      for (const v of values) cells.push(v == null ? '' : String(v));
      rows.push(cells);
    });
    if (!rows.length) return [];
    const keys = mapHeaders(rows[0]);
    return rows.slice(1).map((c) => rowFromCells(c, keys)).filter((r): r is RawRow => r != null);
  }
  // CSV
  const text = buffer.toString('utf8');
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
  const data = (parsed.data ?? []).filter((r) => Array.isArray(r));
  if (!data.length) return [];
  const keys = mapHeaders(data[0]);
  return data.slice(1).map((c) => rowFromCells(c, keys)).filter((r): r is RawRow => r != null);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api exec jest import.parse --silent`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/import/import.parse.ts server/src/modules/import/import.parse.spec.ts
git commit -m "feat(import): file parse (xlsx+csv → canonical rows) + header aliases"
```

---

## Task IM-3: Normalize (pure, TDD)

**Files:**
- Create: `server/src/modules/import/import.normalize.ts`
- Test: `server/src/modules/import/import.normalize.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { normalizeRow, normalizeBgPhone, toStotinki } from './import.normalize';
import type { BatchDefaults, RawRow } from './import.types';

const defaults: BatchDefaults = { carrier: 'econt', currency: 'EUR', weightGrams: 1000 };

describe('normalizeBgPhone', () => {
  it('keeps a valid +359 mobile', () => {
    expect(normalizeBgPhone('+359888123456')).toBe('+359888123456');
  });
  it('converts 08... to +359...', () => {
    expect(normalizeBgPhone('0888123456')).toBe('+359888123456');
  });
  it('converts 359... to +359...', () => {
    expect(normalizeBgPhone('359888123456')).toBe('+359888123456');
  });
  it('strips spaces/dashes', () => {
    expect(normalizeBgPhone('088 812-34-56')).toBe('+359888123456');
  });
  it('returns null for garbage', () => {
    expect(normalizeBgPhone('hello')).toBeNull();
  });
});

describe('toStotinki', () => {
  it('EUR decimal → cents', () => {
    expect(toStotinki('12.50', 'EUR')).toBe(1250);
  });
  it('BGN → EUR cents at the fixed rate', () => {
    // 19.5583 BGN / 1.95583 = 10.00 EUR → 1000
    expect(toStotinki('19.5583', 'BGN')).toBe(1000);
  });
  it('blank → null', () => {
    expect(toStotinki('', 'EUR')).toBeNull();
  });
  it('non-numeric → null', () => {
    expect(toStotinki('abc', 'EUR')).toBeNull();
  });
});

describe('normalizeRow', () => {
  it('maps fields, applies defaults, normalizes phone + money', () => {
    const raw: RawRow = {
      name: 'Иван', phone: '0888123456', mode: 'офис', city: 'Бургас',
      office: 'Изгрев', cod: '20', weight: '2',
    };
    const out = normalizeRow(raw, 3, defaults);
    expect(out).toMatchObject({
      rowIndex: 3,
      receiverName: 'Иван',
      receiverPhone: '+359888123456',
      deliveryMode: 'office',
      city: 'Бургас',
      office: 'Изгрев',
      weightGrams: 2000,
      codAmountStotinki: 2000,
      carrier: 'econt',
    });
  });

  it('falls back to batch defaults for blank weight/contents/carrier', () => {
    const out = normalizeRow({ name: 'A', phone: '0888', mode: 'address' }, 1, {
      ...defaults, contents: 'Зеленчуци', carrier: 'speedy',
    });
    expect(out.weightGrams).toBe(1000);
    expect(out.contents).toBe('Зеленчуци');
    expect(out.carrier).toBe('speedy');
  });

  it('keeps deliveryMode null when unparseable', () => {
    const out = normalizeRow({ name: 'A', phone: '0888', mode: 'хеликоптер' }, 1, defaults);
    expect(out.deliveryMode).toBeNull();
  });

  it('parses an EN carrier value case-insensitively', () => {
    const out = normalizeRow({ name: 'A', phone: '0888', carrier: 'Speedy' }, 1, defaults);
    expect(out.carrier).toBe('speedy');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api exec jest import.normalize --silent`
Expected: FAIL (`normalizeRow` not defined).

- [ ] **Step 3: Implement `import.normalize.ts`**

```ts
import type { BatchDefaults, Carrier, DeliveryMode, NormalizedRow, RawRow } from './import.types';

const BGN_PER_EUR = 1.95583;

/** Normalize a Bulgarian phone to +359XXXXXXXXX, or null if it isn't one. */
export function normalizeBgPhone(raw: string | undefined | null): string | null {
  const digits = String(raw ?? '').replace(/[^\d+]/g, '');
  let n = digits;
  if (n.startsWith('+359')) n = n.slice(4);
  else if (n.startsWith('00359')) n = n.slice(5);
  else if (n.startsWith('359')) n = n.slice(3);
  else if (n.startsWith('0')) n = n.slice(1);
  else return null;
  // BG mobile national part is 9 digits (e.g. 888123456).
  if (!/^\d{9}$/.test(n)) return null;
  return `+359${n}`;
}

/** Parse a money cell (decimal in the batch currency) into EUR stotinki, or null. */
export function toStotinki(raw: string | undefined | null, currency: 'BGN' | 'EUR'): number | null {
  const s = String(raw ?? '').replace(/\s/g, '').replace(',', '.');
  if (!s) return null;
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  const eur = currency === 'BGN' ? v / BGN_PER_EUR : v;
  return Math.round(eur * 100);
}

function parseMode(raw: string | undefined): DeliveryMode | null {
  const n = String(raw ?? '').toLowerCase().trim();
  if (['офис', 'office'].includes(n)) return 'office';
  if (['адрес', 'address'].includes(n)) return 'address';
  return null;
}

function parseCarrier(raw: string | undefined, fallback: Carrier): Carrier {
  const n = String(raw ?? '').toLowerCase().trim();
  if (n === 'speedy' || n === 'спиди') return 'speedy';
  if (n === 'econt' || n === 'еконт') return 'econt';
  return fallback;
}

function parseWeightGrams(raw: string | undefined): number | null {
  const s = String(raw ?? '').replace(/\s/g, '').replace(',', '.');
  if (!s) return null;
  const kg = Number(s);
  if (!Number.isFinite(kg) || kg <= 0) return null;
  return Math.round(kg * 1000);
}

const blank = (s: string | undefined): string | null => {
  const v = String(s ?? '').trim();
  return v ? v : null;
};

/** Map a raw parsed row to a typed NormalizedRow, applying batch defaults. */
export function normalizeRow(raw: RawRow, rowIndex: number, defaults: BatchDefaults): NormalizedRow {
  return {
    rowIndex,
    receiverName: String(raw.name ?? '').trim(),
    receiverPhone: normalizeBgPhone(raw.phone) ?? String(raw.phone ?? '').trim(),
    deliveryMode: parseMode(raw.mode),
    city: blank(raw.city),
    office: blank(raw.office),
    address: blank(raw.address),
    streetNo: null,
    weightGrams: parseWeightGrams(raw.weight) ?? defaults.weightGrams ?? null,
    contents: blank(raw.contents) ?? defaults.contents ?? null,
    codAmountStotinki: toStotinki(raw.cod, defaults.currency),
    declaredValueStotinki: toStotinki(raw.declared, defaults.currency),
    carrier: parseCarrier(raw.carrier, defaults.carrier),
    raw,
  };
}
```

Note: `receiverPhone` keeps the raw value when un-normalizable so validation (next task) can flag it; `normalizeBgPhone` is the authority on validity.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api exec jest import.normalize --silent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/import/import.normalize.ts server/src/modules/import/import.normalize.spec.ts
git commit -m "feat(import): normalize row (phone, currency→stotinki, mode/carrier, defaults)"
```

---

## Task IM-4: Deterministic validation (pure, TDD)

**Files:**
- Create: `server/src/modules/import/import.validate.ts`
- Test: `server/src/modules/import/import.validate.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { validateRow } from './import.validate';
import type { NormalizedRow } from './import.types';

const base: NormalizedRow = {
  rowIndex: 1, receiverName: 'Иван', receiverPhone: '+359888123456',
  deliveryMode: 'office', city: 'Бургас', office: 'Изгрев', address: null, streetNo: null,
  weightGrams: 1000, contents: 'Зеленчуци', codAmountStotinki: null,
  declaredValueStotinki: null, carrier: 'econt', raw: {},
};

describe('validateRow', () => {
  it('passes a complete office row', () => {
    expect(validateRow(base).status).toBe('ok');
  });

  it('errors on missing name', () => {
    const v = validateRow({ ...base, receiverName: '' });
    expect(v.status).toBe('error');
    expect(v.issues.some((i) => i.field === 'receiverName')).toBe(true);
  });

  it('errors on invalid phone', () => {
    const v = validateRow({ ...base, receiverPhone: 'abc' });
    expect(v.status).toBe('error');
    expect(v.issues.some((i) => i.field === 'receiverPhone')).toBe(true);
  });

  it('errors when deliveryMode is missing', () => {
    const v = validateRow({ ...base, deliveryMode: null });
    expect(v.status).toBe('error');
    expect(v.issues.some((i) => i.field === 'deliveryMode')).toBe(true);
  });

  it('errors when office mode but no office', () => {
    const v = validateRow({ ...base, office: null });
    expect(v.status).toBe('error');
    expect(v.issues.some((i) => i.field === 'office')).toBe(true);
  });

  it('errors when address mode but no city or address', () => {
    const v = validateRow({ ...base, deliveryMode: 'address', office: null, city: null, address: null });
    expect(v.issues.some((i) => i.field === 'city')).toBe(true);
    expect(v.issues.some((i) => i.field === 'address')).toBe(true);
  });

  it('warns (not errors) on a missing weight', () => {
    const v = validateRow({ ...base, weightGrams: null });
    expect(v.status).toBe('warn');
    expect(v.issues.some((i) => i.field === 'weightGrams')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api exec jest import.validate --silent`
Expected: FAIL.

- [ ] **Step 3: Implement `import.validate.ts`**

```ts
import { normalizeBgPhone } from './import.normalize';
import type { NormalizedRow, RowIssue, RowStatus, RowValidation } from './import.types';

/** Deterministic, carrier-agnostic validation. Authoritative for blocking (errors). */
export function validateRow(row: NormalizedRow): RowValidation {
  const issues: RowIssue[] = [];
  const err = (field: string, message: string) => issues.push({ field, message });
  const warn = (field: string, message: string) => issues.push({ field, message });

  let hardError = false;

  if (!row.receiverName.trim()) { err('receiverName', 'Липсва получател'); hardError = true; }
  if (!normalizeBgPhone(row.receiverPhone)) { err('receiverPhone', 'Невалиден телефон'); hardError = true; }

  if (!row.deliveryMode) {
    err('deliveryMode', 'Липсва тип доставка (офис/адрес)');
    hardError = true;
  } else if (row.deliveryMode === 'office') {
    if (!row.office) { err('office', 'Режим офис, но липсва офис'); hardError = true; }
  } else {
    if (!row.city) { err('city', 'Режим адрес, но липсва град'); hardError = true; }
    if (!row.address) { err('address', 'Режим адрес, но липсва адрес'); hardError = true; }
  }

  let soft = false;
  if (row.weightGrams == null) { warn('weightGrams', 'Липсва тегло — ще се ползва по подразбиране'); soft = true; }

  const status: RowStatus = hardError ? 'error' : soft ? 'warn' : 'ok';
  return { status, issues };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api exec jest import.validate --silent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/import/import.validate.ts server/src/modules/import/import.validate.spec.ts
git commit -m "feat(import): deterministic row validation (required fields, phone, mode)"
```

---

## Task IM-5: AI merge (pure, TDD) + ImportAiService (OpenAI)

**Files:**
- Create: `server/src/modules/import/import.ai.ts`
- Test: `server/src/modules/import/import.ai.spec.ts`

- [ ] **Step 1: Write the failing test (for the pure merge)**

```ts
import { mergeAi } from './import.ai';
import type { RowValidation, AiVerdict } from './import.types';

describe('mergeAi', () => {
  const okValidation: RowValidation = { status: 'ok', issues: [] };

  it('returns deterministic validation unchanged when there is no AI verdict', () => {
    expect(mergeAi(okValidation, undefined)).toEqual(okValidation);
  });

  it('AI can raise ok → warn and append its issues', () => {
    const ai: AiVerdict = { index: 0, status: 'warn', issues: [{ field: 'city', message: 'Неясен град' }] };
    const out = mergeAi(okValidation, ai);
    expect(out.status).toBe('warn');
    expect(out.issues).toHaveLength(1);
  });

  it('AI cannot downgrade a hard error to ok', () => {
    const errValidation: RowValidation = { status: 'error', issues: [{ field: 'receiverName', message: 'Липсва' }] };
    const ai: AiVerdict = { index: 0, status: 'ok', issues: [] };
    const out = mergeAi(errValidation, ai);
    expect(out.status).toBe('error');
  });

  it('keeps the more severe of the two statuses', () => {
    const warnValidation: RowValidation = { status: 'warn', issues: [] };
    const ai: AiVerdict = { index: 0, status: 'error', issues: [{ field: 'phone', message: 'грешен' }] };
    expect(mergeAi(warnValidation, ai).status).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api exec jest import.ai --silent`
Expected: FAIL.

- [ ] **Step 3: Implement `import.ai.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { AiVerdict, NormalizedRow, RowStatus, RowValidation } from './import.types';

const SEVERITY: Record<RowStatus, number> = { ok: 0, warn: 1, error: 2 };

/** Combine deterministic validation with an AI verdict. Deterministic is authoritative:
 *  AI may raise severity (ok→warn→error) and add explanations, but cannot clear an error. */
export function mergeAi(det: RowValidation, ai: AiVerdict | undefined): RowValidation {
  if (!ai) return det;
  const status = SEVERITY[ai.status] > SEVERITY[det.status] ? ai.status : det.status;
  return { status, issues: [...det.issues, ...ai.issues] };
}

const SYSTEM_PROMPT = `Ти си помощник за проверка на таблица с пратки за български куриери (Еконт, Спиди).
За всеки ред върни JSON обект с: index (число), status ("ok"|"warn"|"error"), issues (масив от {field, message, suggestion?}).
Маркирай: липсващи задължителни полета, невалиден български телефон, неясен или непознат град, тип доставка който не пасва на дадените полета, нечислов наложен платеж.
Когато можеш да предложиш поправка, дай я в issue.suggestion и в normalized (частичен обект със същите ключове като реда).
Връщай само JSON: {"rows":[...]}. Без друг текст.`;

@Injectable()
export class ImportAiService {
  private readonly log = new Logger(ImportAiService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    const key = config.get<string>('OPENAI_API_KEY');
    this.client = key ? new OpenAI({ apiKey: key }) : null;
    this.model = config.get<string>('OPENAI_IMPORT_MODEL', 'gpt-4o-mini');
  }

  get available(): boolean {
    return this.client != null;
  }

  /** Ask OpenAI to vet the rows. Never throws — returns [] on any failure (degrade). */
  async review(rows: NormalizedRow[]): Promise<AiVerdict[]> {
    if (!this.client || !rows.length) return [];
    try {
      const payload = rows.map((r) => ({
        index: r.rowIndex,
        name: r.receiverName,
        phone: r.receiverPhone,
        mode: r.deliveryMode,
        city: r.city,
        office: r.office,
        address: r.address,
        cod: r.codAmountStotinki,
        carrier: r.carrier,
      }));
      const res = await this.client.chat.completions.create({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ rows: payload }) },
        ],
      });
      const txt = res.choices[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(txt) as { rows?: AiVerdict[] };
      return Array.isArray(parsed.rows) ? parsed.rows : [];
    } catch (e) {
      this.log.warn(`OpenAI import review failed, degrading: ${String((e as Error)?.message ?? e)}`);
      return [];
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api exec jest import.ai --silent`
Expected: PASS (the `mergeAi` tests; `ImportAiService` is exercised at integration/boot, not unit-mocked here).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/import/import.ai.ts server/src/modules/import/import.ai.spec.ts
git commit -m "feat(import): AI verdict merge (pure) + ImportAiService (OpenAI, degrade-safe)"
```

---

## Task IM-6: Carrier resolve (pure matchers TDD + ImportResolveService)

**Files:**
- Create: `server/src/modules/import/import.resolve.ts`
- Test: `server/src/modules/import/import.resolve.spec.ts`

- [ ] **Step 1: Write the failing test (pure matchers)**

```ts
import { pickBest, matchByName } from './import.resolve';

describe('pickBest', () => {
  it('returns the exact (case-insensitive) name match when present', () => {
    const list = [{ id: 1, name: 'Бургас' }, { id: 2, name: 'Бургаски' }];
    expect(pickBest(list, 'бургас', (x) => x.name)).toEqual({ chosen: list[0], ambiguous: false, candidates: [] });
  });

  it('flags ambiguity when several prefix-match and none is exact', () => {
    const list = [{ id: 1, name: 'Софийка' }, { id: 2, name: 'Софиево' }];
    const out = pickBest(list, 'софи', (x) => x.name);
    expect(out.chosen).toBeNull();
    expect(out.ambiguous).toBe(true);
    expect(out.candidates).toHaveLength(2);
  });

  it('returns null/empty when there is no match', () => {
    expect(pickBest([{ id: 1, name: 'Варна' }], 'пловдив', (x: any) => x.name)).toEqual({
      chosen: null, ambiguous: false, candidates: [],
    });
  });

  it('auto-picks a single prefix match', () => {
    const out = pickBest([{ id: 9, name: 'Пловдив' }], 'плов', (x) => x.name);
    expect(out.chosen).toEqual({ id: 9, name: 'Пловдив' });
  });
});

describe('matchByName', () => {
  it('finds an office by case-insensitive substring', () => {
    const offices = [{ code: 'A1', name: 'Изгрев' }, { code: 'B2', name: 'Център' }];
    expect(matchByName(offices, 'изгрев', (o) => o.name)?.code).toBe('A1');
  });
  it('returns null when none match', () => {
    expect(matchByName([{ code: 'A1', name: 'Изгрев' }], 'няма', (o) => o.name)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api exec jest import.resolve --silent`
Expected: FAIL.

- [ ] **Step 3: Implement `import.resolve.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { EcontService } from '../econt/econt.service';
import { SpeedyService } from '../speedy/speedy.service';
import type { NormalizedRow } from './import.types';

export interface PickResult<T> {
  chosen: T | null;
  ambiguous: boolean;
  candidates: T[];
}

/** Choose the best location match: exact name wins; a single prefix match auto-picks;
 *  several prefix matches with no exact → ambiguous (surface candidates in the editor). */
export function pickBest<T>(list: T[], query: string, name: (x: T) => string): PickResult<T> {
  const q = query.toLowerCase().trim();
  if (!q || !list.length) return { chosen: null, ambiguous: false, candidates: [] };
  const exact = list.find((x) => name(x).toLowerCase().trim() === q);
  if (exact) return { chosen: exact, ambiguous: false, candidates: [] };
  const prefix = list.filter((x) => name(x).toLowerCase().trim().startsWith(q));
  if (prefix.length === 1) return { chosen: prefix[0], ambiguous: false, candidates: [] };
  if (prefix.length > 1) return { chosen: null, ambiguous: true, candidates: prefix.slice(0, 10) };
  return { chosen: null, ambiguous: false, candidates: [] };
}

/** Find by case-insensitive substring; first hit or null. */
export function matchByName<T>(list: T[], query: string, name: (x: T) => string): T | null {
  const q = query.toLowerCase().trim();
  return list.find((x) => name(x).toLowerCase().includes(q)) ?? null;
}

/** What resolution produced for one row: refs to stamp + a status hint. */
export interface ResolveResult {
  refs: Record<string, unknown>;
  ambiguous: boolean;
  unresolved: string | null; // field name that couldn't be resolved, or null
}

@Injectable()
export class ImportResolveService {
  constructor(
    private readonly econt: EcontService,
    private readonly speedy: SpeedyService,
  ) {}

  /** Resolve a row's human-typed location into carrier ids/codes. Never throws. */
  async resolve(tenantId: string, row: NormalizedRow): Promise<ResolveResult> {
    try {
      return row.carrier === 'speedy'
        ? await this.resolveSpeedy(tenantId, row)
        : await this.resolveEcont(tenantId, row);
    } catch {
      // A location-lookup outage shouldn't block the import; leave it unresolved.
      return { refs: {}, ambiguous: false, unresolved: row.deliveryMode === 'office' ? 'office' : 'city' };
    }
  }

  private async resolveEcont(tenantId: string, row: NormalizedRow): Promise<ResolveResult> {
    // Econt addresses are free-text; only office mode needs a resolved office CODE.
    if (row.deliveryMode !== 'office' || !row.office) return { refs: {}, ambiguous: false, unresolved: null };
    // If the cell already looks like an office code, pass it through.
    if (/^\d{3,}$/.test(row.office)) return { refs: { econtOfficeCode: row.office }, ambiguous: false, unresolved: null };
    const cities = await this.econt.searchCities(tenantId, row.city ?? row.office);
    const cityId = cities[0]?.id;
    if (!cityId) return { refs: {}, ambiguous: false, unresolved: 'office' };
    const offices = await this.econt.getOfficesForCity(tenantId, cityId);
    const hit = matchByName(offices, row.office, (o) => o.name);
    if (!hit) return { refs: {}, ambiguous: offices.length > 1, unresolved: 'office' };
    return { refs: { econtOfficeCode: hit.code }, ambiguous: false, unresolved: null };
  }

  private async resolveSpeedy(tenantId: string, row: NormalizedRow): Promise<ResolveResult> {
    if (!row.city) return { refs: {}, ambiguous: false, unresolved: 'city' };
    const sites = await this.speedy.searchSites(tenantId, row.city);
    const site = pickBest(sites, row.city, (s) => s.name);
    if (!site.chosen) {
      return { refs: { siteCandidates: site.candidates }, ambiguous: site.ambiguous, unresolved: 'city' };
    }
    const siteId = site.chosen.id;
    if (row.deliveryMode === 'office') {
      const offices = await this.speedy.getOffices(tenantId, siteId);
      const office = row.office ? matchByName(offices, row.office, (o) => o.name) : null;
      if (!office) return { refs: { siteId }, ambiguous: offices.length > 1, unresolved: 'office' };
      return { refs: { siteId, officeId: office.id }, ambiguous: false, unresolved: null };
    }
    // address mode: best-effort street resolution
    const refs: Record<string, unknown> = { siteId };
    if (row.address) {
      const streets = await this.speedy.getStreets(tenantId, siteId, row.address);
      const street = pickBest(streets, row.address, (s) => s.name);
      if (street.chosen) refs.streetId = street.chosen.id;
    }
    return { refs, ambiguous: false, unresolved: null };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api exec jest import.resolve --silent`
Expected: PASS (pure matcher tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/import/import.resolve.ts server/src/modules/import/import.resolve.spec.ts
git commit -m "feat(import): carrier location resolve (Econt code / Speedy ids) + pure matchers"
```

---

## Task IM-7: DTOs

**Files:**
- Create: `server/src/modules/import/dto/import-settings.dto.ts`
- Create: `server/src/modules/import/dto/patch-row.dto.ts`

- [ ] **Step 1: Implement `import-settings.dto.ts`**

```ts
import { IsString, IsIn, IsOptional, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** Batch-level defaults posted alongside the uploaded file (multipart fields are strings;
 *  numeric fields are coerced via @Type). */
export class ImportSettingsDto {
  @IsIn(['econt', 'speedy'])
  carrier!: 'econt' | 'speedy';

  @IsIn(['BGN', 'EUR'])
  currency!: 'BGN' | 'EUR';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  weightGrams?: number;

  @IsOptional() @IsString()
  contents?: string;

  @IsOptional() @IsIn(['CASH', 'POSTAL_MONEY_TRANSFER'])
  codProcessingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  speedyServiceId?: number;
}
```

- [ ] **Step 2: Implement `patch-row.dto.ts`**

```ts
import { IsString, IsIn, IsOptional, IsInt, Min, MaxLength } from 'class-validator';

/** Editable fields of a draft row. All optional — only sent fields are updated, then the
 *  row is re-validated + re-resolved. */
export class PatchRowDto {
  @IsOptional() @IsString() @MaxLength(120) receiverName?: string;
  @IsOptional() @IsString() @MaxLength(40) receiverPhone?: string;
  @IsOptional() @IsIn(['office', 'address']) deliveryMode?: 'office' | 'address';
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(120) office?: string;
  @IsOptional() @IsString() @MaxLength(240) address?: string;
  @IsOptional() @IsString() @MaxLength(20) streetNo?: string;
  @IsOptional() @IsInt() @Min(0) weightGrams?: number;
  @IsOptional() @IsString() @MaxLength(120) contents?: string;
  @IsOptional() @IsInt() @Min(0) codAmountStotinki?: number;
  @IsOptional() @IsInt() @Min(0) declaredValueStotinki?: number;
  @IsOptional() @IsIn(['econt', 'speedy']) carrier?: 'econt' | 'speedy';
  // When the user picks an ambiguity candidate, the chosen ids ride here.
  @IsOptional() @IsInt() siteId?: number;
  @IsOptional() @IsInt() officeId?: number;
  @IsOptional() @IsInt() streetId?: number;
  @IsOptional() @IsString() @MaxLength(20) econtOfficeCode?: string;
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
Expected: PASS.

```bash
git add server/src/modules/import/dto
git commit -m "feat(import): DTOs — batch settings + patch-row"
```

---

## Task IM-8: ImportService — create batch (orchestrate + persist)

**Files:**
- Create: `server/src/modules/import/import.service.ts`

- [ ] **Step 1: Implement the service's create path**

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE } from '../../common/drizzle/drizzle.module';
import type { DrizzleDb } from '../../common/drizzle/drizzle.module';
import { Inject } from '@nestjs/common';
import { importBatches, importRows } from '@fermeribg/db/schema';
import { parseFile } from './import.parse';
import { normalizeRow } from './import.normalize';
import { validateRow } from './import.validate';
import { mergeAi, ImportAiService } from './import.ai';
import { ImportResolveService } from './import.resolve';
import type { BatchDefaults, NormalizedRow, RowStatus } from './import.types';
import { ImportSettingsDto } from './dto/import-settings.dto';

const MAX_ROWS = 200;

@Injectable()
export class ImportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ai: ImportAiService,
    private readonly resolver: ImportResolveService,
  ) {}

  /** Parse + validate + resolve + AI-check an uploaded file → a persisted draft batch. */
  async createBatch(tenantId: string, file: { buffer: Buffer; originalname: string }, settings: ImportSettingsDto) {
    if (!file?.buffer?.length) throw new BadRequestException('Празен файл');
    if (!/\.(xlsx|csv)$/i.test(file.originalname)) {
      throw new BadRequestException('Поддържат се само .xlsx и .csv файлове');
    }
    const raw = await parseFile(file.buffer, file.originalname);
    if (!raw.length) throw new BadRequestException('Файлът няма редове с данни');
    if (raw.length > MAX_ROWS) throw new BadRequestException(`Максимум ${MAX_ROWS} реда на файл (${raw.length} намерени)`);

    const defaults: BatchDefaults = {
      carrier: settings.carrier,
      currency: settings.currency,
      weightGrams: settings.weightGrams,
      contents: settings.contents,
      codProcessingType: settings.codProcessingType,
      speedyServiceId: settings.speedyServiceId,
    };
    const normalized = raw.map((r, i) => normalizeRow(r, i + 1, defaults));

    // AI pass over the whole batch (one call; degrades to [] if unavailable).
    const verdicts = await this.ai.review(normalized);
    const verdictByIndex = new Map(verdicts.map((v) => [v.index, v]));

    // Resolve locations per row (sequential to respect per-tenant rate limits).
    const counts: Record<RowStatus, number> = { ok: 0, warn: 0, error: 0 };
    const rowsToInsert: (typeof importRows.$inferInsert)[] = [];
    const [batch] = await this.db
      .insert(importBatches)
      .values({
        tenantId,
        fileName: file.originalname,
        carrierDefault: settings.carrier,
        currency: settings.currency,
        status: 'validating',
        settings: defaults as Record<string, unknown>,
      })
      .returning();

    for (const row of normalized) {
      const det = validateRow(row);
      const resolved = det.status === 'error' ? { refs: {}, ambiguous: false, unresolved: null }
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
      counts[validation.status]++;
      rowsToInsert.push(this.toRowInsert(batch.id, tenantId, row, validation, resolved.refs));
    }

    await this.db.insert(importRows).values(rowsToInsert);
    const aiReport = { aiAvailable: this.ai.available, ...counts };
    await this.db.update(importBatches)
      .set({ status: 'ready', aiReport })
      .where(and(eq(importBatches.id, batch.id), eq(importBatches.tenantId, tenantId)));

    return this.getBatch(tenantId, batch.id);
  }

  private toRowInsert(
    batchId: string, tenantId: string, row: NormalizedRow,
    validation: { status: RowStatus; issues: unknown[] }, refs: Record<string, unknown>,
  ): typeof importRows.$inferInsert {
    return {
      batchId, tenantId, rowIndex: row.rowIndex, raw: row.raw,
      receiverName: row.receiverName, receiverPhone: row.receiverPhone,
      deliveryMode: row.deliveryMode, city: row.city, office: row.office,
      address: row.address, streetNo: row.streetNo, weightGrams: row.weightGrams,
      contents: row.contents, codAmountStotinki: row.codAmountStotinki,
      declaredValueStotinki: row.declaredValueStotinki, carrier: row.carrier,
      validationStatus: validation.status, validation: { issues: validation.issues },
      resolvedRefs: refs,
    };
  }

  /** Fetch a batch + its rows (tenant-scoped). */
  async getBatch(tenantId: string, batchId: string) {
    const [batch] = await this.db.select().from(importBatches)
      .where(and(eq(importBatches.id, batchId), eq(importBatches.tenantId, tenantId))).limit(1);
    if (!batch) throw new NotFoundException('Партидата не е намерена');
    const rows = await this.db.select().from(importRows)
      .where(and(eq(importRows.batchId, batchId), eq(importRows.tenantId, tenantId)))
      .orderBy(importRows.rowIndex);
    return { batch, rows };
  }
}
```

Note on imports: confirm the Drizzle injection token + type in `server/src/common/drizzle/drizzle.module.ts` (it may export `DRIZZLE`/`DrizzleDb` or a differently-named token — match the existing pattern used by `econt.service.ts`, which injects the same db). Adjust the import line accordingly.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
Expected: PASS. Fix any drizzle-token mismatch per the note.

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/import/import.service.ts
git commit -m "feat(import): ImportService.createBatch (parse→validate→resolve→AI→persist)"
```

---

## Task IM-9: ImportService — draft CRUD (patch + delete)

**Files:**
- Modify: `server/src/modules/import/import.service.ts`

- [ ] **Step 1: Add patch + delete methods to `ImportService`**

Add these methods inside the class (after `getBatch`):

```ts
  /** Update editable fields of a draft row, then re-validate + re-resolve it. */
  async patchRow(tenantId: string, batchId: string, rowId: string, patch: import('./dto/patch-row.dto').PatchRowDto) {
    const [existing] = await this.db.select().from(importRows)
      .where(and(eq(importRows.id, rowId), eq(importRows.batchId, batchId), eq(importRows.tenantId, tenantId)))
      .limit(1);
    if (!existing) throw new NotFoundException('Редът не е намерен');

    // Apply only provided fields.
    const merged: NormalizedRow = {
      rowIndex: existing.rowIndex,
      receiverName: patch.receiverName ?? existing.receiverName ?? '',
      receiverPhone: patch.receiverPhone ?? existing.receiverPhone ?? '',
      deliveryMode: (patch.deliveryMode ?? existing.deliveryMode) as NormalizedRow['deliveryMode'],
      city: patch.city ?? existing.city ?? null,
      office: patch.office ?? existing.office ?? null,
      address: patch.address ?? existing.address ?? null,
      streetNo: patch.streetNo ?? existing.streetNo ?? null,
      weightGrams: patch.weightGrams ?? existing.weightGrams ?? null,
      contents: patch.contents ?? existing.contents ?? null,
      codAmountStotinki: patch.codAmountStotinki ?? existing.codAmountStotinki ?? null,
      declaredValueStotinki: patch.declaredValueStotinki ?? existing.declaredValueStotinki ?? null,
      carrier: (patch.carrier ?? existing.carrier) as NormalizedRow['carrier'],
      raw: (existing.raw as NormalizedRow['raw']) ?? {},
    };

    const det = validateRow(merged);
    // User-picked ids from the editor take priority over auto-resolution.
    const manualRefs: Record<string, unknown> = {};
    for (const k of ['siteId', 'officeId', 'streetId', 'econtOfficeCode'] as const) {
      if (patch[k] != null) manualRefs[k] = patch[k];
    }
    let refs = { ...(existing.resolvedRefs as Record<string, unknown> | null ?? {}), ...manualRefs };
    let validation = det;
    if (det.status !== 'error' && !Object.keys(manualRefs).length) {
      const resolved = await this.resolver.resolve(tenantId, merged);
      refs = resolved.refs;
      if (resolved.ambiguous || resolved.unresolved) {
        validation = {
          status: 'warn',
          issues: [...det.issues, { field: resolved.unresolved ?? 'city', message: 'Провери локацията' }],
        };
      }
    }

    const [updated] = await this.db.update(importRows).set({
      receiverName: merged.receiverName, receiverPhone: merged.receiverPhone,
      deliveryMode: merged.deliveryMode, city: merged.city, office: merged.office,
      address: merged.address, streetNo: merged.streetNo, weightGrams: merged.weightGrams,
      contents: merged.contents, codAmountStotinki: merged.codAmountStotinki,
      declaredValueStotinki: merged.declaredValueStotinki, carrier: merged.carrier,
      validationStatus: validation.status, validation: { issues: validation.issues }, resolvedRefs: refs,
    }).where(and(eq(importRows.id, rowId), eq(importRows.tenantId, tenantId))).returning();
    return updated;
  }

  /** Remove a draft row (tenant-scoped). */
  async deleteRow(tenantId: string, batchId: string, rowId: string) {
    const res = await this.db.delete(importRows)
      .where(and(eq(importRows.id, rowId), eq(importRows.batchId, batchId), eq(importRows.tenantId, tenantId)))
      .returning({ id: importRows.id });
    if (!res.length) throw new NotFoundException('Редът не е намерен');
    return { deleted: true };
  }
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/import/import.service.ts
git commit -m "feat(import): draft row patch (re-validate/resolve) + delete"
```

---

## Task IM-10: ImportService — commit (draft → real shipments)

**Files:**
- Modify: `server/src/modules/import/import.service.ts`

- [ ] **Step 1: Add the commit method**

Add to the class. It needs `EcontService` + `SpeedyService` — extend the constructor:

```ts
  // extend constructor params:
  //   private readonly econtSvc: EcontService,
  //   private readonly speedySvc: SpeedyService,
```

```ts
  /** Create real shipments for every committable row (ok, or warn the user accepted).
   *  Per-row try/catch → one failure is isolated; the rest still get created. */
  async commit(tenantId: string, batchId: string) {
    const { batch, rows } = await this.getBatch(tenantId, batchId);
    const speedyServiceId = (batch.settings as { speedyServiceId?: number } | null)?.speedyServiceId;

    const results: Array<{ rowId: string; status: 'created' | 'failed' | 'skipped'; shipmentId?: string; error?: string }> = [];
    for (const row of rows) {
      if (row.shipmentId) { results.push({ rowId: row.id, status: 'skipped' }); continue; }
      if (row.validationStatus === 'error') { results.push({ rowId: row.id, status: 'skipped' }); continue; }
      try {
        const shipmentId = row.carrier === 'speedy'
          ? await this.createSpeedy(tenantId, row, speedyServiceId)
          : await this.createEcont(tenantId, row);
        await this.db.update(importRows).set({ shipmentId, createStatus: 'created', createError: null })
          .where(and(eq(importRows.id, row.id), eq(importRows.tenantId, tenantId)));
        results.push({ rowId: row.id, status: 'created', shipmentId });
      } catch (e) {
        const error = String((e as Error)?.message ?? e).slice(0, 240);
        await this.db.update(importRows).set({ createStatus: 'failed', createError: error })
          .where(and(eq(importRows.id, row.id), eq(importRows.tenantId, tenantId)));
        results.push({ rowId: row.id, status: 'failed', error });
      }
    }

    const created = results.filter((r) => r.status === 'created').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    await this.db.update(importBatches).set({ status: failed ? 'partial' : 'done' })
      .where(and(eq(importBatches.id, batchId), eq(importBatches.tenantId, tenantId)));
    return { created, failed, results };
  }

  private async createEcont(tenantId: string, row: typeof importRows.$inferSelect): Promise<string> {
    const refs = (row.resolvedRefs as { econtOfficeCode?: string } | null) ?? {};
    const ship = await this.econtSvc.createManualShipment(tenantId, {
      receiverName: row.receiverName ?? '',
      receiverPhone: row.receiverPhone ?? '',
      deliveryMode: row.deliveryMode as 'office' | 'address',
      receiverOfficeCode: refs.econtOfficeCode ?? row.office ?? undefined,
      receiverCity: row.city ?? undefined,
      receiverAddress: row.address ?? undefined,
      weightGrams: row.weightGrams ?? undefined,
      contents: row.contents ?? undefined,
      codAmountStotinki: row.codAmountStotinki ?? undefined,
      declaredValueStotinki: row.declaredValueStotinki ?? undefined,
    });
    return ship.id;
  }

  private async createSpeedy(tenantId: string, row: typeof importRows.$inferSelect, batchServiceId?: number): Promise<string> {
    const refs = (row.resolvedRefs as { siteId?: number; officeId?: number; streetId?: number } | null) ?? {};
    const serviceId = batchServiceId;
    if (!serviceId) throw new Error('Липсва Speedy serviceId за партидата');
    const ship = await this.speedySvc.createManualShipment(tenantId, {
      receiverName: row.receiverName ?? '',
      receiverPhone: row.receiverPhone ?? '',
      deliveryMode: row.deliveryMode as 'office' | 'address',
      officeId: refs.officeId,
      siteId: refs.siteId,
      streetId: refs.streetId,
      streetNo: row.streetNo ?? undefined,
      serviceId,
      weightGrams: row.weightGrams ?? undefined,
      contents: row.contents ?? undefined,
      codAmountStotinki: row.codAmountStotinki ?? undefined,
      declaredValueStotinki: row.declaredValueStotinki ?? undefined,
    });
    return ship.id;
  }
```

Confirm the exact return type of `createManualShipment` on both services (both return the inserted `shipments` row with an `id`). The DTO field names above match `ManualShipmentDto` and `SpeedyManualShipmentDto` exactly — verify against those files.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/import/import.service.ts
git commit -m "feat(import): commit drafts → Econt/Speedy shipments (partial, per-row isolated)"
```

---

## Task IM-11: Module + controller + env + wiring

**Files:**
- Create: `server/src/modules/import/import.controller.ts`
- Create: `server/src/modules/import/import.module.ts`
- Modify: `server/src/modules/econt-app/econt-app.module.ts`
- Modify: `server/src/config/env.validation.ts`

- [ ] **Step 1: Implement `import.controller.ts`**

```ts
import {
  Controller, Get, Post, Patch, Delete, Body, Param, UseGuards,
  UploadedFile, UseInterceptors, ParseUUIDPipe, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { ActivationGuard } from '../econt-app/activation.guard';
import { ImportService } from './import.service';
import { ImportSettingsDto } from './dto/import-settings.dto';
import { PatchRowDto } from './dto/patch-row.dto';

@UseGuards(JwtAuthGuard)
@Controller('import')
export class ImportController {
  constructor(private readonly svc: ImportService) {}

  // Validating an upload calls OpenAI + courier lookups → throttle, but no activation
  // gate (it's pre-purchase, like the cheapest-quote feature).
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('batches')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  create(
    @CurrentTenant() t: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() settings: ImportSettingsDto,
  ) {
    if (!file) throw new BadRequestException('Липсва файл');
    return this.svc.createBatch(t, file, settings);
  }

  @Get('batches/:id')
  get(@CurrentTenant() t: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getBatch(t, id);
  }

  @Patch('batches/:id/rows/:rowId')
  patchRow(
    @CurrentTenant() t: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() patch: PatchRowDto,
  ) {
    return this.svc.patchRow(t, id, rowId, patch);
  }

  @Delete('batches/:id/rows/:rowId')
  deleteRow(
    @CurrentTenant() t: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
  ) {
    return this.svc.deleteRow(t, id, rowId);
  }

  // Creating real shipments is the paid action → activation-gated, like per-carrier create.
  @UseGuards(ActivationGuard)
  @Post('batches/:id/commit')
  commit(@CurrentTenant() t: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.commit(t, id);
  }
}
```

- [ ] **Step 2: Implement `import.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { DrizzleModule } from '../../common/drizzle/drizzle.module';
import { EcontCoreModule } from '../econt/econt-core.module';
import { SpeedyCoreModule } from '../speedy/speedy-core.module';
import { ImportService } from './import.service';
import { ImportAiService } from './import.ai';
import { ImportResolveService } from './import.resolve';
import { ImportController } from './import.controller';
import { ActivationGuard } from '../econt-app/activation.guard';

@Module({
  imports: [DrizzleModule, EcontCoreModule, SpeedyCoreModule],
  controllers: [ImportController],
  providers: [ImportService, ImportAiService, ImportResolveService, ActivationGuard],
})
export class ImportModule {}
```

(`EcontCoreModule`/`SpeedyCoreModule` export `EcontService`/`SpeedyService`; confirm they're in the `exports` array — they are, since `econt-app.module` consumes them.)

- [ ] **Step 3: Wire into `econt-app.module.ts`**

Add `import { ImportModule } from '../import/import.module';` and add `ImportModule` to the `imports` array (after `SpeedyCoreModule`).

- [ ] **Step 4: Make OpenAI env optional in `env.validation.ts`**

Open `server/src/config/env.validation.ts` and add two optional fields to the env schema class (match the existing class-validator style, e.g. alongside other optional `@IsOptional() @IsString()` keys):

```ts
  @IsOptional() @IsString()
  OPENAI_API_KEY?: string;

  @IsOptional() @IsString()
  OPENAI_IMPORT_MODEL?: string;
```

(If the file uses a Joi/zod schema instead, add the equivalent optional string keys. The point: boot must NOT fail when these are unset — AI degrades.)

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
Then: `pnpm --filter @fermeribg/api exec eslint src/modules/import`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/import/import.controller.ts server/src/modules/import/import.module.ts server/src/modules/econt-app/econt-app.module.ts server/src/config/env.validation.ts
git commit -m "feat(import): controller + module + wiring + optional OPENAI env"
```

---

## Task IM-12: Minimal UI (`/app`) + static serving + template download

**Files:**
- Modify: `server/src/main.econt.ts`
- Create: `server/public/econt-app/index.html`
- Create: `server/public/econt-app/app.js`
- Modify: `server/src/modules/import/import.controller.ts` (add template endpoint)

- [ ] **Step 1: Serve static at `/app` in `main.econt.ts`**

Change the app type to `NestExpressApplication` and serve the public dir. Add imports at the top:

```ts
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
```

Change `const app = await NestFactory.create(EcontAppModule);` to:

```ts
  const app = await NestFactory.create<NestExpressApplication>(EcontAppModule);
  app.useStaticAssets(join(__dirname, '..', 'public', 'econt-app'), { prefix: '/app' });
```

(`__dirname` at runtime is `server/dist`, so `..` → `server/`, then `public/econt-app`. The `public/` dir is not compiled — it ships as-is. Confirm the Docker/build copies `public/` into the image; if the build only ships `dist/`, add `public/` to the deploy artifact in a follow-up — note this in the final report.)

- [ ] **Step 2: Add a template-download endpoint to `import.controller.ts`**

Add this method (uses exceljs to build a sample on the fly):

```ts
  @Get('template.xlsx')
  async template(@Res() res: import('express').Response) {
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Пратки');
    ws.addRow(['Получател', 'Телефон', 'Доставка', 'Град', 'Офис', 'Адрес', 'Тегло (кг)', 'Съдържание', 'Наложен платеж', 'Обявена стойност', 'Куриер']);
    ws.addRow(['Иван Иванов', '0888123456', 'офис', 'Бургас', 'Изгрев', '', '2', 'Зеленчуци', '20', '', 'Econt']);
    ws.addRow(['Мария Петрова', '0899111222', 'адрес', 'София', '', 'ул. Витоша 1', '1.5', 'Мед', '', '', 'Speedy']);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="import-template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  }
```

Add `Get`, `Res` to the `@nestjs/common` import line if not present. (This route is under `@Controller('import')` + `JwtAuthGuard`; the UI fetches it with the Bearer token and saves the blob.)

- [ ] **Step 3: Create `server/public/econt-app/index.html`**

```html
<!doctype html>
<html lang="bg">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Масов внос на пратки</title>
  <script defer src="https://unpkg.com/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1100px; margin: 1rem auto; padding: 0 1rem; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border: 1px solid #ddd; padding: 4px 6px; text-align: left; }
    .ok { background: #e8f5e9; } .warn { background: #fff8e1; } .error { background: #ffebee; }
    input, select { width: 100%; box-sizing: border-box; border: 1px solid #ccc; padding: 2px; }
    .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
    button { padding: 6px 12px; cursor: pointer; }
    .muted { color: #777; font-size: 12px; }
  </style>
</head>
<body x-data="importApp()">
  <h1>Масов внос на пратки</h1>

  <template x-if="!token">
    <div class="bar">
      <input type="email" placeholder="Имейл" x-model="email" />
      <input type="password" placeholder="Парола" x-model="password" />
      <button @click="login()">Вход</button>
      <span class="error" x-text="loginError"></span>
    </div>
  </template>

  <template x-if="token">
    <div>
      <div class="bar">
        <select x-model="settings.carrier"><option value="econt">Econt</option><option value="speedy">Speedy</option></select>
        <select x-model="settings.currency"><option value="EUR">EUR</option><option value="BGN">BGN</option></select>
        <input type="number" placeholder="Тегло (г) по подр." x-model.number="settings.weightGrams" style="width:140px" />
        <input type="number" placeholder="Speedy serviceId" x-model.number="settings.speedyServiceId" style="width:140px" />
        <input type="file" accept=".xlsx,.csv" @change="pick($event)" />
        <button @click="upload()" :disabled="!file">Качи и провери</button>
        <a href="#" @click.prevent="downloadTemplate()">Свали шаблон</a>
      </div>
      <p class="muted" x-show="ai" x-text="ai"></p>
      <p class="error" x-text="error"></p>

      <template x-if="rows.length">
        <div>
          <div class="bar">
            <span x-text="`Зелени: ${count('ok')} · Жълти: ${count('warn')} · Червени: ${count('error')}`"></span>
            <button @click="commit()" :disabled="committing">Създай пратки</button>
            <a x-show="createdIds.length" :href="labelsUrl()" target="_blank">Свали етикети</a>
          </div>
          <table>
            <thead><tr><th>#</th><th>Получател</th><th>Телефон</th><th>Реж.</th><th>Град</th><th>Офис/Адрес</th><th>Тегло(г)</th><th>НП(ст.)</th><th>Куриер</th><th>Проблеми</th><th></th></tr></thead>
            <tbody>
              <template x-for="r in rows" :key="r.id">
                <tr :class="r.validationStatus">
                  <td x-text="r.rowIndex"></td>
                  <td><input x-model="r.receiverName" @change="save(r)" /></td>
                  <td><input x-model="r.receiverPhone" @change="save(r)" /></td>
                  <td><select x-model="r.deliveryMode" @change="save(r)"><option value="office">офис</option><option value="address">адрес</option></select></td>
                  <td><input x-model="r.city" @change="save(r)" /></td>
                  <td><input x-model="r.deliveryMode === 'office' ? r.office : r.address" @change="save(r)" /></td>
                  <td><input type="number" x-model.number="r.weightGrams" @change="save(r)" /></td>
                  <td><input type="number" x-model.number="r.codAmountStotinki" @change="save(r)" /></td>
                  <td><select x-model="r.carrier" @change="save(r)"><option value="econt">Econt</option><option value="speedy">Speedy</option></select></td>
                  <td class="muted" x-text="(r.validation?.issues||[]).map(i=>i.message).join('; ')"></td>
                  <td><button @click="del(r)">✕</button></td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </template>

  <script src="/app/app.js"></script>
</body>
</html>
```

- [ ] **Step 4: Create `server/public/econt-app/app.js`**

```js
function importApp() {
  return {
    email: '', password: '', token: localStorage.getItem('econt_token') || '', loginError: '',
    settings: { carrier: 'econt', currency: 'EUR', weightGrams: 1000, speedyServiceId: null },
    file: null, batchId: null, rows: [], ai: '', error: '', committing: false, createdIds: [],

    async api(path, opts = {}) {
      const res = await fetch(path, {
        ...opts,
        headers: { Authorization: `Bearer ${this.token}`, ...(opts.headers || {}) },
      });
      if (res.status === 401) { this.logout(); throw new Error('Сесията изтече'); }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || res.statusText);
      return res;
    },
    async login() {
      this.loginError = '';
      try {
        const res = await fetch('/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: this.email, password: this.password }),
        });
        if (!res.ok) throw new Error('Грешен вход');
        const data = await res.json();
        this.token = data.accessToken || data.token;
        localStorage.setItem('econt_token', this.token);
      } catch (e) { this.loginError = e.message; }
    },
    logout() { this.token = ''; localStorage.removeItem('econt_token'); },
    pick(e) { this.file = e.target.files[0] || null; },
    count(s) { return this.rows.filter((r) => r.validationStatus === s).length; },

    async upload() {
      this.error = ''; this.ai = '';
      try {
        const fd = new FormData();
        fd.append('file', this.file);
        Object.entries(this.settings).forEach(([k, v]) => { if (v != null && v !== '') fd.append(k, v); });
        const res = await this.api('/import/batches', { method: 'POST', body: fd });
        const data = await res.json();
        this.batchId = data.batch.id;
        this.rows = data.rows;
        this.ai = data.batch.aiReport?.aiAvailable ? '' : 'AI проверка недостъпна — само базова проверка.';
      } catch (e) { this.error = e.message; }
    },
    async save(r) {
      try {
        const res = await this.api(`/import/batches/${this.batchId}/rows/${r.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            receiverName: r.receiverName, receiverPhone: r.receiverPhone, deliveryMode: r.deliveryMode,
            city: r.city, office: r.office, address: r.address, weightGrams: r.weightGrams,
            codAmountStotinki: r.codAmountStotinki, carrier: r.carrier,
          }),
        });
        const updated = await res.json();
        Object.assign(r, updated);
      } catch (e) { this.error = e.message; }
    },
    async del(r) {
      try {
        await this.api(`/import/batches/${this.batchId}/rows/${r.id}`, { method: 'DELETE' });
        this.rows = this.rows.filter((x) => x.id !== r.id);
      } catch (e) { this.error = e.message; }
    },
    async commit() {
      this.committing = true; this.error = '';
      try {
        const res = await this.api(`/import/batches/${this.batchId}/commit`, { method: 'POST' });
        const data = await res.json();
        this.createdIds = data.results.filter((x) => x.status === 'created').map((x) => x.shipmentId);
        await this.refresh();
        if (data.failed) this.error = `${data.failed} реда не успяха — виж колоната „Проблеми“.`;
      } catch (e) { this.error = e.message; } finally { this.committing = false; }
    },
    async refresh() {
      const res = await this.api(`/import/batches/${this.batchId}`);
      this.rows = (await res.json()).rows;
    },
    labelsUrl() {
      // Econt bulk-print endpoint; for Speedy rows the user uses the Speedy label route.
      return `/shipping/labels.pdf?ids=${this.createdIds.join(',')}`;
    },
    async downloadTemplate() {
      const res = await this.api('/import/template.xlsx');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'import-template.xlsx'; a.click();
    },
  };
}
```

Note: the standalone auth login route is `/auth/login` (StandaloneAuthController) returning a JWT — confirm the exact path + token field name in `standalone-auth.controller.ts` and adjust `login()` if needed. The labels link uses the existing Econt `/shipping/labels.pdf?ids=`; Speedy's bulk-label route differs — for a mixed batch, grouping by carrier in the UI is a follow-up (note in the final report).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
Expected: PASS.

```bash
git add server/src/main.econt.ts server/public/econt-app server/src/modules/import/import.controller.ts
git commit -m "feat(import): minimal Alpine.js UI at /app + xlsx template download"
```

---

## Task IM-13: Final verification + boot smoke + lint

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck + lint + tests**

Run: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
Run: `pnpm --filter @fermeribg/api exec eslint src/modules/import src/main.econt.ts`
Run: `pnpm --filter @fermeribg/api exec jest import --silent`
Expected: all PASS; import pure-helper suites green (parse, normalize, validate, ai, resolve).

- [ ] **Step 2: Build + boot smoke the standalone**

Ensure local PG (5433) + Redis (6379) are up. Build the server, then start the standalone bootstrap:

Run: `pnpm --filter @fermeribg/api build`
Run (background): `node server/dist/main.econt.js`
Expected log: `Econt standalone API running on http://localhost:3100`.

Smoke (no OPENAI_API_KEY set → AI degrades):
- `GET http://localhost:3100/app` → serves the HTML (200).
- `POST http://localhost:3100/import/batches` without a token → `401`.
- Log in via the standalone auth, then `POST /import/batches` with a tiny CSV + settings → `200` with a batch + rows; `aiReport.aiAvailable === false`.
- `POST /import/batches/:id/commit` on a fresh (un-activated) account → `403` (activation gate).

Record the actual responses in the final report.

- [ ] **Step 3: Final holistic review**

Dispatch a final code review (opus-capable) over the whole `modules/import/` + the schema/migration/UI changes: correctness of tenant scoping on every query, the degrade paths (AI down, resolve down), the partial-commit isolation, DTO/field-name alignment with `ManualShipmentDto`/`SpeedyManualShipmentDto`, and the migration being purely additive. Fix everything it flags (fix-then-ship).

- [ ] **Step 4: Final commit (if review fixes were made)**

```bash
git add -A
git commit -m "fix(import): address final review findings"
```

---

## Self-Review (plan vs spec)

- **Spec coverage:** parse (IM-2), deterministic+AI validation (IM-4/IM-5), carrier resolve (IM-6), draft staging tables (IM-1), live-edit CRUD (IM-9), commit→shipments (IM-10), bulk label (existing endpoint, used by UI IM-12), minimal UI (IM-12), file format/template (IM-12 template + spec table), currency BGN/EUR (IM-3), degrade-safe AI (IM-5), activation gate on commit (IM-11), tenant isolation (every query), row cap (IM-8). All covered.
- **Type consistency:** `NormalizedRow`, `RowValidation`, `AiVerdict`, `BatchDefaults`, `Carrier`, `DeliveryMode`, `RowStatus`, `PickResult`, `ResolveResult` defined once and reused. Commit DTO field names verified against `ManualShipmentDto` (receiverOfficeCode/receiverCity/receiverAddress/weightGrams/codAmountStotinki/declaredValueStotinki) and `SpeedyManualShipmentDto` (siteId/officeId/streetId/streetNo/serviceId/...).
- **Known verify-points flagged inline for the implementer:** Drizzle injection token/type name; `StandaloneAuthController` login path + token field; `createManualShipment` return shape; whether the deploy ships `public/`; Speedy bulk-label route for mixed batches. These are confirm-and-adjust, not gaps.
