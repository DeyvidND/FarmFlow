# Ръчно изпращане на поръчки към фермери — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Организаторът на multi-farmer магазин ръчно праща на избрани фермери имейл с поръчките им за избран диапазон дати и статуси.

**Architecture:** Reuse на съществуващата per-farmer digest логика в `DigestService`. Ново: `scheduledForRange` WHERE-helper, range email асемблер (рефактор на дневния), on-demand service метод + endpoint, UI бутон + модал в Фермери страницата.

**Tech Stack:** NestJS + Drizzle (backend), Jest (тестове), Next.js + React + Tailwind (client), class-validator (DTO).

## Global Constraints

- BG UI текст навсякъде; пари „25,99 €" формат (не се пипа тук).
- Subject без „тест": `Твоите поръчки за <период> — ФермериБГ`.
- Разрешени статуси (whitelist): `pending`, `confirmed`, `delivered`. `cancelled` никога.
- Диапазон cap: **31 дни**.
- Cron пътят (`sendFarmerDigests`, `assembleFarmerDigest`, `POST /digest/test`) НЕ променя поведение — само се рефакторира вътрешно.
- `sendMail` е през queue (`EMAIL_QUEUE`) — не блокира заявката.
- Feature е само за `tenants.multiFarmer === true`.

---

### Task 1: `scheduledForRange` WHERE-helper

**Files:**
- Modify: `server/src/modules/orders/order-scheduling.ts`
- Test: `server/src/modules/orders/order-scheduling.spec.ts` (create)

**Interfaces:**
- Consumes: `bgDayBounds(date)` from `common/time/bg-time` (returns `{from: Date, to: Date}`), Drizzle `orders`, `deliverySlots`.
- Produces: `scheduledForRange(from: string, to: string): SQL` — orders whose slot date ∈ `[from,to]` OR (slotless AND `createdAt` ∈ `[bgDayBounds(from).from, bgDayBounds(to).to)`). Requires `leftJoin(deliverySlots, orders.slotId = deliverySlots.id)`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/modules/orders/order-scheduling.spec.ts
import { scheduledForRange } from './order-scheduling';

