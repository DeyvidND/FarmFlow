# Cheapest-Courier Quote — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only `POST /shipping/compare` in the standalone shipping service that estimates Econt + Speedy in parallel for one courier-neutral destination and returns sorted prices + the cheapest carrier.

**Architecture:** A new `SpeedyService.estimateShipping` (`/calculate`) mirrors Econt's existing estimate. A new small `ShippingQuoteService` (in `econt-app`) injects both services, resolves the destination per carrier (Econt: city text; Speedy: city→siteId), runs both estimates in `Promise.allSettled`, and normalizes via a pure `buildQuoteResult` helper. A new `ShippingQuoteController` exposes `/shipping/compare` (JWT + throttle, no activation gate). One additive change to Econt's `estimateShipping` (optional `weightKgOverride`) so both carriers price the same weight.

**Tech Stack:** NestJS, Drizzle, Redis cache, Speedy v1 `/calculate`, Econt `createLabel mode:calculate`, Jest.

**Spec:** `docs/superpowers/specs/2026-06-24-cheapest-courier-quote-design.md`

**Conventions (from prior rounds):**
- Money = integer stotinki (EUR cents); courier APIs use decimal EUR → ×100 on store, ÷100 on send.
- Server package is `@fermeribg/api`; compile `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`; test `pnpm --filter @fermeribg/api exec jest <pattern> --silent`.
- Pure helpers are unit-tested (TDD); service methods that only orchestrate DB+HTTP are not db-mock-tested (verified by tsc + boot smoke). Bulgarian user-facing strings.
- **v1 prices city/address level for both carriers** (no office-code dependency → both always return a price). `deliveryMode` is collected for the future create-handoff, not used in v1 pricing.
- Estimates **never throw** to the user — degrade to `null`/`available:false`.
- A few Speedy field names are docs-not-live → mark `// spike:`.

---

## File Structure

**Create:**
- `server/src/modules/econt-app/dto/compare-shipment.dto.ts`
- `server/src/modules/econt-app/shipping-quote.helpers.ts` + `shipping-quote.helpers.spec.ts`
- `server/src/modules/econt-app/shipping-quote.service.ts`
- `server/src/modules/econt-app/shipping-quote.controller.ts`

**Modify:**
- `server/src/modules/speedy/dto/speedy-credentials.dto.ts` — add optional `defaultServiceId`
- `server/src/modules/speedy/speedy.helpers.ts` — add `defaultServiceId?` to `SpeedyStored`
- `server/src/modules/speedy/speedy.service.ts` — persist `defaultServiceId` + add `estimateShipping` + constants
- `server/src/modules/econt/econt.service.ts` — add optional `weightKgOverride` to `estimateShipping` (additive)
- `server/src/modules/econt-app/econt-app.module.ts` — register quote service + controller

---

## Task 1: Speedy config — `defaultServiceId`

**Files:**
- Modify: `server/src/modules/speedy/dto/speedy-credentials.dto.ts`
- Modify: `server/src/modules/speedy/speedy.helpers.ts` (`SpeedyStored`)
- Modify: `server/src/modules/speedy/speedy.service.ts` (`saveCredentials`)

- [ ] **Step 1: Add `defaultServiceId` to the credentials DTO.**

In `speedy-credentials.dto.ts`, add this field after `clientSystemId`:
```ts
  // The producer's usual Speedy courier-service code; used as the default for
  // price estimates (the quote endpoint) when no per-shipment service is given.
  @IsOptional() @IsInt() @Min(1)
  defaultServiceId?: number;
```
Add `Min` to the `class-validator` import if not already imported (the import currently is `import { IsString, IsNotEmpty, IsIn, IsOptional, IsInt } from 'class-validator';` → add `, Min`).

- [ ] **Step 2: Add `defaultServiceId` to `SpeedyStored`.**

In `speedy.helpers.ts`, in the `SpeedyStored` interface, add after `clientSystemId?: number;`:
```ts
  defaultServiceId?: number;
```

- [ ] **Step 3: Persist it in `saveCredentials`.**

In `speedy.service.ts`, in `saveCredentials`, the `nextSpeedy` object currently spreads `clientSystemId` conditionally. Add the same treatment for `defaultServiceId`. Change the `nextSpeedy` construction so it includes:
```ts
      ...(input.clientSystemId != null ? { clientSystemId: input.clientSystemId } : {}),
      ...(input.defaultServiceId != null ? { defaultServiceId: input.defaultServiceId } : {}),
```
(Insert the `defaultServiceId` line directly after the existing `clientSystemId` spread line.)

