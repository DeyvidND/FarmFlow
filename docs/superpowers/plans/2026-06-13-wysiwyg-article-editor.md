# WYSIWYG Article Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plain-text article body with a Quill WYSIWYG editor supporting inline images (no video/embeds); body becomes server-sanitized HTML rendered identically in admin preview, the in-repo storefront, and chaika.

**Architecture:** `Article.body` shifts from plain text to sanitized HTML. The server sanitizes on write (authoritative, `sanitize-html`). Inline images upload to R2 via a new endpoint returning a URL embedded as `<img>`. All renderers run `bodyToHtml()` (HTML passthrough, or legacy plain-text → `<p>`) into a shared `.article-content` prose container. Legacy `articleMedia` rows still render below for old articles; new articles create none. R2 inline images are swept by prefix on article delete.

**Tech Stack:** NestJS + Drizzle (server), Next 14 / React 18 (client + storefront), Astro (chaika), Quill v2 via `react-quill-new`, `sanitize-html`, AWS S3 SDK (R2).

**Branch:** `feat/wysiwyg-articles` (already created off `main`).

---

## File Structure

**Server (`server/`)**
- `src/modules/articles/articles.util.ts` — add `sanitizeArticleHtml()`.
- `src/modules/articles/articles.util.spec.ts` — add sanitizer tests.
- `src/modules/articles/articles.service.ts` — sanitize body on create/update; add `addInlineImage()`; purge R2 prefix in `remove()`; delete dead media methods.
- `src/modules/articles/articles.controller.ts` — add `POST :id/images`; delete dead media routes.
- `src/modules/articles/dto/upload-media.dto.ts` — reuse cover consts for inline image.
- Delete: `dto/embed-media.dto.ts`, `dto/reorder-media.dto.ts`, `dto/update-media.dto.ts`.
- `src/modules/storage/storage.service.ts` — add abstract `deleteByPrefix()`.
- `src/modules/storage/providers/r2.provider.ts` — implement `deleteByPrefix()`.
- `src/modules/articles/articles.service.spec.ts` (or existing spec) — service tests.

**Client (`client/`)**
- `src/components/articles/article-body-editor.tsx` — NEW Quill editor.
- `src/components/articles/article-content.css` or `globals.css` — `.article-content` styles.
- `src/components/articles/article-editor.tsx` — swap textarea → editor; drop media panel.
- `src/components/articles/article-renderer.tsx` — render `bodyToHtml(body)` as HTML; legacy media stays.
- `src/lib/article-html.ts` — NEW `bodyToHtml()` helper (shared by editor preview + renderer).
- `src/lib/api-client.ts` — add `uploadArticleInlineImage`; remove dead media fns.
- `package.json` — add `react-quill-new`.

**Storefront (`storefront/`)**
- `src/lib/format.ts` — `readingMinutes` strips tags; add `bodyToHtml()`.
- `src/app/article/[slug]/page.tsx` — render HTML body; legacy media stays.
- `src/app/globals.css` — `.article-content` styles.

**chaika (`fermerski-pazar-chaika/`, separate repo)**
- `src/pages/articles/[slug].astro` — `set:html` body via helper; legacy media stays.
- `src/styles/main.css` — extend `.prose`.

---

## Task 1: Server — `sanitizeArticleHtml` (TDD)

**Files:**
- Modify: `server/src/modules/articles/articles.util.ts`
- Test: `server/src/modules/articles/articles.util.spec.ts`
- Modify: `server/package.json` (dep)

- [ ] **Step 1: Install sanitize-html**

Run:
```bash
cd server && npm i sanitize-html && npm i -D @types/sanitize-html
```
Expected: both added to `package.json`.

- [ ] **Step 2: Write failing tests**

Append to `server/src/modules/articles/articles.util.spec.ts` (add `sanitizeArticleHtml` to the existing import from `./articles.util`):

```ts
import { sanitizeArticleHtml } from './articles.util';

describe('sanitizeArticleHtml', () => {
  it('keeps allowed formatting tags', () => {
    const html = '<h2>Заглавие</h2><p><strong>bold</strong> <em>i</em> <u>u</u> <s>s</s></p><ul><li>a</li></ul>';
    expect(sanitizeArticleHtml(html)).toBe(html);
  });

  it('strips script tags and their content', () => {
    expect(sanitizeArticleHtml('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>');
  });

  it('strips event handlers', () => {
    expect(sanitizeArticleHtml('<p onclick="evil()">hi</p>')).toBe('<p>hi</p>');
  });

  it('drops javascript: and data: links', () => {
    expect(sanitizeArticleHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeArticleHtml('<a href="data:text/html,x">x</a>')).toBe('<a>x</a>');
  });

  it('keeps http/https/mailto links and forces rel+target', () => {
    const out = sanitizeArticleHtml('<a href="https://example.com">x</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it('keeps https images, drops data: images', () => {
    expect(sanitizeArticleHtml('<img src="https://cdn.x/y.jpg" alt="a">')).toContain('src="https://cdn.x/y.jpg"');
    expect(sanitizeArticleHtml('<img src="data:image/png;base64,AAAA">')).toBe('');
  });

  it('strips iframe and video', () => {
    expect(sanitizeArticleHtml('<iframe src="https://x"></iframe>')).toBe('');
    expect(sanitizeArticleHtml('<video src="https://x"></video>')).toBe('');
  });

  it('keeps allowed inline styles, drops others', () => {
    const out = sanitizeArticleHtml('<p style="text-align:center;color:#ff0000;position:fixed">x</p>');
    expect(out).toContain('text-align:center');
    expect(out).toContain('color:#ff0000');
    expect(out).not.toContain('position');
  });

  it('returns empty string for nullish/empty', () => {
    expect(sanitizeArticleHtml('')).toBe('');
    expect(sanitizeArticleHtml(null as unknown as string)).toBe('');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npx jest articles.util --runTestsByPath src/modules/articles/articles.util.spec.ts`
