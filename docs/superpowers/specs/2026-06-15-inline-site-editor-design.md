# Inline Site Editor (v3) — edit text + photos directly on the live storefront

**Date:** 2026-06-15
**Status:** Design — approved pending user spec review
**Supersedes:** the v2 admin iframe-preview editor (shipped `ed6b7c8`). The cross-origin iframe was blocked in practice (frame-ancestors locked to one origin) and the side-by-side field+preview model tested as unintuitive. v3 replaces it with a WYSIWYG "edit on your live site" model. Storage + the storefront slot registry are **reused unchanged** (no data migration; slot keys preserved).

## Goal

Make editing the storefront intuitive and reliable: the farmer clicks **„Редактирай сайта"** in the admin, their own site opens in an **edit mode**, and they click any text or photo to change it in place (WordPress/Wix-style), with one save. No embedded iframe (the source of the breakage), no manually-typed site URL, no abstract field list.

## Why this shape

- **Reliability:** the edit UI runs *on the storefront's own origin*, so there is no cross-origin framing to be blocked. (v2 failed because `frame-ancestors` can only allow one exact admin origin, and the admin in use wasn't that origin — which also CORS-blocked the manifest, leaving an empty editor.)
- **Intuitive:** you edit what you see, where you see it.
- **No manual URL:** the operator sets the site URL once at provisioning; the farmer only clicks a button.

## Architecture

```
Admin „Промени сайта" = [Редактирай сайта] button
        │ POST tenants/me/edit-session (admin JWT)
        ▼
   { token (30m, scoped), siteUrl }  ──► window.open(`${siteUrl}/?edit=<token>`)
        │
        ▼  (on the storefront origin)
  edit-overlay.js  ──fetch /editable-manifest.json (same-origin: slot kinds/labels)
                   ──fetch  {API}/tenants/me/site-edit/data  (Bearer token: current overrides)
   click text → inline edit ; click photo → upload ; FAQ → inline add/edit/reorder
        │ Save
        ▼
  {API}/tenants/me/site-edit/{content,media}  (Bearer token, EditSessionGuard → tenantId)
        ▼
   FarmFlow settings.{copy,media,faq}  (slot-agnostic store, reused from v2)
```

## Components

### A. Edit-session token (FarmFlow server)

- `POST tenants/me/edit-session` — `@Roles('admin')` (owner-level, same as the rest of site editing), normal admin JWT. Returns `{ token: string; siteUrl: string; expiresIn: number }`.
- Token: `jwt.signAsync({ sub: tenantId, type: 'site-edit' }, { secret: EDIT_TOKEN_SECRET, expiresIn: '30m' })`. **Separate secret** (env `EDIT_TOKEN_SECRET`, like the reset-token secret) so the token can NEVER pass the normal `JwtAuthGuard` (which uses the main secret + expects `type:'tenant'`).
- If `settings.siteUrl` is empty → 400 `{ message: 'Адресът на сайта не е зададен' }` (the admin button is disabled in that case anyway).

### B. Edit routes + guard (FarmFlow server)

- New `EditSessionGuard`: reads `Authorization: Bearer`, verifies with `EDIT_TOKEN_SECRET`, requires `type === 'site-edit'`, sets `req.tenantId = payload.sub`. Rejects (401) otherwise. Applied ONLY to the `site-edit` routes — the token works nowhere else.
- New routes (in `TenantsController`, or a small `SiteEditController`), guarded by `EditSessionGuard` (NOT `JwtAuthGuard`):
  - `GET tenants/me/site-edit/data` → `{ copy, media, faq }` (current overrides; reuse `getSiteCopy` minus `siteUrl`).
  - `PATCH tenants/me/site-edit/content` → body `{ copy, faq }` → `setSiteCopyContent(tenantId, {copy,faq})` (writes copy+faq only; siteUrl untouched).
  - `POST tenants/me/site-edit/media/:slotKey` (multipart) → `setSiteMedia` (unchanged validation: mime, size, `isValidSlotKey`).
  - `DELETE tenants/me/site-edit/media/:slotKey` → `deleteSiteMedia`.
- Service: add `setSiteCopyContent(tenantId, {copy,faq})` (2-level atomic `jsonb_set` of copy+faq; bust cache). Keep `setSiteMedia`/`deleteSiteMedia` as-is. `cleanCopy`/`normalizeFaq` reused.
- **Remove the v2 admin site-copy routes** `GET`/`PATCH tenants/me/site-copy` (and `SiteCopyDto`) — v3 edits go through `edit-session` + `site-edit/*`. Refactor the projection used by them into a small reusable helper that `GET site-edit/data` calls (returns `{copy,media,faq}`, no `siteUrl`). `siteUrl` is now written only by the provisioning path (Component E), so it leaves `setSiteCopy` entirely; the content writer is `setSiteCopyContent({copy,faq})`.

### C. CORS (FarmFlow server)

- The overlay calls the API cross-origin (storefront origin → API host). Add the storefront origin(s) to the `CORS_ORIGIN` allowlist (env) so `site-edit/*` requests with `Authorization` succeed. `Access-Control-Allow-Headers` must include `authorization, content-type`. Admin routes remain locked to the admin origin (existing behavior); `/public/*` stays open.
- Practically: `CORS_ORIGIN` becomes a comma-separated list including the admin origin + each storefront origin (e.g. `https://app.farmsteadflow.com,https://pazarchaika.farmsteadflow.com`).

### D. chaika — edit overlay + cleanup

