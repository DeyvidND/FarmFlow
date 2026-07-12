# Product Review Queue (Чакащи продукти за проверка) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Products created by a farmer sub-account (role `farmer`) enter a pending-review state, invisible on the storefront, until the tenant admin (brand organizer) reviews — optionally edits — and approves them from the Продукти section.

**Architecture:** One new boolean column `products.needs_review`. Farmer-created products (manual create + AI-import commit) are inserted with `needs_review = true`; the public catalog query excludes them, so they never reach the storefront until approved. Tenant admin gets a „Провери продукти" button with a pending-count badge in the farmer-panel Продукти header, opening a review dialog: approve in place or jump to the existing edit dialog. Operator flows (producer onboarding, admin create) are untouched — they publish immediately.

**Tech Stack:** NestJS + Drizzle (server), Next.js farmer panel (`client/`), hand-written SQL migration, Jest.

## Design decisions (locked)

1. **Only NEW farmer-created products go pending.** Farmer *edits* to already-live products do NOT re-flag review — otherwise every stock/hide toggle floods the queue. (Edit moderation = possible future phase; requires draft/live split.)
2. **Approve-only flow, no reject state.** A bad pending product is edited then approved, or deleted/deactivated via the existing product UI.
3. **Reviewer = tenant `admin` role in the farmer panel** (Васил's organizer account). Super-admin reviews via impersonation; no super-admin UI in this phase.
4. **AI-import commit by a farmer → all committed rows pending.** Same commit by an admin → live, as today.
5. **Operator onboarding (`producer-onboard.service`) publishes immediately** — it passes `farmerScope` to `ProductsService.create`, so the pending flag MUST come from an explicit `opts` parameter, never inferred from `farmerScope`.

## Global Constraints

- All user-facing copy in Bulgarian. Key strings (use verbatim): „Провери продукти", „Чака проверка", „Одобри", „Изпрати за проверка".
- UI uses existing ff-* design tokens; NO left-border accent stripes, NO gradient text, NO raw hex colors.
- Migrations are HAND-WRITTEN (never `drizzle-kit generate`). This plan's migration file is `0090_product_review.sql` with journal `idx: 90` — `0089` is reserved by another in-flight branch; do NOT renumber to fill the gap.
- Global ValidationPipe runs `whitelist + forbidNonWhitelisted`: any new query param MUST be a decorated DTO property, or requests 400.
- `TenantRolesGuard` default-denies to admin; review endpoints must carry explicit `@Roles('admin')`.
- Every catalog-affecting write must call `this.cache.invalidate(tenantId)` (existing pattern in ProductsService).
- Commit messages end with trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Working tree of the MAIN checkout contains uncommitted WIP from another session (schema.ts, platform module, migration 0089). Execute this plan in an isolated git worktree created from `origin/main`; never `git add` files this plan does not list.

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/schema.ts` | +`needsReview` column on `products` (modify) |
| `packages/db/drizzle/0090_product_review.sql` | migration (create) |
| `packages/db/drizzle/meta/_journal.json` | +journal entry idx 90 (modify) |
| `server/src/modules/products/products.service.ts` | create `opts.needsReview`; public-catalog gate; `approve()`; `pendingReviewCount()`; `findAll` review filter (modify) |
| `server/src/modules/products/dto/list-products-query.dto.ts` | query DTO with `review` param (create) |
| `server/src/modules/products/products.controller.ts` | `GET review/count`, `POST :id/approve`, pass opts on create, use new query DTO (modify) |
| `server/src/modules/products/products.review.spec.ts` | service + roles-metadata tests (create) |
| `server/src/modules/ai-import/ai-import.controller.ts` | commit passes `opts.needsReview` for farmer (modify) |
| `client/src/lib/types.ts` | `Product.needsReview` (modify) |
| `client/src/lib/api-client.ts` | `listPendingProducts`, `approveProduct`, `pendingReviewCount` (modify) |
| `client/src/components/products/review-products-dialog.tsx` | review queue dialog (create) |
| `client/src/components/products/products-client.tsx` | header button + badge, card chip, dialog wiring (modify) |
| `client/src/components/products/ai-import-dialog.tsx` | farmer-role copy: „Изпрати за проверка" (modify) |

---

### Task 1: Schema column + migration 0090

**Files:**
- Modify: `packages/db/src/schema.ts` (products table, after `courierDisabled` ~line 196)
- Create: `packages/db/drizzle/0090_product_review.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `products.needsReview: boolean('needs_review').notNull().default(false)` — column consumed by Tasks 2–4.

- [ ] **Step 1: Add the column to the Drizzle schema**

In `packages/db/src/schema.ts`, inside the `products` table definition, directly after the `courierDisabled` column, add:

```ts
    // Moderation gate for farmer-submitted products: true = awaiting tenant-admin
    // review, hidden from the public catalog. Admin/operator-created products are
    // born false (live). Cleared only by the explicit approve endpoint.
    needsReview: boolean('needs_review').notNull().default(false),
```

- [ ] **Step 2: Hand-write the migration**

Create `packages/db/drizzle/0090_product_review.sql`:

```sql
ALTER TABLE "products" ADD COLUMN "needs_review" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX "products_tenant_pending_review_idx" ON "products" ("tenant_id") WHERE "needs_review" = true;
```

(Partial index: the pending count/queue query is `tenant_id + needs_review = true`; pending rows are always few.)

- [ ] **Step 3: Append the journal entry**

In `packages/db/drizzle/meta/_journal.json`, append to the `entries` array (after the idx 88 entry — idx 89 belongs to another branch and is absent here; the gap is intentional):

```json
    {
      "idx": 90,
      "version": "7",
      "when": <current epoch ms>,
      "tag": "0090_product_review",
      "breakpoints": true
    }
```

Use the actual current `Date.now()` value for `when` (run `node -e "console.log(Date.now())"`).

- [ ] **Step 4: Verify the db package compiles**

Run: `pnpm --filter @fermeribg/db exec tsc --noEmit`
Expected: silent exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0090_product_review.sql packages/db/drizzle/meta/_journal.json
git commit -m "feat(db): products.needs_review moderation flag (migr 0090)"
```

---

### Task 2: ProductsService — review lifecycle + public gate

**Files:**
- Modify: `server/src/modules/products/products.service.ts`
- Test: `server/src/modules/products/products.review.spec.ts` (create)

**Interfaces:**
- Consumes: `products.needsReview` column from Task 1.
- Produces (exact signatures, used by Task 3):
  - `create(tenantId: string, dto: CreateProductDto, farmerScope: string | null = null, opts: { needsReview?: boolean } = {}): Promise<Product>`
  - `approve(id: string, tenantId: string): Promise<Product>`
  - `pendingReviewCount(tenantId: string): Promise<{ count: number }>`
  - `findAll(tenantId, opts: { cursor?: string; limit?: number; review?: boolean }, farmerScope)` — `review: true` restricts to pending rows.

- [ ] **Step 1: Write the failing tests**

Create `server/src/modules/products/products.review.spec.ts`. **Copy the mock/db harness from `server/src/modules/products/products.remove.spec.ts`** (same construction of ProductsService with mocked Database, CatalogCacheService, etc. — mirror its beforeEach exactly). Test cases:

```ts
describe('product review queue', () => {
  it('create with opts.needsReview=true inserts needs_review=true', async () => {
    // call svc.create(tenantId, dto, 'farmer-1', { needsReview: true })
    // assert the values object passed to db.insert(...).values() has needsReview: true
  });

  it('create without opts inserts needs_review=false (default)', async () => {
    // svc.create(tenantId, dto, 'farmer-1') → values.needsReview === false
    // (covers producer-onboard: farmerScope set, opts omitted → LIVE)
  });

  it('approve clears the flag, invalidates catalog cache, returns the row', async () => {
    // mock update().set().where().returning() → [row]
    // assert set called with { needsReview: false }; cache.invalidate(tenantId) called
  });

  it('approve throws NotFoundException when no row matches', async () => {
    // returning() → [] ⇒ expect rejects.toThrow(NotFoundException)
  });

  it('pendingReviewCount counts tenant pending non-deleted rows', async () => {
    // mock select count → [{ count: 3 }]; expect { count: 3 }
  });

  it('findAll with review:true adds the needs_review condition', async () => {
    // spy on where-conditions (same technique the harness uses for farmerScope)
  });

  it('findPublicBySlug filters out pending products', async () => {
    // cold cache; assert query conditions include needsReview=false
    // (mirror how products.query.spec.ts asserts the isActive condition)
  });
});
```

Also add roles-metadata assertions (guards are declarative — pin them):

```ts
import { ProductsController } from './products.controller';

describe('review endpoint roles', () => {
  it('approve is admin-only', () => {
    expect(Reflect.getMetadata('roles', ProductsController.prototype.approve)).toEqual(['admin']);
  });
  it('review count is admin-only', () => {
    expect(Reflect.getMetadata('roles', ProductsController.prototype.reviewCount)).toEqual(['admin']);
  });
});
```

(If the existing specs read the roles metadata key differently — check `server/src/common/decorators/roles.decorator.ts` for the exact metadata key constant and use that.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @fermeribg/api exec jest products.review --runInBand`
Expected: FAIL — `approve is not a function`, metadata undefined.

- [ ] **Step 3: Implement in products.service.ts**

3a. `create` — extend the signature and the insert:

```ts
  async create(
    tenantId: string,
    dto: CreateProductDto,
    farmerScope: string | null = null,
    opts: { needsReview?: boolean } = {},
  ): Promise<Product> {
```

and in the insert values (the existing `.values({ ...values, tenantId, slug })` call):

```ts
      .values({ ...values, tenantId, slug, needsReview: opts.needsReview ?? false })
```

3b. Public gate — in `findPublicBySlug`, extend the `where`:

```ts
      .where(and(
        eq(products.tenantId, tenant.id),
        eq(products.isActive, true),
        eq(products.needsReview, false),
      ))
```

(`findPublicProductBySlug` reuses this catalog — no separate change.)

3c. `findAll` — widen opts type to `{ cursor?: string; limit?: number; review?: boolean }` and after the farmerScope cond:

```ts
    if (opts.review) conds.push(eq(products.needsReview, true));
```

Add the same line to the `totalConds` block (first-page total must match the filter).

3d. New methods (place after `remove`):

```ts
  /** Admin sign-off: the product leaves the review queue and becomes publicly
   *  visible (subject to the usual isActive/stock rules). Idempotent. */
  async approve(id: string, tenantId: string): Promise<Product> {
    const [row] = await this.db
      .update(products)
      .set({ needsReview: false })
      .where(and(eq(products.id, id), eq(products.tenantId, tenantId), isNull(products.deletedAt)))
      .returning();
    if (!row) throw new NotFoundException('Продуктът не е намерен');
    await this.cache.invalidate(tenantId);
    return row;
  }

  /** Size of the review queue — drives the «Провери продукти» badge. */
  async pendingReviewCount(tenantId: string): Promise<{ count: number }> {
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(and(
        eq(products.tenantId, tenantId),
        eq(products.needsReview, true),
        isNull(products.deletedAt),
      ));
    return { count };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @fermeribg/api exec jest products.review --runInBand`
Expected: PASS (metadata tests still fail — controller methods arrive in Task 3; if so, mark them `it.todo` NOW and un-todo in Task 3, or move those two asserts to Task 3's step — implementer's choice, but the suite committed here must be green).

Also run the neighbouring suites to catch signature fallout:
`pnpm --filter @fermeribg/api exec jest products --runInBand`
Expected: all existing products suites PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/products/products.service.ts server/src/modules/products/products.review.spec.ts
git commit -m "feat(products): review lifecycle — pending flag, approve, queue count, public gate"
```

---

### Task 3: Controller endpoints + farmer-create wiring

**Files:**
- Create: `server/src/modules/products/dto/list-products-query.dto.ts`
- Modify: `server/src/modules/products/products.controller.ts`
- Modify: `server/src/modules/ai-import/ai-import.controller.ts`
- Test: extend `server/src/modules/products/products.review.spec.ts`; extend the existing ai-import controller spec (`server/src/modules/ai-import/*.spec.ts` — find the commit tests)

**Interfaces:**
- Consumes: Task 2 signatures (`approve`, `pendingReviewCount`, `create` opts, `findAll` review).
- Produces (client contract for Task 4):
  - `GET /products?review=pending` → `Paginated<Product>` (pending only)
  - `GET /products/review/count` → `{ count: number }` (admin only)
  - `POST /products/:id/approve` → `Product` (admin only)

- [ ] **Step 1: Write/extend failing tests**

In `products.review.spec.ts`: un-todo (or add) the roles-metadata tests from Task 2 targeting `ProductsController.prototype.approve` and `.reviewCount`.

In the ai-import controller spec, add two cases mirroring its existing commit tests:

```ts
  it('commit as farmer creates rows with needsReview: true', async () => {
    // user.role = 'farmer' → assert productsSvc.create called with
    // (tenantId, anything, scope, { needsReview: true })
  });

  it('commit as admin creates rows with needsReview: false', async () => {
    // user.role = 'admin' → 4th arg { needsReview: false }
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @fermeribg/api exec jest products.review ai-import --runInBand`
Expected: FAIL (no controller methods; create called without opts).

- [ ] **Step 3: Implement**

3a. Create `server/src/modules/products/dto/list-products-query.dto.ts`:

```ts
import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/pagination/pagination-query.dto';

/** Products list query: pagination + optional review-queue filter. */
export class ListProductsQueryDto extends PaginationQueryDto {
  /** 'pending' = only rows awaiting review (the «Провери продукти» queue). */
  @IsOptional()
  @IsIn(['pending'])
  review?: 'pending';
}
```

(Verify the actual import path of `PaginationQueryDto` — it is whatever `products.controller.ts` already imports; extend that exact class.)

3b. `products.controller.ts`:

- Swap `@Query() q: PaginationQueryDto` in `findAll` for `ListProductsQueryDto`, add `@ApiQuery({ name: 'review', required: false })`, and pass through:

```ts
    return this.productsService.findAll(
      tenantId,
      { cursor: q.cursor, limit: q.limit, review: q.review === 'pending' },
      scope,
    );
```

- In the `create` route, pass the opts (farmer submissions enter the queue):

```ts
    return this.productsService.create(tenantId, dto, scope, {
      needsReview: user.role === 'farmer',
    });
```

- New routes, placed next to the existing literal `@Get('options')` route (before `@Get(':id')`):

```ts
  // Review queue size for the «Провери продукти» badge. Admin only — farmers
  // see their own pending rows in the list, not the queue.
  @Get('review/count')
  @Roles('admin')
  reviewCount(@CurrentTenant() tenantId: string) {
    return this.productsService.pendingReviewCount(tenantId);
  }

  // Admin sign-off on a farmer-submitted product. Explicitly admin-only —
  // a producer must never clear their own review flag.
  @Post(':id/approve')
  @Roles('admin')
  approve(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.productsService.approve(id, tenantId);
  }
```

(Match the `@Param('id')` pipe style of the existing `:id` routes — if they use `ParseUUIDPipe`, use it here too.)

3c. `ai-import.controller.ts` — in `commit`, the create call becomes:

```ts
      await this.productsSvc.create(tenantId, productDto, scope, {
        needsReview: user.role === 'farmer',
      });
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @fermeribg/api exec jest products ai-import --runInBand`
Expected: ALL PASS. Then whole-package typecheck: `pnpm --filter @fermeribg/api exec tsc --noEmit` — silent.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/products/dto/list-products-query.dto.ts server/src/modules/products/products.controller.ts server/src/modules/products/products.review.spec.ts server/src/modules/ai-import/ai-import.controller.ts server/src/modules/ai-import
git commit -m "feat(products): review endpoints — queue filter, count, admin approve; farmer AI-import commits enter queue"
```

---

### Task 4: Client API + types

**Files:**
- Modify: `client/src/lib/types.ts` (Product interface, ~line 52)
- Modify: `client/src/lib/api-client.ts` (next to `listProducts`, ~line 91)

**Interfaces:**
- Consumes: Task 3 HTTP contract.
- Produces (used by Task 5):
  - `Product.needsReview: boolean`
  - `listPendingProducts(cursor?: string): Promise<Paginated<Product>>`
  - `approveProduct(id: string): Promise<Product>`
  - `pendingReviewCount(): Promise<{ count: number }>`

- [ ] **Step 1: Add the type field**

In `client/src/lib/types.ts`, inside `Product` after `courierDisabled`:

```ts
  /** true = farmer-submitted, awaiting admin review; hidden from the storefront. */
  needsReview: boolean;
```

- [ ] **Step 2: Add the API functions**

In `client/src/lib/api-client.ts`, directly after `listProducts`, following its exact helper style (same `api<...>` wrapper and Paginated type it uses):

```ts
export const listPendingProducts = (cursor?: string) =>
  api<Paginated<Product>>(
    `/products?review=pending${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  );

export const approveProduct = (id: string) =>
  api<Product>(`/products/${id}/approve`, { method: 'POST' });

export const pendingReviewCount = () => api<{ count: number }>('/products/review/count');
```

(If `listProducts` builds URLs with a query-string helper instead of template strings, mirror that helper.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @fermeribg/web exec tsc --noEmit`
Expected: silent exit 0.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/api-client.ts
git commit -m "feat(client): product review API — pending list, approve, queue count"
```

---

### Task 5: Farmer-panel UI — button, badge, review dialog, chip

**Files:**
- Create: `client/src/components/products/review-products-dialog.tsx`
- Modify: `client/src/components/products/products-client.tsx`
- Modify: `client/src/components/products/ai-import-dialog.tsx`

**Interfaces:**
- Consumes: Task 4 functions and `Product.needsReview`.
- Produces: user-visible feature; no downstream consumers.

- [ ] **Step 1: Review dialog component**

Create `client/src/components/products/review-products-dialog.tsx`. Follow the dialog scaffolding pattern of `ai-import-dialog.tsx` (overlay, panel, close handling, `ff-*` classes). Behavior:

```tsx
'use client';

// Props
interface ReviewProductsDialogProps {
  open: boolean;
  onClose: () => void;
  farmers: { id: string; name: string }[];           // same shape products-client already holds
  onApproved: (p: Product) => void;                   // parent patches list + decrements badge
  onEdit: (p: Product) => void;                       // parent opens the existing ProductDialog
}
```

- On `open` becoming true: drain ALL pending pages — loop `listPendingProducts(cursor)` until `hasMore` false (queue is small; no pagination UI), store rows in local state. Guard async continuations with a session counter ref (same `sessionRef` pattern as `ai-import-dialog.tsx` — the dialog may be closed mid-fetch).
- Each row renders: product name, `formatPrice(priceStotinki)` per existing helpers in products-client, unit, farmer name (lookup via `farmers` prop by `farmerId`), and two buttons:
  - **„Одобри"** → `approveProduct(p.id)` → on success remove row locally + call `onApproved(updatedRow)`; disable the button while in flight.
  - **„Редактирай"** → `onEdit(p)` and `onClose()` (parent opens `ProductDialog`; after saving, admin reopens the queue to approve).
- Empty state: „Няма продукти за проверка." + close button.
- Error state on approve failure: inline red text (token `text-ff-red` or the panel's existing error class), row stays.

- [ ] **Step 2: Wire into products-client.tsx**

In `client/src/components/products/products-client.tsx`:

2a. State + count fetch (admin only):

```tsx
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (isFarmer) return;
    let alive = true;
    pendingReviewCount().then((r) => { if (alive) setPendingCount(r.count); }).catch(() => {});
    return () => { alive = false; };
  }, [isFarmer]);
