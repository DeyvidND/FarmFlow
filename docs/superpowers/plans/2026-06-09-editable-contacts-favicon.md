# Editable Contacts + Website Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each tenant edit storefront contact details (address, hours, tagline, arbitrary social links, map location) and the website icon (favicon + theme color) from the admin, consumed by the chaika "Пазар" storefront.

**Architecture:** Mirror the existing `settings.media` site-photos feature. Two new `tenants.settings` jsonb sub-keys (`contact`, `brand`) written with per-path atomic `jsonb_set`. New `tenants/me/site-contact` (GET/PATCH) + `tenants/me/favicon` (POST/DELETE) endpoints. Public fields added to `PublicStorefront` + cached `TenantMeta`. New admin „Контакти" page + a small Google-Maps `LocationPicker`. Chaika reads the new fields with `site.ts` constants as fallback.

**Tech Stack:** NestJS + Drizzle (Postgres jsonb) + Redis cache + R2 storage; Next.js admin (`@vis.gl/react-google-maps`, sonner, Tailwind); Astro chaika storefront.

**Storage shapes (final):**
```ts
settings.contact = { address?, hours?, tagline?, social?: {label,url}[], mapLat?, mapLng? }  // strings
settings.brand   = { favicon?: { url: string; key: string }, themeColor?: string }
```
Public projection (unchanged from spec): `contact`, `faviconUrl`, `themeColor`.

**No DB migration** — `tenants.settings` is untyped jsonb.

**Test strategy:** `tenants` has no service unit test today (site-media shipped verified live). Automated tests cover the cleanly-unit-testable pieces: `magic-mime` ICO sniff, `SiteContactDto` validation, and pure `buildPublicContact` / `normalizeSiteContact` helpers. The DB `jsonb_set` wiring, cache busting, endpoints, and chaika rendering are verified live (Task 16).

**Run tests from `server/`:** `npm test -- <pattern>`. Wrap noisy builds/tests in `ctx-wire run` per global prefs.

---

## Phase A — Server

### Task 1: Favicon mime constants + ICO byte-sniff

**Files:**
- Modify: `server/src/modules/storage/dto/upload-image.dto.ts`
- Modify: `server/src/modules/storage/magic-mime.ts`
- Test: `server/src/modules/storage/magic-mime.spec.ts`

- [ ] **Step 1: Add the failing ICO test**

In `server/src/modules/storage/magic-mime.spec.ts`, add an ICO buffer constant after the `MP4` line:

```ts
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 1, 0, 0, 0, 0, 0, 0, 0]);
```

Add to the `describe('sniffMime')` block a new assertion inside the existing "detects each accepted format" test (append the line):

```ts
    expect(sniffMime(ICO)).toBe('image/x-icon');
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- magic-mime`
Expected: FAIL — `sniffMime(ICO)` returns `null`, expected `'image/x-icon'`.

- [ ] **Step 3: Add ICO detection to `sniffMime`**

In `server/src/modules/storage/magic-mime.ts`, add this block immediately **before** the WEBM check (after the WEBP block):

```ts
  // ICO — 00 00 01 00 (Windows icon; favicon)
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
    return 'image/x-icon';
  }
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npm test -- magic-mime`
Expected: PASS (all sniffMime + assertContentMatchesMime tests green).

- [ ] **Step 5: Add favicon constants**

In `server/src/modules/storage/dto/upload-image.dto.ts`, append after the existing exports (before `UploadImageDto`):

```ts
export const FAVICON_MIME_REGEX = /^image\/(png|x-icon|vnd\.microsoft\.icon)$/;

export const FAVICON_MAX_BYTES = 512 * 1024;
```

And append after the `UploadImageDto` class:

```ts
export class FaviconUploadDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'Website icon (PNG or ICO; max 512 KB)',
  })
  image: any;
}
```

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/storage/dto/upload-image.dto.ts server/src/modules/storage/magic-mime.ts server/src/modules/storage/magic-mime.spec.ts
git commit -m "feat(storage): sniff ICO + favicon mime constants"
```

---

### Task 2: `SiteContactDto` + validation test

**Files:**
- Create: `server/src/modules/tenants/dto/site-contact.dto.ts`
- Test: `server/src/modules/tenants/dto/site-contact.dto.spec.ts`

- [ ] **Step 1: Write the DTO**

Create `server/src/modules/tenants/dto/site-contact.dto.ts`:

```ts
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** One social link row. `url` must be a real http(s) URL; `label` is free text. */
export class SocialLinkDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  label?: string;

  @IsString()
  @IsUrl({ require_protocol: true })
  @MaxLength(300)
  url!: string;
}

/** Editable storefront contact block (settings.contact) + theme color
 *  (settings.brand.themeColor). All optional — the admin form sends the whole
 *  block on save, but partials are tolerated. Empty strings are allowed (they
 *  clear the value). */
export class SiteContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  hours?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  tagline?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => SocialLinkDto)
  social?: SocialLinkDto[];

  // Decimal or empty. Lat ±90, lng ±180 — kept loose (string passthrough).
  @IsOptional()
  @IsString()
  @Matches(/^$|^-?\d{1,2}(\.\d+)?$/)
  mapLat?: string;

  @IsOptional()
  @IsString()
  @Matches(/^$|^-?\d{1,3}(\.\d+)?$/)
  mapLng?: string;

  // "#RRGGBB" or empty (empty clears it back to the storefront default).
  @IsOptional()
  @IsString()
  @Matches(/^$|^#[0-9a-fA-F]{6}$/)
  themeColor?: string;
}
```

- [ ] **Step 2: Write the failing validation test**

Create `server/src/modules/tenants/dto/site-contact.dto.spec.ts`:

```ts
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SiteContactDto } from './site-contact.dto';

function errorsFor(obj: unknown): string[] {
  const dto = plainToInstance(SiteContactDto, obj);
  return validateSync(dto, { whitelist: true }).flatMap((e) => {
    const own = Object.keys(e.constraints ?? {});
    const nested = (e.children ?? []).flatMap((c) => Object.keys(c.constraints ?? {}));
    return [...own, ...nested].length ? [e.property] : [];
  });
}

