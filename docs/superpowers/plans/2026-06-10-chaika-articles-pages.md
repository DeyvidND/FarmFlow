# Chaika Articles Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/articles` list page and `/articles/[slug]` detail page to `fermerski-pazar-chaika`, wired to the existing FarmFlow public articles API.

**Architecture:** Three small lib changes (types, api, nav) followed by two new Astro pages. No new framework — follows the same SSR + graceful-fallback pattern as the existing `reviews.astro` and `farmer/[id].astro` pages.

**Tech Stack:** Astro SSR, TypeScript, existing chaika CSS utilities (`.prose`, `.tag`, `.ph`, `.grid--3`, `.section--tight`, `.divider`)

**Working directory:** `C:/Users/Lenovo/source/repos/fermerski-pazar-chaika`

---

### Task 1: Add Article types to `types.ts`

**Files:**
- Modify: `src/lib/types.ts` (append at end)

- [ ] **Step 1: Add ArticleMedia and Article interfaces**

Append to `src/lib/types.ts`:

```typescript
export interface ArticleMedia {
  id: string;
  type: 'image' | 'video' | 'youtube' | 'instagram';
  url: string;
  embedId: string | null;
  caption: string | null;
  position: number;
}

export interface Article {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body: string | null;
  coverImageUrl: string | null;
  category: string | null;
  status: 'published' | 'draft';
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  media: ArticleMedia[];
}
```

- [ ] **Step 2: Commit**

```bash
git -C C:/Users/Lenovo/source/repos/fermerski-pazar-chaika add src/lib/types.ts
git -C C:/Users/Lenovo/source/repos/fermerski-pazar-chaika commit -m "feat(articles): add Article + ArticleMedia types"
```

---

### Task 2: Add date helper

**Files:**
- Create: `src/lib/dates.ts`

- [ ] **Step 1: Create `src/lib/dates.ts`**

```typescript
export function formatDateBg(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('bg-BG', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(iso));
}
```

- [ ] **Step 2: Commit**

```bash
git -C C:/Users/Lenovo/source/repos/fermerski-pazar-chaika add src/lib/dates.ts
git -C C:/Users/Lenovo/source/repos/fermerski-pazar-chaika commit -m "feat(articles): add formatDateBg date helper"
```

---

### Task 3: Add API functions to `api.ts`

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add Article import to the existing type import line**

In `src/lib/api.ts`, find the import line:
```typescript
import type {
  Storefront,
  Product,
  Farmer,
  Subcategory,
  Slot,
  ReviewSummary,
} from './types';
```

Replace with:
```typescript
import type {
  Storefront,
  Product,
  Farmer,
  Subcategory,
  Slot,
  ReviewSummary,
  Article,
} from './types';
```

- [ ] **Step 2: Add getArticles and getArticle after getReviews**

Find `export const getReviews = ...` line and add after it:

```typescript
export const getArticles = () =>
  get<Article[]>('/articles', []);

export const getArticle = (slug: string) =>
  get<Article | null>(`/articles/${encodeURIComponent(slug)}`, null, 0);
```

Note: `ttlMs = 0` on `getArticle` so individual article fetches always go to backend (detail pages are less hot than list, and slug may not exist).

- [ ] **Step 3: Commit**

```bash
git -C C:/Users/Lenovo/source/repos/fermerski-pazar-chaika add src/lib/api.ts
git -C C:/Users/Lenovo/source/repos/fermerski-pazar-chaika commit -m "feat(articles): add getArticles + getArticle API helpers"
```

---

### Task 4: Add Статии to nav

**Files:**
- Modify: `src/lib/nav.ts`

- [ ] **Step 1: Add nav link before Отзиви**

In `src/lib/nav.ts`, find the `navLinks` function and add `Статии` before `Отзиви`:

```typescript
export function navLinks(multiFarmer: boolean): NavLink[] {
  return [
    { label: 'Начало', href: '/' },
    ...(multiFarmer ? [{ label: 'Фермери', href: '/farmers' }] : []),
    { label: 'Магазин', href: '/shop' },
    { label: 'Поръчки', href: '/orders' },
    { label: 'За нас', href: '/about' },
    { label: 'Статии', href: '/articles' },
    { label: 'Отзиви', href: '/reviews' },
    { label: 'Контакти', href: '/contact' },
  ];
}
```

- [ ] **Step 2: Commit**

```bash
git -C C:/Users/Lenovo/source/repos/fermerski-pazar-chaika add src/lib/nav.ts
git -C C:/Users/Lenovo/source/repos/fermerski-pazar-chaika commit -m "feat(articles): add Статии to storefront nav"
```

---

### Task 5: Create articles list page

**Files:**
- Create: `src/pages/articles.astro`