```

2b. Header button — in the header actions row next to „Добави продукт" (~line 332), visible only when `!isFarmer`:

```tsx
  {!isFarmer && (
    <button
      type="button"
      onClick={() => setReviewOpen(true)}
      className={/* same button classes as the neighbouring secondary header buttons */}
    >
      <ClipboardCheck size={18} /> Провери продукти
      {pendingCount > 0 && (
        <span className="ml-1 rounded-full bg-ff-amber px-2 py-0.5 text-xs font-bold text-ff-ink">
          {pendingCount}
        </span>
      )}
    </button>
  )}
```

(`ClipboardCheck` from `lucide-react`, same import line as `Camera`/`Plus`. If `bg-ff-amber`/`text-ff-ink` are not the project's token names, use the amber + ink tokens that ARE defined in `client/tailwind.config`/globals — check before inventing.)

2c. Card chip — in the product card meta area (near the existing weight/subcat line ~line 413), for both roles:

```tsx
  {p.needsReview && (
    <span className="rounded-full bg-ff-amber-soft px-2 py-0.5 text-xs font-semibold text-ff-amber-ink">
      Чака проверка
    </span>
  )}
```

(Same token caveat — reuse whatever soft-amber chip combo the codebase already uses, e.g. the demo/status chips in other clients.)

2d. Mount the dialog next to the other dialogs (bottom of JSX):

```tsx
  {reviewOpen && (
    <ReviewProductsDialog
      open
      farmers={farmers}
      onClose={() => setReviewOpen(false)}
      onApproved={(p) => {
        patchLocal(p.id, { needsReview: false });
        setPendingCount((c) => Math.max(0, c - 1));
      }}
      onEdit={(p) => setFullEdit(p)}
    />
  )}
