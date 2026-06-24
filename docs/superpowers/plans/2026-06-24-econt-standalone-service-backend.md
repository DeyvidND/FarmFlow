# Standalone Econt Service — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend of a standalone self-service Econt shipping app for producers — a second NestJS bootstrap on its own port (3100), sharing FarmFlow's Postgres + `EcontService`, exposing standalone signup/login, order-less shipment creation, address validation, courier-pickup requests, sender auto-fill, print/track/COD — gated behind a one-time activation flag.

**Architecture:** Reuse-first. New code lives in `server/src/modules/econt-app/` plus additive methods on the existing `EcontService`. A new `EcontAppModule` + `main.econt.ts` boot a second app from the same image on port 3100. No package extraction, no new DB, no change to FarmFlow's shipped A–C integration. Order-less shipments are made possible by one migration (`shipments.orderId` nullable + receiver/courier columns).

**Tech Stack:** NestJS, Drizzle ORM (`@fermeribg/db`), Postgres, BullMQ/Redis, argon2, JWT (HS256), Jest. Spec: `docs/superpowers/specs/2026-06-24-econt-standalone-service-design.md`.

**Conventions (read before starting):**
- Work on branch `feat/econt-standalone-service` (already created). `main` auto-deploys.
- Build order for the API: `pnpm --filter @fermeribg/db build && pnpm --filter @fermeribg/types build` before the server build.
- Run server tests: `pnpm --filter @fermeribg/api test`. Typecheck/build: `pnpm --filter @fermeribg/api build`.
- Money is integer stotinki (EUR cents). UI strings Bulgarian.
- Follow the existing `econt.service.spec.ts` style: extract logic into **pure exported functions**, unit-test those; keep I/O methods thin.

---

## File structure

**Modify:**
- `packages/db/src/schema.ts` — `shipments`: `orderId` nullable + new receiver/courier columns.
- `server/src/modules/econt/econt.service.ts` — add pure helpers + new methods (`getClientProfiles`, `validateAddress`, `createManualShipment`, `requestCourier`, `getRequestCourierStatus`); extend `buildLabel` with optional service flags.
- `server/src/modules/econt/econt.service.spec.ts` — tests for the new pure helpers + `buildLabel` flags.
- `server/src/modules/platform/platform.service.ts` + `platform.controller.ts` — super-admin activate endpoint.
- `server/src/modules/platform/platform.service.spec.ts` — test the settings merger.
- `server/package.json` — `start:econt` script.

**Create:**
- `packages/db/migrations/0055_*.sql` — generated.
- `server/src/modules/econt/dto/manual-shipment.dto.ts`
- `server/src/modules/econt/dto/validate-address.dto.ts`
- `server/src/modules/econt/dto/courier-request.dto.ts`
- `server/src/modules/econt-app/econt-app.helpers.ts` (+ `.spec.ts`)
- `server/src/modules/econt-app/dto/signup.dto.ts`
- `server/src/modules/econt-app/standalone-auth.service.ts`
- `server/src/modules/econt-app/standalone-auth.controller.ts`
- `server/src/modules/econt-app/activation.guard.ts`
- `server/src/modules/econt-app/econt-standalone.controller.ts`
- `server/src/modules/econt-app/econt-app.module.ts`
- `server/src/main.econt.ts`

---

## Task 1: Data model — order-less shipments (migration 0055)

**Files:**
- Modify: `packages/db/src/schema.ts:368-393` (shipments table)
- Create: `packages/db/migrations/0055_*.sql` (generated)

- [ ] **Step 1: Make `orderId` nullable + add receiver/courier columns**

In `packages/db/src/schema.ts`, change the `orderId` definition and add new columns inside the `shipments` table body (after `codSettledAt`, before `createdAt`):

```ts
    orderId: uuid('order_id').references(() => orders.id),
```
(remove the `.notNull()` — an order-less standalone shipment has no order)

Add these columns:

```ts
    // --- Standalone (order-less) shipments: a producer types the receiver in by
    // hand via the standalone Econt app, so there is no `orders` row to derive
    // from. NULL for FarmFlow shipments (which keep deriving from `orders`). ---
    receiverName: text('receiver_name'),
    receiverPhone: text('receiver_phone'),
    deliveryMode: text('delivery_mode'), // 'office' | 'address'
    receiverOfficeCode: text('receiver_office_code'),
    receiverCity: text('receiver_city'),
    receiverAddress: text('receiver_address'),
    weightKg: numeric('weight_kg'),
    contents: text('contents'),
    // Econt courier-pickup request lifecycle (requestCourier / getRequestCourierStatus).
    courierRequestId: text('courier_request_id'),
    courierRequestStatus: text('courier_request_status'),
```

Confirm `numeric` and `text` are already imported at the top of `schema.ts` (they are — `farmLat`/`farmLng` use `numeric`, most columns use `text`).

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @fermeribg/db generate`
Expected: a new file `packages/db/migrations/0055_*.sql` is created.

- [ ] **Step 3: Verify the generated SQL**

Open the new `0055_*.sql`. It MUST contain:
- `ALTER TABLE "shipments" ALTER COLUMN "order_id" DROP NOT NULL;`
- `ALTER TABLE "shipments" ADD COLUMN "receiver_name" text;` (and the other 9 columns)

If `DROP NOT NULL` is missing, the nullable change didn't register — re-check Step 1. No data backfill is needed (existing rows already have an `order_id`).

- [ ] **Step 4: Build the db package to verify types**

Run: `pnpm --filter @fermeribg/db build`
Expected: clean build (no TS errors).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations
git commit -m "feat(db): shipments order-less support — orderId nullable + receiver/courier cols (migration 0055)"
```

---

## Task 2: `buildLabel` optional service flags (SMS / refrigerated / declared value)

`buildLabel` already assembles `label.services` only inside the COD branch. Restructure so a `services` object can also carry SMS notification, a refrigerated-pack flag, and a declared value — emitted only when set. Keep the COD-only output identical (existing tests must still pass).

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts` (`buildLabel`, ~lines 418-507; the `order` param type)
- Test: `server/src/modules/econt/econt.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

In `econt.service.spec.ts`, inside the existing `describe('EcontService.buildLabel', ...)` block (after the last `it`), add:

```ts
  it('emits SMS + refrigerated + declared-value services when set', () => {
    const label = build(
      { sender, defaultPackage: { weightKg: 1 } },
      {
        customerName: 'Х', customerPhone: '0', deliveryType: 'econt', econtOffice: '1',
        totalStotinki: 1000, paymentMethod: 'cod',
        smsNotification: true, refrigerated: true, declaredValueStotinki: 5000,
      },
    );
    expect(label.services).toMatchObject({
      cdAmount: 10, cdType: 'get', cdCurrency: 'EUR',
      smsNotification: true,
      refrigeratedPack: 1,
      declaredValueAmount: 50,
      declaredValueCurrency: 'EUR',
    });
  });

  it('no flags + no COD → no services object at all', () => {
    const label = build(
      { sender, defaultPackage: { weightKg: 1 } },
      { customerName: 'Х', customerPhone: '0', deliveryType: 'econt', econtOffice: '1', totalStotinki: 1000, paymentMethod: 'online' },
    );
    expect(label.services).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @fermeribg/api test -- econt.service.spec`
Expected: FAIL — `smsNotification` etc. not present on `label.services` (currently undefined for the online case is fine, but the COD+flags case fails).

