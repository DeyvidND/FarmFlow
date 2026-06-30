# AI Product Import (Super-Admin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A super-admin button on the producer detail page that turns a pasted price list or uploaded file (.txt/.csv/.xlsx) into products created in that farm's catalog via AI extraction + an editable review table.

**Architecture:** New stateless extract endpoint in the platform (super-admin) module: parse file→text (txt/csv decode, xlsx via `exceljs`), send to OpenAI (`gpt-4o-mini`, JSON mode), return coerced rows — no DB write. The browser shows an editable preview; committing reuses the existing `POST /platform/tenants/:id/import` with `{ products }`, attaching each row to the producer via `farmerId`.

**Tech Stack:** NestJS, OpenAI SDK (already a dep), `exceljs` (already a dep), Next.js admin app (BFF proxy pattern), sonner toasts, Jest.

---

## File Structure

Backend (`server/`):
- Create `src/modules/platform/product-extract.service.ts` — file→text parse + OpenAI extract + coerce. One responsibility: produce clean `ExtractedProduct[]` from messy input.
- Create `src/modules/platform/product-extract.service.spec.ts` — unit tests (OpenAI mocked).
- Modify `src/modules/platform/platform.controller.ts` — add `POST tenants/:id/products/extract`.
- Modify `src/modules/platform/platform.module.ts` — register the new provider.

Frontend (`admin/`):
- Modify `src/lib/api-client.ts` — `ExtractedProduct` type + `extractProducts()` + `importTenantProducts()`.
- Create `src/components/product-import-dialog.tsx` — client dialog (input → editable preview → commit).
- Modify `src/components/producer-detail.tsx` — mount the dialog button in the header.

No new dependencies. No migration. State held in the browser between extract and commit.

---

## Task 1: Backend extraction service

**Files:**
- Create: `server/src/modules/platform/product-extract.service.ts`
- Test: `server/src/modules/platform/product-extract.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/platform/product-extract.service.spec.ts`:

```ts
import { BadRequestException, BadGatewayException } from '@nestjs/common';
import { ProductExtractService } from './product-extract.service';

/** Build a service with a stubbed config; OpenAI client is swapped per-test. */
function makeSvc(key: string | null = 'sk-test') {
  const config = { get: (k: string, d?: unknown) => (k === 'OPENAI_API_KEY' ? key : d) } as any;
  return new ProductExtractService(config);
}

function fileOf(name: string, buffer: Buffer, mimetype = 'application/octet-stream') {
  return { originalname: name, buffer, mimetype } as Express.Multer.File;
}

describe('ProductExtractService.parseToText', () => {
  it('prefers pasted text over a file', async () => {
    const svc = makeSvc();
    const text = await svc.parseToText(fileOf('x.txt', Buffer.from('от файл')), 'от текст');
    expect(text).toBe('от текст');
  });

  it('decodes .txt and .csv as utf-8', async () => {
    const svc = makeSvc();
    expect(await svc.parseToText(fileOf('p.txt', Buffer.from('Домати 2,50')), undefined)).toContain('Домати');
    expect(await svc.parseToText(fileOf('p.csv', Buffer.from('Мед,12'), 'text/csv'), undefined)).toContain('Мед');
  });

  it('parses .xlsx cells into text via exceljs', async () => {
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Лист');
    ws.addRow(['Домати', '2,50', 'кг']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const svc = makeSvc();
    const out = await svc.parseToText(fileOf('p.xlsx', buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), undefined);
    expect(out).toContain('Домати');
    expect(out).toContain('кг');
  });

  it('rejects no input', async () => {
    await expect(makeSvc().parseToText(undefined, undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unsupported file type', async () => {
    await expect(makeSvc().parseToText(fileOf('p.pdf', Buffer.from('x'), 'application/pdf'), undefined))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ProductExtractService.extract', () => {
  function withRows(svc: ProductExtractService, json: unknown) {
    (svc as any).client = {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(json) } }] }) } },
    };
  }

  it('coerces price, defaults unit, drops nameless rows, omits empty optionals', async () => {
    const svc = makeSvc();
    withRows(svc, {
      products: [
        { name: 'Домати', priceStotinki: 250, unit: 'кг', weight: '', category: 'Зеленчуци', description: '' },
        { name: '', priceStotinki: 100, unit: 'бр' },
        { name: 'Мед', priceStotinki: -5, unit: '', weight: '500 г', category: '', description: 'Акациев' },
      ],
    });
    const rows = await svc.extract('…');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ name: 'Домати', priceStotinki: 250, unit: 'кг', category: 'Зеленчуци', isActive: true });
    expect(rows[1]).toEqual({ name: 'Мед', priceStotinki: 0, unit: 'бр', weight: '500 г', description: 'Акациев', isActive: true });
  });

  it('rounds a non-integer price', async () => {
    const svc = makeSvc();
    withRows(svc, { products: [{ name: 'Сирене', priceStotinki: 649.7, unit: 'кг' }] });
    expect((await svc.extract('…'))[0].priceStotinki).toBe(650);
  });

  it('caps at 1000 rows', async () => {
    const svc = makeSvc();
    withRows(svc, { products: Array.from({ length: 1100 }, (_, i) => ({ name: `П${i}`, priceStotinki: 100, unit: 'бр' })) });
    expect(await svc.extract('…')).toHaveLength(1000);
  });

  it('throws on invalid JSON from the model', async () => {
    const svc = makeSvc();
    (svc as any).client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'not json' } }] }) } } };
    await expect(svc.extract('…')).rejects.toBeInstanceOf(BadGatewayException);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @fermeribg/api test product-extract.service`