describe('SiteContactDto', () => {
  it('accepts a full valid payload', () => {
    expect(
      errorsFor({
        address: 'кв. Чайка, Варна',
        hours: 'Петък 11:00–18:00',
        tagline: 'Местни стопани на едно място.',
        social: [{ label: 'Facebook', url: 'https://facebook.com/ferma' }],
        mapLat: '43.21',
        mapLng: '27.91',
        themeColor: '#3F7D43',
      }),
    ).toEqual([]);
  });

  it('accepts empty strings (clearing) and an empty social list', () => {
    expect(
      errorsFor({ address: '', mapLat: '', mapLng: '', themeColor: '', social: [] }),
    ).toEqual([]);
  });

  it('rejects a non-url social link', () => {
    expect(errorsFor({ social: [{ url: 'not a url' }] })).toContain('social');
  });

  it('rejects more than 8 social links', () => {
    const social = Array.from({ length: 9 }, (_, i) => ({ url: `https://x.com/${i}` }));
    expect(errorsFor({ social })).toContain('social');
  });

  it('rejects a malformed theme color', () => {
    expect(errorsFor({ themeColor: 'red' })).toContain('themeColor');
  });
});
```

- [ ] **Step 3: Run it, verify it passes**

Run: `npm test -- site-contact.dto`
Expected: PASS (5 tests). If `reflect-metadata` import errors, confirm it is already imported at app bootstrap — the explicit import in the spec covers standalone runs.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/tenants/dto/site-contact.dto.ts server/src/modules/tenants/dto/site-contact.dto.spec.ts
git commit -m "feat(tenants): SiteContactDto with validation"
```

---

### Task 3: Pure projection + normalize helpers (dedicated module)

> A dedicated `site-contact.ts` module holds the pure helpers + public contact
> types. This avoids a circular **value** import: `tenants.service.ts` imports
> `publicCacheKeys` from `public-cache.service.ts`, and `public-cache.service.ts`
> (Task 4) needs `buildPublicContact`. Both import it from this leaf module
> instead (it depends only on the DTO type), so there is no cycle.

**Files:**
- Create: `server/src/modules/tenants/site-contact.ts`
- Modify: `server/src/modules/tenants/tenants.service.ts`
- Test: `server/src/modules/tenants/site-contact.spec.ts`

- [ ] **Step 1: Create the `site-contact.ts` module**

Create `server/src/modules/tenants/site-contact.ts`:

```ts
import type { SiteContactDto } from './dto/site-contact.dto';

/** One public social link. */
export interface PublicSocialLink {
  label: string;
  url: string;
}

/** Public contact block surfaced on the storefront profile. */
export interface PublicContact {
  address: string | null;
  hours: string | null;
  tagline: string | null;
  social: PublicSocialLink[];
  mapLat: string | null;
  mapLng: string | null;
}

/** Project a raw settings.contact blob to its public shape (trim, drop empty
 *  social rows, cap at 8). Garbage-in → safe nulls / []. */
export function buildPublicContact(raw: unknown): PublicContact {
  const c =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v : null;
  const social: PublicSocialLink[] = [];
  if (Array.isArray(c.social)) {
    for (const row of c.social.slice(0, 8)) {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        const url = (row as Record<string, unknown>).url;
        const label = (row as Record<string, unknown>).label;
        if (typeof url === 'string' && url.trim()) {
          social.push({ label: typeof label === 'string' ? label : '', url });
        }
      }
    }
  }
  return {
    address: str(c.address),
    hours: str(c.hours),
    tagline: str(c.tagline),
    social,
    mapLat: str(c.mapLat),
    mapLng: str(c.mapLng),
  };
}

/** Normalize an incoming SiteContactDto into the stored contact object + the
 *  theme color (undefined = field absent, leave brand.themeColor untouched). */
export function normalizeSiteContact(dto: SiteContactDto): {
  contact: Record<string, unknown>;
  themeColor: string | null | undefined;
} {
  const trim = (v?: string): string => (typeof v === 'string' ? v.trim() : '');
  const social = (dto.social ?? [])
    .map((s) => ({ label: trim(s.label), url: trim(s.url) }))
    .filter((s) => s.url)
    .slice(0, 8);
  const contact = {
    address: trim(dto.address),
    hours: trim(dto.hours),
    tagline: trim(dto.tagline),
    social,
    mapLat: trim(dto.mapLat),
    mapLng: trim(dto.mapLng),
  };
  const themeColor =
    dto.themeColor === undefined ? undefined : trim(dto.themeColor) || null;
  return { contact, themeColor };
}
```

- [ ] **Step 2: Wire the types into `tenants.service.ts`**

Add this import to `server/src/modules/tenants/tenants.service.ts` (next to the `./media-slots.catalog` import):

```ts
import {
  buildPublicContact,
  normalizeSiteContact,
  type PublicContact,
} from './site-contact';
```

Extend the `PublicStorefront` interface — add these three fields after `media: PublicMediaMap;`:

```ts
  // Editable contact block (settings.contact). Empty/missing → nulls; the
  // storefront falls back to its own static copy.
  contact: PublicContact;
  // Tenant website icon (settings.brand.favicon.url) and browser theme color
  // (settings.brand.themeColor). Null → storefront defaults.
  faviconUrl: string | null;
  themeColor: string | null;
```

(`buildPublicContact` / `normalizeSiteContact` are consumed by the service methods in Task 5.)

- [ ] **Step 3: Write the failing helper test**

Create `server/src/modules/tenants/site-contact.spec.ts`:

```ts
import { buildPublicContact, normalizeSiteContact } from './site-contact';

describe('buildPublicContact', () => {
  it('returns all-null / empty for garbage input', () => {
    expect(buildPublicContact(null)).toEqual({
      address: null, hours: null, tagline: null, social: [], mapLat: null, mapLng: null,
    });
    expect(buildPublicContact('nope')).toEqual({
      address: null, hours: null, tagline: null, social: [], mapLat: null, mapLng: null,
    });
  });

  it('keeps non-empty fields and drops social rows without a url, capping at 8', () => {
    const social = Array.from({ length: 10 }, (_, i) => ({ label: `L${i}`, url: `https://x/${i}` }));
    social.push({ label: 'bad', url: '' } as never);
    const out = buildPublicContact({ address: ' кв. Чайка ', tagline: '', social });
    expect(out.address).toBe(' кв. Чайка ');
    expect(out.tagline).toBeNull();
    expect(out.social).toHaveLength(8);
    expect(out.social.every((s) => s.url)).toBe(true);
  });
});

describe('normalizeSiteContact', () => {
  it('trims, drops empty social rows, leaves themeColor undefined when absent', () => {
    const { contact, themeColor } = normalizeSiteContact({
      address: '  кв. Чайка  ',
      social: [{ label: ' FB ', url: ' https://fb.com/x ' }, { url: '' }],
    });
    expect(contact.address).toBe('кв. Чайка');
    expect(contact.social).toEqual([{ label: 'FB', url: 'https://fb.com/x' }]);
    expect(themeColor).toBeUndefined();
  });

  it('maps empty themeColor string to null (clear)', () => {
    expect(normalizeSiteContact({ themeColor: '' }).themeColor).toBeNull();
    expect(normalizeSiteContact({ themeColor: '#abcdef' }).themeColor).toBe('#abcdef');
  });
});
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npm test -- site-contact`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/tenants/site-contact.ts server/src/modules/tenants/site-contact.spec.ts server/src/modules/tenants/tenants.service.ts
git commit -m "feat(tenants): public contact projection + normalize helpers"
```

