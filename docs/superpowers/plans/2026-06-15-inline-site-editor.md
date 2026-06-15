# Inline Site Editor (v3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v2 admin iframe editor with a WYSIWYG "edit on your live site" flow: admin „Редактирай сайта" button → opens the farm's storefront in an edit mode (short-lived scoped token) → click any text/photo to edit in place → one save.

**Architecture:** A short-lived, separate-secret `site-edit` JWT (issued to the authenticated farmer, scoped to their tenant) authorizes a small set of `site-edit/*` API routes. A vanilla-TS overlay (no new deps — chaika is pure Astro) loads on the storefront only with `?edit=<token>`, makes `[data-editable-slot]` elements inline-editable, and saves via those routes. The storefront slot registry + slot-agnostic copy/media/faq store are reused unchanged. The site URL is set by the super-admin at provisioning.

**Tech Stack:** NestJS + Drizzle + @nestjs/jwt (server), Astro vanilla TS (storefront, **no new deps**), Next.js (tenant admin `client/` + super-admin `admin/`), Jest.

**Repos (absolute):**
- FarmFlow API + tenant admin + super-admin: `C:\Users\Lenovo\source\repos\FarmFlow` (branch `feat/inline-site-editor` checked out). Sub-apps: `server/`, `client/` (tenant admin), `admin/` (super-admin), `storefront/` (a Next storefront — NOT the one edited here).
- chaika storefront (edited): `C:\Users\Lenovo\source\repos\fermerski-pazar-chaika` (create branch `feat/inline-site-editor`).

**Spec:** `docs/superpowers/specs/2026-06-15-inline-site-editor-design.md`. Supersedes the v2 iframe editor (`ed6b7c8`). No DB migration; slot keys preserved.

**Established patterns to follow:**
- Derived secret (no new env): `resetSecret()` = `` `${JWT_SECRET}::pwreset` `` (`auth.service.ts:259`). Edit token uses `` `${JWT_SECRET}::siteedit` ``.
- Short-lived purpose JWT: `jwt.signAsync({...}, { secret, expiresIn })` (`auth.service.ts:163`).
- Atomic per-path `jsonb_set` + `publicCache.del(publicCacheKeys.tenant(slug))` after settings writes (`tenants.service.ts`).
- Path-aware CORS already echoes any `CORS_ORIGIN`-listed origin with `Authorization` allowed (`main.ts:88`) — **adding the storefront origin to `CORS_ORIGIN` is the whole CORS change (config, no code).**
- `sanitizeSiteUrl` exists in `tenants/site-copy.ts` (http(s)-only).
- Run jest/builds sequentially (FS flakes). After pulling main, `pnpm install` + rebuild db/types dist.
- Windows/PowerShell: chain with `;` (or Bash tool); quote `(admin)`/`(panel)` paths.

---

## File Structure

**server/src:**
- Create `common/guards/edit-session.guard.ts` — verifies the `site-edit` token → `req.tenantId`.
- Create `modules/tenants/dto/site-edit-content.dto.ts` — `{ copy, faq }` (reuses a FaqItemDto).
- Create `modules/tenants/site-edit.controller.ts` — `GET data`, `PATCH content`, `POST/DELETE media/:slotKey` (EditSessionGuard).
- Modify `modules/tenants/tenants.service.ts` — add `editSecret()`, `createEditSession()`, `getSiteEditData()`, `setSiteCopyContent()`; remove the v2 `getSiteCopy`/`setSiteCopy` (siteUrl no longer here).
- Modify `modules/tenants/tenants.controller.ts` — add `POST me/edit-session` (admin JWT); remove `GET/PATCH me/site-copy`.
- Modify `modules/tenants/tenants.module.ts` — register `SiteEditController`.
- Delete `modules/tenants/dto/site-copy.dto.ts` (replaced).
- Modify `modules/platform/dto/update-tenant.dto.ts` + `platform.service.ts` — accept + persist `siteUrl`.
- Tests: `edit-session.guard.spec.ts`, additions to a tenants service spec, platform siteUrl test.

**chaika src:**
- Create `scripts/edit-overlay.ts` — the overlay (vanilla TS).
- Modify `components/Layout.astro` — drop the v2 preview listener; gate-load the overlay on `?edit=`.
- Modify `middleware.ts` — drop the `?preview=1` framing branch (back to always DENY); `no-store` when `?edit=`.
- Modify `pages/faq.astro` — add `data-faq-index` / `data-faq-field` markers for inline FAQ editing.

**client/src (tenant admin):**
- Replace `app/(admin)/site-media/page.tsx` — launch-button screen.
- Delete `app/(admin)/site-media/site-editor.tsx`, `preview-pane.tsx`.
- Modify `lib/api-client.ts` — add `createEditSession()`; remove v2 site-copy/manifest exports.

**admin/src (super-admin):**
- Modify `lib/api-client.ts` — `updateTenant` payload gains `siteUrl`.
- Modify `components/tenant-detail-client.tsx` — „Адрес на сайта" field.

---

## Task 1: Server — edit secret, edit-session, EditSessionGuard

**Files:**
- Modify: `server/src/modules/tenants/tenants.service.ts`
- Modify: `server/src/modules/tenants/tenants.controller.ts`
- Create: `server/src/common/guards/edit-session.guard.ts`
- Test: `server/src/common/guards/edit-session.guard.spec.ts`

- [ ] **Step 1: Add `editSecret` + `createEditSession` to the service**

