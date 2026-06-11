# Curated Home Reviews Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans / subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let the farmer enable a reviews block on the storefront home and hand-pick which of their published reviews appear, in pick order.

**Architecture:** Extend `settings.landing` with a `reviews:{show,ids}` block (no migration). `resolveLanding` clamps it; the bootstrap endpoint resolves the picked ids into review content (`homeReviews`) via a new `ReviewsService.findHomeReviews` (pure `orderReviewsByIds` helper). Admin „Начална страница" card gains a „Отзиви" row with a checkbox picker. chaika home renders the block from `homeReviews`.

**Tech Stack:** NestJS + Drizzle, Next admin, Astro chaika, Jest.

---

## Task 1: `reviews` block in the landing resolver

**Files:** Modify `server/src/modules/tenants/landing.ts`; Modify `server/src/modules/tenants/landing.spec.ts`

- [ ] **Step 1: Add failing tests** — append to `landing.spec.ts` inside `describe('resolveLanding'…)`:

```ts
  it('defaults reviews to off with no picks', () => {
    expect(DEFAULT_LANDING.reviews).toEqual({ show: false, ids: [] });
    expect(resolveLanding(undefined).reviews).toEqual({ show: false, ids: [] });
  });

  it('coerces reviews.show, dedupes ids, drops non-strings, caps at 12', () => {
    const ids = Array.from({ length: 15 }, (_, i) => `id${i}`);
    const out = resolveLanding({
      reviews: { show: true, ids: [...ids, 'id0', 5, null] },
    });
    expect(out.reviews.show).toBe(true);
    expect(out.reviews.ids).toHaveLength(12);
    expect(out.reviews.ids[0]).toBe('id0');
    expect(new Set(out.reviews.ids).size).toBe(12); // deduped
  });
```

- [ ] **Step 2: Run → fail**

Run: `cd server && npx jest src/modules/tenants/landing.spec.ts`
Expected: FAIL (`reviews` undefined).

- [ ] **Step 3: Implement** — in `landing.ts`:

Extend interfaces + default:

```ts
export interface ReviewsBlock {
  show: boolean;
  ids: string[];
}

export interface PublicLanding {
  categories: LandingBlock;
  farmers: LandingBlock;
  latest: LandingBlock;
  reviews: ReviewsBlock;
}

export const DEFAULT_LANDING: PublicLanding = {
  categories: { show: true, count: 0 },
  farmers: { show: true, count: 3 },
  latest: { show: true, count: 4 },
  reviews: { show: false, ids: [] },
};
```

Add a reviews resolver + wire it into `resolveLanding`:

```ts
const MAX_REVIEW_IDS = 12;

/** Reviews block: a show flag + an ordered, deduped, capped list of picked review
 *  ids. Non-string entries are dropped; order is the farmer's pick order. */
function resolveReviewsBlock(raw: unknown): ReviewsBlock {
  const r = asRecord(raw);
  const show = typeof r.show === 'boolean' ? r.show : DEFAULT_LANDING.reviews.show;
  const seen = new Set<string>();
  const ids: string[] = [];
  if (Array.isArray(r.ids)) {
    for (const v of r.ids) {
      if (typeof v === 'string' && v && !seen.has(v)) {
        seen.add(v);
        ids.push(v);
        if (ids.length >= MAX_REVIEW_IDS) break;
      }
    }
  }
  return { show, ids };
}
```

In `resolveLanding`'s return object add:

```ts
    latest: resolveBlock(r.latest, DEFAULT_LANDING.latest, 1),
    reviews: resolveReviewsBlock(r.reviews),
  };
```

- [ ] **Step 4: Run → pass**

Run: `cd server && npx jest src/modules/tenants/landing.spec.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/tenants/landing.ts server/src/modules/tenants/landing.spec.ts
git commit -m "feat(tenants): reviews block in resolveLanding (show + picked ids)"
```

---

## Task 2: `LandingReviewsDto`

**Files:** Modify `server/src/modules/tenants/dto/landing.dto.ts`

- [ ] **Step 1: Add the nested DTO + field**

Add imports for `IsArray, ArrayMaxSize, IsUUID` to the existing `class-validator` import. Then:

```ts
export class LandingReviewsDto {
  @IsOptional()
  @IsBoolean()
  show?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsUUID('all', { each: true })
  ids?: string[];
}
```

And in `LandingDto`, after `latest`:

```ts
  @IsOptional()
  @ValidateNested()
  @Type(() => LandingReviewsDto)
  reviews?: LandingReviewsDto;
```

