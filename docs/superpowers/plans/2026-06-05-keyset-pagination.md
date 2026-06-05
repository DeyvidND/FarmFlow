# Keyset Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the initial load of every unbounded admin list (orders, products, articles, newsletter subscribers, reviews, platform tenants) with keyset (cursor) pagination, while keeping filtering/search 100% client-side over accumulated rows (zero refetch on filter).

**Architecture:** Reusable backend cursor/keyset module rides the `(tenant_id, created_at)` indexes from migration 0023 (no OFFSET). List endpoints return `{ items, nextCursor, total? }`. Frontend seeds page 1 server-side, accumulates further pages with a `usePaginatedList` hook + "Зареди още" button. Secondary consumers that need the whole product set move to a new lean `GET /products/options`.

**Tech Stack:** NestJS + Drizzle ORM (Postgres), Next.js App Router (two apps: `client` farmer panel, `admin` super-admin), Jest, class-validator.

**Spec:** `docs/superpowers/specs/2026-06-05-keyset-pagination-design.md`

---

## File Structure

**Backend (new):**
- `server/src/common/pagination/cursor.ts` — encode/decode cursor token.
- `server/src/common/pagination/keyset.ts` — `Paginated<T>`, `clampLimit`, `keysetAfter`, `buildPage`.
- `server/src/common/pagination/pagination-query.dto.ts` — `PaginationQueryDto`.
- `server/src/common/pagination/*.spec.ts` — unit tests.

**Backend (modified):** `orders`, `products`, `articles`, `newsletter`, `reviews`, `platform` services + controllers; `products` gains an `options` handler + `ProductOption` type.

**Frontend client app (new):** `client/src/hooks/use-paginated-list.ts`.
**Frontend client app (modified):** `lib/types.ts`, `lib/api-client.ts`; pages `orders`, `products`, `articles`, `newsletters`, `dashboard`, `farmers`, `subcategories`; components `orders-client`, `products-client`, `articles-client`, `newsletter-client`, `topbar`.

**Frontend admin app (new):** `admin/src/hooks/use-paginated-list.ts`.
**Frontend admin app (modified):** `lib/types.ts` (or inline), `lib/api-client.ts`; `tenants` page + `tenants-client`.

---

## Phase A — Backend pagination foundation

### Task 1: Cursor codec

**Files:**
- Create: `server/src/common/pagination/cursor.ts`
- Test: `server/src/common/pagination/cursor.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/common/pagination/cursor.spec.ts
import { encodeCursor, decodeCursor } from './cursor';

describe('cursor codec', () => {
  it('round-trips createdAt + id', () => {
    const pos = { createdAt: new Date('2026-06-05T10:20:30.123Z'), id: 'abc-123' };
    const decoded = decodeCursor(encodeCursor(pos));
    expect(decoded?.id).toBe('abc-123');
    expect(decoded?.createdAt.toISOString()).toBe('2026-06-05T10:20:30.123Z');
  });

  it('returns null on malformed input (never throws)', () => {
    expect(decodeCursor('not-base64-$$$')).toBeNull();
    expect(decodeCursor(Buffer.from('no-separator', 'utf8').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('bad-date|x', 'utf8').toString('base64url'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm test -- cursor.spec`
Expected: FAIL ("Cannot find module './cursor'").

- [ ] **Step 3: Write implementation**