In `tenants.service.ts`: ensure `JwtService` + `ConfigService` are injected (check the constructor — `MapsService`, `PublicCacheService`, `StorageService`, `StripeService` are there; ADD `private readonly jwt: JwtService` and `private readonly config: ConfigService` if absent, and import `{ JwtService } from '@nestjs/jwt'`, `{ ConfigService } from '@nestjs/config'`). The `JwtModule` is exported by `AuthModule`; ensure `TenantsModule` imports `AuthModule` (it likely does for guards — verify in Task 3).

Add methods (near the site-copy methods):

```ts
  /** Edit-session tokens use a derived secret so they can't be replayed as auth
   *  tokens (mirrors auth.service resetSecret). */
  private editSecret(): string {
    return `${this.config.getOrThrow<string>('JWT_SECRET')}::siteedit`;
  }

  /** Issue a short-lived, tenant-scoped token for the storefront edit overlay.
   *  Returns the token + the farm's storefront URL (set by the operator). */
  async createEditSession(
    tenantId: string,
  ): Promise<{ token: string; siteUrl: string; expiresIn: number }> {
    const { settings } = await this.loadTenantForMedia(tenantId);
    const siteUrl = sanitizeSiteUrl(settings.siteUrl);
    if (!siteUrl) {
      throw new BadRequestException('Адресът на сайта не е зададен. Свържи се с поддръжката.');
    }
    const token = await this.jwt.signAsync(
      { sub: tenantId, type: 'site-edit' },
      { secret: this.editSecret(), expiresIn: '30m' },
    );
    return { token, siteUrl, expiresIn: 1800 };
  }
```

(Ensure `sanitizeSiteUrl` is imported from `./site-copy` — it already is from the v2 work.)

- [ ] **Step 2: Add `POST me/edit-session` to the controller**

In `tenants.controller.ts`:

```ts
  @ApiOperation({ summary: 'Issue a short-lived token to edit the storefront inline' })
  @Roles('admin')
  @Post('me/edit-session')
  createEditSession(@CurrentTenant() tenantId: string) {
    return this.tenantsService.createEditSession(tenantId);
  }
```

- [ ] **Step 3: Create the guard**

```ts
// server/src/common/guards/edit-session.guard.ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

/**
 * Authorizes the storefront inline-edit overlay. Accepts ONLY a `site-edit`
 * token (separate derived secret, short-lived, tenant-scoped). Sets
 * req.tenantId. This token authenticates nothing else — only the routes that
 * use THIS guard. Mirrors the reset-token isolation.
 */
@Injectable()
export class EditSessionGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ headers: { authorization?: string }; tenantId?: string }>();
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) throw new UnauthorizedException('Липсва edit токен');
    let payload: { sub?: string; type?: string };
    try {
      payload = await this.jwt.verifyAsync(auth.slice(7), {
        secret: `${this.config.getOrThrow<string>('JWT_SECRET')}::siteedit`,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Невалиден или изтекъл edit токен');
    }
    if (payload.type !== 'site-edit' || !payload.sub) {
      throw new UnauthorizedException('Невалиден edit токен');
    }
    req.tenantId = payload.sub;
    return true;
  }
}
```

- [ ] **Step 4: Write the guard spec**

```ts
// server/src/common/guards/edit-session.guard.spec.ts
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EditSessionGuard } from './edit-session.guard';

const JWT = 'x'.repeat(40);
const config = { getOrThrow: () => JWT } as unknown as ConfigService;
const jwt = new JwtService({ secret: JWT, signOptions: { algorithm: 'HS256' } });
const guard = new EditSessionGuard(jwt, config);

function ctxWith(authHeader?: string) {
  const req: any = { headers: authHeader ? { authorization: authHeader } : {} };
  return { switchToHttp: () => ({ getRequest: () => req }), _req: req } as any;
}

describe('EditSessionGuard', () => {
  const sign = (claims: object, opts: object = {}) =>
    jwt.sign(claims, { secret: `${JWT}::siteedit`, ...opts });

  it('accepts a valid site-edit token and sets tenantId', async () => {
    const ctx = ctxWith(`Bearer ${sign({ sub: 't1', type: 'site-edit' })}`);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(ctx._req.tenantId).toBe('t1');
  });
  it('rejects a normal tenant JWT (wrong secret + type)', async () => {
    const normal = jwt.sign({ sub: 'u1', type: 'tenant' }); // main secret, not ::siteedit
    await expect(guard.canActivate(ctxWith(`Bearer ${normal}`))).rejects.toThrow(UnauthorizedException);
  });
  it('rejects wrong type even with the edit secret', async () => {
    await expect(guard.canActivate(ctxWith(`Bearer ${sign({ sub: 't1', type: 'reset' })}`))).rejects.toThrow();
  });
  it('rejects missing/expired token', async () => {
    await expect(guard.canActivate(ctxWith(undefined))).rejects.toThrow(UnauthorizedException);
    const expired = sign({ sub: 't1', type: 'site-edit' }, { expiresIn: '-1s' });
    await expect(guard.canActivate(ctxWith(`Bearer ${expired}`))).rejects.toThrow();
  });
});
```

- [ ] **Step 5: Run guard spec + commit**

Run: `cd server; npx jest edit-session.guard --runInBand` → PASS.
```bash
git switch -c feat/inline-site-editor 2>/dev/null || git switch feat/inline-site-editor
git add server/src/common/guards/edit-session.guard.ts server/src/common/guards/edit-session.guard.spec.ts server/src/modules/tenants/tenants.service.ts server/src/modules/tenants/tenants.controller.ts
git commit -m "feat(tenants): edit-session token + EditSessionGuard"
```

