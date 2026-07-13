# Operator legal identity settings — design

Date: 2026-07-13
Status: Approved (brainstorming), pending implementation plan
Repo: FarmFlow · Branch: `feat/operator-legal-settings`

## Problem

The handover-protocol feature's `buildDraft` requires `tenants.settings.legal` (the
operator's legal identity, as `to`/`from` in the two protocol kinds) via `requireLegal`.
It throws "Липсват легални данни за оператор" — but no admin UI exists to fill that field
in. `LegalIdentity`/`TenantSettings` types already exist (`packages/types/src/index.ts:55-73`,
merged with the handover-protocol feature); nothing writes to them for tenants yet.

## Decisions from brainstorming

- Field set: full `kind` selector (individual/sole_trader/company) with conditional fields,
  identical shape to `farmers.legal` — user chose to keep the existing farmer-legal shape
  rather than simplify to fewer kinds.
- Scope: settings form only. **No shortcut link from the "Липсват легални данни" error** —
  the operator navigates to Settings themselves. (Explicitly decided against, to keep this
  change minimal.)

## Existing foundation

- **DTO shape to mirror:** `server/src/modules/farmers/dto/legal.dto.ts` — `kind`, `name`,
  `eik`, `vatNumber`, `address`, `regNo`, `confirmedAt`, all optional, `class-validator`.
- **Backend write pattern to mirror:** dedicated sub-resource endpoints with atomic
  `jsonb_set` (NOT the generic read-modify-write `UpdateTenantDto` path) — see
  `tenants.service.ts`'s `getSiteContact`/`updateSiteContact` (~line 370-419) and
  `tenants.controller.ts`'s `GET/PATCH tenants/me/site-contact` (~line 90-96). This is the
  newer, safer convention in this module (no read-then-replace race).
- **Frontend hub:** `client/src/app/(admin)/settings/page.tsx` +
  `client/src/components/settings/configurations-card.tsx` — `ConfigKey` tiles
  (`'setup' | 'delivery' | 'slots' | 'features' | 'merchandising' | 'landing' | 'marketing'`,
  `configurations-card.tsx:14-20`). `'setup'` is payment/delivery methods ("Методи и цени"),
  NOT company profile — confirmed no existing tile fits; this needs a **new** `'legal'` tile.
- **Form-field shape to mirror:** `client/src/components/farmers/farmer-panel.tsx:334-404`
  — the "Юридически данни · продавач" card: `kind` select, conditional `eik`/`regNo`,
  `vatNumber`, `address`, with `confirmedAt` set on save (not client-editable).
- Types: `packages/types/src/index.ts:55-73` (`LegalIdentity = FarmerLegal`,
  `TenantSettings { legal?: LegalIdentity }`) — already exist, no change needed.

## Backend

`server/src/modules/tenants/dto/legal.dto.ts` — **new, separate** DTO copying
`farmers/dto/legal.dto.ts`'s fields/validators verbatim (not a shared import — tenant and
farmer legal identity are separate bounded resources, even though the shape matches today).

`tenants.service.ts` — add:
```ts
async getLegal(tenantId: string): Promise<LegalIdentity | null> {
  const settings = await this.loadSettings(tenantId);
  return settings.legal ?? null;
}

async updateLegal(tenantId: string, dto: LegalDto): Promise<LegalIdentity> {
  const legal = { ...dto, confirmedAt: new Date().toISOString() };
  await this.db
    .update(tenants)
    .set({
      settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['legal'], ${JSON.stringify(legal)}::jsonb, true)`,
    })
    .where(eq(tenants.id, tenantId));
  return legal;
}
```
`confirmedAt` is always server-stamped on save (audit trail), never accepted from the
client — mirrors the farmer flow's intent even though the farmer DTO technically accepts
it as input (server overwrite here is a deliberate tightening, not a copy of a bug).

`tenants.controller.ts` — add:
```ts
@ApiOperation({ summary: 'Operator legal identity (for handover-protocol documents)' })
@Get('me/legal')
getLegal(@CurrentTenant() tenantId: string) {
  return this.tenantsService.getLegal(tenantId);
}

@ApiOperation({ summary: 'Update operator legal identity' })
@Patch('me/legal')
updateLegal(@CurrentTenant() tenantId: string, @Body() dto: LegalDto) {
  return this.tenantsService.updateLegal(tenantId, dto);
}
```

## Frontend

- `configurations-card.tsx`: add `'legal'` to the `ConfigKey` union and its tile —
  label „Легални данни", desc „Данни на оператора за приемо-предавателни протоколи и
  разписки.", route `/settings/legal`.
- `client/src/app/(admin)/settings/legal/page.tsx` — minimal server component rendering
  `<LegalSettingsClient />` (mirrors `farmer-delivery/page.tsx`'s minimal pattern).
- `client/src/components/settings/legal-settings-client.tsx` — form mirroring
  `farmer-panel.tsx`'s legal card: `kind` select → conditional `eik` (sole_trader/company)
  or `regNo` (individual), `name`, `vatNumber` (company only, optional), `address`. Loads
  via `getTenantLegal()`, saves via `updateTenantLegal(dto)`, toast on success/error
  (`sonner`, matching existing admin conventions).
- `api-client.ts`: add `getTenantLegal()` → `GET tenants/me/legal`, `updateTenantLegal(dto)`
  → `PATCH tenants/me/legal`.
- `types.ts`: reuse the existing `LegalIdentity` type (already added for the handover
  protocol feature) — no new type needed.

## Testing (TDD)

Backend:
- `updateLegal` writes an atomic `jsonb_set` under the `legal` path, stamps `confirmedAt`
  server-side (ignoring any client-sent value), preserves other `settings` keys untouched.
- `getLegal` returns `null` when unset, the stored object when set.
- Tenancy: `me/legal` routes scope to `@CurrentTenant()` (existing guard pattern — no new
  guard code, but the controller test should confirm the routes exist under the same
  guard as `site-contact`).

Frontend:
- No dedicated test framework covers this form's runtime interaction in this codebase
  (matches the precedent set by other settings forms) — `pnpm --filter @fermeribg/web
  build` is the covering check.

## Scope (YAGNI)

**In scope:** the form + the two endpoints + the new settings tile.
**Out of scope (explicitly deferred by user):** a shortcut link from the handover-protocol
"Липсват легални данни" error message to `/settings/legal`.
