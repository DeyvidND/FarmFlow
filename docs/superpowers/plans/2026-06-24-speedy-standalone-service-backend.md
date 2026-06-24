# Speedy Standalone Courier Service — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Speedy (speedy.bg) as a second courier in the standalone shipping service (:3100) at full parity with the standalone Econt integration — create order-less shipments (office + door), labels, tracking, COD reconciliation, courier pickup, address validation, sender auto-fill — without touching the shipped Econt code.

**Architecture:** A new `server/src/modules/speedy/` module mirrors `econt/` with the controller-less core split (`SpeedyCoreModule` provides the service/client/processor; the standalone app mounts a `SpeedyStandaloneController`). The `shipments` table is generalized **additively** (`carrier`, `trackingNumber`, `carrierShipmentId`) so the cross-carrier COD-risk hook works unchanged. Speedy persists a **canonical status** vocabulary (`pending|created|shipped|delivered|returned|refused`) so `CodRiskService.recordReturnIfApplicable` and reconciliation need no edits.

**Tech Stack:** NestJS, Drizzle ORM (`@fermeribg/db`), BullMQ, Redis cache, Speedy v1 REST/JSON API (`https://api.speedy.bg/v1`), pdf-lib, Jest.

**Spec:** `docs/superpowers/specs/2026-06-24-speedy-standalone-service-design.md`

**Key conventions (from the Econt + cod-risk rounds):**
- Money is integer **stotinki** (EUR cents). Speedy amounts are decimal EUR → divide/multiply by 100.
- Speedy auth = `userName`/`password` (+ optional `clientSystemId`) injected into **every JSON body** (no header). Credentials stored encrypted at `tenants.settings.delivery.speedy`.
- Per repo convention, **pure helpers are unit-tested**; service methods that only orchestrate DB + HTTP are not db-mock-tested (verified by `tsc` + boot smoke).
- Bulgarian user-facing strings.
- `main` auto-deploys to prod on push — migrations run on boot. Migration 0057 is additive/safe.
- A few Speedy field names are documented from the API reference, not a live payload. Mark those `// spike: verify vs live` (same posture as the Econt code) — they're confirmed against a demo account before go-live, not in this plan.

---

## File Structure

**Create:**
- `packages/db/drizzle/0057_*.sql` — migration (auto-named by drizzle-kit)
- `server/src/modules/speedy/dto/speedy-credentials.dto.ts`
- `server/src/modules/speedy/dto/speedy-manual-shipment.dto.ts`
- `server/src/modules/speedy/dto/speedy-validate-address.dto.ts`
- `server/src/modules/speedy/dto/speedy-courier-request.dto.ts`
- `server/src/modules/speedy/speedy.helpers.ts` + `speedy.helpers.spec.ts`
- `server/src/modules/speedy/speedy.client.ts` + `speedy.client.spec.ts`
- `server/src/modules/speedy/speedy.service.ts`
- `server/src/modules/speedy/speedy.processor.ts`
- `server/src/modules/speedy/speedy-core.module.ts`
- `server/src/modules/speedy/speedy-standalone.controller.ts`

**Modify:**
- `packages/db/src/schema.ts` — add 3 columns to `shipments`
- `server/src/common/queue/queue.constants.ts` — add `SPEEDY_QUEUE`
- `server/src/modules/econt-app/econt-app.module.ts` — import `SpeedyCoreModule`, mount `SpeedyStandaloneController`
- `server/src/app.module.ts` — import `SpeedyCoreModule` (so the refresh cron runs in the worker process)

**Reused unchanged:** `secret.util.ts`, `mergePdfs` (exported from `econt.service.ts`), `CodRiskService`, `ActivationGuard`, `JwtAuthGuard`, `CurrentTenant`, `PublicCacheService`, `registerRepeatable`.

---

## Task 1: Schema — generalize `shipments` (migration 0057)

**Files:**
- Modify: `packages/db/src/schema.ts:368-408` (shipments table)
- Create: `packages/db/drizzle/0057_*.sql` (generated)

- [ ] **Step 1: Add the three additive columns**

In `packages/db/src/schema.ts`, inside the `shipments` table definition, add after `econtShipmentNumber` (line ~374):

```ts
    econtShipmentNumber: text('econt_shipment_number'),
    // --- Multi-carrier (Speedy added alongside Econt) ---
    // Which courier owns this row. Existing rows + Econt inserts default 'econt';
    // Speedy inserts set 'speedy'. Each carrier's code reads only its own columns.
    carrier: text('carrier').notNull().default('econt'),
    // Speedy parcel barcode (the trackable number). Econt keeps econtShipmentNumber.
    trackingNumber: text('tracking_number'),
    // Speedy shipment id (needed for cancel/print/info). Null for Econt.
    carrierShipmentId: text('carrier_shipment_id'),
```

- [ ] **Step 2: Build the db package so the types update**

Run: `pnpm --filter @fermeribg/db build`
Expected: `tsc` exits 0; `packages/db/dist` regenerated.

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter @fermeribg/db generate`
Expected: a new `packages/db/drizzle/0057_*.sql` is created containing three `ALTER TABLE "shipments" ADD COLUMN` statements (`carrier`, `tracking_number`, `carrier_shipment_id`). **No interactive rename prompt** (all additive). If drizzle-kit asks any question, abort — the change should be purely additive.

- [ ] **Step 4: Verify the generated SQL**

Run: `cat packages/db/drizzle/0057_*.sql`
Expected (order may vary):
```sql
ALTER TABLE "shipments" ADD COLUMN "carrier" text DEFAULT 'econt' NOT NULL;
ALTER TABLE "shipments" ADD COLUMN "tracking_number" text;
ALTER TABLE "shipments" ADD COLUMN "carrier_shipment_id" text;
```

- [ ] **Step 5: Apply against local Postgres to confirm it runs**

Run (from `packages/db`, with the local compose PG up — `127.0.0.1:5433`, db/user `farmflow`, pass `fermeribg`):
```
DATABASE_URL=postgres://farmflow:fermeribg@127.0.0.1:5433/farmflow pnpm --filter @fermeribg/db migrate
```
Expected: migration `0057` applies cleanly (no error). If the local volume is stale, `docker compose down -v` then re-run.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/
git commit -m "feat(speedy): generalize shipments table with carrier columns (migration 0057)"
```

---

## Task 2: Speedy DTOs

**Files:**
- Create: `server/src/modules/speedy/dto/speedy-credentials.dto.ts`
- Create: `server/src/modules/speedy/dto/speedy-manual-shipment.dto.ts`
- Create: `server/src/modules/speedy/dto/speedy-validate-address.dto.ts`
- Create: `server/src/modules/speedy/dto/speedy-courier-request.dto.ts`

- [ ] **Step 1: Credentials DTO**

`speedy-credentials.dto.ts`:
```ts
import { IsString, IsNotEmpty, IsIn, IsOptional, IsInt } from 'class-validator';

/** Speedy API credentials for a tenant. Auth is userName/password in each request
 *  body; clientSystemId is optional (identifies the integrating system). */
export class SpeedyCredentialsDto {
  // Speedy has no separate sandbox host; 'demo' vs 'prod' only flags which
  // credentials/contract the tenant is using (both hit api.speedy.bg).
  @IsOptional() @IsIn(['demo', 'prod'])
  env?: 'demo' | 'prod';

  @IsString() @IsNotEmpty()
  userName!: string;

  @IsString() @IsNotEmpty()
  password!: string;

  @IsOptional() @IsInt()
  clientSystemId?: number;
}
```

- [ ] **Step 2: Manual-shipment DTO (id-based receiver)**