```

(`patchLocal` and `setFullEdit` already exist in this component — verify names against the file and use the real ones.)

- [ ] **Step 3: Farmer copy in AI-import dialog**

`ai-import-dialog.tsx` already lives inside the farmer panel; give it an optional `role` prop (`'admin' | 'farmer'`, default `'admin'`), passed from products-client (`role` prop is already in scope there). When `role === 'farmer'`:
- Commit button label: „Изпрати за проверка" (instead of the current publish label).
- Success message: „Изпратени за проверка — операторът ще ги одобри преди да се покажат в магазина."
Admin copy unchanged.

- [ ] **Step 4: Typecheck + dev-boot check**

Run: `pnpm --filter @fermeribg/web exec tsc --noEmit` — silent.
Boot check only if port 3000 is free (the user often holds it): `pnpm --filter @fermeribg/web dev` → compile `/products` without errors, then stop. If the port is taken, tsc suffices — note it in the report.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/products/review-products-dialog.tsx client/src/components/products/products-client.tsx client/src/components/products/ai-import-dialog.tsx
git commit -m "feat(client): Провери продукти — review queue dialog, badge, pending chip"
```

---

### Task 6: Full verification + push

**Files:** none new.

- [ ] **Step 1: Typecheck all three packages**

```bash
pnpm --filter @fermeribg/db exec tsc --noEmit
pnpm --filter @fermeribg/api exec tsc --noEmit
pnpm --filter @fermeribg/web exec tsc --noEmit
```
Expected: all silent.

- [ ] **Step 2: Full affected test sweep**

```bash
pnpm --filter @fermeribg/api exec jest products ai-import platform --runInBand
```
Expected: ALL PASS, no new warnings (pre-existing worker-exit warning is known noise).

- [ ] **Step 3: Push (auto-deploys production; migration 0090 self-applies on boot)**

```bash
git push origin main
```

If the main checkout's other-session WIP has landed a conflicting `_journal.json`/`schema.ts` commit in the meantime, rebase and resolve by keeping BOTH entries (their 0089 + our 0090) before pushing.

---

## Post-deploy human verification

1. Farmer account → Добави продукт → product shows „Чака проверка" chip, NOT visible on storefront.
2. Admin account → Продукти shows „Провери продукти" with badge ≥1 → Одобри → chip disappears, product appears on storefront immediately (approve invalidates the catalog cache).
3. Farmer „Добави от снимка" → commit → rows pending; admin queue shows them.
4. Operator „Onboard производител" → products live immediately (NOT pending).