Expected: FAIL — `sanitizeArticleHtml is not a function`.

- [ ] **Step 4: Implement `sanitizeArticleHtml`**

Append to `server/src/modules/articles/articles.util.ts`:

```ts
import sanitizeHtml from 'sanitize-html';

/**
 * Sanitize WYSIWYG article HTML for safe storage + render. Allowlist matches the
 * Quill toolbar (bold/italic/underline/strike, h2/h3, color, align, lists, link,
 * inline image). Strips scripts, iframes, video, event handlers, and unsafe URLs.
 */
export function sanitizeArticleHtml(html: string): string {
  if (!html) return '';
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's',
      'h2', 'h3', 'ul', 'ol', 'li', 'a', 'img', 'span', 'blockquote',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt'],
      '*': ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['https'] },
    allowedStyles: {
      '*': {
        'text-align': [/^(left|center|right|justify)$/],
        color: [/^#(0x)?[0-9a-fA-F]+$/, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/],
      },
    },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
    },
    // Drop <img> with no surviving (https) src instead of leaving an empty tag.
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx jest --runTestsByPath src/modules/articles/articles.util.spec.ts`
Expected: PASS (all `sanitizeArticleHtml` cases).

> If `<img data:>` leaves a bare `<img>`, the `exclusiveFilter` removes it → `''`. If the `keeps allowed formatting tags` test fails on attribute ordering, adjust the expected string to sanitize-html's output (run once, copy actual). Keep assertions on `toContain` where exact serialization is brittle.

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json server/src/modules/articles/articles.util.ts server/src/modules/articles/articles.util.spec.ts
git commit -m "feat(articles): sanitizeArticleHtml allowlist sanitizer"
```

---

## Task 2: Server — sanitize body on create/update (TDD)

**Files:**
- Modify: `server/src/modules/articles/articles.service.ts:88-104` (create + update body handling)
- Modify: `server/src/modules/articles/dto/create-article.dto.ts` (Swagger desc only)
- Test: `server/src/modules/articles/articles.service.spec.ts` (create if absent)

- [ ] **Step 1: Write failing test**

If `articles.service.spec.ts` exists, add a case; else create a focused unit test that calls the sanitizer path. Minimal approach — assert the service sanitizes before persist by spying. If a full service spec is heavy, instead add an integration-style assertion in the existing e2e/spec. Pragmatic unit test (create file if missing):

```ts
// server/src/modules/articles/articles-sanitize.spec.ts
import { sanitizeArticleHtml } from './articles.util';

// Guard: the service must route body writes through the sanitizer. This test
// pins the contract the service relies on (script stripped) so a future refactor
// that bypasses sanitize is caught here + in the live E2E.
it('sanitizer strips script in body payloads', () => {
  expect(sanitizeArticleHtml('<p>ok</p><script>x</script>')).toBe('<p>ok</p>');
});
```

- [ ] **Step 2: Run it**

Run: `cd server && npx jest --runTestsByPath src/modules/articles/articles-sanitize.spec.ts`
Expected: PASS (sanitizer already exists from Task 1).

- [ ] **Step 3: Wire sanitizer into the service**

In `server/src/modules/articles/articles.service.ts`:

Import (top, with other util imports):
```ts
import { slugify, parseEmbed, sanitizeArticleHtml } from './articles.util';
```

In `create()`, change the `body` value:
```ts
        body: dto.body != null ? sanitizeArticleHtml(dto.body) : null,
```

In `update()`, change the body patch line:
```ts
    if (dto.body !== undefined) patch.body = dto.body == null ? null : sanitizeArticleHtml(dto.body);
```

- [ ] **Step 4: Update DTO Swagger description**

In `server/src/modules/articles/dto/create-article.dto.ts`, change the `body` `@ApiPropertyOptional`:
```ts
  @ApiPropertyOptional({ description: 'Sanitized HTML body (WYSIWYG)' })
```

- [ ] **Step 5: Run server build + article tests**

Run: `cd server && npx jest articles && npm run build`
Expected: PASS + build OK.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/articles/articles.service.ts server/src/modules/articles/dto/create-article.dto.ts server/src/modules/articles/articles-sanitize.spec.ts
git commit -m "feat(articles): sanitize HTML body on create/update"
```

---

## Task 3: Server — `deleteByPrefix` on StorageService (TDD)

**Files:**
- Modify: `server/src/modules/storage/storage.service.ts`
- Modify: `server/src/modules/storage/providers/r2.provider.ts`
- Test: `server/src/modules/storage/providers/r2.provider.spec.ts` (create)

- [ ] **Step 1: Add abstract method**

In `server/src/modules/storage/storage.service.ts`, add after `delete`:
```ts
  /** Delete every object under a key prefix (best-effort; no-op in stub mode). */
  abstract deleteByPrefix(prefix: string): Promise<void>;
```

- [ ] **Step 2: Write failing test**

