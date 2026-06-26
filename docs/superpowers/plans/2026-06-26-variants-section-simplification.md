# Variants Section Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the product dialog's „has variants" checkbox with one always-visible „Цена и наличност" rows section (1 row = simple product, 2+ = variants), add per-input hints, and keep variant stock from desyncing with the „Задай наличност" screen.

**Architecture:** Pure panel change plus one server read. „Has variants" becomes *derived* (row count). Stock keeps one source of truth: a simple product writes the availability window (as today); a varianted product writes per-variant stock and the client clears the window (`stock: null`). The „Задай наличност" screen shows varianted products read-only with a pointer to the product. No migration; no chaika change; the server pricing/variant model is untouched.

**Tech Stack:** NestJS + Drizzle (server), Next.js 14 + React (client). Server tests via jest (`cd server && npx jest <name> -c ./package.json`). Client has NO unit runner → verify with `npx tsc --noEmit` + `npx next build`.

Spec: `docs/superpowers/specs/2026-06-26-variants-section-simplification-design.md`.

---

## Task 1: Server — `listPickerProducts` returns `hasVariants`

**Files:**
- Modify: `server/src/modules/availability/availability.service.ts` (`listPickerProducts`, ~317-341, + import)
- Test: `server/src/modules/availability/availability.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Add to `availability.service.spec.ts` (follow the file's existing harness for a real DB or mocked db; if the suite uses a live test DB, insert a product with a variant and one without). Minimal shape:

```typescript
it('listPickerProducts flags products that have live variants', async () => {
  // seed: product A with one product_variants row, product B with none
  const rows = await service.listPickerProducts(tenantId, null);
  const a = rows.find((r) => r.id === productAId)!;
  const b = rows.find((r) => r.id === productBId)!;
  expect(a.hasVariants).toBe(true);
  expect(b.hasVariants).toBe(false);
});
```

- [ ] **Step 2: Run it, expect fail**

Run: `cd server && npx jest availability.service -c ./package.json`
Expected: FAIL — `hasVariants` undefined / property missing.

- [ ] **Step 3: Implement**

In `availability.service.ts`, ensure `productVariants` is imported from `@fermeribg/db`:

```typescript
import { products, productAvailabilityWindows, productVariants } from '@fermeribg/db';
```

Change `listPickerProducts` return type and select:

```typescript
  async listPickerProducts(
    tenantId: string,
    farmerScope: string | null,
  ): Promise<{ id: string; name: string; weight: string | null; farmerId: string | null; hasVariants: boolean }[]> {
    const conditions = [
      eq(products.tenantId, tenantId),
      eq(products.isActive, true),
      isNull(products.deletedAt),
    ];
    if (farmerScope !== null) {
      conditions.push(eq(products.farmerId, farmerScope));
    }
    return this.db
      .select({
        id: products.id,
        name: products.name,
        weight: products.weight,
        farmerId: products.farmerId,
        hasVariants: sql<boolean>`EXISTS (SELECT 1 FROM ${productVariants} WHERE ${productVariants.productId} = ${products.id} AND ${productVariants.deletedAt} IS NULL)`,
      })
      .from(products)
      .where(and(...conditions))
      .orderBy(asc(products.name));
  }