---

### Task 4: Cache derivation (`TenantMeta` + `resolveTenant`)

**Files:**
- Modify: `server/src/common/cache/public-cache.service.ts`

- [ ] **Step 1: Extend `TenantMeta`**

In `server/src/common/cache/public-cache.service.ts`, add an import at the top (after the delivery-pricing import block):

```ts
import { buildPublicContact, type PublicContact } from '../../modules/tenants/site-contact';
```

This imports from the leaf `site-contact.ts` module (Task 3), not `tenants.service.ts` — no circular value import.

Add these fields to the `TenantMeta` interface after `media: Record<string, { url: string }>;`:

```ts
  // Editable contact block + website icon + theme color (settings.contact /
  // settings.brand). Derived here so a warm storefront render needs no extra read.
  contact: PublicContact;
  faviconUrl: string | null;
  themeColor: string | null;
```

- [ ] **Step 2: Derive them in `resolveTenant`**

Widen the `settingsObj` cast type to include `contact` + `brand`:

```ts
    const settingsObj = row.settings as
      | {
          delivery?: DeliveryConfig & { econt?: { configured?: boolean } };
          media?: Record<string, { url?: unknown }>;
          contact?: unknown;
          brand?: { favicon?: { url?: unknown }; themeColor?: unknown };
        }
      | null;
```

Add derivation right before the `const meta: TenantMeta = {` line:

```ts
    const brand = settingsObj?.brand;
    const faviconUrl =
      typeof brand?.favicon?.url === 'string' && brand.favicon.url ? brand.favicon.url : null;
    const themeColor =
      typeof brand?.themeColor === 'string' && brand.themeColor ? brand.themeColor : null;
```

Add these three fields to the `meta` object literal (after `media,`):

```ts
      contact: buildPublicContact(settingsObj?.contact),
      faviconUrl,
      themeColor,
```

- [ ] **Step 3: Verify `findPublicProfileBySlug` forwards the fields**

No change needed — `tenants.service.findPublicProfileBySlug` spreads `...profile` from `resolveTenant`, so `contact`/`faviconUrl`/`themeColor` flow through automatically and `PublicStorefront` (Task 3) now declares them. Read `tenants.service.ts:83-92` to confirm the spread is unchanged.

- [ ] **Step 4: Build to verify types**

Run: `npm run build` (from `server/`)
Expected: SUCCESS, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/common/cache/public-cache.service.ts
git commit -m "feat(cache): expose contact/favicon/themeColor on public tenant meta"
```

---

### Task 5: Service methods (DB writes)

**Files:**
- Modify: `server/src/modules/tenants/tenants.service.ts`

- [ ] **Step 1: Add the imports**

In `server/src/modules/tenants/tenants.service.ts`, extend the storage-dto import to add the favicon ext logic source and the magic-mime guard. Update the existing import line:

```ts
import { PRODUCT_IMAGE_EXT_BY_MIME } from '../storage/dto/upload-image.dto';
```

to also import the sniffer (add a new import line below it):

```ts
import { sniffMime } from '../storage/magic-mime';
```

- [ ] **Step 2: Add the four methods**

Insert these methods in the `TenantsService` class, right after `deleteSiteMedia` (after line ~233):

```ts
  // ---- Site contact + website icon ----

  /** Current contact block + favicon url + theme color for the admin editor. */
  async getSiteContact(tenantId: string): Promise<{
    contact: PublicContact;
    favicon: { url: string } | null;
    themeColor: string | null;
  }> {
    const settings = await this.loadSettings(tenantId);
    const brand = readBrand(settings);
    const url = typeof brand.favicon?.url === 'string' ? brand.favicon.url : '';
    return {
      contact: buildPublicContact(settings.contact),
      favicon: url ? { url } : null,
      themeColor: typeof brand.themeColor === 'string' && brand.themeColor ? brand.themeColor : null,
    };
  }

  /** Replace the whole settings.contact block, and set/clear brand.themeColor
   *  when the field was sent. Both are atomic per-path writes (favicon untouched). */
  async updateSiteContact(
    tenantId: string,
    dto: SiteContactDto,
  ): Promise<{ contact: PublicContact; themeColor: string | null }> {
    const { slug } = await this.loadTenantForMedia(tenantId);
    const { contact, themeColor } = normalizeSiteContact(dto);

    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(
          coalesce(${tenants.settings}, '{}'::jsonb),
          array['contact'],
          ${JSON.stringify(contact)}::jsonb,
          true
        )`,
      })
      .where(eq(tenants.id, tenantId));

    if (themeColor !== undefined) {
      await this.db
        .update(tenants)
        .set({
          settings: themeColor
            ? sql`jsonb_set(
                coalesce(${tenants.settings}, '{}'::jsonb)
                  || jsonb_build_object('brand', coalesce(${tenants.settings} -> 'brand', '{}'::jsonb)),
                array['brand', 'themeColor'],
                ${JSON.stringify(themeColor)}::jsonb,
                true
              )`
            : sql`coalesce(${tenants.settings}, '{}'::jsonb) #- array['brand', 'themeColor']`,
        })
        .where(eq(tenants.id, tenantId));
    }

    await this.publicCache.del(publicCacheKeys.tenant(slug));
    return { contact: buildPublicContact(contact), themeColor: themeColor ?? null };
  }

  /** Upload/replace the website icon. PNG or ICO only — verified by magic bytes
   *  (the declared mime is spoofable). Stored at brand.favicon = { url, key }. */
  async setFavicon(tenantId: string, file: Express.Multer.File): Promise<{ url: string }> {
    const { slug, settings } = await this.loadTenantForMedia(tenantId);

    const detected = sniffMime(file.buffer);
    if (detected !== 'image/png' && detected !== 'image/x-icon') {
      throw new BadRequestException('Иконата трябва да е PNG или ICO файл.');
    }
    const ext = detected === 'image/png' ? 'png' : 'ico';
    const key = `tenants/${tenantId}/site/favicon/${randomUUID()}.${ext}`;
    // Upload with the *detected* (canonical) content type, not the client header.
    const { url } = await this.storage.upload(file.buffer, key, detected);

    const prevKey = readBrand(settings).favicon?.key;
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(
          coalesce(${tenants.settings}, '{}'::jsonb)
            || jsonb_build_object('brand', coalesce(${tenants.settings} -> 'brand', '{}'::jsonb)),
          array['brand', 'favicon'],
          ${JSON.stringify({ url, key })}::jsonb,
          true
        )`,
      })
      .where(eq(tenants.id, tenantId));

    if (typeof prevKey === 'string' && prevKey && prevKey !== key) {
      await this.storage.delete(prevKey).catch(() => undefined);
    }
    await this.publicCache.del(publicCacheKeys.tenant(slug));
    return { url };
  }

  /** Remove the website icon (reverts to the storefront's static favicon). Idempotent. */
  async deleteFavicon(tenantId: string): Promise<{ ok: true }> {
    const { slug, settings } = await this.loadTenantForMedia(tenantId);
    const prevKey = readBrand(settings).favicon?.key;

    await this.db
      .update(tenants)
      .set({
        settings: sql`coalesce(${tenants.settings}, '{}'::jsonb) #- array['brand', 'favicon']`,
      })
      .where(eq(tenants.id, tenantId));

    if (typeof prevKey === 'string' && prevKey) {
      await this.storage.delete(prevKey).catch(() => undefined);
    }
    await this.publicCache.del(publicCacheKeys.tenant(slug));
    return { ok: true };
  }