Expected: FAIL — `Cannot find module './product-extract.service'`.

- [ ] **Step 3: Write the service**

Create `server/src/modules/platform/product-extract.service.ts`:

```ts
import { BadGatewayException, BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

/** A clean product row ready for PlatformImportDto.products (subset of CreateProductDto). */
export interface ExtractedProduct {
  name: string;
  priceStotinki: number;
  unit: string;
  weight?: string;
  category?: string;
  description?: string;
  isActive: true;
}

const MAX_TEXT = 100_000;
const MAX_ROWS = 1000;

const SYSTEM_PROMPT = `Ти си помощник, който извлича продукти от ценоразпис на българска ферма.
Текстът по-долу е приблизително подреден по полета: име, цена, мерна единица, разфасовка, категория, описание.
Извади ВСЕКИ продукт. За всеки върни:
- name: име на продукта на български.
- priceStotinki: цена в стотинки (евроцентове) като ЦЯЛО число. Десетична цена × 100, закръгли. „6,50" → 650, „12" → 1200.
- unit: мерна единица („кг", „бр", „връзка", „литър", „пакет"…). Ако липсва — „бр".
- weight: разфасовка/тегло ако е дадено, иначе празен низ.
- category: раздел/категория ако личи, иначе празен низ.
- description: кратко описание ако има, иначе празен низ.
Пропусни редове, които не са продукти (заглавия, телефони, адреси, имейли).
Връщай само JSON: {"products":[{"name","priceStotinki","unit","weight","category","description"}]}. Без друг текст.`;

/** Coerce one raw model row into a clean product, or null to drop it. */
function coerce(r: unknown): ExtractedProduct | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) return null;
  let price = Number(o.priceStotinki);
  if (!Number.isFinite(price) || price < 0) price = 0;
  price = Math.round(price);
  const unit = typeof o.unit === 'string' && o.unit.trim() ? o.unit.trim() : 'бр';
  const out: ExtractedProduct = { name, priceStotinki: price, unit, isActive: true };
  const weight = typeof o.weight === 'string' ? o.weight.trim() : '';
  const category = typeof o.category === 'string' ? o.category.trim() : '';
  const description = typeof o.description === 'string' ? o.description.trim() : '';
  if (weight) out.weight = weight;
  if (category) out.category = category;
  if (description) out.description = description;
  return out;
}

@Injectable()
export class ProductExtractService {
  private readonly log = new Logger(ProductExtractService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    const key = config.get<string>('OPENAI_API_KEY');
    // Bound the call: a foreground operator action shouldn't hang on a slow OpenAI.
    this.client = key ? new OpenAI({ apiKey: key, timeout: 30_000, maxRetries: 1 }) : null;
    this.model = config.get<string>('OPENAI_IMPORT_MODEL', 'gpt-4o-mini') ?? 'gpt-4o-mini';
  }

  /** Pasted text wins; otherwise decode the file (.txt/.csv direct, .xlsx via exceljs). */
  async parseToText(file: Express.Multer.File | undefined, text: string | undefined): Promise<string> {
    if (text && text.trim()) return text.slice(0, MAX_TEXT);
    if (!file) throw new BadRequestException('Подайте текст или файл');
    const name = (file.originalname ?? '').toLowerCase();
    const mt = file.mimetype ?? '';
    if (name.endsWith('.txt') || name.endsWith('.csv') || mt.startsWith('text/')) {
      return file.buffer.toString('utf8').slice(0, MAX_TEXT);
    }
    if (name.endsWith('.xlsx') || mt.includes('spreadsheet')) {
      const ExcelJS = await import('exceljs');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(file.buffer);
      const lines: string[] = [];
      wb.eachSheet((ws) => {
        ws.eachRow((row) => {
          const cells = (row.values as unknown[]).slice(1).map((v) => {
            if (v == null) return '';
            if (typeof v === 'object' && 'text' in (v as Record<string, unknown>)) return String((v as { text: unknown }).text);
            return String(v);
          });
          lines.push(cells.join('\t'));
        });
      });
      return lines.join('\n').slice(0, MAX_TEXT);
    }
    throw new BadRequestException('Неподдържан файл — .txt, .csv или .xlsx');
  }

  /** Extract products from prepared text. Throws (no silent degrade) — operator can retry. */
  async extract(text: string): Promise<ExtractedProduct[]> {
    if (!this.client) throw new ServiceUnavailableException('AI импорт не е конфигуриран');
    let raw: string;
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      });
      raw = res.choices[0]?.message?.content ?? '{}';
    } catch (e) {
      this.log.warn(`OpenAI product extract failed: ${String((e as Error)?.message ?? e)}`);
      throw new BadGatewayException('AI услугата не отговори — опитайте пак');
    }
    let parsed: { products?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadGatewayException('AI върна невалиден отговор — опитайте пак');
    }
    const rows = Array.isArray(parsed.products) ? parsed.products : [];
    return rows.map(coerce).filter((p): p is ExtractedProduct => p != null).slice(0, MAX_ROWS);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @fermeribg/api test product-extract.service`
Expected: PASS — all `parseToText` + `extract` cases green.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/platform/product-extract.service.ts server/src/modules/platform/product-extract.service.spec.ts
git commit -m "feat(platform): AI product-extract service (file/text -> rows)"
```

---

## Task 2: Wire the endpoint + module

**Files:**
- Modify: `server/src/modules/platform/platform.controller.ts`
- Modify: `server/src/modules/platform/platform.module.ts`

- [ ] **Step 1: Register the provider**

In `server/src/modules/platform/platform.module.ts`, import and add `ProductExtractService` to `providers`:

```ts
import { ProductExtractService } from './product-extract.service';
```

```ts
  providers: [
    PlatformService,
    PlatformInsightsService,
    ProductExtractService,
    ...(RUN_WORKERS ? [DemoCleanupProcessor] : []),
  ],
```

- [ ] **Step 2: Add the controller imports + dependency**

In `server/src/modules/platform/platform.controller.ts`, extend the `@nestjs/common` import with `UseInterceptors`, `UploadedFile`, and add the new imports:

```ts
import { FileInterceptor } from '@nestjs/platform-express';
import { ProductExtractService } from './product-extract.service';
```

Inject it into `PlatformController`'s constructor:

```ts
  constructor(
    private readonly platform: PlatformService,
    private readonly insights: PlatformInsightsService,
    private readonly productExtract: ProductExtractService,
  ) {}
```

- [ ] **Step 3: Add the endpoint**

In `PlatformController`, directly above the existing `importTenant` method (the `@Post('tenants/:id/import')`), add:

```ts
  /** AI product extraction for onboarding: messy price list (text or .txt/.csv/.xlsx
   *  file) -> structured product rows. No DB write — the operator reviews, then POSTs
   *  the (edited) rows to the import endpoint below. Throttled (each call hits OpenAI). */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('tenants/:id/products/extract')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async extractProducts(
    @Param('id', ParseUUIDPipe) _id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('text') text: string | undefined,
  ): Promise<{ products: import('./product-extract.service').ExtractedProduct[] }> {
    const content = await this.productExtract.parseToText(file, text);
    const products = await this.productExtract.extract(content);
    return { products };
  }
```

(`_id` is the tenant id from the path — kept for route shape/guard; extraction itself is side-effect free, so the row is committed via the existing `tenants/:id/import`.)

- [ ] **Step 4: Build to verify it compiles**

Run: `pnpm --filter @fermeribg/api build`
Expected: build succeeds, no TS errors.

- [ ] **Step 5: Run the full server suite**

Run: `pnpm --filter @fermeribg/api test`
Expected: all tests green (existing suite + Task 1 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/platform/platform.controller.ts server/src/modules/platform/platform.module.ts
git commit -m "feat(platform): POST tenants/:id/products/extract endpoint"
```

---

## Task 3: Admin API client helpers

**Files:**
- Modify: `admin/src/lib/api-client.ts`

- [ ] **Step 1: Add the type + two helpers**

Append to `admin/src/lib/api-client.ts` (after the existing `resetTenantPassword` export, anywhere top-level is fine):

```ts
// ── AI product import (super-admin onboarding) ──

/** One AI-extracted product row, editable in the preview before commit. */
export interface ExtractedProduct {
  name: string;
  priceStotinki: number;
  unit: string;
  weight?: string;
  category?: string;
  description?: string;
}

/**
 * Send a pasted price list (text) and/or an uploaded file (.txt/.csv/.xlsx) to the
 * AI extractor. Multipart: do NOT set content-type — the browser sets the boundary
 * and the BFF forwards it. Returns rows only (no products created yet).
 */
export const extractProducts = (tenantId: string, input: { file?: File; text?: string }) => {
  const fd = new FormData();
  if (input.file) fd.append('file', input.file);
  if (input.text) fd.append('text', input.text);
  return apiFetch<{ products: ExtractedProduct[] }>(
    `platform/tenants/${tenantId}/products/extract`,
    { method: 'POST', body: fd },
    'Неуспешно извличане на продукти',
  );
};

/** Commit the reviewed rows to the farm's catalog via the existing import endpoint.
 *  `farmerId` attaches each product to the producer whose page this is. */
export const importTenantProducts = (
  tenantId: string,
  products: (ExtractedProduct & { farmerId?: string; isActive?: boolean })[],
) =>
  apiFetch<{ products: number; farmers: number; categories: number; contact: boolean; favicon: boolean }>(
    `platform/tenants/${tenantId}/import`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ products }),
    },
    'Неуспешно създаване на продукти',
  );
```

- [ ] **Step 2: Typecheck the admin app**

Run: `pnpm --filter @fermeribg/admin exec tsc --noEmit`
Expected: no type errors. (If the admin package name differs, use the name from `admin/package.json`.)

- [ ] **Step 3: Commit**

```bash
git add admin/src/lib/api-client.ts
git commit -m "feat(admin): api-client helpers for AI product import"
```

---

## Task 4: Product import dialog component

**Files:**
- Create: `admin/src/components/product-import-dialog.tsx`

- [ ] **Step 1: Write the component**

Create `admin/src/components/product-import-dialog.tsx`:

```tsx
'use client';

import { useRef, useState } from 'react';
import { Sparkles, Upload, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, extractProducts, importTenantProducts, type ExtractedProduct } from '@/lib/api-client';

/**
 * Super-admin onboarding helper. Operator pastes the farm's price list or uploads a
 * .txt/.csv/.xlsx file → AI extracts products → operator reviews/edits an editable
 * table → „Създай" creates them in the farm's catalog, attached to this producer.
 * No product images are set here; the farmer adds those later in their own panel.
 */
export function ProductImportDialog({
  tenantId,
  farmerId,
  farmerName,
}: {
  tenantId: string;
  farmerId: string;
  farmerName: string;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'input' | 'preview'>('input');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<ExtractedProduct[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function reset() {
    setStep('input');
    setText('');
    setFile(null);
    setRows([]);
    setBusy(false);
  }

  function close() {
    setOpen(false);
    reset();
  }

  async function runExtract() {
    if (!text.trim() && !file) {
      toast.error('Поставете текст или изберете файл');
      return;
    }
    setBusy(true);
    try {
      const { products } = await extractProducts(tenantId, { text: text.trim() || undefined, file: file ?? undefined });
      if (!products.length) {
        toast.error('Не открих продукти в текста');
        return;
      }
      setRows(products);
      setStep('preview');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Неуспешно извличане');
    } finally {
      setBusy(false);
    }
  }

  function patch(i: number, key: keyof ExtractedProduct, value: string) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  }

  function patchPrice(i: number, euros: string) {
    const n = Math.max(0, Math.round((parseFloat(euros.replace(',', '.')) || 0) * 100));
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, priceStotinki: n } : r)));
  }

  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i));
  }

  async function commit() {
    const clean = rows.filter((r) => r.name.trim());
    if (!clean.length) {
      toast.error('Няма валидни продукти');
      return;
    }
    setBusy(true);
    try {
      const res = await importTenantProducts(
        tenantId,
        clean.map((r) => ({ ...r, farmerId, isActive: true })),
      );
      toast.success(`Създадени ${res.products} продукта`);
      close();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Неуспешно създаване');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-ff-green-600 bg-ff-green-50 px-3 py-1.5 text-[13px] font-bold text-ff-green-700 hover:brightness-95"
      >
        <Sparkles size={14} /> Импорт на продукти (AI)
      </button>

      {open && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-black/55 p-4">
          <div className="flex max-h-[92vh] w-[760px] max-w-full flex-col overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg">
            <div className="flex items-center justify-between border-b border-ff-border-2 px-6 py-4">
              <h2 className="font-display text-[18px] font-extrabold">
                Импорт на продукти · {farmerName}
              </h2>
              <button onClick={close} aria-label="Затвори" className="grid h-8 w-8 place-items-center rounded-lg text-ff-muted hover:bg-ff-surface-2">
                <X size={18} />
              </button>
            </div>

            {step === 'input' ? (
              <div className="flex flex-col gap-4 overflow-y-auto px-6 py-5">
                <p className="text-[13.5px] text-ff-ink-2">
                  Поставете ценоразписа на фермата или качете файл (.txt, .csv, .xlsx). AI ще извлече продуктите за преглед — без снимки.
                </p>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={8}
                  placeholder={'Домати 2,50 лв/кг\nКраставици 1,80 лв/кг\nМед 12 лв/буркан…'}
                  className="w-full resize-y rounded-lg border border-ff-border bg-ff-surface-2 px-3 py-2 text-[14px] outline-none focus:border-ff-green-600"
                />
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".txt,.csv,.xlsx"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-ff-border px-3 py-1.5 text-[13px] font-bold text-ff-ink-2 hover:bg-ff-surface-2"
                  >
                    <Upload size={14} /> {file ? file.name : 'Избери файл'}
                  </button>
                  {file && (
                    <button type="button" onClick={() => setFile(null)} className="text-[13px] text-ff-muted hover:underline">
                      Премахни файла
                    </button>
                  )}
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={runExtract}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-ff-green-600 px-4 py-2 text-[14px] font-bold text-white hover:brightness-95 disabled:opacity-60"
                  >
                    <Sparkles size={15} /> {busy ? 'Извличане…' : 'Извлечи'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="overflow-auto px-6 py-4">
                  <p className="mb-3 text-[13px] text-ff-muted">
                    {rows.length} продукта. Прегледайте и редактирайте преди създаване.
                  </p>
                  <table className="w-full border-collapse text-[13px]">
                    <thead>
                      <tr className="border-b border-ff-border text-left text-ff-muted">
                        <th className="py-2 pr-2 font-bold">Име</th>
                        <th className="py-2 pr-2 font-bold">Цена €</th>
                        <th className="py-2 pr-2 font-bold">Ед.</th>
                        <th className="py-2 pr-2 font-bold">Разфасовка</th>
                        <th className="py-2 pr-2 font-bold">Категория</th>
                        <th className="py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i} className="border-b border-ff-border-2">
                          <td className="py-1.5 pr-2">
                            <input value={r.name} onChange={(e) => patch(i, 'name', e.target.value)} className="w-full rounded border border-transparent bg-transparent px-1 py-1 hover:border-ff-border focus:border-ff-green-600 focus:outline-none" />
                          </td>
                          <td className="py-1.5 pr-2">
                            <input value={(r.priceStotinki / 100).toFixed(2)} onChange={(e) => patchPrice(i, e.target.value)} inputMode="decimal" className="w-20 rounded border border-transparent bg-transparent px-1 py-1 text-right hover:border-ff-border focus:border-ff-green-600 focus:outline-none" />
                          </td>
                          <td className="py-1.5 pr-2">
                            <input value={r.unit} onChange={(e) => patch(i, 'unit', e.target.value)} className="w-16 rounded border border-transparent bg-transparent px-1 py-1 hover:border-ff-border focus:border-ff-green-600 focus:outline-none" />
                          </td>
                          <td className="py-1.5 pr-2">
                            <input value={r.weight ?? ''} onChange={(e) => patch(i, 'weight', e.target.value)} className="w-24 rounded border border-transparent bg-transparent px-1 py-1 hover:border-ff-border focus:border-ff-green-600 focus:outline-none" />
                          </td>
                          <td className="py-1.5 pr-2">
                            <input value={r.category ?? ''} onChange={(e) => patch(i, 'category', e.target.value)} className="w-28 rounded border border-transparent bg-transparent px-1 py-1 hover:border-ff-border focus:border-ff-green-600 focus:outline-none" />
                          </td>
                          <td className="py-1.5 text-right">
                            <button type="button" onClick={() => removeRow(i)} aria-label="Премахни" className="text-ff-muted hover:text-ff-red">
                              <Trash2 size={15} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between border-t border-ff-border-2 px-6 py-4">
                  <button type="button" onClick={() => setStep('input')} className="text-[13.5px] font-semibold text-ff-ink-2 hover:underline">
                    ← Назад
                  </button>
                  <button
                    type="button"
                    onClick={commit}
                    disabled={busy || rows.length === 0}
                    className="rounded-lg bg-ff-green-600 px-4 py-2 text-[14px] font-bold text-white hover:brightness-95 disabled:opacity-60"
                  >
                    {busy ? 'Създаване…' : `Създай ${rows.length} продукта`}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @fermeribg/admin exec tsc --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add admin/src/components/product-import-dialog.tsx
git commit -m "feat(admin): product import dialog (paste/upload -> editable preview)"
```

---

## Task 5: Mount the dialog on the producer detail page

**Files:**
- Modify: `admin/src/components/producer-detail.tsx`

- [ ] **Step 1: Import the dialog**

At the top of `admin/src/components/producer-detail.tsx`, add to the imports:

```ts
import { ProductImportDialog } from './product-import-dialog';
```

- [ ] **Step 2: Render it next to the impersonate button**

In the header actions block, replace the existing `<ImpersonateButton ... />` line:

```tsx
          <ImpersonateButton farmerId={f.id} hasLogin={f.hasLogin} />
```

with both buttons wrapped together:

```tsx
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ProductImportDialog tenantId={f.tenantId} farmerId={f.id} farmerName={f.name} />
            <ImpersonateButton farmerId={f.id} hasLogin={f.hasLogin} />
          </div>
```

- [ ] **Step 3: Typecheck + build**

Run: `pnpm --filter @fermeribg/admin exec tsc --noEmit`
Expected: no type errors.

- [ ] **Step 4: Manual verification**

Start the stack (API + admin). As super-admin, open a producer detail page:
1. Click „Импорт на продукти (AI)".
2. Paste e.g. `Домати 2,50 лв/кг\nМед 12 лв/буркан`, click „Извлечи".
3. Confirm the preview shows 2 rows with prices 2.50 / 12.00; edit a name; delete a row; click „Създай".
4. Confirm a success toast, then verify the products appear in that farm (open the farmer's panel via „Влез като фермер", or re-open the tenant — the product count should rise) and are attached to this producer.

Expected: products created, attached to `farmerId`, no images set.

- [ ] **Step 5: Commit**

```bash
git add admin/src/components/producer-detail.tsx
git commit -m "feat(admin): mount AI product import on producer detail"
```

---

## Self-Review Notes

**Spec coverage:**
- Text + file (.txt/.csv/.xlsx) input → Task 1 `parseToText` + Task 4 dialog inputs. ✓
- OpenAI (`gpt-4o-mini`, existing key) → Task 1 service. ✓
- Super-admin guard + throttle + 2MB cap + 1000-row cap → Task 2 endpoint (inherits `PlatformAdminGuard`), Task 1 `MAX_ROWS`. ✓
- Editable preview gate → Task 4. ✓
- Reuse existing import endpoint, attach `farmerId` → Task 3 `importTenantProducts` + Task 5. ✓
- No photos → no image field anywhere; farmer adds later. ✓
- € display in preview (not „лв/€") → Task 4 uses `Цена €` + `priceStotinki/100`. ✓
- Tests for parse/money/skip/cap → Task 1 spec. ✓

**Out of scope (per spec):** farmers/categories/contact extraction, self-serve intake, photo/vision, persisted batches — none included. ✓

**Type consistency:** `ExtractedProduct` defined once server-side (Task 1) and mirrored client-side (Task 3, minus the server-only `isActive: true` literal, which the client adds at commit). `extractProducts` / `importTenantProducts` names consistent across Tasks 3–5.

**Env note:** `OPENAI_API_KEY` already validated as optional in `env.validation.ts`; if unset, the endpoint returns 503 „AI импорт не е конфигуриран". `OPENAI_IMPORT_MODEL` already read by the existing import module (default `gpt-4o-mini`) — no new required var.
