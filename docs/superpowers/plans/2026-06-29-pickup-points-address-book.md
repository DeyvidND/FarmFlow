# Pickup-points address book — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a farm save multiple pickup points per carrier and pick one **active** point, without changing the waybill builder — `econt.sender`/`speedy.sender` stays the active point; a new `senders[]` book sits alongside it.

**Architecture:** Pure helpers `readSenderBook` (migrate single sender → list on read) + `applySenderBook` (write list + mirror the active point into `.sender`). New `POST …/senders` endpoint per carrier; `getConfig` surfaces the migrated list. The dostavki modal becomes a list manager. Downstream (buildLabel, auto-orders, import) is untouched.

**Tech Stack:** NestJS + Drizzle + Jest (server). Next.js + React (delivery-web; verify via `pnpm -C delivery-web lint` + `build`).

**Spec:** `docs/superpowers/specs/2026-06-29-pickup-points-address-book-design.md`

---

## File Structure

- `server/src/modules/econt/sender-book.ts` — **new**: `readSenderBook` + `applySenderBook` (carrier-agnostic, operate on the jsonb blob).
- `server/src/modules/econt/sender-book.spec.ts` — **new**: helper tests.
- `server/src/modules/econt/econt.service.ts` — `getConfig` migration; new `saveSenders`.
- `server/src/modules/speedy/speedy.service.ts` — `getConfig` migration; new `saveSenders`.
- `server/src/modules/econt/dto/econt-senders.dto.ts` — **new**: `EcontSaveSendersDto`.
- `server/src/modules/speedy/dto/speedy-senders.dto.ts` — **new**: `SpeedySaveSendersDto`.
- `server/src/modules/econt-app/econt-standalone.controller.ts` — `POST /shipping/senders`.
- `server/src/modules/speedy/speedy-standalone.controller.ts` — `POST /speedy/senders`.
- `delivery-web/src/lib/api-client.ts` — `saveEcontSenders`/`saveSpeedySenders` + `PickupPoint` types + config `senders`/`activeSenderId`.
- `delivery-web/src/components/sender-modal.tsx` — rewrite as a list manager.
- `delivery-web/src/components/sender-strip.tsx` — show „· N точки".

---

## Task 1: `sender-book` pure helpers (server, TDD)

**Files:**
- Create: `server/src/modules/econt/sender-book.ts`
- Test: `server/src/modules/econt/sender-book.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/econt/sender-book.spec.ts`:

```ts
import { readSenderBook, applySenderBook } from './sender-book';

describe('readSenderBook', () => {
  it('returns the existing senders + a valid activeId', () => {
    const out = readSenderBook({
      senders: [{ id: 'a', label: 'Основна', name: 'Х' }, { id: 'b', label: 'Склад', name: 'Y' }],
      activeSenderId: 'b',
    });
    expect(out).toEqual({ senders: [{ id: 'a', label: 'Основна', name: 'Х' }, { id: 'b', label: 'Склад', name: 'Y' }], activeId: 'b' });
  });

  it('falls back activeId to the first point when activeSenderId is missing/unknown', () => {
    const out = readSenderBook({ senders: [{ id: 'a', label: 'Основна', name: 'Х' }], activeSenderId: 'zzz' });
    expect(out.activeId).toBe('a');
  });

  it('migrates a lone sender into a one-point book labelled „Основна"', () => {
    const out = readSenderBook({ sender: { name: 'Ферма', phone: '0700', mode: 'office' } });
    expect(out.senders).toEqual([{ id: 'p1', label: 'Основна', name: 'Ферма', phone: '0700', mode: 'office' }]);
    expect(out.activeId).toBe('p1');
  });

  it('returns an empty book when neither senders nor sender exist', () => {
    expect(readSenderBook({})).toEqual({ senders: [], activeId: null });
    expect(readSenderBook(null)).toEqual({ senders: [], activeId: null });
  });
});

describe('applySenderBook', () => {
  const senders = [
    { id: 'a', label: 'Основна', name: 'Х', phone: '1', mode: 'office', officeCode: '10' },
    { id: 'b', label: 'Склад', name: 'Y', phone: '2', mode: 'office', officeCode: '20' },
  ];

  it('writes the book + mirrors the active point into sender (without id/label)', () => {
    const out = applySenderBook({ username: 'u', sender: { name: 'old' } }, senders, 'b');
    expect(out.senders).toEqual(senders);
    expect(out.activeSenderId).toBe('b');
    expect(out.sender).toEqual({ name: 'Y', phone: '2', mode: 'office', officeCode: '20' });
    expect(out.username).toBe('u'); // untouched
  });

  it('falls back to the first point when activeId is unknown', () => {
    const out = applySenderBook({}, senders, 'zzz');
    expect(out.activeSenderId).toBe('a');
    expect(out.sender).toMatchObject({ name: 'Х' });
  });

  it('clears the active sender when the book is empty', () => {
    const out = applySenderBook({ sender: { name: 'old' } }, [], 'a');
    expect(out.senders).toEqual([]);
    expect(out.activeSenderId).toBeNull();
    expect(out.sender).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C server test -- sender-book.spec`
