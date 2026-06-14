# R2 keys by tenant slug — design spec

**Date:** 2026-06-14
**Status:** code + dry-run migration script done on `feat/r2-slug-keys`; migration NOT executed
**Scope:** FarmFlow backend (`server/`). No storefront change (the CDN helper keys off
the URL path, so a new prefix is transparent).

## Goal

Store every farm's images under one human-readable bucket folder
`tenants/{slug}/…` instead of `tenants/{uuid}/…`, so the R2 bucket is browsable by
farm name. Today everything is already grouped per tenant, but the folder is the
tenant UUID — unreadable, and re-seeds leave several UUID folders per farm.

## Trade-off (accepted)

UUID was chosen because it is **immutable**; a slug **changes on rename**, after
which new uploads land in a new slug folder while old objects keep the old one
(split). In practice the slug is the storefront identifier (`PUBLIC_TENANT_SLUG`)
and effectively stable; on a rename, re-run the migration. Readability is worth it.

## Code (new uploads)

- `server/src/common/tenant-slug.util.ts` — `tenantSlug(db, tenantId)` resolves the
  slug (one indexed lookup; uploads are infrequent admin actions).
- Every upload key now uses the slug: products (cover + gallery), farmers (×2),
  subcategories (×2), articles (cover + inline), tenants (site media + favicon).
  `tenants.service` already had the slug from `loadTenantForMedia`; the other
  services call `tenantSlug`.

## Migration (existing objects) — `server/scripts/migrate-r2-slug-keys.mjs`

DRY-RUN by default; `--execute` to perform. Per tenant:
1. list `tenants/{id}/…`, copy each to `tenants/{slug}/…` (CopyObject, metadata
   preserved);
2. rewrite DB URLs with a host-agnostic substring replace `tenants/{id}/` →
   `tenants/{slug}/` across products/productMedia/farmers/farmerMedia/
   subcategories/subcategoryMedia/articles/articleMedia + the `tenants.settings`
   jsonb (media urls + favicon url & key);
3. delete the old objects (only after copy + DB succeed).

The path-substring replace fixes both legacy `pub-*.r2.dev` and `cdn.` URLs.

⚠ Run against production R2 + DB; take a DB snapshot first. Sequence with the CDN
go-live so URLs change once, not twice.

## Verify

- `tsc` green; no spec asserts the old key format.
- Run the migration in dry-run first and review the per-tenant plan before
  `--execute`.