- [ ] **Step 1: Create `src/pages/articles.astro`**

```astro
---
import Layout from '../components/Layout.astro';
import AdminNote from '../components/AdminNote.astro';
import { getStorefront, getArticles, FALLBACK_STOREFRONT } from '../lib/api';
import { formatDateBg } from '../lib/dates';

const [sfRaw, articles] = await Promise.all([getStorefront(), getArticles()]);
const sf = sfRaw ?? FALLBACK_STOREFRONT;
const featured = articles[0] ?? null;
const rest = articles.slice(1);
---
<Layout title={`Статии · ${sf.name}`} storefront={sf}>
  <main>
    <div class="wrap">
      <nav class="breadcrumb"><a href="/">Начало</a> / <span>Статии</span></nav>
    </div>

    <section class="section--tight">
      <div class="wrap">
        <div class="section-head">
          <span class="eyebrow">Статии</span>
          <h2 style="margin-top:8px">Новини и истории от фермата</h2>
          <p>Рецепти, съвети и истории зад продуктите.</p>
        </div>

        {articles.length === 0 && (
          <AdminNote text="Все още няма публикувани статии." />
        )}

        {featured && (
          <a
            href={`/articles/${featured.slug}`}
            class="card"
            style="display:grid;grid-template-columns:1.1fr 1fr;overflow:hidden;margin-bottom:26px;text-decoration:none"
          >
            {featured.coverImageUrl
              ? <img src={featured.coverImageUrl} alt={featured.title} style="width:100%;height:100%;min-height:280px;object-fit:cover" />
              : <div class="ph" style="min-height:280px;border-radius:0"></div>
            }
            <div style="padding:clamp(22px,3vw,40px);display:flex;flex-direction:column;justify-content:center">
              <span class="tag" style="align-self:flex-start">Препоръчано</span>
              <h3 style="font-size:clamp(24px,3vw,34px);margin:14px 0 12px">{featured.title}</h3>
              {featured.excerpt && <p class="muted">{featured.excerpt}</p>}
              {featured.publishedAt && (
                <div class="muted" style="font-size:13.5px;margin-top:16px">{formatDateBg(featured.publishedAt)}</div>
              )}
            </div>
          </a>
        )}

        {rest.length > 0 && (
          <div class="grid grid--3">
            {rest.map((a) => (
              <a href={`/articles/${a.slug}`} class="card" style="text-decoration:none">
                {a.coverImageUrl
                  ? <img src={a.coverImageUrl} alt={a.title} style="width:100%;aspect-ratio:16/10;object-fit:cover" />
                  : <div class="ph" style="aspect-ratio:16/10"></div>
                }
                <div style="padding:20px 20px 24px;display:flex;flex-direction:column;flex:1">
                  <h3 style="font-size:20px;margin:0 0 10px">{a.title}</h3>
                  {a.excerpt && <p class="muted" style="font-size:14.5px">{a.excerpt}</p>}
                  {a.publishedAt && (
                    <div class="muted" style="font-size:13px;margin-top:14px">{formatDateBg(a.publishedAt)}</div>
                  )}
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </section>
  </main>
</Layout>
```

- [ ] **Step 2: Commit**

```bash
git -C C:/Users/Lenovo/source/repos/fermerski-pazar-chaika add src/pages/articles.astro
git -C C:/Users/Lenovo/source/repos/fermerski-pazar-chaika commit -m "feat(articles): add /articles list page"
```

---

### Task 6: Create article detail page

**Files:**
- Create: `src/pages/articles/[slug].astro`

- [ ] **Step 1: Create directory and page**

Create `src/pages/articles/[slug].astro`:

```astro
---
import Layout from '../../components/Layout.astro';
import { getStorefront, getArticles, getArticle, FALLBACK_STOREFRONT } from '../../lib/api';
import { formatDateBg } from '../../lib/dates';
import { imageOrigin } from '../../lib/site';

const { slug } = Astro.params;

const [sfRaw, article, allArticles] = await Promise.all([
  getStorefront(),
  getArticle(slug!),
  getArticles(),
]);

if (!article) return Astro.redirect('/articles');

const sf = sfRaw ?? FALLBACK_STOREFRONT;
const related = allArticles.filter((a) => a.slug !== slug).slice(0, 3);
const coverOrigin = article.coverImageUrl ? imageOrigin(article.coverImageUrl) : null;
---
<Layout title={`${article.title} · ${sf.name}`} storefront={sf} imageOrigin={coverOrigin}>
  <article>
    <div class="wrap" style="max-width:820px">
      <nav class="breadcrumb">
        <a href="/">Начало</a> / <a href="/articles">Статии</a> / <span>{article.title}</span>
      </nav>
      <header style="margin:8px 0 26px">
        <h1 style="font-size:clamp(32px,5vw,56px);margin:14px 0 16px">{article.title}</h1>
        {article.publishedAt && (
          <div style="color:var(--muted);font-size:14.5px">{formatDateBg(article.publishedAt)}</div>
        )}
        {article.excerpt && <p class="lead" style="margin-top:12px">{article.excerpt}</p>}
      </header>
    </div>

    {article.coverImageUrl && (
      <div class="wrap" style="max-width:1000px;margin-bottom:36px">
        <img
          src={article.coverImageUrl}
          alt={article.title}
          style="width:100%;aspect-ratio:16/8;object-fit:cover;border-radius:var(--radius-lg)"
        />
      </div>
    )}

    {article.body && (
      <div class="wrap">
        <div class="prose">
          {article.body.split(/\n\n+/).map((para) => <p>{para}</p>)}
        </div>
      </div>
    )}

    {article.media.length > 0 && (
      <div class="wrap" style="max-width:820px;margin-top:32px">
        <div style="display:flex;flex-direction:column;gap:24px">
          {article.media.map((m) => (
            m.type === 'image' ? (
              <figure style="margin:0">
                <img src={m.url} alt={m.caption ?? ''} style="width:100%;border-radius:var(--radius)" />
                {m.caption && (
                  <figcaption style="font-size:13px;color:var(--muted);margin-top:8px;text-align:center">{m.caption}</figcaption>
                )}
              </figure>
            ) : m.type === 'video' ? (
              <figure style="margin:0">
                <video src={m.url} controls style="width:100%;border-radius:var(--radius)"></video>
                {m.caption && (
                  <figcaption style="font-size:13px;color:var(--muted);margin-top:8px;text-align:center">{m.caption}</figcaption>
                )}
              </figure>
            ) : (m.type === 'youtube' && m.embedId) ? (
              <figure style="margin:0">
                <div style="position:relative;aspect-ratio:16/9">
                  <iframe
                    src={`https://www.youtube.com/embed/${m.embedId}`}
                    title={m.caption ?? 'YouTube видео'}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowfullscreen
                    style="position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:var(--radius)"
                  ></iframe>
                </div>
                {m.caption && (
                  <figcaption style="font-size:13px;color:var(--muted);margin-top:8px;text-align:center">{m.caption}</figcaption>
                )}
              </figure>
            ) : m.type === 'instagram' ? (
              <a
                href={m.url}
                target="_blank"
                rel="noopener noreferrer"
                class="btn btn--ghost btn--sm"
                style="align-self:flex-start"
              >
                Виж в Instagram →
              </a>
            ) : null
          ))}
        </div>
      </div>
    )}

    <div class="wrap" style="max-width:820px">
      <hr class="divider" style="margin:36px 0 24px" />
      <a href="/articles" class="btn btn--ghost btn--sm">← Обратно към статиите</a>
    </div>
  </article>

  {related.length > 0 && (
    <section class="section--tight" style="margin-top:30px">
      <div class="wrap">
        <h2 style="font-size:26px;margin-bottom:22px">Прочети още</h2>
        <div class="grid grid--3">
          {related.map((a) => (
            <a href={`/articles/${a.slug}`} class="card" style="text-decoration:none">
              {a.coverImageUrl
                ? <img src={a.coverImageUrl} alt={a.title} style="width:100%;aspect-ratio:16/10;object-fit:cover" />
                : <div class="ph" style="aspect-ratio:16/10"></div>
              }
              <div style="padding:18px 18px 22px">
                <h3 style="font-size:19px;margin:0">{a.title}</h3>
                {a.publishedAt && (
                  <div class="muted" style="font-size:13px;margin-top:8px">{formatDateBg(a.publishedAt)}</div>
                )}
              </div>
            </a>
          ))}
        </div>
      </div>
    </section>
  )}
</Layout>
```

- [ ] **Step 2: Commit**

```bash
git -C C:/Users/Lenovo/source/repos/fermerski-pazar-chaika add src/pages/articles/
git -C C:/Users/Lenovo/source/repos/fermerski-pazar-chaika commit -m "feat(articles): add /articles/[slug] detail page"
```

---

## Self-review

- **types.ts** — `ArticleMedia` + `Article` interfaces cover all fields used in pages ✓
- **api.ts** — `getArticles` + `getArticle` use the correct paths `/articles` and `/articles/:slug`; `Article` imported ✓
- **nav.ts** — `Статии` inserted before `Отзиви` ✓
- **articles.astro** — imports `formatDateBg` from `./lib/dates`; AdminNote used with `text` prop ✓  
- **[slug].astro** — redirects to `/articles` when article is null; `getArticle` called with `ttlMs=0`; all four media types handled ✓
- No placeholders, all code complete ✓