- [ ] **Step 4: Compile.**

Run: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
Expected: 0 errors.

- [ ] **Step 5: Commit.**
```bash
git add server/src/modules/speedy/dto/speedy-credentials.dto.ts server/src/modules/speedy/speedy.helpers.ts server/src/modules/speedy/speedy.service.ts
git commit -m "feat(speedy): persist defaultServiceId for price estimates"
```
(append `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` to the body)

---

## Task 2: `SpeedyService.estimateShipping`

**Files:**
- Modify: `server/src/modules/speedy/speedy.service.ts`

- [ ] **Step 1: Add estimate constants.**

In `speedy.service.ts`, after the existing `const MAX_BULK_LABELS = 50;` line (added in a prior task), add:
```ts
// Estimate cache: Speedy pricing is stable intraday; 8h balances freshness vs.
// the latency of a live /calculate call. Weight is bucketed to 0.5kg so near-
// identical parcels reuse one entry.
const ESTIMATE_TTL = 60 * 60 * 8; // 8 hours
const WEIGHT_BUCKET_KG = 0.5;
// Fallback Speedy courier-service code when the tenant set no defaultServiceId.
// spike: confirm a valid default service id via /services/destination.
const SPEEDY_DEFAULT_SERVICE_ID = 505;
```

- [ ] **Step 2: Add the `estimateShipping` method** inside the `SpeedyService` class (place it near the other shipment methods, before the closing brace):
```ts
  /** Price-only estimate (Speedy /calculate) for a destination site + weight.
   *  City-level base shipping (no COD). Returns stotinki, or null on any failure
   *  (never throws — used by the cross-carrier quote). Cached 8h. */
  async estimateShipping(
    tenantId: string,
    input: { siteId: number; weightGrams?: number },
  ): Promise<number | null> {
    try {
      const { speedy } = await this.loadStored(tenantId);
      if (!speedy.configured || !input.siteId) return null;

      const weightKg = input.weightGrams ? input.weightGrams / 1000 : (speedy.defaultPackage?.weightKg ?? 1);
      const weightBucket = Math.ceil(weightKg / WEIGHT_BUCKET_KG) * WEIGHT_BUCKET_KG;
      const key = `speedy:estimate:${tenantId}:${input.siteId}:${weightBucket}kg`;
      const cached = await this.cache.get<number>(key);
      if (cached !== null) return cached;

      const creds = await this.resolveCreds(tenantId);
      const serviceId = speedy.defaultServiceId ?? SPEEDY_DEFAULT_SERVICE_ID;
      // Reuse the create-body builder with a placeholder receiver at the site
      // (address mode → siteId; no COD). /calculate takes the same body as /shipment.
      const body = buildShipmentRequest(speedy, {
        receiverName: '—',
        receiverPhone: '—',
        deliveryMode: 'address',
        siteId: input.siteId,
        serviceId,
        weightGrams: input.weightGrams,
      });
      // Short timeout: this runs inline behind the quote endpoint.
      const data = await this.client.call(creds, 'calculate', body, 6000);
      // spike: confirm the /calculate price field name vs live API.
      const priceEur: number | undefined = data?.price?.total ?? data?.price?.amount;
      if (typeof priceEur !== 'number') return null;
      const stotinki = Math.round(priceEur * 100);
      await this.cache.set(key, stotinki, ESTIMATE_TTL);
      return stotinki;
    } catch (err) {
      this.logger.warn(`[speedy] estimate failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }
```
NOTE: `buildShipmentRequest` is already imported in this file (added in a prior task). Its `input` parameter requires `receiverName`, `receiverPhone`, `deliveryMode`, `serviceId` — all supplied above; `siteId` and `weightGrams` are optional fields it accepts. If TS complains the literal is missing a required field, check the `ManualInput` shape in `speedy.helpers.ts` and supply it.

- [ ] **Step 3: Compile.**

Run: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
Expected: 0 errors.

- [ ] **Step 4: Commit.**
```bash
git add server/src/modules/speedy/speedy.service.ts
git commit -m "feat(speedy): estimateShipping via /calculate (cached, never-throws)"
```
(append the Co-Authored-By line)

---

## Task 3: Econt `estimateShipping` — additive `weightKgOverride`

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts` (the `estimateShipping` method, ~lines 552-607)