---

## Task 2: Server — content writer + edit data, remove v2 admin site-copy

**Files:**
- Create: `server/src/modules/tenants/dto/site-edit-content.dto.ts`
- Modify: `server/src/modules/tenants/tenants.service.ts`
- Modify: `server/src/modules/tenants/tenants.controller.ts`
- Delete: `server/src/modules/tenants/dto/site-copy.dto.ts`

- [ ] **Step 1: Create the content DTO**

```ts
// server/src/modules/tenants/dto/site-edit-content.dto.ts
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsObject, IsString, MaxLength, ValidateNested } from 'class-validator';

export class FaqItemDto {
  @IsString() @MaxLength(300) q: string;
  @IsString() @MaxLength(4000) a: string;
}

export class SiteEditContentDto {
  @IsObject() copy: Record<string, string>;
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => FaqItemDto) faq: FaqItemDto[];
}
```

- [ ] **Step 2: Service — add `getSiteEditData` + `setSiteCopyContent`; remove v2 `getSiteCopy`/`setSiteCopy`**

In `tenants.service.ts` replace the v2 `getSiteCopy` + `setSiteCopy` methods with:

```ts
  /** Current overrides for the inline editor (no siteUrl — operator-managed). */
  async getSiteEditData(tenantId: string): Promise<{
    copy: Record<string, string>;
    media: Record<string, { url: string }>;
    faq: PublicFaqItem[];
  }> {
    const settings = await this.loadSettings(tenantId);
    return {
      copy: buildPublicCopy(settings.copy),
      media: toPublicMedia(settings.media),
      faq: buildPublicFaq(settings.faq),
    };
  }

  /** Write copy + faq (slot content only) atomically; siteUrl untouched. */
  async setSiteCopyContent(
    tenantId: string,
    dto: SiteEditContentDto,
  ): Promise<{ copy: Record<string, string>; faq: PublicFaqItem[] }> {
    const { slug } = await this.loadTenantForMedia(tenantId);
    const copy = cleanCopy(dto.copy);
    const faq = normalizeFaq(dto.faq);
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(
          jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['copy'], ${JSON.stringify(copy)}::jsonb, true),
          array['faq'], ${JSON.stringify(faq)}::jsonb, true)`,
      })
      .where(eq(tenants.id, tenantId));
    await this.publicCache.del(publicCacheKeys.tenant(slug));
    return { copy, faq };
  }
```

Update imports: drop `SiteCopyDto`; add `import { SiteEditContentDto } from './dto/site-edit-content.dto';`. Keep `buildPublicCopy, buildPublicFaq, cleanCopy, normalizeFaq, sanitizeSiteUrl, isValidSlotKey, PublicFaqItem` from `./site-copy`. `toPublicMedia` stays.

- [ ] **Step 3: Controller — remove `GET/PATCH me/site-copy`**

In `tenants.controller.ts` delete the `getSiteCopy`/`updateSiteCopy` handlers and the `SiteCopyDto` import. (Keep `POST me/edit-session` from Task 1 and the `POST`/`DELETE me/media/:slotKey` upload handlers.)

- [ ] **Step 4: Delete the old DTO + build**

```bash
git rm server/src/modules/tenants/dto/site-copy.dto.ts
```
Run: `cd server; npx tsc --noEmit` → 0 errors (fix any reference to the removed methods/DTO — e.g. the v2 `public-cache.service.ts` does NOT import these, but double-check; the admin `client` references are handled in Task 8).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/tenants
git commit -m "feat(tenants): setSiteCopyContent + getSiteEditData; drop v2 admin site-copy"
```

---

## Task 3: Server — site-edit controller + module wiring

**Files:**
- Create: `server/src/modules/tenants/site-edit.controller.ts`
- Modify: `server/src/modules/tenants/tenants.module.ts`

- [ ] **Step 1: Create the controller (EditSessionGuard, not JwtAuthGuard)**

```ts
// server/src/modules/tenants/site-edit.controller.ts
import {
  Controller, Get, Patch, Post, Delete, Body, Param, UseGuards, Req,
  UploadedFile, UseInterceptors, ParseFilePipe, FileTypeValidator, MaxFileSizeValidator,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { TenantsService } from './tenants.service';
import { EditSessionGuard } from '../../common/guards/edit-session.guard';
import { SiteEditContentDto } from './dto/site-edit-content.dto';
import { UploadImageDto, PRODUCT_IMAGE_MIME_REGEX, PRODUCT_IMAGE_MAX_BYTES } from '../storage/dto/upload-image.dto';

/** Storefront inline-edit overlay endpoints. Authorized by a short-lived
 *  site-edit token (EditSessionGuard sets req.tenantId) — NOT the admin JWT. */
@ApiTags('site-edit')
@UseGuards(EditSessionGuard)
@Controller('tenants/me/site-edit')
export class SiteEditController {
  constructor(private readonly tenants: TenantsService) {}

  @ApiOperation({ summary: 'Current overrides (copy/media/faq) for the overlay' })
  @Get('data')
  data(@Req() req: { tenantId: string }) {
    return this.tenants.getSiteEditData(req.tenantId);
  }

  @ApiOperation({ summary: 'Save edited copy + FAQ' })
  @Patch('content')
  content(@Req() req: { tenantId: string }, @Body() dto: SiteEditContentDto) {
    return this.tenants.setSiteCopyContent(req.tenantId, dto);
  }

  @ApiOperation({ summary: 'Upload/replace a slot photo' })
  @Post('media/:slotKey')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadImageDto })
  @UseInterceptors(FileInterceptor('image'))
  upload(
    @Req() req: { tenantId: string },
    @Param('slotKey') slotKey: string,
    @UploadedFile(new ParseFilePipe({ validators: [
      new FileTypeValidator({ fileType: PRODUCT_IMAGE_MIME_REGEX }),
      new MaxFileSizeValidator({ maxSize: PRODUCT_IMAGE_MAX_BYTES }),
    ] })) file: Express.Multer.File,
  ) {
    return this.tenants.setSiteMedia(req.tenantId, slotKey, file);
  }

  @ApiOperation({ summary: 'Remove a slot photo' })
  @Delete('media/:slotKey')
  remove(@Req() req: { tenantId: string }, @Param('slotKey') slotKey: string) {
    return this.tenants.deleteSiteMedia(req.tenantId, slotKey);
  }
}
```

