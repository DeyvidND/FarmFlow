# Econt Service Build-out Implementation Plan (Phases A–C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the per-tenant Econt courier integration from "label creation works" to a complete operational loop — real label printing, customer tracking + a "shipped" email, and COD reconciliation.

**Architecture:** `EcontService` (`server/src/modules/econt/econt.service.ts`) stays the integration core; phases add capability incrementally. Phase A is migration-free. Phase B adds one column + a BullMQ repeatable refresh + a "shipped" email. Phase C adds two columns + COD reconciliation surfaced in the existing Плащания screen. The browser prints via the existing `/bff/*` cookie→bearer proxy, so a JWT-protected API endpoint that streams a PDF is openable directly with `window.open` (no client-side blob needed).

**Tech Stack:** NestJS + Drizzle (Postgres) + BullMQ (Redis) on the server; Next.js (App Router) admin client; jest for server tests; `pdf-lib` (new) for bulk label merge.

**Reference spec:** `docs/superpowers/specs/2026-06-23-econt-service-buildout-design.md`
**Context map:** `docs/econt-service-context.md`

## Conventions (apply to every task)

- Server tests: `pnpm --filter @fermeribg/api test -- -t "<test name>"` (jest). Lint: `pnpm --filter @fermeribg/api lint`.
- After editing `packages/db` or `packages/types`, rebuild their dist before the server build: `pnpm --filter @fermeribg/db build && pnpm --filter @fermeribg/types build`.
- Client typecheck/build: `pnpm --filter @fermeribg/web build` (Next.js; run from repo root).
- Commit after each task. Work stays on the current branch (`fix/econt-print-label-phase-a`); `main` auto-deploys to Hetzner, so do **not** push to `main`.
- All user-facing strings in Bulgarian.
- Econt failures must never break checkout/webhooks — keep `estimateShipping`/`autoCreateForOrder` swallow behavior untouched.

## File Structure

**Phase A**
- Modify `server/src/modules/econt/econt.service.ts` — `codAmountFor` helper, persist COD in `createLabel`, `mapShipmentRow` returns `labelPdfUrl`, new `getLabelPdf`/`getLabelsPdf`.
- Modify `server/src/modules/econt/econt.controller.ts` — two PDF GET endpoints.
- Modify `server/src/modules/econt/econt.service.spec.ts` — new unit tests.
- Modify `server/package.json` — add `pdf-lib`.
- Modify `client/src/lib/types.ts` — `Shipment.labelPdfUrl`.
- Modify `client/src/components/delivery/shipments-table.tsx` — real print buttons.

**Phase B**
- Modify `packages/db/src/schema.ts` — `shipments.customerNotifiedAt`; generates migration `0053`.
- Modify `server/src/modules/econt/econt.service.ts` — `mapTrackingEvents`, history in `mapShipmentRow`, notify-on-ship in `refreshStatus`, `refreshActiveShipments`.
- Create `server/src/modules/econt/shipment-email.service.ts` — `ShipmentEmailService`.
- Create `server/src/modules/econt/econt.processor.ts` — repeatable refresh.
- Modify `server/src/common/queue/queue.constants.ts` — `ECONT_QUEUE`.
- Modify `server/src/modules/econt/econt.module.ts` — queue + EmailModule + worker gate.
- Modify `client/src/components/delivery/shipments-table.tsx` — "Обнови" in the tracking modal.

**Phase C**
- Spike doc comment (no file) → then `packages/db/src/schema.ts` — `shipments.codCollectedAt`, `codSettledAt`; generates `0054`.
- Modify `server/src/modules/econt/econt.service.ts` — `parseCodReconciliation`, persist in `refreshStatus`, `codReconciliation`.
- Modify `server/src/modules/econt/econt.controller.ts` — `GET cod-reconciliation`.
- Modify `client/src/lib/api-client.ts` + `client/src/components/payments/payments-client.tsx` — settlement badge in the COD tab.

---

# PHASE A — Real print + COD persistence (no migration)

### Task A1: Persist `codAmountStotinki` when a label is created

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts`
- Test: `server/src/modules/econt/econt.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Append to `econt.service.spec.ts`:

```ts
describe('EcontService.codAmountFor', () => {
  const svc = new EcontService({} as never, { get: () => '' } as never, {} as never);
  const cod = (order: Record<string, unknown>): number | null =>
    (svc as unknown as { codAmountFor: (o: unknown) => number | null }).codAmountFor(order);

  it('unpaid COD order → the order total in stotinki', () => {
    expect(cod({ paymentMethod: 'cod', totalStotinki: 2400 })).toBe(2400);
  });
  it('online order → null', () => {
    expect(cod({ paymentMethod: 'online', totalStotinki: 2400 })).toBeNull();
  });
  it('COD already paid online → null (no second collection)', () => {
    expect(cod({ paymentMethod: 'cod', totalStotinki: 2400, paidAt: new Date() })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- -t "codAmountFor"`
Expected: FAIL — `codAmountFor is not a function`.

- [ ] **Step 3: Add the helper and use it in `createLabel`**

In `econt.service.ts`, add this private method just above `createLabel`:

```ts
/**
 * COD amount (stotinki) to persist + collect for an order: the order total when
 * this is an UNPAID наложен-платеж order, else null. Mirrors buildLabel's COD gate
 * so the stored amount and the amount on the waybill always agree.
 */
private codAmountFor(order: {
  paymentMethod?: string | null;
  paidAt?: Date | string | null;
  totalStotinki?: number | null;
}): number | null {
  const collect = order.paymentMethod === 'cod' && !order.paidAt;
  return collect && order.totalStotinki ? Math.round(order.totalStotinki) : null;
}
```

In `createLabel`, add `codAmountStotinki` to both the insert `.values({...})` and the `onConflictDoUpdate` `set` (find the existing block at ~line 618):

