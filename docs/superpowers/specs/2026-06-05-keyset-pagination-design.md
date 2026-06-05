# Keyset pagination for admin lists — design

**Date:** 2026-06-05
**Status:** approved (pending spec review)
**Branch:** feat/media-galleries (current)

## Problem

Every admin list loads its **entire** dataset server-side (`cache: 'no-store'`),
stores it in `useState`, and filters/searches in-memory. Filtering already does not
refetch (it is pure client-side), but the **initial load is unbounded** — a farm with
thousands of orders/products transfers and renders every row.

Goal: bound the initial load with pagination **without** breaking the no-refetch-on-filter
UX. The DB indexes from migration `0023` (`(tenant_id, created_at)` family) must be the
access path.

## Decisions (confirmed)

- **Scope:** unbounded tables only — orders, products, articles, newsletter subscribers,
  reviews (admin), platform tenants. **Excluded:** farmers, subcategories (small,
  position-ordered, drag-reorderable — pagination harms reorder UX). **email-billing
  stays full-load** (sorted by `sum(price) desc` aggregate — keyset impractical; bounded
  by farm count, not per-farm rows).
- **Strategy:** keyset (cursor) pagination + client-side accumulation. Client keeps all
  loaded pages in one array; filter/search run over that array → **zero refetch on filter**.
- **Batch size:** 50 (cap 100).
- **Trigger:** explicit **"Load more" button** (not infinite scroll).

## Backend design

### New module `server/src/common/pagination/`

**`cursor.ts`**
- `encodeCursor({ createdAt: Date; id: string }): string` → base64 of `"<iso>|<uuid>"`.
- `decodeCursor(s: string): { createdAt: Date; id: string } | null` (null on malformed →
  treated as first page, never throws on user input).

**`keyset.ts`**
- `type Paginated<T> = { items: T[]; nextCursor: string | null; total?: number }`.
- `keysetPredicate(createdCol, idCol, cursor, dir: 'asc' | 'desc')` → Drizzle condition
  using row-value comparison: `(created, id) < (:c, :i)` for `desc`, `>` for `asc`.
  id is the tiebreaker (timestamps can collide at ms precision).
- `clampLimit(raw?: number): number` → default 50, min 1, max 100.

### Pattern (applied per service)

```
findAll(tenantId, { cursor, limit }): Promise<Paginated<T>> {
  const lim = clampLimit(limit);
  const cur = cursor ? decodeCursor(cursor) : null;
  const conds = [eq(tbl.tenantId, tenantId)];
  if (cur) conds.push(keysetPredicate(tbl.createdAt, tbl.id, cur, dir));
  const rows = await db.select(...).from(tbl)
    .where(and(...conds))
    .orderBy(/* createdAt dir, id dir */)
    .limit(lim + 1);              // +1 sentinel detects "has more"
  const hasMore = rows.length > lim;
  const items = hasMore ? rows.slice(0, lim) : rows;
  const nextCursor = hasMore ? encodeCursor(last(items)) : null;
  return { items, nextCursor };
}
```

`limit + 1` sentinel avoids a second count query just to know if more exist.

### Per-table specifics (sort preserved from current code)

| Service / endpoint | Sort (createdAt) | Notes |
|---|---|---|
| `orders.findAll` | DESC | Server stays **filter-free** for the admin list (status/search are client-side, as today). The existing `OrderFilters` (date/status/search) path stays available but the admin list does not pass them. Items batch-attach via existing `attachItems` (no N+1). |
| `products.findAll` | ASC | First page (`cursor` absent) also returns `total` via `count(*)` so the UI's "N общо / активни" line keeps working. `activeCount` is derived client-side over loaded rows and **relabelled** "активни (заредени)" — see Frontend. |
| `articles.findAll` | DESC | `attachMedia` already batched. |
| `newsletter.getSubscribers` | ASC | List becomes partial, so `activeCount`/`unsubscribedCount` move to **SQL `count()`** (two filtered counts) instead of `rows.filter().length`. Returns `{ items, nextCursor, activeCount, unsubscribedCount }`. |
| `reviews.listForTenant` | DESC | Admin moderation list. `status` filter (when passed) composes with keyset. |
| `platform.listTenants` | `tenants.createdAt` ASC | Grouped query (per-tenant orderCount). Keyset on `tenants.createdAt` + `tenants.id`; GROUP BY unaffected. |

### Controllers

Each affected GET list endpoint accepts `?cursor=<string>&limit=<number>` (validated via a
small `PaginationQueryDto`: optional string cursor, optional int limit) and returns
`Paginated<T>` instead of a bare array. These are **admin** endpoints — no public/storefront
consumer depends on the array shape. (Public storefront endpoints are out of scope and
unchanged.)