This is the ONLY change to shipped Econt code: a backward-compatible optional parameter so the quote can price the producer-entered weight. Existing callers pass nothing and are unaffected.

- [ ] **Step 1: Add the optional parameter to the signature.**

Find the `estimateShipping` signature:
```ts
  async estimateShipping(
    tenantId: string,
    order: {
      customerName: string | null;
      customerPhone: string | null;
      deliveryType?: string | null;
      econtOffice: string | null;
      deliveryAddress?: string | null;
      deliveryCity?: string | null;
      totalStotinki?: number | null;
    },
    items: { name: string | null; qty: number }[],
  ): Promise<number | null> {
```
Add `weightKgOverride` as a new optional last parameter:
```ts
    items: { name: string | null; qty: number }[],
    weightKgOverride?: number,
  ): Promise<number | null> {
```

- [ ] **Step 2: Use the override for the weight bucket.**

Find:
```ts
      const rawWeightKg = (econt.defaultPackage?.weightKg ?? 1);
```
Replace with:
```ts
      const rawWeightKg = weightKgOverride ?? (econt.defaultPackage?.weightKg ?? 1);
```
(The cache key derives `weightBucket` from `rawWeightKg`, so the override automatically participates in the cache key — no stale cross-contamination.)

- [ ] **Step 3: Build the label with the overridden weight.**

Find:
```ts
      const label = this.buildLabel(econt, order, items);
```
Replace with:
```ts
      // When the caller supplies a weight (the cross-carrier quote), price THAT
      // weight rather than the farm's default package — so both carriers compare
      // the same parcel. Existing callers omit it and keep today's behavior.
      const econtForLabel = weightKgOverride != null
        ? { ...econt, defaultPackage: { ...econt.defaultPackage, weightKg: weightKgOverride } }
        : econt;
      const label = this.buildLabel(econtForLabel, order, items);
```

- [ ] **Step 4: Compile.**

Run: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
Expected: 0 errors.

- [ ] **Step 5: Commit.**
```bash
git add server/src/modules/econt/econt.service.ts
git commit -m "feat(econt): optional weightKgOverride on estimateShipping (additive, for cross-carrier quote)"
```
(append the Co-Authored-By line)

---

## Task 4: Quote DTO + pure `buildQuoteResult` (TDD)

**Files:**
- Create: `server/src/modules/econt-app/dto/compare-shipment.dto.ts`
- Create: `server/src/modules/econt-app/shipping-quote.helpers.ts`
- Test: `server/src/modules/econt-app/shipping-quote.helpers.spec.ts`

- [ ] **Step 1: Create the request DTO.**

`compare-shipment.dto.ts`:
```ts
import { IsString, IsNotEmpty, IsIn, IsOptional, IsInt, Min, MaxLength } from 'class-validator';

/** Courier-neutral shipment to price across all carriers. */
export class CompareShipmentDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  destinationCity!: string;

  // Collected for the create-handoff after the producer picks a carrier; v1
  // prices at city level and does not differentiate office vs door.
  @IsIn(['office', 'address'])
  deliveryMode!: 'office' | 'address';

  @IsOptional() @IsInt() @Min(0)
  weightGrams?: number;
}
```