```

(`sql` is already imported in this file via drizzle-orm; if not, add it to the existing `drizzle-orm` import.)

- [ ] **Step 4: Run it, expect pass**

Run: `cd server && npx jest availability.service -c ./package.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/availability/availability.service.ts server/src/modules/availability/availability.service.spec.ts
git commit -m "feat(availability): listPickerProducts flags products with variants"
```

---

## Task 2: Client — `PickerProduct.hasVariants` + „Задай наличност" note + bulk filter

**Files:**
- Modify: `client/src/app/(admin)/availability/page.tsx:19-24` (type)
- Modify: `client/src/components/availability/availability-client.tsx:150-203` (product card), `:215-217` (bulk)

- [ ] **Step 1: Extend `PickerProduct`**

`client/src/app/(admin)/availability/page.tsx`:

```typescript
export type PickerProduct = {
  id: string;
  name: string;
  weight: string | null;
  farmerId: string | null;
  hasVariants: boolean;
};
```

- [ ] **Step 2: Varianted-product note in the product card**

In `availability-client.tsx`, replace the card body (the `<div className="flex items-center justify-between gap-3">` header button + the `<div className="mt-3 …">` windows block, lines ~155-201) so a varianted product shows the note instead of the stock controls. The cleanest edit: wrap the existing button + windows block in `{!p.hasVariants && ( … )}` and add an `{p.hasVariants && ( … )}` branch:

```tsx
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold text-ff-ink">
                {[p.name, p.weight].filter(Boolean).join(' ')}
              </div>
              {!p.hasVariants && byProduct(p.id).length === 0 && (
                <button
                  onClick={() => setEditing({ productId: p.id })}
                  className="shrink-0 rounded-lg bg-ff-green-50 px-3 py-1.5 text-sm font-bold text-ff-green-700 hover:bg-ff-green-100"
                >
                  + Задай наличност
                </button>
              )}
            </div>

            {p.hasVariants ? (
              <div className="mt-3 rounded-lg bg-ff-surface-2 px-3 py-2.5 text-sm">
                <div className="font-semibold text-ff-ink">Управлява се чрез варианти</div>
                <div className="mt-0.5 text-ff-muted-2">
                  Този продукт има няколко вида/грамажа. Наличността се задава за всеки от тях в самия продукт.
                </div>
                <a href="/products" className="mt-1.5 inline-block font-semibold text-ff-green-700 hover:underline">
                  Отвори продукта →
                </a>
              </div>
            ) : (
              <div className="mt-3 flex flex-col gap-1.5">
                {byProduct(p.id).length === 0 && (
                  <div className="text-sm text-ff-muted-2">Няма зададена наличност.</div>
                )}
                {byProduct(p.id).map((w) => (
                  <div
                    key={w.id}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg bg-ff-surface-2 px-3 py-2 text-sm"
                  >
                    <span className="font-semibold text-ff-ink">
                      остават {w.remaining}/{w.quantity} бр.
                    </span>
                    <span className="flex items-center gap-3">
                      <button onClick={() => setEditing({ productId: p.id, existingWindow: w })} className="text-ff-ink-2 hover:underline">
                        Промени
                      </button>
                      <button onClick={() => setConfirming(w.id)} className="text-red-600 hover:underline">
                        Изтрий
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
```

- [ ] **Step 3: Exclude varianted products from the bulk editor**

Same file, the `<BulkWindowEditor products={visibleProducts} … />` (~line 217):

```tsx
        <BulkWindowEditor
          products={visibleProducts.filter((p) => !p.hasVariants)}
```

- [ ] **Step 4: Typecheck**

Run: `cd client && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add "client/src/app/(admin)/availability/page.tsx" client/src/components/availability/availability-client.tsx
git commit -m "feat(availability): varianted products show 'managed via variants' note, excluded from bulk"
```

---

## Task 3: Product dialog — remove checkbox + top price/stock; unified „Цена и наличност" rows

**Files:**
- Modify: `client/src/components/products/product-dialog.tsx`

This task does the structural/markup changes only; Task 4 does the submit + prefill logic. They live in one file but split for review clarity.

- [ ] **Step 1: Remove the top-level price/stock blocks**

Delete the three `{!hasVariants && ( … )}` blocks: `Цена (€)`, `Наличност`, and the „Задай наличност на много продукти наведнъж →" link (currently ~322-349). Price + stock now live in the rows.

- [ ] **Step 2: Drop the checkbox; make the section always-visible**

In the „Варианти" `Collapsible`, remove the `Този продукт има варианти` checkbox `<label>` and the `{hasVariants && ( … )}` gate so the rows render unconditionally. Rename the section:

```tsx
          <Collapsible
            title="Цена и наличност"
            hint="Един ред = един продукт. Добави още редове за разфасовки или видове (вид/грамаж). Наличност празна = неограничено."
            defaultOpen
          >
            <div className="flex flex-col gap-2">
              {/* rows from Step 3 */}
            </div>
          </Collapsible>
```

- [ ] **Step 3: Rows with per-input hints + disabled trash at one row**

Inside that `<div className="flex flex-col gap-2">`, render the rows (each input gets a hint line; trash disabled when a single row remains):

```tsx
              {variants.map((v, i) => (
                <div key={i} className="flex flex-col gap-1">
                  <div className="flex gap-2">
                    <div className="flex flex-[2] flex-col gap-1">
                      <input
                        value={v.label}
                        onChange={(e) => setVariants((p) => p.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))}
                        placeholder="Кристализиран 500 г"
                        className={`${field} min-w-0`}
                      />
                      <span className="text-[11px] text-ff-muted">Празно = един вид</span>
                    </div>
                    <div className="flex flex-1 flex-col gap-1">
                      <input
                        value={v.price}
                        onChange={(e) => setVariants((p) => p.map((r, j) => (j === i ? { ...r, price: e.target.value } : r)))}
                        inputMode="decimal"
                        placeholder="6,50 €"
                        className={`${field} min-w-0`}
                      />
                      <span className="text-[11px] text-ff-muted">Цена</span>
                    </div>
                    <div className="flex w-20 flex-col gap-1">
                      <input
                        value={v.stock}
                        onChange={(e) => setVariants((p) => p.map((r, j) => (j === i ? { ...r, stock: e.target.value.replace(/[^0-9]/g, '') } : r)))}
                        inputMode="numeric"
                        placeholder="бр"
                        className={field}
                      />
                      <span className="text-[11px] text-ff-muted">празно = ∞</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setVariants((p) => p.filter((_, j) => j !== i))}
                      disabled={variants.length <= 1}
                      aria-label="Премахни ред"
                      className="mt-0.5 grid h-[42px] w-9 shrink-0 place-items-center rounded-sm text-ff-red hover:bg-ff-surface-2 disabled:cursor-not-allowed disabled:text-ff-muted-2 disabled:hover:bg-transparent"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {promoMode === 'fixed' && filledCount >= 2 && (
                    <div className="flex items-center gap-2 pl-1">
                      <span className="shrink-0 text-[11.5px] text-ff-muted">Промо цена</span>
                      <input
                        value={v.salePrice}
                        onChange={(e) => setVariants((p) => p.map((r, j) => (j === i ? { ...r, salePrice: e.target.value } : r)))}
                        inputMode="decimal"
                        placeholder="напр. 5,20 € (празно = без промо)"
                        className={`${field} min-w-0 flex-1`}
                      />
                    </div>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => setVariants((p) => [...p, { label: '', price: '', stock: '', salePrice: '' }])}
                className="inline-flex items-center gap-1.5 self-start text-[12.5px] font-semibold text-ff-green-700 hover:underline"
              >
                <Plus size={14} /> Добави вид / грамаж
              </button>
```

`filledCount` is defined in Task 4 (a `const` computed in the render body before the JSX). Until Task 4 lands, temporarily define `const filledCount = variants.filter((v) => parseFloat(v.price.replace(',', '.')) > 0).length;` near the other derived values so this compiles.

- [ ] **Step 4: Typecheck (will still error until Task 4 wires state — that's expected)**

Run: `cd client && npx tsc --noEmit`
Expected: errors only about `hasVariants` references still present elsewhere (price/stock state, promo `defaultOpen`, submit). Those are fixed in Task 4. If other errors appear, fix the markup.

- [ ] **Step 5: Commit (WIP — pairs with Task 4)**

```bash
git add client/src/components/products/product-dialog.tsx
git commit -m "feat(products): unified 'Цена и наличност' rows section + per-input hints (markup)"
```

---

## Task 4: Product dialog — state, prefill, submit, promo mode

**Files:**
- Modify: `client/src/components/products/product-dialog.tsx`

- [ ] **Step 1: Remove `hasVariants` + standalone `price`/`stock` states; seed one row**

Delete `const [hasVariants, setHasVariants] = useState(false);`. Keep `variants` but initialise with one empty row. Remove the now-unused `price`/`stock` standalone states ONLY if nothing else reads them — the single row replaces them. Seed:

```typescript
const [variants, setVariants] = useState<VRow[]>([{ label: '', price: '', stock: '', salePrice: '' }]);
```

- [ ] **Step 2: Derived `filledCount` + force percent mode when <2 filled**

Add near the top of the render body (before the JSX), and make the Промоция section read `filledCount`:

```typescript
const filledCount = variants.filter((v) => (parseFloat(v.price.replace(',', '.')) || 0) > 0).length;
const effectivePromoMode = filledCount >= 2 ? promoMode : 'percent';
```

Use `effectivePromoMode` where the JSX currently branches on `promoMode` for the toggle/preview, and gate the radio toggle on `filledCount >= 2` (with 0-1 filled rows, show only the % + date inputs). Replace the Промоция `defaultOpen={!!product?.salePercent || (hasVariants && promoMode === 'fixed')}` with `defaultOpen={!!product?.salePercent || promoMode === 'fixed'}` and its `key` `hasVariants`-free.

- [ ] **Step 3: Edit prefill — one row for plain products, N rows for varianted**

Replace the existing two effects (stock prefill + variants prefill) so a plain product seeds exactly one row carrying its price + window stock, and a varianted product fills its rows:

```typescript
  useEffect(() => {
    if (!isEdit || !product) return;
    let alive = true;
    (async () => {
      const [rows, windows] = await Promise.all([
        listProductVariants(product.id).catch(() => []),
        listAvailabilityWindows(product.id).catch(() => []),
      ]);
      if (!alive) return;
      if (rows.length) {
        setVariants(
          rows.map((v) => ({
            id: v.id,
            label: v.label,
            price: (v.priceStotinki / 100).toFixed(2).replace('.', ','),
            stock: v.stockQuantity == null ? '' : String(v.stockQuantity),
            salePrice: v.salePriceStotinki == null ? '' : (v.salePriceStotinki / 100).toFixed(2).replace('.', ','),
          })),
        );
        if (rows.some((v) => v.salePriceStotinki != null)) setPromoMode('fixed');
      } else {
        setVariants([
          {
            label: '',
            price: (product.priceStotinki / 100).toFixed(2).replace('.', ','),
            stock: windows[0] ? String(windows[0].quantity) : '',
            salePrice: '',
          },
        ]);
      }
    })();
    return () => { alive = false; };
  }, [isEdit, product]);
```

- [ ] **Step 4: Submit — 1 row = simple, 2+ = variants, stock routing, promo mode**

Rewrite the variant/promo part of `submit()`:

```typescript
    const parsePriceStotinki = (s: string) => Math.round((parseFloat(s.replace(',', '.')) || 0) * 100);
    const filled = variants.filter((v) => parsePriceStotinki(v.price) > 0);
    if (filled.length === 0) {
      setErr('Въведи цена');
      return;
    }
    const varianted = filled.length >= 2;
    if (varianted && filled.some((v) => !v.label.trim())) {
      setErr('Всеки вариант се нуждае от име');
      return;
    }
    const fixedMode = varianted && promoMode === 'fixed';

    let variantPayload: VariantWrite[];
    let baseStotinki: number;
    let stockToSet: number | null;
    if (varianted) {
      variantPayload = filled.map((v) => {
        const priceStotinki = parsePriceStotinki(v.price);
        const salePriceStotinki = fixedMode && v.salePrice.trim() !== '' ? parsePriceStotinki(v.salePrice) : null;
        return {
          ...(v.id ? { id: v.id } : {}),
          label: v.label.trim(),
          priceStotinki,
          salePriceStotinki,
          stockQuantity: v.stock.trim() === '' ? null : parseInt(v.stock, 10),
        };
      });
      if (variantPayload.some((v) => v.salePriceStotinki != null && v.salePriceStotinki! >= v.priceStotinki)) {
        setErr('Промо цената трябва да е под редовната цена на варианта');
        return;
      }
      baseStotinki = Math.min(...variantPayload.map((v) => v.priceStotinki));
      stockToSet = null; // clear the product window — stock is per-variant now
    } else {
      const row = filled[0];
      variantPayload = []; // plain product — remove any existing variants
      baseStotinki = parsePriceStotinki(row.price);
      stockToSet = row.stock.trim() === '' ? null : parseInt(row.stock, 10);
    }

    const pct = fixedMode || salePercent.trim() === '' ? null : parseInt(salePercent, 10);
    const promoEnd = fixedMode || saleEndsAt.trim() === '' ? null : new Date(`${saleEndsAt}T23:59:59`).toISOString();
```

Then in the `ProductWrite` object passed to `createProduct`/`updateProduct`, set:
`priceStotinki: baseStotinki`, `stock: stockToSet`, `variants: variantPayload`, `salePercent: pct`, `saleEndsAt: promoEnd`. Remove any reference to the deleted `price`/`stock`/`hasVariants` variables and the old `effectivePrice` calc.

- [ ] **Step 5: Typecheck + build**

Run: `cd client && npx tsc --noEmit && npx next build`
Expected: 0 type errors; build compiles. (Watch for `react/no-unescaped-entities` on any raw `"` in JSX text — wrap such strings in `{'…'}`.)

- [ ] **Step 6: Commit**

```bash
git add client/src/components/products/product-dialog.tsx
git commit -m "feat(products): derive variants from rows; route stock (window vs per-variant); promo mode by row count"
```

---

## Task 5: Verify + finish

- [ ] **Step 1: Server tests for touched modules**

Run: `cd server && npx jest src/modules/availability src/modules/products -c ./package.json`
Expected: all pass.

- [ ] **Step 2: Client typecheck + build**

Run: `cd client && npx tsc --noEmit && npx next build`
Expected: green.

- [ ] **Step 3: Live smoke (preview or dev)**

Open the product dialog:
1. New product: one empty row, hints visible, no checkbox. Enter label-less price+stock → save → appears as a plain product; „Задай наличност" shows its window.
2. Add a 2nd row with a label → both require labels; Промоция shows the mode toggle; save → varianted; „Задай наличност" now shows „Управлява се чрез варианти" + link, and the product is gone from the bulk editor.
3. Edit the varianted product → delete down to one row → save → back to a plain product with a window.
4. Fixed promo: 2+ rows, „Фиксирана цена по вариант", per-row промо цена → storefront/charged price matches (already covered by server tests).

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch.

---

## Self-Review

**Spec coverage:**
- Remove checkbox + unified rows → Task 3. ✅
- Per-input hints → Task 3 Step 3. ✅
- 1 row = simple / 2+ = variants (save rule) → Task 4 Step 4. ✅
- Stock one-source-of-truth (window vs per-variant; clear on varianted) → Task 4 Step 4 (`stockToSet`). ✅
- „Задай наличност" varianted note + link + bulk exclusion → Task 2. ✅
- Server `hasVariants` flag → Task 1. ✅
- No migration / no chaika / model unchanged → nothing in the plan touches them. ✅

**Type consistency:** `VRow` gains `salePrice` (used in Tasks 3 & 4 identically). `VariantWrite` already has `salePriceStotinki?` (shipped @8200768). `PickerProduct.hasVariants` defined in Task 2 Step 1, consumed in Task 2 Steps 2-3. `filledCount`/`promoMode`/`effectivePromoMode` defined in Task 4 Step 2, referenced in Task 3 Step 3 (with a temporary local until Task 4 lands).

**Placeholder scan:** none — every step has concrete code or an exact command.