### Consumer handling (internal admin pages that need the full set)

Discovery found admin pages besides the list pages that fetch these endpoints and need the
**whole** dataset, not a page. Changing the shape would break them, so:

- **`GET /products`** → becomes paginated (products list page). Three other consumers need
  all products for counts/search, not the heavy paginated grid:
  - `farmers/page.tsx` (`products.filter(p => p.farmerId === fid)`),
  - `subcategories/page.tsx` (same, by `subcategoryId`),
  - `topbar.tsx` notifications (low-stock scan: needs `name, weight, isActive, stockQuantity`).

  Add **`GET /products/options`** → `ProductOption[]` =
  `{ id, name, weight, isActive, stockQuantity, farmerId, subcategoryId }` (full, unpaginated,
  lean — no description / jsonb / images / stripe ids). The three consumers switch to it. This
  also removes their current full-row over-fetch.

- **`GET /orders`** → becomes paginated (orders list page). The dashboard also reads `/orders`
  for its "today" feed; it switches to `GET /orders?limit=100` and reads `.items`, keeping its
  existing client-side `summary.date` filter (orders are newest-first, so the day's orders sit
  in the first page for any realistic farm; the "виж всички" link routes to the full /orders
  page). No server date-filter is introduced (avoids a BG-date vs UTC-date midnight mismatch).

- **`GET /articles`**, **`GET /subscribers`**, **`GET /reviews`** (admin),
  **`GET /platform tenants`** → paginated; their only consumers are the respective list pages
  (reviews has **no** admin UI yet → backend-only change).

`listProducts`/`listOrders`/`listArticles`/`listSubscribers` in `api-client.ts` change shape;
a new `listProductOptions` is added.

## Frontend design (client + admin apps)

### Shared hook `usePaginatedList`

```
usePaginatedList<T>(
  initial: { items: T[]; nextCursor: string | null },
  fetchMore: (cursor: string) => Promise<Paginated<T>>,
): { items: T[]; loadMore: () => void; hasMore: boolean; loading: boolean; setItems }
```

- Seeds state from the server-rendered first page.
- `loadMore` fetches `nextCursor`, **appends** to `items`, advances cursor.
- `setItems` exposed so existing optimistic create/update/delete handlers keep working
  (prepend on create, patch/remove in place).

### Page components (`page.tsx`)

Fetch page 1 server-side (`?limit=50`) and pass `{ items, nextCursor, total? }` to the
client component (replacing today's bare-array prop).

### Client list components

- Replace `useState<T[]>(initial)` with `usePaginatedList`.
- Render `items` exactly as today; **filtering/search unchanged** (operate over `items`).
- Add a **"Зареди още"** button below the list, shown only while `hasMore`, disabled while
  `loading`. Optional row-count caption: "показани N" (+ `total` when known).
- Count labels that previously implied a full dataset (products "N общо", orders feeds)
  are clarified to reflect loaded rows, except where a server `total` is provided.

### api-client

List fns return `Paginated<T>` and accept an optional cursor:
`listProducts(cursor?) → Paginated<Product>`, etc. Load-more calls go through the existing
`/bff/[...path]` proxy, which forwards query strings and bridges the httpOnly cookie to a
Bearer header (verified). Admin app uses the same BFF pattern (verify in planning).

## Out of scope

- farmers, subcategories, email-billing (full-load, by decision).
- Public/storefront endpoints.
- Server-side filtering for admin lists (filtering stays client-side over loaded pages —
  this is the explicit no-refetch requirement; the known tradeoff is that a filter only
  matches already-loaded pages until "Load more").

## Verification / audit (explicit requirement)

After implementation:

1. **Query side:** `EXPLAIN (ANALYZE, BUFFERS)` each keyset list query on a seeded table
   → confirm Index Scan on the `0023` index, **no Seq Scan** on big tables, **no OFFSET**.
   Confirm `limit+1` is the only over-fetch.
2. **Client side:** with devtools network panel, confirm:
   - toggling any filter / typing in search fires **no** network request;
   - "Load more" issues exactly one request and **appends** (prior rows untouched, not re-fetched);
   - optimistic create/update/delete still mutate the in-memory list without a full reload.
3. **Regression:** `pnpm build` (db + server + both web apps) clean; server jest green;
   newsletter count labels correct against SQL counts.

## Testing

- Unit: `cursor.ts` round-trip + malformed input → null; `keysetPredicate` shape;
  `clampLimit` bounds.
- Service: each `findAll` returns `nextCursor` when more rows exist, null at the tail,
  and the +1 sentinel never leaks into `items`. Update existing newsletter spec for the
  new count-via-SQL + `{ items, nextCursor }` shape.