```ts
// server/src/common/pagination/cursor.ts
export interface CursorPos {
  createdAt: Date;
  id: string;
}

/** Opaque cursor = base64url("<iso>|<id>"). id is the tiebreaker for equal timestamps. */
export function encodeCursor(pos: CursorPos): string {
  const raw = `${pos.createdAt.toISOString()}|${pos.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Decode a cursor; returns null for any malformed/forged token (treated as first page). */
export function decodeCursor(token: string): CursorPos | null {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const idx = raw.indexOf('|');
    if (idx === -1) return null;
    const id = raw.slice(idx + 1);
    const createdAt = new Date(raw.slice(0, idx));
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm test -- cursor.spec`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/common/pagination/cursor.ts server/src/common/pagination/cursor.spec.ts
git commit -m "feat(pagination): add opaque cursor codec"
```

---

### Task 2: Keyset helpers

**Files:**
- Create: `server/src/common/pagination/keyset.ts`
- Test: `server/src/common/pagination/keyset.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/common/pagination/keyset.spec.ts
import { clampLimit, buildPage, DEFAULT_LIMIT, MAX_LIMIT } from './keyset';

describe('clampLimit', () => {
  it('defaults when absent / NaN', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(NaN)).toBe(DEFAULT_LIMIT);
  });
  it('clamps to [1, MAX_LIMIT]', () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(9999)).toBe(MAX_LIMIT);
    expect(clampLimit(25)).toBe(25);
  });
});

describe('buildPage', () => {
  const cursorOf = (r: { createdAt: Date; id: string }) => r;
  const rows = Array.from({ length: 4 }, (_, i) => ({ createdAt: new Date(2026, 0, i + 1), id: `id-${i}` }));

  it('trims the +1 sentinel and emits a nextCursor when more exist', () => {
    const page = buildPage(rows, 3, cursorOf); // 4 rows, limit 3 → hasMore
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).not.toBeNull();
  });

  it('null cursor at the tail', () => {
    const page = buildPage(rows.slice(0, 2), 3, cursorOf); // 2 rows, limit 3 → no more
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm test -- keyset.spec`
Expected: FAIL ("Cannot find module './keyset'").

- [ ] **Step 3: Write implementation**

```ts
// server/src/common/pagination/keyset.ts
import { and, or, eq, lt, gt, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { encodeCursor, type CursorPos } from './cursor';

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export function clampLimit(raw?: number): number {
  if (raw == null || Number.isNaN(raw)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(raw)));
}

/** Strict keyset predicate: rows after `cursor`. DESC → (created,id) < (c,i); ASC → > . */
export function keysetAfter(
  createdCol: PgColumn,
  idCol: PgColumn,
  cursor: CursorPos,
  dir: 'asc' | 'desc',
): SQL {
  const cmp = dir === 'desc' ? lt : gt;
  return or(cmp(createdCol, cursor.createdAt), and(eq(createdCol, cursor.createdAt), cmp(idCol, cursor.id)))!;
}

/** Turn `limit+1` rows into a page. `cursorOf` extracts the keyset position of a row. */
export function buildPage<T>(rows: T[], limit: number, cursorOf: (row: T) => CursorPos): Paginated<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(cursorOf(last)) : null;
  return { items, nextCursor };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm test -- keyset.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/common/pagination/keyset.ts server/src/common/pagination/keyset.spec.ts
git commit -m "feat(pagination): add keyset predicate + page builder"
```

---

### Task 3: Pagination query DTO

**Files:**
- Create: `server/src/common/pagination/pagination-query.dto.ts`

- [ ] **Step 1: Write implementation** (no test — declarative DTO, validated by class-validator)

```ts
// server/src/common/pagination/pagination-query.dto.ts
import { IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class PaginationQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd server && pnpm build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add server/src/common/pagination/pagination-query.dto.ts
git commit -m "feat(pagination): add PaginationQueryDto"
```

---

## Phase B — Backend endpoints

> Pattern for every list service method below:
> ```ts
> async findAll(tenantId, { cursor, limit }: { cursor?: string; limit?: number }): Promise<Paginated<T>> {
>   const lim = clampLimit(limit);
>   const cur = cursor ? decodeCursor(cursor) : null;
>   const conds = [eq(tbl.tenantId, tenantId)];
>   if (cur) conds.push(keysetAfter(tbl.createdAt, tbl.id, cur, DIR));
>   const rows = await this.db.select(...).from(tbl).where(and(...conds)).orderBy(/* createdAt DIR, id DIR */).limit(lim + 1);
>   return buildPage(rows, lim, (r) => ({ createdAt: r.createdAt!, id: r.id }));
> }
> ```
> Controller: add `@Query() q: PaginationQueryDto`, pass `{ cursor: q.cursor, limit: q.limit }`, return `Paginated<T>`.

### Task 4: Orders — paginated list

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts` (`findAll`, DESC by `createdAt`, id tiebreaker)
- Modify: `server/src/modules/orders/orders.controller.ts` (list handler)
- Test: `server/src/modules/orders/orders.service.spec.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
// orders.service.spec.ts — keyset page shape
it('findAll returns a page with nextCursor when more rows exist', async () => {
  // Arrange a mock db returning limit+1 rows (51) for limit 50.
  // Assert: result.items.length === 50, result.nextCursor !== null.
});
```
(Use the existing mock-db pattern from `newsletter.service.spec.ts`: chainable `select/from/where/orderBy/limit`, with `limit` resolving the row array.)

- [ ] **Step 2: Run test → FAIL**

Run: `cd server && pnpm test -- orders.service.spec`
Expected: FAIL (findAll returns array, not `{items,nextCursor}`).

- [ ] **Step 3: Implement**

In `orders.service.ts`:
- Change signature: `findAll(tenantId: string, opts: { cursor?: string; limit?: number } = {}): Promise<Paginated<OrderWithItems>>`.
- Keep `tenantId` scope; **drop** the per-request status/date/search filters from the admin-list path (filtering is now client-side). Keep the `subscription inactive → last 7 days` guard.
- Build keyset on `orders.createdAt` DESC, `orders.id` DESC; `.limit(lim + 1)`; call `attachItems` on the trimmed `items` (not the +1), then `buildPage`. Implementation detail: trim BEFORE `attachItems` to avoid attaching the sentinel —
  ```ts
  const lim = clampLimit(opts.limit);
  const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
  const conds = [eq(orders.tenantId, tenantId)];
  if (t?.status === 'inactive') conds.push(sql`${orders.createdAt} >= now() - interval '7 days'`);
  if (cur) conds.push(keysetAfter(orders.createdAt, orders.id, cur, 'desc'));
  const rows = await this.db.select(orderWithSlot).from(orders)
    .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
    .where(and(...conds)!).orderBy(desc(orders.createdAt), desc(orders.id)).limit(lim + 1);
  const hasMore = rows.length > lim;
  const pageRows = hasMore ? rows.slice(0, lim) : rows;
  const items = await this.attachItems(pageRows);
  return { items, nextCursor: hasMore ? encodeCursor({ createdAt: pageRows[pageRows.length - 1].createdAt!, id: pageRows[pageRows.length - 1].id }) : null };
  ```

In `orders.controller.ts`: list handler gains `@Query() q: PaginationQueryDto` → `this.orders.findAll(tenantId, { cursor: q.cursor, limit: q.limit })`.

- [ ] **Step 4: Run test → PASS**

Run: `cd server && pnpm test -- orders.service.spec`

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/
git commit -m "feat(orders): keyset-paginate admin order list"
```

---

### Task 5: Products — paginated list + `/options` endpoint

**Files:**
- Modify: `server/src/modules/products/products.service.ts` (`findAll` ASC, add `listOptions`)
- Modify: `server/src/modules/products/products.controller.ts` (list handler + `GET options`)
- Modify: `server/src/modules/products/...` add `ProductOption` shape (export from service or a small type)
- Test: `server/src/modules/products/products.service.spec.ts` (create if absent)

- [ ] **Step 1: Write failing tests** — `findAll` returns `{items,nextCursor,total}`; `listOptions` returns lean rows.

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

```ts
export interface ProductOption {
  id: string; name: string; weight: string | null;
  isActive: boolean | null; stockQuantity: number | null;
  farmerId: string | null; subcategoryId: string | null;
}

async findAll(tenantId: string, opts: { cursor?: string; limit?: number } = {}): Promise<Paginated<Product>> {
  const lim = clampLimit(opts.limit);
  const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
  const conds = [eq(products.tenantId, tenantId)];
  if (cur) conds.push(keysetAfter(products.createdAt, products.id, cur, 'asc'));
  const rows = await this.db.select().from(products).where(and(...conds))
    .orderBy(asc(products.createdAt), asc(products.id)).limit(lim + 1);
  const page = buildPage(rows, lim, (r) => ({ createdAt: r.createdAt!, id: r.id }));
  // total only on the first page (no cursor) so the UI can show "N общо".
  if (!cur) {
    const [{ total }] = await this.db.select({ total: sql<number>`count(*)::int` })
      .from(products).where(eq(products.tenantId, tenantId));
    page.total = total;
  }
  return page;
}

listOptions(tenantId: string): Promise<ProductOption[]> {
  return this.db.select({
    id: products.id, name: products.name, weight: products.weight,
    isActive: products.isActive, stockQuantity: products.stockQuantity,
    farmerId: products.farmerId, subcategoryId: products.subcategoryId,
  }).from(products).where(eq(products.tenantId, tenantId)).orderBy(asc(products.createdAt));
}
```

Controller: existing `@Get()` list → paginated; add `@Get('options')` → `listOptions`. **Order matters:** declare `@Get('options')` BEFORE any `@Get(':id')` route so "options" is not captured as an id param.

- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** `feat(products): keyset-paginate list + add lean /products/options`

---

### Task 6: Articles — paginated list

**Files:** `server/src/modules/articles/articles.service.ts` (`findAll`, DESC), `articles.controller.ts`, spec.

- [ ] **Step 1–2:** failing test for `{items,nextCursor}`.
- [ ] **Step 3:** keyset on `articles.createdAt` DESC, `articles.id` DESC; trim to `pageRows` BEFORE `attachMedia`; `buildPage`. Controller adds `@Query() q: PaginationQueryDto`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(articles): keyset-paginate admin article list`.

---

### Task 7: Newsletter subscribers — paginated list + SQL counts

**Files:** `server/src/modules/newsletter/newsletter.service.ts` (`getSubscribers`), controller, `newsletter.service.spec.ts` (update).

- [ ] **Step 1: Update/extend test** — `getSubscribers` returns `{ items, nextCursor, activeCount, unsubscribedCount }`; counts come from SQL `count()` (mock the two count queries), list from the keyset page.

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

```ts
export interface SubscribersResult {
  items: { id: string; email: string; createdAt: Date | null }[];
  nextCursor: string | null;
  activeCount: number;
  unsubscribedCount: number;
}

async getSubscribers(tenantId: string, opts: { cursor?: string; limit?: number } = {}): Promise<SubscribersResult> {
  const lim = clampLimit(opts.limit);
  const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
  const conds = [eq(newsletterSubscribers.tenantId, tenantId)];
  if (cur) conds.push(keysetAfter(newsletterSubscribers.createdAt, newsletterSubscribers.id, cur, 'asc'));
  const rows = await this.db
    .select({ id: newsletterSubscribers.id, email: newsletterSubscribers.email, createdAt: newsletterSubscribers.createdAt, unsubscribedAt: newsletterSubscribers.unsubscribedAt })
    .from(newsletterSubscribers).where(and(...conds))
    .orderBy(asc(newsletterSubscribers.createdAt), asc(newsletterSubscribers.id)).limit(lim + 1);
  const page = buildPage(rows, lim, (r) => ({ createdAt: r.createdAt!, id: r.id }));
  let activeCount = 0, unsubscribedCount = 0;
  if (!cur) {
    const [c] = await this.db.select({
      active: sql<number>`count(*) filter (where ${newsletterSubscribers.unsubscribedAt} is null)::int`,
      unsub: sql<number>`count(*) filter (where ${newsletterSubscribers.unsubscribedAt} is not null)::int`,
    }).from(newsletterSubscribers).where(eq(newsletterSubscribers.tenantId, tenantId));
    activeCount = c.active; unsubscribedCount = c.unsub;
  }
  return { items: page.items.map(({ id, email, createdAt }) => ({ id, email, createdAt })), nextCursor: page.nextCursor, activeCount, unsubscribedCount };
}
```
Controller `GET /subscribers` adds `@Query() q: PaginationQueryDto`. (Counts return 0 on cursored pages; the client already has them from page 1.)

- [ ] **Step 4:** PASS (whole newsletter spec green).
- [ ] **Step 5:** Commit `feat(newsletter): keyset-paginate subscribers, counts via SQL`.

---

### Task 8: Reviews — paginated admin list (backend only, no UI yet)

**Files:** `server/src/modules/reviews/reviews.service.ts` (`listForTenant`), `reviews.controller.ts`.

- [ ] **Step 1–2:** failing test — `listForTenant(tenantId, { status?, cursor?, limit? })` returns `{items,nextCursor}`.
- [ ] **Step 3:** keyset on `reviews.createdAt` DESC, `reviews.id` DESC; compose with optional `status` eq; `buildPage`. Controller passes `q.cursor`, `q.limit` (+ existing `status`).
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(reviews): keyset-paginate admin moderation list`.

---

### Task 9: Platform tenants — paginated list

**Files:** `server/src/modules/platform/platform.service.ts` (`listTenants`), `platform.controller.ts`, `platform.service.spec.ts` (update if it asserts array).

- [ ] **Step 1–2:** failing test — `listTenants({cursor,limit})` returns `{items,nextCursor}`; grouped query intact (per-tenant orderCount).
- [ ] **Step 3:** keyset on `tenants.createdAt` ASC, `tenants.id` ASC added to the grouped query's WHERE; `.limit(lim+1)`; `buildPage`. Controller adds `@Query() q: PaginationQueryDto`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(platform): keyset-paginate tenants list`.

- [ ] **Phase B gate:** `cd server && pnpm build && pnpm test` → all green. Commit nothing (verification only).

---

## Phase C — Frontend foundation (both apps)

### Task 10: Shared types + `usePaginatedList` hook

**Files:**
- Modify: `client/src/lib/types.ts` — add `Paginated<T>` + `ProductOption`.
- Create: `client/src/hooks/use-paginated-list.ts`.
- Modify: `admin/src/lib/types.ts` (or create) — add `Paginated<T>`.
- Create: `admin/src/hooks/use-paginated-list.ts`.

- [ ] **Step 1: Add types** (client `lib/types.ts`)

```ts
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export interface ProductOption {
  id: string; name: string; weight: string | null;
  isActive: boolean | null; stockQuantity: number | null;
  farmerId: string | null; subcategoryId: string | null;
}
```
(admin `lib/types.ts`: add the `Paginated<T>` interface only.)

- [ ] **Step 2: Create the hook** (identical file in both `client/src/hooks/` and `admin/src/hooks/`)

```tsx
'use client';
import { useState, useCallback } from 'react';
import type { Paginated } from '@/lib/types';

export function usePaginatedList<T>(
  initial: Paginated<T>,
  fetchMore: (cursor: string) => Promise<Paginated<T>>,
) {
  const [items, setItems] = useState<T[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [loading, setLoading] = useState(false);

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await fetchMore(cursor);
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, fetchMore]);

  return { items, setItems, loadMore, hasMore: cursor !== null, loading } as const;
}
```

- [ ] **Step 3: Verify both apps compile**

Run: `cd client && pnpm build` and `cd admin && pnpm build`
Expected: both succeed (hook unused yet → tree-shaken; types valid).

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/types.ts client/src/hooks/use-paginated-list.ts admin/src/lib/types.ts admin/src/hooks/use-paginated-list.ts
git commit -m "feat(web): add Paginated type + usePaginatedList hook (both apps)"
```

---

### Task 11: api-client list functions

**Files:** `client/src/lib/api-client.ts`, `admin/src/lib/api-client.ts`.

- [ ] **Step 1: Update client `api-client.ts`**

```ts
import type { /* …existing… */ Paginated, ProductOption } from './types';

const qs = (cursor?: string, limit?: number) => {
  const p = new URLSearchParams();
  if (cursor) p.set('cursor', cursor);
  if (limit) p.set('limit', String(limit));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const listProducts = (cursor?: string) => apiFetch<Paginated<Product>>(`products${qs(cursor)}`);
export const listProductOptions = () => apiFetch<ProductOption[]>('products/options');
export const listOrders = (cursor?: string) => apiFetch<Paginated<Order>>(`orders${qs(cursor)}`);
export const listArticles = (cursor?: string) => apiFetch<Paginated<Article>>(`articles${qs(cursor)}`);
export const listSubscribers = (cursor?: string) =>
  apiFetch<{ items: { id: string; email: string; createdAt: string | null }[]; nextCursor: string | null; activeCount: number; unsubscribedCount: number }>(`subscribers${qs(cursor)}`);
```

- [ ] **Step 2: Update admin `api-client.ts`** — `listTenants(cursor?)` → `Paginated<PlatformTenantRow>` with the same `qs` helper.

- [ ] **Step 3: Verify compile** — `cd client && pnpm build`, `cd admin && pnpm build`. (Callers update in Phase D; if build flags caller type errors, they are fixed there. Run lint only here.)

- [ ] **Step 4: Commit** `feat(web): cursor-aware list api-client fns`

---

## Phase D — Frontend pages

> Per page: (a) server `page.tsx` fetches page 1 (`?limit=50`) and passes the `Paginated<T>` to the client; (b) client component swaps `useState(initial)` → `usePaginatedList(initial, fetchMore)`, aliasing `items`/`setItems` to the existing names; (c) add the "Зареди още" button.

**Shared "Load more" button** (place below each list, inside the client component):
```tsx
{hasMore && (
  <div className="mt-5 flex justify-center">
    <button
      onClick={loadMore}
      disabled={loading}
      className="rounded-xl border border-ff-border bg-ff-surface px-5 py-2.5 text-[14px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2 disabled:opacity-60"
    >
      {loading ? 'Зареждане…' : 'Зареди още'}
    </button>
  </div>
)}
```

### Task 12: Orders page + dashboard consumer

**Files:** `client/src/app/(admin)/orders/page.tsx`, `client/src/components/orders/orders-client.tsx`, `client/src/app/(admin)/dashboard/page.tsx`.

- [ ] **Step 1: `orders/page.tsx`** — fetch `${API_BASE}/orders?limit=50`, type the result `Paginated<Order>`, pass `initial={page}` (shape change: `OrdersClient` now takes `initial: Paginated<Order>`).

- [ ] **Step 2: `orders-client.tsx`** — replace `const [orders, setOrders] = useState(initial)` with:
```tsx
const { items: orders, setItems: setOrders, loadMore, hasMore, loading } = usePaginatedList<Order>(initial, listOrders);
```
Keep the existing client-side `filtered`/search logic unchanged. Add the Load-more button after the table/cards block. Prop type: `{ initial: Paginated<Order> }`.

- [ ] **Step 3: `dashboard/page.tsx`** — change the orders fetch to `${API_BASE}/orders?limit=100`, read `.items`:
```ts
const oJson = oRes.ok ? await oRes.json() : { items: [] };
const orders = oJson.items ?? [];
```
(Dashboard's client-side `summary.date` filter is unchanged; today's orders are newest → within page 1.)

- [ ] **Step 4: Verify** — `cd client && pnpm build`. Manually: orders list shows 50 + "Зареди още"; dashboard feed still shows today.

- [ ] **Step 5: Commit** `feat(orders-ui): paginated list + load-more; bound dashboard fetch`

---

### Task 13: Products page + secondary consumers

**Files:** `client/src/app/(admin)/products/page.tsx`, `client/src/components/products/products-client.tsx`, `client/src/app/(admin)/farmers/page.tsx`, `client/src/app/(admin)/subcategories/page.tsx`, `client/src/components/layout/topbar.tsx`.

- [ ] **Step 1: `products/page.tsx`** — fetch `products?limit=50` as `Paginated<Product>` (keep farmers/subcats/tenant fetches). Pass `initial={productsPage}` to `ProductsClient`.

- [ ] **Step 2: `products-client.tsx`** — prop `initial: Paginated<Product>`; swap to
```tsx
const { items: products, setItems: setProducts, loadMore, hasMore, loading } = usePaginatedList<Product>(initial, listProducts);
```
Count line: `{activeLoaded} активни · {initial.total ?? products.length} общо` where `activeLoaded = products.filter(p => p.isActive).length` (relabel tooltip "активни (заредени)" if desired). Add Load-more button after the grid. All optimistic handlers keep using `setProducts`.

- [ ] **Step 3: `farmers/page.tsx` + `subcategories/page.tsx`** — replace `fetchJson<Product[]>('products', [])` with `fetchJson<ProductOption[]>('products/options', [])`. Their client components already only read `id/name/farmerId`(or `subcategoryId`); update the prop type `products: Product[]` → `products: ProductOption[]` in `farmers-client.tsx` / `subcategories-client.tsx`.

- [ ] **Step 4: `topbar.tsx`** — replace `listProducts()` in `loadNotifs` with `listProductOptions()`; the stock scan uses `name/weight/isActive/stockQuantity`, all present on `ProductOption`. Update the import.

- [ ] **Step 5: Verify** — `cd client && pnpm build`. Manually: products list paginates; farmers/subcategories still show per-item product counts; topbar low-stock notifications still appear.

- [ ] **Step 6: Commit** `feat(products-ui): paginated grid + /options for farmers/subcats/topbar`

---

### Task 14: Articles page

**Files:** `client/src/app/(admin)/articles/page.tsx`, `client/src/components/articles/articles-client.tsx`.

- [ ] **Step 1:** `articles/page.tsx` fetch `articles?limit=50` → `Paginated<Article>`, pass `initial`.
- [ ] **Step 2:** `articles-client.tsx` prop `initial: Paginated<Article>`; `const { items: articles, setItems, loadMore, hasMore, loading } = usePaginatedList<Article>(initial, listArticles);`. Keep existing render/handlers. Add Load-more button.
- [ ] **Step 3:** Verify `cd client && pnpm build`.
- [ ] **Step 4:** Commit `feat(articles-ui): paginated list + load-more`.

---

### Task 15: Newsletters page

**Files:** `client/src/app/(admin)/newsletters/page.tsx`, `client/src/components/newsletter/newsletter-client.tsx`.

- [ ] **Step 1:** `newsletters/page.tsx` fetch `${API_BASE}/subscribers?limit=50`; the JSON now has `{ items, nextCursor, activeCount, unsubscribedCount }`. Pass `initial={{ items: data.items, nextCursor: data.nextCursor }}`, `activeCount`, and (if shown) `unsubscribedCount`.
- [ ] **Step 2:** `newsletter-client.tsx` prop changes to `{ initial: Paginated<Subscriber>; activeCount: number }`; swap to `usePaginatedList(initial, listSubscribers)` (map the cursored `listSubscribers` result `{items,nextCursor}` into the hook — wrap: `(c) => listSubscribers(c).then(r => ({ items: r.items, nextCursor: r.nextCursor }))`). Render `items`; counts come from props. Add Load-more button.
- [ ] **Step 3:** Verify `cd client && pnpm build`.
- [ ] **Step 4:** Commit `feat(newsletter-ui): paginated subscribers + load-more`.

---

### Task 16: Admin platform tenants page

**Files:** `admin/src/app/(panel)/tenants/page.tsx`, `admin/src/components/tenants-client.tsx`.

- [ ] **Step 1:** `tenants/page.tsx` fetch `tenants?limit=50` → `Paginated<PlatformTenantRow>`, pass `initial`.
- [ ] **Step 2:** `tenants-client.tsx` prop `initial: Paginated<...>`; `const { items: tenants, setItems, loadMore, hasMore, loading } = usePaginatedList(initial, listTenants);`. Keep existing client-side search/filter. Add Load-more button (admin styling).
- [ ] **Step 3:** Verify `cd admin && pnpm build`.
- [ ] **Step 4:** Commit `feat(admin-ui): paginated tenants list + load-more`.

---

## Phase E — Audit & verification (explicit requirement)

### Task 17: Query-side audit (index usage, no Seq Scan / OFFSET)

- [ ] **Step 1:** Seed a tenant with > 200 rows in `orders` and `products` (use `packages/db` seed or an ad-hoc insert script).
- [ ] **Step 2:** Run `EXPLAIN (ANALYZE, BUFFERS)` for the page-1 and page-2 keyset queries, e.g.:
```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders
WHERE tenant_id = '<tid>'
ORDER BY created_at DESC, id DESC
LIMIT 51;

EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders
WHERE tenant_id = '<tid>'
  AND (created_at < '<c>' OR (created_at = '<c>' AND id < '<i>'))
ORDER BY created_at DESC, id DESC
LIMIT 51;
```
- [ ] **Step 3:** Confirm in the plan output: **Index Scan / Index Cond** using `orders_tenant_created_idx` (and the products/reviews/etc. equivalents), **no `Seq Scan`** on the big tables, **no `OFFSET`**. Record findings in a short comment block at the bottom of the plan file.

### Task 18: Client-side audit (filter = 0 requests; load-more appends)

- [ ] **Step 1:** Run the client app; open an admin list with > 50 rows. Open devtools Network.
- [ ] **Step 2:** Type in search / toggle a filter → confirm **zero** network requests fire (filtering is pure client-side over loaded items).
- [ ] **Step 3:** Click "Зареди още" → confirm exactly **one** request (`?cursor=…`) and that previously-rendered rows are **not** re-requested (the response contains only the next 50; React state appends).
- [ ] **Step 4:** Perform an optimistic create/toggle/delete → confirm the in-memory list updates without a full reload.

### Task 19: Full regression

- [ ] **Step 1:** `cd packages/db && pnpm build` (no schema change expected here; sanity).
- [ ] **Step 2:** `cd server && pnpm build && pnpm test` → green.
- [ ] **Step 3:** `cd client && pnpm build` and `cd admin && pnpm build` → green.
- [ ] **Step 4:** Commit any final fixes; write a one-line summary in the plan file's audit comment block.

---

## Notes / risks

- **Filter-only-covers-loaded-pages** is the accepted tradeoff (spec). If a farmer filters "Отказани" and old cancelled orders sit on unloaded pages, they appear only after "Зареди още". Acceptable for admin; revisit with server-side filtering only if users complain.
- **`total` only on page 1** — cursored requests skip the `count(*)`; the client keeps the page-1 total.
- **Reviews** has no admin UI; Task 8 is backend-only (endpoint ready for a future moderation page).
- **farmers/subcategories/email-billing** intentionally remain full-load (small, ordered/aggregate).