- [ ] **Step 2: Write the failing test** `shipping-quote.helpers.spec.ts`:
```ts
import { buildQuoteResult } from './shipping-quote.helpers';

describe('buildQuoteResult', () => {
  it('both available → sorts cheapest-first, cheapest = lower price', () => {
    const r = buildQuoteResult(450, 390);
    expect(r.quotes.map((q) => q.carrier)).toEqual(['speedy', 'econt']);
    expect(r.quotes[0]).toEqual({ carrier: 'speedy', priceStotinki: 390, available: true });
    expect(r.cheapest).toBe('speedy');
  });
  it('both available, econt cheaper → econt first', () => {
    const r = buildQuoteResult(300, 390);
    expect(r.quotes.map((q) => q.carrier)).toEqual(['econt', 'speedy']);
    expect(r.cheapest).toBe('econt');
  });
  it('only econt available → econt first + cheapest, speedy last unavailable', () => {
    const r = buildQuoteResult(450, null);
    expect(r.quotes[0].carrier).toBe('econt');
    expect(r.quotes[1]).toEqual({ carrier: 'speedy', priceStotinki: null, available: false });
    expect(r.cheapest).toBe('econt');
  });
  it('only speedy available → speedy first + cheapest', () => {
    const r = buildQuoteResult(null, 390);
    expect(r.quotes[0].carrier).toBe('speedy');
    expect(r.cheapest).toBe('speedy');
  });
  it('both unavailable → cheapest null, both available:false', () => {
    const r = buildQuoteResult(null, null);
    expect(r.cheapest).toBeNull();
    expect(r.quotes.every((q) => !q.available)).toBe(true);
  });
  it('tie → stable order (econt first), cheapest = econt', () => {
    const r = buildQuoteResult(400, 400);
    expect(r.quotes.map((q) => q.carrier)).toEqual(['econt', 'speedy']);
    expect(r.cheapest).toBe('econt');
  });
});
```

- [ ] **Step 3: Run it, confirm FAIL.**

Run: `pnpm --filter @fermeribg/api exec jest shipping-quote.helpers --silent`
Expected: FAIL — `Cannot find module './shipping-quote.helpers'`.

- [ ] **Step 4: Implement** `shipping-quote.helpers.ts`:
```ts
export type QuoteCarrier = 'econt' | 'speedy';

export interface CarrierQuote {
  carrier: QuoteCarrier;
  priceStotinki: number | null;
  available: boolean;
}

export interface QuoteResult {
  quotes: CarrierQuote[];
  cheapest: QuoteCarrier | null;
}

/**
 * Normalize two carrier estimates into a sorted result. Available carriers come
 * first (cheapest price ascending); unavailable carriers (null estimate) sort
 * last. Ties keep input order (econt before speedy) for a stable response.
 */
export function buildQuoteResult(econtStotinki: number | null, speedyStotinki: number | null): QuoteResult {
  const raw: CarrierQuote[] = [
    { carrier: 'econt', priceStotinki: econtStotinki, available: econtStotinki != null },
    { carrier: 'speedy', priceStotinki: speedyStotinki, available: speedyStotinki != null },
  ];
  const quotes = [...raw].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.available && b.available) return a.priceStotinki! - b.priceStotinki!;
    return 0; // both unavailable, or equal price → stable (input order preserved)
  });
  const cheapest = quotes[0].available ? quotes[0].carrier : null;
  return { quotes, cheapest };
}
```

- [ ] **Step 5: Run it, confirm PASS.**

Run: `pnpm --filter @fermeribg/api exec jest shipping-quote.helpers --silent`
Expected: PASS (6 tests). NOTE: `Array.prototype.sort` is stable in Node ≥ 12, so the tie/both-unavailable cases preserve econt-before-speedy.

- [ ] **Step 6: Commit.**
```bash
git add server/src/modules/econt-app/dto/compare-shipment.dto.ts server/src/modules/econt-app/shipping-quote.helpers.ts server/src/modules/econt-app/shipping-quote.helpers.spec.ts
git commit -m "feat(quote): CompareShipmentDto + pure buildQuoteResult (sort + cheapest)"
```
(append the Co-Authored-By line)

---

## Task 5: `ShippingQuoteService` + controller + wiring

**Files:**
- Create: `server/src/modules/econt-app/shipping-quote.service.ts`
- Create: `server/src/modules/econt-app/shipping-quote.controller.ts`
- Modify: `server/src/modules/econt-app/econt-app.module.ts`

