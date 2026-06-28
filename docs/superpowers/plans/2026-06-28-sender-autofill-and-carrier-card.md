# Sender auto-fill + carrier-card connected state — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the standalone „Профил на подател" page — auto-seed the carrier sender from the farm's own Еcont/Speedy profile + contact on connect, surface it as a compact „Подаваш от: … ✎" strip + edit modal on Пратки/Внос, and give the credentials card a connected state (✓ Свързан + Промени/Премахни).

**Architecture:** Backend derives a default sender (pure helper) and seeds it inside `saveCredentials` only when empty (best-effort); a new disconnect endpoint clears creds. Frontend removes the profile settings tab, adds a sender strip + modal (extracted from the old card), and collapses the credentials card to a connected state.

**Tech Stack:** NestJS + Drizzle + Jest (server). Next.js + React (delivery-web; no unit runner → verify via `pnpm -C delivery-web lint` + `build`).

**Spec:** `docs/superpowers/specs/2026-06-28-sender-autofill-and-carrier-card-design.md`

---

## File Structure

- `server/src/modules/econt/econt.sender.ts` — **new**: `deriveSenderFromFarm` pure helper + types.
- `server/src/modules/econt/econt.sender.spec.ts` — **new**: helper tests.
- `server/src/modules/econt/econt.service.ts` — auto-seed in `saveCredentials`; new `disconnect`.
- `server/src/modules/speedy/speedy.service.ts` — auto-seed in `saveCredentials`; new `disconnect`.
- `server/src/modules/econt-app/econt-standalone.controller.ts` — `DELETE /shipping/credentials`.
- `server/src/modules/econt-app/speedy-standalone.controller.ts` — `DELETE /speedy/credentials`.
- `server/src/modules/{econt,speedy}/*.service.spec.ts` — disconnect tests.
- `delivery-web/src/lib/api-client.ts` — `disconnectEcont` / `disconnectSpeedy`.
- `delivery-web/src/components/sender-modal.tsx` — **new** (extract picker/profile form).
- `delivery-web/src/components/sender-strip.tsx` — **new**.
- `delivery-web/src/components/settings-client.tsx` — card connected-state; remove `profile` tab.
- `delivery-web/src/components/shipments-client.tsx`, `import-client.tsx` — mount the strip.
- `delivery-web/src/components/carrier-profile-section.tsx` — **delete** (after extraction).

---

## Task 1: `deriveSenderFromFarm` pure helper (server, TDD)

**Files:**
- Create: `server/src/modules/econt/econt.sender.ts`
- Test: `server/src/modules/econt/econt.sender.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/econt/econt.sender.spec.ts`:

```ts
import { deriveSenderFromFarm } from './econt.sender';

describe('deriveSenderFromFarm', () => {
  it('prefers the carrier profile name/phone', () => {
    const out = deriveSenderFromFarm('Ферма Х', { phone: '0700', address: 'ул. 1' },
      [{ name: 'Регистрирано Име', phone: '0888111', clientNumber: '5' }]);
    expect(out).toEqual({ name: 'Регистрирано Име', phone: '0888111', mode: 'office' });
  });

  it('falls back to farm name + contact phone when no profile', () => {
    const out = deriveSenderFromFarm('Ферма Х', { phone: '0700', address: 'ул. 1' }, []);
    expect(out).toEqual({ name: 'Ферма Х', phone: '0700', mode: 'office' });
  });

  it('falls back to farm name + empty phone when nothing available', () => {
    const out = deriveSenderFromFarm('Ферма Х', null, []);
    expect(out).toEqual({ name: 'Ферма Х', phone: '', mode: 'office' });
  });

  it('ignores a blank profile name/phone and uses the fallbacks', () => {
    const out = deriveSenderFromFarm('Ферма Х', { phone: '0700' },
      [{ name: '  ', phone: '', clientNumber: null }]);
    expect(out).toEqual({ name: 'Ферма Х', phone: '0700', mode: 'office' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C server test -- econt.sender.spec`
Expected: FAIL — `Cannot find module './econt.sender'`.

- [ ] **Step 3: Implement the helper**

Create `server/src/modules/econt/econt.sender.ts`:

```ts
/** Minimal contact shape we read off settings.contact for sender fallback. */
export interface FarmContact { phone?: string | null; address?: string | null }

/** A carrier sender suggestion (name + phone) — matches Econt SenderSuggestion
 *  and the Speedy contract-client slim shape. */
export interface CarrierProfileLite { name: string; phone: string; clientNumber?: string | null }

/** The seeded sender blob written under settings.delivery.<carrier>.sender. */
export interface DerivedSender { name: string; phone: string; mode: 'office' }

/**
 * Derive a default carrier sender from the farm's own data, in precedence order:
 *   1. the carrier's registered profile (name + phone),
 *   2. the farm name + contact phone,
 *   3. the farm name + empty phone.
 * `mode: 'office'` is always returned — the farmer picks the actual drop-off office
 * once in the sender modal (we never guess an office code).
 */
export function deriveSenderFromFarm(
  farmName: string,
  contact: FarmContact | null | undefined,
  profiles: CarrierProfileLite[] | null | undefined,
): DerivedSender {
  const p = (profiles ?? []).find((x) => x && String(x.name ?? '').trim());
  const name = (p?.name && p.name.trim()) || farmName;
  const phone = (p?.phone && p.phone.trim()) || (contact?.phone ?? '').trim() || '';
  return { name, phone, mode: 'office' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C server test -- econt.sender.spec`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt/econt.sender.ts server/src/modules/econt/econt.sender.spec.ts
git commit -m "feat(delivery): deriveSenderFromFarm helper (carrier profile -> contact -> farm name)"
```

---

## Task 2: Auto-seed sender in Еcont `saveCredentials` (server, TDD)

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts` (`saveCredentials`, ~line 186-217; import the helper)
- Test: `server/src/modules/econt/econt.service.spec.ts`

**Context:** `saveCredentials` validates creds (getCities), then writes `nextEcont`. After that we best-effort seed `sender` only if `econt.sender` is empty: fetch the farm's Еcont profiles (`getClientProfiles`) and the farm name + `settings.contact`, run `deriveSenderFromFarm`, merge into `nextEcont.sender`. A failure to fetch profiles must NOT fail the connect.

- [ ] **Step 1: Write the failing test**

In `server/src/modules/econt/econt.service.spec.ts`, add a new describe (top-level, after the existing ones):

```ts
import { deriveSenderFromFarm } from './econt.sender';

describe('EcontService.maybeSeedSender (unit)', () => {
  const svc = new EcontService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never);
  const seed = (econt: unknown, farmName: string, contact: unknown, profiles: unknown) =>
    (svc as unknown as {
      maybeSeedSender: (e: any, n: string, c: any, p: any) => Record<string, unknown>;
    }).maybeSeedSender(econt, farmName, contact, profiles);

  it('seeds sender when empty, from the Econt profile', () => {
    const out = seed({ username: 'u' }, 'Ферма', { phone: '0700' },
      [{ name: 'Профил', phone: '0888', clientNumber: null }]);
    expect(out.sender).toEqual({ name: 'Профил', phone: '0888', mode: 'office' });
  });

  it('does NOT overwrite an existing sender', () => {
    const existing = { name: 'Ръчно', phone: '0999', mode: 'office', officeCode: '1' };
    const out = seed({ username: 'u', sender: existing }, 'Ферма', { phone: '0700' },
      [{ name: 'Профил', phone: '0888', clientNumber: null }]);
    expect(out.sender).toEqual(existing);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C server test -- econt.service.spec -t maybeSeedSender`
Expected: FAIL — `maybeSeedSender is not a function`.

- [ ] **Step 3: Add the import + the `maybeSeedSender` method**

In `server/src/modules/econt/econt.service.ts`, add to the imports near the top (next to the `secret.util` import at line 14):

```ts
import { deriveSenderFromFarm } from './econt.sender';
```

Add this private method to the `EcontService` class (next to `resolveHandling`, ~line 471):

```ts
  /** Merge a derived sender into the econt blob ONLY when none is set yet.
   *  Pure (no I/O) so it is unit-testable; the async fetch happens in the caller. */
  private maybeSeedSender(
    econt: Record<string, unknown>,
    farmName: string,
    contact: { phone?: string | null; address?: string | null } | null | undefined,
    profiles: { name: string; phone: string; clientNumber?: string | null }[] | null | undefined,
  ): Record<string, unknown> {
    const existing = econt.sender as Record<string, unknown> | undefined;
    if (existing && Object.keys(existing).length) return econt;
    return { ...econt, sender: deriveSenderFromFarm(farmName, contact ?? null, profiles ?? []) };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C server test -- econt.service.spec -t maybeSeedSender`
Expected: PASS (2/2).

- [ ] **Step 5: Wire it into `saveCredentials` (best-effort fetch)**

In `saveCredentials`, replace the `nextEcont` construction + settings write (the block from `const nextEcont: EcontStored = {` through the `await this.db.update(...)` line, ~line 207-217) with:

```ts
    let nextEcont: EcontStored = {
      ...econt,
      env,
      username: input.username,
      passwordEnc: encryptSecret(input.password, this.encKey),
      configured: true,
    };
    // Best-effort: seed the sender from the farm's own data so the operator never
    // has to fill a profile form. Never let a derivation hiccup fail the connect.
    try {
      let profiles: { name: string; phone: string; clientNumber: string | null }[] = [];
      try {
        const data = await this.call(base, input.username, input.password, 'Profile/ProfileService.getClientProfiles.json', {});
        profiles = slimClientProfiles(data);
      } catch { /* no profiles → fall back to contact/farm name */ }
      const contact = (tenant.settings.contact ?? null) as { phone?: string | null; address?: string | null } | null;
      nextEcont = this.maybeSeedSender(nextEcont, tenant.slug, contact, profiles) as EcontStored;
    } catch { /* seeding is optional */ }

    const nextSettings = {
      ...tenant.settings,
      delivery: { ...((tenant.settings.delivery as Record<string, unknown>) ?? {}), econt: nextEcont },
    };
    await this.db.update(tenants).set({ settings: nextSettings }).where(eq(tenants.id, tenantId));
```

> `slimClientProfiles` is already exported in this file; `this.call(base, user, pass, path, body)` is the same low-level call `saveCredentials` already uses for validation. `tenant.slug` is the farm name fallback (the tenant row exposes `slug`; the human farm name is not on the loadStored projection, and slug is an acceptable default the farmer edits in the modal).

- [ ] **Step 6: Run the full Еcont suite (no regression)**