**`src/scripts/edit-overlay.ts`** (new), loaded by `Layout.astro` only when `?edit=` is present:
1. Capture the token from `?edit=`, then `history.replaceState` to strip it from the URL.
2. Fetch `/editable-manifest.json` (same-origin) → slot kinds/labels; fetch `${PUBLIC_API_BASE}/tenants/me/site-edit/data` with `Authorization: Bearer <token>` → current `{copy,media,faq}`.
3. For each `[data-editable-slot]`: if the slot kind is `text` → make it inline-editable (click → `contenteditable` or swap to an `<input>/<textarea>`, Enter/blur commits to a local draft); if `image` → click → hidden file input → `POST site-edit/media/:slotKey` → swap the rendered `<img>`.
4. On `/faq`: render small controls on each Q&A (edit inline, ↑/↓, ✕) + an „+ Добави въпрос" — maintained as a local faq draft.
5. Floating toolbar (fixed): „Запази" (PATCH `site-edit/content` with the copy+faq draft; media already saved on upload) + „Изход" (leave edit mode → reload without `?edit`). Dirty indicator. Toast on save.
6. Errors: expired/invalid token (401) → message „Сесията изтече, отвори пак от панела"; network → retry.

**`src/middleware.ts`**: REMOVE the `?preview=1` framing-relaxation branch — revert to always `X-Frame-Options: DENY` + `frame-ancestors 'none'` (no embedding anymore → safer). Keep nosniff/Referrer/HSTS + the HTML edge-cache block. (Edit mode pages: add `Cache-Control: no-store` when `?edit=` is present so a cached page isn't edited.)

**`src/components/Layout.astro`**: REMOVE the `?preview=1` postMessage scroll listener; ADD `{isEdit && <script src="/src/scripts/edit-overlay.ts" …>}` (Astro `<script>` import gated by `?edit=`).

**Reused unchanged:** `editable-manifest.ts` registry, `editable-manifest.json.ts` endpoint, `CopySlot`/`MediaSlot` (registry-driven + `data-editable-slot`), `data-copy-section` anchors (harmless; can stay).

### E. Super-admin provisioning — siteUrl

- Add a `siteUrl` field to the platform (super-admin) tenant create/edit path: the platform tenant-update DTO + endpoint accept `siteUrl`, stored in `settings.siteUrl` via `sanitizeSiteUrl`. Add the input to the super-admin tenant form.
- (Find the exact platform tenant-update endpoint + form during planning.)

### F. Admin „Промени сайта" screen → launch button

- Replace `site-editor.tsx` + `preview-pane.tsx` with a simple screen: heading + a short explainer + a **„Редактирай сайта"** button. On click: `POST tenants/me/edit-session` → `window.open(`${siteUrl}/?edit=${token}`, '_blank')`. If the API returns 400 (no siteUrl) or the button is known-disabled → show „Адресът на сайта още не е зададен — свържи се с поддръжката."
- `api-client.ts`: add `createEditSession()` → `{token, siteUrl, expiresIn}`. Remove `getSiteCopy`/`updateSiteCopy`/`getEditableManifest`/manifest types (v2, now unused) + the v2 editor files.

## Data flow (one edit)

1. Farmer clicks „Редактирай сайта" → token + siteUrl → site opens in edit mode.
2. Overlay loads current content; farmer clicks a heading, types, clicks Запази.
3. `PATCH site-edit/content` (Bearer token) → `setSiteCopyContent` → `settings.copy`/`faq` updated → cache bust.
4. The page reflects edits immediately (overlay updated the DOM); a normal reload re-renders override-or-default.

## Error handling

- Token expired/invalid → overlay shows a re-open prompt; API returns 401.
- `siteUrl` unset → edit-session 400 + disabled button with guidance.
- Media upload failure → toast, slot keeps its previous image.
- Storefront unreachable → the button just opens a normal failed tab (no admin breakage).
- CORS misconfig (storefront origin not allowed) → overlay save fails with a clear console + toast; documented as a deploy step.

## Security

- Edit token: separate secret, `type:'site-edit'`, tenant-scoped, 30 min, accepted ONLY by `EditSessionGuard` on `site-edit/*`. Stripped from the URL after load. A leaked token can only edit that one tenant's site content for ≤30 min — it cannot touch auth, billing, or other tenants.
- CORS opens the storefront origin only for `site-edit/*` + public; admin routes stay origin-locked.
- Media validation unchanged. `siteUrl` is provisioning-only (farmer can't repoint their site).

## Testing

- **Server:** edit-session issues a 30m `type:'site-edit'` token; `EditSessionGuard` accepts a valid edit token + rejects a normal tenant JWT and an expired/wrong-type token; `site-edit/content` writes copy+faq (not siteUrl) + busts cache; `site-edit/media` validates keys; edit-session 400 when siteUrl empty; the site-edit token is rejected on a normal admin route.
- **chaika:** `astro build` green; overlay loads only with `?edit=`; middleware always `DENY` now.
- **Admin/super-admin:** tsc + build; provisioning siteUrl persists.
- **Live E2E:** super-admin sets siteUrl → farmer clicks „Редактирай сайта" → site opens in edit mode → edit a heading + upload a photo + add an FAQ item → Запази → reload shows the changes; token expired → guarded; site-edit token rejected on `/tenants/me` (admin route).

## Migration / deploy

- **No DB migration** (`settings.siteUrl`/`copy`/`media`/`faq` already exist; slot keys preserved).
- Server: add `EDIT_TOKEN_SECRET` env; add storefront origin(s) to `CORS_ORIGIN`. Redeploy.
- chaika: auto-deploys (overlay + middleware revert). `PUBLIC_API_BASE` already points at the API.
- Super-admin sets each farm's `siteUrl` once.

## Out of scope (v3)

- Editing header/footer or layout/structure (only the registry's text+photo slots + FAQ).
- Adding brand-new slots/pages from the UI (still a dev act in the chaika registry — the "autonomous" boundary).
- Rich-text formatting in slots (plain text + line breaks).
- Real-time multi-user editing.
