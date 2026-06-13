# WYSIWYG Article Editor (Quill) — Design

**Date:** 2026-06-13
**Branch:** `feat/wysiwyg-articles` (off `main`)
**Goal:** Replace the plain-text article body with a Quill rich-text (WYSIWYG) editor that supports inline images, modelled on the Hogan repo's editor. No video, no YouTube/Instagram embeds.

## Background

Today the farmer article editor (`client/src/components/articles/article-editor.tsx`) has:

- a plain `<textarea>` body — rendered by splitting on blank lines into `<p>` paragraphs;
- a separate "Медия" side panel that uploads images/video and adds YouTube/Instagram embeds as `articleMedia` rows, rendered **below** the body;
- a cover image uploader (`articles.coverImageUrl` column).

The Hogan platform (`hogan-assessments-platform`) uses a Quill-based WYSIWYG editor that emits an HTML string, sanitized server-side, with inline images. We want the same experience for FarmFlow articles, scoped down to: **inline images only, no video, no embeds.**

## Decisions (locked with user)

- **Engine:** Quill v2 via `react-quill-new` (React-18 safe; matches Hogan's engine).
- **Media:** body becomes WYSIWYG HTML with **inline images**. Drop video uploads, YouTube, and Instagram entirely. Cover image stays.
- **Toolbar:** bold · italic · underline · strike · H2/H3 · color · align(L/C/R) · list(ordered/bullet) · link · image · clean. (No font-size widget, no video, no document.)
- **Old media routes:** keep only the image-upload path (a new inline-image endpoint). Drop `addEmbed` (YT/IG), the video path, `updateMedia`, `reorderMedia`, `removeMedia`. Keep the `articleMedia` table + public read so legacy articles still render.
- **chaika:** apply the matching storefront render change in `fermerski-pazar-chaika` in the same effort (after FarmFlow lands).

## Contract

`Article.body` changes meaning from "plain text / markdown" to **sanitized HTML**. The HTML is sanitized **on write** (authoritative) and rendered as-is by every renderer. Inline images are `<img src="{R2 url}">` embedded in that HTML. Legacy plain-text bodies and legacy `articleMedia` rows keep rendering (no data loss).

## Components

### 1. Editor — `client/src/components/articles/article-body-editor.tsx` (new)

- `react-quill-new`, loaded through `next/dynamic` with `ssr: false` (Quill touches `window`).
- One-time module registration (guarded for repeated import):
  - **Safe link** — override `formats/link` sanitize to allow only `http:`/`https:`/`mailto:`, else `about:blank` (ported from Hogan `registerSafeLink`).
  - **Inline-style align** — register `attributors/style/align` so alignment serializes as `style="text-align:center"` rather than `ql-align-center` classes. Makes the HTML portable to storefronts with no Quill CSS dependency.
- Toolbar container = the locked set above. Custom `image` handler:
  1. open a hidden file input (image mimes only);
  2. `POST /articles/:id/images` (multipart);
  3. on `{ url }`, `quill.insertEmbed(cursorIndex, 'image', url, 'user')`.
- `formats` whitelist limited to the toolbar's formats (prevents pasted junk formats surviving).
- Emits HTML via `onChange(html)`. Props: `{ articleId, value, onChange }`.
- Exposes the rendered content styling through the shared `.article-content` class (see §2) so the editor surface matches the public render.

### 2. Rendering — one contract, three renderers

Shared prose container class **`.article-content`** with CSS for `h2,h3,p,ul,ol,li,a,img,strong,em,u,s,blockquote` and honoring inline `text-align` / `color`. Defined once per app (Tailwind layer / global CSS) in: admin client, in-repo storefront, chaika.

- **`bodyToHtml(body)` helper** (client + storefront + chaika, small pure fn):
  - if `body` contains a `<` tag → already HTML → return as-is;
  - else legacy plain text → HTML-escape, split on blank lines, wrap each block in `<p>` (preserving the current paragraph behavior).
- **Admin preview** (`article-renderer.tsx`): render `bodyToHtml(body)` via `dangerouslySetInnerHTML` inside `.article-content`. Keep the legacy "media-below" block, but render it **only when `media.length > 0`** (legacy articles); new articles have none.
- **In-repo storefront** (`storefront/src/app/article/[slug]/page.tsx`): same — replace the `paragraphs(body).map(...)` block with `.article-content` + `dangerouslySetInnerHTML`. Keep `ArticleMedia` mapping for legacy rows only. `readingTime` strips tags first.
- **chaika** (`fermerski-pazar-chaika/src/pages/articles/[slug].astro`): `<div class="article-content" set:html={bodyToHtml(body)} />`; keep legacy media loop; add `.article-content` CSS.

Because body is sanitized on write, renderers trust the stored HTML. (Optional future hardening: client-side DOMPurify — not in scope; only authenticated farmers write and the server sanitizes.)

### 3. Backend

- **Sanitizer** — add `sanitize-html`. New `sanitizeArticleHtml(html)` in `articles.util.ts`:
  - allowed tags: `p, br, strong, b, em, i, u, s, h2, h3, ul, ol, li, a, img, span, blockquote`;
  - `a`: `href` (http/https/mailto only) + forced `rel="noopener noreferrer"` `target="_blank"`;
  - `img`: `src` (https only) + `alt`;
  - allowed styles: `text-align` ∈ {left,center,right}, `color` (hex / rgb);
  - everything else stripped — `script`, `iframe`, `video`, `on*` handlers, `javascript:` / `data:` URLs.
  - Called in `ArticlesService.create` and `.update` whenever `body` is provided (store the sanitized string).
- **Inline image upload** — `POST /articles/:id/images` (multipart, single `file`, image mimes via existing `articleMediaTypeForMime` guard restricted to image). Pipeline: scope-check article → `optimizeImage` → R2 key `tenants/{tenantId}/articles/{articleId}/inline/{uuid}.{ext}` → return `{ url }`. **No DB row.**
- **R2 cleanup** — add `deleteByPrefix(prefix)` to `StorageService` (abstract) + `R2StorageProvider` impl (S3 `ListObjectsV2Command` paginated → `DeleteObjectsCommand` in ≤1000 batches; no-op when client is null). In `ArticlesService.remove`, after the existing per-row + cover deletes, call `deleteByPrefix('tenants/{tenantId}/articles/{articleId}/')` to sweep inline images (best-effort, must not block the DB delete).
- **Drop routes** — remove from controller + service + client api-client: `addMedia` (old image/video), `addEmbed`, `updateMedia`, `reorderMedia`, `removeMedia`, and their DTOs (`embed-media.dto`, `reorder-media.dto`, media-update bits). Keep: `uploadCover`, public reads, the new `POST /:id/images`. Keep `articleMedia` table + `toPublicArticle` media mapping (legacy render). No DB migration.
- **DTO** — `body` stays `string`; update Swagger description to "Sanitized HTML".

### 4. Client glue

- `article-editor.tsx`: swap body `<textarea>` → `<ArticleBodyEditor articleId={initial.id} value={body} onChange={setBody} />`. Delete the entire "Медия" `<section>` (uploads/embeds/reorder/captions) + `embedUrl` state + media handlers. Keep cover section, title, excerpt, publish toggle, Save, delete-article.
- `api-client.ts`: remove `uploadArticleMedia`, `addArticleEmbed`, `updateArticleMedia`, `deleteArticleMedia`, `reorderArticleMedia`. Add `uploadArticleInlineImage(id, file): Promise<{ url }>`. Keep `uploadArticleCover`, `updateArticle`, etc.
- `articles-client.tsx` list: the media-count chip (`a.media.length`) stays valid for legacy; for new articles it shows 0 — drop the chip or leave it. Decision: leave it (harmless).

## Testing

- **server unit:** `sanitizeArticleHtml` — strips `<script>`, `<iframe>`, `onerror=`, `javascript:` href, `data:` img; keeps `<h2>`, `<strong>`, allowed `text-align`/`color`, `mailto:` links, https img. `bodyToHtml` legacy paths. Image-upload route rejects non-image mime. `remove()` calls `deleteByPrefix` with the article prefix (mock storage).
- **fix:** any existing article spec referencing the removed routes.
- **builds:** server + client + storefront typecheck/build green.
- **live E2E:** create article → format text (bold/H2/list/link/color/align) → insert inline image → publish → load storefront article page → assert HTML renders, alignment/color applied, and an injected `<script>`/`onerror` is stripped.

## Out of scope / follow-ups

- Client-side DOMPurify defense-in-depth (server sanitize is authoritative).
- Migrating legacy plain-text bodies to HTML in the DB (handled at render via `bodyToHtml`; no migration).
- Re-introducing video/embeds.

## chaika (separate repo, same effort)

After FarmFlow merges/verifies: in `fermerski-pazar-chaika`, update `src/pages/articles/[slug].astro` to render `bodyToHtml(body)` via `set:html` in `.article-content`, keep the legacy media loop, add `.article-content` CSS. Its own commit in that repo.