Expected: FAIL — `Cannot find module './sender-book'`.

- [ ] **Step 3: Implement the helpers**

Create `server/src/modules/econt/sender-book.ts`:

```ts
/** A saved pickup point = the carrier's sender fields + id + label. Carrier-agnostic
 *  here (the sender fields differ per carrier; we only touch id/label generically). */
export type PickupPoint = Record<string, unknown> & { id: string; label: string };

/**
 * Read the pickup-point book off a carrier blob, migrating a legacy single `sender`
 * into a one-point book on the fly (no DB migration). Returns the list + the active id
 * (defaulting to the first point when the stored activeSenderId is missing/unknown).
 */
export function readSenderBook(
  blob: Record<string, unknown> | null | undefined,
): { senders: PickupPoint[]; activeId: string | null } {
  const b = (blob ?? {}) as Record<string, unknown>;
  const raw = b.senders;
  if (Array.isArray(raw) && raw.length) {
    const senders = raw as PickupPoint[];
    const stored = b.activeSenderId;
    const activeId =
      typeof stored === 'string' && senders.some((p) => p.id === stored) ? stored : senders[0].id;
    return { senders, activeId };
  }
  const sender = b.sender as Record<string, unknown> | undefined;
  if (sender && Object.keys(sender).length) {
    return { senders: [{ id: 'p1', label: 'Основна', ...sender }], activeId: 'p1' };
  }
  return { senders: [], activeId: null };
}

/**
 * Write the book onto a carrier blob and mirror the active point's sender fields into
 * `sender` (stripped of id/label) so the waybill builder — which reads `.sender` —
 * transparently uses the active point. Unknown activeId → first point; empty book →
 * cleared active sender. Never touches other blob keys (creds/handling/package/COD).
 */
export function applySenderBook(
  blob: Record<string, unknown>,
  senders: PickupPoint[],
  activeId: string,
): Record<string, unknown> {
  const active = senders.find((p) => p.id === activeId) ?? senders[0] ?? null;
  let sender: Record<string, unknown> = {};
  if (active) {
    const rest = { ...active } as Record<string, unknown>;
    delete rest.id;
    delete rest.label;
    sender = rest;
  }
  return { ...blob, senders, activeSenderId: active ? active.id : null, sender };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C server test -- sender-book.spec`
Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt/sender-book.ts server/src/modules/econt/sender-book.spec.ts
git commit -m "feat(delivery): sender-book helpers (read-migrate + apply-mirror pickup points)"
```

---

## Task 2: Еcont — getConfig migration + saveSenders + route (server, TDD)

**Files:**
- Create: `server/src/modules/econt/dto/econt-senders.dto.ts`
- Modify: `server/src/modules/econt/econt.service.ts` (import helpers; `getConfig` ~line 285-289; new `saveSenders`)
- Modify: `server/src/modules/econt-app/econt-standalone.controller.ts` (route)
- Test: `server/src/modules/econt/econt.service.spec.ts`

- [ ] **Step 1: Write the failing test (saveSenders writes book + mirrors active)**

In `server/src/modules/econt/econt.service.spec.ts`, add:

```ts
import { applySenderBook } from './sender-book';

