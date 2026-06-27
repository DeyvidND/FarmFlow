# Smart Carrier Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At checkout, show the customer a live Econt-vs-Speedy price comparison for door delivery (COD-aware), let them pick the cheaper carrier, persist the choice, charge the re-quoted price — and give the farm full Speedy order fulfillment (waybill, label, auto-create, tracking) so Speedy orders ship like Econt orders.

**Architecture:** A new `orders.carrier` column records the chosen courier; `deliveryType` stays the *mode* (`econt_address` = generic "до адрес"). Both carriers' `estimateShipping` become COD-aware (COD folded into the cache key + carrier payload). `ShippingQuoteService.compare` threads COD through. Checkout re-quotes the chosen carrier server-side (never trusts the client price). A new order-linked `SpeedyService.createLabelForOrder` mirrors Econt's `createLabel`; a carrier-routing dispatcher fans `autoCreateForOrder` and label-print to the right service.

**Tech Stack:** NestJS + Drizzle (Postgres), Jest, Redis (PublicCacheService), Econt + Speedy JSON APIs, Astro/React storefront (chaika + `client`).

---

## Background facts (read before starting)

- **Money is integer stotinki end-to-end.** Carriers bill in EUR (Bulgaria adopted the euro, 2026); `priceEur × 100 → stotinki`, no BGN conversion.
- **`compare` endpoint already exists**: `POST /shipping/compare` → `ShippingQuoteService.compare` → returns `{ quotes: [{carrier, priceStotinki, available}], cheapest }`. It is price-only and **not** COD-aware today.
- **Estimate caching**: both carriers cache live estimates in Redis for 8h, weight bucketed to 0.5kg. Cache keys today have **no COD dimension** — adding COD without changing the key would cross-contaminate COD and non-COD prices, so the key MUST gain a COD dimension.
- **Econt COD** is added inside `EcontService.buildLabel` when `order.paymentMethod === 'cod' && !order.paidAt && order.totalStotinki` (sets `services.cdAmount`). The price returned by `mode:'calculate'` then includes the COD service fee.
- **Speedy COD** is added inside `buildShipmentRequest` when `input.codAmountStotinki > 0` (sets `additionalServices.cod`). `/calculate` takes the same body as `/shipment`.
- **Migrations are hand-written** in this repo — `drizzle generate` is broken (snapshots stop at 0059). Latest migration is `0065`. New migration = `0066`. After writing the `.sql`, register it in `packages/db/migrations/meta/_journal.json` by appending an entry mirroring the previous one (idx, version, `when` epoch-ms, tag = filename without `.sql`).
- **Run tests** from `server/`: `cd server && npx jest <path> -t '<name>'`. The repo currently has 887 passing tests.
- **Hand-written migration gotcha**: in correlated subqueries drizzle renders bare `sql\`\`` columns unqualified — not relevant here (no such query added), but keep new SQL plain DDL.

---

## File structure

**Part 1 — comparison + pricing (customer-facing):**
- `packages/db/src/schema.ts` — add `orders.carrier` column
- `packages/db/migrations/0066_orders_carrier.sql` — new migration (+ journal entry)
- `server/src/modules/econt/econt.service.ts` — COD-aware `estimateShipping`
- `server/src/modules/speedy/speedy.service.ts` — COD-aware `estimateShipping`
- `server/src/modules/econt-app/dto/compare-shipment.dto.ts` — add `codAmountStotinki`
- `server/src/modules/econt-app/shipping-quote.service.ts` — thread COD
- `server/src/modules/orders/dto/create-order.dto.ts` — add `carrier`
- `server/src/modules/orders/delivery-pricing.ts` — `speedyEnabled`, `comparisonActive`, `courierDoorEnabled` helpers
- `server/src/modules/orders/orders.service.ts` — persist `carrier`, gate door delivery
- `server/src/modules/orders/checkout.service.ts` — re-quote by carrier in `shippingStotinki`
- storefront: chaika checkout + `client` storefront — fetch `compare`, render the two-row picker

