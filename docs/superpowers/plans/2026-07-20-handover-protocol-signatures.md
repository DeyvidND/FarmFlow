# Handover Protocols — Saved Signatures, .doc Layout, Offline „Проверка" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Farmers/operator save one encrypted signature in their profile; farmer→operator handovers sign in one tap; the protocol PDF matches the official bilateral `.doc`; a fullscreen offline „Проверка" view shows the day's signed protocols for a roadside police check.

**Architecture:** New nullable encrypted columns hold each party's reusable signature (AES-256-GCM via the existing `secret.util`, degrading to plaintext when `ENCRYPTION_KEY` is unset). Dedicated signature endpoints keep the blobs out of general farmer/tenant payloads. `HandoverService` auto-fills saved signatures at sign time; `handover-pdf` is rewritten to the two-party bilateral form; a new `GET /handover/check` feeds a pure-HTML fullscreen view that caches to IndexedDB for offline display.

**Tech Stack:** NestJS + Drizzle (Postgres) backend, Next.js App Router (client `@fermeribg/web`) frontend, `pdf-lib` for PDFs, jest (server) + vitest Node-only (client) for tests.

## Global Constraints

- **Migrations are hand-written.** Next file `packages/db/drizzle/0110_handover_signatures.sql`; journal `packages/db/drizzle/meta/_journal.json` next entry `idx: 108`, `version: "7"`, `tag: "0110_handover_signatures"`. No gaps.
- **Multi-tenant:** every query scoped by `tenantId`. Never select a signature column in a public projection.
- **`ENCRYPTION_KEY` is OPTIONAL** (`env.validation.ts:49`). Signature crypto MUST degrade to plaintext when it is unset — never throw for a missing key.
- **Optional string DTO fields:** class-validator `@IsOptional()` does NOT coerce `''`→`undefined`.
- **Client `@fermeribg/web` does NOT import `@fermeribg/db`/`@fermeribg/types`** — types live in the hand-synced mirror `client/src/lib/types.ts`.
- **Frontends call the API only via `/bff/*`** (see `protocolPdfHref = '/bff/handover/...'`).
- **Europe/Sofia** for all date math (PDF already uses `bgDateOf`).
- **Mobile matters** — this panel is used on phones; verify at 375px.
- **Bulgarian UI copy**, matching existing tone (е.g. „Подпис", „Проверка", „Изчисти").

---

## Task 1: Signature crypto helper

**Files:**
- Create: `server/src/common/crypto/signature-crypto.ts`
- Test: `server/src/common/crypto/signature-crypto.spec.ts`

**Interfaces:**
- Consumes: `encryptSecret`, `decryptSecret` from `./secret.util` (AES-256-GCM, output `iv:tag:ct` base64).
- Produces:
  - `encryptSignature(plaintext: string, key?: string): string`
  - `decryptSignature(blob: string | null | undefined, key?: string): string | null`
  - `looksEncrypted(v: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// signature-crypto.spec.ts
import { encryptSignature, decryptSignature, looksEncrypted } from './signature-crypto';

const KEY = 'test-key-123';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('signature-crypto', () => {
  it('round-trips with a key', () => {
    const enc = encryptSignature(PNG, KEY);
    expect(enc).not.toEqual(PNG);
    expect(looksEncrypted(enc)).toBe(true);
    expect(decryptSignature(enc, KEY)).toEqual(PNG);
  });

  it('degrades to plaintext when no key', () => {
    expect(encryptSignature(PNG, undefined)).toEqual(PNG);
  });

  it('passes legacy plaintext data-URL through decrypt unchanged', () => {
    expect(decryptSignature(PNG, KEY)).toEqual(PNG);
    expect(looksEncrypted(PNG)).toBe(false);
  });

  it('returns null for empty', () => {
    expect(decryptSignature(null, KEY)).toBeNull();
    expect(decryptSignature('', KEY)).toBeNull();
  });

  it('tolerates a malformed ciphertext-shaped value', () => {
    expect(decryptSignature('aa:bb:cc', KEY)).toBe('aa:bb:cc');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- signature-crypto`
Expected: FAIL — cannot find module `./signature-crypto`.

- [ ] **Step 3: Write the implementation**

```ts
// signature-crypto.ts
import { encryptSecret, decryptSecret } from './secret.util';

/**
 * Encryption for a stored, reusable signature PNG (data-URL). Wraps the shared
 * AES-256-GCM `secret.util`. `ENCRYPTION_KEY` is OPTIONAL in this deployment, so
 * both helpers DEGRADE to plaintext when no key is configured (dev) — the feature
 * still works; production always has the key set (Econt creds require it too).
 */

/** True when `v` has our ciphertext shape: three non-empty base64 parts `iv:tag:ct`.
 *  A plaintext `data:image/png;base64,…` URL has only ONE colon → false. */
export function looksEncrypted(v: string): boolean {
  const parts = v.split(':');
  return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9+/]+=*$/.test(p));
}

export function encryptSignature(plaintext: string, key = process.env.ENCRYPTION_KEY): string {
  if (!key) return plaintext;
  return encryptSecret(plaintext, key);
}

export function decryptSignature(
  blob: string | null | undefined,
  key = process.env.ENCRYPTION_KEY,
): string | null {
  if (!blob) return null;
  if (!key || !looksEncrypted(blob)) return blob;
  try {
    return decryptSecret(blob, key);
  } catch {
    // Never 500 a legal document over one mis-shaped signature value.
    return blob;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- signature-crypto`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/common/crypto/signature-crypto.ts server/src/common/crypto/signature-crypto.spec.ts
git commit -m "feat(handover): encrypted-signature crypto helper (degrades to plaintext)"
```

---

## Task 2: DB columns + migration

**Files:**
- Modify: `packages/db/src/schema.ts` (add columns to `farmers` and `tenants`)
- Create: `packages/db/drizzle/0110_handover_signatures.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `farmers.signaturePng` (`signature_png text`), `tenants.operatorSignaturePng` (`operator_signature_png text`).

- [ ] **Step 1: Add the `farmers` column**

In `packages/db/src/schema.ts`, inside the `farmers` pgTable column block (near `payout`, around line 1215), add:

```ts
    // Reusable farmer signature for handover protocols — ENCRYPTED at rest
    // (server/common/crypto/signature-crypto). Operator-only; never in the public
    // projection. NULL = none saved yet. (migration 0110)
    signaturePng: text('signature_png'),
```

- [ ] **Step 2: Add the `tenants` column**

In the `tenants` pgTable column block, add:

```ts
    // Reusable operator signature for handover protocols — ENCRYPTED at rest.
    // Stored as its own column (NOT settings.legal, which updateLegal replaces
    // wholesale). NULL = none saved yet. (migration 0110)
    operatorSignaturePng: text('operator_signature_png'),
```

- [ ] **Step 3: Write the migration SQL**

```sql
-- 0110_handover_signatures.sql
-- Reusable, encrypted per-party signatures for handover protocols.
ALTER TABLE farmers ADD COLUMN IF NOT EXISTS signature_png text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS operator_signature_png text;
```

- [ ] **Step 4: Add the journal entry**

Append to the `entries` array in `packages/db/drizzle/meta/_journal.json` (after the `idx: 107` entry):

```json
    {
      "idx": 108,
      "version": "7",
      "when": 1784700000000,
      "tag": "0110_handover_signatures",
      "breakpoints": true
    }
```

(Ensure the previous entry now ends with a comma.)

- [ ] **Step 5: Apply + verify**

Run: `pnpm --filter @fermeribg/db build && pnpm db:migrate`
Expected: migrator applies `0110_handover_signatures` with no error; re-running is a no-op.
Verify: `docker exec farmflow-postgres-1 psql -U postgres -d farmflow -c "\d farmers" | grep signature_png` shows the column.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0110_handover_signatures.sql packages/db/drizzle/meta/_journal.json
git commit -m "feat(db): 0110 add encrypted signature columns to farmers + tenants"
```

---

## Task 3: City-from-address parser

**Files:**
- Create: `server/src/modules/handover/handover-city.ts`
- Test: `server/src/modules/handover/handover-city.spec.ts`

**Interfaces:**
- Produces: `cityFromAddress(address?: string | null): { prefix: string; name: string } | null`

- [ ] **Step 1: Write the failing test**

```ts
// handover-city.spec.ts
import { cityFromAddress } from './handover-city';

describe('cityFromAddress', () => {
  it('extracts гр.', () => {
    expect(cityFromAddress('гр. Варна, ул. Приморска 12')).toEqual({ prefix: 'гр.', name: 'Варна' });
  });
  it('extracts a two-word settlement', () => {
    expect(cityFromAddress('гр. Велико Търново, пл. Майка България 1')).toEqual({ prefix: 'гр.', name: 'Велико Търново' });
  });
  it('extracts село', () => {
    expect(cityFromAddress('с. Кранево, общ. Балчик')).toEqual({ prefix: 'с.', name: 'Кранево' });
  });
  it('returns null when no settlement token', () => {
    expect(cityFromAddress('ул. Приморска 12')).toBeNull();
    expect(cityFromAddress('')).toBeNull();
    expect(cityFromAddress(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- handover-city`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// handover-city.ts
/**
 * Best-effort settlement name for the „Днес, …, в гр./с. X" clause on a protocol,
 * parsed from a free-text legal address. Matches „гр."/„град"/„с."/„село" then up
 * to two capitalized words. null when nothing recognizable — the caller drops the
 * clause gracefully. Heuristic by design (addresses are unstructured).
 */
export function cityFromAddress(address?: string | null): { prefix: string; name: string } | null {
  if (!address) return null;
  const m = address.match(
    /(?:^|[\s,])(гр|град|с|село)\.?\s+([А-ЯA-Z][А-Яа-яA-Za-z-]+(?:\s+[А-ЯA-Z][А-Яа-яA-Za-z-]+)?)/u,
  );
  if (!m) return null;
  const name = m[2].trim().replace(/[.,]+$/, '');
  if (!name) return null;
  const prefix = /^гр|^град/i.test(m[1]) ? 'гр.' : 'с.';
  return { prefix, name };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- handover-city`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/handover/handover-city.ts server/src/modules/handover/handover-city.spec.ts
git commit -m "feat(handover): city-from-address parser for protocol opening line"
```

---

## Task 4: Farmer signature endpoints

**Files:**
- Create: `server/src/modules/farmers/dto/signature.dto.ts`
- Modify: `server/src/modules/farmers/farmers.service.ts` (add two methods)
- Modify: `server/src/modules/farmers/farmers.controller.ts` (add two routes)
- Test: `server/src/modules/farmers/farmers.signature.spec.ts`

**Interfaces:**
- Consumes: `encryptSignature`, `decryptSignature` (Task 1); `farmers.signaturePng` (Task 2).
- Produces:
  - `FarmersService.getSignature(id, tenantId): Promise<{ signaturePng: string | null }>`
  - `FarmersService.setSignature(id, tenantId, png: string | null): Promise<{ signaturePng: string | null }>`
  - Routes `GET /farmers/:id/signature`, `PUT /farmers/:id/signature`.
  - `SignatureDto { signaturePng?: string | null }`

- [ ] **Step 1: Write the DTO**

```ts
// dto/signature.dto.ts
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/** A reusable party signature as a PNG data-URL, or null to clear it. Capped so a
 *  runaway canvas export can't bloat a row (~200KB is plenty for a signature). */
export class SignatureDto {
  @ValidateIf((_, v) => v !== null)
  @IsOptional()
  @IsString()
  @MaxLength(300_000)
  signaturePng?: string | null;
}
```

- [ ] **Step 2: Write the failing service test**

```ts
// farmers.signature.spec.ts
import { Test } from '@nestjs/testing';
import { FarmersService } from './farmers.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { encryptSignature } from '../../common/crypto/signature-crypto';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function dbMock() {
  const state: { stored?: string | null } = {};
  return {
    state,
    update: () => ({ set: (v: any) => ({ where: () => ({ returning: async () => { state.stored = v.signaturePng; return [{ id: 'f1' }]; } }) }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ signaturePng: state.stored ?? null }] }) }) }),
  };
}

describe('FarmersService signature', () => {
  const OLD = process.env.ENCRYPTION_KEY;
  beforeAll(() => { process.env.ENCRYPTION_KEY = 'test-key'; });
  afterAll(() => { process.env.ENCRYPTION_KEY = OLD; });

  async function make(db: any) {
    const mod = await Test.createTestingModule({
      providers: [FarmersService, { provide: DB_TOKEN, useValue: db },
        // minimal stubs for other injected deps — copy the tokens the real service needs
      ],
    }).compile();
    return mod.get(FarmersService);
  }

  it('stores encrypted and reads back decrypted', async () => {
    const db = dbMock();
    const svc = await make(db);
    await svc.setSignature('f1', 't1', PNG);
    expect(db.state.stored).not.toEqual(PNG);            // encrypted at rest
    const got = await svc.getSignature('f1', 't1');
    expect(got.signaturePng).toEqual(PNG);               // decrypted on read
  });
});
```

> NOTE for implementer: `FarmersService` has other constructor deps (cache, publicCache, storage). If the module can't compile with only `DB_TOKEN`, stub the remaining tokens with `useValue: {}`; the two new methods touch only the DB. Read the existing `farmers.service.ts` constructor for the exact token list.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- farmers.signature`
Expected: FAIL — `setSignature`/`getSignature` are not functions.

- [ ] **Step 4: Add the service methods**

In `farmers.service.ts`, import at top:

```ts
import { encryptSignature, decryptSignature } from '../../common/crypto/signature-crypto';
```

Add methods (near `update`):

```ts
  /** The farmer's saved signature, decrypted, for the operator panel preview. */
  async getSignature(id: string, tenantId: string): Promise<{ signaturePng: string | null }> {
    const [row] = await this.db
      .select({ signaturePng: farmers.signaturePng })
      .from(farmers)
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new NotFoundException('Фермерът не е намерен');
    return { signaturePng: decryptSignature(row.signaturePng) };
  }

  /** Store (encrypted) or clear the farmer's reusable signature. */
  async setSignature(id: string, tenantId: string, png: string | null): Promise<{ signaturePng: string | null }> {
    const enc = png ? encryptSignature(png) : null;
    const [updated] = await this.db
      .update(farmers)
      .set({ signaturePng: enc })
      .where(and(eq(farmers.id, id), eq(farmers.tenantId, tenantId)))
      .returning({ id: farmers.id });
    if (!updated) throw new NotFoundException('Фермерът не е намерен');
    return { signaturePng: png };
  }
```

(Confirm `farmers`, `and`, `eq`, `NotFoundException` are already imported — they are used elsewhere in the file.)

- [ ] **Step 5: Add the controller routes**

In `farmers.controller.ts`, import `SignatureDto` and add routes (mirror the existing `:id` patterns; keep them admin-only like the surrounding update route):

```ts
  @Get(':id/signature')
  getSignature(@CurrentTenant() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.farmers.getSignature(id, tenantId);
  }

  @Put(':id/signature')
  setSignature(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SignatureDto,
  ) {
    return this.farmers.setSignature(id, tenantId, dto.signaturePng ?? null);
  }
```

(Add `Put`, `ParseUUIDPipe` to the `@nestjs/common` import if missing; the service field is likely `this.farmers` — match the existing constructor property name.)

- [ ] **Step 6: Run test + typecheck**

Run: `pnpm --filter @fermeribg/api test -- farmers.signature && pnpm --filter @fermeribg/api build`
Expected: PASS + clean build.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/farmers/dto/signature.dto.ts server/src/modules/farmers/farmers.service.ts server/src/modules/farmers/farmers.controller.ts server/src/modules/farmers/farmers.signature.spec.ts
git commit -m "feat(farmers): GET/PUT :id/signature — encrypted reusable signature"
```

---

## Task 5: Operator signature endpoints

**Files:**
- Modify: `server/src/modules/tenants/tenants.service.ts` (add two methods)
- Modify: `server/src/modules/tenants/tenants.controller.ts` (add two routes)
- Test: `server/src/modules/tenants/tenants.signature.spec.ts`

**Interfaces:**
- Consumes: `encryptSignature`, `decryptSignature`; `tenants.operatorSignaturePng`.
- Produces:
  - `TenantsService.getSignature(tenantId): Promise<{ signaturePng: string | null }>`
  - `TenantsService.setSignature(tenantId, png: string | null): Promise<{ signaturePng: string | null }>`
  - Routes `GET /tenants/me/signature`, `PUT /tenants/me/signature`.

- [ ] **Step 1: Write the failing test**

```ts
// tenants.signature.spec.ts — same shape as farmers.signature.spec.ts
// setSignature stores encrypted; getSignature returns decrypted. Stub non-DB deps
// with useValue: {} as needed (read the tenants.service constructor for tokens).
```

Model it on `farmers.signature.spec.ts` from Task 4: set `ENCRYPTION_KEY`, call `setSignature('t1', PNG)`, assert the stored value differs from `PNG`, then `getSignature('t1')` returns `PNG`. Mock `db.update(...).set(...).where(...)` and `db.select(...).from(...).where(...).limit(...)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- tenants.signature`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Add the service methods**

Import `encryptSignature, decryptSignature` and add near `getLegal`/`updateLegal`:

```ts
  /** Operator's saved signature, decrypted, for the settings preview + auto-sign. */
  async getSignature(tenantId: string): Promise<{ signaturePng: string | null }> {
    const [row] = await this.db
      .select({ signaturePng: tenants.operatorSignaturePng })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return { signaturePng: decryptSignature(row?.operatorSignaturePng ?? row?.signaturePng ?? null) };
  }

  /** Store (encrypted) or clear the operator's reusable signature. */
  async setSignature(tenantId: string, png: string | null): Promise<{ signaturePng: string | null }> {
    await this.db
      .update(tenants)
      .set({ operatorSignaturePng: png ? encryptSignature(png) : null })
      .where(eq(tenants.id, tenantId));
    return { signaturePng: png };
  }
```

> Fix the select alias to `{ signaturePng: tenants.operatorSignaturePng }` and read `row?.signaturePng` — the snippet above shows the intent; use the clean alias so there is no `operatorSignaturePng` on the row type:
```ts
    const [row] = await this.db
      .select({ signaturePng: tenants.operatorSignaturePng })
      .from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return { signaturePng: decryptSignature(row?.signaturePng ?? null) };
```

- [ ] **Step 4: Add the controller routes**

In `tenants.controller.ts`, add (near `getLegal`/`updateLegal`), importing `SignatureDto` from `../farmers/dto/signature.dto` (reuse it) and `Put` if missing:

```ts
  @ApiOperation({ summary: 'Operator signature for handover protocols' })
  @Get('me/signature')
  getSignature(@CurrentTenant() tenantId: string) {
    return this.tenantsService.getSignature(tenantId);
  }

  @ApiOperation({ summary: 'Update operator signature' })
  @Put('me/signature')
  setSignature(@CurrentTenant() tenantId: string, @Body() dto: SignatureDto) {
    return this.tenantsService.setSignature(tenantId, dto.signaturePng ?? null);
  }
```

- [ ] **Step 5: Run test + build**

Run: `pnpm --filter @fermeribg/api test -- tenants.signature && pnpm --filter @fermeribg/api build`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/tenants/tenants.service.ts server/src/modules/tenants/tenants.controller.ts server/src/modules/tenants/tenants.signature.spec.ts
git commit -m "feat(tenants): GET/PUT me/signature — encrypted operator signature"
```

---

## Task 6: Handover — encrypt snapshots, auto-fill saved signatures, party enrichment

**Files:**
- Modify: `server/src/modules/handover/handover.service.ts`
- Test: `server/src/modules/handover/handover.service.spec.ts` (extend)

**Interfaces:**
- Consumes: `encryptSignature`, `decryptSignature`; `FarmersService`/tenant signature columns; `cityFromAddress` (Task 3, used in Task 7).
- Produces (widened party type carried in snapshots):
  - `ProtocolParty = LegalIdentity & { phone?: string; email?: string }`
  - `getById` result signatures come back **decrypted** for PDF render.
  - `listForCheck(tenantId, { date }): Promise<CheckRow[]>` (see Task 8).

- [ ] **Step 1: Write the failing test — createSigned auto-fills saved signatures**

Extend `handover.service.spec.ts` with a case: a `farmer_to_operator` `createSigned` where the DTO omits `fromSignaturePng`/`toSignaturePng`, the farmer row has an (encrypted) `signature_png` and the tenant has an (encrypted) `operator_signature_png`. Assert the inserted row's `fromSignaturePng`/`toSignaturePng` are **non-null and encrypted** (i.e. `looksEncrypted(inserted.fromSignaturePng)` is true), and that decrypting them yields the two saved PNGs. Follow the file's existing mock style (it already mocks `this.db` and captures `.insert(...).values(...)`).

```ts
import { looksEncrypted, decryptSignature } from '../../common/crypto/signature-crypto';
// ...
it('auto-fills saved farmer + operator signatures when the DTO omits them', async () => {
  process.env.ENCRYPTION_KEY = 'k';
  // arrange: farmer row returns { signature_png: encryptSignature(FARMER_PNG,'k') },
  //          tenant row returns { operator_signature_png: encryptSignature(OP_PNG,'k') }
  // act: createSigned(t, { kind: 'farmer_to_operator', farmerId, slotId, items:[...] })
  // assert on the captured insert values:
  expect(looksEncrypted(captured.fromSignaturePng)).toBe(true);
  expect(decryptSignature(captured.fromSignaturePng, 'k')).toBe(FARMER_PNG);
  expect(decryptSignature(captured.toSignaturePng, 'k')).toBe(OP_PNG);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- handover.service`
Expected: FAIL — signatures are null (no auto-fill yet).

- [ ] **Step 3: Implement — load saved signatures + encrypt on write**

3a. Add imports:
```ts
import { encryptSignature, decryptSignature } from '../../common/crypto/signature-crypto';
```

3b. In `buildDraft`'s farmer-leg branch, extend the tenant + farmer selects to also fetch the signature columns and phone/email, and attach them to the identities. Change the tenant select to include `operatorSignaturePng: tenants.operatorSignaturePng` and `contact: sql\`${tenants.settings}->'contact'\``; change the farmer select to include `signaturePng: farmers.signaturePng, phone: farmers.phone, email: farmers.email`. Then:

```ts
    const operatorLegal: ProtocolParty = {
      ...resolveParty(tenantRow?.legal, tenantRow?.name, 'оператор'),
      phone: (tenantRow?.contact as any)?.phone ?? undefined,
      email: (tenantRow?.contact as any)?.email ?? undefined,
    };
    const farmerLegal: ProtocolParty = {
      ...resolveParty(farmerRow?.legal, farmerRow?.name, 'фермер'),
      phone: farmerRow?.phone ?? undefined,
      email: farmerRow?.email ?? undefined,
    };
```

> Read `server/src/modules/tenants/site-contact.ts` for the exact key names under `settings.contact` (likely `phone`/`email`); render only when present. If the shape differs, attach what exists and omit the rest — never invent a field.

3c. Return the saved (decrypted) signatures from `buildDraft` so `createSigned` can reuse them. Add to the farmer-leg return object:
```ts
    savedFromSignature: decryptSignature(farmerRow?.signaturePng),
    savedToSignature: decryptSignature(tenantRow?.operatorSignaturePng),
```
For the customer-leg (`buildCustomerLegDraft`): `savedFromSignature` = operator's decrypted signature, `savedToSignature` = null.

3d. In `createSigned`, after building the draft, resolve the signatures and ENCRYPT before insert:
```ts
    const fromSig = dto.fromSignaturePng ?? draft.savedFromSignature ?? null;
    const toSig = dto.toSignaturePng ?? draft.savedToSignature ?? null;
    // ...in .values({...}):
    fromSignaturePng: fromSig ? encryptSignature(fromSig) : null,
    toSignaturePng: toSig ? encryptSignature(toSig) : null,
```

3e. In `signPaperTarget` and `signAllForDay`: when a saved signature exists for the leg, sign **digitally** — set `signMode: 'digital'`, `fromSignaturePng`/`toSignaturePng` from the draft's saved (encrypted), else keep the existing `paper` path. Concretely, in `signPaperTarget`'s insert branch:
```ts
    const fromSig = draft.savedFromSignature ?? null;
    const toSig = draft.savedToSignature ?? null;
    const digital = !!(fromSig && (target.kind === 'operator_to_customer' || toSig));
    // values:
    signMode: digital ? 'digital' : 'paper',
    fromSignaturePng: fromSig ? encryptSignature(fromSig) : null,
    toSignaturePng: toSig ? encryptSignature(toSig) : null,
```
(For the existing-row flip branch, keep marking paper — a pre-existing draft was already numbered without sigs.)

- [ ] **Step 4: Decrypt signatures on read for PDF**

In `getById`, after fetching the row, return it with decrypted signatures so `renderProtocolPdf` embeds the real PNG:
```ts
    return { ...row, fromSignaturePng: decryptSignature(row.fromSignaturePng), toSignaturePng: decryptSignature(row.toSignaturePng) };
```
Add the `ProtocolParty` type near the top of the file:
```ts
export type ProtocolParty = LegalIdentity & { phone?: string; email?: string };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @fermeribg/api test -- handover.service`
Expected: PASS (existing cases still green + the new auto-fill case).

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/handover.service.ts server/src/modules/handover/handover.service.spec.ts
git commit -m "feat(handover): auto-fill + encrypt saved signatures; decrypt on render"
```

---

## Task 7: PDF — bilateral .doc layout

**Files:**
- Modify: `server/src/modules/handover/handover-pdf.ts`
- Test: `server/src/modules/handover/handover-pdf.spec.ts` (rewrite `composeProtocol` assertions)

**Interfaces:**
- Consumes: `cityFromAddress` (Task 3); `ProtocolParty` (Task 6); decrypted signatures on the row.
- Produces: `composeProtocol(row): ProtocolText` (new shape below); `renderProtocolPdf(row): Promise<Buffer>` unchanged signature.

New `ProtocolText`:
```ts
export interface PartyText {
  role: string;                 // 'ПРЕДАВА:' | 'ПРИЕМА:'
  name: string;
  idLine: string | null;        // 'ЕИК 203912345' | 'рег.№ …' | null
  address: string | null;
  phone: string | null;
  email: string | null;
}
export interface ProtocolText {
  title: string;
  number: string | null;
  opening: string;              // 'Днес, 20.07.2026 г., в гр. Варна, между:'
  from: PartyText;
  to: PartyText;
  intro: string;                // 'се състави настоящият приемо-предавателен протокол за долуописаните стоки:'
  itemLines: string[];
  footer: string;
  fromName: string;
  toName: string;
}
```

- [ ] **Step 1: Rewrite the `composeProtocol` test**

```ts
// handover-pdf.spec.ts (compose section)
import { composeProtocol } from './handover-pdf';

const base = {
  kind: 'farmer_to_operator',
  protocolNumber: 7,
  signedAt: new Date('2026-07-20T09:00:00Z'),
  fromSnapshot: { name: 'ЕТ Димка Четова', eik: '203912345', address: 'гр. Варна, ул. Приморска 12', phone: '0888123456', email: 'dimka@example.bg' },
  toSnapshot: { name: 'ФермериБГ ЕООД', eik: '206000111', address: 'гр. Варна, бул. Сливница 1', phone: '0700', email: 'ops@fermeri.bg' },
  items: [{ productName: 'Домати', quantity: 5, unit: 'кг' }],
  meta: { orderNumbers: [101, 102] },
};

describe('composeProtocol (bilateral)', () => {
  it('builds the two-party structure with our data', () => {
    const t = composeProtocol(base);
    expect(t.title).toBe('ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ');
    expect(t.number).toBe('№ 7');
    expect(t.opening).toContain('Днес, 20.07.2026 г.');
    expect(t.opening).toContain('в гр. Варна');
    expect(t.from.role).toBe('ПРЕДАВА:');
    expect(t.from.name).toBe('ЕТ Димка Четова');
    expect(t.from.idLine).toBe('ЕИК 203912345');
    expect(t.from.phone).toBe('0888123456');
    expect(t.to.role).toBe('ПРИЕМА:');
    expect(t.intro).toContain('се състави настоящият приемо-предавателен протокол');
    expect(t.itemLines[0]).toBe('1. Домати — 5 кг');
    expect(t.footer).toContain('два еднообразни екземпляра');
  });

  it('customer leg → разписка, no ЕИК on the customer', () => {
    const t = composeProtocol({ ...base, kind: 'operator_to_customer', toSnapshot: { name: 'Иван Петров', phone: '0899', address: 'гр. Варна' } });
    expect(t.title).toBe('РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА');
    expect(t.to.idLine).toBeNull();
  });

  it('drops the „в гр." clause when the operator address has no settlement', () => {
    const t = composeProtocol({ ...base, fromSnapshot: { ...base.fromSnapshot }, toSnapshot: { ...base.toSnapshot, address: 'ул. без град' } });
    expect(t.opening).not.toContain('в гр.');
  });
});
```

> The opening line's city comes from the **operator** party (the `to` on a farmer leg, the `from` on a customer leg). Compute it from whichever snapshot is the operator.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- handover-pdf`
Expected: FAIL — new fields (`opening`, `from`, `to`, `intro`) absent.

- [ ] **Step 3: Rewrite `composeProtocol`**

```ts
import { cityFromAddress } from './handover-city';

/** ЕИК / рег.№ line for a party (skipped for a customer / no id). */
function idLineOf(p: any, withId: boolean): string | null {
  if (!withId) return null;
  if (p?.eik) return `ЕИК ${p.eik}`;
  if (p?.regNo) return `рег.№ ${p.regNo}`;
  return null;
}

function partyText(p: any, role: string, withId: boolean): PartyText {
  return {
    role,
    name: String(p?.name ?? '—'),
    idLine: idLineOf(p, withId),
    address: p?.address ? String(p.address) : null,
    phone: p?.phone ? String(p.phone) : null,
    email: p?.email ? String(p.email) : null,
  };
}

export function composeProtocol(row: any): ProtocolText {
  const isCustomer = row.kind === 'operator_to_customer';
  const when = dateBg(new Date(row.signedAt ?? row.createdAt ?? Date.now()));

  // Operator is the receiver on a farmer leg, the sender on a customer leg.
  const operatorSnap = isCustomer ? row.fromSnapshot : row.toSnapshot;
  const city = cityFromAddress(operatorSnap?.address);
  const cityClause = city ? `, в ${city.prefix} ${city.name}` : '';

  const from = partyText(row.fromSnapshot, 'ПРЕДАВА:', true);
  const to = partyText(row.toSnapshot, 'ПРИЕМА:', !isCustomer);

  const items: any[] = row.items ?? [];
  const itemLines = items.map((it, i) => {
    const variant = it.variantLabel ? ` · ${it.variantLabel}` : '';
    const qty = `${it.quantity}${it.unit ? ` ${it.unit}` : ''}`;
    return `${i + 1}. ${it.productName}${variant} — ${qty}`;
  });

  const docNoun = isCustomer ? 'настоящата разписка за получена стока' : 'настоящият приемо-предавателен протокол';

  return {
    title: isCustomer ? 'РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА' : 'ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ',
    number: row.protocolNumber != null ? `№ ${row.protocolNumber}` : null,
    opening: `Днес, ${when}${cityClause}, между:`,
    from,
    to,
    intro: `се състави ${docNoun} за долуописаните стоки:`,
    itemLines,
    footer: `${isCustomer ? 'Настоящата разписка' : 'Настоящият протокол'} се състави в два еднообразни екземпляра — по един за всяка страна.`,
    fromName: from.name,
    toName: to.name,
  };
}
```

- [ ] **Step 4: Rewrite `renderProtocolPdf` drawing**

Replace the drawing body so it lays out, in order: centered underlined title; centered `№`; the `opening` line; a party block for `t.from` then a centered „и" then a party block for `t.to`; the `intro` line; numbered `itemLines` + 2 dotted continuation lines; the `footer`; the two signature blocks (`ПРЕДАЛ`/`ПРИЕЛ`) with embedded PNG (from the already-decrypted `row.fromSignaturePng`/`toSignaturePng`). Add a helper:

```ts
function drawParty(page: PDFPage, font: PDFFont, x: number, startY: number, p: PartyText): number {
  let y = startY;
  const line = (text: string, size = BODY_SIZE, bold = false) => {
    page.drawText(text, { x, y, size, font, color: INK });
    if (bold) page.drawText(text, { x: x + 0.4, y, size, font, color: INK });
    y -= BODY_LH;
  };
  line(p.role, BODY_SIZE, true);
  line(p.name, BODY_SIZE, true);
  if (p.idLine) line(p.idLine);
  if (p.address) for (const l of wrap(`адрес: ${p.address}`, font, BODY_SIZE, CONTENT_W)) { page.drawText(l, { x, y, size: BODY_SIZE, font, color: INK }); y -= BODY_LH; }
  const contact = [p.phone && `тел.: ${p.phone}`, p.email && `e-mail: ${p.email}`].filter(Boolean).join('   ');
  if (contact) line(contact);
  return y;
}
```

Keep the existing `sigBlock`, `wrap`, `dateBg`, `drawCentered` helpers. Drive layout off a single mutable `y` cursor as the current code does; after the `t.from` block, draw a centered „и" (use `drawCentered('и', 12)`), then the `t.to` block. Ensure page overflow is tolerable for a typical (≤ ~12 item) protocol — no pagination needed.

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @fermeribg/api test -- handover-pdf`
Expected: PASS. (The compose tests assert the text model; the render path is exercised for no-throw — keep/extend the existing "renders a buffer" test.)

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/handover-pdf.ts server/src/modules/handover/handover-pdf.spec.ts
git commit -m "feat(handover): bilateral .doc-style protocol PDF layout"
```

---

## Task 8: Check endpoint (day's signed protocols, decrypted)

**Files:**
- Modify: `server/src/modules/handover/handover.service.ts` (add `listForCheck`)
- Modify: `server/src/modules/handover/handover.controller.ts` (add `GET check`)
- Test: `server/src/modules/handover/handover.service.spec.ts` (extend)

**Interfaces:**
- Produces:
  - `HandoverService.listForCheck(tenantId, { date, slotId }): Promise<CheckRow[]>` where
    ```ts
    interface CheckRow {
      id: string; protocolNumber: number | null; kind: string; status: string;
      signedAt: Date | null;
      fromSnapshot: ProtocolParty; toSnapshot: ProtocolParty;
      items: { productName: string; variantLabel?: string; quantity: number; unit?: string }[];
      fromSignaturePng: string | null; toSignaturePng: string | null; // DECRYPTED
    }
    ```
  - Route `GET /handover/check?date=&slotId=` → `CheckRow[]`.

- [ ] **Step 1: Write the failing test**

Add a case: `listForCheck` returns only `status === 'signed'` rows for the date, with `fromSignaturePng`/`toSignaturePng` **decrypted** (assert a value stored encrypted comes back as the plain PNG, and a draft row is excluded). Reuse the file's `list` mock plumbing.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- handover.service`
Expected: FAIL — `listForCheck` undefined.

- [ ] **Step 3: Implement `listForCheck`**

```ts
  /** The day's SIGNED protocols for the fullscreen „Проверка" view — signatures
   *  decrypted for display. Reuses `list` (which leftJoins deliverySlots for date). */
  async listForCheck(tenantId: string, q: { date?: string; slotId?: string }) {
    const rows = (await this.list(tenantId, { slotId: q.slotId, date: q.date })) as any[];
    return rows
      .filter((r) => r.status === 'signed')
      .sort((a, b) => (a.protocolNumber ?? 0) - (b.protocolNumber ?? 0))
      .map((r) => ({
        id: r.id,
        protocolNumber: r.protocolNumber,
        kind: r.kind,
        status: r.status,
        signedAt: r.signedAt ?? null,
        fromSnapshot: r.fromSnapshot,
        toSnapshot: r.toSnapshot,
        items: r.items ?? [],
        fromSignaturePng: decryptSignature(r.fromSignaturePng),
        toSignaturePng: decryptSignature(r.toSignaturePng),
      }));
  }
```

- [ ] **Step 4: Add the controller route**

```ts
  /** Day's signed protocols with decrypted signatures for the offline check view. */
  @Get('check')
  check(
    @CurrentTenant() tenantId: string,
    @Query('date') date?: string,
    @Query('slotId') slotId?: string,
  ) {
    return this.handover.listForCheck(tenantId, { date, slotId });
  }
```

> Route ordering: `@Get('check')` must be declared BEFORE `@Get(':id/pdf')`? No — `check` is a distinct static segment and `:id/pdf` has a second segment, so there is no collision. Place it near the other `@Get` handlers.

- [ ] **Step 5: Run tests + build**

Run: `pnpm --filter @fermeribg/api test -- handover.service && pnpm --filter @fermeribg/api build`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/handover/handover.service.ts server/src/modules/handover/handover.controller.ts server/src/modules/handover/handover.service.spec.ts
git commit -m "feat(handover): GET /handover/check — day's signed protocols, decrypted"
```

---

## Task 9: `SignaturePadField` component (mobile-first, preview, saved state)

**Files:**
- Create: `client/src/components/handover/signature-pad-field.tsx`
- Create: `client/src/components/handover/signature-export.ts` (pure helper)
- Test: `client/src/components/handover/signature-export.test.ts`

**Interfaces:**
- Produces:
  - `signatureIsBlank(dataUrl: string): boolean` (pure — for the test + guard)
  - `<SignaturePadField value={string|null} onChange={(png:string|null)=>void} label?:string />`

- [ ] **Step 1: Write the failing pure-logic test**

```ts
// signature-export.test.ts (vitest, Node-only — NO DOM)
import { describe, it, expect } from 'vitest';
import { signatureIsBlank } from './signature-export';

describe('signatureIsBlank', () => {
  it('treats a non-data-url as blank', () => {
    expect(signatureIsBlank('')).toBe(true);
    expect(signatureIsBlank('nope')).toBe(true);
  });
  it('treats a tiny/short data-url as blank', () => {
    expect(signatureIsBlank('data:image/png;base64,AAAA')).toBe(true);
  });
  it('treats a substantial data-url as non-blank', () => {
    expect(signatureIsBlank('data:image/png;base64,' + 'A'.repeat(3000))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/web test -- signature-export`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the pure helper**

```ts
// signature-export.ts
/** Heuristic: a cleared/near-empty canvas exports to a very short PNG data-URL.
 *  Anything below this base64 length is treated as "no signature". */
const MIN_SIGNATURE_LEN = 1500;
export function signatureIsBlank(dataUrl: string | null | undefined): boolean {
  if (!dataUrl || !dataUrl.startsWith('data:image/png')) return true;
  const comma = dataUrl.indexOf(',');
  return comma < 0 || dataUrl.length - comma - 1 < MIN_SIGNATURE_LEN;
}
```

- [ ] **Step 4: Write the component**

```tsx
// signature-pad-field.tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import { Eraser, Check } from 'lucide-react';
import { signatureIsBlank } from './signature-export';

/**
 * Mobile-first signature capture. High-DPI canvas (crisp on phones), preview of
 * the captured signature, and a saved-image state with „Промени"/„Изтрий".
 * Emits a PNG data-URL (or null when cleared). Parent persists it.
 */
export function SignaturePadField({
  value,
  onChange,
  label = 'Подпис',
}: {
  value: string | null;
  onChange: (png: string | null) => void;
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [editing, setEditing] = useState(!value);
  const [dirty, setDirty] = useState(false);

  // Size the backing store to CSS px × devicePixelRatio so strokes stay sharp.
  useEffect(() => {
    if (!editing) return;
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rect = c.getBoundingClientRect();
    c.width = Math.round(rect.width * dpr);
    c.height = Math.round(rect.height * dpr);
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1c1a17';
  }, [editing]);

  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: React.PointerEvent) => {
    drawing.current = true;
    const ctx = ref.current!.getContext('2d')!;
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = ref.current!.getContext('2d')!;
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!dirty) setDirty(true);
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const png = ref.current!.toDataURL('image/png');
    onChange(signatureIsBlank(png) ? null : png);
  };
  const clear = () => {
    const c = ref.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    setDirty(false);
    onChange(null);
  };

  // Saved, not editing → show the stored signature with actions.
  if (!editing && value) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-bold text-ff-ink-2">{label}</span>
        <div className="rounded-lg border border-ff-border bg-white p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value} alt={label} className="mx-auto h-24 w-auto object-contain" />
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setEditing(true)} className="text-[13px] font-bold text-ff-green-700 underline">Промени</button>
          <button type="button" onClick={() => { onChange(null); setEditing(true); }} className="text-[13px] font-bold text-ff-danger underline">Изтрий</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-bold text-ff-ink-2">{label}</span>
        {dirty && (
          <button type="button" onClick={clear} className="inline-flex items-center gap-1 text-[13px] font-bold text-ff-green-700">
            <Eraser size={14} /> Изчисти
          </button>
        )}
      </div>
      <canvas
        ref={ref}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
        className="h-40 w-full touch-none rounded-lg border-2 border-dashed border-ff-border bg-white"
      />
      <p className="text-[11.5px] text-ff-muted">Подпишете се в полето с пръст или писалка.</p>
      {value && (
        <div className="mt-1">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-ff-muted">Преглед</div>
          <div className="rounded-lg border border-ff-border bg-white p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={value} alt="преглед" className="mx-auto h-16 w-auto object-contain" />
          </div>
        </div>
      )}
      {value && (
        <button type="button" onClick={() => setEditing(false)} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-ff-green-700 px-3 py-2 text-[13.5px] font-bold text-white">
          <Check size={15} /> Готово
        </button>
      )}
    </div>
  );
}
```

> `ff-danger` colour token: if it doesn't exist in this codebase, use `text-red-600`. Confirm against an existing component before committing.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/web test -- signature-export`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/handover/signature-pad-field.tsx client/src/components/handover/signature-export.ts client/src/components/handover/signature-export.test.ts
git commit -m "feat(web): mobile-first SignaturePadField with preview + saved state"
```

---

## Task 10: Signature sections in farmer profile + operator settings

**Files:**
- Modify: `client/src/lib/api-client.ts` (4 functions)
- Modify: `client/src/components/farmers/farmer-panel.tsx` (add „Подпис на фермера" section)
- Modify: `client/src/components/settings/legal-card.tsx` (add „Подпис на оператора" section)

**Interfaces:**
- Consumes: `SignaturePadField` (Task 9); endpoints from Tasks 4–5.
- Produces (api-client):
  - `getFarmerSignature(id): Promise<{ signaturePng: string | null }>`
  - `updateFarmerSignature(id, signaturePng: string | null): Promise<{ signaturePng: string | null }>`
  - `getOperatorSignature(): Promise<{ signaturePng: string | null }>`
  - `updateOperatorSignature(signaturePng: string | null): Promise<{ signaturePng: string | null }>`

- [ ] **Step 1: Add the api-client functions**

Near `getTenantLegal`/`updateTenantLegal` (~line 543) and the farmer helpers:

```ts
export const getFarmerSignature = (id: string) =>
  apiFetch<{ signaturePng: string | null }>(`farmers/${id}/signature`);
export const updateFarmerSignature = (id: string, signaturePng: string | null) =>
  apiFetch<{ signaturePng: string | null }>(`farmers/${id}/signature`, { method: 'PUT', ...json({ signaturePng }) }, 'Подписът не беше записан');

export const getOperatorSignature = () =>
  apiFetch<{ signaturePng: string | null }>('tenants/me/signature');
export const updateOperatorSignature = (signaturePng: string | null) =>
  apiFetch<{ signaturePng: string | null }>('tenants/me/signature', { method: 'PUT', ...json({ signaturePng }) }, 'Подписът не беше записан');
```

(Use the file's existing `json(...)` helper and `apiFetch` signature — match how `updateTenantLegal` is written.)

- [ ] **Step 2: Farmer panel — signature section**

In `farmer-panel.tsx`, add a section (only meaningful once the farmer exists — i.e. `!isNew`). It lazy-loads the saved signature on mount and saves on change via a dedicated call (NOT the main farmer save, which doesn't touch the signature column):

```tsx
// imports
import { SignaturePadField } from '@/components/handover/signature-pad-field';
import { getFarmerSignature, updateFarmerSignature } from '@/lib/api-client';
// ...inside the component, after existing hooks:
const [sig, setSig] = useState<string | null>(null);
const [sigLoaded, setSigLoaded] = useState(false);
useEffect(() => {
  if (isNew || !farmer.id) { setSigLoaded(true); return; }
  getFarmerSignature(farmer.id).then((r) => setSig(r.signaturePng)).catch(() => {}).finally(() => setSigLoaded(true));
}, [isNew, farmer.id]);

async function saveSig(png: string | null) {
  setSig(png);
  if (!farmer.id) return;
  try { await updateFarmerSignature(farmer.id, png); toast.success('Подписът е запазен'); }
  catch { toast.error('Подписът не беше записан'); }
}
```

Render (place near the legal-data block; visible whenever the farmer is saved):

```tsx
{!isNew && sigLoaded && (
  <div className="rounded-xl border border-ff-border-2 bg-ff-surface-2 p-3.5">
    <div className="flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wide text-ff-muted">
      <FileText size={14} /> Подпис за протоколи
    </div>
    <p className="mt-1.5 text-[12px] leading-snug text-ff-muted">
      Подпишете се веднъж — при предаване на продукция протоколът се подписва автоматично.
    </p>
    <div className="mt-3">
      <SignaturePadField value={sig} onChange={saveSig} label="Подпис на фермера" />
    </div>
  </div>
)}
```

- [ ] **Step 3: Operator settings — signature section**

In `legal-card.tsx`, add below the legal fields a signature block using `getOperatorSignature`/`updateOperatorSignature`, mirroring Task-10 Step-2 (no `farmer.id` — the operator is the current tenant). Load on mount, save on change with a toast.

- [ ] **Step 4: Verify live (deferred to Task 14 verify pass)**

No unit test (DOM component). Typecheck now:
Run: `pnpm --filter @fermeribg/web build`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/api-client.ts client/src/components/farmers/farmer-panel.tsx client/src/components/settings/legal-card.tsx
git commit -m "feat(web): save farmer + operator signatures in profile/settings"
```

---

## Task 11: Offline protocol cache (IndexedDB)

**Files:**
- Create: `client/src/lib/protocol-cache.ts`
- Test: `client/src/lib/protocol-cache.test.ts`

**Interfaces:**
- Produces:
  - `type CheckProtocol` (client mirror of `CheckRow`)
  - `saveCheckCache(date: string, rows: CheckProtocol[], now: number): Promise<void>`
  - `readCheckCache(date: string): Promise<{ rows: CheckProtocol[]; cachedAt: number } | null>`
  - Internally uses IndexedDB; both functions swallow errors (return null / resolve) so the view never crashes when storage is unavailable.

- [ ] **Step 1: Write the failing test (in-memory idb shim)**

```ts
// protocol-cache.test.ts (vitest, Node-only)
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Minimal fake-indexeddb: install BEFORE importing the module under test.
import 'fake-indexeddb/auto'; // dev-dependency; see step 3 note
import { saveCheckCache, readCheckCache } from './protocol-cache';

const rows = [{ id: 'p1', protocolNumber: 1, kind: 'farmer_to_operator', status: 'signed', signedAt: null, fromSnapshot: { name: 'A' }, toSnapshot: { name: 'B' }, items: [], fromSignaturePng: null, toSignaturePng: null }];

describe('protocol-cache', () => {
  it('round-trips a day payload', async () => {
    await saveCheckCache('2026-07-20', rows as any, 1000);
    const got = await readCheckCache('2026-07-20');
    expect(got?.cachedAt).toBe(1000);
    expect(got?.rows[0].id).toBe('p1');
  });
  it('returns null for an uncached date', async () => {
    expect(await readCheckCache('1999-01-01')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/web test -- protocol-cache`
Expected: FAIL — module not found. (If `fake-indexeddb` isn't installed, `pnpm --filter @fermeribg/web add -D fake-indexeddb` first.)

- [ ] **Step 3: Write the cache module**

```ts
// protocol-cache.ts
export interface CheckProtocol {
  id: string;
  protocolNumber: number | null;
  kind: string;
  status: string;
  signedAt: string | null;
  fromSnapshot: { name?: string; eik?: string; regNo?: string; address?: string; phone?: string; email?: string };
  toSnapshot: { name?: string; eik?: string; regNo?: string; address?: string; phone?: string; email?: string };
  items: { productName: string; variantLabel?: string; quantity: number; unit?: string }[];
  fromSignaturePng: string | null;
  toSignaturePng: string | null;
}

const DB_NAME = 'ff-protocols';
const STORE = 'check';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Persist the day's check payload. Never throws — offline caching is best-effort. */
export async function saveCheckCache(date: string, rows: CheckProtocol[], now: number): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ rows, cachedAt: now }, date);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* storage unavailable / quota / private mode — ignore */
  }
}

/** Read the cached day payload, or null if absent/unavailable. */
export async function readCheckCache(date: string): Promise<{ rows: CheckProtocol[]; cachedAt: number } | null> {
  try {
    const db = await open();
    const val = await new Promise<any>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(date);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return val ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/web test -- protocol-cache`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/protocol-cache.ts client/src/lib/protocol-cache.test.ts package.json pnpm-lock.yaml
git commit -m "feat(web): IndexedDB cache for offline protocol check view"
```

---

## Task 12: „Проверка" fullscreen view

**Files:**
- Create: `client/src/app/(admin)/protocols/check/page.tsx`
- Create: `client/src/components/handover/protocol-check-client.tsx`
- Modify: `client/src/lib/api-client.ts` (add `getCheckProtocols`)

**Interfaces:**
- Consumes: `getCheckProtocols(date)` → `CheckProtocol[]`; `saveCheckCache`/`readCheckCache` (Task 11).
- Produces: route `/protocols/check` rendering the day's signed protocols, cache-first with an offline banner.

- [ ] **Step 1: Add the api-client function**

```ts
import type { CheckProtocol } from './protocol-cache';
export const getCheckProtocols = (date: string) =>
  apiFetch<CheckProtocol[]>(`handover/check?date=${encodeURIComponent(date)}`);
```

- [ ] **Step 2: Page shell**

```tsx
// app/(admin)/protocols/check/page.tsx
import { ProtocolCheckClient } from '@/components/handover/protocol-check-client';
export const dynamic = 'force-dynamic';
export default function ProtocolCheckPage() {
  return <ProtocolCheckClient />;
}
```

- [ ] **Step 3: The client view**

```tsx
// protocol-check-client.tsx
'use client';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, WifiOff } from 'lucide-react';
import { todayIso } from '@/lib/utils';
import { getCheckProtocols } from '@/lib/api-client';
import { readCheckCache, saveCheckCache, type CheckProtocol } from '@/lib/protocol-cache';

const idLine = (p: CheckProtocol['fromSnapshot']) =>
  p?.eik ? `ЕИК ${p.eik}` : p?.regNo ? `рег.№ ${p.regNo}` : null;

/**
 * Fullscreen „Проверка" — the day's SIGNED handover protocols shown large for a
 * roadside police check. Loads from the network, caches to IndexedDB, and falls
 * back to the cache when offline so it still renders with no signal.
 */
export function ProtocolCheckClient() {
  const [date] = useState(() => todayIso());
  const [rows, setRows] = useState<CheckProtocol[]>([]);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const fresh = await getCheckProtocols(date);
      setRows(fresh);
      setOffline(false);
      setCachedAt(Date.now());
      await saveCheckCache(date, fresh, Date.now());
    } catch {
      const cached = await readCheckCache(date);
      if (cached) {
        setRows(cached.rows);
        setCachedAt(cached.cachedAt);
        setOffline(true);
      }
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="min-h-screen bg-ff-surface">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-ff-border bg-ff-surface/95 px-4 py-3 backdrop-blur">
        <a href="/protocols" className="inline-flex items-center gap-1.5 text-[14px] font-bold text-ff-ink"><ArrowLeft size={18} /> Назад</a>
        <span className="text-[15px] font-extrabold">Проверка · {rows.length}</span>
        <span className="w-16" />
      </div>

      {offline && (
        <div className="flex items-center gap-2 bg-amber-50 px-4 py-2 text-[12.5px] font-bold text-amber-800">
          <WifiOff size={15} /> Офлайн — показани са кешираните протоколи{cachedAt ? ` (${new Date(cachedAt).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' })})` : ''}
        </div>
      )}

      {loading && rows.length === 0 && <p className="px-5 py-16 text-center text-sm text-ff-muted">Зареждане…</p>}
      {!loading && rows.length === 0 && <p className="px-5 py-16 text-center text-sm text-ff-muted">Няма подписани протоколи за днес.</p>}

      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
        {rows.map((r) => (
          <article key={r.id} className="overflow-hidden rounded-2xl border border-ff-border bg-white shadow-ff-sm">
            <div className="flex items-center justify-between border-b border-ff-border-2 bg-ff-surface-2 px-4 py-3">
              <span className="text-[15px] font-extrabold">{r.kind === 'operator_to_customer' ? 'Разписка' : 'Протокол'} № {r.protocolNumber ?? '—'}</span>
              <span className="rounded-full bg-ff-green-50 px-2.5 py-0.5 text-[12px] font-bold text-ff-green-700">Подписан ✓</span>
            </div>
            <div className="grid grid-cols-2 gap-3 px-4 py-3">
              {[r.fromSnapshot, r.toSnapshot].map((p, i) => (
                <div key={i}>
                  <div className="text-[11px] font-bold uppercase tracking-wide text-ff-muted">{i === 0 ? 'Предава' : 'Приема'}</div>
                  <div className="text-[14px] font-bold text-ff-ink">{p?.name ?? '—'}</div>
                  {idLine(p) && <div className="text-[12px] text-ff-muted">{idLine(p)}</div>}
                  {p?.address && <div className="text-[12px] text-ff-muted">{p.address}</div>}
                </div>
              ))}
            </div>
            <ul className="border-t border-ff-border-2 px-4 py-3 text-[13.5px]">
              {r.items.map((it, i) => (
                <li key={i} className="flex justify-between py-0.5">
                  <span className="font-semibold">{it.productName}{it.variantLabel ? ` · ${it.variantLabel}` : ''}</span>
                  <span className="ff-fig font-bold">{it.quantity}{it.unit ? ` ${it.unit}` : ''}</span>
                </li>
              ))}
            </ul>
            {(r.fromSignaturePng || r.toSignaturePng) && (
              <div className="grid grid-cols-2 gap-3 border-t border-ff-border-2 px-4 py-3">
                {[r.fromSignaturePng, r.toSignaturePng].map((s, i) => (
                  <div key={i} className="text-center">
                    <div className="text-[11px] font-bold uppercase tracking-wide text-ff-muted">{i === 0 ? 'Предал' : 'Приел'}</div>
                    {s
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={s} alt="" className="mx-auto h-14 w-auto object-contain" />
                      : <div className="h-14" />}
                  </div>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @fermeribg/web build`
Expected: clean build. (Live behaviour verified in Task 14.)

- [ ] **Step 5: Commit**

```bash
git add client/src/app/(admin)/protocols/check/page.tsx client/src/components/handover/protocol-check-client.tsx client/src/lib/api-client.ts
git commit -m "feat(web): fullscreen offline Проверка view for signed protocols"
```

---

## Task 13: Protocols screen — „Проверка" entry + one-tap sign

**Files:**
- Modify: `client/src/components/handover/protocols-client.tsx`
- Modify: `client/src/components/handover/protocol-dialog.tsx`

**Interfaces:**
- Consumes: `getFarmerSignature`, `getOperatorSignature`, `createProtocol`, `SignaturePadField`.
- Produces: a „Проверка" button linking to `/protocols/check`; a farmer-leg one-tap sign path that posts with no drawn signature (server auto-fills the saved ones).

- [ ] **Step 1: Add the „Проверка" button**

In `protocols-client.tsx` toolbar (the `flex flex-wrap gap-2` action group), add as the FIRST action (most reachable — this is the roadside button), importing `ShieldCheck` from `lucide-react` and using a plain link so it works even if JS state is mid-load:

```tsx
<a
  href="/protocols/check"
  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-ff-ink px-3.5 py-2 text-[13.5px] font-bold text-white max-[680px]:w-full"
>
  <ShieldCheck size={16} /> Проверка
</a>
```

- [ ] **Step 2: One-tap sign for farmer legs**

Replace the „Подпиши дигитално" button's behaviour so that, when the farmer + operator both have saved signatures, it signs in one call without opening the draw dialog. Add a helper in `protocols-client.tsx`:

```tsx
import { createProtocol, getFarmerSignature, getOperatorSignature } from '@/lib/api-client';
// ...
async function quickSign(row: DayProtocolRow) {
  if (!row.farmerId || !row.slotId) return;
  setMarkingId(rowKey(row));
  try {
    const [f, o] = await Promise.all([getFarmerSignature(row.farmerId), getOperatorSignature()]);
    if (!f.signaturePng || !o.signaturePng) {
      // No saved signatures → fall back to the draw dialog.
      setSignTarget({ farmerId: row.farmerId, slotId: row.slotId });
      return;
    }
    const draft = await getProtocolDraft({ kind: 'farmer_to_operator', farmerId: row.farmerId, slotId: row.slotId });
    const res = await createProtocol({
      kind: 'farmer_to_operator', farmerId: row.farmerId, slotId: row.slotId,
      items: draft.items, meta: {},
      // omit signatures → server auto-fills the saved (encrypted) ones
    });
    toast.success(`Протокол № ${res.protocolNumber} подписан`);
    await load(date);
  } catch (e) {
    toast.error(errMsg(e));
  } finally {
    setMarkingId(null);
  }
}
```

Wire the existing „Подпиши дигитално" button (both desktop + mobile) to `() => void quickSign(row)` instead of `setSignTarget(...)`. Import `getProtocolDraft` (already exported). Keep the „Хартия" button as-is.

- [ ] **Step 3: `ProtocolDialog` uses `SignaturePadField`**

In `protocol-dialog.tsx`, swap the two `<SignaturePad .../>` usages for `<SignaturePadField value={fromSignaturePng} onChange={setFromSignaturePng} label="Предал" />` and the „Приел" one, so the fallback/customer flow gets the improved mobile capture + preview. Remove the now-unused `SignaturePad` import.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @fermeribg/web build`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/handover/protocols-client.tsx client/src/components/handover/protocol-dialog.tsx
git commit -m "feat(web): Проверка entry + one-tap farmer-leg signing"
```

---

## Task 14: Live verify + impeccable pass

**Files:** (fixes as found)
- Any of the above.

- [ ] **Step 1: Run the full server + client suites**

Run: `pnpm --filter @fermeribg/api test && pnpm --filter @fermeribg/web test`
Expected: all green. Fix regressions before proceeding.

- [ ] **Step 2: Live-verify in the Browser pane (375px)**

Start the dev server (`.claude/launch.json` `api-dev` + `web-dev`), then in the Browser pane at 375px:
1. Open a farmer profile → draw a signature → see the preview → „Готово"/save → reload → the saved signature shows with „Промени"/„Изтрий".
2. Settings → save the operator signature the same way.
3. Protocols screen → a farmer pickup → „Подпиши дигитално" → confirm it signs in ONE tap (toast „Протокол № N подписан"), status flips to „Подписан".
4. Open that protocol's PDF → confirm the bilateral layout (title, „Днес … в гр. …, между:", two party blocks + „и", numbered goods, ПРЕДАЛ/ПРИЕЛ with the two signatures embedded).
5. „Проверка" → the signed protocol renders large. Then throttle to Offline (DevTools) + reload → the amber „Офлайн" banner shows and the protocol still renders from cache.

Capture a screenshot of the „Проверка" view and the new PDF as proof.

- [ ] **Step 3: impeccable pass**

Invoke `impeccable:critique` (then `impeccable:audit` if warranted) on: `signature-pad-field.tsx`, `protocol-check-client.tsx`, and the farmer/operator signature sections. Focus: 375px layout, canvas a11y (label, focus ring, hit area ≥ 44px), colour contrast on the amber offline banner and „Подписан ✓" pill, and the „Проверка" button prominence. Implement P0–P2 findings; commit as `polish(web): impeccable fixes for signature + check UI`.

- [ ] **Step 4: Final commit / branch wrap**

```bash
git add -A && git commit -m "test+polish(handover): full-suite green + live-verified" || true
```

Then use `superpowers:finishing-a-development-branch` to choose merge/PR.

---

## Self-Review (spec coverage)

- **Spec A (encrypted columns + maybeDecrypt + no public leak):** Tasks 1, 2, 6, 8. ✅
- **Spec B (SignaturePadField mobile + preview + saved state; placement):** Tasks 9, 10. ✅
- **Spec C (.doc layout):** Task 7. ✅
- **Spec D (one-tap signing, auto-fill):** Tasks 6, 13. ✅
- **Spec E (Проверка view + offline cache):** Tasks 11, 12, 13 (entry). ✅
- **Spec F (impeccable):** Task 14. ✅
- **Testing (crypto round-trip, auto-fill, compose, migration, cache):** Tasks 1, 2, 6, 7, 8, 11 + full suite in 14. ✅

**Type consistency:** `signaturePng` (column `signature_png`) / `operatorSignaturePng` (`operator_signature_png`) used consistently; `CheckRow` (server) mirrors `CheckProtocol` (client `protocol-cache.ts`); `ProtocolParty` extends `LegalIdentity` with `phone`/`email`; `SignaturePadField` prop `{ value, onChange, label }` consistent across Tasks 9/10/13.

**Known implementer read-points (not placeholders — behaviour is defined, exact keys to confirm in-repo):** `tenants.settings.contact` key names (`site-contact.ts`); `FarmersService`/`TenantsService` constructor token lists for spec stubs; `ff-danger` colour token existence.