- [ ] **Step 3: Implement**

In `econt.service.ts`, extend the `order` param type of `buildLabel` (the inline object type around line 419-430) by adding these optional fields:

```ts
      smsNotification?: boolean | null;
      refrigerated?: boolean | null;
      declaredValueStotinki?: number | null;
```

Then replace the COD block (the `const collectCod = ...` through the closing of the `if (collectCod ...)` block, ~lines 478-494) with a single assembled `services` object:

```ts
    // Assemble optional label `services` (COD + SMS + refrigerated + declared value).
    // Emitted only when at least one service applies, so a plain shipment sends no
    // `services` key (keeps the Econt payload minimal + existing tests stable).
    const services: Record<string, unknown> = {};

    // Cash on delivery: collect the order total from the customer (app currency = EUR).
    // Keyed on the ORDER's own payment choice, never on an order already paid online,
    // so a paid Econt order can't be charged a second time at the door.
    const collectCod = order.paymentMethod === 'cod' && !order.paidAt;
    if (collectCod && order.totalStotinki) {
      services.cdAmount = Math.round(order.totalStotinki) / 100;
      services.cdType = 'get';
      services.cdCurrency = 'EUR';
      // Who covers the courier fee on a COD shipment (top-level fields).
      if (econt.cod?.feePayer === 'customer') {
        label.paymentReceiverMethod = 'cash';
      } else if (econt.cod?.feePayer === 'farm') {
        label.paymentSenderMethod = 'cash';
      }
    }

    // SMS to the receiver on the way / on delivery.
    if (order.smsNotification) services.smsNotification = true;
    // Refrigerated/perishable handling (Econt `refrigeratedPack` is an int count).
    if (order.refrigerated) services.refrigeratedPack = 1;
    // Declared value / insurance (обявена стойност), in EUR.
    if (order.declaredValueStotinki && order.declaredValueStotinki > 0) {
      services.declaredValueAmount = Math.round(order.declaredValueStotinki) / 100;
      services.declaredValueCurrency = 'EUR';
    }

    if (Object.keys(services).length) label.services = services;
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @fermeribg/api test -- econt.service.spec`
Expected: PASS — both new tests pass AND the pre-existing COD tests (which assert `label.services` `toEqual({ cdAmount, cdType, cdCurrency })`) still pass, because no flags are set in those cases.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.service.spec.ts
git commit -m "feat(econt): buildLabel optional services — SMS / refrigerated / declared value"
```

---

## Task 3: Manual (order-less) shipment shape + `createManualShipment`

Extract a pure function that turns hand-entered receiver input into the order-like object `buildLabel` consumes, then add a thin `createManualShipment` that calls Econt and persists a shipment with `orderId = null`.

**Files:**
- Create: `server/src/modules/econt/dto/manual-shipment.dto.ts`
- Modify: `server/src/modules/econt/econt.service.ts`
- Test: `server/src/modules/econt/econt.service.spec.ts`

- [ ] **Step 1: Create the DTO**

`server/src/modules/econt/dto/manual-shipment.dto.ts`:

```ts
import {
  IsString, IsNotEmpty, IsIn, IsOptional, IsInt, Min, IsBoolean, MaxLength,
} from 'class-validator';