`speedy-manual-shipment.dto.ts`:
```ts
import {
  IsString, IsNotEmpty, IsIn, IsOptional, IsInt, Min, IsBoolean, MaxLength,
} from 'class-validator';

/** A Speedy shipment typed in by hand (no storefront order). Speedy addresses are
 *  id-based: siteId (нас. място) + streetId/streetNo for a door, or officeId for an
 *  office. serviceId is the Speedy courier-service code (from /services/destination). */
export class SpeedyManualShipmentDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  receiverName!: string;

  @IsString() @IsNotEmpty() @MaxLength(40)
  receiverPhone!: string;

  @IsIn(['office', 'address'])
  deliveryMode!: 'office' | 'address';

  // Required when deliveryMode === 'office'.
  @IsOptional() @IsInt() @Min(1)
  officeId?: number;

  // Required when deliveryMode === 'address'.
  @IsOptional() @IsInt() @Min(1)
  siteId?: number;
  @IsOptional() @IsInt() @Min(1)
  streetId?: number;
  @IsOptional() @IsString() @MaxLength(20)
  streetNo?: string;
  @IsOptional() @IsString() @MaxLength(20)
  blockNo?: string;
  @IsOptional() @IsString() @MaxLength(20)
  entranceNo?: string;
  @IsOptional() @IsString() @MaxLength(20)
  floorNo?: string;
  @IsOptional() @IsString() @MaxLength(20)
  apartmentNo?: string;

  // Speedy courier-service code (e.g. 505). Required to create a shipment.
  @IsInt() @Min(1)
  serviceId!: number;

  @IsOptional() @IsInt() @Min(0)
  weightGrams?: number; // grams in the API; converted to kg for Speedy

  @IsOptional() @IsInt() @Min(1)
  parcelsCount?: number;

  @IsOptional() @IsString() @MaxLength(120)
  contents?: string;

  // 0 / omitted → no cash-on-delivery.
  @IsOptional() @IsInt() @Min(0)
  codAmountStotinki?: number;

  @IsOptional() @IsInt() @Min(0)
  declaredValueStotinki?: number;
}
```

- [ ] **Step 3: Validate-address DTO**

`speedy-validate-address.dto.ts`:
```ts
import { IsInt, Min, IsOptional, IsString, MaxLength } from 'class-validator';

/** Address to dry-run against Speedy /validation/address before creating a label. */
export class SpeedyValidateAddressDto {
  @IsInt() @Min(1)
  siteId!: number;

  @IsOptional() @IsInt() @Min(1)
  streetId?: number;
  @IsOptional() @IsString() @MaxLength(20)
  streetNo?: string;
  @IsOptional() @IsInt() @Min(1)
  officeId?: number;
}
```

- [ ] **Step 4: Courier-request DTO**

`speedy-courier-request.dto.ts`:
```ts
import { IsArray, IsString, ArrayNotEmpty, IsOptional, MaxLength } from 'class-validator';

/** Request a Speedy courier pickup for already-created shipments. */
export class SpeedyCourierRequestDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true })
  shipmentIds!: string[];

  // Pickup date (YYYY-MM-DD) + time window; optional (Speedy auto-adjusts).
  @IsOptional() @IsString() @MaxLength(10)
  pickupDate?: string;
  @IsOptional() @IsString() @MaxLength(5)
  timeFrom?: string;
  @IsOptional() @IsString() @MaxLength(5)
  timeTo?: string;
}
```

- [ ] **Step 5: Compile**

Run: `pnpm --filter @fermeribg/server exec tsc --noEmit -p tsconfig.json`
Expected: 0 errors (DTOs are standalone).

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/speedy/dto/
git commit -m "feat(speedy): request DTOs (credentials, manual shipment, validate, courier)"
```

---

## Task 3: Speedy pure helpers (TDD)

**Files:**
- Create: `server/src/modules/speedy/speedy.helpers.ts`
- Test: `server/src/modules/speedy/speedy.helpers.spec.ts`

These pure functions hold all the carrier-specific shaping logic and are the most-tested part of the module.

- [ ] **Step 1: Write the failing test**

`speedy.helpers.spec.ts`:
```ts
import {
  parseTrackStatus, trackingUrl, buildShipmentRequest, parsePayouts,
  slimSites, slimOffices, slimStreets, slimContractClients, toEur,
} from './speedy.helpers';

describe('toEur', () => {
  it('converts stotinki to a 2dp EUR number', () => {
    expect(toEur(2400)).toBe(24);
    expect(toEur(2399)).toBe(23.99);
    expect(toEur(0)).toBe(0);
  });
});

describe('parseTrackStatus', () => {
  it('returns pending when there is no barcode yet', () => {
    expect(parseTrackStatus([], false)).toBe('pending');
  });
  it('maps delivered / returned / refused / in-transit from the latest operation', () => {
    expect(parseTrackStatus([{ description: 'Пратката е доставена' }], true)).toBe('delivered');
    expect(parseTrackStatus([{ description: 'Върната на подателя' }], true)).toBe('returned');
    expect(parseTrackStatus([{ description: 'Отказана от получателя' }], true)).toBe('refused');
    expect(parseTrackStatus([{ description: 'Товарителницата е в транзит' }], true)).toBe('shipped');
    expect(parseTrackStatus([{ description: 'returned to sender' }], true)).toBe('returned');
    expect(parseTrackStatus([{ description: 'refused by recipient' }], true)).toBe('refused');
  });
  it('uses the LAST operation (newest) to decide', () => {
    const ops = [{ description: 'в транзит' }, { description: 'доставена' }];
    expect(parseTrackStatus(ops, true)).toBe('delivered');
  });
  it('falls back to created when a barcode exists but no operation matches', () => {
    expect(parseTrackStatus([{ description: 'Приета в офис' }], true)).toBe('created');
    expect(parseTrackStatus([], true)).toBe('created');
  });
  it('the returned/refused tokens are recognized by cod-risk isReturnedStatus', () => {
    // canonical 'returned' contains 'return'; 'refused' contains 'refus'
    expect('returned'.includes('return')).toBe(true);
    expect('refused'.includes('refus')).toBe(true);
  });
});

describe('trackingUrl', () => {
  it('builds the Speedy public tracking link and strips spaces', () => {
    expect(trackingUrl('123 456')).toContain('123456');
    expect(trackingUrl('123456')).toContain('speedy.bg');
  });
});

describe('buildShipmentRequest', () => {
  const cfg = {
    sender: { contactName: 'Ферма Иванови', phone: '0888112233', mode: 'office', officeId: 70 },
    defaultPackage: { parcelsCount: 1, weightKg: 1, contents: 'Хранителни продукти' },
  };

  it('builds an office-delivery body with id-based recipient address', () => {
    const body = buildShipmentRequest(cfg, {
      receiverName: 'Иван Петров', receiverPhone: '0899445566',
      deliveryMode: 'office', officeId: 123, serviceId: 505,
    } as any) as any;
    expect(body.recipient.clientName).toBe('Иван Петров');
    expect(body.recipient.phone1.number).toBe('0899445566');
    expect(body.recipient.privatePerson).toBe(true);
    expect(body.recipient.address.officeId).toBe(123);
    expect(body.service.serviceId).toBe(505);
    expect(body.content.parcelsCount).toBe(1);
    expect(body.service.additionalServices).toBeUndefined(); // no COD
  });

  it('builds a door-address body with siteId/streetId/streetNo', () => {
    const body = buildShipmentRequest(cfg, {
      receiverName: 'Иван', receiverPhone: '0899445566',
      deliveryMode: 'address', siteId: 68134, streetId: 3109, streetNo: '1A', serviceId: 505,
    } as any) as any;
    expect(body.recipient.address.siteId).toBe(68134);
    expect(body.recipient.address.streetId).toBe(3109);
    expect(body.recipient.address.streetNo).toBe('1A');
    expect(body.recipient.address.officeId).toBeUndefined();
  });

  it('adds COD in EUR when a COD amount is given', () => {
    const body = buildShipmentRequest(cfg, {
      receiverName: 'Иван', receiverPhone: '0899445566',
      deliveryMode: 'office', officeId: 123, serviceId: 505, codAmountStotinki: 2400,
    } as any) as any;
    expect(body.service.additionalServices.cod.amount).toBe(24);
    expect(body.service.additionalServices.cod.processingType).toBe('CASH');
    expect(body.service.additionalServices.cod.currencyCode).toBe('EUR');
  });

  it('converts weightGrams to kg and honours parcelsCount/contents overrides', () => {
    const body = buildShipmentRequest(cfg, {
      receiverName: 'Иван', receiverPhone: '0899445566',
      deliveryMode: 'office', officeId: 123, serviceId: 505,
      weightGrams: 1500, parcelsCount: 2, contents: 'Мед',
    } as any) as any;
    expect(body.content.totalWeight).toBe(1.5);
    expect(body.content.parcelsCount).toBe(2);
    expect(body.content.contents).toBe('Мед');
  });
});

describe('parsePayouts', () => {
  it('maps a Speedy payout report into reconciliation rows (defensive shape)', () => {
    const rows = parsePayouts({ payouts: [
      { shipmentBarcode: '123', amount: 24, paidDate: '2026-06-20T00:00:00+03:00' },
    ] });
    expect(rows).toHaveLength(1);
    expect(rows[0].barcode).toBe('123');
    expect(rows[0].amountStotinki).toBe(2400);
    expect(rows[0].settledAt).toBe('2026-06-20T00:00:00+03:00');
  });
  it('handles an array root and missing fields', () => {
    expect(parsePayouts([{ amount: 10 }])[0].amountStotinki).toBe(1000);
    expect(parsePayouts(null)).toEqual([]);
  });
});