Run: `pnpm -C server test -- econt.service.spec`
Expected: PASS (all). Also `pnpm -C server build`.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.service.spec.ts
git commit -m "feat(econt): auto-seed sender from farm profile/contact on connect (best-effort)"
```

---

## Task 3: Auto-seed sender in Speedy `saveCredentials` (server, TDD)

**Files:**
- Modify: `server/src/modules/speedy/speedy.service.ts` (`saveCredentials`, ~line 101-129)
- Test: `server/src/modules/speedy/speedy.service.spec.ts`

**Context:** Mirror Task 2 for Speedy. Speedy's registered clients come from `slimContractClients` (already imported in `speedy.service.ts`); the low-level call is `this.client.call(creds, 'client/contract', {})` (see `getContractClients`, ~line 279). Reuse the SAME `deriveSenderFromFarm` helper + a `maybeSeedSender` method.

- [ ] **Step 1: Write the failing test**

In `server/src/modules/speedy/speedy.service.spec.ts`, add:

```ts
describe('SpeedyService.maybeSeedSender (unit)', () => {
  const svc = new SpeedyService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never, {} as never);
  const seed = (speedy: unknown, farmName: string, contact: unknown, profiles: unknown) =>
    (svc as unknown as {
      maybeSeedSender: (s: any, n: string, c: any, p: any) => Record<string, unknown>;
    }).maybeSeedSender(speedy, farmName, contact, profiles);

  it('seeds sender when empty, from the contract client', () => {
    const out = seed({ userName: 'u' }, 'Ферма', { phone: '0700' },
      [{ name: 'Клиент', phone: '0888', clientNumber: '9' }]);
    expect(out.sender).toEqual({ name: 'Клиент', phone: '0888', mode: 'office' });
  });

  it('does NOT overwrite an existing sender', () => {
    const existing = { name: 'Ръчно', phone: '0999', mode: 'office' };
    const out = seed({ userName: 'u', sender: existing }, 'Ферма', { phone: '0700' }, []);
    expect(out.sender).toEqual(existing);
  });
});
```

> Match the existing `new SpeedyService(...)` constructor arity used elsewhere in this spec file — copy the argument count from an existing `new SpeedyService(` in the file (adjust the `{} as never` count if it differs from 6).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C server test -- speedy.service.spec -t maybeSeedSender`
Expected: FAIL — `maybeSeedSender is not a function`.

- [ ] **Step 3: Add import + `maybeSeedSender`**

In `server/src/modules/speedy/speedy.service.ts`, add the import (next to the helpers import):

```ts
import { deriveSenderFromFarm } from '../econt/econt.sender';
```

Add the private method to `SpeedyService`:

```ts
  /** Merge a derived sender into the speedy blob ONLY when none is set yet. */
  private maybeSeedSender(
    speedy: Record<string, unknown>,
    farmName: string,
    contact: { phone?: string | null; address?: string | null } | null | undefined,
    profiles: { name: string; phone: string; clientNumber?: string | null }[] | null | undefined,
  ): Record<string, unknown> {
    const existing = speedy.sender as Record<string, unknown> | undefined;
    if (existing && Object.keys(existing).length) return speedy;
    return { ...speedy, sender: deriveSenderFromFarm(farmName, contact ?? null, profiles ?? []) };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C server test -- speedy.service.spec -t maybeSeedSender`
Expected: PASS (2/2).

- [ ] **Step 5: Wire into `saveCredentials`**

In `speedy.service.ts saveCredentials`, after the `nextSpeedy` object is built and BEFORE the settings write, seed it (mirror Task 2; the contract-client fetch is best-effort). Locate the `const nextSpeedy ... = { ... configured: true }` block and the following settings-write, and insert between them:

```ts
    let seededSpeedy: Record<string, unknown> = nextSpeedy;
    try {
      let profiles: { name: string; phone: string; clientNumber: string | null }[] = [];
      try {
        const data = await this.client.call(
          { base: SPEEDY_BASE, userName: input.userName, password: input.password, clientSystemId: input.clientSystemId },
          'client/contract', {},
        );
        profiles = slimContractClients(data);
      } catch { /* no contract clients → fall back */ }
      const contact = (tenant.settings.contact ?? null) as { phone?: string | null; address?: string | null } | null;
      seededSpeedy = this.maybeSeedSender(nextSpeedy, tenant.slug, contact, profiles);
    } catch { /* optional */ }
```

Then change the settings write to use `seededSpeedy` instead of `nextSpeedy` (the `delivery: { ..., speedy: seededSpeedy }` object).

> Verify the exact local names (`nextSpeedy`, `tenant`, `SPEEDY_BASE`, `input.clientSystemId`, the contract-client endpoint string used by `getContractClients`) against the current file and match them — adjust the endpoint path if `getContractClients` uses a different one.

- [ ] **Step 6: Run the full Speedy suite**

Run: `pnpm -C server test -- speedy.service.spec`
Expected: PASS. Also `pnpm -C server build`.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/speedy/speedy.service.ts server/src/modules/speedy/speedy.service.spec.ts
git commit -m "feat(speedy): auto-seed sender from contract client/contact on connect (best-effort)"
```

---

## Task 4: Disconnect endpoints (server, TDD)

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts` (+ `disconnect`)
- Modify: `server/src/modules/speedy/speedy.service.ts` (+ `disconnect`)
- Modify: `server/src/modules/econt-app/econt-standalone.controller.ts` (`DELETE credentials`)
- Modify: `server/src/modules/econt-app/speedy-standalone.controller.ts` (`DELETE credentials`)
- Test: `server/src/modules/econt/econt.service.spec.ts`

**Context:** `disconnect(tenantId)` clears `username`/`passwordEnc` and sets `configured:false` on the carrier blob, leaving `sender`/everything else intact, and busts the tenant cache. The clearing logic over the settings blob is pure → unit-test that.

- [ ] **Step 1: Write the failing test**

In `server/src/modules/econt/econt.service.spec.ts`, add:

```ts
describe('EcontService.clearCredsBlob (unit)', () => {
  const svc = new EcontService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never);
  const clear = (econt: unknown) =>
    (svc as unknown as { clearCredsBlob: (e: any) => Record<string, unknown> }).clearCredsBlob(econt);

  it('clears username/passwordEnc/configured but keeps sender', () => {
    const out = clear({ username: 'u', passwordEnc: 'enc', configured: true, env: 'demo',
      sender: { name: 'Ферма', mode: 'office' } });
    expect(out.configured).toBe(false);
    expect(out.username).toBeUndefined();
    expect(out.passwordEnc).toBeUndefined();
    expect(out.sender).toEqual({ name: 'Ферма', mode: 'office' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C server test -- econt.service.spec -t clearCredsBlob`
Expected: FAIL — `clearCredsBlob is not a function`.

- [ ] **Step 3: Implement `clearCredsBlob` + `disconnect` (Еcont)**

In `econt.service.ts`, add:

```ts
  /** Strip creds off a carrier blob (keep sender/profile). Pure → unit-tested. */
  private clearCredsBlob(econt: Record<string, unknown>): Record<string, unknown> {
    const { username: _u, passwordEnc: _p, ...rest } = econt;
    return { ...rest, configured: false };
  }

  /** Disconnect Econt: clear creds (keep the sender profile), bust caches. */
  async disconnect(tenantId: string): Promise<{ configured: false }> {
    const { tenant, econt } = await this.loadStored(tenantId);
    const nextEcont = this.clearCredsBlob(econt);
    const nextSettings = {
      ...tenant.settings,
      delivery: { ...((tenant.settings.delivery as Record<string, unknown>) ?? {}), econt: nextEcont },
    };
    await this.db.update(tenants).set({ settings: nextSettings }).where(eq(tenants.id, tenantId));
    await this.cache.del(
      publicCacheKeys.tenant(tenant.slug),
      `econt:offices:${tenant.slug}`,
      `econt:cities:${tenant.slug}`,
    );
    return { configured: false };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C server test -- econt.service.spec -t clearCredsBlob`
Expected: PASS.

- [ ] **Step 5: Add the Speedy `disconnect` (mirror)**

In `speedy.service.ts`, add (using Speedy's own field names — `userName`/`passwordEnc` — and its existing cache-bust keys; copy the exact `this.cache.del(...)` key list from Speedy's `saveCredentials`):

```ts
  private clearCredsBlob(speedy: Record<string, unknown>): Record<string, unknown> {
    const { userName: _u, passwordEnc: _p, ...rest } = speedy;
    return { ...rest, configured: false };
  }

  async disconnect(tenantId: string): Promise<{ configured: false }> {
    const { tenant, speedy } = await this.loadStored(tenantId);
    const nextSpeedy = this.clearCredsBlob(speedy);
    const nextSettings = {
      ...tenant.settings,
      delivery: { ...((tenant.settings.delivery as Record<string, unknown>) ?? {}), speedy: nextSpeedy },
    };
    await this.db.update(tenants).set({ settings: nextSettings }).where(eq(tenants.id, tenantId));
    await this.cache.del(publicCacheKeys.tenant(tenant.slug));
    return { configured: false };
  }
```

> Match Speedy's `loadStored` return shape (`{ tenant, speedy }`) and its cache-bust keys to whatever `saveCredentials` uses in that file.

- [ ] **Step 6: Add the controller routes**

In `econt-standalone.controller.ts`, next to `@Post('credentials')`:

```ts
  @Delete('credentials')
  disconnect(@CurrentTenant() t: string) {
    return this.econt.disconnect(t);
  }
```

(`Delete` and `CurrentTenant` are already imported in this controller.)

In `speedy-standalone.controller.ts`, add the analogous route (confirm `Delete` is imported; add to the `@nestjs/common` import if missing):

```ts
  @Delete('credentials')
  disconnect(@CurrentTenant() t: string) {
    return this.speedy.disconnect(t);
  }
```

- [ ] **Step 7: Run suites + build**

Run: `pnpm -C server test -- econt.service.spec speedy.service.spec` then `pnpm -C server build`
Expected: PASS + clean build.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.service.spec.ts server/src/modules/speedy/speedy.service.ts server/src/modules/econt-app/econt-standalone.controller.ts server/src/modules/econt-app/speedy-standalone.controller.ts
git commit -m "feat(delivery): disconnect endpoints clear carrier creds (keep sender)"
```

---

## Task 5: delivery-web api-client — disconnect calls

**Files:**
- Modify: `delivery-web/src/lib/api-client.ts`

- [ ] **Step 1: Add the two functions**

Open `delivery-web/src/lib/api-client.ts`, find `saveEcontCredentials` / `saveSpeedyCredentials`, and add right after them (use the SAME request helper they use — match the existing `apiFetch`/`request` wrapper and the `'shipping'` / `'speedy'` base path conventions already present in the file):

```ts
export const disconnectEcont = async (): Promise<{ configured: false }> =>
  request('/shipping/credentials', { method: 'DELETE' });

export const disconnectSpeedy = async (): Promise<{ configured: false }> =>
  request('/speedy/credentials', { method: 'DELETE' });
```

> Replace `request(...)` with whatever the file's existing helper is (e.g. `apiFetch`, `bff`, or a raw `fetch` wrapper) — copy the exact shape from `saveEcontCredentials` and only change the path + method to `DELETE`.

- [ ] **Step 2: Verify the client compiles**

Run: `pnpm -C delivery-web lint`
Expected: no errors on the new exports.

- [ ] **Step 3: Commit**

```bash
git add delivery-web/src/lib/api-client.ts
git commit -m "feat(delivery-web): disconnectEcont/disconnectSpeedy api calls"
```

---

## Task 6: Sender modal (delivery-web — extract from the old card)

**Files:**
- Create: `delivery-web/src/components/sender-modal.tsx`
- Read for extraction: `delivery-web/src/components/carrier-profile-section.tsx`

**Context:** The old `carrier-profile-section.tsx` already contains the full sender form for both carriers (name/phone, the `SiteAutocomplete` city search, the office picker, package, COD) and the `saveEcontProfile`/`saveSpeedyProfile` calls. Extract that into a modal that takes a `carrier` prop and renders one carrier's form, with package + COD collapsed under a „Разширени" toggle.

- [ ] **Step 1: Create the modal**

Create `delivery-web/src/components/sender-modal.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { toast } from 'sonner';

/**
 * Edit one carrier's sender (name/phone + drop-off office/address), with package +
 * COD under „Разширени". Replaces the standalone „Профил на подател" page — opened
 * from the SenderStrip on Пратки/Внос. The actual field bodies (name/phone inputs,
 * SiteAutocomplete city search, office picker, package, COD) are moved verbatim from
 * carrier-profile-section.tsx — keep the same state + save calls
 * (saveEcontProfile / saveSpeedyProfile), just rendered inside this dialog.
 */
export function SenderModal({
  carrier,
  open,
  onClose,
  onSaved,
}: {
  carrier: 'econt' | 'speedy';
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-[560px] rounded-2xl bg-ff-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-[18px] font-extrabold">
          Подател — {carrier === 'econt' ? 'Еконт' : 'Speedy'}
        </h2>
        <p className="mt-1 text-[13px] text-ff-muted">
          Тези данни влизат автоматично във всяка товарителница. Попълнени са от профила
          ти — смени само ако е нужно.
        </p>

        {/* MOVE HERE from carrier-profile-section.tsx: the name + phone inputs, the
            city SiteAutocomplete + office picker (Econt) / site+office (Speedy),
            using the same state hooks and the same getEcont/SpeedyConfig load. */}

        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="mt-4 text-[13px] font-bold text-ff-green-700"
        >
          {advanced ? '− Скрий разширени' : '+ Разширени (пакет, наложен платеж)'}
        </button>
        {advanced && (
          <div className="mt-2">
            {/* MOVE HERE: the package (weightKg/contents) + COD (enabled/feePayer) fields. */}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-ff-border px-4 py-2 text-[13.5px] font-bold">
            Затвори
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                // MOVE HERE: the exact saveEcontProfile / saveSpeedyProfile call from the
                // old card (sender + defaultPackage + cod), branched on `carrier`.
                toast.success('Подателят е запазен');
                onSaved();
                onClose();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Грешка');
              }
            }}
            className="rounded-xl bg-ff-green-700 px-4 py-2 text-[13.5px] font-bold text-white"
          >
            Запази
          </button>
        </div>
      </div>
    </div>
  );
}
```

> This is an extraction task, not new logic: lift the working field JSX + state + save calls out of `carrier-profile-section.tsx` into the marked spots, parameterised by `carrier`. Do not invent new field behaviour.

- [ ] **Step 2: Verify it compiles**

Run: `pnpm -C delivery-web lint`
Expected: no errors (unused-var warnings for not-yet-mounted modal are fine until Task 8).

- [ ] **Step 3: Commit**

```bash
git add delivery-web/src/components/sender-modal.tsx
git commit -m "feat(delivery-web): SenderModal (sender edit, extracted from profile card)"
```

---

## Task 7: Sender strip (delivery-web)

**Files:**
- Create: `delivery-web/src/components/sender-strip.tsx`

- [ ] **Step 1: Create the strip**

Create `delivery-web/src/components/sender-strip.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Pencil, AlertTriangle } from 'lucide-react';
import { getEcontConfig, getSpeedyConfig } from '@/lib/api-client';
import { SenderModal } from './sender-modal';