```

- [ ] **Step 3: Add the `readBrand` helper**

Add at the bottom of the file, next to `readMedia`:

```ts
/** Read the raw settings.brand object (favicon + themeColor) from a settings blob. */
function readBrand(settings: Record<string, unknown>): {
  favicon?: { url?: unknown; key?: unknown };
  themeColor?: unknown;
} {
  const b = settings.brand;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return {};
  return b as { favicon?: { url?: unknown; key?: unknown }; themeColor?: unknown };
}
```

- [ ] **Step 4: Build to verify types**

Run: `npm run build` (from `server/`)
Expected: SUCCESS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/tenants/tenants.service.ts
git commit -m "feat(tenants): site-contact + favicon service methods (atomic jsonb)"
```

---

### Task 6: Controller routes

**Files:**
- Modify: `server/src/modules/tenants/tenants.controller.ts`

- [ ] **Step 1: Add the routes**

In `server/src/modules/tenants/tenants.controller.ts`, extend the storage-dto import to add favicon constants + dto:

```ts
import {
  UploadImageDto,
  PRODUCT_IMAGE_MIME_REGEX,
  PRODUCT_IMAGE_MAX_BYTES,
  FaviconUploadDto,
  FAVICON_MIME_REGEX,
  FAVICON_MAX_BYTES,
} from '../storage/dto/upload-image.dto';
```

Add the DTO import below the `UpdateTenantDto` import:

```ts
import { SiteContactDto } from './dto/site-contact.dto';
```

Insert these routes inside `TenantsController`, after `deleteMedia` (line ~70):

```ts
  // ---- Site contact + website icon ----

  @ApiOperation({ summary: 'Contact block + favicon + theme color' })
  @Get('me/site-contact')
  getSiteContact(@CurrentTenant() tenantId: string) {
    return this.tenantsService.getSiteContact(tenantId);
  }

  @ApiOperation({ summary: 'Update contact block + theme color' })
  @Patch('me/site-contact')
  updateSiteContact(@CurrentTenant() tenantId: string, @Body() dto: SiteContactDto) {
    return this.tenantsService.updateSiteContact(tenantId, dto);
  }

  @ApiOperation({ summary: 'Upload/replace the website icon (PNG or ICO)' })
  @Post('me/favicon')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: FaviconUploadDto })
  @UseInterceptors(FileInterceptor('image'))
  uploadFavicon(
    @CurrentTenant() tenantId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new FileTypeValidator({ fileType: FAVICON_MIME_REGEX }),
          new MaxFileSizeValidator({ maxSize: FAVICON_MAX_BYTES }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.tenantsService.setFavicon(tenantId, file);
  }

  @ApiOperation({ summary: 'Remove the website icon' })
  @Delete('me/favicon')
  deleteFavicon(@CurrentTenant() tenantId: string) {
    return this.tenantsService.deleteFavicon(tenantId);
  }
```

- [ ] **Step 2: Build + run the full server test suite**

Run: `npm run build && npm test` (from `server/`)
Expected: build SUCCESS; all tests PASS (existing suite + the new magic-mime / dto / helper specs). No new providers needed in `tenants.module.ts` — the controller and `TenantsService` are already registered and `StorageService`/`PublicCacheService` already injected.

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/tenants/tenants.controller.ts
git commit -m "feat(tenants): site-contact + favicon endpoints"
```

---

## Phase B — Admin client

### Task 7: API client helpers + types

**Files:**
- Modify: `client/src/lib/api-client.ts`

- [ ] **Step 1: Add types + helpers**

In `client/src/lib/api-client.ts`, after the `deleteSiteMedia` export (line ~218), add:

```ts
// ---- Site contact + website icon ----
export interface SocialLink {
  label: string;
  url: string;
}

export interface SiteContact {
  address: string;
  hours: string;
  tagline: string;
  social: SocialLink[];
  mapLat: string;
  mapLng: string;
}

export interface SiteContactResponse {
  contact: {
    address: string | null;
    hours: string | null;
    tagline: string | null;
    social: SocialLink[];
    mapLat: string | null;
    mapLng: string | null;
  };
  favicon: { url: string } | null;
  themeColor: string | null;
}

export const getSiteContact = () => apiFetch<SiteContactResponse>('tenants/me/site-contact');

export const updateSiteContact = (data: {
  address: string;
  hours: string;
  tagline: string;
  social: SocialLink[];
  mapLat: string;
  mapLng: string;
  themeColor: string;
}) =>
  apiFetch<{ contact: SiteContactResponse['contact']; themeColor: string | null }>(
    'tenants/me/site-contact',
    { method: 'PATCH', ...json(data) },
    'Неуспешно записване',
  );

export function uploadFavicon(file: File) {
  const fd = new FormData();
  fd.append('image', file);
  return apiFetch<{ url: string }>(
    'tenants/me/favicon',
    { method: 'POST', body: fd },
    'Неуспешно качване',
  );
}

export const deleteFavicon = () =>
  apiFetch<{ ok: true }>('tenants/me/favicon', { method: 'DELETE' }, 'Неуспешно изтриване');
```

- [ ] **Step 2: Type-check**

Run: `npm run build` (from `client/`) — or `npx tsc --noEmit`.
Expected: SUCCESS.

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/api-client.ts
git commit -m "feat(admin): site-contact + favicon api helpers"
```

---

### Task 8: `LocationPicker` component