- [ ] **Step 1: Create the service** `shipping-quote.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { EcontService } from '../econt/econt.service';
import { SpeedyService } from '../speedy/speedy.service';
import { CompareShipmentDto } from './dto/compare-shipment.dto';
import { buildQuoteResult, type QuoteResult } from './shipping-quote.helpers';

/**
 * Cross-carrier price comparison. Estimates Econt + Speedy in parallel for one
 * courier-neutral destination and returns sorted quotes + the cheapest carrier.
 * Each estimate degrades to null independently (never throws), so one carrier
 * being down still returns the other's price. v1 prices at city level.
 */
@Injectable()
export class ShippingQuoteService {
  constructor(
    private readonly econt: EcontService,
    private readonly speedy: SpeedyService,
  ) {}

  async compare(tenantId: string, input: CompareShipmentDto): Promise<QuoteResult> {
    const [econtRes, speedyRes] = await Promise.allSettled([
      this.econtEstimate(tenantId, input),
      this.speedyEstimate(tenantId, input),
    ]);
    const econtStotinki = econtRes.status === 'fulfilled' ? econtRes.value : null;
    const speedyStotinki = speedyRes.status === 'fulfilled' ? speedyRes.value : null;
    return buildQuoteResult(econtStotinki, speedyStotinki);
  }

  /** Econt city-level estimate (door-to-city), priced at the entered weight. */
  private async econtEstimate(tenantId: string, input: CompareShipmentDto): Promise<number | null> {
    const order = {
      customerName: '—',
      customerPhone: '—',
      // City-level estimate for both modes (no office code needed → always prices).
      deliveryType: 'econt_address' as const,
      econtOffice: null,
      deliveryAddress: input.destinationCity,
      deliveryCity: input.destinationCity,
      totalStotinki: null,
    };
    const weightKg = input.weightGrams ? input.weightGrams / 1000 : undefined;
    return this.econt.estimateShipping(tenantId, order, [], weightKg);
  }

  /** Speedy city-level estimate: resolve the typed city → siteId, then /calculate. */
  private async speedyEstimate(tenantId: string, input: CompareShipmentDto): Promise<number | null> {
    try {
      const sites = await this.speedy.searchSites(tenantId, input.destinationCity);
      const siteId = sites[0]?.id;
      if (!siteId) return null;
      return await this.speedy.estimateShipping(tenantId, { siteId, weightGrams: input.weightGrams });
    } catch {
      // searchSites throws when Speedy isn't configured for this tenant → unavailable.
      return null;
    }
  }
}
```

- [ ] **Step 2: Create the controller** `shipping-quote.controller.ts`:
```ts
import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ShippingQuoteService } from './shipping-quote.service';
import { CompareShipmentDto } from './dto/compare-shipment.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@UseGuards(JwtAuthGuard)
@Controller('shipping')
export class ShippingQuoteController {
  constructor(private readonly quote: ShippingQuoteService) {}

  // Pre-purchase price comparison — JWT only (NOT activation-gated; showing prices
  // to unactivated accounts drives conversion). Throttled — hits two courier APIs.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('compare')
  compare(@CurrentTenant() t: string, @Body() dto: CompareShipmentDto) {
    return this.quote.compare(t, dto);
  }
}
```
NOTE: `EcontStandaloneController` already uses `@Controller('shipping')`; a second controller sharing that base path is fine because the full route `POST /shipping/compare` doesn't collide with any existing route. Confirm `JwtAuthGuard` / `CurrentTenant` / `Throttle` import paths match `econt-standalone.controller.ts`.

- [ ] **Step 3: Wire into the standalone app** `econt-app.module.ts`:
- Add imports (the module file is IN `econt-app/`, so the paths are local):
```ts
import { ShippingQuoteService } from './shipping-quote.service';
import { ShippingQuoteController } from './shipping-quote.controller';
```
- Add `ShippingQuoteController` to the `controllers` array (alongside `StandaloneAuthController, EcontStandaloneController, SpeedyStandaloneController`).
- Add `ShippingQuoteService` to the `providers` array.
(`EcontCoreModule` + `SpeedyCoreModule` are already imported, so `EcontService` + `SpeedyService` resolve.)

- [ ] **Step 4: Compile.**

Run: `pnpm --filter @fermeribg/api exec tsc --noEmit -p tsconfig.json`
Expected: 0 errors.

- [ ] **Step 5: Commit.**
```bash
git add server/src/modules/econt-app/shipping-quote.service.ts server/src/modules/econt-app/shipping-quote.controller.ts server/src/modules/econt-app/econt-app.module.ts
git commit -m "feat(quote): ShippingQuoteService + /shipping/compare controller + wiring"
```
(append the Co-Authored-By line)

---

## Task 6: Final verification + boot smoke

**Files:** none (verification only).

Local infra is up (PG `127.0.0.1:5433` db/user `farmflow` pass `fermeribg`, migrations applied; Redis `127.0.0.1:6379`).

- [ ] **Step 1: Build.**

Run: `pnpm --filter @fermeribg/db build && pnpm --filter @fermeribg/api build`
Expected: both exit 0.

