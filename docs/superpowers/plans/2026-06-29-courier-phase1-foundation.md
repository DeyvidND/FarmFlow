# Courier per-farmer — Phase 1 (foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Vasil (farmer-admin) enable courier per farmer; let each enabled farmer open a self-scoped "Доставки" view (SSO into dostavki) and connect their own Speedy/Econt — connection state synced between the farmer panel and dostavki.

**Architecture:** Carrier credentials live in `tenants.settings.delivery.{econt,speedy}` (JSONB, encrypted), keyed by `tenantId`. A farmer's delivery account is a **sub-namespace** of the marketplace tenant: `tenants.settings.delivery.farmers[<farmerId>].{econt,speedy}`. The delivery JWT already carries an optional `farmerId`; we thread it from the request into the delivery services' storage path via a `@CurrentFarmer()` decorator and a per-service `settingsPath(farmerId?)` helper. The existing SSO handoff is reused, extended to put `farmerId` in the token so a farmer lands in dostavki scoped to themselves. No new tenants, no new creds table.

**Tech Stack:** NestJS + Drizzle ORM (server), Next.js App Router (client farmer panel + delivery-web dostavki), PostgreSQL JSONB, Jest.

**Spec:** `docs/superpowers/specs/2026-06-29-courier-per-farmer-delivery-design.md`

**Out of scope (later phases):** storefront courier option + cart split (Phase 2), order auto-distribution into drafts (Phase 3). This plan ships the account/credentials/SSO foundation only.

---

## File map

**Create**
- `packages/db/drizzle/0069_farmers_courier_enabled.sql` — migration
- `server/src/common/decorators/current-farmer.decorator.ts` — `@CurrentFarmer()`
- `client/src/app/(admin)/farmer-delivery/page.tsx` — farmer "Доставки" page (SSO + carrier-connect)
- `client/src/components/farmer-delivery/farmer-delivery-client.tsx` — its client component

**Modify**
- `packages/db/src/schema.ts` — `farmers.courier_enabled`
- `packages/db/drizzle/meta/_journal.json` — journal entry idx 69
- `server/src/modules/farmers/dto/update-farmer.dto.ts` — `courierEnabled?`
- `server/src/modules/farmers/farmers.service.ts:181` — persist `courierEnabled`
- `server/src/modules/econt/econt.service.ts` — `settingsPath(farmerId?)` + thread `farmerId`
- `server/src/modules/speedy/speedy.service.ts` — `settingsPath(farmerId?)` + thread `farmerId`
- `server/src/modules/econt-app/econt-standalone.controller.ts` — `@CurrentFarmer()` on cred/config routes
- `server/src/modules/speedy/speedy.controller.ts` (standalone routes) — `@CurrentFarmer()`
- `server/src/modules/auth/auth.service.ts:307` — `issueDeliveryHandoff` puts `farmerId` in token; `sign()` already supports it
- `client/src/lib/types.ts` — `Farmer.courierEnabled`
- `client/src/components/farmers/farmer-panel.tsx` — courier toggle
- `client/src/components/layout/sidebar.tsx` — `FARMER_NAV` add "Доставки"
- `client/src/components/layout/farmer-route-guard.tsx` — allow `/farmer-delivery`
- `client/src/lib/api-client.ts` — already has `requestDeliveryHandoff`, `getEcontConfig`, `saveEcontCredentials`; add Speedy equivalents if missing

---

## Task 1: Migration + schema for `farmers.courier_enabled`

**Files:**
- Create: `packages/db/drizzle/0069_farmers_courier_enabled.sql`
- Modify: `packages/db/src/schema.ts` (farmers table)
- Modify: `packages/db/drizzle/meta/_journal.json`

- [ ] **Step 1: Write the migration SQL**

Create `packages/db/drizzle/0069_farmers_courier_enabled.sql`:

```sql
-- Per-farmer courier opt-in. Vasil (farmer-admin) toggles this from the tenant
-- "Фермери" section. Only courier-enabled farmers with a connected carrier offer
-- the storefront courier option (Phase 2).
ALTER TABLE "farmers" ADD COLUMN "courier_enabled" boolean DEFAULT false NOT NULL;
```

