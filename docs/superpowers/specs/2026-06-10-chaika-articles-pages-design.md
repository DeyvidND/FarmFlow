# Chaika Articles Pages

**Repo:** fermerski-pazar-chaika  
**Date:** 2026-06-10

## Goal

Wire the existing FarmFlow public articles API to the chaika storefront: list page + detail page + nav link.

## API

- `GET /public/:slug/articles` → `PublicArticle[]` (published only, ordered by publishedAt desc)
- `GET /public/:slug/articles/:articleSlug` → `PublicArticle`

## Article shape

Fields used by the storefront:
- `id`, `slug`, `title`, `excerpt`, `body`, `coverImageUrl`, `publishedAt`
- `media[]` — each: `id`, `type` (image/video/youtube/instagram), `url`, `embedId`, `caption`, `position`

## Changes

### `src/lib/types.ts`
Add `ArticleMedia` and `Article` interfaces.

### `src/lib/api.ts`
Add `getArticles()` → `Article[]` (fallback `[]`) and `getArticle(slug)` → `Article | null`.

### `src/lib/nav.ts`
Add `{ label: 'Статии', href: '/articles' }` before Отзиви.

### `src/pages/articles.astro` — list page
- Breadcrumb: Начало / Статии
- Section header: eyebrow "Статии", h2, lead text
- If articles exist: first article → featured card (cover left, meta right, like templates blog.astro) + `grid--3` for the rest
- Each card: cover image (16/10 aspect, or `.ph` placeholder), title, excerpt, date
- If empty: AdminNote-style empty state
- No category filter tabs

### `src/pages/articles/[slug].astro` — detail page
- SSR: fetch article by slug, 404→redirect `/articles`
- Breadcrumb: Начало / Статии / title
- Header: `<h1>`, date eyebrow, excerpt lead
- Cover image (16/8 aspect, or `.ph` placeholder)
- `.prose` body (pre-wrap paragraphs split on `\n\n`)
- Media section after body: images → `<img>`, video → `<video>`, youtube → `<iframe>` embed, instagram → link/embed
- "← Обратно към статиите" link at bottom
- "Прочети още" section: up to 3 other articles from `getArticles()` (exclude current)

## Design source
Follows templates `src/pages/blog.astro` + `src/pages/article/[slug].astro` adapted for real API data and chaika CSS classes.