/** A shipment typed in by hand in the standalone app (no storefront order). */
export class ManualShipmentDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  receiverName!: string;

  @IsString() @IsNotEmpty() @MaxLength(40)
  receiverPhone!: string;

  @IsIn(['office', 'address'])
  deliveryMode!: 'office' | 'address';

  // Required when deliveryMode === 'office'.
  @IsOptional() @IsString() @MaxLength(20)
  receiverOfficeCode?: string;

  // Required when deliveryMode === 'address'.
  @IsOptional() @IsString() @MaxLength(120)
  receiverCity?: string;
  @IsOptional() @IsString() @MaxLength(240)
  receiverAddress?: string;

  @IsOptional() @IsInt() @Min(0)
  weightGrams?: number; // grams in the API; converted to kg for the label

  @IsOptional() @IsString() @MaxLength(120)
  contents?: string;

  // 0 / omitted → no cash-on-delivery.
  @IsOptional() @IsInt() @Min(0)
  codAmountStotinki?: number;

  @IsOptional() @IsBoolean() smsNotification?: boolean;
  @IsOptional() @IsBoolean() refrigerated?: boolean;
  @IsOptional() @IsInt() @Min(0) declaredValueStotinki?: number;
}
```

- [ ] **Step 2: Write the failing test for the pure shape builder**

In `econt.service.spec.ts` add (and extend the import on line 2 to include `buildManualOrderShape`):

```ts
describe('buildManualOrderShape', () => {
  it('office + COD → econt office order-like shape with cod payment', () => {
    const o = buildManualOrderShape({
      receiverName: 'Иван', receiverPhone: '0888', deliveryMode: 'office',
      receiverOfficeCode: '1234', weightGrams: 2000, contents: 'мед',
      codAmountStotinki: 2400, smsNotification: true,
    });
    expect(o.customerName).toBe('Иван');
    expect(o.deliveryType).toBe('econt');
    expect(o.econtOffice).toBe('1234');
    expect(o.paymentMethod).toBe('cod');
    expect(o.totalStotinki).toBe(2400);
    expect(o.weightKg).toBe(2);
    expect(o.smsNotification).toBe(true);
  });

  it('address + no COD → econt_address shape, online payment, no cod', () => {
    const o = buildManualOrderShape({
      receiverName: 'Мария', receiverPhone: '0877', deliveryMode: 'address',
      receiverCity: 'София', receiverAddress: 'ул. Шипка 5',
    });
    expect(o.deliveryType).toBe('econt_address');
    expect(o.deliveryCity).toBe('София');
    expect(o.deliveryAddress).toBe('ул. Шипка 5');
    expect(o.paymentMethod).toBe('online');
    expect(o.totalStotinki).toBeNull();
    expect(o.weightKg).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @fermeribg/api test -- econt.service.spec`
Expected: FAIL — `buildManualOrderShape` not exported.

- [ ] **Step 4: Implement the pure builder + the service method**

In `econt.service.ts`, near the other exported pure functions (after `mapShipmentRow`), add:

```ts
/** The order-like shape `buildLabel` consumes, plus the optional service flags. */
export interface ManualOrderShape {
  customerName: string;
  customerPhone: string;
  deliveryType: 'econt' | 'econt_address';
  econtOffice: string | null;
  deliveryCity: string | null;
  deliveryAddress: string | null;
  totalStotinki: number | null;
  paymentMethod: 'cod' | 'online';
  paidAt: null;
  weightKg?: number;
  contents?: string;
  smsNotification?: boolean;
  refrigerated?: boolean;
  declaredValueStotinki?: number;
}

/** Turn hand-entered receiver input into the order-like shape buildLabel needs.
 *  COD is "the producer entered a COD amount"; weight is grams → kg. */
export function buildManualOrderShape(input: {
  receiverName: string;
  receiverPhone: string;
  deliveryMode: 'office' | 'address';
  receiverOfficeCode?: string;
  receiverCity?: string;
  receiverAddress?: string;
  weightGrams?: number;
  contents?: string;
  codAmountStotinki?: number;
  smsNotification?: boolean;
  refrigerated?: boolean;
  declaredValueStotinki?: number;
}): ManualOrderShape {
  const hasCod = !!input.codAmountStotinki && input.codAmountStotinki > 0;
  return {
    customerName: input.receiverName,
    customerPhone: input.receiverPhone,
    deliveryType: input.deliveryMode === 'address' ? 'econt_address' : 'econt',
    econtOffice: input.deliveryMode === 'office' ? (input.receiverOfficeCode ?? null) : null,
    deliveryCity: input.deliveryMode === 'address' ? (input.receiverCity ?? null) : null,
    deliveryAddress: input.deliveryMode === 'address' ? (input.receiverAddress ?? null) : null,
    totalStotinki: hasCod ? input.codAmountStotinki! : null,
    paymentMethod: hasCod ? 'cod' : 'online',
    paidAt: null,
    ...(input.weightGrams ? { weightKg: input.weightGrams / 1000 } : {}),
    ...(input.contents ? { contents: input.contents } : {}),
    ...(input.smsNotification ? { smsNotification: true } : {}),
    ...(input.refrigerated ? { refrigerated: true } : {}),
    ...(input.declaredValueStotinki ? { declaredValueStotinki: input.declaredValueStotinki } : {}),
  };
}
```

Then add the method on the `EcontService` class (after `createLabel`, before `getLabelPdf`). Note: `buildLabel` reads `econt.defaultPackage.weightKg` for the label weight; pass a per-shipment package override so a manual weight wins:

```ts
  /** Create an Econt waybill for a manually-entered shipment (no storefront order).
   *  Persists a `shipments` row with `orderId = null` + the receiver snapshot. */
  async createManualShipment(
    tenantId: string,
    input: import('./dto/manual-shipment.dto').ManualShipmentDto,
  ): Promise<typeof shipments.$inferSelect> {
    const { econt } = await this.loadStored(tenantId);
    const shape = buildManualOrderShape(input);
    // Per-shipment weight/contents override the farm's defaultPackage for this label.
    const econtForLabel: EcontStored = {
      ...econt,
      defaultPackage: {
        ...econt.defaultPackage,
        ...(shape.weightKg ? { weightKg: shape.weightKg } : {}),
        ...(shape.contents ? { contents: shape.contents } : {}),
      },
    };
    const label = this.buildLabel(econtForLabel, shape, []);
    const data = await this.callTenant(tenantId, 'Shipments/LabelService.createLabel.json', {
      label,
      mode: 'create',
    });
    const out = data?.label ?? {};
    const number: string | null = out.shipmentNumber ?? null;
    const priceBgn: number | undefined = out.totalPrice;
    const codAmount = this.codAmountFor(shape);

    const [row] = await this.db
      .insert(shipments)
      .values({
        tenantId,
        orderId: null,
        econtShipmentNumber: number,
        status: number ? 'created' : 'pending',
        labelPdfUrl: out.pdfURL ?? null,
        courierPriceStotinki: typeof priceBgn === 'number' ? Math.round(priceBgn * 100) : null,
        codAmountStotinki: codAmount,
        trackingJson: out,
        receiverName: input.receiverName,
        receiverPhone: input.receiverPhone,
        deliveryMode: input.deliveryMode,
        receiverOfficeCode: input.receiverOfficeCode ?? null,
        receiverCity: input.receiverCity ?? null,
        receiverAddress: input.receiverAddress ?? null,
        weightKg: shape.weightKg ? String(shape.weightKg) : null,
        contents: input.contents ?? null,
      })
      .returning();
    return row;
  }
```

(`codAmountFor` already accepts `{ paymentMethod, paidAt, totalStotinki }`, which `ManualOrderShape` satisfies.)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @fermeribg/api test -- econt.service.spec`
Expected: PASS.

- [ ] **Step 6: Build to typecheck the new method**

Run: `pnpm --filter @fermeribg/api build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/econt
git commit -m "feat(econt): createManualShipment — order-less waybill from hand-entered receiver"
```

---

## Task 4: `listShipments` includes manual shipments + their receiver

`listShipments` joins FROM `orders`, so manual (order-less) shipments never appear. Add a separate query that returns manual shipments for the tenant, mapped to the same `AdminShipment` shape (using the stored receiver columns instead of an order).

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts` (`listShipments`, the `ShipmentJoinRow`/`mapShipmentRow` neighbours)
- Test: `server/src/modules/econt/econt.service.spec.ts`

- [ ] **Step 1: Write the failing test for the manual-row mapper**

In `econt.service.spec.ts` add (extend the import to include `mapManualShipmentRow`):

```ts
describe('mapManualShipmentRow', () => {
  it('maps a stored manual shipment to the admin shape using receiver columns', () => {
    const out = mapManualShipmentRow({
      shipmentId: 'aaaa', orderId: null,
      receiverName: 'Иван', deliveryMode: 'address',
      shipmentNumber: '1051000000009', shipmentStatus: 'created',
      courierPrice: 599, labelPdfUrl: 'https://e/x.pdf', codAmount: 2400,
      trackingJson: null,
    });
    expect(out.customerName).toBe('Иван');
    expect(out.method).toBe('econtAddress');
    expect(out.status).toBe('created');
    expect(out.trackingNumber).toBe('1051000000009');
    expect(out.codAmountStotinki).toBe(2400);
    expect(out.shipmentId).toBe('aaaa');
    expect(out.orderNumber).toBe('Ръчна');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @fermeribg/api test -- econt.service.spec`
Expected: FAIL — `mapManualShipmentRow` not exported.

- [ ] **Step 3: Implement the mapper + extend `listShipments`**

In `econt.service.ts`, add the mapper next to `mapShipmentRow`:

```ts
/** Raw manual-shipment row (no order join). */
export interface ManualShipmentRow {
  shipmentId: string;
  orderId: string | null;
  receiverName: string | null;
  deliveryMode: string | null;
  shipmentNumber: string | null;
  shipmentStatus: string | null;
  courierPrice: number | null;
  labelPdfUrl: string | null;
  codAmount: number | null;
  trackingJson: unknown;
}

/** Map a stored order-less shipment onto the admin shipments-table shape. */
export function mapManualShipmentRow(r: ManualShipmentRow): AdminShipment {
  return {
    orderId: r.shipmentId, // no order — use the shipment id as the row key
    orderNumber: 'Ръчна',
    customerName: r.receiverName ?? '—',
    method: r.deliveryMode === 'address' ? 'econtAddress' : 'econtOffice',
    status: uiShipmentStatus(r.shipmentNumber, r.shipmentStatus),
    trackingNumber: r.shipmentNumber ?? undefined,
    priceStotinki: r.courierPrice ?? undefined,
    codAmountStotinki: r.codAmount ?? undefined,
    labelPdfUrl: r.labelPdfUrl ?? undefined,
    shipmentId: r.shipmentId,
    history: mapTrackingEvents(r.trackingJson),
  };
}
```

Then, in `listShipments`, after the existing order-joined query returns `rows.map(mapShipmentRow)`, also fetch + append manual shipments. Replace the final `return rows.map(mapShipmentRow);` with:

```ts
    const orderShipments = rows.map(mapShipmentRow);

    // Manual (order-less) shipments created in the standalone app.
    const manual = await this.db
      .select({
        shipmentId: shipments.id,
        orderId: shipments.orderId,
        receiverName: shipments.receiverName,
        deliveryMode: shipments.deliveryMode,
        shipmentNumber: shipments.econtShipmentNumber,
        shipmentStatus: shipments.status,
        courierPrice: shipments.courierPriceStotinki,
        labelPdfUrl: shipments.labelPdfUrl,
        codAmount: shipments.codAmountStotinki,
        trackingJson: shipments.trackingJson,
      })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), isNull(shipments.orderId)))
      .orderBy(desc(shipments.createdAt));

    return [...manual.map(mapManualShipmentRow), ...orderShipments];
```

Add `isNull` to the drizzle import on line 10 (`import { and, eq, desc, inArray, ne, isNotNull, isNull } from 'drizzle-orm';`).

- [ ] **Step 4: Run tests + build**

Run: `pnpm --filter @fermeribg/api test -- econt.service.spec`
Expected: PASS.
Run: `pnpm --filter @fermeribg/api build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt
git commit -m "feat(econt): listShipments includes manual order-less shipments"
```

---

## Task 5: Address validation (`validateAddress`)

**Files:**
- Create: `server/src/modules/econt/dto/validate-address.dto.ts`
- Modify: `server/src/modules/econt/econt.service.ts`
- Test: `server/src/modules/econt/econt.service.spec.ts`

- [ ] **Step 1: Create the DTO**

`server/src/modules/econt/dto/validate-address.dto.ts`:

```ts
import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

export class ValidateAddressDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  city!: string;

  @IsString() @IsNotEmpty() @MaxLength(240)
  address!: string;
}
```

- [ ] **Step 2: Write the failing test for the response parser**

In `econt.service.spec.ts` add (extend import with `parseAddressValidation`):

```ts
describe('parseAddressValidation', () => {
  it('normal/processed → valid', () => {
    expect(parseAddressValidation({ validationStatus: 'normal' }).valid).toBe(true);
    expect(parseAddressValidation({ validationStatus: 'processed' }).valid).toBe(true);
  });
  it('invalid / missing → not valid', () => {
    expect(parseAddressValidation({ validationStatus: 'invalid' }).valid).toBe(false);
    expect(parseAddressValidation(null).valid).toBe(false);
  });
  it('passes the raw status through', () => {
    expect(parseAddressValidation({ validationStatus: 'normal' }).status).toBe('normal');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @fermeribg/api test -- econt.service.spec`
Expected: FAIL — `parseAddressValidation` not exported.

- [ ] **Step 4: Implement parser + method**

In `econt.service.ts`, add the exported parser near the other pure helpers:

```ts
export interface AddressValidation {
  valid: boolean;
  status: string | null;
}

/** Interpret Econt's `validateAddress` response. `normal`/`processed` = usable;
 *  anything else (incl. a shapeless/empty response) = not deliverable. */
export function parseAddressValidation(res: unknown): AddressValidation {
  const r = (res ?? {}) as Record<string, any>;
  const status: string | null = typeof r.validationStatus === 'string' ? r.validationStatus : null;
  return { valid: status === 'normal' || status === 'processed', status };
}
```

Add the method on `EcontService` (near the nomenclature methods):

```ts
  /** Validate a door address against Econt before allowing a label. */
  async validateAddress(
    tenantId: string,
    input: import('./dto/validate-address.dto').ValidateAddressDto,
  ): Promise<AddressValidation> {
    const data = await this.callTenant(
      tenantId,
      'Nomenclatures/AddressService.validateAddress.json',
      { address: { city: { name: input.city }, other: input.address } },
    );
    return parseAddressValidation(data?.address ?? data);
  }
```

- [ ] **Step 5: Run tests + build**

Run: `pnpm --filter @fermeribg/api test -- econt.service.spec` → PASS
Run: `pnpm --filter @fermeribg/api build` → clean

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/econt
git commit -m "feat(econt): validateAddress — gate door labels on a deliverable address"
```

---

## Task 6: Sender auto-fill (`getClientProfiles`)

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts`
- Test: `server/src/modules/econt/econt.service.spec.ts`

- [ ] **Step 1: Write the failing test for the slim mapper**

In `econt.service.spec.ts` add (extend import with `slimClientProfiles`):

```ts
describe('slimClientProfiles', () => {
  it('maps Econt client profiles to sender suggestions', () => {
    const out = slimClientProfiles({
      profiles: [
        { client: { name: 'Ферма Петрови', phones: ['0888111222'], clientNumber: '1234567' } },
        { client: { name: 'Втора', phones: [] } },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: 'Ферма Петрови', phone: '0888111222', clientNumber: '1234567' });
    expect(out[1]).toEqual({ name: 'Втора', phone: '', clientNumber: null });
  });
  it('tolerates a flat profiles array + shapeless input', () => {
    expect(slimClientProfiles(null)).toEqual([]);
    expect(slimClientProfiles({ profiles: [{ name: 'Плосък', phones: ['0700'] }] })[0].name).toBe('Плосък');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @fermeribg/api test -- econt.service.spec`
Expected: FAIL — `slimClientProfiles` not exported.

- [ ] **Step 3: Implement mapper + method**

In `econt.service.ts`:

```ts
export interface SenderSuggestion {
  name: string;
  phone: string;
  clientNumber: string | null;
}

/** Slim Econt client profiles into sender suggestions. Econt nests the data under
 *  `profiles[].client` in current docs, but some responses are flat — handle both. */
export function slimClientProfiles(res: unknown): SenderSuggestion[] {
  const r = (res ?? {}) as Record<string, any>;
  const list: any[] = Array.isArray(r.profiles) ? r.profiles : [];
  return list.map((p) => {
    const c = p?.client ?? p ?? {};
    const phones: any[] = Array.isArray(c.phones) ? c.phones : [];
    return {
      name: String(c.name ?? '').trim(),
      phone: phones.length ? String(phones[0]) : '',
      clientNumber: c.clientNumber != null ? String(c.clientNumber) : null,
    };
  });
}
```

Method on `EcontService`:

```ts
  /** Fetch the farm's saved Econt sender profiles (auto-fill + creds check). */
  async getClientProfiles(tenantId: string): Promise<SenderSuggestion[]> {
    const data = await this.callTenant(tenantId, 'Profile/ProfileService.getClientProfiles.json', {});
    return slimClientProfiles(data);
  }
```

- [ ] **Step 4: Run tests + build**

Run: `pnpm --filter @fermeribg/api test -- econt.service.spec` → PASS
Run: `pnpm --filter @fermeribg/api build` → clean

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt
git commit -m "feat(econt): getClientProfiles — sender auto-fill from the Econt account"
```

---

## Task 7: Courier pickup request (`requestCourier` + status)

**Files:**
- Create: `server/src/modules/econt/dto/courier-request.dto.ts`
- Modify: `server/src/modules/econt/econt.service.ts`
- Test: `server/src/modules/econt/econt.service.spec.ts`

- [ ] **Step 1: Create the DTO**

`server/src/modules/econt/dto/courier-request.dto.ts`:

```ts
import { IsArray, IsString, IsOptional, ArrayNotEmpty, Matches } from 'class-validator';

export class CourierRequestDto {
  // Shipment UUIDs (our ids) to attach to the pickup.
  @IsArray() @ArrayNotEmpty() @IsString({ each: true })
  shipmentIds!: string[];

  // Pickup window — "YYYY-MM-DD HH:mm" style strings Econt accepts; optional.
  @IsOptional() @IsString() @Matches(/^[\d :-]{0,25}$/)
  timeFrom?: string;
  @IsOptional() @IsString() @Matches(/^[\d :-]{0,25}$/)
  timeTo?: string;
}
```

- [ ] **Step 2: Write the failing test for the payload builder**

In `econt.service.spec.ts` add (extend import with `buildCourierRequest`):

```ts
describe('buildCourierRequest', () => {
  const senderAddress = { sender: { name: 'Ферма', phone: '0888', mode: 'address', cityName: 'Бургас', address: 'ул. 1' } };
  it('door sender → senderAddress + attached numbers + packCount', () => {
    const body = buildCourierRequest(senderAddress as never, ['1051000000001', '1051000000002'], { timeFrom: '2026-06-25 10:00', timeTo: '2026-06-25 18:00' });
    expect(body.attachShipments).toEqual(['1051000000001', '1051000000002']);
    expect(body.shipmentPackCount).toBe(2);
    expect(body.requestTimeFrom).toBe('2026-06-25 10:00');
    expect(body.senderClient).toEqual({ name: 'Ферма', phones: ['0888'] });
    expect((body.senderAddress as any).city.name).toBe('Бургас');
  });
  it('office sender → senderOfficeCode instead of address', () => {
    const body = buildCourierRequest(
      { sender: { name: 'Ф', phone: '0', mode: 'office', officeCode: '99' } } as never,
      ['1051000000003'], {},
    );
    expect(body.senderOfficeCode).toBe('99');
    expect(body.senderAddress).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @fermeribg/api test -- econt.service.spec`
Expected: FAIL — `buildCourierRequest` not exported.

- [ ] **Step 4: Implement builder + methods**

In `econt.service.ts`:

```ts
/** Build the Econt `requestCourier` payload from the farm's sender profile +
 *  already-created waybill numbers. `shipmentType` casing is verified in the spike
 *  (docs say lowercase `pack`; the PHP SDK sends `PACK`). */
export function buildCourierRequest(
  econt: EcontStored,
  shipmentNumbers: string[],
  window: { timeFrom?: string; timeTo?: string },
): Record<string, unknown> {
  const sender = (econt.sender ?? {}) as Record<string, any>;
  const body: Record<string, unknown> = {
    shipmentType: 'pack',
    shipmentPackCount: shipmentNumbers.length,
    senderClient: { name: sender.name || 'Подател', phones: [sender.phone || ''] },
    attachShipments: shipmentNumbers,
  };
  if (sender.mode === 'address') {
    body.senderAddress = { city: { name: sender.cityName ?? '' }, other: sender.address ?? '' };
  } else {
    body.senderOfficeCode = sender.officeCode ?? undefined;
  }
  if (window.timeFrom) body.requestTimeFrom = window.timeFrom;
  if (window.timeTo) body.requestTimeTo = window.timeTo;
  return body;
}
```

Methods on `EcontService` (after `createManualShipment`). `EcontStored` is already exposed via `this.loadStored`:

```ts
  /** Book an Econt courier to collect the given (already-created) shipments at the farm. */
  async requestCourier(
    tenantId: string,
    input: import('./dto/courier-request.dto').CourierRequestDto,
  ): Promise<{ requestId: string | null; status: string | null }> {
    const { econt } = await this.loadStored(tenantId);
    // Resolve our shipment ids → Econt waybill numbers (tenant-scoped).
    const rows = await this.db
      .select({ id: shipments.id, number: shipments.econtShipmentNumber })
      .from(shipments)
      .where(and(eq(shipments.tenantId, tenantId), inArray(shipments.id, input.shipmentIds)));
    const numbers = rows.map((r) => r.number).filter((n): n is string => !!n);
    if (!numbers.length) throw new BadRequestException('Няма товарителници за заявка на куриер');

    const body = buildCourierRequest(econt, numbers, { timeFrom: input.timeFrom, timeTo: input.timeTo });
    const data = await this.callTenant(tenantId, 'Shipments/ShipmentService.requestCourier.json', body);
    const requestId: string | null =
      data?.courierRequestID != null ? String(data.courierRequestID) : data?.id != null ? String(data.id) : null;
    const status: string | null = data?.status ?? (requestId ? 'process' : null);

    if (requestId) {
      await this.db
        .update(shipments)
        .set({ courierRequestId: requestId, courierRequestStatus: status, updatedAt: new Date() })
        .where(and(eq(shipments.tenantId, tenantId), inArray(shipments.id, input.shipmentIds)));
    }
    return { requestId, status };
  }

  /** Poll an Econt courier-pickup request's status. */
  async getRequestCourierStatus(tenantId: string, requestId: string): Promise<{ status: string | null }> {
    const data = await this.callTenant(
      tenantId,
      'Shipments/ShipmentService.getRequestCourierStatus.json',
      { requestCourierId: requestId },
    );
    const status: string | null = data?.status ?? data?.requestCourierStatus ?? null;
    return { status };
  }
```

- [ ] **Step 5: Run tests + build**

Run: `pnpm --filter @fermeribg/api test -- econt.service.spec` → PASS
Run: `pnpm --filter @fermeribg/api build` → clean

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/econt
git commit -m "feat(econt): requestCourier — book a farm pickup for created waybills"
```

---

## Task 8: Standalone helpers — slug, signup settings, activation gate

Pure functions for the standalone module, unit-tested in isolation.

**Files:**
- Create: `server/src/modules/econt-app/econt-app.helpers.ts`
- Create: `server/src/modules/econt-app/econt-app.helpers.spec.ts`

- [ ] **Step 1: Write the failing tests**

`server/src/modules/econt-app/econt-app.helpers.spec.ts`:

```ts
import { slugifyFarm, econtTenantSettings, isEcontAccountActive, withEcontActive } from './econt-app.helpers';

describe('slugifyFarm', () => {
  it('transliterates + kebab-cases a Bulgarian name', () => {
    expect(slugifyFarm('Ферма Петрови!!')).toMatch(/^[a-z0-9-]+$/);
    expect(slugifyFarm('  Hello World  ')).toBe('hello-world');
  });
  it('falls back when empty after stripping', () => {
    expect(slugifyFarm('!!!').length).toBeGreaterThan(0);
  });
});

describe('econtTenantSettings', () => {
  it('marks the product + inactive account + econt manual mode', () => {
    const s = econtTenantSettings();
    expect(s.product).toBe('econt-standalone');
    expect(s.econtApp).toEqual({ active: false });
    expect((s.delivery as any).econt.mode).toBe('manual');
  });
});

describe('isEcontAccountActive', () => {
  it('true only when econtApp.active === true', () => {
    expect(isEcontAccountActive({ econtApp: { active: true } })).toBe(true);
    expect(isEcontAccountActive({ econtApp: { active: false } })).toBe(false);
    expect(isEcontAccountActive({})).toBe(false);
    expect(isEcontAccountActive(null)).toBe(false);
  });
});

describe('withEcontActive', () => {
  it('sets the flag without dropping other settings', () => {
    const next = withEcontActive({ product: 'econt-standalone', foo: 1 }, true);
    expect(next.econtApp).toEqual({ active: true });
    expect(next.foo).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @fermeribg/api test -- econt-app.helpers`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`server/src/modules/econt-app/econt-app.helpers.ts`:

```ts
const CYR_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya',
};

/** Transliterate + kebab-case a farm name into a URL-safe slug stem (no uniqueness). */
export function slugifyFarm(name: string): string {
  const translit = (name ?? '')
    .toLowerCase()
    .split('')
    .map((ch) => CYR_MAP[ch] ?? ch)
    .join('');
  const slug = translit.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `ferma-${Math.abs(hashCode(name ?? ''))}`;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** Default `tenants.settings` for a standalone Econt account. */
export function econtTenantSettings(): Record<string, unknown> {
  return {
    product: 'econt-standalone',
    econtApp: { active: false },
    delivery: { econt: { mode: 'manual' } },
  };
}

/** Is the tenant's standalone account paid/active? */
export function isEcontAccountActive(settings: unknown): boolean {
  const s = (settings ?? {}) as Record<string, any>;
  return s.econtApp?.active === true;
}

/** Merge the active flag into a settings blob without dropping other keys. */
export function withEcontActive(settings: unknown, active: boolean): Record<string, unknown> {
  const s = (settings ?? {}) as Record<string, any>;
  return { ...s, econtApp: { ...(s.econtApp ?? {}), active } };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @fermeribg/api test -- econt-app.helpers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt-app/econt-app.helpers.ts server/src/modules/econt-app/econt-app.helpers.spec.ts
git commit -m "feat(econt-app): pure helpers — slug, signup settings, activation gate"
```

---

## Task 9: Standalone auth — signup DTO + service

**Files:**
- Create: `server/src/modules/econt-app/dto/signup.dto.ts`
- Create: `server/src/modules/econt-app/standalone-auth.service.ts`

- [ ] **Step 1: Create the signup DTO**

`server/src/modules/econt-app/dto/signup.dto.ts`:

```ts
import { IsEmail, IsString, MinLength, MaxLength, IsOptional } from 'class-validator';

export class EcontSignupDto {
  @IsEmail()
  email!: string;

  // Floor of 12 to match the platform password policy.
  @IsString() @MinLength(12) @MaxLength(128)
  password!: string;

  @IsString() @MinLength(2) @MaxLength(120)
  farmName!: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;
}
```

- [ ] **Step 2: Implement the service**

`server/src/modules/econt-app/standalone-auth.service.ts` — signup creates a tenant + owner user (reusing the platform pattern from `platform.service.ts:648`), then returns a token via the existing `AuthService.login`:

```ts
import { Injectable, Inject, ConflictException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import * as argon2 from 'argon2';
import { type Database, tenants, users } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { AuthService } from '../auth/auth.service';
import { EcontSignupDto } from './dto/signup.dto';
import { slugifyFarm, econtTenantSettings } from './econt-app.helpers';

@Injectable()
export class StandaloneAuthService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly auth: AuthService,
  ) {}

  /** Public self-service signup for a standalone Econt account. */
  async signup(dto: EcontSignupDto): Promise<{ accessToken: string }> {
    const email = dto.email.trim().toLowerCase();
    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    if (existing.length) throw new ConflictException('Имейлът вече е зает');

    const slug = await this.uniqueSlug(slugifyFarm(dto.farmName));

    const [tenant] = await this.db
      .insert(tenants)
      .values({
        name: dto.farmName,
        slug,
        phone: dto.phone,
        email,
        subscriptionStatus: 'active',
        subscriptionSince: new Date(),
        settings: econtTenantSettings(),
      })
      .returning();

    await this.db.insert(users).values({
      tenantId: tenant.id,
      email,
      passwordHash: await argon2.hash(dto.password),
      role: 'admin',
      mustChangePassword: false,
    });

    // Reuse the case-insensitive login to mint the session token.
    return this.auth.login({ email, password: dto.password });
  }

  /** Append -2, -3, … until the slug is free. */
  private async uniqueSlug(stem: string): Promise<string> {
    let slug = stem;
    for (let n = 2; ; n++) {
      const [clash] = await this.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .limit(1);
      if (!clash) return slug;
      slug = `${stem}-${n}`;
    }
  }
}
```

- [ ] **Step 3: Build to typecheck**

Run: `pnpm --filter @fermeribg/api build`
Expected: clean. `tsc` compiles every file regardless of DI wiring, so this file passes once it is type-correct (it imports only things that already exist — `AuthService`, `tenants`/`users`, and the Task 8 helpers). DI wiring (providing the service in a module) is a runtime concern verified at boot in Task 13. Fix any type errors here.

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/econt-app/dto/signup.dto.ts server/src/modules/econt-app/standalone-auth.service.ts
git commit -m "feat(econt-app): standalone signup — create tenant+owner, return token"
```

---

## Task 10: Activation guard

Blocks paid actions (label creation, courier request) until `settings.econtApp.active === true`.

**Files:**
- Create: `server/src/modules/econt-app/activation.guard.ts`

- [ ] **Step 1: Implement the guard**

`server/src/modules/econt-app/activation.guard.ts`:

```ts
import { CanActivate, ExecutionContext, Injectable, Inject, ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Database, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { isEcontAccountActive } from './econt-app.helpers';

/** Allow only activated (paid) standalone accounts past. Runs after JwtAuthGuard,
 *  so `request.user.tenantId` is set. */
@Injectable()
export class ActivationGuard implements CanActivate {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const tenantId: string | undefined = req.user?.tenantId;
    if (!tenantId) throw new ForbiddenException('Няма достъп');
    const [row] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!isEcontAccountActive(row?.settings)) {
      throw new ForbiddenException('Активирай акаунта си, за да създаваш товарителници');
    }
    return true;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/modules/econt-app/activation.guard.ts
git commit -m "feat(econt-app): activation guard — gate paid actions on active account"
```

---

## Task 11: Standalone controllers (auth + shipping)

**Files:**
- Create: `server/src/modules/econt-app/standalone-auth.controller.ts`
- Create: `server/src/modules/econt-app/econt-standalone.controller.ts`

- [ ] **Step 1: Auth controller**

`server/src/modules/econt-app/standalone-auth.controller.ts` — signup (throttled), plus login/me/change-password reusing `AuthService`:

```ts
import { Controller, Post, Get, Body, UseGuards, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { StandaloneAuthService } from './standalone-auth.service';
import { AuthService } from '../auth/auth.service';
import { EcontSignupDto } from './dto/signup.dto';
import { LoginDto } from '../auth/dto/login.dto';
import { ChangePasswordDto } from '../auth/dto/change-password.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@Controller('auth')
export class StandaloneAuthController {
  constructor(
    private readonly standalone: StandaloneAuthService,
    private readonly auth: AuthService,
  ) {}

  // Tight limit: account creation is abuse-prone.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('signup')
  signup(@Body() dto: EcontSignupDto) {
    return this.standalone.signup(dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: any) {
    return this.auth.getMe(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(req.user.userId, dto);
  }
}
```

- [ ] **Step 2: Shipping controller**

`server/src/modules/econt-app/econt-standalone.controller.ts` — the full standalone surface, tenant-scoped; create + courier gated by `ActivationGuard`:

```ts
import {
  Controller, Get, Post, Delete, Body, Param, Query, UseGuards, ParseUUIDPipe, StreamableFile,
} from '@nestjs/common';
import { EcontService } from '../econt/econt.service';
import { EcontCredentialsDto } from '../econt/dto/econt-credentials.dto';
import { ManualShipmentDto } from '../econt/dto/manual-shipment.dto';
import { ValidateAddressDto } from '../econt/dto/validate-address.dto';
import { CourierRequestDto } from '../econt/dto/courier-request.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { ActivationGuard } from './activation.guard';

@UseGuards(JwtAuthGuard)
@Controller('shipping')
export class EcontStandaloneController {
  constructor(private readonly econt: EcontService) {}

  // --- account / setup ---
  @Post('credentials')
  saveCredentials(@CurrentTenant() t: string, @Body() dto: EcontCredentialsDto) {
    return this.econt.saveCredentials(t, dto);
  }
  @Get('config')
  config(@CurrentTenant() t: string) {
    return this.econt.getConfig(t);
  }
  @Get('profiles')
  profiles(@CurrentTenant() t: string) {
    return this.econt.getClientProfiles(t);
  }
  @Post('nomenclature/sync')
  sync(@CurrentTenant() t: string) {
    return this.econt.syncNomenclature(t);
  }
  @Get('cities')
  cities(@CurrentTenant() t: string, @Query('q') q?: string) {
    return this.econt.searchCities(t, q);
  }
  @Get('offices')
  offices(@CurrentTenant() t: string, @Query('cityId') cityId?: string) {
    return this.econt.getOfficesForCity(t, cityId ? Number(cityId) : 0);
  }
  @Post('validate-address')
  validateAddress(@CurrentTenant() t: string, @Body() dto: ValidateAddressDto) {
    return this.econt.validateAddress(t, dto);
  }

  // --- shipments ---
  @Get('shipments')
  list(@CurrentTenant() t: string) {
    return this.econt.listShipments(t);
  }
  @Get('cod-reconciliation')
  cod(@CurrentTenant() t: string) {
    return this.econt.codReconciliation(t);
  }

  // Creating a real waybill is the paid action → activation-gated.
  @UseGuards(ActivationGuard)
  @Post('shipments')
  create(@CurrentTenant() t: string, @Body() dto: ManualShipmentDto) {
    return this.econt.createManualShipment(t, dto);
  }

  @Post('shipments/:id/refresh')
  refresh(@CurrentTenant() t: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.econt.refreshStatus(t, id);
  }
  @Delete('shipments/:id')
  void(@CurrentTenant() t: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.econt.voidShipment(t, id);
  }

  // --- courier pickup (paid action) ---
  @UseGuards(ActivationGuard)
  @Post('courier')
  courier(@CurrentTenant() t: string, @Body() dto: CourierRequestDto) {
    return this.econt.requestCourier(t, dto);
  }
  @Get('courier/:requestId')
  courierStatus(@CurrentTenant() t: string, @Param('requestId') requestId: string) {
    return this.econt.getRequestCourierStatus(t, requestId);
  }

  // --- print ---
  @Get('labels.pdf')
  async labels(@CurrentTenant() t: string, @Query('ids') ids: string): Promise<StreamableFile> {
    const list = (ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const buf = await this.econt.getLabelsPdf(t, list);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="labels.pdf"' });
  }
  @Get('shipments/:id/label.pdf')
  async label(@CurrentTenant() t: string, @Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const buf = await this.econt.getLabelPdf(t, id);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="label.pdf"' });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/econt-app/standalone-auth.controller.ts server/src/modules/econt-app/econt-standalone.controller.ts
git commit -m "feat(econt-app): standalone controllers — auth + shipping surface"
```

---

## Task 12: `EcontAppModule` (standalone root module)

A self-contained root module importing the subset of infra the standalone app needs.

**Files:**
- Create: `server/src/modules/econt-app/econt-app.module.ts`

- [ ] **Step 1: Implement the module**

`server/src/modules/econt-app/econt-app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { DrizzleModule } from '../../common/drizzle/drizzle.module';
import { RedisModule } from '../../common/redis/redis.module';
import { REDIS_TOKEN } from '../../common/redis/redis.constants';
import { RedisThrottlerStorage } from '../../common/throttler/redis-throttler.storage';
import { throttlerTracker } from '../../common/throttler/throttler.tracker';
import { QueueModule } from '../../common/queue/queue.module';
import { EmailModule } from '../../common/email/email.module';
import { PublicCacheModule } from '../../common/cache/public-cache.module';
import { AuthModule } from '../auth/auth.module';
import { EcontModule } from '../econt/econt.module';
import { StandaloneAuthService } from './standalone-auth.service';
import { StandaloneAuthController } from './standalone-auth.controller';
import { EcontStandaloneController } from './econt-standalone.controller';
import { ActivationGuard } from './activation.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../.env', '.env'] }),
    ThrottlerModule.forRootAsync({
      inject: [REDIS_TOKEN, ConfigService],
      useFactory: (redis: Redis, config: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get<number>('RATE_LIMIT_TTL_MS', 60_000),
            limit: config.get<number>('RATE_LIMIT_DEFAULT', 300),
          },
        ],
        storage: new RedisThrottlerStorage(redis),
        getTracker: (req) => throttlerTracker(req as any),
      }),
    }),
    DrizzleModule,
    RedisModule,
    QueueModule,
    EmailModule,
    PublicCacheModule,
    AuthModule, // JwtModule + JwtStrategy + AuthService
    EcontModule, // EcontService
  ],
  controllers: [StandaloneAuthController, EcontStandaloneController],
  providers: [
    StandaloneAuthService,
    ActivationGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class EcontAppModule {}
```

> If `pnpm --filter @fermeribg/api build` reports that `EcontModule` or `EmailModule` aren't exported as expected, check their actual export names — `EcontModule` exports `EcontService`; `EmailModule` is `@Global`, so importing it makes `EmailService` available to `EcontService`/`ShipmentEmailService`. Do not add a second `EmailModule` if it's already global — importing it once here is correct since this is a separate app root.

- [ ] **Step 2: Commit**

```bash
git add server/src/modules/econt-app/econt-app.module.ts
git commit -m "feat(econt-app): EcontAppModule — standalone root module"
```

---

## Task 13: Bootstrap `main.econt.ts` + green build

**Files:**
- Create: `server/src/main.econt.ts`
- Modify: `server/package.json` (add `start:econt`)

- [ ] **Step 1: Write the bootstrap**

`server/src/main.econt.ts` — mirrors `main.ts` but minimal; does NOT run migrations (the FarmFlow API owns that; deploy it first):

```ts
import './instrument';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import compression from 'compression';
import { EcontAppModule } from './modules/econt-app/econt-app.module';

async function bootstrap() {
  const app = await NestFactory.create(EcontAppModule);
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const corsOrigins = config
    .get<string>('CORS_ORIGIN_ECONT', 'http://localhost:3200')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const port = config.get<number>('PORT_ECONT', 3100);

  app.getHttpAdapter().getInstance().set('trust proxy', config.get<string>('TRUST_PROXY') ?? false);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' }, crossOriginEmbedderPolicy: false }));
  app.use(compression());

  app.use((req: any, res: any, next: () => void) => {
    const origin = req.headers.origin;
    res.header('Vary', 'Origin');
    if (origin && corsOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
    }
    res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));

  await app.listen(port);
  console.log(`Econt standalone API running on http://localhost:${port}`);
}

bootstrap();
```

- [ ] **Step 2: Add the run script**

In `server/package.json`, add to `scripts` (next to the existing `start:prod` / `start` entries — match their style):

```json
    "start:econt": "node dist/main.econt.js",
```

- [ ] **Step 3: Build the whole API (the real green gate)**

Run: `pnpm --filter @fermeribg/db build && pnpm --filter @fermeribg/types build && pnpm --filter @fermeribg/api build`
Expected: clean build — `dist/main.econt.js` exists and all econt-app files compile. Fix any type errors surfaced now (imports, the `import('./dto/...')` inline types in `econt.service.ts`, etc.).

- [ ] **Step 4: Run the full server test suite**

Run: `pnpm --filter @fermeribg/api test`
Expected: all suites green (the prior 656 + the new econt/econt-app tests).

- [ ] **Step 5: Smoke-test the standalone app boots (no live Econt needed)**

With local Postgres + Redis available (the same the API uses) and env (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`) set:

Run: `node server/dist/main.econt.js` (or `pnpm --filter @fermeribg/api start:econt`)
Expected: logs `Econt standalone API running on http://localhost:3100`.

In another shell:
```bash
curl -s -X POST localhost:3100/auth/signup -H 'content-type: application/json' \
  -d '{"email":"farm1@example.com","password":"longenoughpw12","farmName":"Тест Ферма","phone":"0888"}'
```
Expected: `{"accessToken":"..."}`. Then with that token:
```bash
curl -s localhost:3100/auth/me -H "authorization: Bearer <token>"
```
Expected: a JSON profile (`email`, `role: "admin"`). Then verify the activation gate:
```bash
curl -s -X POST localhost:3100/shipping/shipments -H "authorization: Bearer <token>" \
  -H 'content-type: application/json' -d '{"receiverName":"Х","receiverPhone":"0","deliveryMode":"office","receiverOfficeCode":"1"}'
```
Expected: `403` with `Активирай акаунта си, за да създаваш товарителници` (account not active yet — proves the guard). Stop the process when done.

- [ ] **Step 6: Commit**

```bash
git add server/src/main.econt.ts server/package.json
git commit -m "feat(econt-app): main.econt.ts bootstrap on port 3100 + start:econt"
```

---

## Task 14: Super-admin activate endpoint

Lets a platform admin flip `econtApp.active` after payment.

**Files:**
- Modify: `server/src/modules/platform/platform.service.ts`
- Modify: `server/src/modules/platform/platform.controller.ts`
- Test: `server/src/modules/platform/platform.service.spec.ts`

- [ ] **Step 1: Write the failing test**

In `platform.service.spec.ts`, add a unit test for the settings merge (import `withEcontActive` from the econt-app helpers — it is the single source of truth for the merge):

```ts
import { withEcontActive } from '../econt-app/econt-app.helpers';

describe('withEcontActive (used by platform activate)', () => {
  it('activates without dropping other settings', () => {
    expect(withEcontActive({ product: 'econt-standalone', delivery: { x: 1 } }, true)).toEqual({
      product: 'econt-standalone',
      delivery: { x: 1 },
      econtApp: { active: true },
    });
  });
});
```

- [ ] **Step 2: Run to verify it passes already (helper exists) — this is a guard test**

Run: `pnpm --filter @fermeribg/api test -- platform.service.spec`
Expected: PASS (the helper is already implemented + tested in Task 8; this asserts platform uses the same merge contract). If the import path is wrong, fix it.

- [ ] **Step 3: Implement the service method**

In `platform.service.ts`, add (near `updateTenant`; reuse the existing `tenants` import + `eq`):

```ts
  /** Activate/deactivate a standalone Econt account (one-time payment gate). */
  async setEcontAppActive(tenantId: string, active: boolean): Promise<{ id: string; active: boolean }> {
    const [t] = await this.db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!t) throw new NotFoundException('Акаунтът не е намерен');
    await this.db
      .update(tenants)
      .set({ settings: withEcontActive(t.settings, active) })
      .where(eq(tenants.id, tenantId));
    return { id: tenantId, active };
  }
```

Add the import at the top of `platform.service.ts`:
```ts
import { withEcontActive } from '../econt-app/econt-app.helpers';
```
(Confirm `NotFoundException` is imported — it is used elsewhere in the file; if not, add it to the `@nestjs/common` import.)

- [ ] **Step 4: Implement the controller route**

In `platform.controller.ts`, add a route to the existing platform controller (it is already platform-admin guarded — match the surrounding guard/decorator pattern, e.g. the existing tenant-status route). Use a body `{ active: boolean }`:

```ts
  @Patch('econt-accounts/:tenantId/activate')
  setEcontActive(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: { active: boolean },
  ) {
    return this.platform.setEcontAppActive(tenantId, body.active === true);
  }
```

Confirm `Patch`, `Param`, `Body`, `ParseUUIDPipe` are imported in `platform.controller.ts` (add any missing to the `@nestjs/common` import).

- [ ] **Step 5: Run tests + build**

Run: `pnpm --filter @fermeribg/api test -- platform` → PASS
Run: `pnpm --filter @fermeribg/api build` → clean

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/platform
git commit -m "feat(platform): super-admin activate standalone Econt account"
```

---

## Task 15: Final verification + lint

- [ ] **Step 1: Full build (db + types + api)**

Run: `pnpm --filter @fermeribg/db build && pnpm --filter @fermeribg/types build && pnpm --filter @fermeribg/api build`
Expected: all clean.

- [ ] **Step 2: Full server test suite**

Run: `pnpm --filter @fermeribg/api test`
Expected: all green.

- [ ] **Step 3: Lint**

Run: `pnpm --filter @fermeribg/api lint`
Expected: no errors. Fix any (the inline `import('./dto/...')` types are valid TS but if the repo's lint dislikes them, convert to top-of-file imports).

- [ ] **Step 4: Confirm migration is the only schema change + review the diff**

Run: `git diff --stat main..HEAD` and `git log --oneline main..HEAD`
Expected: one migration (0055), no edits to FarmFlow's A–C behaviour beyond the additive `buildLabel`/`listShipments` changes (which keep existing tests green).

---

## Spike (do before any producer goes to production — not a code task)

With Васил's **demo** Econt account, hit the demo base and diff live JSON against the field names this plan assumed. Adjust the defensive parsers if they differ:

- `Profile/ProfileService.getClientProfiles.json` → confirm `profiles[].client.{name,phones,clientNumber}` (vs flat) → `slimClientProfiles`.
- `Nomenclatures/AddressService.validateAddress.json` → confirm `validationStatus` values + whether the status is under `address` or top-level → `parseAddressValidation`.
- `Shipments/ShipmentService.requestCourier.json` → confirm `shipmentType` casing (`pack` vs `PACK`) + the response id field (`courierRequestID` vs `id`) → `buildCourierRequest` / `requestCourier`.
- `getRequestCourierStatus.json` → confirm request id field name (`requestCourierId`?) + status enum.
- COD timing fields on `getShipmentStatuses` (`cdCollectedTime`/`cdPaidTime`) — already handled defensively by `parseCodReconciliation`.

All parsers degrade to safe defaults (empty/null) on mismatch — nothing crashes — but COD/courier features stay inert until the field names match. Update + add a regression test for any field that differs.

---

## Out of scope (this plan)

- The `econt-web` frontend (signup/login, connect, create-shipment form, list/track/COD/print/courier UI) — **next plan**.
- Deploy wiring: the new compose service for `node dist/main.econt.js`, the Cloudflare-tunnel subdomain, `deploy.yml` changes, `APP_ROLE=web` on the standalone process — **next plan**.
- CSV bulk import, `PaymentReport` ledger, Stripe one-time auto-activation, `getMyAWB` sync, returns (all v2).