Create `server/src/modules/storage/providers/r2.provider.spec.ts`:
```ts
import { ConfigService } from '@nestjs/config';
import { R2StorageProvider } from './r2.provider';

describe('R2StorageProvider.deleteByPrefix (stub mode)', () => {
  it('is a no-op when unconfigured', async () => {
    const provider = new R2StorageProvider(new ConfigService({}));
    await expect(provider.deleteByPrefix('tenants/x/articles/y/')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it**

Run: `cd server && npx jest --runTestsByPath src/modules/storage/providers/r2.provider.spec.ts`
Expected: FAIL — `deleteByPrefix is not a function`.

- [ ] **Step 4: Implement `deleteByPrefix`**

In `server/src/modules/storage/providers/r2.provider.ts`, extend the import:
```ts
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
```

Add method after `delete()`:
```ts
  async deleteByPrefix(prefix: string): Promise<void> {
    if (this.stubMode || !this.client) {
      this.logger.warn(`[stub] deleteByPrefix skipped for prefix=${prefix}`);
      return;
    }
    let token: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((k) => k.Key);
      if (keys.length) {
        // DeleteObjects caps at 1000 keys; ListObjectsV2 already pages at 1000.
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }),
        );
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  }
```

- [ ] **Step 5: Run test to verify pass**

Run: `cd server && npx jest --runTestsByPath src/modules/storage/providers/r2.provider.spec.ts`
Expected: PASS.

> If any other class extends `StorageService` (search `extends StorageService`), add a `deleteByPrefix` impl there too or TS build fails.

- [ ] **Step 6: Build + commit**

```bash
cd server && npm run build
git add server/src/modules/storage
git commit -m "feat(storage): deleteByPrefix for R2 prefix cleanup"
```

---

## Task 4: Server — inline image endpoint + R2 purge on remove (TDD)

**Files:**
- Modify: `server/src/modules/articles/articles.service.ts` (add `addInlineImage`, purge in `remove`)
- Modify: `server/src/modules/articles/articles.controller.ts` (add `POST :id/images`)

- [ ] **Step 1: Add service method**

In `articles.service.ts`, add after `uploadCover()`:
```ts
  async addInlineImage(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<{ url: string }> {
    await this.findOne(id, tenantId); // scope check (404 cross-tenant)
    const url = await this.store(tenantId, id, 'inline', file);
    return { url };
  }
```

Change `store()`'s `kind` param to accept `'inline'`:
```ts
  private async store(
    tenantId: string,
    articleId: string,
    kind: 'cover' | 'media' | 'inline',
    file: Express.Multer.File,
  ): Promise<string> {
```

- [ ] **Step 2: Purge R2 prefix on remove**

In `remove()`, after the existing cover delete block and before the DB deletes, add:
```ts
    // Sweep inline images (no per-row tracking) by wiping the article's R2 prefix.
    await this.storage.deleteByPrefix(`tenants/${tenantId}/articles/${id}/`);
```

- [ ] **Step 3: Add controller route**

In `articles.controller.ts`, import cover consts already present. Add route after `uploadCover` (before any `:id/media` routes are removed in Task 5):
```ts
  @Post(':id/images')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadArticleMediaDto })
  @UseInterceptors(FileInterceptor('file'))
  addInlineImage(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new FileTypeValidator({ fileType: ARTICLE_COVER_MIME_REGEX }),
          new MaxFileSizeValidator({ maxSize: ARTICLE_COVER_MAX_BYTES }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.articlesService.addInlineImage(id, tenantId, file);
  }
```

- [ ] **Step 4: Verify remove() calls deleteByPrefix (test)**

Add to `r2.provider.spec.ts` sibling OR a service spec a behavioral check. Minimal: append to `articles-sanitize.spec.ts`:
```ts
import { ArticlesService } from './articles.service';

it('remove() sweeps the article R2 prefix', async () => {
  const deleteByPrefix = jest.fn().mockResolvedValue(undefined);
  const storage = { delete: jest.fn(), deleteByPrefix } as any;
  const cache = { invalidate: jest.fn() } as any;
  const article = { id: 'a1', tenantId: 't1', coverImageUrl: null, media: [] };
  const db = {
    delete: () => ({ where: () => Promise.resolve() }),
  } as any;
  const svc = new ArticlesService(db, storage, cache, {} as any);
  jest.spyOn(svc, 'findOne').mockResolvedValue(article as any);
  await svc.remove('a1', 't1');
  expect(deleteByPrefix).toHaveBeenCalledWith('tenants/t1/articles/a1/');
});
```

- [ ] **Step 5: Run + build**

Run: `cd server && npx jest articles && npm run build`
Expected: PASS + build OK.

> If the `db.delete().where()` chain shape differs and the mock throws, simplify by asserting only `deleteByPrefix` is wired via a lighter mock, or move this assertion into the live E2E. Don't block on mock fidelity.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/articles
git commit -m "feat(articles): inline image upload endpoint + R2 prefix purge on delete"
```

---

## Task 5: Server — drop dead media routes/methods/DTOs

**Files:**
- Modify: `server/src/modules/articles/articles.controller.ts`
- Modify: `server/src/modules/articles/articles.service.ts`
- Delete: `dto/embed-media.dto.ts`, `dto/reorder-media.dto.ts`, `dto/update-media.dto.ts`

- [ ] **Step 1: Remove controller routes**

In `articles.controller.ts` delete the methods: `addMedia` (`POST :id/media`), `addEmbed` (`POST :id/media/embed`), `reorderMedia` (`PATCH :id/media/reorder`), `updateMedia` (`PATCH :id/media/:mediaId`), `removeMedia` (`DELETE :id/media/:mediaId`). Remove now-unused imports: `EmbedMediaDto`, `ReorderMediaDto`, `UpdateMediaDto`, `ARTICLE_MEDIA_MIME_REGEX`, `ARTICLE_MEDIA_MAX_BYTES`. Keep `Patch`, `Delete` (still used by article update/remove).

- [ ] **Step 2: Remove service methods**

In `articles.service.ts` delete: `addMedia`, `addEmbed`, `removeMedia`, `updateMedia`, `reorderMedia`, and the now-unused private `nextPosition`. Remove unused imports: `parseEmbed` (if only used by addEmbed), `EmbedMediaDto`, `ReorderMediaDto`, `articleMediaTypeForMime`, `ARTICLE_MEDIA_EXT_BY_MIME` only if unused — note `ARTICLE_MEDIA_EXT_BY_MIME` is still used by `store()`; keep it. Keep `articleMedia` import (used by `remove`, `attachMedia`, public read).

> `store()` still uses `ARTICLE_MEDIA_EXT_BY_MIME[file.mimetype]`. Inline + cover are images covered by that map. Keep the map import.

- [ ] **Step 3: Delete DTO files**

```bash
git rm server/src/modules/articles/dto/embed-media.dto.ts server/src/modules/articles/dto/reorder-media.dto.ts server/src/modules/articles/dto/update-media.dto.ts
```

- [ ] **Step 4: Fix broken tests/imports**

Run: `cd server && npm run build`
Fix any compile errors (unused imports, specs referencing removed methods). Search + remove:
```bash
rg -l "addEmbed|reorderMedia|updateMedia|removeMedia|addMedia|embed-media.dto|reorder-media.dto|update-media.dto" server/src
```
Update or delete those test cases.

- [ ] **Step 5: Run full server suite**

Run: `cd server && npx jest && npm run build`
Expected: PASS + build OK.

- [ ] **Step 6: Commit**

```bash
git add -A server/src/modules/articles
git commit -m "refactor(articles): drop video/embed media routes (image-only inline)"
```

---

## Task 6: Client — `bodyToHtml` helper (TDD)

**Files:**
- Create: `client/src/lib/article-html.ts`
- Test: `client/src/lib/article-html.spec.ts` (or `.test.ts` per repo convention — check existing client tests)

- [ ] **Step 1: Check client test convention**

Run: `rg -l "describe\(" client/src --glob '*.spec.ts' --glob '*.test.ts' | head`
Use whichever suffix the repo uses. (Assume `.spec.ts` below; adjust if needed.)

- [ ] **Step 2: Write failing tests**

Create `client/src/lib/article-html.spec.ts`:
```ts
import { bodyToHtml } from './article-html';

describe('bodyToHtml', () => {
  it('passes through HTML bodies unchanged', () => {
    expect(bodyToHtml('<p>hi</p>')).toBe('<p>hi</p>');
  });
  it('wraps legacy plain text paragraphs', () => {
    expect(bodyToHtml('a\n\nb')).toBe('<p>a</p><p>b</p>');
  });
  it('escapes legacy plain text', () => {
    expect(bodyToHtml('a < b & c')).toBe('<p>a &lt; b &amp; c</p>');
  });
  it('returns empty string for nullish', () => {
    expect(bodyToHtml(null)).toBe('');
    expect(bodyToHtml('')).toBe('');
  });
});
```

- [ ] **Step 3: Run to fail**

Run: `cd client && npx jest --runTestsByPath src/lib/article-html.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `client/src/lib/article-html.ts`:
```ts
/**
 * Normalize an article body to render-ready HTML.
 *  - New bodies are already sanitized HTML (contain tags) → passthrough.
 *  - Legacy bodies are plain text → escape + split blank lines into <p>.
 * Kept tiny + dependency-free so the storefront + chaika can mirror it.
 */
export function bodyToHtml(body: string | null | undefined): string {
  if (!body) return '';
  if (/<[a-z][\s\S]*>/i.test(body)) return body; // already HTML
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('');
}
```

- [ ] **Step 5: Run to pass**

Run: `cd client && npx jest --runTestsByPath src/lib/article-html.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/article-html.ts client/src/lib/article-html.spec.ts
git commit -m "feat(articles): bodyToHtml helper (HTML passthrough + legacy plain-text)"
```

---

## Task 7: Client — Quill editor component

**Files:**
- Modify: `client/package.json` (dep)
- Create: `client/src/components/articles/article-body-editor.tsx`

- [ ] **Step 1: Install react-quill-new**

Run: `cd client && npm i react-quill-new`
Expected: added to deps (pulls Quill v2).

- [ ] **Step 2: Create the editor component**

Create `client/src/components/articles/article-body-editor.tsx`:
```tsx
'use client';

import { useMemo, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import type ReactQuillType from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import { uploadArticleInlineImage } from '@/lib/api-client';
import { toast } from 'sonner';

// Quill touches `window` → never SSR it.
const ReactQuill = dynamic(() => import('react-quill-new'), { ssr: false });

// One-time global Quill patches: safe links + inline-style alignment.
// Guarded so Fast Refresh / repeated imports don't double-register.
let patched = false;
async function ensureQuillPatches() {
  if (patched) return;
  patched = true;
  const Quill = (await import('react-quill-new')).default.Quill;
  const Link: any = Quill.import('formats/link');
  const orig = Link.sanitize.bind(Link);
  const SAFE = ['http:', 'https:', 'mailto:'];
  Link.sanitize = (url: string) => {
    try {
      const u = new URL(url, window.location.href);
      return SAFE.includes(u.protocol) ? orig(url) : 'about:blank';
    } catch {
      return 'about:blank';
    }
  };
  // Alignment as inline style (text-align) → portable HTML, no ql-align CSS dep.
  const AlignStyle: any = Quill.import('attributors/style/align');
  Quill.register(AlignStyle, true);
}

const TOOLBAR = [
  ['bold', 'italic', 'underline', 'strike'],
  [{ header: 2 }, { header: 3 }],
  [{ color: [] }],
  [{ align: '' }, { align: 'center' }, { align: 'right' }],
  [{ list: 'ordered' }, { list: 'bullet' }],
  ['link', 'image'],
  ['clean'],
];

const FORMATS = [
  'bold', 'italic', 'underline', 'strike',
  'header', 'color', 'align', 'list', 'link', 'image',
];

export function ArticleBodyEditor({
  articleId,
  value,
  onChange,
}: {
  articleId: string;
  value: string;
  onChange: (html: string) => void;
}) {
  const quillRef = useRef<ReactQuillType | null>(null);

  void ensureQuillPatches();

  const imageHandler = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const { url } = await uploadArticleInlineImage(articleId, file);
        const editor = quillRef.current?.getEditor();
        const range = editor?.getSelection(true);
        editor?.insertEmbed(range ? range.index : 0, 'image', url, 'user');
        editor?.setSelection((range ? range.index : 0) + 1, 0);
      } catch {
        toast.error('Неуспешно качване на снимка');
      }
    };
    input.click();
  }, [articleId]);

  const modules = useMemo(
    () => ({ toolbar: { container: TOOLBAR, handlers: { image: imageHandler } } }),
    [imageHandler],
  );

  return (
    <div className="article-editor-quill">
      <ReactQuill
        forwardedRef={quillRef as never}
        theme="snow"
        value={value}
        onChange={onChange}
        modules={modules}
        formats={FORMATS}
        placeholder="Текст на статията…"
      />
    </div>
  );
}
```

> `react-quill-new` exposes the Quill class via the default export's `.Quill`. If `forwardedRef` typing complains, use the documented `ref` prop name for the installed version — check `node_modules/react-quill-new` README quickly. The editor must end up with a working `getEditor()`.

- [ ] **Step 3: Typecheck**

Run: `cd client && npx tsc --noEmit`
Expected: no errors in this file (api-client fn added in Task 8 — do Task 8 before final typecheck, or stub the import temporarily; see ordering note).

> **Ordering:** Task 8 adds `uploadArticleInlineImage`. Either do Task 8 step 1 first, or accept a transient unresolved import until Task 8. Commit this task together with Task 8 if needed.

- [ ] **Step 4: Commit**

```bash
git add client/package.json client/package-lock.json client/src/components/articles/article-body-editor.tsx
git commit -m "feat(articles): Quill WYSIWYG body editor component"
```

---

## Task 8: Client — api-client (add inline image, drop dead fns)

**Files:**
- Modify: `client/src/lib/api-client.ts:343-377`

- [ ] **Step 1: Add inline image fn, remove dead media fns**

In `client/src/lib/api-client.ts`, after `uploadArticleCover` add:
```ts
export function uploadArticleInlineImage(id: string, file: File) {
  const fd = new FormData();
  fd.append('file', file);
  return apiFetch<{ url: string }>(`articles/${id}/images`, { method: 'POST', body: fd }, 'Неуспешно качване');
}
```

Delete: `uploadArticleMedia`, `addArticleEmbed`, `updateArticleMedia`, `deleteArticleMedia`, `reorderArticleMedia`.

- [ ] **Step 2: Find + fix remaining references**

Run: `rg -n "uploadArticleMedia|addArticleEmbed|updateArticleMedia|deleteArticleMedia|reorderArticleMedia" client/src`
Expected: only `article-editor.tsx` (fixed in Task 9). No others.

- [ ] **Step 3: Typecheck (defer full pass to Task 9)**

`article-editor.tsx` still imports the deleted fns until Task 9 → expected transient error. Proceed to Task 9 before typechecking.

- [ ] **Step 4: Commit (with Task 7)**

```bash
git add client/src/lib/api-client.ts
git commit -m "feat(articles): api-client inline image upload; drop media/embed fns"
```

---

## Task 9: Client — rewrite editor screen + renderer + CSS

**Files:**
- Modify: `client/src/components/articles/article-editor.tsx`
- Modify: `client/src/components/articles/article-renderer.tsx`
- Modify: `client/src/app/globals.css`

- [ ] **Step 1: Add `.article-content` + Quill height CSS**

Append to `client/src/app/globals.css`:
```css
/* Rendered article HTML (preview + storefront contract). */
.article-content { color: var(--ff-ink, #1a1a1a); line-height: 1.7; font-size: 15.5px; }
.article-content p { margin: 0 0 16px; }
.article-content h2 { font-size: 22px; font-weight: 800; margin: 26px 0 12px; }
.article-content h3 { font-size: 18px; font-weight: 800; margin: 22px 0 10px; }
.article-content ul, .article-content ol { margin: 0 0 16px; padding-left: 22px; }
.article-content li { margin: 4px 0; }
.article-content a { color: var(--ff-green-600, #1f7a44); text-decoration: underline; }
.article-content img { max-width: 100%; height: auto; border-radius: 12px; margin: 12px 0; }
.article-content blockquote { margin: 16px 0; padding-left: 14px; border-left: 3px solid var(--ff-border, #e5e5e5); color: var(--ff-muted, #666); }

/* Quill editor surface tweaks. */
.article-editor-quill .ql-container { min-height: 320px; font-size: 15.5px; border-bottom-left-radius: 8px; border-bottom-right-radius: 8px; }
.article-editor-quill .ql-toolbar { border-top-left-radius: 8px; border-top-right-radius: 8px; }
```

- [ ] **Step 2: Rewrite `article-editor.tsx`**

Replace the file with the version below — swaps the body textarea for `ArticleBodyEditor`, removes the entire Медия section + embed state + media handlers, keeps cover/title/excerpt/publish/save/delete:
```tsx
'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Save, ImagePlus, Trash2, Eye, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ArticleRenderer } from './article-renderer';
import { ArticleStatusBadge } from './articles-client';
import { ArticleBodyEditor } from './article-body-editor';
import { cn } from '@/lib/utils';
import { ApiError, updateArticle, deleteArticle, uploadArticleCover } from '@/lib/api-client';
import type { Article } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

export function ArticleEditor({ initial }: { initial: Article }) {
  const router = useRouter();
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');

  const [title, setTitle] = useState(initial.title);
  const [excerpt, setExcerpt] = useState(initial.excerpt ?? '');
  const [body, setBody] = useState(initial.body ?? '');
  const [coverImageUrl, setCoverImageUrl] = useState(initial.coverImageUrl);
  const [status, setStatus] = useState<Article['status']>(initial.status);
  const [publishedAt, setPublishedAt] = useState(initial.publishedAt);

  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const coverRef = useRef<HTMLInputElement>(null);

  const preview: Article = {
    ...initial,
    title,
    excerpt: excerpt || null,
    body: body || null,
    coverImageUrl,
    status,
    publishedAt,
    media: initial.media, // legacy media still previews
  };

  async function onSave() {
    setSaving(true);
    try {
      const updated = await updateArticle(initial.id, {
        title: title.trim() || 'Без заглавие',
        excerpt,
        body,
      });
      setTitle(updated.title);
      setBody(updated.body ?? ''); // reflect server-sanitized HTML
      toast.success('Статията е запазена');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  async function onTogglePublish(on: boolean) {
    const prev = status;
    setStatus(on ? 'published' : 'draft');
    try {
      const updated = await updateArticle(initial.id, { status: on ? 'published' : 'draft' });
      setStatus(updated.status);
      setPublishedAt(updated.publishedAt);
      toast.success(on ? 'Статията е публикувана' : 'Статията е върната в чернова');
    } catch (e) {
      setStatus(prev);
      toast.error(errMsg(e));
    }
  }

  async function onCover(file: File) {
    setBusy(true);
    try {
      const updated = await uploadArticleCover(initial.id, file);
      setCoverImageUrl(updated.coverImageUrl);
      toast.success('Корицата е качена');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteArticle() {
    if (!window.confirm('Изтриване на статията?')) return;
    setBusy(true);
    try {
      await deleteArticle(initial.id);
      toast.success('Статията е изтрита');
      router.push('/articles');
    } catch (e) {
      toast.error(errMsg(e));
      setBusy(false);
    }
  }

  return (
    <div className="animate-ff-fade-up">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={() => router.push('/articles')}
          className="inline-flex items-center gap-1.5 text-[13.5px] font-bold text-ff-muted hover:text-ff-ink"
        >
          <ArrowLeft size={16} /> Статии
        </button>
        <div className="flex items-center gap-3">
          <ArticleStatusBadge status={status} />
          <div className="flex items-center gap-2 text-[13px] font-bold text-ff-ink-2">
            Публикувана
            <ToggleSwitch checked={status === 'published'} onChange={onTogglePublish} />
          </div>
          <Button variant="primary" onClick={onSave} disabled={saving} className="rounded-sm">
            <Save size={16} /> {saving ? 'Запазване…' : 'Запази'}
          </Button>
        </div>
      </div>

      <div className="mb-5 inline-flex rounded-[10px] border border-ff-border bg-ff-surface-2 p-1">
        <TabBtn on={tab === 'edit'} onClick={() => setTab('edit')} Icon={Pencil} label="Редактор" />
        <TabBtn on={tab === 'preview'} onClick={() => setTab('preview')} Icon={Eye} label="Преглед" />
      </div>

      {tab === 'preview' ? (
        <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm max-sm:p-4">
          <ArticleRenderer article={preview} />
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_340px] gap-5 max-lg:grid-cols-1">
          <div className="flex flex-col gap-4">
            <label className={labelCls}>
              Заглавие
              <input value={title} onChange={(e) => setTitle(e.target.value)} className={cn(field, 'text-[17px] font-bold')} placeholder="Заглавие на статията" />
            </label>
            <label className={labelCls}>
              Кратко описание
              <textarea value={excerpt} onChange={(e) => setExcerpt(e.target.value)} rows={2} className={field} placeholder="Едно-две изречения за изданието/новината" />
            </label>
            <div className={labelCls}>
              Съдържание
              <ArticleBodyEditor articleId={initial.id} value={body} onChange={setBody} />
            </div>
          </div>

          <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-2">
              <h3 className="text-[12.5px] font-bold text-ff-ink-2">Корица</h3>
              <input ref={coverRef} type="file" accept="image/jpeg,image/png,image/webp" hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onCover(f); e.target.value = ''; }} />
              <button onClick={() => coverRef.current?.click()}
                className="relative grid h-[150px] w-full place-items-center overflow-hidden rounded-xl border border-ff-border-2 bg-ff-surface-2 text-ff-muted transition hover:border-ff-green-500">
                {coverImageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={coverImageUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="inline-flex flex-col items-center gap-1 text-[12.5px] font-semibold">
                    <ImagePlus size={22} /> {busy ? 'качване…' : 'Качи корица'}
                  </span>
                )}
              </button>
            </section>

            <button onClick={onDeleteArticle} disabled={busy}
              className="mt-2 inline-flex items-center justify-center gap-1.5 rounded-sm border border-ff-border px-3 py-2 text-[13px] font-bold text-ff-red transition hover:bg-ff-red/10 disabled:opacity-50">
              <Trash2 size={15} /> Изтрий статията
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TabBtn({ on, onClick, Icon, label }: { on: boolean; onClick: () => void; Icon: typeof Eye; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[7px] px-3.5 py-1.5 text-[13.5px] font-bold transition',
        on ? 'bg-ff-surface text-ff-ink shadow-ff-sm' : 'text-ff-muted hover:text-ff-ink',
      )}
    >
      <Icon size={15} /> {label}
    </button>
  );
}
```

- [ ] **Step 3: Update `article-renderer.tsx` body block**

Replace the `paragraphs`/body block. Change the import line at top to add the helper:
```tsx
import { bodyToHtml } from '@/lib/article-html';
```
Replace the `const paragraphs = ...` computation and the `{paragraphs.length > 0 && (...)}` JSX with:
```tsx
  const html = bodyToHtml(article.body);
```
and in the JSX (where the paragraphs block was):
```tsx
      {html && (
        <div
          className="article-content mt-5"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
```
Keep the existing `{article.media.length > 0 && (...)}` legacy media block and `MediaBlock`/`Frame`/`Caption` unchanged.

- [ ] **Step 4: Typecheck + build**

Run: `cd client && npx tsc --noEmit && npm run build`
Expected: no errors. (Build compiles Quill dynamic import fine.)

> If `npm run build` errors on `document` from Quill, confirm the dynamic import uses `{ ssr: false }` and the component is `'use client'`. The CSS import `quill.snow.css` is build-safe.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/articles/article-editor.tsx client/src/components/articles/article-renderer.tsx client/src/app/globals.css
git commit -m "feat(articles): WYSIWYG editor screen + HTML renderer + article-content CSS"
```

---

## Task 10: In-repo storefront — render HTML body

**Files:**
- Modify: `storefront/src/lib/format.ts`
- Modify: `storefront/src/app/article/[slug]/page.tsx`
- Modify: `storefront/src/app/globals.css`

- [ ] **Step 1: Add `bodyToHtml` + strip tags in reading time**

In `storefront/src/lib/format.ts`, change `readingMinutes` to strip tags, and add `bodyToHtml`:
```ts
export function readingMinutes(body: string | null | undefined): number {
  const text = (body ?? '').replace(/<[^>]*>/g, ' ');
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/** Body → render-ready HTML (HTML passthrough; legacy plain text → <p>). */
export function bodyToHtml(body: string | null | undefined): string {
  if (!body) return '';
  if (/<[a-z][\s\S]*>/i.test(body)) return body;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('');
}
```
Keep `paragraphs` (may be unused now — remove its import in the page).

- [ ] **Step 2: Render HTML in the article page**

In `storefront/src/app/article/[slug]/page.tsx`:
- change import: `import { formatDate, readingTime, bodyToHtml } from '@/lib/format';`
- replace the body block:
```tsx
            {paragraphs(article.body).map((p, i) => (
              ...
            ))}
```
with:
```tsx
            <div
              className="article-content"
              dangerouslySetInnerHTML={{ __html: bodyToHtml(article.body) }}
            />
```
Keep the legacy `media.map((m) => <ArticleMedia .../>)` block unchanged (renders legacy rows).

- [ ] **Step 3: Add `.article-content` CSS**

Append to `storefront/src/app/globals.css` (use storefront token vars):
```css
.article-content { font-size: 17px; line-height: 1.7; color: var(--ink, #1a1a1a); }
.article-content p { margin: 0 0 18px; }
.article-content h2 { font-size: 26px; font-weight: 800; margin: 30px 0 14px; }
.article-content h3 { font-size: 20px; font-weight: 800; margin: 24px 0 12px; }
.article-content ul, .article-content ol { margin: 0 0 18px; padding-left: 24px; }
.article-content li { margin: 6px 0; }
.article-content a { color: var(--brand, #1f7a44); text-decoration: underline; }
.article-content img { max-width: 100%; height: auto; border-radius: var(--radius, 12px); margin: 14px 0; }
.article-content blockquote { margin: 18px 0; padding-left: 16px; border-left: 3px solid var(--line, #e5e5e5); color: var(--muted, #666); }
```

- [ ] **Step 4: Build**

Run: `cd storefront && npm run build`
Expected: PASS. (Fix unused `paragraphs` import if lint/TS strict flags it.)

- [ ] **Step 5: Commit**

```bash
git add storefront/src/lib/format.ts storefront/src/app/article storefront/src/app/globals.css
git commit -m "feat(articles): storefront renders sanitized HTML body"
```

---

## Task 11: chaika — render HTML body (separate repo)

**Files (in `C:\Users\Lenovo\source\repos\fermerski-pazar-chaika`):**
- Modify: `src/pages/articles/[slug].astro`
- Modify: `src/styles/main.css`
- Create: `src/lib/article-html.ts`

> chaika is its own git repo. Commit there separately (not in the FarmFlow branch).

- [ ] **Step 1: Add helper**

Create `fermerski-pazar-chaika/src/lib/article-html.ts`:
```ts
export function bodyToHtml(body: string | null | undefined): string {
  if (!body) return '';
  if (/<[a-z][\s\S]*>/i.test(body)) return body;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return body.split(/\n\n+/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('');
}
```

- [ ] **Step 2: Render via `set:html`**

In `src/pages/articles/[slug].astro`, add to the frontmatter import block:
```ts
import { bodyToHtml } from '../../lib/article-html';
```
Replace the body block:
```astro
    {article.body && (
      <div class="wrap">
        <div class="prose">
          {article.body.split(/\n\n+/).map((para) => <p>{para}</p>)}
        </div>
      </div>
    )}
```
with:
```astro
    {article.body && (
      <div class="wrap">
        <div class="prose article-content" set:html={bodyToHtml(article.body)} />
      </div>
    )}
```
Keep the `article.media.length > 0` legacy block unchanged.

- [ ] **Step 3: Extend `.prose` CSS**

In `src/styles/main.css`, after the existing `.prose` rules add:
```css
.prose h3 { font-size: 22px; margin: 28px 0 12px; }
.prose ul, .prose ol { margin: 0 0 22px; padding-left: 24px; }
.prose li { font-size: 18px; line-height: 1.7; color: var(--ink-soft); margin: 6px 0; }
.prose a { color: var(--brand); text-decoration: underline; }
.prose img { max-width: 100%; height: auto; border-radius: var(--radius); margin: 18px 0; }
.prose blockquote { margin: 22px 0; padding-left: 16px; border-left: 3px solid var(--line); color: var(--muted); }
.prose [style*="text-align"] { display: block; }
```

- [ ] **Step 4: Build**

Run: `cd /c/Users/Lenovo/source/repos/fermerski-pazar-chaika && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit (in chaika repo)**

```bash
cd /c/Users/Lenovo/source/repos/fermerski-pazar-chaika
git add src/lib/article-html.ts src/pages/articles/[slug].astro src/styles/main.css
git commit -m "feat(articles): render sanitized HTML article body"
```

---

## Task 12: Full verification + live E2E

- [ ] **Step 1: Server + client + storefront green**

Run:
```bash
cd server && npx jest && npm run build
cd ../client && npx jest && npx tsc --noEmit && npm run build
cd ../storefront && npm run build
```
Expected: all PASS. (Run sequentially — parallel jest+build on this machine causes FS flakes, per project gotcha.)

- [ ] **Step 2: Live E2E — author flow**

Start the stack (per project dev workflow, server port 5433 etc.). Log in as a farmer, go to Статии → open/create an article:
- type text, apply bold, an H2, a bullet list, a colored word, center-align a paragraph;
- click the image button, upload a JPG → confirm it appears inline;
- add a link `https://example.com` → confirm it's clickable;
- Save → reload the editor → confirm formatting + inline image persisted (server-sanitized HTML round-trips).

- [ ] **Step 3: Live E2E — sanitization**

With devtools, PATCH the article body to include `<script>alert(1)</script>` and `<img src=x onerror=alert(1)>` (or paste into editor). Save, then GET the article → confirm `<script>` and `onerror` are gone in the stored body.

- [ ] **Step 4: Live E2E — storefront render**

Publish the article. Open the in-repo storefront article page (and chaika if running) → confirm the HTML renders with correct headings/lists/alignment/inline image, no raw tags, and a legacy article (with old media rows + plain-text body) still renders its paragraphs + media below.

- [ ] **Step 5: Final commit / branch status**

```bash
cd /c/Users/Lenovo/source/repos/FarmFlow
git status
git log --oneline main..HEAD
```
Confirm a clean, logically-ordered set of commits on `feat/wysiwyg-articles`. chaika has its own commit in its own repo.

---

## Self-Review Notes

- **Spec coverage:** editor (T7,T9) · inline images (T4,T7,T8) · sanitize on write (T1,T2) · 3 renderers (T9,T10,T11) · legacy compat (T6 `bodyToHtml`, renderers keep legacy media) · R2 cleanup (T3,T4) · drop dead routes/keep image (T5) · chaika (T11) · tests/E2E (all + T12).
- **Type consistency:** `bodyToHtml(body): string` identical signature in client/storefront/chaika. `uploadArticleInlineImage(id,file): Promise<{url}>` matches endpoint `{ url }`. `addInlineImage` service returns `{ url }`. `deleteByPrefix(prefix): Promise<void>` abstract + impl match.
- **Risk:** `react-quill-new` ref/Quill-import API may differ slightly by version — T7 notes verifying `getEditor()`/ref prop against the installed README. Everything else is deterministic.