type Row = { carrier: 'econt' | 'speedy'; label: string; sender: { name?: string; officeCode?: string; cityName?: string } | null; configured: boolean };

/** Compact „Подаваш от: …" strip shown atop Пратки/Внос. One row per connected
 *  carrier; ✎ opens the SenderModal. Replaces the „Профил на подател" settings page. */
export function SenderStrip() {
  const [rows, setRows] = useState<Row[]>([]);
  const [editing, setEditing] = useState<'econt' | 'speedy' | null>(null);

  const load = useCallback(async () => {
    const [e, s] = await Promise.allSettled([getEcontConfig(), getSpeedyConfig()]);
    const next: Row[] = [];
    if (e.status === 'fulfilled' && e.value?.configured) {
      next.push({ carrier: 'econt', label: 'Еконт', sender: (e.value.sender as Row['sender']) ?? null, configured: true });
    }
    if (s.status === 'fulfilled' && s.value?.configured) {
      next.push({ carrier: 'speedy', label: 'Speedy', sender: (s.value.sender as Row['sender']) ?? null, configured: true });
    }
    setRows(next);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!rows.length) return null;

  return (
    <div className="mb-4 flex flex-col gap-2">
      {rows.map((r) => {
        const place = r.sender?.officeCode ? `офис ${r.sender.officeCode}` : (r.sender?.cityName ?? '');
        const hasPickup = !!(r.sender?.officeCode || r.sender?.cityName);
        return (
          <div key={r.carrier} className="flex items-center justify-between gap-3 rounded-xl border border-ff-border bg-ff-surface-2 px-4 py-2.5">
            <div className="min-w-0 text-[13.5px] text-ff-ink-2">
              {hasPickup ? (
                <>Подаваш от <b className="text-ff-ink">{r.sender?.name}</b>{place ? <> · {place}</> : null} <span className="text-ff-muted">({r.label})</span></>
              ) : (
                <span className="inline-flex items-center gap-1.5 font-bold text-ff-amber-600">
                  <AlertTriangle size={15} /> Избери офис на подаване ({r.label})
                </span>
              )}
            </div>
            <button type="button" onClick={() => setEditing(r.carrier)} className="inline-flex shrink-0 items-center gap-1.5 text-[13px] font-bold text-ff-green-700">
              <Pencil size={14} /> Промени
            </button>
          </div>
        );
      })}
      <SenderModal
        carrier={editing ?? 'econt'}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={() => void load()}
      />
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm -C delivery-web lint`
Expected: no errors. (Confirm `getEcontConfig`/`getSpeedyConfig` return `{ configured, sender }` — they do, via the server `getConfig` `...safe` spread.)

- [ ] **Step 3: Commit**

```bash
git add delivery-web/src/components/sender-strip.tsx
git commit -m "feat(delivery-web): SenderStrip („Подаваш от: … ✎") for Пратки/Внос"
```

---

## Task 8: Mount strip + remove the profile page (delivery-web)

**Files:**
- Modify: `delivery-web/src/components/shipments-client.tsx`
- Modify: `delivery-web/src/components/import-client.tsx`
- Modify: `delivery-web/src/components/settings-client.tsx`
- Delete: `delivery-web/src/components/carrier-profile-section.tsx`

- [ ] **Step 1: Mount the strip on Пратки**

In `delivery-web/src/components/shipments-client.tsx`, add the import:

```tsx
import { SenderStrip } from './sender-strip';
```

Render `<SenderStrip />` at the very top of the component's returned JSX (just inside the outermost wrapper, above the stats/table).

- [ ] **Step 2: Mount the strip on Внос**

In `delivery-web/src/components/import-client.tsx`, add the same import and render `<SenderStrip />` at the top of the returned JSX.

- [ ] **Step 3: Remove the profile section from settings**

In `delivery-web/src/components/settings-client.tsx`:
- Remove the import `import { CarrierProfileSection } from './carrier-profile-section';` (line ~11).
- Remove the `{ id: 'profile', label: 'Профил на подател' }` entry from `SECTIONS` (line ~53).
- Remove `'profile'` from the `Section` type union (line ~49).
- Remove the render line `{section === 'profile' && <CarrierProfileSection />}` (line ~395).

- [ ] **Step 4: Delete the old card file**

```bash
git rm delivery-web/src/components/carrier-profile-section.tsx
```

- [ ] **Step 5: Verify lint + build (no dangling refs)**

Run: `pnpm -C delivery-web lint` then `pnpm -C delivery-web build`
Expected: both succeed; no references to `CarrierProfileSection` or the deleted file remain.

- [ ] **Step 6: Commit**

```bash
git add delivery-web/src/components/shipments-client.tsx delivery-web/src/components/import-client.tsx delivery-web/src/components/settings-client.tsx
git commit -m "feat(delivery-web): mount SenderStrip on Пратки/Внос; remove „Профил на подател" page"
```

---

## Task 9: Carrier-credentials card — connected state (delivery-web)

**Files:**
- Modify: `delivery-web/src/components/settings-client.tsx` (the `carriers` section, ~line 333-391)

**Context:** Today each carrier card always shows username/password inputs. When `configured`, collapse them → „✓ Свързан · потребител <username>" + „Промени" / „Премахни". `econt?.username` / `speedy?.userName` are already loaded from `getConfig`.

- [ ] **Step 1: Add disconnect imports + handlers**

In `settings-client.tsx`, add to the api-client import: `disconnectEcont, disconnectSpeedy`. Add two edit-mode flags + handlers inside `SettingsClient` (next to `savingE`/`savingS`):

```tsx
  const [editE, setEditE] = useState(false);
  const [editS, setEditS] = useState(false);

  async function disconnectEcontFn() {
    if (!confirm('Да премахна ли връзката с Еконт? Данните на подателя се запазват.')) return;
    try {
      await disconnectEcont();
      setEcont((c) => ({ ...(c ?? {}), configured: false }));
      setEcontForm({ username: '', password: '' });
      setEditE(false);
      toast.success('Еконт е премахнат');
    } catch (e) { toast.error(errMsg(e)); }
  }
  async function disconnectSpeedyFn() {
    if (!confirm('Да премахна ли връзката със Speedy? Данните на подателя се запазват.')) return;
    try {
      await disconnectSpeedy();
      setSpeedy((c) => ({ ...(c ?? {}), configured: false }));
      setSpeedyForm({ userName: '', password: '' });
      setEditS(false);
      toast.success('Speedy е премахнат');
    } catch (e) { toast.error(errMsg(e)); }
  }
```

- [ ] **Step 2: Replace the Еcont inputs block with a connected/edit branch**

In the Еcont `<form>` (line ~346-360), replace the `<div className="mt-4 space-y-3"> … </div>` + submit button with:

```tsx
                  {econt?.configured && !editE ? (
                    <div className="mt-4">
                      <div className="flex items-center gap-2 text-[13.5px] font-bold text-ff-green-700">
                        <CheckCircle2 size={16} /> Свързан{econt?.username ? <span className="text-ff-ink-2 font-semibold"> · потребител {econt.username}</span> : null}
                      </div>
                      <div className="mt-3 flex gap-2">
                        <button type="button" onClick={() => setEditE(true)} className="rounded-xl border border-ff-border px-4 py-2 text-[13px] font-bold">Промени</button>
                        <button type="button" onClick={disconnectEcontFn} className="rounded-xl border border-[#e7b8b0] px-4 py-2 text-[13px] font-bold text-ff-red">Премахни</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="mt-4 space-y-3">
                        <EnvRow isDemo={isDemo} />
                        <div>
                          <label className={lbl} htmlFor="econt-user">Потребител</label>
                          <input id="econt-user" className={inp} autoComplete="off" value={econtForm.username} onChange={(e) => setEcontForm({ ...econtForm, username: e.target.value })} />
                        </div>
                        <div>
                          <label className={lbl} htmlFor="econt-pass">Парола</label>
                          <input id="econt-pass" type="password" className={inp} autoComplete="new-password" placeholder={econt?.configured ? 'Въведи нова, за да смениш' : ''} value={econtForm.password} onChange={(e) => setEcontForm({ ...econtForm, password: e.target.value })} />
                        </div>
                      </div>
                      <button type="submit" disabled={savingE || !econtForm.username.trim() || !econtForm.password} className={btn + ' mt-4 w-full'}>
                        <Plug size={16} /> {savingE ? 'Запазвам…' : 'Запази'}
                      </button>
                    </>
                  )}
```

In `saveEcont`, after a successful save also exit edit mode: add `setEditE(false);` next to the `setEcontForm((f) => ({ ...f, password: '' }));` line.

- [ ] **Step 3: Mirror for Speedy**

Apply the same connected/edit branch to the Speedy `<form>` (line ~375-389) using `speedy`, `editS`/`setEditS`, `speedyForm`, `savingS`, `disconnectSpeedyFn`, and `speedy?.userName` for the username label. In `saveSpeedy`, add `setEditS(false);`.

- [ ] **Step 4: Verify lint + build**

Run: `pnpm -C delivery-web lint` then `pnpm -C delivery-web build`
Expected: both succeed. `CheckCircle2` is already imported in this file (used for the active badge).

- [ ] **Step 5: Commit**

```bash
git add delivery-web/src/components/settings-client.tsx
git commit -m "feat(delivery-web): carrier card connected state (✓ Свързан + Промени/Премахни)"
```

---

## Task 10: Full verification

- [ ] **Step 1: Server suite + build**

Run: `pnpm -C server test` then `pnpm -C server build`
Expected: all PASS (baseline 971 + the new sender/disconnect tests), clean build.

- [ ] **Step 2: delivery-web lint + build**

Run: `pnpm -C delivery-web lint` then `pnpm -C delivery-web build`
Expected: both succeed; no references to `carrier-profile-section` / `CarrierProfileSection`.

- [ ] **Step 3: Live smoke (after deploy)**

1. On a tenant with NO sender, connect Еcont demo creds (`iasp-dev`/`1Asp-dev`) → verify `settings.delivery.econt.sender` is auto-seeded (name/phone from the Еcont profile).
2. Settings → Куриерски акаунти: card shows „✓ Свързан · потребител iasp-dev" + Промени/Премахни.
3. Пратки/Внос: „Подаваш от: …" strip renders; ✎ opens the modal; edit office → saves (`saveProfile` 200), strip updates.
4. „Премахни" → card returns to inputs; DB `econt.configured=false`, `sender` still present.

- [ ] **Step 4: Update memory**

Note the feature shipped in a delivery memory file (page removed, sender auto-seeded, disconnect endpoints, card connected-state).

---

## Self-review notes

- **Spec coverage:** auto-seed (T1-T3), disconnect (T4-T5), modal (T6), strip (T7), mount + page removal (T8), card connected state (T9), verify + live smoke (T10). All spec sections covered.
- **Type consistency:** `deriveSenderFromFarm(farmName, contact, profiles) → { name, phone, mode:'office' }` used identically in Еcont (T2) + Speedy (T3); `maybeSeedSender` same signature both services; `clearCredsBlob`/`disconnect` mirror across carriers; `SenderModal` props (`carrier/open/onClose/onSaved`) match the strip's usage (T7) and mount (T8).
- **Best-effort safety:** sender seeding + profile fetch are wrapped so a failure never breaks `saveCredentials`; disconnect keeps `sender`.
- **Known follow-up:** the Еcont profile (`SenderSuggestion`) carries no office/city, so the seeded sender has name+phone + `mode:'office'` and the strip shows „⚠ Избери офис" until the farmer picks one in the modal — the single intended choice.