describe('slim mappers', () => {
  it('slimSites reads id/name/postCode defensively', () => {
    const s = slimSites({ sites: [{ id: 68134, name: 'София', postCode: '1000' }] });
    expect(s[0]).toEqual({ id: 68134, name: 'София', postCode: '1000' });
    expect(slimSites(null)).toEqual([]);
  });
  it('slimOffices reads id/name/address', () => {
    const o = slimOffices({ offices: [{ id: 70, name: 'Офис Изток', address: { fullAddress: 'бул. Витоша 1' } }] });
    expect(o[0]).toEqual({ id: 70, name: 'Офис Изток', address: 'бул. Витоша 1' });
  });
  it('slimStreets reads id/name', () => {
    const s = slimStreets({ streets: [{ id: 3109, name: 'Витоша' }] });
    expect(s[0]).toEqual({ id: 3109, name: 'Витоша' });
  });
  it('slimContractClients maps to sender suggestions', () => {
    const c = slimContractClients({ clients: [{ clientName: 'Ферма', phones: [{ number: '0888' }], id: 9 }] });
    expect(c[0]).toEqual({ name: 'Ферма', phone: '0888', clientNumber: '9' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @fermeribg/server exec jest speedy.helpers --silent`
Expected: FAIL — `Cannot find module './speedy.helpers'`.

- [ ] **Step 3: Implement the helpers**

`speedy.helpers.ts`:
```ts
/** Canonical shipment status shared with Econt's vocabulary so the COD-risk hook,
 *  reconciliation and list views work the same for both carriers. 'returned' and
 *  'refused' are recognized by cod-risk's isReturnedStatus ('return'/'refus' substrings). */
export type CanonicalStatus =
  | 'pending' | 'created' | 'shipped' | 'delivered' | 'returned' | 'refused';

/** stotinki (EUR cents) → a 2-decimal EUR number for the Speedy API. */
export function toEur(stotinki: number): number {
  return Math.round(stotinki) / 100;
}

/** Speedy's public tracking page for a parcel barcode. */
export function trackingUrl(barcode: string): string {
  return `https://www.speedy.bg/bg/track-shipment?shipmentNumber=${barcode.replace(/\s/g, '')}`;
}

/**
 * Collapse a Speedy /track operations[] history into a canonical status. Keyed off
 * the LATEST operation's free-text description (Bulgarian + English), mirroring the
 * keyword approach used for Econt. // spike: confirm operation codes vs live /track.
 */
export function parseTrackStatus(
  operations: Array<{ description?: string | null; code?: number | string | null }> | null | undefined,
  hasBarcode: boolean,
): CanonicalStatus {
  if (!hasBarcode) return 'pending';
  const ops = Array.isArray(operations) ? operations : [];
  const last = ops.length ? ops[ops.length - 1] : null;
  const d = (last?.description ?? '').toLowerCase();
  if (d.includes('върн') || d.includes('return')) return 'returned';
  if (d.includes('отказ') || d.includes('refus')) return 'refused';
  if (d.includes('достав') || d.includes('предадена') || d.includes('deliver')) return 'delivered';
  if (d.includes('транзит') || d.includes('товар') || d.includes('път') || d.includes('transit') || d.includes('ship'))
    return 'shipped';
  return 'created';
}

/** The stored Speedy config (sender profile + package defaults). */
export interface SpeedyStored {
  env?: 'demo' | 'prod';
  userName?: string;
  passwordEnc?: string;
  clientSystemId?: number;
  configured?: boolean;
  sender?: {
    contactName?: string;
    phone?: string;
    mode?: 'office' | 'address';
    officeId?: number;
    siteId?: number;
    streetId?: number;
    streetNo?: string;
  };
  defaultPackage?: { parcelsCount?: number; weightKg?: number; contents?: string };
  cod?: { enabled?: boolean; processingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER' };
  [k: string]: unknown;
}

interface ManualInput {
  receiverName: string;
  receiverPhone: string;
  deliveryMode: 'office' | 'address';
  officeId?: number;
  siteId?: number;
  streetId?: number;
  streetNo?: string;
  blockNo?: string;
  entranceNo?: string;
  floorNo?: string;
  apartmentNo?: string;
  serviceId: number;
  weightGrams?: number;
  parcelsCount?: number;
  contents?: string;
  codAmountStotinki?: number;
  declaredValueStotinki?: number;
}

/**
 * Build the Speedy POST /shipment body from the farm's sender profile + hand-entered
 * receiver. Addresses are id-based (siteId/streetId/streetNo for a door, officeId for
 * an office). COD + declared value ride on service.additionalServices in EUR.
 * // spike: verify sender/recipient/address field names + payer enums vs live API.
 */
export function buildShipmentRequest(cfg: SpeedyStored, input: ManualInput): Record<string, unknown> {
  const sender = cfg.sender ?? {};
  const pkg = cfg.defaultPackage ?? {};
  const contents = input.contents || pkg.contents || 'Хранителни продукти';
  const weightKg = input.weightGrams ? input.weightGrams / 1000 : (pkg.weightKg ?? 1);
  const parcelsCount = input.parcelsCount ?? pkg.parcelsCount ?? 1;

  const recipientAddress: Record<string, unknown> =
    input.deliveryMode === 'office'
      ? { countryId: 100, officeId: input.officeId }
      : {
          countryId: 100,
          siteId: input.siteId,
          ...(input.streetId ? { streetId: input.streetId } : {}),
          ...(input.streetNo ? { streetNo: input.streetNo } : {}),
          ...(input.blockNo ? { blockNo: input.blockNo } : {}),
          ...(input.entranceNo ? { entranceNo: input.entranceNo } : {}),
          ...(input.floorNo ? { floorNo: input.floorNo } : {}),
          ...(input.apartmentNo ? { apartmentNo: input.apartmentNo } : {}),
        };

  const additionalServices: Record<string, unknown> = {};
  if (input.codAmountStotinki && input.codAmountStotinki > 0) {
    additionalServices.cod = {
      amount: toEur(input.codAmountStotinki),
      processingType: cfg.cod?.processingType ?? 'CASH',
      currencyCode: 'EUR',
    };
  }
  if (input.declaredValueStotinki && input.declaredValueStotinki > 0) {
    additionalServices.declaredValue = { amount: toEur(input.declaredValueStotinki) };
  }

  const service: Record<string, unknown> = { serviceId: input.serviceId, autoAdjustPickupDate: true };
  if (Object.keys(additionalServices).length) service.additionalServices = additionalServices;

  const senderBlock: Record<string, unknown> = {
    phone1: { number: sender.phone ?? '' },
    contactName: sender.contactName ?? 'Подател',
  };
  if (sender.mode === 'office' && sender.officeId) senderBlock.dropoffOfficeId = sender.officeId;

  return {
    sender: senderBlock,
    recipient: {
      phone1: { number: input.receiverPhone },
      clientName: input.receiverName,
      privatePerson: true,
      address: recipientAddress,
    },
    service,
    content: { parcelsCount, totalWeight: weightKg, contents },
    // Default: recipient pays courier (COD use-case). // spike: confirm payer enum.
    payment: { courierServicePayer: 'RECIPIENT' },
    ref1: contents.slice(0, 30),
  };
}

export interface SpeedyPayout {
  barcode: string | null;
  amountStotinki: number;
  settledAt: string | null;
}

/** Read Speedy's /payments PayoutResponse defensively into reconciliation rows. */
export function parsePayouts(res: unknown): SpeedyPayout[] {
  const r = (res ?? {}) as Record<string, any>;
  const list: any[] = Array.isArray(r) ? r : Array.isArray(r.payouts) ? r.payouts : Array.isArray(r.data) ? r.data : [];
  return list.map((p) => ({
    barcode: p?.shipmentBarcode ?? p?.barcode ?? null,
    amountStotinki: Math.round(Number(p?.amount ?? 0) * 100),
    settledAt: p?.paidDate ?? p?.date ?? null,
  }));
}

export interface SpeedySite { id: number; name: string; postCode: string | null; }
export interface SpeedyOffice { id: number; name: string; address: string | null; }
export interface SpeedyStreet { id: number; name: string; }
export interface SenderSuggestion { name: string; phone: string; clientNumber: string | null; }

export function slimSites(res: unknown): SpeedySite[] {
  const r = (res ?? {}) as Record<string, any>;
  const list: any[] = Array.isArray(r) ? r : Array.isArray(r.sites) ? r.sites : [];
  return list
    .map((s) => ({ id: Number(s?.id), name: String(s?.name ?? '').trim(), postCode: s?.postCode ?? null }))
    .filter((s) => Number.isFinite(s.id) && s.name);
}

export function slimOffices(res: unknown): SpeedyOffice[] {
  const r = (res ?? {}) as Record<string, any>;
  const list: any[] = Array.isArray(r) ? r : Array.isArray(r.offices) ? r.offices : [];
  return list
    .map((o) => ({
      id: Number(o?.id),
      name: String(o?.name ?? '').trim(),
      address: (o?.address?.fullAddress ?? o?.address ?? null) || null,
    }))
    .filter((o) => Number.isFinite(o.id) && o.name);
}

export function slimStreets(res: unknown): SpeedyStreet[] {
  const r = (res ?? {}) as Record<string, any>;
  const list: any[] = Array.isArray(r) ? r : Array.isArray(r.streets) ? r.streets : [];
  return list
    .map((s) => ({ id: Number(s?.id), name: String(s?.name ?? '').trim() }))
    .filter((s) => Number.isFinite(s.id) && s.name);
}

export function slimContractClients(res: unknown): SenderSuggestion[] {
  const r = (res ?? {}) as Record<string, any>;
  const list: any[] = Array.isArray(r) ? r : Array.isArray(r.clients) ? r.clients : [];
  return list.map((c) => {
    const phones: any[] = Array.isArray(c?.phones) ? c.phones : [];
    const phone = phones.length ? String(phones[0]?.number ?? phones[0] ?? '') : '';
    return {
      name: String(c?.clientName ?? c?.name ?? '').trim(),
      phone,
      clientNumber: c?.id != null ? String(c.id) : null,
    };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @fermeribg/server exec jest speedy.helpers --silent`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/speedy/speedy.helpers.ts server/src/modules/speedy/speedy.helpers.spec.ts
git commit -m "feat(speedy): pure helpers — shipment body, status parse, payouts, location slimmers"
```

---

## Task 4: SpeedyClient (HTTP) (TDD)

**Files:**
- Create: `server/src/modules/speedy/speedy.client.ts`
- Test: `server/src/modules/speedy/speedy.client.spec.ts`

- [ ] **Step 1: Write the failing test**

`speedy.client.spec.ts`:
```ts
import { SpeedyClient } from './speedy.client';

describe('SpeedyClient', () => {
  const creds = { base: 'https://api.speedy.bg/v1', userName: 'u', password: 'p', clientSystemId: 7 };
  let client: SpeedyClient;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    client = new SpeedyClient();
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  it('call injects credentials into the JSON body and returns parsed json', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: 1 }) });
    const out = await client.call(creds, 'location/site', { name: 'София' });
    expect(out).toEqual({ ok: 1 });
    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse(init.body);
    expect(sent.userName).toBe('u');
    expect(sent.password).toBe('p');
    expect(sent.clientSystemId).toBe(7);
    expect(sent.name).toBe('София');
  });

  it('call throws BadRequest on a Speedy JSON error envelope (HTTP 200)', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ error: { message: 'bad creds' } }) });
    await expect(client.call(creds, 'shipment', {})).rejects.toThrow(/bad creds/);
  });

  it('call throws BadRequest on a non-ok HTTP status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => '{}' });
    await expect(client.call(creds, 'shipment', {})).rejects.toThrow(/401/);
  });

  it('callSafe returns null instead of throwing (degradable lookups)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const out = await client.callSafe(creds, 'location/site', {});
    expect(out).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @fermeribg/server exec jest speedy.client --silent`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client**

`speedy.client.ts`:
```ts
import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface SpeedyCreds {
  base: string;
  userName: string;
  password: string;
  clientSystemId?: number;
}

/**
 * Thin HTTP client for the Speedy v1 REST API. Auth is the userName/password
 * (+ optional clientSystemId) merged into every JSON body. `call` throws a clear
 * 400 on any failure (for create/print/track). `callSafe` swallows failures and
 * returns null (for degradable location lookups). `callBinary` returns label bytes.
 */
@Injectable()
export class SpeedyClient {
  private readonly logger = new Logger(SpeedyClient.name);

  private body(creds: SpeedyCreds, body: unknown): string {
    return JSON.stringify({
      userName: creds.userName,
      password: creds.password,
      language: 'BG',
      ...(creds.clientSystemId != null ? { clientSystemId: creds.clientSystemId } : {}),
      ...(body as Record<string, unknown>),
    });
  }

  async call(creds: SpeedyCreds, path: string, body: unknown, timeoutMs = 15000): Promise<any> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(`${creds.base}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.body(creds, body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new BadRequestException(`Speedy недостъпен: ${err instanceof Error ? err.message : 'network error'}`);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body
    }
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || text?.slice(0, 200) || `HTTP ${res.status}`;
      throw new BadRequestException(`Speedy грешка (${res.status}): ${msg}`);
    }
    // Speedy can return an error envelope with HTTP 200.
    if (json?.error) {
      const msg = json.error?.message || json.error?.id || 'неизвестна грешка';
      throw new BadRequestException(`Speedy грешка: ${msg}`);
    }
    return json;
  }

  /** Degradable variant for location lookups — never throws; returns null on failure. */
  async callSafe(creds: SpeedyCreds, path: string, body: unknown, timeoutMs = 8000): Promise<any | null> {
    try {
      return await this.call(creds, path, body, timeoutMs);
    } catch (err) {
      this.logger.warn(`[speedy] ${path} failed (degraded): ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Fetch a label PDF (raw bytes). Speedy /print returns application/pdf directly,
   *  or an application/json error envelope on failure. */
  async callBinary(creds: SpeedyCreds, path: string, body: unknown, timeoutMs = 15000): Promise<Buffer> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(`${creds.base}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.body(creds, body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new BadRequestException(`Speedy недостъпен: ${err instanceof Error ? err.message : 'network error'}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok || ct.includes('application/json')) {
      const text = await res.text();
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text);
        msg = j?.error?.message || j?.message || msg;
      } catch {
        // ignore
      }
      throw new BadRequestException(`Speedy PDF грешка: ${msg}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @fermeribg/server exec jest speedy.client --silent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/speedy/speedy.client.ts server/src/modules/speedy/speedy.client.spec.ts
git commit -m "feat(speedy): SpeedyClient — creds-in-body HTTP, degradable + binary variants"
```

---

## Task 5: SpeedyService — credentials + location

**Files:**
- Create: `server/src/modules/speedy/speedy.service.ts`

Build the service incrementally across Tasks 5–7. This task lays the class + credentials + location lookups.

- [ ] **Step 1: Create the service with credentials + location methods**

`speedy.service.ts`:
```ts
import { Injectable, Inject, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { type Database, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { encryptSecret, decryptSecret } from '../../common/crypto/secret.util';
import { SpeedyClient, type SpeedyCreds } from './speedy.client';
import {
  type SpeedyStored, slimSites, slimOffices, slimStreets, slimContractClients,
  type SpeedySite, type SpeedyOffice, type SpeedyStreet, type SenderSuggestion,
} from './speedy.helpers';
import { SpeedyCredentialsDto } from './dto/speedy-credentials.dto';
import { SpeedyValidateAddressDto } from './dto/speedy-validate-address.dto';

const SPEEDY_BASE = 'https://api.speedy.bg/v1';
const NOMENCLATURE_TTL = 60 * 60 * 24; // 1 day
const EMPTY_TTL = 60; // negative-cache empty lookups for 60s

@Injectable()
export class SpeedyService {
  private readonly logger = new Logger(SpeedyService.name);
  private readonly encKey: string;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    config: ConfigService,
    private readonly cache: PublicCacheService,
    private readonly client: SpeedyClient,
  ) {
    this.encKey = config.get<string>('ENCRYPTION_KEY', '');
  }

  /* ------------------------------ credentials ------------------------------ */

  private async loadStored(
    tenantId: string,
  ): Promise<{ tenant: { id: string; slug: string; settings: Record<string, unknown> }; speedy: SpeedyStored }> {
    const [row] = await this.db
      .select({ id: tenants.id, slug: tenants.slug, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!row) throw new NotFoundException('Фермата не е намерена');
    const settings = (row.settings as Record<string, unknown> | null) ?? {};
    const delivery = (settings.delivery as Record<string, unknown> | null) ?? {};
    const speedy = (delivery.speedy as SpeedyStored | null) ?? {};
    return { tenant: { id: row.id, slug: row.slug, settings }, speedy };
  }

  private async resolveCreds(tenantId: string): Promise<SpeedyCreds> {
    if (!this.encKey) throw new BadRequestException('ENCRYPTION_KEY не е конфигуриран');
    const { speedy } = await this.loadStored(tenantId);
    if (!speedy.configured || !speedy.userName || !speedy.passwordEnc) {
      throw new BadRequestException('Speedy не е конфигуриран за тази ферма');
    }
    return {
      base: SPEEDY_BASE,
      userName: speedy.userName,
      password: decryptSecret(speedy.passwordEnc, this.encKey),
      clientSystemId: speedy.clientSystemId,
    };
  }

  /** Validate creds against Speedy (a cheap /client call), then store encrypted. */
  async saveCredentials(tenantId: string, input: SpeedyCredentialsDto): Promise<{ configured: true }> {
    if (!this.encKey) {
      throw new BadRequestException('ENCRYPTION_KEY не е конфигуриран — Speedy не може да се запази');
    }
    // Live validation: bad creds make /client fail.
    await this.client.call(
      { base: SPEEDY_BASE, userName: input.userName, password: input.password, clientSystemId: input.clientSystemId },
      'client',
      {},
    );

    const { tenant, speedy } = await this.loadStored(tenantId);
    const nextSpeedy: SpeedyStored = {
      ...speedy,
      env: input.env ?? 'prod',
      userName: input.userName,
      passwordEnc: encryptSecret(input.password, this.encKey),
      ...(input.clientSystemId != null ? { clientSystemId: input.clientSystemId } : {}),
      configured: true,
    };
    const nextSettings = {
      ...tenant.settings,
      delivery: { ...((tenant.settings.delivery as Record<string, unknown>) ?? {}), speedy: nextSpeedy },
    };
    await this.db.update(tenants).set({ settings: nextSettings }).where(eq(tenants.id, tenantId));
    await this.cache.del(`speedy:sites:${tenant.slug}`);
    return { configured: true };
  }

  async getConfig(tenantId: string): Promise<Record<string, unknown>> {
    const { speedy } = await this.loadStored(tenantId);
    const { passwordEnc: _pw, ...safe } = speedy;
    return { ...safe, configured: !!speedy.configured };
  }

  /* ------------------------------- location -------------------------------- */

  async searchSites(tenantId: string, q?: string): Promise<SpeedySite[]> {
    const { tenant } = await this.loadStored(tenantId);
    const key = `speedy:sites:${tenant.slug}`;
    let list = await this.cache.get<SpeedySite[]>(key);
    if (list === null) {
      const creds = await this.resolveCreds(tenantId);
      // Speedy /location/site can be queried by name; cache the full BG set once.
      const data = await this.client.callSafe(creds, 'location/site', { countryId: 100 });
      list = slimSites(data);
      await this.cache.set(key, list, list.length ? NOMENCLATURE_TTL : EMPTY_TTL);
    }
    const query = (q ?? '').trim().toLowerCase();
    if (!query) return list.slice(0, 20);
    const starts: SpeedySite[] = [];
    const contains: SpeedySite[] = [];
    for (const s of list) {
      const n = s.name.toLowerCase();
      if (n.startsWith(query)) starts.push(s);
      else if (n.includes(query)) contains.push(s);
    }
    return [...starts, ...contains].slice(0, 20);
  }

  async getOffices(tenantId: string, siteId: number): Promise<SpeedyOffice[]> {
    if (!siteId) return [];
    const { tenant } = await this.loadStored(tenantId);
    const key = `speedy:offices:${tenant.slug}:${siteId}`;
    const cached = await this.cache.get<SpeedyOffice[]>(key);
    if (cached !== null) return cached;
    const creds = await this.resolveCreds(tenantId);
    const data = await this.client.callSafe(creds, 'location/office', { countryId: 100, siteId });
    const list = slimOffices(data);
    await this.cache.set(key, list, list.length ? NOMENCLATURE_TTL : EMPTY_TTL);
    return list;
  }

  async getStreets(tenantId: string, siteId: number, q?: string): Promise<SpeedyStreet[]> {
    if (!siteId) return [];
    const { tenant } = await this.loadStored(tenantId);
    const key = `speedy:streets:${tenant.slug}:${siteId}`;
    let list = await this.cache.get<SpeedyStreet[]>(key);
    if (list === null) {
      const creds = await this.resolveCreds(tenantId);
      const data = await this.client.callSafe(creds, 'location/street', { siteId });
      list = slimStreets(data);
      await this.cache.set(key, list, list.length ? NOMENCLATURE_TTL : EMPTY_TTL);
    }
    const query = (q ?? '').trim().toLowerCase();
    if (!query) return list.slice(0, 20);
    return list.filter((s) => s.name.toLowerCase().includes(query)).slice(0, 20);
  }

  async validateAddress(
    tenantId: string,
    input: SpeedyValidateAddressDto,
  ): Promise<{ valid: boolean; status: string | null }> {
    const creds = await this.resolveCreds(tenantId);
    const address: Record<string, unknown> =
      input.officeId != null
        ? { countryId: 100, siteId: input.siteId, officeId: input.officeId }
        : { countryId: 100, siteId: input.siteId, streetId: input.streetId, streetNo: input.streetNo };
    const data = await this.client.call(creds, 'validation/address', { address });
    // Speedy returns a `validationMode`/`valid` flag. // spike: confirm field name.
    const valid = data?.valid === true || data?.validationMode === 'VALID';
    return { valid, status: data?.validationMode ?? null };
  }

  async getClientProfiles(tenantId: string): Promise<SenderSuggestion[]> {
    const creds = await this.resolveCreds(tenantId);
    const data = await this.client.call(creds, 'client/contract', {});
    return slimContractClients(data);
  }
}
```

- [ ] **Step 2: Compile**

Run: `pnpm --filter @fermeribg/server exec tsc --noEmit -p tsconfig.json`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/speedy/speedy.service.ts
git commit -m "feat(speedy): SpeedyService — credentials + location lookups (sites/offices/streets/validate/profiles)"
```

---

## Task 6: SpeedyService — shipments (create, list, labels, void)

**Files:**
- Modify: `server/src/modules/speedy/speedy.service.ts`

- [ ] **Step 1: Add shipment imports**

At the top of `speedy.service.ts`, extend the drizzle + helper imports:
```ts
import { and, eq, desc, inArray, isNull } from 'drizzle-orm';
import { type Database, tenants, shipments } from '@fermeribg/db';
import { mergePdfs } from '../econt/econt.service';
import {
  type SpeedyStored, slimSites, slimOffices, slimStreets, slimContractClients,
  buildShipmentRequest, parseTrackStatus, type CanonicalStatus,
  type SpeedySite, type SpeedyOffice, type SpeedyStreet, type SenderSuggestion,
} from './speedy.helpers';
import { SpeedyManualShipmentDto } from './dto/speedy-manual-shipment.dto';
```
(Keep the existing `tenants`/`ConfigService`/etc. imports; merge — don't duplicate.)

- [ ] **Step 2: Add a Speedy shipment view type + constants**

After the existing `const EMPTY_TTL` line:
```ts
const MAX_BULK_LABELS = 50;

/** A Speedy shipment row shaped for the standalone shipments table. */
export interface SpeedyShipment {
  shipmentId: string;
  receiverName: string;
  deliveryMode: 'office' | 'address';
  status: CanonicalStatus;
  trackingNumber: string | null;
  priceStotinki: number | null;
  codAmountStotinki: number | null;
}
```

- [ ] **Step 3: Add createManualShipment / listShipments / labels / void methods**

Append inside the `SpeedyService` class (before the closing brace):
```ts
  /* ------------------------------- shipments ------------------------------- */

  /** Create a Speedy waybill for a hand-entered receiver (no storefront order). */
  async createManualShipment(
    tenantId: string,
    input: SpeedyManualShipmentDto,
  ): Promise<typeof shipments.$inferSelect> {
    const { speedy } = await this.loadStored(tenantId);
    const creds = await this.resolveCreds(tenantId);
    const body = buildShipmentRequest(speedy, input);
    const data = await this.client.call(creds, 'shipment', body);

    // Speedy returns the shipment id + per-parcel barcodes.
    const shipmentId: string | null = data?.id != null ? String(data.id) : null;
    const parcels: any[] = Array.isArray(data?.parcels) ? data.parcels : [];
    const barcode: string | null = parcels.length ? String(parcels[0]?.barcode ?? parcels[0]?.id ?? '') || null : null;
    const priceEur: number | undefined = data?.price?.total ?? data?.price?.amount;
    const codAmount = input.codAmountStotinki && input.codAmountStotinki > 0 ? Math.round(input.codAmountStotinki) : null;

    const [row] = await this.db
      .insert(shipments)
      .values({
        tenantId,
        orderId: null,
        carrier: 'speedy',
        carrierShipmentId: shipmentId,
        trackingNumber: barcode,
        status: barcode ? 'created' : 'pending',
        labelPdfUrl: null, // Speedy /print returns bytes on demand (no hosted URL)
        courierPriceStotinki: typeof priceEur === 'number' ? Math.round(priceEur * 100) : null,
        codAmountStotinki: codAmount,
        trackingJson: data ?? null,
        receiverName: input.receiverName,
        receiverPhone: input.receiverPhone,
        deliveryMode: input.deliveryMode,
        receiverOfficeCode: input.officeId != null ? String(input.officeId) : null,
        receiverCity: input.siteId != null ? String(input.siteId) : null,
        weightKg: input.weightGrams ? String(input.weightGrams / 1000) : null,
        contents: input.contents ?? null,
      })
      .returning();
    return row;
  }

  /** Speedy shipments for this tenant (order-less), newest first. */
  async listShipments(tenantId: string): Promise<SpeedyShipment[]> {
    const rows = await this.db
      .select({
        shipmentId: shipments.id,
        receiverName: shipments.receiverName,
        deliveryMode: shipments.deliveryMode,
        status: shipments.status,
        trackingNumber: shipments.trackingNumber,
        priceStotinki: shipments.courierPriceStotinki,
        codAmountStotinki: shipments.codAmountStotinki,
      })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), eq(shipments.carrier, 'speedy')))
      .orderBy(desc(shipments.createdAt));
    return rows.map((r) => ({
      shipmentId: r.shipmentId,
      receiverName: r.receiverName ?? '—',
      deliveryMode: r.deliveryMode === 'address' ? 'address' : 'office',
      status: (r.status as CanonicalStatus) ?? 'pending',
      trackingNumber: r.trackingNumber,
      priceStotinki: r.priceStotinki,
      codAmountStotinki: r.codAmountStotinki,
    }));
  }

  /** One Speedy label PDF (tenant-scoped) — fetched live via /print. */
  async getLabelPdf(tenantId: string, shipmentId: string): Promise<Buffer> {
    const [row] = await this.db
      .select({ id: shipments.carrierShipmentId, barcode: shipments.trackingNumber })
      .from(shipments)
      .where(and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId), eq(shipments.carrier, 'speedy')))
      .limit(1);
    if (!row) throw new NotFoundException('Пратката не е намерена');
    const ref = row.id ?? row.barcode;
    if (!ref) throw new NotFoundException('Няма товарителница за тази пратка');
    const creds = await this.resolveCreds(tenantId);
    return this.client.callBinary(creds, 'print', { paperSize: 'A6', parcels: [{ parcel: { id: ref } }] });
  }

  /** Several Speedy labels merged into one PDF (tenant-scoped). */
  async getLabelsPdf(tenantId: string, shipmentIds: string[]): Promise<Buffer> {
    if (!shipmentIds.length) throw new BadRequestException('Няма избрани товарителници');
    if (shipmentIds.length > MAX_BULK_LABELS) {
      throw new BadRequestException(`Максимум ${MAX_BULK_LABELS} товарителници наведнъж`);
    }
    const creds = await this.resolveCreds(tenantId);
    const rows = await this.db
      .select({ id: shipments.carrierShipmentId, barcode: shipments.trackingNumber })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), eq(shipments.carrier, 'speedy'), inArray(shipments.id, shipmentIds)));
    const refs = rows.map((r) => r.id ?? r.barcode).filter((x): x is string => !!x);
    const settled = await Promise.allSettled(
      refs.map((ref) => this.client.callBinary(creds, 'print', { paperSize: 'A6', parcels: [{ parcel: { id: ref } }] })),
    );
    const buffers: Buffer[] = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') buffers.push(s.value);
      else this.logger.warn(`[speedy] label fetch failed for ${refs[i]}: ${s.reason instanceof Error ? s.reason.message : s.reason}`);
    });
    if (!buffers.length) throw new NotFoundException('Няма PDF за избраните товарителници');
    return mergePdfs(buffers);
  }

  /** Cancel a Speedy waybill (pre-pickup) and remove the shipment row. */
  async voidShipment(tenantId: string, shipmentId: string): Promise<{ id: string }> {
    const [row] = await this.db
      .select({ id: shipments.id, carrierShipmentId: shipments.carrierShipmentId })
      .from(shipments)
      .where(and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId), eq(shipments.carrier, 'speedy')))
      .limit(1);
    if (!row) throw new NotFoundException('Пратката не е намерена');
    if (row.carrierShipmentId) {
      const creds = await this.resolveCreds(tenantId);
      // Best-effort cancel — if Speedy already picked it up the row is still removed locally.
      try {
        await this.client.call(creds, 'shipment/cancel', { shipmentId: row.carrierShipmentId });
      } catch (err) {
        this.logger.warn(`[speedy] cancel failed for ${row.carrierShipmentId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    await this.db.delete(shipments).where(eq(shipments.id, shipmentId));
    return { id: shipmentId };
  }
```

- [ ] **Step 4: Compile**

Run: `pnpm --filter @fermeribg/server exec tsc --noEmit -p tsconfig.json`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/speedy/speedy.service.ts
git commit -m "feat(speedy): SpeedyService — create/list/labels/void shipments"
```

---

## Task 7: SpeedyService — tracking + COD reconciliation + courier (+ cod-risk hook)

**Files:**
- Modify: `server/src/modules/speedy/speedy.service.ts`

- [ ] **Step 1: Inject CodRiskService**

In `speedy.service.ts`, add the import:
```ts
import { CodRiskService } from '../cod-risk/cod-risk.service';
import { SpeedyCourierRequestDto } from './dto/speedy-courier-request.dto';
import { parsePayouts } from './speedy.helpers';
```
(Merge `parsePayouts` into the existing `./speedy.helpers` import line instead of duplicating.)

Add `codRisk` as the final constructor parameter:
```ts
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    config: ConfigService,
    private readonly cache: PublicCacheService,
    private readonly client: SpeedyClient,
    private readonly codRisk: CodRiskService,
  ) {
    this.encKey = config.get<string>('ENCRYPTION_KEY', '');
  }
```

- [ ] **Step 2: Add tracking + reconciliation + courier methods**

Append inside the class:
```ts
  /* ------------------------- tracking + COD + courier ---------------------- */

  /** Refresh a Speedy shipment's status from /track. Persists the canonical status
   *  and fires the COD-risk hook (best-effort) on a returned/refused COD parcel. */
  async refreshStatus(tenantId: string, shipmentId: string): Promise<typeof shipments.$inferSelect> {
    const [row] = await this.db
      .select()
      .from(shipments)
      .where(and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId), eq(shipments.carrier, 'speedy')))
      .limit(1);
    if (!row) throw new NotFoundException('Пратката не е намерена');
    if (!row.trackingNumber) return row;

    const creds = await this.resolveCreds(tenantId);
    const data = await this.client.call(creds, 'track', { parcels: [{ id: row.trackingNumber }] });
    const parcel = Array.isArray(data?.parcels) ? data.parcels[0] : null;
    const operations: any[] = Array.isArray(parcel?.operations) ? parcel.operations : [];
    const status = parseTrackStatus(operations, true);

    const [updated] = await this.db
      .update(shipments)
      .set({ status, trackingJson: parcel ?? row.trackingJson, updatedAt: new Date() })
      .where(eq(shipments.id, shipmentId))
      .returning();

    // COD-risk strike on a returned/refused COD parcel. Best-effort — must never turn
    // a successful refresh into a user-facing error (carrier-agnostic; keys off status).
    try {
      await this.codRisk.recordReturnIfApplicable(updated);
    } catch (err) {
      this.logger.warn(`[speedy] cod-risk record failed for ${updated.id}: ${err instanceof Error ? err.message : err}`);
    }
    return updated;
  }

  /** Refresh every not-yet-final Speedy shipment with a barcode, across all tenants.
   *  Best-effort per shipment — one Speedy failure never aborts the batch. */
  async refreshActiveShipments(): Promise<{ refreshed: number }> {
    const rows = await this.db
      .select({ id: shipments.id, tenantId: shipments.tenantId, barcode: shipments.trackingNumber, status: shipments.status })
      .from(shipments)
      .where(eq(shipments.carrier, 'speedy'));
    let refreshed = 0;
    for (const r of rows) {
      if (!r.barcode || !r.tenantId) continue;
      if (r.status === 'delivered' || r.status === 'returned' || r.status === 'refused') continue;
      try {
        await this.refreshStatus(r.tenantId, r.id);
        refreshed++;
      } catch (err) {
        this.logger.warn(`[speedy] refresh failed for shipment ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { refreshed };
  }

  /** COD payout reconciliation for the last 60 days (Очаквано → Преведено). Stamps
   *  codSettledAt on matched Speedy shipments and returns the screen rows. */
  async codReconciliation(tenantId: string): Promise<Array<{ shipmentId: string; expectedStotinki: number | null; settledAt: string | null }>> {
    const creds = await this.resolveCreds(tenantId);
    // Speedy /payments takes a date range (ISO with TZ). 60-day lookback.
    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - 60 * 24 * 60 * 60 * 1000);
    const data = await this.client.callSafe(creds, 'payments', {
      fromDate: fromDate.toISOString(),
      toDate: toDate.toISOString(),
      includeDetails: true,
    });
    const payouts = parsePayouts(data);
    const settledByBarcode = new Map(payouts.filter((p) => p.barcode).map((p) => [p.barcode as string, p]));

    const rows = await this.db
      .select({
        shipmentId: shipments.id,
        barcode: shipments.trackingNumber,
        expected: shipments.codAmountStotinki,
        settledAt: shipments.codSettledAt,
      })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), eq(shipments.carrier, 'speedy')));

    const out: Array<{ shipmentId: string; expectedStotinki: number | null; settledAt: string | null }> = [];
    for (const r of rows) {
      if (r.expected == null) continue; // not a COD shipment
      const payout = r.barcode ? settledByBarcode.get(r.barcode) : undefined;
      let settledAt = r.settledAt ? r.settledAt.toISOString() : null;
      if (payout?.settledAt && !r.settledAt) {
        const d = new Date(payout.settledAt);
        if (!Number.isNaN(d.getTime())) {
          await this.db.update(shipments).set({ codSettledAt: d, updatedAt: new Date() }).where(eq(shipments.id, r.shipmentId));
          settledAt = d.toISOString();
        }
      }
      out.push({ shipmentId: r.shipmentId, expectedStotinki: r.expected, settledAt });
    }
    return out;
  }

  /** Book a Speedy courier pickup for already-created shipments. */
  async requestCourier(
    tenantId: string,
    input: SpeedyCourierRequestDto,
  ): Promise<{ pickupId: string | null; attached: number; skipped: number }> {
    const creds = await this.resolveCreds(tenantId);
    const rows = await this.db
      .select({ id: shipments.id, shipmentId: shipments.carrierShipmentId })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), eq(shipments.carrier, 'speedy'), inArray(shipments.id, input.shipmentIds)));
    const sent = rows.filter((r): r is { id: string; shipmentId: string } => !!r.shipmentId);
    if (!sent.length) throw new BadRequestException('Няма товарителници за заявка на куриер');

    const body: Record<string, unknown> = {
      shipmentIds: sent.map((r) => r.shipmentId),
      ...(input.pickupDate ? { pickupDate: input.pickupDate } : {}),
      ...(input.timeFrom ? { timeFrom: input.timeFrom } : {}),
      ...(input.timeTo ? { timeTo: input.timeTo } : {}),
    };
    const data = await this.client.call(creds, 'pickup', body);
    const pickupId: string | null = data?.id != null ? String(data.id) : null;

    if (pickupId) {
      await this.db
        .update(shipments)
        .set({ courierRequestId: pickupId, courierRequestStatus: 'requested', updatedAt: new Date() })
        .where(and(eq(shipments.tenantId, tenantId), inArray(shipments.id, sent.map((r) => r.id))));
    }
    return { pickupId, attached: sent.length, skipped: input.shipmentIds.length - sent.length };
  }
```

- [ ] **Step 3: Compile**

Run: `pnpm --filter @fermeribg/server exec tsc --noEmit -p tsconfig.json`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/speedy/speedy.service.ts
git commit -m "feat(speedy): SpeedyService — tracking, COD reconciliation, courier pickup + cod-risk hook"
```

---

## Task 8: Queue constant + processor + core module

**Files:**
- Modify: `server/src/common/queue/queue.constants.ts`
- Create: `server/src/modules/speedy/speedy.processor.ts`
- Create: `server/src/modules/speedy/speedy-core.module.ts`

- [ ] **Step 1: Add the queue constant**

In `server/src/common/queue/queue.constants.ts`, append:
```ts
export const SPEEDY_QUEUE = 'speedy';
```

- [ ] **Step 2: Create the processor**

`speedy.processor.ts` (mirror `econt.processor.ts`):
```ts
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { SpeedyService } from './speedy.service';
import { SPEEDY_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(SPEEDY_QUEUE)
export class SpeedyProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(SpeedyProcessor.name);

  constructor(
    private readonly speedy: SpeedyService,
    @InjectQueue(SPEEDY_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    // Every 30 minutes — Speedy statuses move on the order of hours.
    await registerRepeatable(this.queue, 'refresh-active', '*/30 * * * *');
  }

  async process(_job: Job): Promise<void> {
    const { refreshed } = await this.speedy.refreshActiveShipments();
    this.logger.log(`[speedy] refreshed ${refreshed} active shipment(s)`);
  }
}
```

- [ ] **Step 3: Create the core module**

`speedy-core.module.ts` (mirror `econt-core.module.ts` — no ShipmentEmailService; all Speedy shipments are order-less):
```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SpeedyService } from './speedy.service';
import { SpeedyClient } from './speedy.client';
import { SpeedyProcessor } from './speedy.processor';
import { SPEEDY_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';
import { CodRiskModule } from '../cod-risk/cod-risk.module';

/**
 * Speedy providers WITHOUT controllers — so the standalone shipping app reuses
 * `SpeedyService` (+ the refresh queue/processor) without mounting any FarmFlow
 * routes. The processor only runs when this process is a worker (RUN_WORKERS).
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: SPEEDY_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    }),
    CodRiskModule,
  ],
  providers: [SpeedyService, SpeedyClient, ...(RUN_WORKERS ? [SpeedyProcessor] : [])],
  exports: [SpeedyService],
})
export class SpeedyCoreModule {}
```

- [ ] **Step 4: Compile**

Run: `pnpm --filter @fermeribg/server exec tsc --noEmit -p tsconfig.json`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/common/queue/queue.constants.ts server/src/modules/speedy/speedy.processor.ts server/src/modules/speedy/speedy-core.module.ts
git commit -m "feat(speedy): SPEEDY_QUEUE + processor (30m refresh cron) + controller-less core module"
```

---

## Task 9: Standalone controller + module wiring

**Files:**
- Create: `server/src/modules/speedy/speedy-standalone.controller.ts`
- Modify: `server/src/modules/econt-app/econt-app.module.ts`
- Modify: `server/src/app.module.ts`

- [ ] **Step 1: Create the standalone controller**

`speedy-standalone.controller.ts` (mirror the Econt standalone controller; paid actions get `ActivationGuard`):
```ts
import {
  Controller, Get, Post, Delete, Body, Param, Query, UseGuards, ParseUUIDPipe, StreamableFile,
} from '@nestjs/common';
import { SpeedyService } from '../speedy/speedy.service';
import { SpeedyCredentialsDto } from '../speedy/dto/speedy-credentials.dto';
import { SpeedyManualShipmentDto } from '../speedy/dto/speedy-manual-shipment.dto';
import { SpeedyValidateAddressDto } from '../speedy/dto/speedy-validate-address.dto';
import { SpeedyCourierRequestDto } from '../speedy/dto/speedy-courier-request.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { ActivationGuard } from '../econt-app/activation.guard';

@UseGuards(JwtAuthGuard)
@Controller('speedy')
export class SpeedyStandaloneController {
  constructor(private readonly speedy: SpeedyService) {}

  // --- account / setup ---
  @Post('credentials')
  saveCredentials(@CurrentTenant() t: string, @Body() dto: SpeedyCredentialsDto) {
    return this.speedy.saveCredentials(t, dto);
  }
  @Get('config')
  config(@CurrentTenant() t: string) {
    return this.speedy.getConfig(t);
  }
  @Get('profiles')
  profiles(@CurrentTenant() t: string) {
    return this.speedy.getClientProfiles(t);
  }

  // --- location pickers ---
  @Get('sites')
  sites(@CurrentTenant() t: string, @Query('q') q?: string) {
    return this.speedy.searchSites(t, q);
  }
  @Get('offices')
  offices(@CurrentTenant() t: string, @Query('siteId') siteId?: string) {
    return this.speedy.getOffices(t, siteId ? Number(siteId) : 0);
  }
  @Get('streets')
  streets(@CurrentTenant() t: string, @Query('siteId') siteId?: string, @Query('q') q?: string) {
    return this.speedy.getStreets(t, siteId ? Number(siteId) : 0, q);
  }
  @Post('validate-address')
  validateAddress(@CurrentTenant() t: string, @Body() dto: SpeedyValidateAddressDto) {
    return this.speedy.validateAddress(t, dto);
  }

  // --- shipments ---
  @Get('shipments')
  list(@CurrentTenant() t: string) {
    return this.speedy.listShipments(t);
  }
  @Get('cod-reconciliation')
  cod(@CurrentTenant() t: string) {
    return this.speedy.codReconciliation(t);
  }

  // Creating a real waybill is the paid action → activation-gated.
  @UseGuards(ActivationGuard)
  @Post('shipments')
  create(@CurrentTenant() t: string, @Body() dto: SpeedyManualShipmentDto) {
    return this.speedy.createManualShipment(t, dto);
  }

  @Post('shipments/:id/refresh')
  refresh(@CurrentTenant() t: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.speedy.refreshStatus(t, id);
  }
  @Delete('shipments/:id')
  void(@CurrentTenant() t: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.speedy.voidShipment(t, id);
  }

  // --- courier pickup (paid action) ---
  @UseGuards(ActivationGuard)
  @Post('courier')
  courier(@CurrentTenant() t: string, @Body() dto: SpeedyCourierRequestDto) {
    return this.speedy.requestCourier(t, dto);
  }

  // --- print ---
  @Get('labels.pdf')
  async labels(@CurrentTenant() t: string, @Query('ids') ids: string): Promise<StreamableFile> {
    const list = (ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const buf = await this.speedy.getLabelsPdf(t, list);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="labels.pdf"' });
  }
  @Get('shipments/:id/label.pdf')
  async label(@CurrentTenant() t: string, @Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const buf = await this.speedy.getLabelPdf(t, id);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="label.pdf"' });
  }
}
```

- [ ] **Step 2: Wire SpeedyCoreModule + controller into the standalone app**

In `server/src/modules/econt-app/econt-app.module.ts`:
- Add imports near the other core-module imports:
```ts
import { SpeedyCoreModule } from '../speedy/speedy-core.module';
import { SpeedyStandaloneController } from '../speedy/speedy-standalone.controller';
```
- Add `SpeedyCoreModule` to the `imports` array (after `EcontCoreModule`):
```ts
    EcontCoreModule, // EcontService + ShipmentEmailService (no /econt/* controllers)
    SpeedyCoreModule, // SpeedyService (no FarmFlow controllers)
```
- Add `SpeedyStandaloneController` to the `controllers` array:
```ts
  controllers: [StandaloneAuthController, EcontStandaloneController, SpeedyStandaloneController],
```

- [ ] **Step 3: Wire SpeedyCoreModule into the FarmFlow app (worker cron)**

In `server/src/app.module.ts`:
- Add the import near the `EcontModule` import (line ~42):
```ts
import { SpeedyCoreModule } from './modules/speedy/speedy-core.module';
```
- Add `SpeedyCoreModule` to the module `imports` array right after `EcontModule` (line ~126):
```ts
    EcontModule,
    SpeedyCoreModule,
```
This makes the Speedy refresh cron run in the worker process (the FarmFlow API with `RUN_WORKERS=true`), NOT in the standalone (`APP_ROLE=web`). No Speedy controllers are mounted here (the core module is controller-less).

- [ ] **Step 4: Compile**

Run: `pnpm --filter @fermeribg/server exec tsc --noEmit -p tsconfig.json`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/speedy/speedy-standalone.controller.ts server/src/modules/econt-app/econt-app.module.ts server/src/app.module.ts
git commit -m "feat(speedy): /speedy/* standalone controller + wire core into standalone app + worker cron"
```

---

## Task 10: Final verification + boot smoke

**Files:** none (verification only).

- [ ] **Step 1: Full build**

Run: `pnpm --filter @fermeribg/db build && pnpm --filter @fermeribg/server build`
Expected: both exit 0.

- [ ] **Step 2: Lint**

Run: `pnpm --filter @fermeribg/server lint`
Expected: 0 errors (fix any new warnings in the speedy files).

- [ ] **Step 3: Full test suite**

Run: `pnpm --filter @fermeribg/server test`
Expected: ALL suites pass (684 prior + the new `speedy.helpers` + `speedy.client` suites). No regressions.

- [ ] **Step 4: Boot smoke — standalone :3100**

Ensure local PG (`127.0.0.1:5433`) + Redis are up and migration 0057 is applied (Task 1 Step 5). Then:
```
ENCRYPTION_KEY=test-key-please-change \
DATABASE_URL=postgres://farmflow:fermeribg@127.0.0.1:5433/farmflow \
REDIS_URL=redis://127.0.0.1:6379 \
JWT_SECRET=dev-secret \
PORT_ECONT=3100 APP_ROLE=web \
node server/dist/main.econt.js
```
Expected: logs `Econt standalone API running on http://localhost:3100`, no Nest DI errors (the `SpeedyService`/`SpeedyClient`/`SpeedyStandaloneController` resolve; `SpeedyProcessor` is NOT instantiated because `APP_ROLE=web` → `RUN_WORKERS=false`).

- [ ] **Step 5: Boot smoke — verify the Speedy route is mounted + activation-gated**

With the server from Step 4 running, in another shell:
```bash
# Sign up a standalone account (returns a JWT).
curl -s -X POST http://localhost:3100/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"speedy-smoke@example.com","farmName":"Smoke Ферма","phone":"0888000111","password":"vremennaparola1234"}'
# → copy the token, then attempt a paid action (create) BEFORE activation:
TOKEN=<paste>
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3100/speedy/shipments \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"receiverName":"Иван","receiverPhone":"0899445566","deliveryMode":"office","officeId":1,"serviceId":505}'
```
Expected: `403` (ActivationGuard blocks the unactivated account — proves the route is mounted and gated). A read route like `GET /speedy/config` with the token returns `200` with `{configured:false}`.

- [ ] **Step 6: Stop the server.** (Ctrl-C.)

- [ ] **Step 7: Final commit (if any lint/build fixups were needed)**

```bash
git add -A
git commit -m "chore(speedy): verification fixups (build + lint + boot smoke green)"
```

---

## Self-Review (completed)

**Spec coverage:**
- Module layout (client/service/helpers/core/processor/dto) → Tasks 2–9 ✅
- Data model carrier columns (additive) → Task 1 ✅
- Credentials + location (sites/offices/streets/validate/profiles) → Task 5 ✅
- Shipments (create/list/labels/void) → Task 6 ✅
- Tracking + COD reconciliation + courier + cod-risk hook → Task 7 ✅
- Canonical status → Task 3 (`parseTrackStatus`) ✅
- Activation gate on paid actions → Task 9 (controller) ✅
- Cron placement in worker process → Task 9 Step 3 (AppModule) ✅
- No shipped-email / no duplicated risk routes → reflected (Speedy controller has neither) ✅
- Redis-cached location, no new tables → Task 5 (cache keys `speedy:*`) ✅

**Placeholder scan:** none — every code step is complete. Live-uncertain Speedy field names are marked `// spike:` (intentional, deferred to a demo-account spike — not placeholders in the plan sense).

**Type consistency:** `SpeedyStored`, `SpeedyCreds`, `CanonicalStatus`, `SpeedySite/Office/Street`, `SenderSuggestion`, `SpeedyShipment` defined once and used consistently. `parseTrackStatus(operations, hasBarcode)`, `buildShipmentRequest(cfg, input)`, `toEur(stotinki)`, `parsePayouts(res)` signatures match between helpers (Task 3) and service (Tasks 5–7). DTO field names (`officeId`, `siteId`, `streetId`, `serviceId`, `codAmountStotinki`, `weightGrams`) match between DTO (Task 2), `buildShipmentRequest` test+impl (Task 3), and `createManualShipment` (Task 6).

## Pending after this plan (out of scope — tracked in the spec)

- **Spikes:** Speedy demo creds → confirm create/track/print/payments/validate field names + EUR currency behavior; resolve a real `serviceId` via `/services/destination`.
- **Frontend + deploy:** standalone shipping web UI gains a Speedy tab; `deploy.yml` already covers the standalone process.
- **Provision:** each tenant supplies its own Speedy contract creds (no platform-wide key, unlike nekorekten).