- [ ] **Step 2: Lint.**

Run: `pnpm --filter @fermeribg/api lint`
Expected: 0 errors. Fix any new warnings in the new files minimally.

- [ ] **Step 3: Full test suite.**

Run: `pnpm --filter @fermeribg/api test`
Expected: all suites pass, including the new `shipping-quote.helpers` (6 tests). Report totals.

- [ ] **Step 4: Boot smoke `/shipping/compare`.**

Start the standalone app in the background:
```
ENCRYPTION_KEY=test-key-please-change DATABASE_URL=postgres://farmflow:fermeribg@127.0.0.1:5433/farmflow REDIS_URL=redis://127.0.0.1:6379 JWT_SECRET=dev-secret-that-is-at-least-32chars PORT_ECONT=3100 APP_ROLE=web node server/dist/main.econt.js
```
Wait for `:3100` ready, no Nest DI errors (the graph now includes `ShippingQuoteService`/`ShippingQuoteController`). Then:
```bash
# signup → token (use a fresh email if it already exists)
curl -s -X POST http://localhost:3100/auth/signup -H 'Content-Type: application/json' \
  -d '{"email":"quote-smoke@example.com","farmName":"Quote Ферма","phone":"0888000222","password":"vremennaparola1234"}'
TOKEN=<paste token field from the JSON>
# compare on a tenant with NO courier creds → both unavailable, cheapest null, HTTP 200
curl -s -w '\nhttp=%{http_code}\n' -X POST http://localhost:3100/shipping/compare \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"destinationCity":"София","deliveryMode":"office","weightGrams":1000}'
```
Expected: `http=200` with body shape `{"quotes":[{"carrier":"econt","priceStotinki":null,"available":false},{"carrier":"speedy","priceStotinki":null,"available":false}],"cheapest":null}` (both unavailable because the fresh tenant has no Econt/Speedy credentials — proves the endpoint is mounted, JWT works, and degradation is correct). Then STOP the server.

- [ ] **Step 5: Commit any fixups** (only if steps 2/3 changed files):
```bash
git add -A && git commit -m "chore(quote): verification fixups (build + lint + boot smoke green)"
```
(append the Co-Authored-By line). If nothing changed, skip.

---

## Self-Review (completed)

**Spec coverage:**
- `POST /shipping/compare` JWT+throttle, no activation gate → Task 5 (controller) ✅
- Courier-neutral input → Task 4 (DTO) ✅
- Speedy `/calculate` estimate, cached, never-throws → Task 2 ✅
- Econt estimate reused + additive `weightKgOverride` so both price same weight → Task 3 ✅
- city→siteId resolution for Speedy; Econt city text → Task 5 (`speedyEstimate`/`econtEstimate`) ✅
- parallel `Promise.allSettled`, independent degradation, base-shipping (no COD) → Task 5 ✅
- sorted quotes + cheapest, both-unavailable→null → Task 4 (`buildQuoteResult`) ✅
- `defaultServiceId` config → Task 1 ✅

**Placeholder scan:** none — all code complete. `// spike:` tags (Speedy `/calculate` price field + default serviceId, Econt office-mode) are intentional deferred verifications, not plan placeholders. v1 sidesteps the Econt office-mode spike by pricing `econt_address` city-level.

**Type consistency:** `QuoteCarrier`/`CarrierQuote`/`QuoteResult` defined in Task 4, consumed in Task 5. `buildQuoteResult(econtStotinki, speedyStotinki)` signature matches between helper (Task 4) and service (Task 5). `SpeedyService.estimateShipping(tenantId, {siteId, weightGrams})` defined in Task 2, called in Task 5. `EcontService.estimateShipping(tenantId, order, items, weightKgOverride?)` extended in Task 3, called in Task 5 with 4 args. `defaultServiceId` field name consistent across DTO (Task 1) / SpeedyStored (Task 1) / estimate read (Task 2). `CompareShipmentDto` fields (`destinationCity`, `deliveryMode`, `weightGrams`) consistent across DTO (Task 4), service (Task 5), boot smoke (Task 6).

## Pending after this plan (out of scope)

- Smart-create with cheapest (later round).
- Spikes: Speedy `/calculate` price field + valid default `serviceId`; Econt office-mode estimate without office code (for future per-mode pricing).
- Frontend: a compare widget in the standalone shipping UI (separate plan).