```ts
      .values({
        tenantId,
        orderId,
        econtShipmentNumber: number,
        status: number ? 'created' : 'pending',
        labelPdfUrl: out.pdfURL ?? null,
        courierPriceStotinki: typeof priceBgn === 'number' ? Math.round(priceBgn * 100) : null,
        codAmountStotinki: this.codAmountFor(order),
        trackingJson: out,
      })
      .onConflictDoUpdate({
        target: shipments.orderId,
        set: {
          econtShipmentNumber: number,
          status: number ? 'created' : 'pending',
          labelPdfUrl: out.pdfURL ?? null,
          codAmountStotinki: this.codAmountFor(order),
          updatedAt: new Date(),
        },
      })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- -t "codAmountFor"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.service.spec.ts
git commit -m "feat(econt): persist codAmountStotinki on label create"
```

---

### Task A2: Return `labelPdfUrl` from `listShipments`

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts`
- Test: `server/src/modules/econt/econt.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Append to `econt.service.spec.ts`:

```ts
import { mapShipmentRow } from './econt.service';

describe('mapShipmentRow', () => {
  it('passes labelPdfUrl, codAmount and a created status through', () => {
    const out = mapShipmentRow({
      orderId: '11111111-2222-3333-4444-555555555555',
      customerName: 'Иван',
      deliveryType: 'econt',
      total: 2400,
      shipmentId: 'aaaa',
      shipmentNumber: '1051000000001',
      shipmentStatus: 'created',
      courierPrice: 599,
      labelPdfUrl: 'https://ee.econt.com/x.pdf',
      codAmount: 2400,
      trackingJson: null,
    });
    expect(out.orderNumber).toBe('11111111');
    expect(out.method).toBe('econtOffice');
    expect(out.status).toBe('created');
    expect(out.trackingNumber).toBe('1051000000001');
    expect(out.priceStotinki).toBe(599);
    expect(out.labelPdfUrl).toBe('https://ee.econt.com/x.pdf');
    expect(out.history).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- -t "mapShipmentRow"`
Expected: FAIL — `mapShipmentRow is not exported`.

- [ ] **Step 3: Extract the row mapper, export it, and add `labelPdfUrl` to the query**

In `econt.service.ts`, define the row type + exported mapper near the bottom (next to `uiShipmentStatus`):

```ts
/** Raw joined row from listShipments' query. */
export interface ShipmentJoinRow {
  orderId: string;
  customerName: string | null;
  deliveryType: string | null;
  total: number | null;
  shipmentId: string | null;
  shipmentNumber: string | null;
  shipmentStatus: string | null;
  courierPrice: number | null;
  labelPdfUrl: string | null;
  codAmount: number | null;
  trackingJson: unknown;
}

/** Admin shipments-table row. */
export interface AdminShipment {
  orderId: string;
  orderNumber: string;
  customerName: string;
  method: 'econtOffice' | 'econtAddress';
  status: 'pending' | 'created' | 'shipped' | 'delivered';
  trackingNumber?: string;
  priceStotinki?: number;
  codAmountStotinki?: number;
  labelPdfUrl?: string;
  shipmentId?: string;
  history: { at: string; label: string; location?: string }[];
}

/** Map a joined query row onto the admin shipments-table shape. */
export function mapShipmentRow(r: ShipmentJoinRow): AdminShipment {
  return {
    orderId: r.orderId,
    orderNumber: r.orderId.slice(0, 8),
    customerName: r.customerName ?? '—',
    method: r.deliveryType === 'econt_address' ? 'econtAddress' : 'econtOffice',
    status: uiShipmentStatus(r.shipmentNumber, r.shipmentStatus),
    trackingNumber: r.shipmentNumber ?? undefined,
    priceStotinki: r.courierPrice ?? r.total ?? undefined,
    codAmountStotinki: r.codAmount ?? undefined,
    labelPdfUrl: r.labelPdfUrl ?? undefined,
    shipmentId: r.shipmentId ?? undefined,
    history: [], // Phase B fills this from trackingJson
  };
}
```

Rewrite `listShipments` to select the two extra columns and delegate to the mapper. Change its signature return type to `Promise<AdminShipment[]>` and the body:

```ts
async listShipments(tenantId: string): Promise<AdminShipment[]> {
  const rows = await this.db
    .select({
      orderId: orders.id,
      customerName: orders.customerName,
      deliveryType: orders.deliveryType,
      total: orders.totalStotinki,
      shipmentId: shipments.id,
      shipmentNumber: shipments.econtShipmentNumber,
      shipmentStatus: shipments.status,
      courierPrice: shipments.courierPriceStotinki,
      labelPdfUrl: shipments.labelPdfUrl,
      codAmount: shipments.codAmountStotinki,
      trackingJson: shipments.trackingJson,
    })
    .from(orders)
    .leftJoin(shipments, eq(shipments.orderId, orders.id))
    .where(
      and(
        eq(orders.tenantId, tenantId),
        inArray(orders.deliveryType, ['econt', 'econt_address']),
        ne(orders.status, 'cancelled'),
      ),
    )
    .orderBy(desc(orders.createdAt));

  return rows.map(mapShipmentRow);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- -t "mapShipmentRow"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.service.spec.ts
git commit -m "feat(econt): expose labelPdfUrl + codAmount in listShipments"
```

---

### Task A3: Install pdf-lib + service methods to fetch/merge label PDFs

**Files:**
- Modify: `server/package.json` (via pnpm add)
- Modify: `server/src/modules/econt/econt.service.ts`
- Test: `server/src/modules/econt/econt.service.spec.ts`

- [ ] **Step 1: Install pdf-lib**

Run: `pnpm --filter @fermeribg/api add pdf-lib`
Expected: `pdf-lib` appears in `server/package.json` dependencies; lockfile updated.

- [ ] **Step 2: Write the failing test (PDF merge)**

Append to `econt.service.spec.ts`:

```ts
import { PDFDocument } from 'pdf-lib';
import { mergePdfs } from './econt.service';

describe('mergePdfs', () => {
  async function onePager(): Promise<Buffer> {
    const doc = await PDFDocument.create();
    doc.addPage();
    return Buffer.from(await doc.save());
  }

  it('merges N single-page PDFs into one document with N pages', async () => {
    const merged = await mergePdfs([await onePager(), await onePager(), await onePager()]);
    const out = await PDFDocument.load(merged);
    expect(out.getPageCount()).toBe(3);
  });

  it('skips unreadable buffers rather than throwing', async () => {
    const merged = await mergePdfs([await onePager(), Buffer.from('not a pdf')]);
    const out = await PDFDocument.load(merged);
    expect(out.getPageCount()).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- -t "mergePdfs"`
Expected: FAIL — `mergePdfs is not exported`.

- [ ] **Step 4: Implement `mergePdfs` (module fn) + `getLabelPdf`/`getLabelsPdf` (service methods)**

At the top of `econt.service.ts` add the import:

```ts
import { PDFDocument } from 'pdf-lib';
```

Add the exported merge helper near `mapShipmentRow`:

```ts
/** Merge label PDFs into one document. Unreadable buffers are skipped (a single
 *  bad label must not fail the whole bulk print). */
export async function mergePdfs(buffers: Buffer[]): Promise<Buffer> {
  const merged = await PDFDocument.create();
  for (const buf of buffers) {
    try {
      const doc = await PDFDocument.load(buf);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    } catch {
      // skip a corrupt / non-PDF buffer
    }
  }
  return Buffer.from(await merged.save());
}
```

Add the two service methods in the shipments section (after `createLabel`). They reuse the private `resolveCreds` for the farm's Basic auth and fetch the Econt-hosted PDF server-side:

```ts
/** Fetch one shipment's label PDF (tenant-scoped) as a Buffer. */
async getLabelPdf(tenantId: string, shipmentId: string): Promise<Buffer> {
  const [row] = await this.db
    .select({ url: shipments.labelPdfUrl })
    .from(shipments)
    .where(and(eq(shipments.id, shipmentId), eq(shipments.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new NotFoundException('Пратката не е намерена');
  if (!row.url) throw new NotFoundException('Няма PDF за тази товарителница');
  return this.fetchLabelPdf(tenantId, row.url);
}

/** Fetch + merge several shipments' label PDFs (tenant-scoped) into one Buffer. */
async getLabelsPdf(tenantId: string, shipmentIds: string[]): Promise<Buffer> {
  if (!shipmentIds.length) throw new BadRequestException('Няма избрани товарителници');
  const rows = await this.db
    .select({ url: shipments.labelPdfUrl })
    .from(shipments)
    .where(and(eq(shipments.tenantId, tenantId), inArray(shipments.id, shipmentIds)));
  const urls = rows.map((r) => r.url).filter((u): u is string => !!u);
  const buffers: Buffer[] = [];
  for (const url of urls) {
    try {
      buffers.push(await this.fetchLabelPdf(tenantId, url));
    } catch {
      // skip a label whose PDF can't be fetched
    }
  }
  if (!buffers.length) throw new NotFoundException('Няма PDF за избраните товарителници');
  return mergePdfs(buffers);
}

/** GET an Econt-hosted label PDF using the farm's Basic credentials. */
private async fetchLabelPdf(tenantId: string, url: string): Promise<Buffer> {
  const c = await this.resolveCreds(tenantId);
  const auth = Buffer.from(`${c.username}:${c.password}`).toString('base64');
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new BadRequestException(
      `Econt PDF недостъпен: ${err instanceof Error ? err.message : 'network error'}`,
    );
  }
  if (!res.ok) throw new BadRequestException(`Econt PDF грешка (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- -t "mergePdfs"`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add server/package.json pnpm-lock.yaml server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.service.spec.ts
git commit -m "feat(econt): fetch + merge label PDFs server-side (pdf-lib)"
```

---

### Task A4: PDF endpoints on the controller

**Files:**
- Modify: `server/src/modules/econt/econt.controller.ts`

- [ ] **Step 1: Add the two GET endpoints**

In `econt.controller.ts`, extend the imports:

```ts
import {
  Controller, Get, Post, Delete, Param, Body, Query,
  UseGuards, ParseUUIDPipe, StreamableFile,
} from '@nestjs/common';
```

Add to `EcontController` (place the bulk route **before** the `:id` route so the static path wins):

```ts
/** Merged label PDF for several shipments (bulk print). */
@Get('labels.pdf')
async labels(
  @CurrentTenant() tenantId: string,
  @Query('ids') ids: string,
): Promise<StreamableFile> {
  const list = (ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const buf = await this.econt.getLabelsPdf(tenantId, list);
  return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="labels.pdf"' });
}

/** Single shipment label PDF (print). */
@Get('shipments/:id/label.pdf')
async label(
  @CurrentTenant() tenantId: string,
  @Param('id', ParseUUIDPipe) id: string,
): Promise<StreamableFile> {
  const buf = await this.econt.getLabelPdf(tenantId, id);
  return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="label.pdf"' });
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @fermeribg/api build`
Expected: build succeeds (nest build).

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/econt/econt.controller.ts
git commit -m "feat(econt): label.pdf + labels.pdf print endpoints"
```

---

### Task A5: Wire the client print buttons

**Files:**
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/components/delivery/shipments-table.tsx`

- [ ] **Step 1: Add `labelPdfUrl` to the `Shipment` type**

In `client/src/lib/types.ts`, in the `Shipment` interface (~line 280), add after `shipmentId?: string;`:

```ts
  /** When set, the farm can print the Econt waybill PDF. */
  labelPdfUrl?: string;
```

- [ ] **Step 2: Add a print helper and wire the single-row button**

In `shipments-table.tsx`, add a helper inside `ShipmentsTable` (near `copyTrack`):

```ts
const printOne = (r: Shipment) => {
  if (!r.shipmentId) return;
  window.open(`/bff/econt/shipments/${r.shipmentId}/label.pdf`, '_blank', 'noopener');
};
```

Replace BOTH fake single-print buttons (desktop `:221` and mobile `:270`) — currently `onClick={() => toast.info?.('Отваряне на PDF…')}` — with:

```tsx
<button className={actBtnCls} title="Принтирай" onClick={() => printOne(r)}>
  <Printer size={16} />
</button>
```

- [ ] **Step 3: Wire bulk print**

Add a helper inside `ShipmentsTable`:

```ts
const printSelected = () => {
  const ids = sel
    .map((id) => rows.find((x) => x.orderId === id)?.shipmentId)
    .filter((x): x is string => !!x);
  if (!ids.length) {
    toast.info?.('Избери товарителници със създаден етикет');
    return;
  }
  window.open(`/bff/econt/labels.pdf?ids=${ids.join(',')}`, '_blank', 'noopener');
};
```

Replace the bulk-print button (`:132`, currently `onClick={() => toast.info?.('Изпращане към принтер…')}`) with:

```tsx
<Button variant="ghost" size="sm" onClick={printSelected}>
  <Printer size={15} /> Принтирай избраните
</Button>
```

- [ ] **Step 4: Typecheck + build the client**

Run: `pnpm --filter @fermeribg/web build`
Expected: build succeeds, no type errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/types.ts client/src/components/delivery/shipments-table.tsx
git commit -m "feat(econt): wire real label print (single + bulk) via /bff proxy"
```

---

# PHASE B — Tracking events + "shipped" email + cron

### Task B1: Add `customerNotifiedAt` column + migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0053_*.sql` (generated)

- [ ] **Step 1: Add the column**

In `packages/db/src/schema.ts`, in the `shipments` table (~line 381, after `trackingJson`), add:

```ts
    customerNotifiedAt: timestamp('customer_notified_at', { withTimezone: true }),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @fermeribg/db generate`
Expected: a new `packages/db/drizzle/0053_*.sql` with `ALTER TABLE "shipments" ADD COLUMN "customer_notified_at" timestamp with time zone;` and a matching `meta/0053_snapshot.json`.

- [ ] **Step 3: Rebuild db dist**

Run: `pnpm --filter @fermeribg/db build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle
git commit -m "feat(db): shipments.customerNotifiedAt (migration 0053)"
```

---

### Task B2: `mapTrackingEvents` — Econt status payload → events

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts`
- Test: `server/src/modules/econt/econt.service.spec.ts`

> **Note on shape:** Econt `ShipmentService.getShipmentStatuses` returns
> `shipmentStatuses[].status` whose tracking history is an array (observed key:
> `trackingEvents`, each `{ time, officeName, destinationType }`; `time` is epoch-ms
> or an ISO string). The mapper below is defensive (tolerates a missing/renamed
> array and both time formats) — if the live demo payload differs, adjust only the
> `events` extraction line; the rest holds.

- [ ] **Step 1: Write the failing test**

Append to `econt.service.spec.ts`:

```ts
import { mapTrackingEvents } from './econt.service';

describe('mapTrackingEvents', () => {
  it('maps Econt trackingEvents into {at,label,location}', () => {
    const out = mapTrackingEvents({
      trackingEvents: [
        { time: '2026-06-23T08:00:00', officeName: 'Бургас Център', destinationType: 'office' },
        { time: '2026-06-23T14:30:00', officeName: 'София Изток', destinationType: 'delivery' },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0].location).toBe('Бургас Център');
    expect(typeof out[0].at).toBe('string');
    expect(out[0].label.length).toBeGreaterThan(0);
  });

  it('returns [] for null / shapeless payloads', () => {
    expect(mapTrackingEvents(null)).toEqual([]);
    expect(mapTrackingEvents({})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- -t "mapTrackingEvents"`
Expected: FAIL — `mapTrackingEvents is not exported`.

- [ ] **Step 3: Implement the mapper**

Add near `uiShipmentStatus` in `econt.service.ts`:

```ts
export interface TrackingEvent {
  at: string;
  label: string;
  location?: string;
}

/** Normalize an Econt tracking time (epoch-ms number or ISO/HH:mm string). */
function trackTime(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v).toISOString();
  if (typeof v === 'string' && v.length >= 5) return v;
  return '';
}

/** Map an Econt status payload's tracking history into UI events (newest last). */
export function mapTrackingEvents(status: unknown): TrackingEvent[] {
  const s = (status ?? {}) as Record<string, any>;
  const raw: any[] = Array.isArray(s.trackingEvents)
    ? s.trackingEvents
    : Array.isArray(s.tracking)
      ? s.tracking
      : [];
  return raw
    .map((e) => ({
      at: trackTime(e?.time ?? e?.cdDate ?? e?.date),
      label: String(e?.destinationType ?? e?.officeName ?? e?.tracking ?? 'Обновление').trim(),
      location: e?.officeName ? String(e.officeName) : undefined,
    }))
    .filter((e) => e.at || e.location);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- -t "mapTrackingEvents"`
Expected: PASS (2 tests).

- [ ] **Step 5: Use it in `mapShipmentRow`**

In `mapShipmentRow`, change the `history` line from `history: []` to:

```ts
    history: mapTrackingEvents(r.trackingJson),
```

Run the existing mapper test to confirm it still passes (its `trackingJson: null` → `history: []`):
Run: `pnpm --filter @fermeribg/api test -- -t "mapShipmentRow"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.service.spec.ts
git commit -m "feat(econt): map tracking events into shipment history"
```

---

### Task B3: `ShipmentEmailService` — the "shipped" email

**Files:**
- Create: `server/src/modules/econt/shipment-email.service.ts`
- Test: `server/src/modules/econt/shipment-email.service.spec.ts`

- [ ] **Step 1: Write the failing test (pure render + send)**

Create `server/src/modules/econt/shipment-email.service.spec.ts`:

```ts
import { trackingUrl } from './shipment-email.service';

describe('trackingUrl', () => {
  it('builds the Econt public tracking link, stripping spaces', () => {
    expect(trackingUrl('1051 0000 0001')).toBe(
      'https://www.econt.com/services/track-shipment/105100000001/',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- -t "trackingUrl"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `server/src/modules/econt/shipment-email.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Database, orders, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EmailService } from '../../common/email/email.service';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Econt's public tracking page for a waybill number. */
export function trackingUrl(number: string): string {
  return `https://www.econt.com/services/track-shipment/${number.replace(/\s/g, '')}/`;
}

/**
 * Emails the buyer that their parcel has shipped, with the Econt tracking link.
 * Self-contained (DB + EmailService only) and error-swallowing — a refresh cycle
 * must never fail because mail failed.
 */
@Injectable()
export class ShipmentEmailService {
  private readonly logger = new Logger(ShipmentEmailService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly email: EmailService,
  ) {}

  async sendShipped(orderId: string, shipmentNumber: string): Promise<void> {
    try {
      const [order] = await this.db
        .select({
          customerName: orders.customerName,
          customerEmail: orders.customerEmail,
          tenantId: orders.tenantId,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      const to = order?.customerEmail?.trim();
      if (!to) return;

      const [tenant] = order.tenantId
        ? await this.db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, order.tenantId)).limit(1)
        : [undefined];
      const farmName = tenant?.name ?? 'ФермериБГ';
      const safeFarmName = farmName.replace(/[\r\n]+/g, ' ').trim();
      const link = trackingUrl(shipmentNumber);

      await this.email.sendMail({
        to,
        subject: `Пратката ти е изпратена — ${safeFarmName}`.trim(),
        html: this.renderHtml(order.customerName, farmName, shipmentNumber, link),
        text: [
          `${farmName} — пратката ти е изпратена.`,
          order.customerName ? `Здравей, ${order.customerName}!` : '',
          `Товарителница: ${shipmentNumber}`,
          `Проследи: ${link}`,
        ].filter(Boolean).join('\n'),
        stream: 'transactional',
      });
    } catch (err) {
      this.logger.error(`shipped email failed for ${orderId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private renderHtml(customerName: string | null, farmName: string, number: string, link: string): string {
    const hi = customerName ? `Здравей, ${esc(customerName)}! ` : '';
    return `<!doctype html><html lang="bg"><body style="margin:0;background:#f6f4ec;font-family:Arial,Helvetica,sans-serif;color:#23210f">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ec;padding:28px 0"><tr><td align="center">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fffdf7;border:1px solid #e7e3d6;border-radius:16px;overflow:hidden">
      <tr><td style="background:#2d6a4f;padding:22px 28px;color:#eaf1e4;font-size:20px;font-weight:bold">🚚 ${esc(farmName)}</td></tr>
      <tr><td style="padding:28px">
        <h1 style="margin:0 0 6px;font-size:22px;color:#23210f">Пратката ти пътува!</h1>
        <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#4a4733">${hi}Поръчката ти беше предадена на Еконт и вече пътува към теб.</p>
        <div style="margin:18px 0;padding:14px 16px;background:#f3f6f0;border:1px solid #e1e9dd;border-radius:12px">
          <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#8a8770;margin-bottom:4px">Товарителница</div>
          <div style="font-size:16px;font-weight:bold;color:#23210f">${esc(number)}</div>
        </div>
        <p style="margin:22px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#2d6a4f;color:#fff;text-decoration:none;font-weight:bold;font-size:14px;padding:12px 20px;border-radius:10px">Проследи пратката</a></p>
      </td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #eee7d6;font-size:12px;color:#a8a594">${esc(farmName)} · Благодарим, че пазаруваш от местни производители 🌱</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- -t "trackingUrl"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt/shipment-email.service.ts server/src/modules/econt/shipment-email.service.spec.ts
git commit -m "feat(econt): ShipmentEmailService (shipped email + tracking link)"
```

---

### Task B4: Notify-on-ship inside `refreshStatus`

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts`
- Test: `server/src/modules/econt/econt.service.spec.ts`

- [ ] **Step 1: Write the failing test (the notify gate is a pure predicate)**

Append to `econt.service.spec.ts`:

```ts
import { shouldNotifyShipped } from './econt.service';

describe('shouldNotifyShipped', () => {
  it('notifies once on shipped/delivered when not yet notified', () => {
    expect(shouldNotifyShipped('shipped', null)).toBe(true);
    expect(shouldNotifyShipped('delivered', null)).toBe(true);
  });
  it('does not notify before shipping or after already notifying', () => {
    expect(shouldNotifyShipped('created', null)).toBe(false);
    expect(shouldNotifyShipped('pending', null)).toBe(false);
    expect(shouldNotifyShipped('shipped', new Date())).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- -t "shouldNotifyShipped"`
Expected: FAIL — `shouldNotifyShipped is not exported`.

- [ ] **Step 3: Add the predicate + inject the email service + notify in `refreshStatus`**

Add the predicate near `uiShipmentStatus`:

```ts
/** Send the buyer the "shipped" email exactly once — when the parcel first reaches
 *  shipped/delivered and we haven't notified before. */
export function shouldNotifyShipped(
  uiStatus: 'pending' | 'created' | 'shipped' | 'delivered',
  customerNotifiedAt: Date | string | null,
): boolean {
  return !customerNotifiedAt && (uiStatus === 'shipped' || uiStatus === 'delivered');
}
```

Inject `ShipmentEmailService` into the constructor (add the parameter last so existing positional test stubs only need one extra arg):

```ts
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    config: ConfigService,
    private readonly cache: PublicCacheService,
    private readonly shipmentEmail: ShipmentEmailService,
  ) {
    this.encKey = config.get<string>('ENCRYPTION_KEY', '');
  }
```

Add the import at top: `import { ShipmentEmailService } from './shipment-email.service';`

In `refreshStatus`, after the `.returning()` update, compute the UI status and fire the email through the gate (replace the `return updated;` tail):

```ts
  const newStatus = uiShipmentStatus(updated.econtShipmentNumber, updated.status);
  if (updated.econtShipmentNumber && shouldNotifyShipped(newStatus, row.customerNotifiedAt)) {
    await this.shipmentEmail.sendShipped(updated.orderId, updated.econtShipmentNumber);
    await this.db
      .update(shipments)
      .set({ customerNotifiedAt: new Date() })
      .where(eq(shipments.id, updated.id));
  }
  return updated;
```

Update the three positional `new EcontService(...)` calls in `econt.service.spec.ts` (the `buildLabel` and `codAmountFor` describes) to pass a 4th stub arg:

```ts
const svc = new EcontService({} as never, { get: () => '' } as never, {} as never, {} as never);
```

- [ ] **Step 4: Run the econt suite**

Run: `pnpm --filter @fermeribg/api test -- econt.service.spec`
Expected: PASS (all existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.service.spec.ts
git commit -m "feat(econt): email buyer once when parcel ships (refreshStatus gate)"
```

---

### Task B5: Repeatable cron to refresh active shipments

**Files:**
- Modify: `server/src/common/queue/queue.constants.ts`
- Modify: `server/src/modules/econt/econt.service.ts`
- Create: `server/src/modules/econt/econt.processor.ts`
- Modify: `server/src/modules/econt/econt.module.ts`

- [ ] **Step 1: Add the queue name**

In `server/src/common/queue/queue.constants.ts` add:

```ts
export const ECONT_QUEUE = 'econt';
```

- [ ] **Step 2: Add `refreshActiveShipments` to the service**

In `econt.service.ts`, add to the shipments section:

```ts
/**
 * Refresh every not-yet-delivered shipment that has a waybill, across all tenants.
 * Best-effort per shipment — one Econt failure never aborts the batch. Drives the
 * "shipped" email (via refreshStatus) and COD reconciliation (Phase C).
 */
async refreshActiveShipments(): Promise<{ refreshed: number }> {
  const rows = await this.db
    .select({
      id: shipments.id,
      tenantId: shipments.tenantId,
      number: shipments.econtShipmentNumber,
      status: shipments.status,
    })
    .from(shipments);
  let refreshed = 0;
  for (const r of rows) {
    if (!r.number) continue;
    if (uiShipmentStatus(r.number, r.status) === 'delivered') continue;
    try {
      await this.refreshStatus(r.tenantId, r.id);
      refreshed++;
    } catch (err) {
      this.logger.warn(
        `[econt] refresh failed for shipment ${r.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { refreshed };
}
```

- [ ] **Step 3: Create the processor**

Create `server/src/modules/econt/econt.processor.ts` (mirror `slots.processor.ts`):

```ts
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { EcontService } from './econt.service';
import { ECONT_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(ECONT_QUEUE)
export class EcontProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(EcontProcessor.name);

  constructor(
    private readonly econt: EcontService,
    @InjectQueue(ECONT_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    // Every 30 minutes — Econt statuses move on the order of hours.
    await registerRepeatable(this.queue, 'refresh-active', '*/30 * * * *');
  }

  async process(_job: Job): Promise<void> {
    const { refreshed } = await this.econt.refreshActiveShipments();
    this.logger.log(`[econt] refreshed ${refreshed} active shipment(s)`);
  }
}
```

- [ ] **Step 4: Wire the module (queue + email + worker gate)**

Replace `server/src/modules/econt/econt.module.ts` with:

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EcontService } from './econt.service';
import { EcontController, PublicEcontController } from './econt.controller';
import { EcontProcessor } from './econt.processor';
import { ShipmentEmailService } from './shipment-email.service';
import { EmailModule } from '../../common/email/email.module';
import { ECONT_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';

@Module({
  imports: [
    EmailModule,
    BullModule.registerQueue({
      name: ECONT_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    }),
  ],
  controllers: [EcontController, PublicEcontController],
  providers: [EcontService, ShipmentEmailService, ...(RUN_WORKERS ? [EcontProcessor] : [])],
  exports: [EcontService],
})
export class EcontModule {}
```

> Verify `EmailModule` exports `EmailService` (it must, since `OrderConfirmationService` consumes it). If `EmailModule`'s path differs, match the import used in `server/src/modules/order-email/*.module.ts`.

- [ ] **Step 5: Build the server**

Run: `pnpm --filter @fermeribg/api build`
Expected: build succeeds; DI resolves (EcontService gets ShipmentEmailService; processor only when RUN_WORKERS).

- [ ] **Step 6: Commit**

```bash
git add server/src/common/queue/queue.constants.ts server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.processor.ts server/src/modules/econt/econt.module.ts
git commit -m "feat(econt): repeatable cron to refresh active shipments"
```

---

### Task B6: "Обнови" button in the tracking modal

**Files:**
- Modify: `client/src/components/delivery/shipments-table.tsx`

- [ ] **Step 1: Pass a refresh handler into the modal**

`refreshShipment` already exists in `client/src/lib/api-client.ts`. In `shipments-table.tsx`, add a handler in `ShipmentsTable`:

```ts
const refreshTrack = async (r: Shipment) => {
  if (!r.shipmentId) return;
  try {
    await refreshShipment(r.shipmentId);
    await reload();
    toast.success('Проследяването е обновено');
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : 'Неуспешно обновяване');
  }
};
```

Add `refreshShipment` to the import from `@/lib/api-client`. Pass it to the modal:

```tsx
{track && (
  <TrackingModal
    shipment={track}
    onClose={() => setTrack(null)}
    onRefresh={() => refreshTrack(track)}
  />
)}
```

- [ ] **Step 2: Render the button in the modal**

Change `TrackingModal`'s signature to accept `onRefresh: () => void` and add a button in the header (next to the close button):

```tsx
<button
  type="button"
  onClick={onRefresh}
  className="grid h-[38px] w-[38px] place-items-center rounded-[10px] border border-ff-border bg-ff-surface-2 text-ff-ink-2 hover:bg-ff-green-50"
  title="Обнови"
>
  <Navigation size={18} />
</button>
```

(After refresh, `reload()` refetches `listShipments`, but the open modal holds a stale `track`. Keep it simple: the refresh updates the underlying list; the user reopens to see new events. If you want live update, lift `track` to read from `rows` by `orderId` — optional, out of scope here.)

- [ ] **Step 3: Typecheck + build the client**

Run: `pnpm --filter @fermeribg/web build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/delivery/shipments-table.tsx
git commit -m "feat(econt): manual refresh in tracking modal"
```

---

# PHASE C — COD reconciliation

### Task C0: SPIKE — confirm Econt COD fields (no production code)

**Goal:** learn which fields in the `getShipmentStatuses` response carry (a) COD collected from the customer and (b) COD settled/paid-out to the farm, with timestamps.

- [ ] **Step 1: Capture a real status payload**

Using a farm's **demo** Econt credentials, call the status endpoint for a COD shipment (an existing demo waybill number). One option — a throwaway node script run from the server package, or extend an existing `econt.service.spec` temporarily, hitting:
`POST https://demo.econt.com/ee/services/Shipments/ShipmentService.getShipmentStatuses.json`
body `{ "shipmentNumbers": ["<demo COD number>"] }`, header `Authorization: Basic <demo creds>`.

- [ ] **Step 2: Record the field names**

Write the observed COD field names + formats into a comment block at the top of the `parseCodReconciliation` function in Task C2 (e.g. `cdPaidTime`, `cdPaid`, `cdCollectedTime`, …). If the names differ from the assumptions in C2, change only the field-extraction lines there.

- [ ] **Step 3: No commit** (investigation only). Proceed to C1.

---

### Task C1: Add `codCollectedAt` + `codSettledAt` columns + migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0054_*.sql` (generated)

- [ ] **Step 1: Add the columns**

In `packages/db/src/schema.ts`, in `shipments` (after `customerNotifiedAt`):

```ts
    codCollectedAt: timestamp('cod_collected_at', { withTimezone: true }),
    codSettledAt: timestamp('cod_settled_at', { withTimezone: true }),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @fermeribg/db generate`
Expected: `0054_*.sql` adds both columns; `meta/0054_snapshot.json` written.

- [ ] **Step 3: Rebuild db dist**

Run: `pnpm --filter @fermeribg/db build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle
git commit -m "feat(db): shipments cod_collected_at + cod_settled_at (migration 0054)"
```

---

### Task C2: Parse + persist COD reconciliation in `refreshStatus`

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts`
- Test: `server/src/modules/econt/econt.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Append to `econt.service.spec.ts` (adjust the input field names to the C0 spike findings if they differ):

```ts
import { parseCodReconciliation } from './econt.service';

describe('parseCodReconciliation', () => {
  it('reads collected + settled timestamps when present', () => {
    const out = parseCodReconciliation({ cdCollectedTime: '2026-06-23T10:00:00', cdPaidTime: '2026-06-25T09:00:00' });
    expect(out.collectedAt).toBeInstanceOf(Date);
    expect(out.settledAt).toBeInstanceOf(Date);
  });
  it('returns nulls when absent', () => {
    expect(parseCodReconciliation({})).toEqual({ collectedAt: null, settledAt: null });
    expect(parseCodReconciliation(null)).toEqual({ collectedAt: null, settledAt: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- -t "parseCodReconciliation"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the parser + persist in `refreshStatus`**

Add near `uiShipmentStatus`:

```ts
/**
 * Extract COD reconciliation timestamps from an Econt status payload.
 * SPIKE (C0) field names — confirm against a live demo COD shipment and adjust the
 * two pick lines below if they differ:
 *   collected (customer paid the courier): `cdCollectedTime`
 *   settled   (Econt paid out to the farm): `cdPaidTime`
 */
export function parseCodReconciliation(status: unknown): { collectedAt: Date | null; settledAt: Date | null } {
  const s = (status ?? {}) as Record<string, any>;
  const toDate = (v: unknown): Date | null => {
    if (typeof v === 'number' && v > 0) return new Date(v);
    if (typeof v === 'string' && v.length >= 5) {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  };
  return { collectedAt: toDate(s.cdCollectedTime), settledAt: toDate(s.cdPaidTime) };
}
```

In `refreshStatus`, fold the COD timestamps into the existing update `.set({...})` (the call that sets `status`/`trackingJson`):

```ts
  const cod = parseCodReconciliation(st);
  const [updated] = await this.db
    .update(shipments)
    .set({
      status: st?.shortDeliveryStatus ?? st?.deliveryStatus ?? row.status,
      trackingJson: st ?? row.trackingJson,
      codCollectedAt: cod.collectedAt ?? row.codCollectedAt,
      codSettledAt: cod.settledAt ?? row.codSettledAt,
      updatedAt: new Date(),
    })
    .where(eq(shipments.id, shipmentId))
    .returning();
```

- [ ] **Step 4: Run the suite**

Run: `pnpm --filter @fermeribg/api test -- econt.service.spec`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.service.spec.ts
git commit -m "feat(econt): parse + persist COD collected/settled timestamps"
```

---

### Task C3: COD reconciliation endpoint

**Files:**
- Modify: `server/src/modules/econt/econt.service.ts`
- Modify: `server/src/modules/econt/econt.controller.ts`
- Modify: `client/src/lib/api-client.ts`

- [ ] **Step 1: Add the service method**

In `econt.service.ts`:

```ts
export interface CodReconRow {
  orderId: string;
  expectedStotinki: number | null;
  collectedAt: string | null;
  settledAt: string | null;
}

/** COD-via-Econt reconciliation rows for the Плащания screen. */
async codReconciliation(tenantId: string): Promise<CodReconRow[]> {
  const rows = await this.db
    .select({
      orderId: shipments.orderId,
      expected: shipments.codAmountStotinki,
      collectedAt: shipments.codCollectedAt,
      settledAt: shipments.codSettledAt,
    })
    .from(shipments)
    .where(and(eq(shipments.tenantId, tenantId), isNotNull(shipments.codAmountStotinki)));
  return rows.map((r) => ({
    orderId: r.orderId,
    expectedStotinki: r.expected ?? null,
    collectedAt: r.collectedAt ? r.collectedAt.toISOString() : null,
    settledAt: r.settledAt ? r.settledAt.toISOString() : null,
  }));
}
```

Add `isNotNull` to the `drizzle-orm` import at the top of the file (the import currently has `and, eq, desc, inArray, ne`):

```ts
import { and, eq, desc, inArray, ne, isNotNull } from 'drizzle-orm';
```

- [ ] **Step 2: Add the controller route**

In `econt.controller.ts`, in `EcontController`:

```ts
@Get('cod-reconciliation')
codReconciliation(@CurrentTenant() tenantId: string) {
  return this.econt.codReconciliation(tenantId);
}
```

- [ ] **Step 3: Add the api-client call**

In `client/src/lib/api-client.ts`, add:

```ts
export interface CodReconRow {
  orderId: string;
  expectedStotinki: number | null;
  collectedAt: string | null;
  settledAt: string | null;
}
export const getCodReconciliation = () =>
  apiFetch<CodReconRow[]>('econt/cod-reconciliation');
```

- [ ] **Step 4: Build server + client**

Run: `pnpm --filter @fermeribg/api build && pnpm --filter @fermeribg/web build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/econt/econt.service.ts server/src/modules/econt/econt.controller.ts client/src/lib/api-client.ts
git commit -m "feat(econt): COD reconciliation endpoint + api-client"
```

---

### Task C4: COD settlement badge in the Плащания COD tab

**Files:**
- Modify: `client/src/components/payments/payments-client.tsx`

- [ ] **Step 1: Fetch reconciliation when the COD tab is active**

In `payments-client.tsx`, import the call + type:

```ts
import { getCodReconciliation, type CodReconRow } from '@/lib/api-client';
```

Add state + a load effect:

```ts
const [codRecon, setCodRecon] = useState<Record<string, CodReconRow>>({});
useEffect(() => {
  if (tab !== 'cod') return;
  let alive = true;
  getCodReconciliation()
    .then((rows) => {
      if (!alive) return;
      setCodRecon(Object.fromEntries(rows.map((r) => [r.orderId, r])));
    })
    .catch(() => {/* leave empty — badge falls back to delivery-derived state */});
  return () => { alive = false; };
}, [tab]);
```

- [ ] **Step 2: Add the 3-state badge helper**

Add near the other helpers (after `moneyStatus`):

```ts
/** COD lifecycle from the Econt reconciliation row: Очаквано → Събрано → Преведено. */
function codSettlementBadge(recon: CodReconRow | undefined): { label: string; cls: string } {
  if (recon?.settledAt) return { label: 'Преведено', cls: 'bg-ff-green-100 text-ff-green-800' };
  if (recon?.collectedAt) return { label: 'Събрано', cls: 'bg-amber-100 text-amber-800' };
  return { label: 'Очаквано', cls: 'bg-ff-surface-2 text-ff-muted' };
}
```

- [ ] **Step 3: Render the badge in COD-tab rows**

In the COD tab's row rendering, where each order row is shown, add (keyed by `o.id`):

```tsx
{tab === 'cod' && (() => {
  const b = codSettlementBadge(codRecon[o.id]);
  return <span className={cn('rounded-full px-2 py-0.5 text-[12px] font-bold', b.cls)}>{b.label}</span>;
})()}
```

(Place it alongside the existing `moneyStatus` badge for the row. Match the surrounding row markup — the exact JSX wrapper depends on the row component; insert next to the existing status pill.)

- [ ] **Step 4: Typecheck + build the client**

Run: `pnpm --filter @fermeribg/web build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/payments/payments-client.tsx
git commit -m "feat(econt): COD settlement badge in Плащания (Очаквано→Събрано→Преведено)"
```

---

# Final verification

- [ ] **Run the full server test suite**

Run: `pnpm --filter @fermeribg/api test`
Expected: all green (existing + new econt tests).

- [ ] **Build everything**

Run: `pnpm --filter @fermeribg/db build && pnpm --filter @fermeribg/types build && pnpm --filter @fermeribg/api build && pnpm --filter @fermeribg/web build`
Expected: all succeed.

- [ ] **Lint the server**

Run: `pnpm --filter @fermeribg/api lint`
Expected: clean.

- [ ] **Deploy note**

Migrations 0053 + 0054 run automatically on API boot (`runMigrations` in `main.ts`). `main` auto-deploys to Hetzner — only merge when A–C are verified. New runtime needs: `pdf-lib` installed (`pnpm install` on deploy), `ENCRYPTION_KEY` set (already required), email transport configured (already required), and a worker (`RUN_WORKERS`) for the cron.

# Spec coverage self-check

- Print (A) → A3/A4/A5 ✅ · COD persist (A) → A1 ✅
- Tracking events (B) → B2 ✅ · shipped email on real ship (B) → B3/B4 ✅ · cron auto-refresh (B) → B5 ✅
- COD reconciliation via Econt report (C) → C0 spike + C2/C3/C4 ✅
- Phase D → documented in the spec, intentionally not in this plan ✅
- Graceful degradation / tenant isolation / BG i18n → preserved across all tasks ✅