describe('scheduledForRange', () => {
  it('builds a defined SQL condition for a valid range', () => {
    const cond = scheduledForRange('2026-07-10', '2026-07-12');
    expect(cond).toBeDefined();
    // Serialized SQL should reference both the slot-date range and the slotless
    // createdAt fallback (gte/lt on orders.created_at).
    const sql = JSON.stringify(cond);
    expect(sql).toContain('date');
    expect(sql).toContain('created_at');
  });

  it('for a single-day range still includes the slotless createdAt fallback', () => {
    const cond = scheduledForRange('2026-07-10', '2026-07-10');
    expect(JSON.stringify(cond)).toContain('created_at');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest order-scheduling.spec.ts`
Expected: FAIL — `scheduledForRange` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `server/src/modules/orders/order-scheduling.ts` (extend the existing `import` from drizzle to include `lte` if missing — current import is `and, eq, gte, isNull, lt, or`; add `lte`):

```typescript
/**
 * Range variant of {@link scheduledForDay}. Selects orders "scheduled for" any
 * BG calendar day in [from, to] (inclusive). A slotted order counts on its slot
 * date; a slotless order falls back to its creation day. Same leftJoin
 * requirement as scheduledForDay.
 */
export function scheduledForRange(from: string, to: string) {
  const lo = bgDayBounds(from).from; // start of `from` day
  const hi = bgDayBounds(to).to; // end (exclusive) of `to` day
  return or(
    and(gte(deliverySlots.date, from), lte(deliverySlots.date, to)),
    and(isNull(orders.slotId), gte(orders.createdAt, lo), lt(orders.createdAt, hi)),
  )!;
}
```

Update the drizzle import line at the top of the file to:

```typescript
import { and, eq, gte, isNull, lt, lte, or } from 'drizzle-orm';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx jest order-scheduling.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/order-scheduling.ts server/src/modules/orders/order-scheduling.spec.ts
git commit -m "feat(orders): scheduledForRange WHERE-helper for date-range digests"
```

---

### Task 2: Range email assembler (refactor day renderer)

**Files:**
- Modify: `server/src/modules/digest/digest.service.ts`
- Test: `server/src/modules/digest/digest-range.spec.ts` (create)

**Interfaces:**
- Consumes: existing module-private `renderFarmerHtml`, `renderFarmerText`, `harvestSummary`, `hhmm`, `escapeHtml`, `econtDestination`, types `FarmerOrder`, `FarmerItem`, `FarmerDigestRow`, `DigestResult`.
- Produces: new module-private pure functions:
  - `groupFarmerRows(rows: FarmerDigestRow[]): { addressOrders: FarmerOrder[]; econtOrders: FarmerOrder[]; pickupOrders: FarmerOrder[]; prep: FarmerItem[] }`
  - `renderFarmerSectionsHtml(prep, addressOrders, econtOrders, pickupOrders): string` (inner, no `<html>` wrapper — the prep table + 3 delivery-type sections)
  - `assembleFarmerRangeEmail(from: string, to: string, farmerName: string, byDay: Map<string, FarmerDigestRow[]>): DigestResult | null` (null when every day is empty)

**Note:** `assembleFarmerDigest` and `renderFarmerHtml` must keep identical output for the cron path — the refactor only extracts the inner sections so both the single-day wrapper and the range wrapper can reuse them.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/modules/digest/digest-range.spec.ts
import { __rangeInternals } from './digest.service';

const { assembleFarmerRangeEmail } = __rangeInternals;

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  orderId: 'o1',
  deliveryType: 'address',
  customerName: 'Иван',
  deliveryAddress: 'ул. Роза 5',
  deliveryCity: 'София',
  econtOffice: null,
  slotFrom: '09:00:00',
  slotTo: '12:00:00',
  productName: 'Домати',
  quantity: 3,
  ...over,
});

describe('assembleFarmerRangeEmail', () => {
  it('returns null when every day is empty', () => {
    const res = assembleFarmerRangeEmail('2026-07-10', '2026-07-12', 'Иван', new Map());
    expect(res).toBeNull();
  });

  it('renders one section per non-empty day and skips empty days', () => {
    const byDay = new Map<string, any[]>([
      ['2026-07-10', [row({ orderId: 'a' })]],
      ['2026-07-11', []],
      ['2026-07-12', [row({ orderId: 'b', customerName: 'Мария' })]],
    ]);
    const res = assembleFarmerRangeEmail('2026-07-10', '2026-07-12', 'Иван', byDay)!;
    expect(res).not.toBeNull();
    // Both non-empty days present; the empty middle day is not.
    expect(res.html).toContain('2026-07-10');
    expect(res.html).toContain('2026-07-12');
    expect(res.html.match(/2026-07-11/g)).toBeNull();
    // Single wrapping document, not concatenated docs.
    expect(res.html.match(/<!DOCTYPE html>/g)!.length).toBe(1);
    expect(res.html).toContain('Иван'); // farmer name in header
    expect(res.text).toContain('Домати');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest digest-range.spec.ts`
Expected: FAIL — `__rangeInternals` not exported.

- [ ] **Step 3: Refactor + implement**

In `digest.service.ts`:

**(a)** Extract the grouping out of `assembleFarmerDigest`. Add this module-private function (near the other helpers, before the class):

```typescript
/** Pure grouping of a farmer's day rows into delivery-type buckets + prep list.
 *  Shared by the single-day digest and the range email. */
function groupFarmerRows(rows: FarmerDigestRow[]): {
  addressOrders: FarmerOrder[];
  econtOrders: FarmerOrder[];
  pickupOrders: FarmerOrder[];
  prep: FarmerItem[];
} {
  const byOrder = new Map<string, FarmerOrder>();
  for (const r of rows) {
    let o = byOrder.get(r.orderId);
    if (!o) {
      o = {
        id: r.orderId,
        deliveryType: r.deliveryType,
        customerName: r.customerName,
        deliveryAddress: r.deliveryAddress,
        deliveryCity: r.deliveryCity,
        econtOffice: r.econtOffice,
        slotFrom: r.slotFrom,
        slotTo: r.slotTo,
        paymentMethod: 'online',
        totalStotinki: 0,
        items: [],
      };
      byOrder.set(r.orderId, o);
    }
    o.items.push({ productName: r.productName ?? '—', quantity: r.quantity });
  }
  const orderList = [...byOrder.values()];
  return {
    addressOrders: orderList.filter((o) => o.deliveryType === 'address'),
    econtOrders: orderList.filter(
      (o) => o.deliveryType === 'econt' || o.deliveryType === 'econt_address',
    ),
    pickupOrders: orderList.filter((o) => o.deliveryType === 'pickup'),
    prep: harvestSummary(rows),
  };
}
```

Then rewrite the body of the private method `assembleFarmerDigest` to use it (keep the same return shape / output):

```typescript
  private assembleFarmerDigest(
    date: string,
    farmerName: string,
    rows: FarmerDigestRow[],
  ): DigestResult | null {
    if (rows.length === 0) return null;
    const { addressOrders, econtOrders, pickupOrders, prep } = groupFarmerRows(rows);
    const distinctCustomers = new Set(
      [...addressOrders, ...econtOrders, ...pickupOrders].map((o) =>
        o.customerName?.trim().toLowerCase(),
      ),
    ).size;
    return {
      html: renderFarmerHtml(date, farmerName, prep, addressOrders, econtOrders, pickupOrders),
      text: renderFarmerText(date, farmerName, prep, addressOrders, econtOrders, pickupOrders),
      summary: {
        selfDeliveryCount: addressOrders.length,
        econtCount: econtOrders.length,
        totalOrders: addressOrders.length + econtOrders.length + pickupOrders.length,
        distinctCustomers,
      },
    };
  }
```

**(b)** Extract the inner sections of `renderFarmerHtml` into a reusable fragment. Add:

```typescript
/** Inner HTML fragment for one day: prep table + pickup/address/econt sections.
 *  No <html>/<body> wrapper — shared by the single-day email and range email. */
function renderFarmerSectionsHtml(
  prep: FarmerItem[],
  addressOrders: FarmerOrder[],
  econtOrders: FarmerOrder[],
  pickupOrders: FarmerOrder[],
): string {
  const prepRows = prep
    .map(
      (p) => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(p.productName)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right"><strong>${p.quantity}</strong> бр</td>
        </tr>`,
    )
    .join('');

  const orderBlock = (o: FarmerOrder, dest: string): string => {
    const itemLines = o.items
      .map((it) => `<li>${escapeHtml(it.productName)} — <strong>${it.quantity}</strong> бр</li>`)
      .join('');
    return `
      <div style="margin:0 0 12px;padding:10px 12px;border:1px solid #eee;border-radius:8px">
        <div style="font-weight:bold">${escapeHtml(o.customerName ?? '—')}</div>
        <div style="font-size:13px;color:#555">${escapeHtml(dest)}</div>
        <ul style="margin:6px 0 0;padding-left:18px;font-size:14px">${itemLines}</ul>
      </div>`;
  };

  const pickupSection =
    pickupOrders.length > 0
      ? `<h2 style="font-size:16px;color:#333;margin:24px 0 8px">За вземане (${pickupOrders.length})</h2>` +
        pickupOrders.map((o) => orderBlock(o, 'За вземане на място')).join('')
      : '';
  const addressSection =
    addressOrders.length > 0
      ? `<h2 style="font-size:16px;color:#333;margin:24px 0 8px">Доставка до адрес (${addressOrders.length})</h2>` +
        addressOrders
          .map((o) => {
            const slot = o.slotFrom && o.slotTo ? ` · ${hhmm(o.slotFrom)}–${hhmm(o.slotTo)}` : '';
            return orderBlock(o, `${o.deliveryAddress ?? '—'}${slot}`);
          })
          .join('')
      : '';
  const econtSection =
    econtOrders.length > 0
      ? `<h2 style="font-size:16px;color:#333;margin:24px 0 8px">Еконт — за изпращане (${econtOrders.length})</h2>` +
        econtOrders.map((o) => orderBlock(o, econtDestination(o))).join('')
      : '';

  return `<h2 style="font-size:16px;color:#333;margin:20px 0 8px">За приготвяне</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px"><tbody>${prepRows}</tbody></table>
  ${pickupSection}
  ${addressSection}
  ${econtSection}`;
}
```

Then change `renderFarmerHtml`'s `return` to reuse the fragment (replacing the inline prep/pickup/address/econt block, keeping the outer wrapper + h1 identical):

```typescript
  return `<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>Твоите доставки за ${date}</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <h1 style="font-size:20px;color:#2d6a4f;border-bottom:2px solid #2d6a4f;padding-bottom:8px">
    ${escapeHtml(farmerName)} — доставки за ${date}
  </h1>
  ${renderFarmerSectionsHtml(prep, addressOrders, econtOrders, pickupOrders)}
  <p style="font-size:12px;color:#999;margin-top:32px">ФермериБГ — автоматичен дайджест за фермер</p>
</body>
</html>`;
```

(`renderFarmerHtml` still takes `date`/`farmerName` for the h1; the `prepRows`/`orderBlock` locals it previously declared are now gone — delete them from `renderFarmerHtml`.)

**(c)** Add the range renderer + assembler:

```typescript
/** stotinki-free header period label, e.g. "10.07.2026 – 12.07.2026" or a single day. */
function periodLabel(from: string, to: string): string {
  return from === to ? from : `${from} – ${to}`;
}

/** One farmer's multi-day order email. `byDay` keyed by YYYY-MM-DD. */
function assembleFarmerRangeEmail(
  from: string,
  to: string,
  farmerName: string,
  byDay: Map<string, FarmerDigestRow[]>,
): DigestResult | null {
  const days = [...byDay.entries()]
    .filter(([, rows]) => rows.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (days.length === 0) return null;

  let totalOrders = 0;
  const htmlSections: string[] = [];
  const textSections: string[] = [];
  for (const [date, rows] of days) {
    const { addressOrders, econtOrders, pickupOrders, prep } = groupFarmerRows(rows);
    totalOrders += addressOrders.length + econtOrders.length + pickupOrders.length;
    htmlSections.push(
      `<h2 style="font-size:18px;color:#2d6a4f;margin:28px 0 4px;border-bottom:1px solid #cde">${date}</h2>` +
        renderFarmerSectionsHtml(prep, addressOrders, econtOrders, pickupOrders),
    );
    textSections.push(
      `=== ${date} ===\n` + renderFarmerText(date, farmerName, prep, addressOrders, econtOrders, pickupOrders),
    );
  }

  const label = periodLabel(from, to);
  const html = `<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>Твоите поръчки за ${label}</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <h1 style="font-size:20px;color:#2d6a4f;border-bottom:2px solid #2d6a4f;padding-bottom:8px">
    ${escapeHtml(farmerName)} — поръчки за ${label}
  </h1>
  ${htmlSections.join('\n')}
  <p style="font-size:12px;color:#999;margin-top:32px">ФермериБГ</p>
</body>
</html>`;
  const text = `${escapeHtml(farmerName)} — поръчки за ${label}\n\n${textSections.join('\n\n')}`;

  return {
    html,
    text,
    summary: { selfDeliveryCount: 0, econtCount: 0, totalOrders, distinctCustomers: 0 },
  };
}
```

**(d)** At the very bottom of `digest.service.ts`, export a test hook:

```typescript
/** Test-only surface for the pure range assembler. */
export const __rangeInternals = { assembleFarmerRangeEmail };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest digest-range.spec.ts digest.service.spec.ts`
Expected: PASS — new range tests green AND existing `digest.service.spec.ts` still green (regression on the refactored cron path).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/digest/digest.service.ts server/src/modules/digest/digest-range.spec.ts
git commit -m "refactor(digest): extract day fragment + add range email assembler"
```

---

### Task 3: `sendFarmerOrderEmails` service method

**Files:**
- Modify: `server/src/modules/digest/digest.service.ts`
- Test: `server/src/modules/digest/digest-send-range.spec.ts` (create)

**Interfaces:**
- Consumes: `scheduledForRange` (Task 1), `assembleFarmerRangeEmail` (Task 2), `this.db`, `this.email.sendMail`, drizzle `orders/orderItems/products/deliverySlots/farmers/tenants`, `inArray` from drizzle.
- Produces: public method
  `sendFarmerOrderEmails(tenantId: string, opts: { from: string; to: string; farmerIds: string[]; statuses: string[] }): Promise<{ sent: number; skipped: number }>`

- [ ] **Step 1: Write the failing tests**

```typescript
// server/src/modules/digest/digest-send-range.spec.ts
import { Test } from '@nestjs/testing';
import { Logger, BadRequestException } from '@nestjs/common';
import { DigestService } from './digest.service';
import { EmailService } from '../../common/email/email.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

const OPTS = { from: '2026-07-10', to: '2026-07-12', farmerIds: ['f1', 'f2'], statuses: ['confirmed'] };

// db mock: `.where()` resolves depending on which query is running. We stage the
// return values in order: [tenant lookup, farmers lookup, line-items lookup].
function makeService(stages: {
  tenant?: Record<string, unknown> | null;
  farmers?: Record<string, unknown>[];
  lineItems?: Record<string, unknown>[];
}) {
  const email = { sendMail: jest.fn().mockResolvedValue(undefined) };
  let call = 0;
  const chain: any = {};
  chain.select = jest.fn(() => chain);
  chain.from = jest.fn(() => chain);
  chain.innerJoin = jest.fn(() => chain);
  chain.leftJoin = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn(() => Promise.resolve(stages.tenant === null ? [] : [stages.tenant ?? { multiFarmer: true }]));
  chain.where = jest.fn(() => {
    // 1st where → farmers list; 2nd where → line items. (tenant lookup uses .limit)
    call += 1;
    if (call === 1) return Promise.resolve(stages.farmers ?? []);
    return Promise.resolve(stages.lineItems ?? []);
  });
  return { service: new DigestService(chain as never, email as never), email };
}

describe('DigestService.sendFarmerOrderEmails', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('rejects a non-multiFarmer tenant', async () => {
    const { service } = makeService({ tenant: { multiFarmer: false } });
    await expect(service.sendFarmerOrderEmails('t', OPTS)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects from > to', async () => {
    const { service } = makeService({ tenant: { multiFarmer: true } });
    await expect(
      service.sendFarmerOrderEmails('t', { ...OPTS, from: '2026-07-20', to: '2026-07-10' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a range wider than 31 days', async () => {
    const { service } = makeService({ tenant: { multiFarmer: true } });
    await expect(
      service.sendFarmerOrderEmails('t', { ...OPTS, from: '2026-07-01', to: '2026-08-15' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when statuses contain nothing allowed (cancelled stripped)', async () => {
    const { service } = makeService({ tenant: { multiFarmer: true } });
    await expect(
      service.sendFarmerOrderEmails('t', { ...OPTS, statuses: ['cancelled', 'bogus'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when no selected farmer resolves for the tenant', async () => {
    const { service } = makeService({ tenant: { multiFarmer: true }, farmers: [] });
    await expect(service.sendFarmerOrderEmails('t', OPTS)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sends to farmers with orders, skips farmers with none', async () => {
    const { service, email } = makeService({
      tenant: { multiFarmer: true },
      farmers: [
        { id: 'f1', name: 'Иван', email: 'ivan@x.bg' },
        { id: 'f2', name: 'Мария', email: 'maria@x.bg' },
      ],
      lineItems: [
        {
          farmerId: 'f1',
          orderId: 'o1',
          deliveryType: 'address',
          customerName: 'Клиент',
          deliveryAddress: 'ул. 1',
          deliveryCity: 'София',
          econtOffice: null,
          slotFrom: '09:00:00',
          slotTo: '12:00:00',
          slotDate: '2026-07-10',
          productName: 'Домати',
          quantity: 2,
        },
      ],
    });
    const res = await service.sendFarmerOrderEmails('t', OPTS);
    expect(res).toEqual({ sent: 1, skipped: 1 });
    expect(email.sendMail).toHaveBeenCalledTimes(1);
    expect(email.sendMail.mock.calls[0][0].to).toBe('ivan@x.bg');
    expect(email.sendMail.mock.calls[0][0].subject).toContain('Твоите поръчки за');
  });

  it('does not abort remaining farmers when one sendMail throws', async () => {
    const { service, email } = makeService({
      tenant: { multiFarmer: true },
      farmers: [
        { id: 'f1', name: 'Иван', email: 'ivan@x.bg' },
        { id: 'f2', name: 'Мария', email: 'maria@x.bg' },
      ],
      lineItems: [
        { farmerId: 'f1', orderId: 'o1', deliveryType: 'pickup', customerName: 'A', deliveryAddress: null, deliveryCity: null, econtOffice: null, slotFrom: null, slotTo: null, slotDate: '2026-07-10', productName: 'P', quantity: 1 },
        { farmerId: 'f2', orderId: 'o2', deliveryType: 'pickup', customerName: 'B', deliveryAddress: null, deliveryCity: null, econtOffice: null, slotFrom: null, slotTo: null, slotDate: '2026-07-10', productName: 'Q', quantity: 1 },
      ],
    });
    email.sendMail.mockRejectedValueOnce(new Error('smtp down'));
    const res = await service.sendFarmerOrderEmails('t', OPTS);
    expect(email.sendMail).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ sent: 1, skipped: 1 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx jest digest-send-range.spec.ts`
Expected: FAIL — `sendFarmerOrderEmails` is not a function.

- [ ] **Step 3: Implement the method**

In `digest.service.ts`, ensure the drizzle import includes `inArray` and `lte`:

```typescript
import { and, eq, inArray, isNotNull, lte, or } from 'drizzle-orm';
```

Add the constant near the top (module scope):

```typescript
const ALLOWED_STATUSES = ['pending', 'confirmed', 'delivered'] as const;
const MAX_RANGE_DAYS = 31;
```

Add `BadRequestException` to the `@nestjs/common` import. Add `scheduledForRange` to the existing import from `../orders/order-scheduling`. Then add the public method to the `DigestService` class:

```typescript
  /**
   * Organizer-triggered: email each SELECTED farmer their own orders for the
   * [from,to] BG-day range, limited to the chosen statuses. Reuses the range
   * assembler. One batch line-item query (no N+1). Per-farmer try/catch so a
   * single failed send doesn't abort the rest. Returns how many farmers were
   * emailed vs skipped (selected, has email, but no orders / send failed).
   */
  async sendFarmerOrderEmails(
    tenantId: string,
    opts: { from: string; to: string; farmerIds: string[]; statuses: string[] },
  ): Promise<{ sent: number; skipped: number }> {
    const { from, to } = opts;

    const [tenant] = await this.db
      .select({ multiFarmer: tenants.multiFarmer })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant?.multiFarmer) {
      throw new BadRequestException('Тази функция е само за магазини с няколко фермери.');
    }
    if (from > to) {
      throw new BadRequestException('Началната дата е след крайната.');
    }
    // Inclusive day span. (Both are YYYY-MM-DD; parse as UTC midnight.)
    const spanDays =
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    if (spanDays > MAX_RANGE_DAYS) {
      throw new BadRequestException(`Периодът е твърде голям (макс. ${MAX_RANGE_DAYS} дни).`);
    }

    const statuses = opts.statuses.filter((s) =>
      (ALLOWED_STATUSES as readonly string[]).includes(s),
    );
    if (statuses.length === 0) {
      throw new BadRequestException('Изберете поне един валиден статус.');
    }
    if (opts.farmerIds.length === 0) {
      throw new BadRequestException('Изберете поне един фермер.');
    }

    // Selected farmers that actually belong to this tenant AND have an email.
    const farmerRows = await this.db
      .select({ id: farmers.id, name: farmers.name, email: farmers.email })
      .from(farmers)
      .where(
        and(
          eq(farmers.tenantId, tenantId),
          inArray(farmers.id, opts.farmerIds),
          isNotNull(farmers.email),
        )!,
      );
    if (farmerRows.length === 0) {
      throw new BadRequestException('Няма избран фермер с имейл адрес.');
    }

    // One batch query for every selected farmer's line items across the range.
    const rows = await this.db
      .select({
        farmerId: products.farmerId,
        orderId: orders.id,
        deliveryType: orders.deliveryType,
        customerName: orders.customerName,
        deliveryAddress: orders.deliveryAddress,
        deliveryCity: orders.deliveryCity,
        econtOffice: orders.econtOffice,
        slotFrom: deliverySlots.timeFrom,
        slotTo: deliverySlots.timeTo,
        slotDate: deliverySlots.date,
        productName: orderItems.productName,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .innerJoin(products, eq(orderItems.productId, products.id))
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          inArray(orders.status, statuses as string[]),
          scheduledForRange(from, to),
          inArray(products.farmerId, farmerRows.map((f) => f.id)),
        )!,
      )
      .orderBy(orders.createdAt);

    // Group rows: farmerId → (slotDate-or-null bucketed to a day) → rows.
    // Slotless orders count on their scheduled day; for range display we bucket
    // them under `from` day when slotDate is null (they were selected by the
    // createdAt fallback in scheduledForRange, so their exact day isn't in the
    // slot column — group them under the range start so they still appear).
    const byFarmer = new Map<string, Map<string, typeof rows>>();
    for (const r of rows) {
      const fid = r.farmerId;
      if (!fid) continue;
      const day = (r.slotDate as string | null) ?? from;
      const farmerMap = byFarmer.get(fid) ?? new Map();
      const dayRows = farmerMap.get(day) ?? [];
      dayRows.push(r);
      farmerMap.set(day, dayRows);
      byFarmer.set(fid, farmerMap);
    }

    let sent = 0;
    let skipped = 0;
    for (const f of farmerRows) {
      const byDay = byFarmer.get(f.id);
      const email = assembleFarmerRangeEmail(from, to, f.name, byDay ?? new Map());
      if (!email) {
        skipped++;
        continue;
      }
      try {
        await this.email.sendMail({
          to: f.email!,
          subject: `Твоите поръчки за ${periodLabelPublic(from, to)} — ФермериБГ`,
          html: email.html,
          text: email.text,
        });
        sent++;
        this.logger.log(`[digest] farmer-orders sent tenant=${tenantId} farmer=${f.id}`);
      } catch (err) {
        skipped++;
        this.logger.error(
          `[digest] farmer-orders failed tenant=${tenantId} farmer=${f.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { sent, skipped };
  }
```

Expose the subject label helper (the module-private `periodLabel` from Task 2 is fine to reuse — export a thin alias so the method above compiles without touching class scope):

```typescript
function periodLabelPublic(from: string, to: string): string {
  return periodLabel(from, to);
}
```

(If `periodLabel` is already in module scope from Task 2, `periodLabelPublic` simply forwards to it. Do not redefine `periodLabel`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx jest digest-send-range.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/digest/digest.service.ts server/src/modules/digest/digest-send-range.spec.ts
git commit -m "feat(digest): sendFarmerOrderEmails — organizer manual range send"
```

---

### Task 4: DTO + controller endpoint

**Files:**
- Create: `server/src/modules/digest/dto/send-farmer-orders.dto.ts`
- Modify: `server/src/modules/digest/digest.controller.ts`
- Test: `server/src/modules/digest/digest.controller.spec.ts` (create)

**Interfaces:**
- Consumes: `DigestService.sendFarmerOrderEmails` (Task 3), `JwtAuthGuard`, `@CurrentTenant()`.
- Produces: `POST /digest/farmers/send` accepting `SendFarmerOrdersDto`, returning `{ sent: number; skipped: number }`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/modules/digest/digest.controller.spec.ts
import { DigestController } from './digest.controller';

describe('DigestController.sendFarmerOrders', () => {
  it('delegates to the service with tenant + body', async () => {
    const service = {
      sendFarmerOrderEmails: jest.fn().mockResolvedValue({ sent: 2, skipped: 1 }),
    } as any;
    const controller = new DigestController(service);
    const body = { from: '2026-07-10', to: '2026-07-12', farmerIds: ['f1'], statuses: ['confirmed'] };
    const res = await controller.sendFarmerOrders('tenant-1', body as any);
    expect(service.sendFarmerOrderEmails).toHaveBeenCalledWith('tenant-1', body);
    expect(res).toEqual({ sent: 2, skipped: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx jest digest.controller.spec.ts`
Expected: FAIL — `controller.sendFarmerOrders` is not a function.

- [ ] **Step 3: Create the DTO**

```typescript
// server/src/modules/digest/dto/send-farmer-orders.dto.ts
import { IsArray, IsIn, IsUUID, Matches, ArrayNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Organizer-triggered manual send of per-farmer order emails for a date range. */
export class SendFarmerOrdersDto {
  @ApiProperty({ example: '2026-07-10' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from трябва да е YYYY-MM-DD' })
  from!: string;

  @ApiProperty({ example: '2026-07-12' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to трябва да е YYYY-MM-DD' })
  to!: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  farmerIds!: string[];

  @ApiProperty({ type: [String], example: ['confirmed'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['pending', 'confirmed', 'delivered'], { each: true })
  statuses!: string[];
}
```

- [ ] **Step 4: Add the route**

Modify `server/src/modules/digest/digest.controller.ts` — add `Body` to the `@nestjs/common` import, import the DTO, and add the handler inside the class:

```typescript
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
// ...existing imports...
import { SendFarmerOrdersDto } from './dto/send-farmer-orders.dto';
```

```typescript
  /** Organizer manually emails selected farmers their orders for a date range. */
  @Post('farmers/send')
  sendFarmerOrders(
    @CurrentTenant() tenantId: string,
    @Body() dto: SendFarmerOrdersDto,
  ): Promise<{ sent: number; skipped: number }> {
    return this.digestService.sendFarmerOrderEmails(tenantId, dto);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx jest digest.controller.spec.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

```bash
git add server/src/modules/digest/dto/send-farmer-orders.dto.ts server/src/modules/digest/digest.controller.ts server/src/modules/digest/digest.controller.spec.ts
git commit -m "feat(digest): POST /digest/farmers/send endpoint + DTO"
```

---

### Task 5: Frontend — api-client + modal + button

**Files:**
- Modify: `client/src/lib/api-client.ts`
- Create: `client/src/components/farmers/send-farmer-orders-modal.tsx`
- Modify: `client/src/components/farmers/farmers-client.tsx`

**Interfaces:**
- Consumes: `POST /digest/farmers/send` (Task 4), `Farmer` type (has `id`, `name`, `email`), existing `apiFetch`/`json`, `Button`, `toast`.
- Produces: `sendFarmerOrders(body)` api fn; `SendFarmerOrdersModal` component; a toolbar button in `FarmersClient`.

- [ ] **Step 1: Add the api-client function**

In `client/src/lib/api-client.ts`, near the Farmers section (after `revokeFarmerAccess`):

```typescript
/** Organizer: email selected farmers their orders for a date range + statuses. */
export const sendFarmerOrders = (body: {
  from: string;
  to: string;
  farmerIds: string[];
  statuses: string[];
}) =>
  apiFetch<{ sent: number; skipped: number }>(
    'digest/farmers/send',
    { method: 'POST', ...json(body) },
    'Неуспешно изпращане',
  );
```

- [ ] **Step 2: Create the modal**

```tsx
// client/src/components/farmers/send-farmer-orders-modal.tsx
'use client';

import { useState } from 'react';
import { X, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, sendFarmerOrders } from '@/lib/api-client';
import type { Farmer } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const todayStr = () => new Date().toLocaleDateString('en-CA');

const STATUS_OPTIONS: { key: string; label: string }[] = [
  { key: 'pending', label: 'Чакащи' },
  { key: 'confirmed', label: 'Потвърдени' },
  { key: 'delivered', label: 'Доставени' },
];

export function SendFarmerOrdersModal({
  farmers,
  onClose,
}: {
  farmers: Farmer[];
  onClose: () => void;
}) {
  const withEmail = farmers.filter((f) => f.email);
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [farmerIds, setFarmerIds] = useState<Record<string, boolean>>(
    Object.fromEntries(withEmail.map((f) => [f.id, true])),
  );
  const [statuses, setStatuses] = useState<Record<string, boolean>>({ confirmed: true });
  const [busy, setBusy] = useState(false);

  const selectedFarmers = withEmail.filter((f) => farmerIds[f.id]).map((f) => f.id);
  const selectedStatuses = STATUS_OPTIONS.filter((s) => statuses[s.key]).map((s) => s.key);
  const canSend =
    selectedFarmers.length > 0 && selectedStatuses.length > 0 && from <= to && !busy;

  async function submit() {
    if (!canSend) return;
    setBusy(true);
    try {
      const res = await sendFarmerOrders({ from, to, farmerIds: selectedFarmers, statuses: selectedStatuses });
      toast.success(`Изпратени ${res.sent} · прескочени ${res.skipped} (без поръчки за периода)`);
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const allChecked = withEmail.length > 0 && selectedFarmers.length === withEmail.length;
  const toggleAll = () =>
    setFarmerIds(Object.fromEntries(withEmail.map((f) => [f.id, !allChecked])));

  return (
    <div className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ff-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-[16px] font-extrabold text-ff-ink">
            <Send size={18} /> Изпрати поръчки на фермери
          </h2>
          <button onClick={onClose} className="text-ff-muted hover:text-ff-ink" aria-label="Затвори">
            <X size={20} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          <div className="mb-4 flex gap-3">
            <div className="flex-1">
              <label className="mb-1.5 block text-[13px] font-bold text-ff-ink-2">От</label>
              <input
                type="date"
                value={from}
                max={to}
                onChange={(e) => setFrom(e.target.value)}
                className="h-11 w-full rounded-xl border border-ff-border bg-ff-surface px-3 text-[14.5px] outline-none focus:border-ff-green-500"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1.5 block text-[13px] font-bold text-ff-ink-2">До</label>
              <input
                type="date"
                value={to}
                min={from}
                onChange={(e) => setTo(e.target.value)}
                className="h-11 w-full rounded-xl border border-ff-border bg-ff-surface px-3 text-[14.5px] outline-none focus:border-ff-green-500"
              />
            </div>
          </div>

          <div className="mb-4">
            <label className="mb-1.5 block text-[13px] font-bold text-ff-ink-2">Статуси</label>
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.map((s) => (
                <label
                  key={s.key}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-ff-border px-3 py-2 text-[14px]"
                >
                  <input
                    type="checkbox"
                    checked={!!statuses[s.key]}
                    onChange={(e) => setStatuses((c) => ({ ...c, [s.key]: e.target.checked }))}
                    className="h-4 w-4 accent-ff-green-700"
                  />
                  {s.label}
                </label>
              ))}
            </div>
          </div>

          <div className="mb-1 flex items-center justify-between">
            <label className="text-[13px] font-bold text-ff-ink-2">Фермери</label>
            {withEmail.length > 0 && (
              <button type="button" onClick={toggleAll} className="text-[12.5px] font-semibold text-ff-green-700">
                {allChecked ? 'Никой' : 'Всички'}
              </button>
            )}
          </div>
          <div className="rounded-xl border border-ff-border-2">
            {farmers.map((f) => {
              const disabled = !f.email;
              return (
                <label
                  key={f.id}
                  className={`flex items-center gap-3 border-b border-ff-border-2 px-3.5 py-2.5 last:border-0 ${
                    disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer'
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={!disabled && !!farmerIds[f.id]}
                    onChange={(e) => setFarmerIds((c) => ({ ...c, [f.id]: e.target.checked }))}
                    className="h-4 w-4 accent-ff-green-700"
                  />
                  <span className="flex-1 text-[14px] font-semibold text-ff-ink">{f.name}</span>
                  <span className="text-[12.5px] text-ff-muted">{f.email ?? 'няма имейл'}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-ff-border px-5 py-4">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Отказ
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!canSend}>
            <Send size={16} /> Изпрати
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire the button in `farmers-client.tsx`**

Add `Mail` to the lucide import line (line 4) and import the modal near the other imports:

```typescript
import { Plus, Pencil, Link2, Users, ArrowUpDown, Check, Mail } from 'lucide-react';
import { SendFarmerOrdersModal } from './send-farmer-orders-modal';
```

Add state near the other `useState` hooks (after `reorderMode`):

```typescript
const [sendOrdersOpen, setSendOrdersOpen] = useState(false);
```

In the multiFarmer toolbar (the `<div className="flex items-center gap-2">` around line 148, before the „Добави фермер" button), add:

```tsx
{!reorderMode && (
  <Button variant="ghost" size="sm" onClick={() => setSendOrdersOpen(true)} title="Изпрати имейл с поръчки на фермери">
    <Mail size={16} /> Изпрати поръчки
  </Button>
)}
```

Render the modal (near the bottom of the component's returned JSX, alongside the other conditionally-rendered panels/modals):

```tsx
{sendOrdersOpen && (
  <SendFarmerOrdersModal farmers={farmers} onClose={() => setSendOrdersOpen(false)} />
)}
```

- [ ] **Step 4: Typecheck**

Run: `cd client && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual verification via preview**

Start the client preview (per the run/preview workflow). As a multiFarmer tenant:
1. Go to Фермери → confirm the „Изпрати поръчки" button shows only in multiFarmer mode.
2. Click it → modal opens with today/today, „Потвърдени" checked, farmers-with-email pre-checked, email-less farmers greyed with „няма имейл".
3. Pick a range/statuses → Изпрати.
4. Confirm the network request `POST /digest/farmers/send` returns 200 `{sent,skipped}` and the toast shows counts. (SMTP may not deliver in dev — verify the response + server log `[digest] farmer-orders sent`.)

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/api-client.ts client/src/components/farmers/send-farmer-orders-modal.tsx client/src/components/farmers/farmers-client.tsx
git commit -m "feat(farmers): organizer send-orders-to-farmers modal + button"
```

---

## Self-Review Notes

- **Spec coverage:** range picker (Task 5 modal), farmer multi-select w/ email gating (Task 5), status multi-select whitelist (Task 3 + 4 DTO), on-demand endpoint (Task 4), reuse of digest logic + `scheduledForRange` (Task 1) + range assembler refactor (Task 2), cron untouched (Task 2 keeps `assembleFarmerDigest`/`renderFarmerHtml` output, regression-tested). All covered.
- **Placeholder scan:** every code step carries full code. No TBD/TODO.
- **Type consistency:** `sendFarmerOrderEmails(tenantId, {from,to,farmerIds,statuses})` identical across Tasks 3/4/5. `assembleFarmerRangeEmail(from,to,name,byDay)` identical Tasks 2/3. Response `{sent,skipped}` identical Tasks 3/4/5. `scheduledForRange(from,to)` identical Tasks 1/3.
- **Constructor caveat:** Task 3's test constructs `new DigestService(chain, email)` with 2 args — mirror the real constructor arity when implementing; if `DigestService` has more injected deps than (db, email), the test's `new DigestService(...)` call and the controller-spec must pass the same number of args (extend with `{} as never` placeholders). Verify against the real constructor before finalizing the test.