> NOTE: `setSiteMedia`/`deleteSiteMedia` take `(tenantId, slotKey, file?)` — they validate the slot key via `isValidSlotKey` (v2) and need no admin context. Confirm their signatures match; they do.

- [ ] **Step 2: Register the controller + EditSessionGuard**

In `tenants.module.ts`: add `SiteEditController` to `controllers`, and `EditSessionGuard` to `providers`. Ensure `AuthModule` (exports `JwtModule`) is imported so `JwtService` is injectable into both the guard and `TenantsService` (Task 1). If `TenantsModule` doesn't already import `AuthModule`, add it (watch for a circular import — `AuthModule` doesn't import `TenantsModule`, so this is safe).

- [ ] **Step 3: Build + commit**

Run: `cd server; npx tsc --noEmit` → 0 errors.
```bash
git add server/src/modules/tenants/site-edit.controller.ts server/src/modules/tenants/tenants.module.ts
git commit -m "feat(tenants): site-edit controller (overlay endpoints, edit-token guarded)"
```

---

## Task 4: Server — provisioning siteUrl (super-admin)

**Files:**
- Modify: `server/src/modules/platform/dto/update-tenant.dto.ts`
- Modify: `server/src/modules/platform/platform.service.ts`
- Test: add to the platform service spec.

- [ ] **Step 1: DTO — add siteUrl**

In `update-tenant.dto.ts` add (with `IsOptional`/`IsString` already imported):
```ts
  @ApiPropertyOptional({ example: 'https://pazarchaika.farmsteadflow.com', description: 'Адрес на онлайн магазина (за бутона „Редактирай сайта")' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  siteUrl?: string;
```
(Add `MaxLength` to the class-validator import.)

- [ ] **Step 2: Service — persist siteUrl into settings.siteUrl**

In `platform.service.ts` `updateTenant`, after the flat `patch` write block (before/after the cache-bust), add a settings write when `dto.siteUrl !== undefined`:

```ts
    if (dto.siteUrl !== undefined) {
      const siteUrl = sanitizeSiteUrl(dto.siteUrl);
      await this.db
        .update(tenants)
        .set({ settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['siteUrl'], ${JSON.stringify(siteUrl)}::jsonb, true)` })
        .where(eq(tenants.id, id));
      await this.publicCache.del(publicCacheKeys.tenant(existing.slug));
    }
```

Add imports: `import { sql } from 'drizzle-orm';` (likely already present) and `import { sanitizeSiteUrl } from '../tenants/site-copy';`.

- [ ] **Step 3: Test**

Add to the platform service spec (mirror an existing `updateTenant` test): updating with `siteUrl: 'https://x.test/'` writes `settings.siteUrl === 'https://x.test'` (sanitized) and busts the cache; `siteUrl: 'javascript:1'` writes `''`. Run: `cd server; npx jest platform --runInBand` → PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/platform
git commit -m "feat(platform): super-admin sets settings.siteUrl on a farm"
```

---

## Task 5: Server — full suite + builds

- [ ] **Step 1:** `cd server; npx jest --runInBand` → all green (fix any spec referencing removed v2 site-copy methods).
- [ ] **Step 2:** `cd packages/db; npm run build; cd ../types; npm run build; cd ../../server; npm run build` → clean.
- [ ] **Step 3:** Add a note (no code) that `CORS_ORIGIN` must include each storefront origin in prod, and update the local-dev default if helpful: in `env.validation.ts` the `CORS_ORIGIN` default can be left as-is (deploy sets it). Commit any spec fixes: `git add server && git commit -m "test(tenants): align specs with v3 site-edit"` (skip if none).

---

## Task 6: chaika — edit overlay

**Files:**
- Create: `../fermerski-pazar-chaika/src/scripts/edit-overlay.ts`
- Modify: `../fermerski-pazar-chaika/src/pages/faq.astro` (add FAQ markers)

- [ ] **Step 1: Add FAQ item markers in `faq.astro`**

The accordion maps `FAQ`. Add data markers so the overlay can target each Q/A. Change the map body to:
```astro
          {FAQ.map((f, i) => (
            <div class={`acc__item${i === 0 ? ' open' : ''}`} data-faq-item={i}>
              <button class="acc__head"><span data-faq-field="q" data-faq-index={i}>{f.q}</span><span class="ico">+</span></button>
              <div class="acc__body"><div class="acc__body-inner" data-faq-field="a" data-faq-index={i}>{f.a}</div></div>
            </div>
          ))}
```
(Only adds `data-faq-item`/`data-faq-field`/`data-faq-index`; everything else unchanged.)