- [ ] **Step 2: Add the journal entry**

In `packages/db/drizzle/meta/_journal.json`, append after the `idx: 68` entry (mind the comma):

```json
    {
      "idx": 69,
      "version": "7",
      "when": 1783069200000,
      "tag": "0069_farmers_courier_enabled",
      "breakpoints": true
    }
```

- [ ] **Step 3: Add the column to the Drizzle schema**

In `packages/db/src/schema.ts`, in the `farmers` table definition, add alongside the other columns:

```ts
    courierEnabled: boolean('courier_enabled').notNull().default(false),
```

Ensure `boolean` is in the `drizzle-orm/pg-core` import at the top of the file (it is already used elsewhere).

- [ ] **Step 4: Build the db package**

Run: `cd packages/db && npm run build`
Expected: clean tsc, no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/drizzle/0069_farmers_courier_enabled.sql packages/db/drizzle/meta/_journal.json packages/db/src/schema.ts
git commit -m "feat(db): farmers.courier_enabled (migration 0069)"
```

---

## Task 2: Farmers API accepts `courierEnabled`

**Files:**
- Modify: `server/src/modules/farmers/dto/update-farmer.dto.ts`
- Modify: `server/src/modules/farmers/farmers.service.ts:181`
- Test: `server/src/modules/farmers/farmers.update.spec.ts` (create if absent; otherwise add to an existing farmers spec)

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/farmers/farmers.update.spec.ts`:

```ts
import { FarmersService } from './farmers.service';

/** Minimal chainable db stub capturing the update set-payload. */
function fakeDb(captured: { set?: Record<string, unknown> }) {
  const upd = {
    set: (v: Record<string, unknown>) => {
      captured.set = v;
      return { where: () => ({ returning: async () => [{ id: 'f1', courierEnabled: v.courierEnabled }] }) };
    },
  };
  // farmers.update reads the row first (ownership) then updates.
  const sel = { from: () => sel, where: () => sel, limit: async () => [{ id: 'f1', tenantId: 't1' }] };
  return { select: () => sel, update: () => upd } as never;
}

describe('FarmersService.update — courierEnabled', () => {
  it('persists courierEnabled when provided', async () => {
    const captured: { set?: Record<string, unknown> } = {};
    const svc = new FarmersService(fakeDb(captured), {} as never);
    await svc.update('f1', 't1', { courierEnabled: true } as never);
    expect(captured.set?.courierEnabled).toBe(true);
  });
});
```

> Note: match the real `FarmersService` constructor args. Open `farmers.service.ts` and mirror its constructor (db token + any cache/service). Adjust the stub's chain to the exact calls `update()` makes (read `farmers.service.ts:181` first).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx jest farmers.update -v`
Expected: FAIL (`courierEnabled` not in the update payload, or compile error on the DTO field).

- [ ] **Step 3: Add the DTO field**

In `server/src/modules/farmers/dto/update-farmer.dto.ts`, add:

```ts
  @IsOptional()
  @IsBoolean()
  courierEnabled?: boolean;
```

Ensure `IsOptional, IsBoolean` are imported from `class-validator`.

- [ ] **Step 4: Persist it in the service**