- [ ] **Step 2: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/tenants/dto/landing.dto.ts
git commit -m "feat(tenants): LandingReviewsDto (validate picked review ids)"
```

---

## Task 3: `findHomeReviews` + pure ordering helper

**Files:** Create `server/src/modules/reviews/home-reviews.ts` + `.spec.ts`; Modify `server/src/modules/reviews/reviews.service.ts`; Modify `server/src/modules/reviews/reviews.module.ts`

- [ ] **Step 1: Failing test for the pure helper** — `server/src/modules/reviews/home-reviews.spec.ts`:

```ts
import { orderReviewsByIds } from './home-reviews';

const row = (id: string) => ({ id, body: id });

describe('orderReviewsByIds', () => {
  it('returns rows in pick order, dropping ids with no matching row', () => {
    const rows = [row('b'), row('a'), row('c')];
    expect(orderReviewsByIds(['a', 'x', 'c'], rows).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('ignores rows whose id is not in ids', () => {
    const rows = [row('a'), row('z')];
    expect(orderReviewsByIds(['a'], rows).map((r) => r.id)).toEqual(['a']);
  });

  it('returns [] for empty ids', () => {
    expect(orderReviewsByIds([], [row('a')])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `cd server && npx jest src/modules/reviews/home-reviews.spec.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the helper** — `server/src/modules/reviews/home-reviews.ts`:

```ts
/** Order a set of fetched review rows by the farmer's pick order. Rows whose id
 *  is not in `ids` are dropped; ids with no matching row are skipped. Pure, so
 *  the DB query stays trivial and the ordering is unit-testable. */
export function orderReviewsByIds<T extends { id: string }>(ids: string[], rows: T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: T[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r) out.push(r);
  }
  return out;
}
```

- [ ] **Step 4: Run → pass**

Run: `cd server && npx jest src/modules/reviews/home-reviews.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add `findHomeReviews` to the service** — in `reviews.service.ts`:

Add `inArray` to the drizzle import:

```ts
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
```

Import the helper near the other imports:

```ts
import { orderReviewsByIds } from './home-reviews';
```

Add the method (after `findPublic`):

```ts
  /** Picked-for-home reviews: the tenant's PUBLISHED reviews whose ids the farmer
   *  selected in settings.landing.reviews, returned in pick order. Empty when the
   *  block is off or nothing is picked. */
  async findHomeReviews(slug: string): Promise<PublicReview[]> {
    const tenant = await this.publicCache.resolveTenant(this.db, slug);
    const cfg = tenant.landing.reviews;
    if (!cfg.show || cfg.ids.length === 0) return [];

    const rows = await this.db
      .select({
        id: reviews.id,
        authorName: reviews.authorName,
        authorLocation: reviews.authorLocation,
        rating: reviews.rating,
        body: reviews.body,
        createdAt: reviews.createdAt,
      })
      .from(reviews)
      .where(
        and(
          eq(reviews.tenantId, tenant.id),
          eq(reviews.status, 'published'),
          inArray(reviews.id, cfg.ids),
        ),
      );

    return orderReviewsByIds(cfg.ids, rows).map((r) => ({
      ...r,
      createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    }));
  }
```

- [ ] **Step 6: Export the service from its module** — in `reviews.module.ts` add `exports`:

```ts
@Module({
  controllers: [PublicReviewsController, ReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
```

- [ ] **Step 7: Typecheck + reviews suite**

Run: `cd server && npx tsc --noEmit && npx jest src/modules/reviews`
Expected: no type errors; reviews specs pass.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/reviews/home-reviews.ts server/src/modules/reviews/home-reviews.spec.ts server/src/modules/reviews/reviews.service.ts server/src/modules/reviews/reviews.module.ts
git commit -m "feat(reviews): findHomeReviews resolves picked ids to published reviews in order"
```

---

## Task 4: Deliver `homeReviews` via bootstrap

**Files:** Modify `server/src/modules/public-bootstrap/public-bootstrap.controller.ts` + `public-bootstrap.module.ts`

- [ ] **Step 1: Import + inject ReviewsService** — controller:

```ts
import { ReviewsService } from '../reviews/reviews.service';
```

Add to the constructor:

```ts
    private readonly subcategories: SubcategoriesService,
    private readonly reviews: ReviewsService,
  ) {}
```

- [ ] **Step 2: Add to the Promise.all + payload**

```ts
    const [storefront, products, farmers, subcategories, homeReviews] = await Promise.all([
      this.tenants.findPublicProfileBySlug(slug),
      this.products.findPublicBySlug(slug),
      this.farmers.findPublicBySlug(slug),
      this.subcategories.findPublicBySlug(slug),
      this.reviews.findHomeReviews(slug),
    ]);
    const productOfWeek = resolveProductOfWeek(storefront, products, new Date());
    return { storefront, products, farmers, subcategories, productOfWeek, homeReviews };
```

- [ ] **Step 3: Import ReviewsModule** — module:

```ts
import { ReviewsModule } from '../reviews/reviews.module';
```

```ts
  imports: [TenantsModule, ProductsModule, FarmersModule, SubcategoriesModule, ReviewsModule],
```

- [ ] **Step 4: Typecheck + full suite**

Run: `cd server && npx tsc --noEmit && npx jest`
Expected: no errors; all suites pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/public-bootstrap/
git commit -m "feat(public): bootstrap returns curated homeReviews"
```

---

## Task 5: Admin „Отзиви" picker row

**Files:** Modify `client/src/lib/api-client.ts`; Modify `client/src/components/settings/landing-card.tsx`

- [ ] **Step 1: Extend `LandingConfig`** — in `api-client.ts`, change the interface:

```ts
export interface LandingConfig {
  categories: LandingBlock;
  farmers: LandingBlock;
  latest: LandingBlock;
  reviews: { show: boolean; ids: string[] };
}
```

(`listReviews` already exists for the picker — no new endpoint.)

- [ ] **Step 2: Wire the picker into the card** — in `landing-card.tsx`:

Add imports:

```ts
import { ApiError, getLanding, updateLanding, getTenant, listReviews, type LandingConfig } from '@/lib/api-client';
import type { AdminReview } from '@/lib/types';
```

Add reviews state + load them alongside the rest. Replace the effect's `Promise.all`:

```ts
  const [pubReviews, setPubReviews] = React.useState<AdminReview[]>([]);

  React.useEffect(() => {
    let active = true;
    Promise.all([getLanding(), getTenant(), listReviews('published')])
      .then(([l, t, rv]) => {
        if (!active) return;
        setSaved(l.landing);
        setCfg(l.landing);
        setMultiFarmer(Boolean(t.multiFarmer));
        setPubReviews(rv.items);
      })
      .catch(() => active && toast.error('Неуспешно зареждане на настройките'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);
```

Add helpers (next to `setShow`/`setCount`):

```ts
  const MAX_REVIEW_PICKS = 12;
  const setReviewsShow = (show: boolean) =>
    setCfg((p) => (p ? { ...p, reviews: { ...p.reviews, show } } : p));
  const toggleReview = (id: string) =>
    setCfg((p) => {
      if (!p) return p;
      const ids = p.reviews.ids.includes(id)
        ? p.reviews.ids.filter((x) => x !== id)
        : p.reviews.ids.length < MAX_REVIEW_PICKS
          ? [...p.reviews.ids, id]
          : p.reviews.ids;
      return { ...p, reviews: { ...p.reviews, ids } };
    });
```

Render the row AFTER the `{ROWS.map(...)}` block (inside the same `flex flex-col gap-4` container, before its closing `</div>`):

```tsx
          {/* Reviews — pick specific published reviews */}
          <div className="rounded-xl border border-ff-border bg-ff-surface-2 px-[15px] py-3">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] font-extrabold text-ff-ink">Отзиви</div>
                <div className="mt-0.5 text-[12.5px] leading-snug text-ff-muted">
                  Избери кои отзиви на клиенти да се показват на началната страница.
                </div>
              </div>
              <ToggleSwitch checked={cfg.reviews.show} onChange={setReviewsShow} />
            </div>

            {cfg.reviews.show && (
              <div className="mt-3">
                {pubReviews.length === 0 ? (
                  <div className="text-[12.5px] text-ff-muted">
                    Няма публикувани отзиви за избор. Публикувай отзиви от „Отзиви“.
                  </div>
                ) : (
                  <>
                    <div className="mb-2 text-[12px] font-bold text-ff-ink-2">
                      Избрани: {cfg.reviews.ids.length}/{MAX_REVIEW_PICKS}
                    </div>
                    <div className="flex max-h-[280px] flex-col gap-1.5 overflow-y-auto">
                      {pubReviews.map((r) => {
                        const picked = cfg.reviews.ids.includes(r.id);
                        const atCap = !picked && cfg.reviews.ids.length >= MAX_REVIEW_PICKS;
                        return (
                          <label
                            key={r.id}
                            className={cn(
                              'flex cursor-pointer items-start gap-2.5 rounded-lg border border-ff-border bg-ff-surface px-3 py-2',
                              atCap && 'cursor-not-allowed opacity-45',
                            )}
                          >
                            <input
                              type="checkbox"
                              className="mt-1 shrink-0"
                              checked={picked}
                              disabled={atCap}
                              onChange={() => toggleReview(r.id)}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-[13px] font-bold text-ff-ink">
                                {'★'.repeat(r.rating)} · {r.authorName}
                                {r.authorLocation ? `, ${r.authorLocation}` : ''}
                              </div>
                              <div className="truncate text-[12.5px] text-ff-muted">{r.body}</div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
```

- [ ] **Step 3: Typecheck admin**

Run: `cd client && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/api-client.ts client/src/components/settings/landing-card.tsx
git commit -m "feat(admin): pick reviews for the home block in the Начална страница card"
```

---

## Task 6: chaika home reviews block

**Files:** Modify `fermerski-pazar-chaika/src/lib/types.ts`, `src/lib/api.ts`, `src/pages/index.astro`

- [ ] **Step 1: types** — in `src/lib/types.ts`:

Add `reviews` to `Storefront.landing` (after `latest`):

```ts
    latest: { show: boolean; count: number };
    reviews: { show: boolean; ids: string[] };
  };
```

Add to `Bootstrap`:

```ts
  productOfWeek?: { id: string; note: string | null } | null;
  /** Farmer-picked reviews for the home block, in pick order. Empty/absent when
   *  the block is off or nothing is picked. */
  homeReviews?: Review[];
}
```

- [ ] **Step 2: api** — in `src/lib/api.ts`:

Add to `FALLBACK_STOREFRONT.landing` (after `latest`):

```ts
    latest: { show: true, count: 4 },
    reviews: { show: false, ids: [] },
  },
```

In `getCatalog`, the bootstrap branch already returns `boot` (which carries `homeReviews`) — no change needed there. In the fallback (older-backend) branch, add `homeReviews: []` to the returned object:

```ts
    productOfWeek: null,
    homeReviews: [],
  };
```

- [ ] **Step 3: index.astro frontmatter** — after the landing config block, add:

```ts
const homeReviews = boot.homeReviews ?? [];
```

Update the inline `DEFAULT_LANDING` to include reviews:

```ts
const DEFAULT_LANDING = {
  categories: { show: true, count: 0 },
  farmers: { show: true, count: 3 },
  latest: { show: true, count: 4 },
  reviews: { show: false, ids: [] },
};
```

- [ ] **Step 4: index.astro reviews section** — insert AFTER the FEATURED PRODUCTS `</section>` (the `{L.latest.show && seeded && (…)}` block) and BEFORE the `<!-- HOW IT WORKS -->` section:

```astro
    <!-- CUSTOMER REVIEWS · farmer-picked -->
    {L.reviews.show && homeReviews.length > 0 && (
    <section class="section--tight">
      <div class="wrap">
        <div class="section-head center" style="margin-bottom:32px">
          <span class="eyebrow">Отзиви</span>
          <h2 style="margin-top:8px">Какво казват клиентите</h2>
        </div>
        <div class="grid grid--3">
          {homeReviews.map((r) => (
            <article class="card review-card">
              <div class="stars">{[0, 1, 2, 3, 4].map((i) => (
                <span style={`opacity:${i < r.rating ? 1 : 0.25}`}><Icon name="star" /></span>
              ))}</div>
              <p>„{r.body}”</p>
              <div class="who">
                <div class="ph avatar"></div>
                <div><b>{r.authorName}</b><span>{r.authorLocation || 'клиент'}</span></div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
    )}
```

(`Icon` is already imported in `index.astro`; `review-card`/`stars`/`who` styles already exist in `main.css`.)

- [ ] **Step 5: Typecheck chaika**

Run: `cd ../fermerski-pazar-chaika && npx astro check`
Expected: 0 errors.

- [ ] **Step 6: Commit (chaika repo)**

```bash
cd ../fermerski-pazar-chaika
git add src/lib/types.ts src/lib/api.ts src/pages/index.astro
git commit -m "feat: farmer-picked reviews block on the home page"
```

---

## Final verification

- [ ] Server: `cd server && npx tsc --noEmit && npx jest` → all green.
- [ ] Admin: `cd client && npx tsc --noEmit && npm run build` → builds.
- [ ] Chaika: `cd fermerski-pazar-chaika && npx astro check && npm run build` → builds.
- [ ] Live E2E (full stack): login → enable „Отзиви" + pick 2 published reviews → `GET /public/<slug>/bootstrap` returns `homeReviews` (2, in pick order) → chaika home renders 2 review cards in that order → toggle off → block gone. Verify a non-picked / pending review never renders.

## Notes

- No migration — `settings.landing` is existing jsonb; reviews are existing rows.
- Back-compat: reviews block defaults OFF, so existing homes are unchanged.
- Leave the unrelated reviews WIP (`reviews.controller.ts`, `review-list-query.dto.ts`) untouched and unstaged.