**Files:**
- Create: `client/src/components/maps/location-picker.tsx`

- [ ] **Step 1: Write the component**

Create `client/src/components/maps/location-picker.tsx`:

```tsx
'use client';

import { APIProvider, Map, AdvancedMarker } from '@vis.gl/react-google-maps';

const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
const MAP_ID = 'DEMO_MAP_ID';
const BG_CENTROID = { lat: 42.7339, lng: 25.4858 };

interface LocationPickerProps {
  lat: number | null;
  lng: number | null;
  /** Called with the clicked coordinates. */
  onPick: (lat: number, lng: number) => void;
}

/**
 * Click-to-drop location picker. With a Maps key it renders a real Google map;
 * a click drops/moves the pin and reports lat/lng. With no key it renders
 * nothing (the numeric inputs in the parent card remain the manual fallback),
 * matching the project's stub-when-empty maps convention.
 */
export function LocationPicker({ lat, lng, onPick }: LocationPickerProps) {
  if (!MAPS_KEY) return null;
  const has = lat != null && lng != null;
  const center = has ? { lat: lat as number, lng: lng as number } : BG_CENTROID;

  return (
    <div className="h-[260px] w-full overflow-hidden rounded-2xl border border-ff-border">
      <APIProvider apiKey={MAPS_KEY} language="bg" region="BG">
        <Map
          mapId={MAP_ID}
          defaultCenter={center}
          defaultZoom={has ? 14 : 7}
          gestureHandling="greedy"
          disableDefaultUI={false}
          style={{ width: '100%', height: '100%' }}
          onClick={(e) => {
            const ll = e.detail.latLng;
            if (ll) onPick(ll.lat, ll.lng);
          }}
        >
          {has && <AdvancedMarker position={{ lat: lat as number, lng: lng as number }} />}
        </Map>
      </APIProvider>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit` (from `client/`).