In `server/src/modules/farmers/farmers.service.ts`, inside `update(id, tenantId, dto)` (line ~181), add `courierEnabled` to the columns copied from `dto` into the update `set(...)` payload, following the existing allow-list pattern used for the other fields (e.g. `...(dto.courierEnabled !== undefined ? { courierEnabled: dto.courierEnabled } : {})`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx jest farmers.update -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/farmers/dto/update-farmer.dto.ts server/src/modules/farmers/farmers.service.ts server/src/modules/farmers/farmers.update.spec.ts
git commit -m "feat(farmers): accept courierEnabled on PATCH"
```

---

## Task 3: Vasil's courier toggle in the "Фермери" panel

**Files:**
- Modify: `client/src/lib/types.ts` (Farmer type, ~lines 100–113)
- Modify: `client/src/components/farmers/farmer-panel.tsx` (edit drawer + PATCH payload)

- [ ] **Step 1: Extend the Farmer type**

In `client/src/lib/types.ts`, add to the `Farmer` interface:

```ts
  courierEnabled?: boolean;
```

- [ ] **Step 2: Add the toggle to the edit drawer**

In `client/src/components/farmers/farmer-panel.tsx`:
- Add state: `const [courierEnabled, setCourierEnabled] = useState(farmer?.courierEnabled ?? false);`
- In the form body, add a labelled checkbox/switch (match the existing field styling in this file):

```tsx
<label className="flex items-center gap-2 text-[13.5px] font-semibold">
  <input
    type="checkbox"
    checked={courierEnabled}
    onChange={(e) => setCourierEnabled(e.target.checked)}
  />
  Куриерска доставка (фермерът праща сам с негов Speedy/Econt)
</label>
```

- In the `data` object built before `updateFarmer()` (the object at ~lines 93–101), add:

```ts
  courierEnabled,
```

- [ ] **Step 3: Verify in the browser preview**

Start the client dev server, open `/farmers`, open a farmer's edit drawer, toggle "Куриерска доставка", save, reopen — the checkbox keeps its state.

(Verification workflow: preview_start → preview to `/farmers` → preview_click the farmer + toggle + save → preview_snapshot to confirm persisted state.)

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/types.ts client/src/components/farmers/farmer-panel.tsx
git commit -m "feat(panel): courier toggle per farmer in Фермери"
```

---

## Task 4: `@CurrentFarmer()` decorator

**Files:**
- Create: `server/src/common/decorators/current-farmer.decorator.ts`
- Test: `server/src/common/decorators/current-farmer.decorator.spec.ts`

Mirror the existing `current-tenant.decorator.ts` (reads `request.user.tenantId`); this one reads `request.user.farmerId` (optional — undefined for non-farmer sessions).

- [ ] **Step 1: Write the failing test**

Create `server/src/common/decorators/current-farmer.decorator.spec.ts`:

```ts
import { ExecutionContext } from '@nestjs/common';
import { currentFarmerFactory } from './current-farmer.decorator';

function ctx(user: unknown): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ user }) }) } as never;
}

describe('currentFarmerFactory', () => {
  it('returns farmerId when present', () => {
    expect(currentFarmerFactory(undefined, ctx({ tenantId: 't1', farmerId: 'f1' }))).toBe('f1');
  });
  it('returns undefined when absent', () => {
    expect(currentFarmerFactory(undefined, ctx({ tenantId: 't1' }))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx jest current-farmer -v`
Expected: FAIL ("Cannot find module './current-farmer.decorator'").

- [ ] **Step 3: Implement the decorator**

Create `server/src/common/decorators/current-farmer.decorator.ts`:

```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Extracts the optional farmerId from the authenticated delivery/farmer session.
 *  Undefined for marketplace-admin (tenant-level) sessions. Pairs with
 *  @CurrentTenant() — the two together scope delivery storage to a farmer
 *  sub-namespace when farmerId is set. */
export function currentFarmerFactory(_data: unknown, ctx: ExecutionContext): string | undefined {
  const req = ctx.switchToHttp().getRequest();
  return req.user?.farmerId;
}

export const CurrentFarmer = createParamDecorator(currentFarmerFactory);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx jest current-farmer -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/common/decorators/current-farmer.decorator.ts server/src/common/decorators/current-farmer.decorator.spec.ts
git commit -m "feat(server): @CurrentFarmer() decorator"
```

---

## Task 5: Farmer-scoped storage path in Econt service

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts`
- Test: `server/src/modules/econt/econt.farmer-scope.spec.ts`

The service today reads/writes `tenants.settings.delivery.econt`. Add a `settingsPath(farmerId?)`
helper returning the JSONB key array, and thread an optional `farmerId` through the methods that
read/persist credentials and profile so a farmer session targets
`settings.delivery.farmers[<farmerId>].econt`.

- [ ] **Step 1: Write the failing test for the path helper**

Create `server/src/modules/econt/econt.farmer-scope.spec.ts`:

```ts
import { econtSettingsPath } from './econt.service';

describe('econtSettingsPath', () => {
  it('tenant level when no farmerId', () => {
    expect(econtSettingsPath(undefined)).toEqual(['delivery', 'econt']);
  });
  it('farmer sub-namespace when farmerId present', () => {
    expect(econtSettingsPath('f1')).toEqual(['delivery', 'farmers', 'f1', 'econt']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx jest econt.farmer-scope -v`
Expected: FAIL ("econtSettingsPath is not exported").

- [ ] **Step 3: Implement and export the helper**

In `server/src/modules/econt/econt.service.ts`, add an exported pure function near the top:

```ts
/** JSONB key path for a delivery account's Econt blob. Tenant-level when no
 *  farmerId; a per-farmer sub-namespace otherwise. */
export function econtSettingsPath(farmerId?: string): string[] {
  return farmerId ? ['delivery', 'farmers', farmerId, 'econt'] : ['delivery', 'econt'];
}
```

- [ ] **Step 4: Thread `farmerId` through the storage methods**

In `econt.service.ts`, give each of these methods an optional trailing `farmerId?: string` and use
`econtSettingsPath(farmerId)` wherever the code currently hard-codes the `['delivery','econt']`
JSONB path (both the `jsonb_set(...)` writes and the `settings -> 'delivery' -> 'econt'` reads):

- `saveCredentials(tenantId, input, farmerId?)`
- `loadStored(tenantId, cache?, farmerId?)` — the central read used by everything below
- `getConfig(tenantId, farmerId?)`
- `saveProfile(tenantId, input, farmerId?)`
- `saveSenders(tenantId, input, farmerId?)`
- `disconnect(tenantId, farmerId?)`
- `callTenant(tenantId, endpoint, body, cache?, farmerId?)` and the public methods that call it
  (cities/offices/validate-address/create/list/void/labels/courier) — pass `farmerId` straight
  through to `loadStored`.

Pattern for a read (Drizzle): build the path with `sql` from the helper, e.g.
`sql\`${tenants.settings} #> ${econtSettingsPath(farmerId)}\``. Pattern for a write:
`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), ${econtSettingsPath(farmerId)}, <value>::jsonb, true)`.
Keep `tenantId` as the row selector (`where tenants.id = tenantId`) in all cases — the farmer's
blob lives inside the marketplace tenant row.

Default `farmerId = undefined` keeps every existing caller (marketplace admin `/delivery` panel)
on the tenant-level path unchanged.

- [ ] **Step 5: Write a save→load round-trip test (farmer-scoped)**

Add to `econt.farmer-scope.spec.ts` a test that drives `saveCredentials('t1', {username:'u', password:'p'}, 'f1')` against a fake db that records the `jsonb_set` path argument, asserting the path equals `['delivery','farmers','f1','econt']` and that a tenant-level save (`farmerId` omitted) records `['delivery','econt']`. Mirror the existing econt.service.spec.ts db-stub style for the `update().set().where()` chain and the credential-validation mock.

- [ ] **Step 6: Run the econt suite**

Run: `cd server && npx jest econt -v`
Expected: PASS (new scope tests + existing econt tests still green — back-compat).

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.farmer-scope.spec.ts
git commit -m "feat(econt): farmer-scoped settings path (settings.delivery.farmers[id])"
```

---

## Task 6: Farmer-scoped storage path in Speedy service

**Files:**
- Modify: `server/src/modules/speedy/speedy.service.ts`
- Test: `server/src/modules/speedy/speedy.farmer-scope.spec.ts`

Same shape as Task 5, for `tenants.settings.delivery.speedy`.

- [ ] **Step 1: Write the failing path test**

Create `server/src/modules/speedy/speedy.farmer-scope.spec.ts`:

```ts
import { speedySettingsPath } from './speedy.service';

describe('speedySettingsPath', () => {
  it('tenant level when no farmerId', () => {
    expect(speedySettingsPath(undefined)).toEqual(['delivery', 'speedy']);
  });
  it('farmer sub-namespace when farmerId present', () => {
    expect(speedySettingsPath('f1')).toEqual(['delivery', 'farmers', 'f1', 'speedy']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx jest speedy.farmer-scope -v`
Expected: FAIL.

- [ ] **Step 3: Implement and export the helper**

In `server/src/modules/speedy/speedy.service.ts`:

```ts
export function speedySettingsPath(farmerId?: string): string[] {
  return farmerId ? ['delivery', 'farmers', farmerId, 'speedy'] : ['delivery', 'speedy'];
}
```

- [ ] **Step 4: Thread `farmerId` through the storage methods**

Add optional trailing `farmerId?: string` and use `speedySettingsPath(farmerId)` for the JSONB
read/write path in: `saveCredentials`, `resolveCreds`, `getConfig`, `saveProfile`, `saveSenders`,
`disconnect`, and the public API methods (`searchSites`, `getStreets`, `estimateShipping`,
`createShipment`, `listShipments`, label/void) — passing `farmerId` to `resolveCreds`. Keep
`tenantId` as the row selector. Default `farmerId = undefined` → tenant-level (back-compat).

- [ ] **Step 5: Write the save→load round-trip test**

Add to `speedy.farmer-scope.spec.ts` a test asserting `saveCredentials('t1', {userName:'u', password:'p'}, 'f1')` writes the `['delivery','farmers','f1','speedy']` path and the omitted-farmerId case writes `['delivery','speedy']`. Mirror the existing `speedy.service.spec.ts` stub style.

- [ ] **Step 6: Run the speedy suite**

Run: `cd server && npx jest speedy -v`
Expected: PASS (new + existing green).

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/speedy/speedy.service.ts server/src/modules/speedy/speedy.farmer-scope.spec.ts
git commit -m "feat(speedy): farmer-scoped settings path"
```

---

## Task 7: Pass `farmerId` from the standalone controllers

**Files:**
- Modify: `server/src/modules/econt-app/econt-standalone.controller.ts`
- Modify: the standalone Speedy controller (the routes serving `speedy/credentials`, `speedy/config`, `speedy/profile`, `speedy/shipments`, etc. — locate with `grep -rn "@Controller('speedy')" server/src`)
- Test: `server/src/modules/econt-app/econt-standalone.controller.spec.ts` (extend if present)

- [ ] **Step 1: Add `@CurrentFarmer()` to each cred/config/shipment route**

In `econt-standalone.controller.ts`, import `CurrentFarmer` and add `@CurrentFarmer() f?: string`
to every route that currently takes `@CurrentTenant() t: string` and forwards to a service method
that now accepts `farmerId` — i.e. `account`, `credentials` (POST/DELETE), `config`, `profile`,
`senders`, `profiles`, `cities`, `offices`, `validate-address`, `shipments` (GET/POST),
`shipments/:id/refresh`, `shipments/:id` (DELETE), `courier`, `courier/:requestId`, `labels.pdf`.
Pass `f` as the trailing argument, e.g.:

```ts
@Post('credentials')
saveCredentials(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined, @Body() dto: EcontCredentialsDto) {
  return this.econt.saveCredentials(t, dto, f);
}
```

- [ ] **Step 2: Do the same for the standalone Speedy controller**

Apply the identical change to every credential/config/profile/shipment route in the Speedy
standalone controller, passing `f` to the now-farmer-aware service methods.

- [ ] **Step 3: Build the server**

Run: `cd server && npm run build`
Expected: clean `nest build` (the optional trailing param is type-safe for both farmer and admin sessions).

- [ ] **Step 4: Run the full delivery suites**

Run: `cd server && npx jest econt speedy farmers current-farmer -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt-app/econt-standalone.controller.ts server/src/modules/speedy
git commit -m "feat(delivery): thread @CurrentFarmer through cred/config/shipment routes"
```

---

## Task 8: Handoff token carries `farmerId`

**Files:**
- Modify: `server/src/modules/auth/auth.service.ts:307` (`issueDeliveryHandoff`) and `handoffLogin`
- Test: `server/src/modules/auth/auth.service.spec.ts` (extend the existing "delivery handoff" describe block, ~line 421)

Currently `issueDeliveryHandoff(userId, tenantId)` signs `{sub, tid, type:'delivery-handoff'}`.
`handoffLogin` verifies it, checks the deliveries-package gate, and calls `sign()`. `sign()`
already adds `farmerId` to the session payload when given. We carry the farmer's id end-to-end.

- [ ] **Step 1: Write the failing test**

In `auth.service.spec.ts`, inside the `describe('delivery handoff', …)` block, add:

```ts
it('includes farmerId in the handoff token when the user is a farmer', async () => {
  (jwtService.signAsync as jest.Mock).mockResolvedValueOnce('handoff-token');
  await service.issueDeliveryHandoff(USER_ID, TENANT_ID, 'farmer-1');
  expect(jwtService.signAsync).toHaveBeenCalledWith(
    { sub: USER_ID, tid: TENANT_ID, fid: 'farmer-1', type: 'delivery-handoff' },
    expect.objectContaining({ expiresIn: '120s' }),
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx jest auth.service -t "handoff" -v`
Expected: FAIL (signature takes 2 args; `fid` not in payload).

- [ ] **Step 3: Thread farmerId through mint + consume**

In `auth.service.ts`:
- `issueDeliveryHandoff(userId: string, tenantId: string, farmerId?: string)` — add
  `...(farmerId ? { fid: farmerId } : {})` to the signed payload.
- `handoffLogin(token)` — after verifying, read `payload.fid` and pass it into `sign()` as the
  `farmerId` argument (the param `sign()` already accepts), so the minted session carries it.

- [ ] **Step 4: Pass farmerId at the call site**

In `auth.controller.ts` `POST /auth/delivery-handoff`, pass the authenticated user's `farmerId`
(from `request.user.farmerId` via `@CurrentFarmer()` or the existing user object) into
`issueDeliveryHandoff(userId, tenantId, farmerId)`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx jest auth.service -t "handoff" -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/auth/auth.service.ts server/src/modules/auth/auth.controller.ts server/src/modules/auth/auth.service.spec.ts
git commit -m "feat(auth): handoff token carries farmerId for farmer-scoped delivery session"
```

---

## Task 9: Farmer "Доставки" surface in the panel

**Files:**
- Create: `client/src/app/(admin)/farmer-delivery/page.tsx`
- Create: `client/src/components/farmer-delivery/farmer-delivery-client.tsx`
- Modify: `client/src/components/layout/sidebar.tsx` (`FARMER_NAV`)
- Modify: `client/src/components/layout/farmer-route-guard.tsx` (`FARMER_ALLOWED`)
- Modify: `client/src/lib/api-client.ts` — ensure Speedy config/credentials helpers exist (add if missing, mirroring the Econt ones at lines ~733–768)

The page gives the farmer (a) an "Отвори Доставки" button reusing the existing handoff flow, and
(b) inline Speedy/Econt connect forms that hit the same farmer-scoped endpoints — so the
connection state is identical whether edited here or in dostavki (single store, Task 5/6).

- [ ] **Step 1: Add the nav item**

In `client/src/components/layout/sidebar.tsx`, add to `FARMER_NAV` (after `/availability`):

```tsx
{ href: '/farmer-delivery', label: 'Доставки', Icon: Truck, desc: 'Свържи Speedy/Econt и пращай куриерски поръчки.' },
```

Ensure `Truck` is imported from `lucide-react` in this file.

- [ ] **Step 2: Allow the route for farmers**

In `client/src/components/layout/farmer-route-guard.tsx`, add `'/farmer-delivery'` to the
`FARMER_ALLOWED` array.

- [ ] **Step 3: Create the server page**

Create `client/src/app/(admin)/farmer-delivery/page.tsx`:

```tsx
import { FarmerDeliveryClient } from '@/components/farmer-delivery/farmer-delivery-client';

export const dynamic = 'force-dynamic';

export default function FarmerDeliveryPage() {
  return <FarmerDeliveryClient />;
}
```

- [ ] **Step 4: Create the client component**

Create `client/src/components/farmer-delivery/farmer-delivery-client.tsx`. It must:
- Render an "Отвори Доставки" button that calls `requestDeliveryHandoff()` then
  `window.open(\`${process.env.NEXT_PUBLIC_DELIVERY_URL ?? 'https://dostavki.fermeribg.com'}/api/session/handoff?token=${encodeURIComponent(token)}\`, '_blank', 'noopener')` — mirroring `DeliveryHandoffCard` in `delivery-client.tsx:136–177`.
- On mount, call `getEcontConfig()` + `getSpeedyConfig()` and show a "Свързан / Не е свързан"
  badge for each (reuse the `.configured` flag), mirroring dostavki's `StatusBadge`.
- Render Econt + Speedy credential forms that call `saveEcontCredentials({username, password})`
  and `saveSpeedyCredentials({userName, password})`. Because the farmer's JWT carries `farmerId`,
  the BFF → API writes land in the farmer sub-namespace automatically (Task 5/6/7). After save,
  re-fetch config so the badge flips to "Свързан".

Keep the styling consistent with existing farmer-panel components (reuse the same input/badge
classes used in `farmers/farmer-panel.tsx`).

- [ ] **Step 5: Ensure the API helpers exist**

In `client/src/lib/api-client.ts`, confirm `getEcontConfig`, `saveEcontCredentials`,
`requestDeliveryHandoff` exist (they do). Add the Speedy equivalents if missing:

```ts
export const getSpeedyConfig = () => apiFetch<SpeedyConfigView>('speedy/config');
export const saveSpeedyCredentials = (data: { userName: string; password: string }) =>
  apiFetch<{ configured: true }>('speedy/credentials', { method: 'POST', ...json(data) }, 'Неуспешна връзка със Speedy');
```

(Define `SpeedyConfigView` mirroring `EcontConfigView`.)

- [ ] **Step 6: Verify in the browser preview**

Log in as a farmer subaccount (role=farmer). Confirm:
- "Доставки" appears in the farmer sidebar; `/farmer-delivery` loads (not redirected by the guard).
- Connecting Speedy/Econt flips the badge to "Свързан".
- "Отвори Доставки" opens dostavki; the same carrier shows as connected there (single store).

(Verification workflow: preview_start → log in as farmer → preview to `/farmer-delivery` →
preview_fill the cred form + submit → preview_snapshot for the "Свързан" badge → preview_click
"Отвори Доставки".)

- [ ] **Step 7: Commit**

```bash
git add client/src/app/(admin)/farmer-delivery client/src/components/farmer-delivery client/src/components/layout/sidebar.tsx client/src/components/layout/farmer-route-guard.tsx client/src/lib/api-client.ts
git commit -m "feat(panel): farmer Доставки surface — SSO + farmer-scoped carrier connect"
```

---

## Task 10: End-to-end verification (live)

- [ ] **Step 1: Run all affected server suites**

Run: `cd server && npx jest econt speedy farmers auth current-farmer slots -v`
Expected: all PASS.

- [ ] **Step 2: Build everything**

Run: `cd packages/db && npm run build && cd ../../server && npm run build && cd ../client && npm run build`
Expected: clean.

- [ ] **Step 3: Manual two-farmer credential isolation check**

Against a dev/demo stack: enable courier for two different farmers (Vasil toggle). For each
farmer subaccount, open "Доставки", connect a (distinct) carrier credential. Confirm via the API
(`GET /bff/shipping/config` under each farmer session) that each farmer sees only their own
connection — proving `settings.delivery.farmers[<farmerId>]` isolation and that the marketplace
admin's tenant-level config is untouched.

- [ ] **Step 4: Commit any fixes, then mark Phase 1 done**

Phase 1 foundation complete. Phases 2 (storefront courier option + cart split) and 3 (order
auto-distribution) follow as separate plans.

---

## Self-review notes

- **Spec coverage:** Components 1 (farmer-scoped storage — Tasks 5/6/7), 2 (SSO farmerId — Task 8),
  5 (carrier-connect two synced surfaces — Tasks 5/6 single store + Task 9 panel surface; dostavki
  surface already exists), 6 (Vasil toggle — Tasks 1/2/3). Components 3 (cart split) and 4 (order
  distribution) are Phases 2/3, out of this plan's scope by design.
- **No new table / no tenant sprawl:** credentials stay in `tenants.settings` JSONB under a farmer
  sub-namespace; the only migration is `farmers.courier_enabled`.
- **Back-compat:** every threaded `farmerId` defaults to `undefined` → the marketplace admin's
  existing `/delivery` panel and the marketplace-level dostavki account keep working unchanged.
- **Open item carried to Phase 2:** shipment weight source (per-product weight vs configurable
  default) — verify the products schema then decide.