describe('EcontService.buildSenderBlob (unit)', () => {
  const svc = new EcontService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never);
  const build = (econt: unknown, senders: unknown, activeId: string) =>
    (svc as unknown as {
      buildSenderBlob: (e: any, s: any, a: string) => Record<string, unknown>;
    }).buildSenderBlob(econt, senders, activeId);

  it('mirrors the active point into sender + keeps creds', () => {
    const out = build(
      { username: 'u', passwordEnc: 'enc', configured: true },
      [{ id: 'a', label: 'Основна', name: 'Х', mode: 'office', officeCode: '1' },
       { id: 'b', label: 'Склад', name: 'Y', mode: 'office', officeCode: '2' }],
      'b',
    );
    expect(out.username).toBe('u');
    expect(out.passwordEnc).toBe('enc');
    expect(out.activeSenderId).toBe('b');
    expect(out.sender).toEqual({ name: 'Y', mode: 'office', officeCode: '2' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C server test -- econt.service.spec -t buildSenderBlob`
Expected: FAIL — `buildSenderBlob is not a function`.

- [ ] **Step 3: Add the DTO**

Create `server/src/modules/econt/dto/econt-senders.dto.ts`:

```ts
import { Type } from 'class-transformer';
import {
  IsArray, IsString, IsNotEmpty, IsOptional, IsIn, IsNumber, MaxLength,
  ValidateNested, ArrayMaxSize,
} from 'class-validator';

/** One Еcont pickup point: the sender fields + id + label. */
export class EcontPickupPointDto {
  @IsString() @IsNotEmpty() @MaxLength(40) id!: string;
  @IsString() @IsNotEmpty() @MaxLength(60) label!: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsNumber() cityId?: number;
  @IsOptional() @IsString() @MaxLength(120) cityName?: string;
  @IsOptional() @IsIn(['office', 'address']) mode?: 'office' | 'address';
  @IsOptional() @IsString() @MaxLength(40) officeCode?: string;
  @IsOptional() @IsString() @MaxLength(200) address?: string;
}

export class EcontSaveSendersDto {
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => EcontPickupPointDto)
  senders!: EcontPickupPointDto[];
  @IsString() @IsNotEmpty() @MaxLength(40) activeId!: string;
}
```

- [ ] **Step 4: Implement `buildSenderBlob` + `saveSenders` + migrate `getConfig`**

In `server/src/modules/econt/econt.service.ts`:

a) Add to the imports (next to `deriveSenderFromFarm` at line 15):

```ts
import { readSenderBook, applySenderBook, type PickupPoint } from './sender-book';
```

b) Add the pure builder + the save method (near `saveProfile`, ~line 262):

```ts
  /** Pure: build the next econt blob with the book + mirrored active sender. */
  private buildSenderBlob(econt: Record<string, unknown>, senders: PickupPoint[], activeId: string): Record<string, unknown> {
    return applySenderBook(econt, senders, activeId);
  }

  /** Persist the pickup-point book; mirror the active point into `sender`. */
  async saveSenders(tenantId: string, input: { senders: PickupPoint[]; activeId: string }): Promise<{ ok: true }> {
    const { tenant, econt } = await this.loadStored(tenantId);
    const nextEcont = this.buildSenderBlob(econt, input.senders, input.activeId);
    const nextSettings = {
      ...tenant.settings,
      delivery: { ...((tenant.settings.delivery as Record<string, unknown>) ?? {}), econt: nextEcont },
    };
    await this.db.update(tenants).set({ settings: nextSettings }).where(eq(tenants.id, tenantId));
    await this.cache.del(publicCacheKeys.tenant(tenant.slug));
    return { ok: true };
  }
```

c) Migrate `getConfig` (line 285-289) — surface the book:

```ts
  async getConfig(tenantId: string): Promise<Record<string, unknown>> {
    const { tenant, econt } = await this.loadStored(tenantId);
    const { passwordEnc: _pw, ...safe } = econt;
    const book = readSenderBook(econt);
    return {
      ...safe,
      senders: book.senders,
      activeSenderId: book.activeId,
      configured: !!econt.configured,
      isDemo: tenant.isDemo,
      env: tenant.isDemo ? 'demo' : 'prod',
    };
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -C server test -- econt.service.spec -t buildSenderBlob`
Expected: PASS.

- [ ] **Step 6: Add the controller route**

In `server/src/modules/econt-app/econt-standalone.controller.ts`, add the import:

```ts
import { EcontSaveSendersDto } from '../econt/dto/econt-senders.dto';
```

and next to `@Post('profile')`:

```ts
  @Post('senders')
  saveSenders(@CurrentTenant() t: string, @Body() dto: EcontSaveSendersDto) {
    return this.econt.saveSenders(t, dto);
  }
```

- [ ] **Step 7: Run the Еcont suite + build**

Run: `pnpm -C server test -- econt.service.spec sender-book.spec` then `pnpm -C server build`
Expected: PASS + clean build.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.service.spec.ts server/src/modules/econt/dto/econt-senders.dto.ts server/src/modules/econt-app/econt-standalone.controller.ts
git commit -m "feat(econt): pickup-point book — getConfig migration + saveSenders + /shipping/senders"
```

---

## Task 3: Speedy — getConfig migration + saveSenders + route (server, TDD)

**Files:**
- Create: `server/src/modules/speedy/dto/speedy-senders.dto.ts`
- Modify: `server/src/modules/speedy/speedy.service.ts` (`getConfig` ~line 214-217; new `saveSenders`)
- Modify: `server/src/modules/speedy/speedy-standalone.controller.ts` (route)
- Test: `server/src/modules/speedy/speedy.service.spec.ts`

- [ ] **Step 1: Write the failing test**

In `server/src/modules/speedy/speedy.service.spec.ts`, add (match the `new SpeedyService(...)` arity used elsewhere in the file):

```ts
describe('SpeedyService.buildSenderBlob (unit)', () => {
  const svc = new SpeedyService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never, {} as never);
  const build = (speedy: unknown, senders: unknown, activeId: string) =>
    (svc as unknown as {
      buildSenderBlob: (s: any, ss: any, a: string) => Record<string, unknown>;
    }).buildSenderBlob(speedy, senders, activeId);

  it('mirrors the active Speedy point (contactName) into sender + keeps creds', () => {
    const out = build(
      { userName: 'u', passwordEnc: 'enc', configured: true },
      [{ id: 'a', label: 'Основна', contactName: 'Х', mode: 'office', officeId: 1 },
       { id: 'b', label: 'Склад', contactName: 'Y', mode: 'office', officeId: 2 }],
      'b',
    );
    expect(out.userName).toBe('u');
    expect(out.activeSenderId).toBe('b');
    expect(out.sender).toEqual({ contactName: 'Y', mode: 'office', officeId: 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C server test -- speedy.service.spec -t buildSenderBlob`
Expected: FAIL — `buildSenderBlob is not a function`.

- [ ] **Step 3: Add the DTO**

Create `server/src/modules/speedy/dto/speedy-senders.dto.ts`:

```ts
import { Type } from 'class-transformer';
import {
  IsArray, IsString, IsNotEmpty, IsOptional, IsIn, IsNumber, MaxLength,
  ValidateNested, ArrayMaxSize,
} from 'class-validator';

/** One Speedy pickup point: the sender fields (contactName-based) + id + label. */
export class SpeedyPickupPointDto {
  @IsString() @IsNotEmpty() @MaxLength(40) id!: string;
  @IsString() @IsNotEmpty() @MaxLength(60) label!: string;
  @IsOptional() @IsString() @MaxLength(120) contactName?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsIn(['office', 'address']) mode?: 'office' | 'address';
  @IsOptional() @IsNumber() officeId?: number;
  @IsOptional() @IsNumber() siteId?: number;
  @IsOptional() @IsString() @MaxLength(120) siteName?: string;
  @IsOptional() @IsNumber() streetId?: number;
  @IsOptional() @IsString() @MaxLength(40) streetNo?: string;
}

export class SpeedySaveSendersDto {
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => SpeedyPickupPointDto)
  senders!: SpeedyPickupPointDto[];
  @IsString() @IsNotEmpty() @MaxLength(40) activeId!: string;
}
```

- [ ] **Step 4: Implement `buildSenderBlob` + `saveSenders` + migrate `getConfig`**

In `server/src/modules/speedy/speedy.service.ts`:

a) Add the import (next to the existing `deriveSenderFromFarm` import):

```ts
import { readSenderBook, applySenderBook, type PickupPoint } from '../econt/sender-book';
```

b) Add (near `saveProfile`):

```ts
  private buildSenderBlob(speedy: Record<string, unknown>, senders: PickupPoint[], activeId: string): Record<string, unknown> {
    return applySenderBook(speedy, senders, activeId);
  }

  async saveSenders(tenantId: string, input: { senders: PickupPoint[]; activeId: string }): Promise<{ ok: true }> {
    const { tenant, speedy } = await this.loadStored(tenantId);
    const nextSpeedy = this.buildSenderBlob(speedy, input.senders, input.activeId);
    const nextSettings = {
      ...tenant.settings,
      delivery: { ...((tenant.settings.delivery as Record<string, unknown>) ?? {}), speedy: nextSpeedy },
    };
    await this.db.update(tenants).set({ settings: nextSettings }).where(eq(tenants.id, tenantId));
    await this.cache.del(`tenant:${tenant.slug}`);
    return { ok: true };
  }
```

> Use the same tenant-cache key Speedy's `saveProfile` uses (`tenant:${slug}`); match it if it differs.

c) Migrate `getConfig` (line 214-217):

```ts
  async getConfig(tenantId: string): Promise<Record<string, unknown>> {
    const { tenant, speedy } = await this.loadStored(tenantId);
    const { passwordEnc: _pw, ...safe } = speedy;
    const book = readSenderBook(speedy);
    return {
      ...safe,
      senders: book.senders,
      activeSenderId: book.activeId,
      configured: !!speedy.configured,
      isDemo: tenant.isDemo,
      env: tenant.isDemo ? 'demo' : 'prod',
    };
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -C server test -- speedy.service.spec -t buildSenderBlob`
Expected: PASS.

- [ ] **Step 6: Add the controller route**

In `server/src/modules/speedy/speedy-standalone.controller.ts`, add the import:

```ts
import { SpeedySaveSendersDto } from '../speedy/dto/speedy-senders.dto';
```

and next to `@Post('profile')`:

```ts
  @Post('senders')
  saveSenders(@CurrentTenant() t: string, @Body() dto: SpeedySaveSendersDto) {
    return this.speedy.saveSenders(t, dto);
  }
```

> The import path may be `./dto/speedy-senders.dto` or `../speedy/...` depending on the controller's location — match how the controller imports `SpeedyProfileDto` and mirror it.

- [ ] **Step 7: Run the Speedy suite + build**

Run: `pnpm -C server test -- speedy.service.spec` then `pnpm -C server build`
Expected: PASS + clean build.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/speedy/speedy.service.ts server/src/modules/speedy/speedy.service.spec.ts server/src/modules/speedy/dto/speedy-senders.dto.ts server/src/modules/speedy/speedy-standalone.controller.ts
git commit -m "feat(speedy): pickup-point book — getConfig migration + saveSenders + /speedy/senders"
```

---

## Task 4: delivery-web api-client — senders types + save calls

**Files:**
- Modify: `delivery-web/src/lib/api-client.ts`

- [ ] **Step 1: Add the types + functions**

In `delivery-web/src/lib/api-client.ts`:

a) After the `EcontSender` / `SpeedySender` interfaces (~line 277-312), add:

```ts
export type EcontPickupPoint = EcontSender & { id: string; label: string };
export type SpeedyPickupPoint = SpeedySender & { id: string; label: string };
```

b) In the `EcontConfig` interface, add (next to `sender?`):

```ts
  senders?: EcontPickupPoint[];
  activeSenderId?: string | null;
```

and the same two fields (with `SpeedyPickupPoint`) in the `SpeedyConfig` interface.

c) After `saveSpeedyProfile` (~line 340), add (match the `bff` helper shape used by `saveEcontProfile`):

```ts
/** Save the Еcont pickup-point book + which point is active. */
export const saveEcontSenders = async (body: { senders: EcontPickupPoint[]; activeId: string }): Promise<{ ok: true }> =>
  (await bff('shipping/senders', { method: 'POST', body: JSON.stringify(body) }, 'Запазването се провали')).json();

/** Save the Speedy pickup-point book + which point is active. */
export const saveSpeedySenders = async (body: { senders: SpeedyPickupPoint[]; activeId: string }): Promise<{ ok: true }> =>
  (await bff('speedy/senders', { method: 'POST', body: JSON.stringify(body) }, 'Запазването се провали')).json();
```

> Copy the exact `bff(...)` call shape + headers from `saveEcontProfile` (e.g. it may already set `Content-Type`); only change the path + payload.

- [ ] **Step 2: Verify**

Run: `pnpm -C delivery-web lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add delivery-web/src/lib/api-client.ts
git commit -m "feat(delivery-web): saveEcontSenders/saveSpeedySenders + pickup-point types"
```

---

## Task 5: Sender modal → pickup-point list manager (delivery-web)

**Files:**
- Modify: `delivery-web/src/components/sender-modal.tsx`

**Context:** Today the modal edits one sender per carrier (state `eSender`/`sSender`, save via `saveEcontProfile`/`saveSpeedyProfile`). Rewrite it to manage a **list** of points: it loads `getEcontConfig()/getSpeedyConfig()` → `{ senders, activeSenderId }`, shows the list, lets the user pick the active one, edit a point inline (the existing name/phone/office/address form), delete a point, and add a new one — then saves the whole book via `saveEcontSenders`/`saveSpeedySenders`. The single-point edit form already in this file is REUSED as the per-point editor.

- [ ] **Step 1: Replace the modal body with a list manager**

Rewrite `delivery-web/src/components/sender-modal.tsx` so that, for the given `carrier`:

1. **State:**
   ```tsx
   const [points, setPoints] = useState<EcontPickupPoint[]>([]); // or SpeedyPickupPoint[]
   const [activeId, setActiveId] = useState<string>('');
   const [editingId, setEditingId] = useState<string | null>(null); // which point's form is open
   const [saving, setSaving] = useState(false);
   ```
2. **Load on open:** call `getEcontConfig()` / `getSpeedyConfig()`; set `points` from `config.senders ?? []` and `activeId` from `config.activeSenderId ?? points[0]?.id ?? ''`.
3. **List render:** for each point a row with: its `label` + a one-line summary (`name`/`contactName` · office/site), a „✓ Активна" badge when `point.id === activeId`, and buttons:
   - **Избери** (`onClick={() => setActiveId(point.id)}`) — disabled when already active;
   - **✎** (`setEditingId(point.id)`) — opens the existing field form bound to that point (use the SAME name/phone + city autocomplete + office picker controls that the current modal has, but writing into `points[i]` instead of `eSender`); the office-fetch effects key on the editing point's `cityId`/`siteId`;
   - **Изтрий** (`onClick`) — removes the point; if it was active, promote `points[0]` (after removal) to active; **disabled when only one point remains**.
4. **„+ Добави точка"**: appends `{ id: crypto.randomUUID().slice(0, 8), label: 'Нова точка', mode: 'office' }` and opens it for editing.
5. **Label field:** each point's editor includes a „Име на точката" text input bound to `point.label`.
6. **Save (footer „Запази"):**
   ```tsx
   const fn = carrier === 'econt' ? saveEcontSenders : saveSpeedySenders;
   await fn({ senders: points as never, activeId });
   onSaved(); onClose();
   ```
7. **Package + COD** stay under the „Разширени" toggle (farm-level, not per-point). On Save, do TWO calls in order: first `saveEcontSenders`/`saveSpeedySenders({ senders, activeId })` (writes the book + mirrors the active point into `sender`), then the existing `saveEcontProfile`/`saveSpeedyProfile({ defaultPackage, cod })` (updates package/COD — different blob keys, so it does not clobber the just-written sender). `defaultPackage`/`cod` are loaded from the config on open, as today.

Keep the overlay/close behaviour and the `{carrier, open, onClose, onSaved}` props unchanged. Reuse the existing `Seg`/`Autocomplete`/office-picker helpers already in the file.

> This is a focused rewrite of one component. Preserve every existing field control (name/phone, city autocomplete, office picker, address mode, package, COD) — they now bind to the selected point instead of a single sender object. Do not change the server payload shape beyond `{ senders, activeId }`.

- [ ] **Step 2: Verify**

Run: `pnpm -C delivery-web lint` then `pnpm -C delivery-web build`
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add delivery-web/src/components/sender-modal.tsx
git commit -m "feat(delivery-web): sender modal → pickup-point list manager (pick/edit/delete/add)"
```

---

## Task 6: Strip shows „· N точки" (delivery-web)

**Files:**
- Modify: `delivery-web/src/components/sender-strip.tsx`

- [ ] **Step 1: Surface the point count**

In `sender-strip.tsx`, extend the `Row` type with `count: number`, set it from `config.senders?.length ?? (sender ? 1 : 0)` in `load()`, and in the active-line render append „· N точки" when `count > 1`:

```tsx
{hasPickup ? (
  <>Подаваш от <b className="text-ff-ink">{name}</b>{place ? <> · {place}</> : null}
    {r.count > 1 ? <> · {r.count} точки</> : null} <span className="text-ff-muted">({r.label})</span></>
) : ( /* unchanged ⚠ prompt */ )}
```

Update the two `next.push({...})` calls to include `count: (e.value.senders as unknown[] | undefined)?.length ?? (e.value.sender ? 1 : 0)` (and the Speedy equivalent).

- [ ] **Step 2: Verify**

Run: `pnpm -C delivery-web lint` then `pnpm -C delivery-web build`
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add delivery-web/src/components/sender-strip.tsx
git commit -m "feat(delivery-web): strip shows „· N точки" when a farm has multiple pickup points"
```

---

## Task 7: Full verification

- [ ] **Step 1: Server suite + build**

Run: `pnpm -C server test` then `pnpm -C server build`
Expected: all PASS (baseline 980 + new sender-book + buildSenderBlob tests), clean build.

- [ ] **Step 2: delivery-web lint + build**

Run: `pnpm -C delivery-web lint` then `pnpm -C delivery-web build`
Expected: both succeed.

- [ ] **Step 3: Live smoke (after deploy)**

1. On a connected tenant, `getEcontConfig` → `senders` has the auto-seeded point as „Основна", `activeSenderId` set.
2. Modal: „+ Добави точка" → fill a 2nd point (different office) → Save. `settings.delivery.econt.senders` has 2; `sender` still the active one.
3. Switch active to the 2nd point → Save → `settings.delivery.econt.sender` now mirrors the 2nd point (verify in DB).
4. Strip shows „· 2 точки". Delete one → back to 1, „Основна" active.
5. Confirm a waybill build still reads `econt.sender` (the active point) — unchanged behaviour.

- [ ] **Step 4: Update memory**

Note the address book shipped (active-point model, `senders[]` + mirrored `sender`, migration-on-read, modal list manager).

---

## Self-review notes

- **Spec coverage:** active-point model + `senders[]` (T1 helpers); per-carrier getConfig migration + saveSenders + DTO + route (T2 Еcont, T3 Speedy); api-client (T4); modal list manager (T5); strip count (T6); verify + live smoke (T7). All spec sections covered.
- **Type consistency:** `readSenderBook(blob) → {senders, activeId}` and `applySenderBook(blob, senders, activeId) → blob` used identically in both services via `buildSenderBlob`; DTO field `activeId` matches the service input + api-client body `{ senders, activeId }`; `PickupPoint = sender + {id,label}` consistent client (`EcontPickupPoint`/`SpeedyPickupPoint`) + server. `getConfig` returns `senders` + `activeSenderId`; the modal reads those exact keys.
- **Downstream untouched:** `buildLabel`/`buildShipmentRequest` keep reading `.sender`; `applySenderBook` mirrors the active point's fields (minus id/label) into `.sender`. Verified by the existing 980 tests staying green.
- **Edge cases:** unknown activeId → first point (helper + tests); empty book → cleared sender; ≤1 point → delete disabled (UI).