- [ ] **Step 2: Create the overlay**

```ts
// src/scripts/edit-overlay.ts
/**
 * Storefront inline-edit overlay. Loaded only with ?edit=<token> (Layout gate).
 * Lets the farm edit text + photos + the FAQ list in place and save via the
 * FarmFlow site-edit API (Bearer = the short-lived edit token). No deps.
 */
const API = import.meta.env.PUBLIC_API_BASE as string;

function getTokenAndClean(): string | null {
  const u = new URL(location.href);
  const t = u.searchParams.get('edit');
  if (!t) return null;
  u.searchParams.delete('edit');
  history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash);
  return t;
}

type Slot = { kind: 'text' | 'image'; key: string };
type Manifest = { pages: { sections: { slots: Slot[] }[] }[] };

function flattenKinds(m: Manifest): Record<string, 'text' | 'image'> {
  const out: Record<string, 'text' | 'image'> = {};
  for (const p of m.pages) for (const s of p.sections) for (const sl of s.slots) out[sl.key] = sl.kind;
  return out;
}

async function boot() {
  const token = getTokenAndClean();
  if (!token) return;
  const auth = { Authorization: `Bearer ${token}` };

  // Load slot kinds (same-origin) + current overrides + faq.
  const [kinds, data] = await Promise.all([
    fetch('/editable-manifest.json').then((r) => r.json()).then(flattenKindsSafe),
    fetch(`${API}/tenants/me/site-edit/data`, { headers: auth }).then(handle).catch(() => null),
  ]);
  if (!data) { banner('Сесията изтече. Отвори пак „Редактирай сайта" от панела.'); return; }

  const draftCopy: Record<string, string> = { ...(data.copy ?? {}) };
  let draftFaq: { q: string; a: string }[] = Array.isArray(data.faq) ? data.faq.map((f: any) => ({ q: f.q, a: f.a })) : [];
  let dirty = false;
  const markDirty = () => { dirty = true; updateBar(); };

  document.documentElement.classList.add('ff-edit-on');
  injectStyles();
  wireText(kinds, draftCopy, markDirty);
  wireImages(kinds, token, markDirty);
  wireFaq(draftFaq, (next) => { draftFaq = next; markDirty(); });
  const { updateBar } = buildBar(async () => {
    try {
      await handle(await fetch(`${API}/tenants/me/site-edit/content`, {
        method: 'PATCH', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ copy: cleanCopy(draftCopy), faq: cleanFaq(draftFaq) }),
      }));
      dirty = false; updateBar(); toast('Запазено');
    } catch { toast('Грешка при запис'); }
  });
  updateBar();

  function handle(r: Response) { if (!r.ok) throw new Error(String(r.status)); return r.json(); }
  function flattenKindsSafe(m: any) { try { return flattenKinds(m); } catch { return {}; } }
  function cleanCopy(c: Record<string, string>) {
    const o: Record<string, string> = {}; for (const [k, v] of Object.entries(c)) if (v && v.trim()) o[k] = v.trim(); return o;
  }
  function cleanFaq(f: { q: string; a: string }[]) {
    return f.map((x) => ({ q: (x.q || '').trim(), a: (x.a || '').trim() })).filter((x) => x.q || x.a).slice(0, 50);
  }

  // --- text slots: contenteditable, commit innerText to draft on input ---
  function wireText(kinds: Record<string, string>, draft: Record<string, string>, onChange: () => void) {
    document.querySelectorAll<HTMLElement>('[data-editable-slot]').forEach((el) => {
      const key = el.getAttribute('data-editable-slot')!;
      if (kinds[key] !== 'text') return;
      el.setAttribute('contenteditable', 'plaintext-only');
      el.classList.add('ff-edit-text');
      el.addEventListener('input', () => { draft[key] = el.innerText; onChange(); });
    });
  }

  // --- image slots: click → file picker → upload → swap ---
  function wireImages(kinds: Record<string, string>, tok: string, onChange: () => void) {
    document.querySelectorAll<HTMLElement>('[data-editable-slot]').forEach((el) => {
      const key = el.getAttribute('data-editable-slot')!;
      if (kinds[key] !== 'image') return;
      el.classList.add('ff-edit-img');
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'ff-edit-imgbtn'; btn.textContent = 'Смени снимка';
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/jpeg,image/png,image/webp';
        inp.onchange = async () => {
          const file = inp.files?.[0]; if (!file) return;
          btn.textContent = 'Качване…';
          try {
            const fd = new FormData(); fd.append('image', file);
            const res = await fetch(`${API}/tenants/me/site-edit/media/${encodeURIComponent(key)}`, {
              method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: fd,
            });
            if (!res.ok) throw new Error();
            const { url } = await res.json();
            let img = el.querySelector('img');
            if (!img) { img = document.createElement('img'); img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover'; el.appendChild(img); el.querySelector('.ph__label')?.remove(); }
            img.src = url; toast('Снимката е качена'); onChange();
          } catch { toast('Грешка при качване'); }
          finally { btn.textContent = 'Смени снимка'; }
        };
        inp.click();
      });
      el.appendChild(btn);
    });
  }

  // --- FAQ: inline-edit q/a + per-item ↑↓✕ + add (only on the faq page) ---
  function wireFaq(faq: { q: string; a: string }[], setFaq: (f: { q: string; a: string }[]) => void) {
    const list = document.querySelector('.acc'); if (!list) return;
    function render() {
      list!.querySelectorAll('[data-faq-field]').forEach((node) => {
        const el = node as HTMLElement;
        const idx = Number(el.getAttribute('data-faq-index'));
        const field = el.getAttribute('data-faq-field') as 'q' | 'a';
        if (faq[idx]) el.innerText = faq[idx][field];
        el.setAttribute('contenteditable', 'plaintext-only');
        el.classList.add('ff-edit-text');
        el.oninput = () => { if (faq[idx]) { faq[idx][field] = el.innerText; setFaq([...faq]); } };
      });
    }
    // per-item controls
    list.querySelectorAll<HTMLElement>('[data-faq-item]').forEach((item) => {
      const idx = Number(item.getAttribute('data-faq-item'));
      const tools = document.createElement('div'); tools.className = 'ff-faq-tools';
      const mk = (txt: string, fn: () => void) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = txt; b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(); }; tools.appendChild(b); };
      mk('↑', () => { if (idx > 0) { [faq[idx - 1], faq[idx]] = [faq[idx], faq[idx - 1]]; setFaq([...faq]); rebuild(faq, setFaq); } });
      mk('↓', () => { if (idx < faq.length - 1) { [faq[idx + 1], faq[idx]] = [faq[idx], faq[idx + 1]]; setFaq([...faq]); rebuild(faq, setFaq); } });
      mk('✕', () => { faq.splice(idx, 1); setFaq([...faq]); rebuild(faq, setFaq); });
      item.appendChild(tools);
    });
    const add = document.createElement('button'); add.type = 'button'; add.className = 'ff-faq-add'; add.textContent = '+ Добави въпрос';
    add.onclick = (e) => { e.preventDefault(); faq.push({ q: 'Нов въпрос', a: 'Отговор' }); setFaq([...faq]); rebuild(faq, setFaq); };
    list.parentElement?.appendChild(add);
    render();
  }
  // Rebuild the FAQ DOM after structural change (reorder/add/remove) by reloading the page in edit mode would lose the token; instead re-render text from the draft and toggle item visibility. Simpler: full re-render of the .acc innerHTML from the draft.
  function rebuild(faq: { q: string; a: string }[], setFaq: (f: { q: string; a: string }[]) => void) {
    const list = document.querySelector('.acc'); if (!list) return;
    list.innerHTML = faq.map((f, i) => `
      <div class="acc__item${i === 0 ? ' open' : ''}" data-faq-item="${i}">
        <button class="acc__head"><span data-faq-field="q" data-faq-index="${i}"></span><span class="ico">+</span></button>
        <div class="acc__body"><div class="acc__body-inner" data-faq-field="a" data-faq-index="${i}"></div></div>
      </div>`).join('');
    document.querySelector('.ff-faq-add')?.remove();
    wireFaq(faq, setFaq);
  }

  function buildBar(onSave: () => void) {
    const bar = document.createElement('div'); bar.className = 'ff-edit-bar';
    const status = document.createElement('span'); status.className = 'ff-edit-status';
    const save = document.createElement('button'); save.type = 'button'; save.className = 'ff-edit-save'; save.textContent = 'Запази'; save.onclick = onSave;
    const exit = document.createElement('button'); exit.type = 'button'; exit.className = 'ff-edit-exit'; exit.textContent = 'Изход';
    exit.onclick = () => { location.href = location.pathname; };
    bar.append(status, exit, save); document.body.appendChild(bar);
    return { updateBar: () => { status.textContent = dirty ? 'Незаписани промени' : 'Режим на редактиране'; save.disabled = !dirty; } };
  }
  function banner(msg: string) { const b = document.createElement('div'); b.className = 'ff-edit-bar'; b.textContent = msg; document.body.appendChild(b); }
  function toast(msg: string) { const t = document.createElement('div'); t.className = 'ff-edit-toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2200); }
  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = `
      .ff-edit-text{outline:1px dashed rgba(63,125,67,.5);outline-offset:2px;cursor:text;border-radius:3px}
      .ff-edit-text:focus{outline:2px solid #3F7D43;background:rgba(63,125,67,.06)}
      .ff-edit-img{position:relative}
      .ff-edit-imgbtn{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:5;background:#3F7D43;color:#fff;border:0;border-radius:6px;padding:8px 12px;font:600 13px system-ui;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)}
      .ff-faq-tools{display:flex;gap:4px;margin:6px 0}
      .ff-faq-tools button{width:28px;height:28px;border:1px solid #ccc;background:#fff;border-radius:6px;cursor:pointer}
      .ff-faq-add{margin:12px 0;background:#eef3ec;border:1px solid #cdddc9;border-radius:8px;padding:8px 14px;font:600 14px system-ui;cursor:pointer}
      .ff-edit-bar{position:fixed;left:0;right:0;bottom:0;z-index:9999;display:flex;align-items:center;justify-content:flex-end;gap:12px;background:#1f2a1f;color:#fff;padding:12px 20px;font:600 14px system-ui}
      .ff-edit-status{margin-right:auto;font-weight:500;opacity:.85}
      .ff-edit-save{background:#3F7D43;color:#fff;border:0;border-radius:8px;padding:9px 22px;font:600 14px system-ui;cursor:pointer}
      .ff-edit-save:disabled{opacity:.5;cursor:default}
      .ff-edit-exit{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:8px;padding:9px 16px;cursor:pointer}
      .ff-edit-toast{position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:10000;background:#1f2a1f;color:#fff;padding:10px 18px;border-radius:8px;font:600 14px system-ui}
      body{padding-bottom:64px}
    `;
    document.head.appendChild(s);
  }
}
boot();
```

> Implementer note: this is the largest file. Keep it dependency-free. The `rebuild` for FAQ re-renders `.acc` innerHTML from the draft (preserves the `acc` accordion classes so the storefront's `ui.ts` accordion behavior still applies after exit). If `ui.ts` binds accordion handlers once on load, a rebuilt item may not toggle in edit mode — that's acceptable (edit mode doesn't need the accordion to expand; the body-inner is always editable). Verify text + image + faq paths in the live E2E (Task 9).

- [ ] **Step 3: Build**

Run: `cd ../fermerski-pazar-chaika && npx astro check && npx astro build` → green. (The script isn't imported yet — Task 7 wires it; `astro check` validates the TS.)

- [ ] **Step 4: Commit**

```bash
cd ../fermerski-pazar-chaika && git switch -c feat/inline-site-editor 2>/dev/null || git switch feat/inline-site-editor
git add src/scripts/edit-overlay.ts src/pages/faq.astro
git commit -m "feat: storefront inline-edit overlay + FAQ markers"
```

---

## Task 7: chaika — Layout gate + middleware revert

**Files:**
- Modify: `../fermerski-pazar-chaika/src/components/Layout.astro`
- Modify: `../fermerski-pazar-chaika/src/middleware.ts`

- [ ] **Step 1: Layout — remove v2 preview listener, gate-load the overlay**

In `Layout.astro` frontmatter, replace the v2 `isPreview`/`adminOrigin` lines with:
```ts
const isEdit = Astro.url.searchParams.get('edit') !== null;
```
Remove the v2 `{isPreview && adminOrigin && (<script …postMessage listener…>)}` block. Before `</body>` (after the existing `<script>import '../scripts/ui.ts'</script>`), add:
```astro
{isEdit && <script>import '../scripts/edit-overlay.ts';</script>}
```

- [ ] **Step 2: middleware — drop preview branch, no-store on edit**

In `middleware.ts` replace the v2 `if (isPreview && ADMIN) {…} else {…}` framing block with the original unconditional headers + an edit no-store:
```ts
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  const isEdit = ctx.url.searchParams.get('edit') !== null;
  if (isEdit) res.headers.set('Cache-Control', 'no-store');
```
And guard the existing HTML edge-cache block to also require `!isEdit` (don't cache an edit-mode render). Remove the now-unused `ADMIN`/`isPreview` vars.

- [ ] **Step 3: Build + commit**

Run: `cd ../fermerski-pazar-chaika && npx astro build` → green.
```bash
git add src/components/Layout.astro src/middleware.ts
git commit -m "feat: load edit overlay on ?edit; revert preview framing to DENY"
```

---

## Task 8: Tenant admin — launch button (replace v2 editor)

**Files:**
- Modify: `client/src/lib/api-client.ts`
- Replace: `client/src/app/(admin)/site-media/page.tsx`
- Delete: `client/src/app/(admin)/site-media/site-editor.tsx`, `preview-pane.tsx`

- [ ] **Step 1: api-client — add createEditSession, remove v2 exports**

In `client/src/lib/api-client.ts` remove the v2 block (`ManifestTextSlot`…`EditableManifest`, `SiteFaqItem`, `SiteCopyData`, `getSiteCopy`, `updateSiteCopy`, `getEditableManifest`). Leave `uploadSiteMedia`/`deleteSiteMedia` in place if removing them would break any other import (they become dead after `site-editor.tsx` is deleted — harmless; only remove them if `rg "uploadSiteMedia|deleteSiteMedia" client/src` shows no remaining users). Add:
```ts
// ---- Site editor ----
export const createEditSession = () =>
  apiFetch<{ token: string; siteUrl: string; expiresIn: number }>(
    'tenants/me/edit-session',
    { method: 'POST' },
    'Неуспешно отваряне на редактора',
  );
```

- [ ] **Step 2: page.tsx — launch screen**

```tsx
'use client';

import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { createEditSession } from '@/lib/api-client';

export default function SiteEditorPage() {
  const [busy, setBusy] = useState(false);

  async function openEditor() {
    setBusy(true);
    try {
      const { token, siteUrl } = await createEditSession();
      const url = `${siteUrl.replace(/\/$/, '')}/?edit=${encodeURIComponent(token)}`;
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Адресът на сайта още не е зададен — свържи се с поддръжката.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-[760px]">
      <div className="mb-6">
        <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Промени сайта</h1>
        <p className="text-[13.5px] text-ff-muted">Редактирай текстовете и снимките направо върху сайта си.</p>
      </div>
      <div className="rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
        <p className="mb-4 text-[14px] text-ff-ink">
          Натисни бутона — сайтът ти ще се отвори в режим на редактиране. Кликни върху всеки текст или снимка, за да го смениш, после „Запази".
        </p>
        <Button type="button" disabled={busy} onClick={openEditor} className="gap-2 rounded-sm px-6 py-2.5 text-[14px]">
          <ExternalLink size={16} /> {busy ? 'Отваряне…' : 'Редактирай сайта'}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: delete v2 editor files**

```bash
cd C:/Users/Lenovo/source/repos/FarmFlow
git rm "client/src/app/(admin)/site-media/site-editor.tsx" "client/src/app/(admin)/site-media/preview-pane.tsx"
```

- [ ] **Step 4: typecheck + build**

Run: `cd client; npx tsc --noEmit` → 0 errors (if anything else imported the removed api-client exports, fix it). Run: `cd client; npm run build` → success.

- [ ] **Step 5: Commit**

```bash
git add "client/src/app/(admin)/site-media" client/src/lib/api-client.ts
git commit -m "feat(admin): Промени сайта = launch inline editor (drop iframe editor)"
```

---

## Task 9: Super-admin — siteUrl field

**Files:**
- Modify: `admin/src/lib/api-client.ts`
- Modify: `admin/src/components/tenant-detail-client.tsx`

- [ ] **Step 1: api-client — add siteUrl to the updateTenant payload type**

In `admin/src/lib/api-client.ts` find the `updateTenant` call (~line 213) + its payload type; add optional `siteUrl?: string` to the update payload interface. Also include `siteUrl` in the tenant-detail GET type if it surfaces settings (if the detail response exposes `settings.siteUrl`, type it; otherwise the field is write-mostly — prefill from the detail if available).

- [ ] **Step 2: tenant-detail-client — add the field**

In `admin/src/components/tenant-detail-client.tsx`, alongside the existing editable fields (name/slug/email/phone), add an „Адрес на сайта" text input bound to local state, included in the `updateTenant` payload on save. Mirror the existing field markup. Prefill from the tenant detail's `settings.siteUrl` if present.

- [ ] **Step 3: typecheck + build**

Run: `cd admin; npx tsc --noEmit` → 0 errors. Run: `cd admin; npm run build` → success.

- [ ] **Step 4: Commit**

```bash
git add admin/src/lib/api-client.ts admin/src/components/tenant-detail-client.tsx
git commit -m "feat(super-admin): set a farm's site URL (settings.siteUrl)"
```

---

## Task 10: Docs

**Files:** `docs/admin-panel-guide.md`, `client/src/app/(admin)/help/page.tsx`

- [ ] **Step 1:** Update „Промени сайта": it's now a single „Редактирай сайта" button that opens the live site in edit mode — click text/photos to change them, then Запази. Note the operator sets the site address. Remove v2 iframe/field-tree wording. Run `cd client; npx tsc --noEmit` if you touch the tsx.
- [ ] **Step 2:** Commit `docs: document inline (edit-on-site) editor`.

---

## Task 11: Full verification + live E2E

- [ ] **Step 1:** Server: `cd server; npx jest --runInBand` → green. Builds: db/types/server → clean.
- [ ] **Step 2:** Tenant admin: `cd client; npx tsc --noEmit; npm run build` → clean. Super-admin: `cd admin; npx tsc --noEmit; npm run build` → clean.
- [ ] **Step 3:** chaika: `cd ../fermerski-pazar-chaika; npx astro build` → clean.
- [ ] **Step 4: Live E2E** (API from dist `node dist/main.js`; chaika `astro dev` with `PUBLIC_API_BASE=http://localhost:3001`; add the chaika dev origin to the API `CORS_ORIGIN`, e.g. run the API with `CORS_ORIGIN=http://localhost:3000,http://localhost:4321`). Verify with an API harness + a browser pass:
  - super-admin sets `settings.siteUrl` (PATCH `platform/tenants/:id` `{siteUrl}`) → stored sanitized.
  - `POST tenants/me/edit-session` (admin JWT) → `{token, siteUrl}`; with siteUrl unset → 400.
  - `GET/PATCH tenants/me/site-edit/*` with the edit token → works; with a normal tenant JWT → 401; the edit token on `GET tenants/me` (admin route) → 401/403.
  - Browser: open `${siteUrl}/?edit=<token>` → overlay loads, token stripped from URL; edit a heading (contenteditable) + upload a photo + add/edit an FAQ item → Запази → reload (no `?edit`) shows the changes.
  - Normal page (no `?edit`) → `X-Frame-Options: DENY` (preview framing gone).
- [ ] **Step 5:** Report with command output.

---

## Self-Review notes (for the executor)

- **Token isolation:** the edit token is signed/verified with `${JWT_SECRET}::siteedit` — it must fail the normal `JwtAuthGuard` (main secret). The guard spec proves this; the live E2E confirms cross-route rejection.
- **CORS is config:** add each storefront origin to `CORS_ORIGIN` (prod env + the local-dev run command). No `main.ts` change.
- **`JwtService` injection:** `TenantsService` + `EditSessionGuard` need `JwtService` → `TenantsModule` must import `AuthModule` (which exports `JwtModule`). No circular dep (AuthModule doesn't import TenantsModule).
- **Reused unchanged:** chaika `editable-manifest.ts` + `editable-manifest.json` endpoint + `CopySlot`/`MediaSlot` (`data-editable-slot`) + `data-copy-section`; server `cleanCopy`/`normalizeFaq`/`sanitizeSiteUrl`/`isValidSlotKey`/`setSiteMedia`/`deleteSiteMedia`/`toPublicMedia`.
- **No DB migration** (`settings.siteUrl` exists from v2; slot keys preserved → tenant overrides valid).
- **Overlay is the risk surface** — verify text/image/FAQ in the live E2E; it's dependency-free vanilla TS bundled like the existing `src/scripts/*.ts`.
- **The v2 admin `media-manager`/`uploadSiteMedia` removal:** confirm nothing else in `client/` imports `uploadSiteMedia`/`deleteSiteMedia` before deleting them; if the products/farmers media managers use a DIFFERENT api-client function, these site-media ones are safe to drop.