Expected: SUCCESS.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/maps/location-picker.tsx
git commit -m "feat(admin): click-to-drop LocationPicker"
```

---

### Task 9: „Контакти" admin page

**Files:**
- Create: `client/src/app/(admin)/contacts/page.tsx`

- [ ] **Step 1: Write the page**

Create `client/src/app/(admin)/contacts/page.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { Upload, Trash2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { LocationPicker } from '@/components/maps/location-picker';
import {
  getSiteContact,
  updateSiteContact,
  uploadFavicon,
  deleteFavicon,
  type SocialLink,
} from '@/lib/api-client';

const FAVICON_ACCEPT = 'image/png,image/x-icon,.ico,.png';

type Form = {
  address: string;
  hours: string;
  tagline: string;
  social: SocialLink[];
  mapLat: string;
  mapLng: string;
  themeColor: string;
};

const EMPTY: Form = {
  address: '', hours: '', tagline: '', social: [], mapLat: '', mapLng: '', themeColor: '',
};

export default function ContactsPage() {
  const [form, setForm] = useState<Form>(EMPTY);
  const [favicon, setFavicon] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);
  const iconRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getSiteContact()
      .then((res) => {
        setForm({
          address: res.contact.address ?? '',
          hours: res.contact.hours ?? '',
          tagline: res.contact.tagline ?? '',
          social: res.contact.social ?? [],
          mapLat: res.contact.mapLat ?? '',
          mapLng: res.contact.mapLng ?? '',
          themeColor: res.themeColor ?? '',
        });
        setFavicon(res.favicon?.url ?? null);
      })
      .catch(() => toast.error('Неуспешно зареждане'))
      .finally(() => setLoading(false));
  }, []);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setSocial(i: number, patch: Partial<SocialLink>) {
    setForm((f) => ({
      ...f,
      social: f.social.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    }));
  }

  function addSocial() {
    setForm((f) => (f.social.length >= 8 ? f : { ...f, social: [...f.social, { label: '', url: '' }] }));
  }

  function removeSocial(i: number) {
    setForm((f) => ({ ...f, social: f.social.filter((_, idx) => idx !== i) }));
  }

  async function save() {
    setSaving(true);
    try {
      await updateSiteContact({
        address: form.address,
        hours: form.hours,
        tagline: form.tagline,
        // Drop rows without a url — the API rejects non-url social links.
        social: form.social.filter((s) => s.url.trim()),
        mapLat: form.mapLat,
        mapLng: form.mapLng,
        themeColor: form.themeColor,
      });
      toast.success('Запазено');
    } catch {
      toast.error('Неуспешно записване');
    } finally {
      setSaving(false);
    }
  }

  async function pickIcon(file: File) {
    setIconBusy(true);
    try {
      const { url } = await uploadFavicon(file);
      setFavicon(url);
      toast.success('Иконата е качена');
    } catch {
      toast.error('Неуспешно качване');
    } finally {
      setIconBusy(false);
    }
  }

  async function removeIcon() {
    setIconBusy(true);
    try {
      await deleteFavicon();
      setFavicon(null);
      toast.success('Иконата е премахната');
    } catch {
      toast.error('Неуспешно изтриване');
    } finally {
      setIconBusy(false);
    }
  }

  if (loading) {
    return <p className="max-w-[900px] text-[14px] text-ff-muted">Зареждане…</p>;
  }

  const lat = form.mapLat ? Number(form.mapLat) : null;
  const lng = form.mapLng ? Number(form.mapLng) : null;

  const card = 'rounded-2xl border border-ff-border bg-ff-surface p-5 shadow-ff-sm';
  const label = 'mb-1 block text-[13px] font-bold text-ff-ink';
  const input =
    'w-full rounded-lg border border-ff-border bg-ff-surface px-3 py-2 text-[14px] text-ff-ink outline-none focus:border-ff-green-600';

  return (
    <div className="max-w-[900px]">
      <div className="mb-6">
        <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Контакти</h1>
        <p className="text-[13.5px] text-ff-muted">
          Контактна информация, социални мрежи и локация — показват се в долната част и на
          страница „Контакти" в магазина.
        </p>
      </div>

      <div className="flex flex-col gap-5">
        {/* Контакти */}
        <section className={card}>
          <h2 className="mb-3 text-[15px] font-extrabold">Информация за контакт</h2>
          <div className="flex flex-col gap-3">
            <div>
              <label className={label}>Адрес / място на пазара</label>
              <input className={input} value={form.address} onChange={(e) => set('address', e.target.value)}
                placeholder="кв. Чайка, бул. „Ал. Стамболийски“, Варна" />
            </div>
            <div>
              <label className={label}>Работно време</label>
              <input className={input} value={form.hours} onChange={(e) => set('hours', e.target.value)}
                placeholder="Всеки петък · 11:00–18:00" />
            </div>
            <div>
              <label className={label}>Кратко описание (във футъра)</label>
              <textarea className={`${input} min-h-[80px]`} value={form.tagline}
                onChange={(e) => set('tagline', e.target.value)}
                placeholder="Местни стопани на едно място — пазарувай на живо или поръчай онлайн." />
            </div>
          </div>
        </section>

        {/* Социални мрежи */}
        <section className={card}>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-extrabold">Социални мрежи</h2>
            <Button variant="soft" type="button" onClick={addSocial} disabled={form.social.length >= 8}
              className="gap-1.5 rounded-sm px-3 py-1.5 text-[13px]">
              <Plus size={15} /> Добави
            </Button>
          </div>
          {form.social.length === 0 ? (
            <p className="text-[13px] text-ff-muted">Няма добавени връзки.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {form.social.map((s, i) => (
                <div key={i} className="flex gap-2">
                  <input className={`${input} max-w-[160px]`} value={s.label}
                    onChange={(e) => setSocial(i, { label: e.target.value })} placeholder="Facebook" />
                  <input className={input} value={s.url}
                    onChange={(e) => setSocial(i, { url: e.target.value })}
                    placeholder="https://facebook.com/твоята-страница" />
                  <Button variant="ghost" type="button" onClick={() => removeSocial(i)}
                    title="Премахни" className="rounded-sm px-2.5 text-ff-red hover:bg-ff-red/10">
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-[12px] text-ff-muted">
            Връзката трябва да започва с https:// — иконата се познава по адреса (Facebook,
            Instagram, TikTok, YouTube), останалите получават обща икона.
          </p>
        </section>

        {/* Локация */}
        <section className={card}>
          <h2 className="mb-3 text-[15px] font-extrabold">Локация на картата</h2>
          <p className="mb-3 text-[13px] text-ff-muted">
            Кликни на картата, за да поставиш точката, или въведи координати ръчно.
          </p>
          <div className="mb-3">
            <LocationPicker lat={lat} lng={lng}
              onPick={(la, ln) => setForm((f) => ({ ...f, mapLat: la.toFixed(6), mapLng: ln.toFixed(6) }))} />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className={label}>Ширина (lat)</label>
              <input className={input} value={form.mapLat} onChange={(e) => set('mapLat', e.target.value)}
                placeholder="43.21" />
            </div>
            <div className="flex-1">
              <label className={label}>Дължина (lng)</label>
              <input className={input} value={form.mapLng} onChange={(e) => set('mapLng', e.target.value)}
                placeholder="27.91" />
            </div>
          </div>
        </section>

        {/* Иконка на сайта */}
        <section className={card}>
          <h2 className="mb-3 text-[15px] font-extrabold">Иконка на сайта</h2>
          <div className="flex items-center gap-4">
            <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl border border-ff-border bg-ff-surface-2">
              {favicon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={favicon} alt="Иконка" className="h-12 w-12 object-contain" />
              ) : (
                <span className="text-[11px] text-ff-muted">няма</span>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <input ref={iconRef} type="file" accept={FAVICON_ACCEPT} className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) pickIcon(file);
                  e.target.value = '';
                }} />
              <div className="flex gap-2">
                <Button variant="soft" type="button" disabled={iconBusy}
                  onClick={() => iconRef.current?.click()} className="gap-1.5 rounded-sm px-3 py-2 text-[13.5px]">
                  <Upload size={15} /> {favicon ? 'Смени' : 'Качи икона'}
                </Button>
                {favicon && (
                  <Button variant="ghost" type="button" disabled={iconBusy} onClick={removeIcon}
                    className="gap-1.5 rounded-sm px-3 py-2 text-[13.5px] text-ff-red hover:bg-ff-red/10">
                    <Trash2 size={15} /> Премахни
                  </Button>
                )}
              </div>
              <p className="text-[12px] text-ff-muted">PNG или ICO, до 512 KB.</p>
            </div>
          </div>

          <div className="mt-4">
            <label className={label}>Основен цвят (theme color)</label>
            <div className="flex items-center gap-2">
              <input type="color" value={form.themeColor || '#3F7D43'}
                onChange={(e) => set('themeColor', e.target.value)}
                className="h-9 w-12 cursor-pointer rounded border border-ff-border bg-ff-surface" />
              <input className={`${input} max-w-[140px]`} value={form.themeColor}
                onChange={(e) => set('themeColor', e.target.value)} placeholder="#3F7D43" />
              {form.themeColor && (
                <Button variant="ghost" type="button" onClick={() => set('themeColor', '')}
                  className="rounded-sm px-2.5 text-[13px] text-ff-muted">
                  Изчисти
                </Button>
              )}
            </div>
          </div>
        </section>

        <div className="sticky bottom-0 -mx-1 flex justify-end bg-gradient-to-t from-ff-bg to-transparent py-3">
          <Button type="button" onClick={save} disabled={saving}
            className="rounded-sm px-6 py-2.5 text-[14px] font-bold">
            {saving ? 'Запазване…' : 'Запази'}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

> Note: the `Button` variants used (`soft`, `ghost`, default) and the `ff-*` Tailwind tokens are the same ones the site-media page uses — copy any class that does not resolve from `client/src/app/(admin)/site-media/page.tsx`. If `ff-bg` is not a defined token, use `bg-white` for the sticky footer gradient origin.

- [ ] **Step 2: Type-check + lint**

Run: `npx tsc --noEmit && npm run lint` (from `client/`).
Expected: SUCCESS (lint may warn on the `img` element — the inline eslint-disable covers the favicon preview; add one to any other flagged `img`).

- [ ] **Step 3: Commit**

```bash
git add "client/src/app/(admin)/contacts/page.tsx"
git commit -m "feat(admin): Контакти page (contact, socials, map, favicon, theme)"
```

---

### Task 10: Sidebar nav entry

**Files:**
- Modify: `client/src/components/layout/sidebar.tsx`

- [ ] **Step 1: Add the icon import**

In `client/src/components/layout/sidebar.tsx`, add `Contact` to the `lucide-react` import block (e.g. after `BookOpen,`):

```ts
  Contact,
```

- [ ] **Step 2: Add the nav item**

In the `NAV_GROUPS` „Маркетинг" group `items` array, add after the `/site-media` entry:

```ts
      { href: '/contacts', label: 'Контакти', Icon: Contact, desc: 'Контактна информация, социални мрежи, локация и иконка на сайта.' },
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit` (from `client/`).
Expected: SUCCESS. (Hideable-nav keys off `href`, so the new item is automatically hide/show-able — no other change.)

- [ ] **Step 4: Commit**

```bash
git add client/src/components/layout/sidebar.tsx
git commit -m "feat(admin): add Контакти to sidebar nav"
```

---

## Phase C — Chaika storefront (`fermerski-pazar-chaika`)

> Separate repo at `C:\Users\Lenovo\source\repos\fermerski-pazar-chaika`. Commit there separately.

### Task 11: Types + social-icon resolution

**Files:**
- Modify: `fermerski-pazar-chaika/src/lib/types.ts`
- Modify: `fermerski-pazar-chaika/src/lib/icons.ts`
- Modify: `fermerski-pazar-chaika/src/lib/site.ts`
- Modify: `fermerski-pazar-chaika/src/lib/api.ts`

- [ ] **Step 1: Extend the `Storefront` type**

In `fermerski-pazar-chaika/src/lib/types.ts`, add to the `Storefront` interface after the `media?` field:

```ts
  // Editable contact block from the farm's admin. Optional (older backend) →
  // the storefront falls back to its static copy in site.ts.
  contact?: {
    address: string | null;
    hours: string | null;
    tagline: string | null;
    social: { label: string; url: string }[];
    mapLat: string | null;
    mapLng: string | null;
  };
  // Tenant website icon + browser theme color. Null/absent → static defaults.
  faviconUrl?: string | null;
  themeColor?: string | null;
```

- [ ] **Step 2: Add `yt` + `globe` icons**

In `fermerski-pazar-chaika/src/lib/icons.ts`, add two entries to the `ICONS` map (after the `tt:` entry):

```ts
  yt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.6 7.2a2.6 2.6 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.6 2.6 0 0 0 2.4 7.2 27 27 0 0 0 2 12a27 27 0 0 0 .4 4.8 2.6 2.6 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.6 2.6 0 0 0 1.8-1.8A27 27 0 0 0 22 12a27 27 0 0 0-.4-4.8ZM10 15V9l5.2 3Z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
```

- [ ] **Step 3: Add the resolver helpers to `site.ts`**

In `fermerski-pazar-chaika/src/lib/site.ts`, add a `Storefront` import at the top:

```ts
import type { Storefront } from './types';
```

Append at the bottom:

```ts
/** Pick an icon name (from icons.ts) for a social link by its URL hostname. */
export function socialIconName(url: string): string {
  const u = url.toLowerCase();
  if (u.includes('facebook') || u.includes('fb.com') || u.includes('fb.me')) return 'fb';
  if (u.includes('instagram') || u.includes('instagr.am')) return 'ig';
  if (u.includes('tiktok')) return 'tt';
  if (u.includes('youtube') || u.includes('youtu.be')) return 'yt';
  if (u.includes('viber')) return 'phone';
  return 'globe';
}

/** Resolved social links for rendering: live admin list if present, else the
 *  static SOCIALS fallback. Each row carries an href, label, and icon name. */
export function resolveSocials(sf: Storefront): { href: string; label: string; icon: string }[] {
  const live = (sf.contact?.social ?? []).filter((s) => s.url);
  if (live.length) {
    return live.map((s) => ({ href: s.url, label: s.label || 'Социална мрежа', icon: socialIconName(s.url) }));
  }
  return SOCIALS.map((s) => ({ href: s.href, label: s.label, icon: s.name }));
}

/** Contact fields with static fallbacks. */
export const contactAddress = (sf: Storefront) => sf.contact?.address || ADDRESS;
export const contactHours = (sf: Storefront) => sf.contact?.hours || MARKET_HOURS;
export const contactTagline = (sf: Storefront) =>
  sf.contact?.tagline ||
  'Фермерски пазар на Чайка, Варна. Местни стопани на едно място — пазарувай на живо всеки петък или поръчай онлайн с доставка до дома.';
```

- [ ] **Step 4: Add the new fields to `FALLBACK_STOREFRONT`**

In `fermerski-pazar-chaika/src/lib/api.ts`, add to the `FALLBACK_STOREFRONT` object (after `media: {},`):

```ts
  contact: { address: null, hours: null, tagline: null, social: [], mapLat: null, mapLng: null },
  faviconUrl: null,
  themeColor: null,
```

- [ ] **Step 5: Type-check**

Run: `npx astro check` (from `fermerski-pazar-chaika/`) — or `npx tsc --noEmit`.
Expected: SUCCESS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts src/lib/icons.ts src/lib/site.ts src/lib/api.ts
git commit -m "feat: storefront contact/favicon/theme types + social resolver"
```

---

### Task 12: Footer uses live contact

**Files:**
- Modify: `fermerski-pazar-chaika/src/components/Footer.astro`

- [ ] **Step 1: Update the frontmatter + markup**

Replace the frontmatter imports/consts and the two affected markup blocks in `fermerski-pazar-chaika/src/components/Footer.astro`.

Frontmatter — replace the `site` import line + derived consts:

```astro
import { DEFAULT_PHONE, DEFAULT_EMAIL, telHref, resolveSocials, contactAddress, contactHours, contactTagline } from '../lib/site';
import { ADMIN_LOGIN_URL } from '../lib/config';
import type { Storefront } from '../lib/types';

interface Props { storefront: Storefront }
const { storefront } = Astro.props;
const phone = storefront.phone || DEFAULT_PHONE;
const email = storefront.email || DEFAULT_EMAIL;
const socials = resolveSocials(storefront);
const year = 2026;
```

Replace the tagline paragraph (the hardcoded `<p>…Фермерски пазар на Чайка…</p>`):

```astro
      <p style="margin-top:14px;opacity:.85;max-width:32ch;font-size:15px">
        {contactTagline(storefront)}
      </p>
      <div class="socials">
        {socials.map((s) => (
          <a href={s.href} aria-label={s.label} target="_blank" rel="noopener"><Icon name={s.icon} /></a>
        ))}
      </div>
```

Replace the „Пазар & контакти" `footer-contact` block:

```astro
      <div class="footer-contact">
        {contactAddress(storefront)}<br>
        <b style="color:#fff">{contactHours(storefront)}</b><br>
        <a href={telHref(phone)}>{phone}</a><br>
        <a href={`mailto:${email}`}>{email}</a>
      </div>
```

- [ ] **Step 2: Visual check (deferred to Task 16); commit**

```bash
git add src/components/Footer.astro
git commit -m "feat: footer reads live contact + socials"
```

---

### Task 13: Contact page uses live contact + map

**Files:**
- Modify: `fermerski-pazar-chaika/src/pages/contact.astro`

- [ ] **Step 1: Update frontmatter**

In `fermerski-pazar-chaika/src/pages/contact.astro`, replace the `site` import + consts:

```astro
import { DEFAULT_PHONE, DEFAULT_EMAIL, telHref, resolveSocials, contactAddress, contactHours } from '../lib/site';

const sf = (await getStorefront()) ?? FALLBACK_STOREFRONT;
const phone = sf.phone || DEFAULT_PHONE;
const email = sf.email || DEFAULT_EMAIL;
const socials = resolveSocials(sf);
const address = contactAddress(sf);
const hours = contactHours(sf);
// Map: prefer the admin pin (lat,lng); else the address text. Keyless embed.
const mapQuery =
  sf.contact?.mapLat && sf.contact?.mapLng
    ? `${sf.contact.mapLat},${sf.contact.mapLng}`
    : address;
const mapSrc = `https://www.google.com/maps?q=${encodeURIComponent(mapQuery)}&z=15&hl=bg&output=embed`;
```

- [ ] **Step 2: Update the address + socials markup**

Replace the „Пазар на място" card body and the socials block:

```astro
            <div class="card" style="padding:20px;display:flex;gap:14px;align-items:center">
              <span class="contact-ic"><Icon name="pin" /></span>
              <span><span class="muted" style="font-size:13px">Пазар на място</span><br><b>{address}</b> · {hours}</span>
            </div>
```

```astro
            <div>
              <div class="muted" style="font-size:13.5px;margin-bottom:10px">Последвай ни</div>
              <div class="socials" style="margin:0">
                {socials.map((s) => (
                  <a href={s.href} aria-label={s.label} target="_blank" rel="noopener" style="background:var(--primary-050);color:var(--primary)"><Icon name={s.icon} /></a>
                ))}
              </div>
            </div>
```

- [ ] **Step 3: Commit**

```bash
git add src/pages/contact.astro
git commit -m "feat: contact page reads live contact, socials + map pin"
```

---

### Task 14: Layout favicon + theme color

**Files:**
- Modify: `fermerski-pazar-chaika/src/components/Layout.astro`

- [ ] **Step 1: Derive favicon + theme in frontmatter**

In `fermerski-pazar-chaika/src/components/Layout.astro`, add after the `const desc = …` block:

```astro
const favicon = storefront.faviconUrl || '/favicon.svg';
const faviconType = favicon.endsWith('.svg')
  ? 'image/svg+xml'
  : favicon.endsWith('.png')
    ? 'image/png'
    : favicon.endsWith('.ico')
      ? 'image/x-icon'
      : undefined;
const themeColor = storefront.themeColor || '#3F7D43';
```

- [ ] **Step 2: Use them in `<head>`**

Replace the static `theme-color` meta + favicon link:

```astro
  <meta name="theme-color" content={themeColor} />
  <link rel="icon" href={favicon} type={faviconType} />
```

(Astro omits `type` when `faviconType` is `undefined`.)

- [ ] **Step 3: Type-check + commit**

Run: `npx astro check` (from `fermerski-pazar-chaika/`).
Expected: SUCCESS.

```bash
git add src/components/Layout.astro
git commit -m "feat: dynamic favicon + theme-color from storefront profile"
```

---

## Phase D — Verify

### Task 15: Builds + full server test suite

- [ ] **Step 1: Server**

Run (from `server/`): `npm run build && npm test`
Expected: build SUCCESS; all tests PASS (existing + new magic-mime/dto/helper specs).

- [ ] **Step 2: Admin client**

Run (from `client/`): `npm run build`
Expected: SUCCESS.

- [ ] **Step 3: Chaika**

Run (from `fermerski-pazar-chaika/`): `npx astro check && npm run build`
Expected: SUCCESS.

---

### Task 16: Live end-to-end verification

Use the project's dev workflow (`project_farmflow_dev_verify` memory: preview runs `next start`, rebuild to see admin changes; re-seed rotates tenant ids → re-login). Verify against a running API + admin + chaika.

- [ ] **Step 1: Admin round-trip** — log into the admin, open „Контакти". Fill address/hours/tagline, add 2 social links (a Facebook URL + an arbitrary site), drop a map pin, pick a theme color, upload a PNG favicon, Save. Reload the page → all values persist (proves GET + PATCH + favicon upload + jsonb writes).

- [ ] **Step 2: Favicon validation** — try uploading a `.jpg` renamed to `.png` (or any non-PNG/ICO) → expect a rejection toast (proves magic-mime guard). Upload a real `.ico` → succeeds.

- [ ] **Step 3: Public API** — `curl http://localhost:3000/public/<slug>` (and `/public/<slug>/bootstrap`) → response includes `contact` (with the saved fields + social array), `faviconUrl`, `themeColor`. Save again in admin and re-curl → values updated (proves cache invalidation).

- [ ] **Step 4: Chaika render** — load the chaika home + `/contact`. Footer shows the live address/hours/tagline + social icons (FB icon for the Facebook URL, globe for the arbitrary one). Contact page map centers on the dropped pin. Browser tab shows the uploaded favicon; `<meta name=theme-color>` matches the chosen color (view source). Remove the favicon in admin → chaika falls back to `/favicon.svg`.

- [ ] **Step 5:** If all pass, the feature is complete. Note any deviations.

---

## Self-review notes

- **Spec coverage:** address/hours/tagline (Tasks 3,9,12,13), arbitrary socials (Tasks 9,11,12,13), map location (Tasks 8,9,13), favicon PNG/ICO + magic-mime (Tasks 1,5,6,9), theme color (Tasks 3,5,9,14), public API + cache (Tasks 3,4), new dedicated admin page + nav (Tasks 9,10), chaika consumption with fallback (Tasks 11–14). All spec sections mapped.
- **Storage refinement vs spec:** `brand.favicon = {url,key}` (object) instead of flat `faviconUrl/faviconKey` — one atomic path write, never clobbers `themeColor`. Public shape (`faviconUrl`, `themeColor`) unchanged.
- **Type consistency:** `buildPublicContact`/`normalizeSiteContact`/`PublicContact`/`readBrand` names are used identically across Tasks 3–6; `SiteContact`/`SocialLink`/`getSiteContact`/`updateSiteContact`/`uploadFavicon`/`deleteFavicon` identical across Tasks 7,9; `resolveSocials`/`socialIconName`/`contactAddress`/`contactHours`/`contactTagline` identical across Tasks 11–13.
- **Circular-import avoided:** pure helpers + public contact types live in the leaf `site-contact.ts` (Task 3), imported by both `tenants.service.ts` and `public-cache.service.ts` — no value cycle.
- **Known verify-live points:** global `ValidationPipe` nested validation for `social[]` (functionally backstopped by `normalizeSiteContact` regardless); bootstrap composition (Task 4 Step 3 + Task 16 Step 3).