**Part 2 — Speedy order fulfillment parity (back-office):**
- `server/src/modules/speedy/speedy.helpers.ts` — `buildOrderShipmentInput(order)` mapper
- `server/src/modules/speedy/speedy.service.ts` — `createLabelForOrder(tenantId, orderId)`
- `server/src/modules/orders/carrier-fulfillment.service.ts` — NEW dispatcher (auto-create + label routing by `orders.carrier`)
- `server/src/modules/stripe/stripe.service.ts` + `orders/orders.service.ts` — call the dispatcher instead of `econt.autoCreateForOrder` directly
- admin label-print routing (`econt`/`speedy` controllers already expose per-shipment `label.pdf`; the panel selects the endpoint by the shipment's `carrier`)

---

# PART 1 — Customer comparison + pricing

## Task 1: Add `orders.carrier` column (schema + migration)

**Files:**
- Modify: `packages/db/src/schema.ts` (orders table, near `deliveryType`)
- Create: `packages/db/migrations/0066_orders_carrier.sql`
- Modify: `packages/db/migrations/meta/_journal.json`

- [ ] **Step 1: Add the column to the Drizzle schema**

In `packages/db/src/schema.ts`, inside the `orders` table definition, add next to `deliveryType`:

```typescript
// Which courier the customer chose when both carriers were offered (door delivery
// comparison). NULL = legacy / single-carrier order; carrier inferred from deliveryType.
carrier: text('carrier'),
```

- [ ] **Step 2: Write the migration SQL**

Create `packages/db/migrations/0066_orders_carrier.sql`:

```sql
ALTER TABLE "orders" ADD COLUMN "carrier" text;
```

- [ ] **Step 3: Register the migration in the journal**

Open `packages/db/migrations/meta/_journal.json`. Copy the last `entries[]` object and append a new one incrementing `idx`, with `tag: "0066_orders_carrier"` and a `when` value one millisecond after the previous entry (any monotonically-increasing epoch-ms is fine — these are hand-written). Example shape of the appended entry:

```json
{ "idx": 66, "version": "7", "when": 1750000000001, "tag": "0066_orders_carrier", "breakpoints": true }
```

(Match `version` and field names to the existing entries exactly — do not invent fields.)

- [ ] **Step 4: Build the db package so dist types pick up the new column**

Run: `cd packages/db && npm run build`
Expected: build succeeds; `orders.carrier` appears in the emitted types.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations/0066_orders_carrier.sql packages/db/migrations/meta/_journal.json
git commit -m "feat(db): add orders.carrier column (migration 0066)"
```

---

## Task 2: Make Econt `estimateShipping` COD-aware

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts:571-639`
- Test: `server/src/modules/econt/econt.service.spec.ts` (add cases; create the file's describe block if absent)

The current `order` param has no `paymentMethod`; `buildLabel` reads `order.paymentMethod`/`order.paidAt`/`order.totalStotinki` to add COD. We add an explicit `codAmountStotinki` override that (a) feeds `buildLabel` and (b) enters the cache key.

- [ ] **Step 1: Write the failing test**

Add to `server/src/modules/econt/econt.service.spec.ts`:

```typescript
it('caches COD and non-COD estimates under different keys', async () => {
  // Two calls for the same destination+weight but different COD must NOT collide.
  const order = {
    customerName: '—', customerPhone: '—',
    deliveryType: 'econt_address' as const, econtOffice: null,
    deliveryAddress: 'Варна', deliveryCity: 'Варна', totalStotinki: null,
  };
  const plainKey = (svc as any).estimateKeyFor('t1', order, 1, 0);
  const codKey = (svc as any).estimateKeyFor('t1', order, 1, 5000);
  expect(plainKey).not.toEqual(codKey);
  expect(codKey).toContain('cod');
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd server && npx jest econt.service.spec -t 'different keys'`
Expected: FAIL — `estimateKeyFor` is not a function.

- [ ] **Step 3: Extract the cache-key builder and add the COD dimension**

In `econt.service.ts`, replace the inline key construction (lines ~598-604) by extracting a private method and calling it. Add the method:

```typescript
/** Cache key for a live estimate. COD bucketed to 10€ so COD baskets still share
 *  entries without colliding with the non-COD price for the same destination. */
private estimateKeyFor(
  tenantId: string,
  order: { deliveryType?: string | null; deliveryCity?: string | null; econtOffice: string | null },
  weightKg: number,
  codAmountStotinki: number,
): string {
  const weightBucket = this.bucketWeight(weightKg);
  const destination =
    order.deliveryType === 'econt_address'
      ? `city:${(order.deliveryCity ?? '').toLowerCase()}`
      : `office:${order.econtOffice ?? ''}`;
  const codBucket = codAmountStotinki > 0 ? Math.ceil(codAmountStotinki / 1000) * 1000 : 0;
  return `econt:estimate:${tenantId}:${destination}:${weightBucket}kg:cod${codBucket}`;
}
```

- [ ] **Step 4: Add the `codAmountStotinki` param and wire it through**

Change the `estimateShipping` signature and body (lines 571-634). Add a 5th param and use it for both the key and the label:

```typescript
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
  weightKgOverride?: number,
  codAmountStotinki?: number,            // NEW: when > 0, price WITH cash-on-delivery
): Promise<number | null> {
  try {
    const store = new Map<string, unknown>();
    const { econt } = await this.loadStored(tenantId, store);
    if (!econt.configured) return null;

    const rawWeightKg = weightKgOverride ?? (econt.defaultPackage?.weightKg ?? 1);
    const cod = codAmountStotinki ?? 0;
    const estimateKey = this.estimateKeyFor(tenantId, order, rawWeightKg, cod);

    const cachedEstimate = await this.cache.get<number>(estimateKey);
    if (cachedEstimate !== null) return cachedEstimate;

    const econtForLabel = weightKgOverride != null
      ? { ...econt, defaultPackage: { ...econt.defaultPackage, weightKg: weightKgOverride } }
      : econt;
    // Inject COD onto the order shape so buildLabel emits services.cdAmount → the
    // calculate price includes the COD fee. paidAt absent → treated as unpaid.
    const orderForLabel = cod > 0
      ? { ...order, paymentMethod: 'cod' as const, paidAt: null, totalStotinki: cod }
      : order;
    const label = this.buildLabel(econtForLabel, orderForLabel, items);
    const data = await this.callTenant(
      tenantId, 'Shipments/LabelService.createLabel.json',
      { label, mode: 'calculate' }, 6000, store,
    );
    const totalEur = data?.label?.totalPrice ?? data?.label?.totalPriceVAT;
    if (!Number.isFinite(totalEur) || totalEur <= 0) return null;
    const stotinki = Math.round(totalEur * 100);
    await this.cache.set(estimateKey, stotinki, ESTIMATE_TTL);
    return stotinki;
  } catch (err) {
    this.logger.warn(`Econt estimate failed, using flat fee: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd server && npx jest econt.service.spec -t 'different keys'`
Expected: PASS.

- [ ] **Step 6: Run the full Econt suite to confirm no regression**

Run: `cd server && npx jest econt.service.spec`
Expected: PASS (existing callers omit the new param → unchanged behavior).

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.service.spec.ts
git commit -m "feat(econt): COD-aware shipping estimate (cod in cache key + label)"
```

---

## Task 3: Make Speedy `estimateShipping` COD-aware

**Files:**
- Modify: `server/src/modules/speedy/speedy.service.ts:506-545`
- Test: `server/src/modules/speedy/speedy.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/modules/speedy/speedy.service.spec.ts`:

```typescript
it('prices COD with a distinct cache key and passes cod to the request body', async () => {
  // Arrange a configured tenant + a client.call spy returning a price.
  const call = jest.fn().mockResolvedValue({ price: { total: 5 } });
  (svc as any).client = { call };
  (svc as any).loadStored = jest.fn().mockResolvedValue({
    speedy: { configured: true, defaultServiceId: 505 },
  });
  (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });
  const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
  (svc as any).cache = cache;

  await svc.estimateShipping('t1', { siteId: 100, weightGrams: 1000, codAmountStotinki: 5000 });

  // cache key carries a cod segment
  expect(cache.set.mock.calls[0][0]).toContain('cod');
  // request body carries the COD additional service
  const body = call.mock.calls[0][2];
  expect((body as any).service?.additionalServices?.cod?.amount).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd server && npx jest speedy.service.spec -t 'prices COD'`
Expected: FAIL — `codAmountStotinki` not accepted / no cod in key or body.

- [ ] **Step 3: Add COD to the estimate**

In `speedy.service.ts`, change `estimateShipping` (506-545):

```typescript
async estimateShipping(
  tenantId: string,
  input: { siteId: number; weightGrams?: number; codAmountStotinki?: number },
): Promise<number | null> {
  try {
    const { speedy } = await this.loadStored(tenantId);
    if (!speedy.configured || !input.siteId) return null;

    const weightKg = input.weightGrams ? input.weightGrams / 1000 : (speedy.defaultPackage?.weightKg ?? 1);
    const weightBucket = Math.ceil(weightKg / WEIGHT_BUCKET_KG) * WEIGHT_BUCKET_KG;
    const cod = input.codAmountStotinki && input.codAmountStotinki > 0 ? input.codAmountStotinki : 0;
    const codBucket = cod > 0 ? Math.ceil(cod / 1000) * 1000 : 0;
    const key = `speedy:estimate:${tenantId}:${input.siteId}:${weightBucket}kg:cod${codBucket}`;
    const cached = await this.cache.get<number>(key);
    if (cached !== null) return cached;

    const creds = await this.resolveCreds(tenantId);
    const serviceId = speedy.defaultServiceId ?? SPEEDY_DEFAULT_SERVICE_ID;
    const body = buildShipmentRequest(speedy, {
      receiverName: '—',
      receiverPhone: '—',
      deliveryMode: 'address',
      siteId: input.siteId,
      serviceId,
      weightGrams: input.weightGrams,
      ...(cod > 0 ? { codAmountStotinki: cod } : {}),
    });
    const data = await this.client.call(creds, 'calculate', body, 6000);
    const priceEur: number | undefined = data?.price?.total ?? data?.price?.amount;
    if (!Number.isFinite(priceEur) || (priceEur as number) <= 0) return null;
    const stotinki = Math.round((priceEur as number) * 100);
    await this.cache.set(key, stotinki, ESTIMATE_TTL);
    return stotinki;
  } catch (err) {
    this.logger.warn(`[speedy] estimate failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd server && npx jest speedy.service.spec -t 'prices COD'`
Expected: PASS.

- [ ] **Step 5: Run the full Speedy suite**

Run: `cd server && npx jest speedy.service.spec`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/speedy/speedy.service.ts server/src/modules/speedy/speedy.service.spec.ts
git commit -m "feat(speedy): COD-aware shipping estimate"
```

---

## Task 4: Thread COD through the compare endpoint

**Files:**
- Modify: `server/src/modules/econt-app/dto/compare-shipment.dto.ts`
- Modify: `server/src/modules/econt-app/shipping-quote.service.ts`
- Test: `server/src/modules/econt-app/shipping-quote.service.spec.ts`

- [ ] **Step 1: Add `codAmountStotinki` to the DTO**

In `compare-shipment.dto.ts` add:

```typescript
// When the customer chose наложен платеж, the quote must include the COD surcharge
// so the cheaper carrier is honest. Optional; absent/0 = base price compare.
@IsOptional() @IsInt() @Min(0)
codAmountStotinki?: number;
```

- [ ] **Step 2: Write the failing test**

Add to `shipping-quote.service.spec.ts`:

```typescript
it('forwards codAmountStotinki to both carriers', async () => {
  const econt = { estimateShipping: jest.fn().mockResolvedValue(490) };
  const speedy = {
    searchSites: jest.fn().mockResolvedValue([{ id: 100, name: 'Варна' }]),
    estimateShipping: jest.fn().mockResolvedValue(420),
  };
  const svc = new ShippingQuoteService(econt as any, speedy as any);

  await svc.compare('t1', { destinationCity: 'Варна', deliveryMode: 'address', codAmountStotinki: 5000 });

  expect(econt.estimateShipping).toHaveBeenCalledWith('t1', expect.anything(), [], 1, 5000);
  expect(speedy.estimateShipping).toHaveBeenCalledWith('t1', { siteId: 100, weightGrams: 1000, codAmountStotinki: 5000 });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd server && npx jest shipping-quote.service.spec -t 'forwards cod'`
Expected: FAIL — COD not forwarded.

- [ ] **Step 4: Thread COD through `compare`**

In `shipping-quote.service.ts`, pass the COD amount into both estimates:

```typescript
async compare(tenantId: string, input: CompareShipmentDto): Promise<QuoteResult> {
  const weightGrams = input.weightGrams ?? DEFAULT_WEIGHT_GRAMS;
  const cod = input.codAmountStotinki ?? 0;
  const [econtRes, speedyRes] = await Promise.allSettled([
    this.econtEstimate(tenantId, input, weightGrams, cod),
    this.speedyEstimate(tenantId, input, weightGrams, cod),
  ]);
  const econtStotinki = econtRes.status === 'fulfilled' ? econtRes.value : null;
  const speedyStotinki = speedyRes.status === 'fulfilled' ? speedyRes.value : null;
  return buildQuoteResult(econtStotinki, speedyStotinki);
}

private async econtEstimate(tenantId: string, input: CompareShipmentDto, weightGrams: number, cod: number): Promise<number | null> {
  const order = {
    customerName: '—', customerPhone: '—',
    deliveryType: 'econt_address' as const, econtOffice: null,
    deliveryAddress: input.destinationCity, deliveryCity: input.destinationCity,
    totalStotinki: null,
  };
  return this.econt.estimateShipping(tenantId, order, [], weightGrams / 1000, cod);
}

private async speedyEstimate(tenantId: string, input: CompareShipmentDto, weightGrams: number, cod: number): Promise<number | null> {
  try {
    const sites = await this.speedy.searchSites(tenantId, input.destinationCity);
    const siteId = sites[0]?.id;
    if (!siteId) return null;
    return await this.speedy.estimateShipping(tenantId, { siteId, weightGrams, codAmountStotinki: cod });
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd server && npx jest shipping-quote.service.spec -t 'forwards cod'`
Expected: PASS.

- [ ] **Step 6: Run the suite**

Run: `cd server && npx jest shipping-quote`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/econt-app/dto/compare-shipment.dto.ts server/src/modules/econt-app/shipping-quote.service.ts server/src/modules/econt-app/shipping-quote.service.spec.ts
git commit -m "feat(shipping): COD-aware cross-carrier compare"
```

---

## Task 5: Add `carrier` to `CreateOrderDto`

**Files:**
- Modify: `server/src/modules/orders/dto/create-order.dto.ts`
- Test: covered by Task 6 integration test (no standalone test needed for a DTO field)

- [ ] **Step 1: Add the field**

In `create-order.dto.ts`, after `paymentMethod`:

```typescript
// Courier the customer picked in the door-delivery comparison. Only meaningful for
// delivery_type=econt_address (door); ignored for other modes. Validated against the
// two carriers we quote.
@ApiPropertyOptional({ enum: ['econt', 'speedy'] })
@IsOptional()
@IsEnum(['econt', 'speedy'])
carrier?: 'econt' | 'speedy';
```

- [ ] **Step 2: Confirm it compiles**

Run: `cd server && npx tsc --noEmit -p tsconfig.json`
Expected: no new type errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/orders/dto/create-order.dto.ts
git commit -m "feat(orders): accept chosen carrier on create-order"
```

---

## Task 6: Persist `carrier` + gate Speedy door delivery

**Files:**
- Modify: `server/src/modules/orders/delivery-pricing.ts` (add helpers)
- Modify: `server/src/modules/orders/orders.service.ts:319-343` (gate) and `:1174-1201` (insert)
- Test: `server/src/modules/orders/delivery-pricing.spec.ts` and `orders.service.spec.ts`

- [ ] **Step 1: Write failing helper tests**

Add to `server/src/modules/orders/delivery-pricing.spec.ts`:

```typescript
import { speedyEnabled, comparisonActive, courierDoorEnabled } from './delivery-pricing';

describe('carrier-comparison helpers', () => {
  it('speedyEnabled true only when speedy.configured', () => {
    expect(speedyEnabled({ speedy: { configured: true } } as any)).toBe(true);
    expect(speedyEnabled({ speedy: { configured: false } } as any)).toBe(false);
    expect(speedyEnabled(null)).toBe(false);
  });
  it('comparisonActive needs econt auto AND speedy configured', () => {
    expect(comparisonActive({ econt: { mode: 'auto' }, speedy: { configured: true } } as any)).toBe(true);
    expect(comparisonActive({ econt: { mode: 'manual' }, speedy: { configured: true } } as any)).toBe(false);
    expect(comparisonActive({ econt: { mode: 'auto' } } as any)).toBe(false);
  });
  it('courierDoorEnabled when econtAddress method on OR speedy configured', () => {
    expect(courierDoorEnabled({ methods: { econtAddress: { enabled: true } } } as any)).toBe(true);
    expect(courierDoorEnabled({ speedy: { configured: true } } as any)).toBe(true);
    expect(courierDoorEnabled({} as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `cd server && npx jest delivery-pricing.spec -t 'carrier-comparison'`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Add the helpers + the `speedy` field to `DeliveryConfig`**

In `delivery-pricing.ts`, extend the interface and add helpers:

```typescript
export interface DeliveryConfig {
  methods?: {
    ownSlots?: MethodConfig;
    econtOffice?: MethodConfig;
    econtAddress?: MethodConfig;
    pickup?: MethodConfig;
  };
  pricing?: { freeThresholdStotinki?: number };
  econt?: { mode?: EcontMode; configured?: boolean };
  speedy?: { configured?: boolean };          // NEW
  cod?: { enabled?: boolean };
  card?: { enabled?: boolean };
}

/** Whether Speedy live pricing/fulfillment is configured for this farm. */
export function speedyEnabled(cfg: DeliveryConfig | null | undefined): boolean {
  return !!cfg?.speedy?.configured;
}

/** Cross-carrier comparison is offered only when BOTH carriers are live. */
export function comparisonActive(cfg: DeliveryConfig | null | undefined): boolean {
  return econtMode(cfg) === 'auto' && speedyEnabled(cfg);
}

/** Door (до адрес) courier delivery is allowed when Econt door is on OR Speedy is configured. */
export function courierDoorEnabled(cfg: DeliveryConfig | null | undefined): boolean {
  return (cfg?.methods?.econtAddress?.enabled ?? false) || speedyEnabled(cfg);
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `cd server && npx jest delivery-pricing.spec -t 'carrier-comparison'`
Expected: PASS.

- [ ] **Step 5: Gate the door method by `courierDoorEnabled`**

In `orders.service.ts` `assertMethodAllowed` (319-343), change the `econt_address` allowance and validate the carrier. Replace the `allowed` map and add a carrier check:

```typescript
const allowed: Record<string, boolean> = {
  pickup: methods.pickup,
  address: deliveryEnabled && methods.ownSlots,
  econt: methods.econtOffice,
  // Door delivery is allowed when either carrier can do it (Econt door OR Speedy).
  econt_address: courierDoorEnabled(cfg),
};
if (!allowed[method]) {
  throw new BadRequestException('Избраният начин на доставка не е наличен.');
}
```

Add `courierDoorEnabled` and `speedyEnabled` to the existing import from `./delivery-pricing`.

- [ ] **Step 6: Validate carrier matches a live carrier, then persist it on insert**

Still in `orders.service.ts`, in `create()` after `assertMethodAllowed(...)`, add a carrier guard, and in the insert (`.values({...})`) persist it. First the guard (only meaningful for door):

```typescript
const cfg = (tenant.settings as { delivery?: DeliveryConfig } | null)?.delivery ?? null;
// Carrier is only carried by door delivery; default it for door when the customer
// didn't pick (single-carrier farm) to the one that's live.
let carrier: 'econt' | 'speedy' | null = null;
if (method === 'econt_address') {
  carrier = dto.carrier
    ?? (econtMode(cfg) === 'auto' ? 'econt' : speedyEnabled(cfg) ? 'speedy' : 'econt');
  if (carrier === 'speedy' && !speedyEnabled(cfg)) {
    throw new BadRequestException('Избраният куриер не е наличен.');
  }
  if (carrier === 'econt' && econtMode(cfg) === 'off') {
    throw new BadRequestException('Избраният куриер не е наличен.');
  }
}
```

Then add to the `.values({...})` object (near `econtOffice`):

```typescript
carrier,
```

(Add `econtMode` to the `./delivery-pricing` import if not already present.)

- [ ] **Step 7: Write the failing integration test for persistence**

Add to `orders.service.spec.ts` a test that a door order with `carrier: 'speedy'` on a both-carriers farm persists `carrier: 'speedy'`. Mirror the existing create-order test setup in that file (reuse its tenant/cfg fixture; set `settings.delivery = { econt: { mode: 'auto' }, speedy: { configured: true }, methods: { econtAddress: { enabled: true } } }`). Assert the inserted row's `carrier === 'speedy'`.

- [ ] **Step 8: Run to confirm pass**

Run: `cd server && npx jest orders.service.spec`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/modules/orders/delivery-pricing.ts server/src/modules/orders/delivery-pricing.spec.ts server/src/modules/orders/orders.service.ts server/src/modules/orders/orders.service.spec.ts
git commit -m "feat(orders): persist chosen carrier + allow Speedy door delivery"
```

---

## Task 7: Re-quote the chosen carrier in checkout pricing

**Files:**
- Modify: `server/src/modules/orders/checkout.service.ts:186-235`
- Test: `server/src/modules/orders/checkout.service.spec.ts`

The order shape passed to `shippingStotinki` must now carry `carrier` and the COD info. Currently it's `order` returned from `OrdersService.create` (which includes `carrier` after Task 6, plus `paymentMethod` and `totalStotinki`).

- [ ] **Step 1: Write the failing test**

Add to `checkout.service.spec.ts`:

```typescript
it('prices a Speedy door order via the Speedy estimate (COD-aware)', async () => {
  const speedy = {
    searchSites: jest.fn().mockResolvedValue([{ id: 100 }]),
    estimateShipping: jest.fn().mockResolvedValue(420),
  };
  // svc built with econt + speedy injected; cfg = both carriers live, no free threshold reached.
  const fee = await (svc as any).shippingStotinki(
    {
      tenantId: 't1', deliveryType: 'econt_address', carrier: 'speedy',
      customerName: 'x', customerPhone: 'y', econtOffice: null,
      deliveryAddress: 'ул', deliveryCity: 'Варна',
      paymentMethod: 'cod', totalStotinki: 5000,
      items: [{ productName: 'p', quantity: 1 }],
    },
    3000,
    { econt: { mode: 'auto' }, speedy: { configured: true }, pricing: { freeThresholdStotinki: 0 } },
  );
  expect(speedy.estimateShipping).toHaveBeenCalledWith('t1', { siteId: 100, weightGrams: undefined, codAmountStotinki: 5000 });
  expect(fee).toBe(420);
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `cd server && npx jest checkout.service.spec -t 'Speedy door order'`
Expected: FAIL — checkout has no Speedy path / no `SpeedyService` injected.

- [ ] **Step 3: Inject `SpeedyService` into `CheckoutService`**

In `checkout.service.ts` constructor (39-46), add:

```typescript
import { SpeedyService } from '../speedy/speedy.service';
// ...
private readonly speedy: SpeedyService,
```

Ensure `SpeedyModule` exports `SpeedyService` and `OrdersModule` (or wherever `CheckoutService` is provided) imports it. (Check the providing module's `imports`/`exports`; add if missing.)

- [ ] **Step 4: Route the door price by carrier + COD**

Extend the `shippingStotinki` param type and the Econt branch (186-235):

```typescript
private async shippingStotinki(
  order: {
    tenantId: string | null;
    deliveryType: 'pickup' | 'address' | 'econt' | 'econt_address' | null;
    carrier?: 'econt' | 'speedy' | null;
    customerName: string | null;
    customerPhone: string | null;
    econtOffice: string | null;
    deliveryAddress: string | null;
    deliveryCity: string | null;
    paymentMethod?: 'online' | 'cod' | null;
    totalStotinki?: number | null;
    items: { productName: string | null; quantity: number }[];
  },
  subtotal: number,
  preloadedCfg?: DeliveryConfig | null,
): Promise<number> {
  const method = order.deliveryType ?? 'address';
  if (method === 'pickup') return 0;

  const cfg =
    preloadedCfg !== undefined
      ? preloadedCfg
      : order.tenantId ? await this.loadDelivery(order.tenantId) : null;

  if (method === 'address') return localFeeStotinki(cfg, subtotal);

  const door = method === 'econt_address';
  // COD surcharge applies only to an unpaid наложен-платеж order.
  const cod = order.paymentMethod === 'cod' && order.totalStotinki ? order.totalStotinki : 0;

  // Speedy door delivery → live Speedy quote (city → siteId), COD-aware.
  if (door && order.carrier === 'speedy' && speedyEnabled(cfg) && order.tenantId && order.deliveryCity) {
    let live: number | null = null;
    try {
      const sites = await this.speedy.searchSites(order.tenantId, order.deliveryCity);
      const siteId = sites[0]?.id;
      if (siteId) {
        live = await this.speedy.estimateShipping(order.tenantId, {
          siteId, weightGrams: undefined, codAmountStotinki: cod,
        });
      }
    } catch { live = null; }
    const fee = live ?? econtFallbackFee(cfg, true);
    return applyFreeThreshold(fee, subtotal, freeThresholdStotinki(cfg));
  }

  // Econt (office or door) — live quote in auto mode, COD-aware; else flat fallback.
  let fee: number;
  if (econtMode(cfg) === 'auto' && order.tenantId) {
    const live = await this.econt.estimateShipping(
      order.tenantId,
      order,
      order.items.map((i) => ({ name: i.productName, qty: i.quantity })),
      undefined,
      cod,
    );
    fee = live ?? econtFallbackFee(cfg, door);
  } else {
    fee = econtFallbackFee(cfg, door);
  }
  return applyFreeThreshold(fee, subtotal, freeThresholdStotinki(cfg));
}
```

Add `speedyEnabled` to the `./delivery-pricing` import.

- [ ] **Step 5: Run to confirm pass**

Run: `cd server && npx jest checkout.service.spec -t 'Speedy door order'`
Expected: PASS.

- [ ] **Step 6: Run the checkout suite**

Run: `cd server && npx jest checkout.service.spec`
Expected: PASS (Econt + COD-null paths unchanged — `cod` defaults to 0, matching prior behavior).

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/orders/checkout.service.ts server/src/modules/orders/checkout.service.spec.ts
git commit -m "feat(checkout): re-quote chosen carrier server-side (Speedy door + COD)"
```

---

## Task 8: Storefront — fetch compare + render the two-row picker

> The repo has two storefronts: the shared Astro `client` (in this repo) and the third-party **chaika** storefront (separate repo). This task covers the in-repo `client`; replicate the same UI in chaika as a follow-up commit there. Verify with the preview tools.

**Files (in-repo `client`):**
- Modify: `client/src/lib/delivery-data.ts` (types: add `speedyConfigured`, `comparisonActive`)
- Modify: the checkout component that renders delivery options (search: `grep -rl 'deliveryType' client/src` → the checkout form)
- Modify: `client/src/lib/shipping.ts` (display fee uses chosen carrier price when comparison active)

- [ ] **Step 1: Find the checkout delivery UI**

Run: `cd .. && grep -rln "econt_address" client/src`
Read the component that lets the customer choose delivery type. Identify where door delivery (`econt_address`) is selected and where city/address + payment method are known.

- [ ] **Step 2: Add a compare fetch when door + city + payment are known**

When delivery type is door (`econt_address`), the customer has entered a city, and a payment method is chosen, POST to the API compare endpoint:

```typescript
// types: { quotes: {carrier:'econt'|'speedy'; priceStotinki:number|null; available:boolean}[]; cheapest: 'econt'|'speedy'|null }
async function fetchCompare(city: string, weightGrams: number, codAmountStotinki: number) {
  const res = await fetch(`${API_BASE}/shipping/compare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader },
    body: JSON.stringify({ destinationCity: city, deliveryMode: 'address', weightGrams, codAmountStotinki }),
  });
  if (!res.ok) return null;
  return res.json();
}
```

NOTE: `POST /shipping/compare` is JWT-guarded (it's the admin/import endpoint). For the public storefront, add a **public** compare route (see Step 5) and call that instead. Use `codAmountStotinki = paymentMethod === 'cod' ? cartTotalStotinki : 0`.

- [ ] **Step 3: Render the picker**

When `comparisonActive` and not free-over-threshold, render two selectable rows from `quotes`, pre-select `cheapest`, badge the cheaper "Най-евтин", and when COD show the footnote:

```tsx
{quotes.filter(q => q.available).map(q => (
  <label key={q.carrier} className="carrier-row">
    <input type="radio" name="carrier" value={q.carrier}
           checked={carrier === q.carrier} onChange={() => setCarrier(q.carrier)} />
    <span>{q.carrier === 'speedy' ? 'Спиди' : 'Еконт'}</span>
    <span>{(q.priceStotinki! / 100).toFixed(2)} лв</span>
    {q.carrier === cheapest && <span className="badge">Най-евтин</span>}
  </label>
))}
{isCod && <p className="hint">Цената включва такса наложен платеж.</p>}
```

When the order is free-over-threshold, show "Безплатна доставка" and hide the rows. When only one carrier is `available`, show that single row, no badge.

- [ ] **Step 4: Send the chosen carrier on order create**

Include `carrier` in the create-order POST body (the value of the selected radio). Default to `cheapest` if the user didn't change it.

- [ ] **Step 5: Add a PUBLIC compare route for the storefront**

The existing `/shipping/compare` is JWT-only. Add a public, slug-scoped, throttled endpoint so an anonymous shopper can get quotes. In the public storefront controller (search: `grep -rln "@Controller('public" server/src`), add:

```typescript
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@HttpCode(200)
@Post(':slug/shipping/compare')
async compare(@Param('slug') slug: string, @Body() dto: CompareShipmentDto) {
  const tenantId = await this.tenants.idForSlug(slug);   // reuse the existing slug→id resolver
  return this.quote.compare(tenantId, dto);
}
```

Gate it so it only quotes when `comparisonActive(cfg)` — otherwise return `{ quotes: [], cheapest: null }` so the storefront falls back to the single-carrier flat fee. Add a unit test for the gating.

- [ ] **Step 6: Verify in the preview**

Start the dev server (preview_start), open checkout, choose door delivery, enter a city, toggle COD, and confirm: two rows render, cheaper is badged + pre-selected, COD footnote appears, and switching payment re-fetches. Capture a screenshot.

- [ ] **Step 7: Commit**

```bash
git add client/src server/src
git commit -m "feat(storefront): carrier comparison picker at checkout + public compare route"
```

---

# PART 2 — Speedy order fulfillment parity

## Task 9: Map an order → Speedy shipment input

**Files:**
- Modify: `server/src/modules/speedy/speedy.helpers.ts`
- Test: `server/src/modules/speedy/speedy.helpers.spec.ts`

`createManualShipment` already builds a body from a `ManualInput` (receiverName/phone, deliveryMode, siteId/officeId, weightGrams, contents, codAmountStotinki). We need a mapper from an order row + its tenant Speedy config to that input, for door delivery.

- [ ] **Step 1: Write the failing test**

Add to `speedy.helpers.spec.ts`:

```typescript
import { buildOrderShipmentInput } from './speedy.helpers';

it('maps a door order to a Speedy shipment input with COD when unpaid cod', () => {
  const input = buildOrderShipmentInput(
    { configured: true, defaultServiceId: 505, defaultPackage: { weightKg: 1.5 } } as any,
    {
      customerName: 'Иван', customerPhone: '0888', deliveryAddress: 'ул. Шипка 5',
      paymentMethod: 'cod', paidAt: null, totalStotinki: 5000,
    } as any,
    100, // resolved siteId
  );
  expect(input.deliveryMode).toBe('address');
  expect(input.siteId).toBe(100);
  expect(input.weightGrams).toBe(1500);
  expect(input.codAmountStotinki).toBe(5000);
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `cd server && npx jest speedy.helpers.spec -t 'maps a door order'`
Expected: FAIL — `buildOrderShipmentInput` undefined.

- [ ] **Step 3: Implement the mapper**

In `speedy.helpers.ts` add:

```typescript
/** Map a storefront order (door delivery) + resolved siteId → Speedy shipment input.
 *  COD is collected only on an unpaid наложен-платеж order (mirror Econt's gate). */
export function buildOrderShipmentInput(
  cfg: SpeedyStored,
  order: {
    customerName: string | null;
    customerPhone: string | null;
    deliveryAddress: string | null;
    paymentMethod?: 'online' | 'cod' | null;
    paidAt?: Date | null;
    totalStotinki?: number | null;
  },
  siteId: number,
): ManualInput {
  const collectCod = order.paymentMethod === 'cod' && !order.paidAt && !!order.totalStotinki;
  const weightKg = cfg.defaultPackage?.weightKg ?? 1;
  return {
    receiverName: order.customerName ?? '—',
    receiverPhone: order.customerPhone ?? '—',
    deliveryMode: 'address',
    siteId,
    serviceId: cfg.defaultServiceId,
    weightGrams: Math.round(weightKg * 1000),
    contents: cfg.defaultPackage?.contents,
    ...(collectCod ? { codAmountStotinki: order.totalStotinki! } : {}),
  };
}
```

(Confirm `ManualInput` already has these fields — it does: `receiverName`, `receiverPhone`, `deliveryMode`, `siteId`, `serviceId`, `weightGrams`, `contents`, `codAmountStotinki`. If `contents`/`serviceId` are not on `ManualInput`, add them as optional.)

- [ ] **Step 4: Run to confirm pass**

Run: `cd server && npx jest speedy.helpers.spec -t 'maps a door order'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/speedy/speedy.helpers.ts server/src/modules/speedy/speedy.helpers.spec.ts
git commit -m "feat(speedy): order→shipment input mapper"
```

---

## Task 10: `SpeedyService.createLabelForOrder`

**Files:**
- Modify: `server/src/modules/speedy/speedy.service.ts`
- Test: `server/src/modules/speedy/speedy.service.spec.ts`

Mirror Econt's `createLabel(tenantId, orderId)`: resolve the order, resolve the destination siteId from `order.deliveryCity`, create the waybill, upsert a `shipments` row keyed on `orderId`.

- [ ] **Step 1: Write the failing test**

Add to `speedy.service.spec.ts`:

```typescript
it('createLabelForOrder upserts an order-linked Speedy shipment', async () => {
  // order with door delivery + city; speedy configured.
  const call = jest.fn().mockResolvedValue({ id: 'S1', parcels: [{ barcode: 'BC1' }], price: { total: 4.2 } });
  (svc as any).client = { call };
  (svc as any).resolveCreds = jest.fn().mockResolvedValue({ base: 'x', userName: 'u', password: 'p' });
  (svc as any).loadStored = jest.fn().mockResolvedValue({ speedy: { configured: true, defaultServiceId: 505 } });
  (svc as any).searchSites = jest.fn().mockResolvedValue([{ id: 100 }]);
  (svc as any).orderForShipment = jest.fn().mockResolvedValue({
    tenantId: 't1', deliveryCity: 'Варна', customerName: 'И', customerPhone: '0888',
    deliveryAddress: 'ул', paymentMethod: 'cod', paidAt: null, totalStotinki: 5000,
  });
  // db.insert(...).values(...).onConflictDoUpdate(...).returning() mock returns a row
  const row = await svc.createLabelForOrder('t1', 'order-1');
  expect(call).toHaveBeenCalledWith(expect.anything(), 'shipment', expect.anything());
  expect(row.carrier).toBe('speedy');
});
```

(Reuse the db-mock pattern already present in `speedy.service.spec.ts` for `createManualShipment`.)

- [ ] **Step 2: Run to confirm fail**

Run: `cd server && npx jest speedy.service.spec -t 'createLabelForOrder'`
Expected: FAIL — method undefined.

- [ ] **Step 3: Implement `createLabelForOrder` + a small `orderForShipment`**

Add to `speedy.service.ts`. First a private order loader (mirrors Econt's), then the public method:

```typescript
/** Load the order fields a Speedy waybill needs (tenant-scoped). */
private async orderForShipment(tenantId: string, orderId: string) {
  const [row] = await this.db
    .select({
      tenantId: orders.tenantId,
      deliveryCity: orders.deliveryCity,
      deliveryAddress: orders.deliveryAddress,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      paymentMethod: orders.paymentMethod,
      paidAt: orders.paidAt,
      totalStotinki: orders.totalStotinki,
    })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new NotFoundException('Поръчката не е намерена');
  return row;
}

/** Create an order-linked Speedy waybill + upsert the shipments row (one per order). */
async createLabelForOrder(tenantId: string, orderId: string): Promise<typeof shipments.$inferSelect> {
  const { speedy } = await this.loadStored(tenantId);
  if (!speedy.configured) throw new BadRequestException('Speedy не е конфигуриран за тази ферма');
  const order = await this.orderForShipment(tenantId, orderId);
  const sites = await this.searchSites(tenantId, order.deliveryCity ?? '');
  const siteId = sites[0]?.id;
  if (!siteId) throw new BadRequestException('Населеното място не е намерено в Speedy');

  const creds = await this.resolveCreds(tenantId);
  const input = buildOrderShipmentInput(speedy, order, siteId);
  const body = buildShipmentRequest(speedy, input);
  const data = await this.client.call(creds, 'shipment', body);

  const shipmentId: string | null = data?.id != null ? String(data.id) : null;
  const parcels: any[] = Array.isArray(data?.parcels) ? data.parcels : [];
  const barcode: string | null = parcels.length ? String(parcels[0]?.barcode ?? parcels[0]?.id ?? '') || null : null;
  const priceEur: number | undefined = data?.price?.total ?? data?.price?.amount;
  const codAmount = input.codAmountStotinki && input.codAmountStotinki > 0 ? Math.round(input.codAmountStotinki) : null;

  const [row] = await this.db
    .insert(shipments)
    .values({
      tenantId,
      orderId,
      carrier: 'speedy',
      carrierShipmentId: shipmentId,
      trackingNumber: barcode,
      status: barcode ? 'created' : 'pending',
      courierPriceStotinki: typeof priceEur === 'number' ? Math.round(priceEur * 100) : null,
      codAmountStotinki: codAmount,
      trackingJson: data ?? null,
      deliveryMode: 'address',
    })
    .onConflictDoUpdate({
      target: shipments.orderId,
      set: {
        carrier: 'speedy',
        carrierShipmentId: shipmentId,
        trackingNumber: barcode,
        status: barcode ? 'created' : 'pending',
        courierPriceStotinki: typeof priceEur === 'number' ? Math.round(priceEur * 100) : null,
        codAmountStotinki: codAmount,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}
```

Add `orders` and `and`, `eq` to the imports at the top of `speedy.service.ts` (`orders` from `@fermeribg/db`; `and`/`eq` already imported), and `buildOrderShipmentInput` to the `./speedy.helpers` import.

- [ ] **Step 4: Run to confirm pass**

Run: `cd server && npx jest speedy.service.spec -t 'createLabelForOrder'`
Expected: PASS.

- [ ] **Step 5: Expose an order-label endpoint on the Speedy controller**

In `speedy-standalone.controller.ts`, mirror Econt's `@Post('shipments/:orderId')`. Add (activation-gated):

```typescript
@UseGuards(ActivationGuard)
@Post('orders/:orderId/label')
createForOrder(@CurrentTenant() t: string, @Param('orderId', ParseUUIDPipe) orderId: string) {
  return this.speedy.createLabelForOrder(t, orderId);
}
```

- [ ] **Step 6: Run the suite + commit**

Run: `cd server && npx jest speedy.service.spec`
Expected: PASS.

```bash
git add server/src/modules/speedy/speedy.service.ts server/src/modules/speedy/speedy.service.spec.ts server/src/modules/speedy/speedy-standalone.controller.ts
git commit -m "feat(speedy): order-linked waybill creation + endpoint"
```

---

## Task 11: Carrier-routing dispatcher for auto-create

**Files:**
- Create: `server/src/modules/orders/carrier-fulfillment.service.ts`
- Modify: `server/src/modules/stripe/stripe.service.ts:744`, `server/src/modules/orders/orders.service.ts:697,923`
- Test: `server/src/modules/orders/carrier-fulfillment.service.spec.ts`

Today `autoCreateForOrder` is Econt-only. The dispatcher reads `orders.carrier` + `deliveryType` and routes to the right carrier's auto-create.

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/orders/carrier-fulfillment.service.spec.ts`:

```typescript
import { CarrierFulfillmentService } from './carrier-fulfillment.service';

describe('CarrierFulfillmentService', () => {
  const order = (carrier: string | null, dt = 'econt_address') =>
    ({ carrier, deliveryType: dt, tenantId: 't1' });

  it('routes speedy door orders to speedy auto-create', async () => {
    const econt = { autoCreateForOrder: jest.fn() };
    const speedy = { autoCreateForOrder: jest.fn() };
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: () => [order('speedy')] }) }) }) };
    const svc = new CarrierFulfillmentService(db as any, econt as any, speedy as any);
    await svc.autoCreateForOrder('o1');
    expect(speedy.autoCreateForOrder).toHaveBeenCalledWith('o1');
    expect(econt.autoCreateForOrder).not.toHaveBeenCalled();
  });

  it('routes econt/null-carrier door orders to econt', async () => {
    const econt = { autoCreateForOrder: jest.fn() };
    const speedy = { autoCreateForOrder: jest.fn() };
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: () => [order(null)] }) }) }) };
    const svc = new CarrierFulfillmentService(db as any, econt as any, speedy as any);
    await svc.autoCreateForOrder('o1');
    expect(econt.autoCreateForOrder).toHaveBeenCalledWith('o1');
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `cd server && npx jest carrier-fulfillment.service.spec`
Expected: FAIL — module not found.

- [ ] **Step 3: Add a Speedy `autoCreateForOrder` (best-effort, idempotent)**

In `speedy.service.ts`, mirror Econt's `autoCreateForOrder` (guards on `speedy.label?.autoCreate`, skips if a shipment with a `trackingNumber`/`carrierShipmentId` already exists for the order):

```typescript
async autoCreateForOrder(orderId: string): Promise<void> {
  try {
    const [order] = await this.db
      .select({ tenantId: orders.tenantId, deliveryType: orders.deliveryType })
      .from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order?.tenantId || order.deliveryType !== 'econt_address') return;
    const { speedy } = await this.loadStored(order.tenantId);
    const autoCreate = (speedy as any).label?.autoCreate;
    if (!speedy.configured || autoCreate !== true) return;
    const [existing] = await this.db
      .select({ id: shipments.carrierShipmentId })
      .from(shipments).where(eq(shipments.orderId, orderId)).limit(1);
    if (existing?.id) return;
    await this.createLabelForOrder(order.tenantId, orderId);
    this.logger.log(`[speedy] auto-created waybill for order ${orderId}`);
  } catch (err) {
    this.logger.warn(`[speedy] auto-create failed for order ${orderId}: ${err instanceof Error ? err.message : err}`);
  }
}
```

- [ ] **Step 4: Implement the dispatcher**

Create `carrier-fulfillment.service.ts`:

```typescript
import { Injectable, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Database, orders } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EcontService } from '../econt/econt.service';
import { SpeedyService } from '../speedy/speedy.service';

/** Routes order fulfillment (auto-create waybill) to the carrier the customer chose.
 *  Door orders with carrier='speedy' go to Speedy; everything else stays on Econt
 *  (its autoCreateForOrder already no-ops for non-Econt delivery types). */
@Injectable()
export class CarrierFulfillmentService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly econt: EcontService,
    private readonly speedy: SpeedyService,
  ) {}

  async autoCreateForOrder(orderId: string): Promise<void> {
    const [row] = await this.db
      .select({ carrier: orders.carrier })
      .from(orders).where(eq(orders.id, orderId)).limit(1);
    if (row?.carrier === 'speedy') {
      await this.speedy.autoCreateForOrder(orderId);
      return;
    }
    await this.econt.autoCreateForOrder(orderId);
  }
}
```

Provide it from the module that wires Econt+Speedy (the same module that provides `CheckoutService`); export it where `StripeService`/`OrdersService` can inject it.

- [ ] **Step 5: Swap the three call sites to use the dispatcher**

Replace `this.econt.autoCreateForOrder(id)` with `this.carrierFulfillment.autoCreateForOrder(id)` at:
- `stripe.service.ts:744` (inject `CarrierFulfillmentService`)
- `orders.service.ts:697` and `:923`

Update the three call sites' specs (`stripe.service.spec.ts` mocks `econt.autoCreateForOrder` — change to mock the dispatcher, or provide a stub dispatcher whose `autoCreateForOrder` is a jest.fn()).

- [ ] **Step 6: Run the affected suites**

Run: `cd server && npx jest carrier-fulfillment.service.spec stripe.service.spec speedy.service.spec`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/orders/carrier-fulfillment.service.ts server/src/modules/orders/carrier-fulfillment.service.spec.ts server/src/modules/speedy/speedy.service.ts server/src/modules/stripe/stripe.service.ts server/src/modules/orders/orders.service.ts server/src/modules/stripe/stripe.service.spec.ts
git commit -m "feat(orders): carrier-routed auto-create (Econt/Speedy)"
```

---

## Task 12: Admin label-print routing by carrier

**Files:**
- Modify: the admin Доставки/Пратки panel (search the admin app for the Econt `shipments/:id/label.pdf` link)
- No server change needed: Econt exposes `GET /econt/shipments/:id/label.pdf`; Speedy exposes `GET /speedy/shipments/:id/label.pdf`. Both order-linked and manual shipments carry `carrier`.

- [ ] **Step 1: Find the print/label link in the admin UI**

Run: `cd .. && grep -rln "label.pdf" admin/src client/src`
Read the component that renders the print button for a shipment row.

- [ ] **Step 2: Choose the endpoint by the row's `carrier`**

```typescript
const labelUrl = (s: { id: string; carrier: 'econt' | 'speedy' | null }) =>
  s.carrier === 'speedy'
    ? `${API_BASE}/speedy/shipments/${s.id}/label.pdf`
    : `${API_BASE}/econt/shipments/${s.id}/label.pdf`;
```

Ensure the shipments list the panel renders includes `carrier` (the shipments table already has it; confirm the list query selects it — add `carrier: shipments.carrier` to the select if missing).

- [ ] **Step 3: Verify in the preview**

Render a Speedy order shipment, click print, confirm the Speedy label PDF streams. Capture a screenshot.

- [ ] **Step 4: Commit**

```bash
git add admin/src client/src server/src
git commit -m "feat(admin): route label print to the shipment's carrier"
```

---

## Task 13: Full suite + manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full server test suite**

Run: `cd server && npx jest`
Expected: all green (≥ 887 + the new tests).

- [ ] **Step 2: Type-check**

Run: `cd server && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Manual E2E on a both-carriers demo tenant**

Configure a demo tenant with Econt `mode=auto` + Speedy configured. Place a door order via the storefront with COD:
- comparison shows two prices, cheaper badged + pre-selected
- pick Speedy, place order → order persists `carrier='speedy'`, total folds the Speedy re-quote
- in admin, create the Speedy waybill for the order (or rely on auto-create on paid), print the label
- confirm the shipment shows under the tenant and tracking refresh picks it up (Speedy cron `refreshActiveShipments` already runs)

- [ ] **Step 4: Commit any fixups, then finish the branch**

Use `superpowers:finishing-a-development-branch` to open the PR. Include the deploy note below.

---

## Deploy notes (carry into the PR description)

- **Migration 0066** must run before/with the redeploy (adds `orders.carrier`).
- Affected deployables: the API server, the in-repo `client` storefront, the admin panel, and the **chaika** storefront (separate repo — replicate the Task 8 UI there).
- Feature is dark for single-carrier farms: `comparisonActive` is false unless a farm has BOTH Econt `auto` and Speedy configured, so existing farms see no change.
- Add a per-tenant Speedy `label.autoCreate` toggle in the delivery settings UI if you want Speedy waybills auto-created on paid orders (parity with Econt); otherwise farms create Speedy labels manually from the panel.
