# Move Orders To Another Day — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give own-delivery farmers a one-click "Премести на друг ден" tool in the Поръчки tab that bulk-moves a day's personal-delivery orders to any date and emails each customer about the change.

**Architecture:** A local-delivery order's day lives on its joined slot (`orders.slotId → delivery_slots.date`). Moving = reassigning `slotId`. To land orders on a day that is NOT open in the storefront, the backend find-or-creates a slot for the target date and, when creating, sets `isActive=false` — the storefront picker (`findPublicBySlug`) filters `isActive=true` so the day stays hidden, while the admin list (`findAll`) shows it. Zero schema change.

**Tech Stack:** NestJS + Drizzle (Postgres) backend, Jest tests; Next.js (App Router) + React + Tailwind client; Resend-over-SMTP email via nodemailer + BullMQ.

## Global Constraints

- **Own-delivery gate:** the button and endpoints are for own delivery only. Gate = `tenant.deliveryEnabled && ownSlots.enabled` (client: `delivery?.methods?.ownSlots?.enabled ?? true`; server backstop already at `orders.service.ts:464`).
- **Movable orders only:** `deliveryType='address'` AND `status ∈ {'pending','confirmed'}`. Never move delivered/cancelled/preparing/out_for_delivery.
- **No capacity / no same-day guard on the move** — the farmer deliberately piles orders onto their own day. (Unlike `lockAndCheckSlot`.)
- **Move even without email:** orders with no `customerEmail` are still moved; the email is silently skipped.
- **Email only** (no SMS this iteration). Stream `'transactional'`.
- **Admin-only** endpoints (`@Roles('admin')`), tenant-scoped. Not opened to producer sub-accounts.
- **No migration.** `delivery_slots.is_active` already exists (default true).
- **All user-facing copy in Bulgarian.**
- **Dates are `YYYY-MM-DD` strings**, compared lexically; "today" from `bgToday()` (Europe/Sofia) server-side.
- Server tests: `pnpm --filter server test <pattern>` (Jest, `*.spec.ts`). Client typecheck: `pnpm --filter client exec tsc --noEmit`.

---

### Task 1: `RescheduleOrdersDto`

**Files:**
- Create: `server/src/modules/orders/dto/reschedule-orders.dto.ts`
- Test: `server/src/modules/orders/dto/reschedule-orders.dto.spec.ts`

**Interfaces:**
- Produces: `class RescheduleOrdersDto { orderIds: string[]; toDate: string }` — consumed by the controller (Task 4) and service (Task 3).

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/orders/dto/reschedule-orders.dto.spec.ts` (mirrors the validation style of `dto/update-order.dto.spec.ts`):

```ts
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RescheduleOrdersDto } from './reschedule-orders.dto';

const UUID = '11111111-1111-1111-1111-111111111111';
const errs = (obj: unknown) => validateSync(plainToInstance(RescheduleOrdersDto, obj));

describe('RescheduleOrdersDto', () => {
  it('accepts a non-empty uuid list + a YYYY-MM-DD date', () => {
    expect(errs({ orderIds: [UUID], toDate: '2026-07-10' })).toHaveLength(0);
  });
  it('rejects an empty orderIds array', () => {
    expect(errs({ orderIds: [], toDate: '2026-07-10' }).length).toBeGreaterThan(0);
  });
  it('rejects a non-uuid id', () => {
    expect(errs({ orderIds: ['nope'], toDate: '2026-07-10' }).length).toBeGreaterThan(0);
  });
  it('rejects a malformed date', () => {
    expect(errs({ orderIds: [UUID], toDate: '10.07.2026' }).length).toBeGreaterThan(0);
  });
  it('rejects a missing date', () => {
    expect(errs({ orderIds: [UUID] }).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test reschedule-orders.dto`
Expected: FAIL — `Cannot find module './reschedule-orders.dto'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/modules/orders/dto/reschedule-orders.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsString, IsUUID, Matches } from 'class-validator';

/** Bulk-move a set of orders onto a target delivery day (own delivery). */
export class RescheduleOrdersDto {
  @ApiProperty({ type: [String], description: 'Order ids to move (all tenant-scoped).' })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  orderIds!: string[];

  @ApiProperty({ example: '2026-07-10', description: 'Target delivery day (YYYY-MM-DD).' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'toDate трябва да е във формат YYYY-MM-DD' })
  toDate!: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter server test reschedule-orders.dto`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/dto/reschedule-orders.dto.ts server/src/modules/orders/dto/reschedule-orders.dto.spec.ts
git commit -m "feat(orders): RescheduleOrdersDto for bulk day-move"
```

---

### Task 2: `OrderConfirmationService.sendMoved` (email)

**Files:**
- Modify: `server/src/modules/order-email/order-confirmation.service.ts`
- Test: `server/src/modules/order-email/order-confirmation.moved.spec.ts`

**Interfaces:**
- Consumes: existing `EmailService.sendMail`, `this.db`, `this.storefrontUrl`, module helpers `esc`, `money`.
- Produces: `sendMoved(orderId: string, fromDate: string | null, toDate: string): Promise<void>` — called fire-and-forget by the service (Task 3).

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/order-email/order-confirmation.moved.spec.ts`:

```ts
import { OrderConfirmationService } from './order-confirmation.service';

/** db whose selects resolve, in order: [order], [tenant]. */
function svc(order: Record<string, unknown> | undefined, tenant: Record<string, unknown>) {
  let call = 0;
  const chain: any = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(call++ === 0 ? (order ? [order] : []) : [tenant]);
  const db: any = { select: () => chain };
  const email = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const config: any = { get: () => 'https://shop.example' };
  return { s: new OrderConfirmationService(db, email as any, config), email };
}

const ORDER = {
  id: 'o1', tenantId: 't1', customerEmail: 'buyer@example.com', customerName: 'Иван',
  deliveryType: 'address', deliveryAddress: 'ул. Стара 1', deliveryCity: null,
  econtOffice: null, totalStotinki: 2450,
};
const TENANT = { name: 'Зелена ферма', settings: { contact: { phone: '0888123456' } } };

describe('OrderConfirmationService.sendMoved', () => {
  it('sends a from→to email with the farm phone', async () => {
    const { s, email } = svc(ORDER, TENANT);
    await s.sendMoved('o1', '2026-07-09', '2026-07-10');
    expect(email.sendMail).toHaveBeenCalledTimes(1);
    const arg = email.sendMail.mock.calls[0][0];
    expect(arg.to).toBe('buyer@example.com');
    expect(arg.subject).toContain('Промяна в деня на доставка');
    expect(arg.html).toContain('0888123456');
    expect(arg.stream).toBe('transactional');
  });

  it('does not send when the order has no email', async () => {
    const { s, email } = svc({ ...ORDER, customerEmail: null }, TENANT);
    await s.sendMoved('o1', '2026-07-09', '2026-07-10');
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  it('omits the phone clause gracefully when the farm has no phone', async () => {
    const { s, email } = svc(ORDER, { name: 'Ф', settings: {} });
    await s.sendMoved('o1', null, '2026-07-10');
    expect(email.sendMail).toHaveBeenCalledTimes(1);
    expect(email.sendMail.mock.calls[0][0].html).not.toContain('обади се на');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test order-confirmation.moved`
Expected: FAIL — `sendMoved is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `order-confirmation.service.ts`, add two module-level helpers near `money`/`esc` (top of file, after `esc`):

```ts
/** "четвъртък, 10.07" in Europe/Sofia. Noon-UTC input avoids a midnight day-shift. */
const BG_DAY_FMT = new Intl.DateTimeFormat('bg-BG', {
  timeZone: 'Europe/Sofia',
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
});
function dayLabel(date: string): string {
  return BG_DAY_FMT.format(new Date(`${date}T12:00:00Z`));
}

/** Farm contact phone from settings.contact.phone, or null. */
function contactPhone(settings: unknown): string | null {
  const c = (settings as { contact?: { phone?: unknown } } | null)?.contact;
  const p = typeof c?.phone === 'string' ? c.phone.trim() : '';
  return p || null;
}
```

Add the public method + two renderers inside the class (after `sendForOrder`):

```ts
/**
 * Email the buyer that their delivery DAY was changed (farmer moved the order to
 * another day). Fire-and-forget — swallows its own errors, no-ops without an email.
 */
async sendMoved(orderId: string, fromDate: string | null, toDate: string): Promise<void> {
  try {
    const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) return;
    const to = order.customerEmail?.trim();
    if (!to) return;

    const [tenant] = order.tenantId
      ? await this.db
          .select({ name: tenants.name, settings: tenants.settings })
          .from(tenants)
          .where(eq(tenants.id, order.tenantId))
          .limit(1)
      : [undefined];
    const farmName = tenant?.name ?? 'ФермериБГ';
    const phone = contactPhone(tenant?.settings);
    const safeFarmName = farmName.replace(/[\r\n]+/g, ' ').trim();

    await this.email.sendMail({
      to,
      subject: `Промяна в деня на доставка — ${safeFarmName}`.trim(),
      html: this.renderMovedHtml(order, farmName, fromDate, toDate, phone),
      text: this.renderMovedText(order, farmName, fromDate, toDate, phone),
      stream: 'transactional',
    });
  } catch (err) {
    this.logger.error(
      `order-moved email failed for ${orderId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

private renderMovedHtml(
  order: OrderRow,
  farmName: string,
  fromDate: string | null,
  toDate: string,
  phone: string | null,
): string {
  const greetingName = order.customerName ? esc(order.customerName) : '';
  const fromClause = fromDate ? `от <strong>${esc(dayLabel(fromDate))}</strong> ` : '';
  const phoneClause = phone
    ? ` Ако този ден не ти е удобен, обади се на <strong>${esc(phone)}</strong>, за да се уговорим за друг ден.`
    : '';
  return `<!doctype html><html lang="bg"><body style="margin:0;background:#f6f4ec;font-family:Arial,Helvetica,sans-serif;color:#23210f">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ec;padding:28px 0">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fffdf7;border:1px solid #e7e3d6;border-radius:16px;overflow:hidden">
        <tr><td style="background:#2d6a4f;padding:22px 28px;color:#eaf1e4;font-size:20px;font-weight:bold">🌿 ${esc(farmName)}</td></tr>
        <tr><td style="padding:28px">
          <h1 style="margin:0 0 6px;font-size:22px;color:#23210f">Промяна в деня на доставка</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#4a4733">
            ${greetingName ? `Здравей, ${greetingName}! ` : ''}Денят за доставка на поръчката ти е преместен ${fromClause}за <strong>${esc(dayLabel(toDate))}</strong>.${phoneClause}
          </p>
          <div style="margin-top:8px;padding:14px 16px;background:#f3f6f0;border:1px solid #e1e9dd;border-radius:12px">
            <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#8a8770;margin-bottom:4px">Доставка</div>
            <div style="font-size:14px;color:#23210f">${esc(this.deliveryLine(order))}</div>
          </div>
          <p style="margin:22px 0 0">
            <a href="${esc(this.storefrontUrl)}/confirmation?order=${esc(order.id)}" style="display:inline-block;background:#2d6a4f;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;padding:12px 20px;border-radius:10px">Виж поръчката</a>
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #eee7d6;font-size:12px;color:#a8a594">${esc(farmName)} · Благодарим, че пазаруваш от местни производители 🌱</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

private renderMovedText(
  order: OrderRow,
  farmName: string,
  fromDate: string | null,
  toDate: string,
  phone: string | null,
): string {
  return [
    `${farmName} — Промяна в деня на доставка.`,
    order.customerName ? `Здравей, ${order.customerName}!` : '',
    '',
    `Денят за доставка на поръчката ти е преместен ${fromDate ? `от ${dayLabel(fromDate)} ` : ''}за ${dayLabel(toDate)}.`,
    phone ? `Ако този ден не ти е удобен, обади се на ${phone}, за да се уговорим за друг ден.` : '',
    '',
    this.deliveryLine(order),
  ]
    .filter((l) => l !== '')
    .join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter server test order-confirmation.moved`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/order-email/order-confirmation.service.ts server/src/modules/order-email/order-confirmation.moved.spec.ts
git commit -m "feat(order-email): sendMoved — notify buyer their delivery day changed"
```

---

### Task 3: `OrdersService.reschedulable` + `rescheduleOrders`

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts`
- Test: `server/src/modules/orders/orders.reschedule.spec.ts`

**Interfaces:**
- Consumes: `RescheduleOrdersDto` (Task 1), `this.orderEmail.sendMoved` (Task 2), existing `bgToday`, `this.bustPayments`, `this.db.transaction`.
- Produces:
  - `reschedulable(tenantId: string): Promise<ReschedulableOrder[]>`
  - `rescheduleOrders(tenantId: string, dto: RescheduleOrdersDto): Promise<{ moved: number; toDate: string }>`
  - `interface ReschedulableOrder { id, orderNumber, customerName, customerPhone, totalStotinki, status, slotDate }`

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/orders/orders.reschedule.spec.ts`. It uses a small hand-rolled tx mock (same style as `orders.update.spec.ts`) that records `update(orders).set(...)` calls and the created slot.

```ts
import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

const TENANT = 'tenant-1';
const UUID = (n: number) => `${n}`.padStart(8, '0') + '-0000-0000-0000-000000000000';

/**
 * Build a service whose:
 *  - first `db.select` (the load) resolves to `loadRows`
 *  - `db.transaction` runs the callback against a tx that:
 *      • answers `select(...).for('update')` for the target-slot lookup with `existingSlot`
 *      • records inserted slot rows into `inserted`
 *      • records `update(orders).set(v).where()` values into `setCalls`
 */
function makeSvc(opts: {
  loadRows: Record<string, unknown>[];
  existingSlot?: { id: string };
}) {
  const setCalls: Record<string, unknown>[] = [];
  const inserted: Record<string, unknown>[] = [];
  const sendMoved = jest.fn().mockResolvedValue(undefined);

  const loadChain: any = {};
  loadChain.from = () => loadChain;
  loadChain.leftJoin = () => loadChain;
  loadChain.innerJoin = () => loadChain;
  loadChain.where = () => loadChain;
  loadChain.orderBy = () => Promise.resolve(opts.loadRows);
  loadChain.limit = () => Promise.resolve(opts.loadRows);

  const db: any = {
    select: () => loadChain,
    transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => {
      const tx: any = {
        select: () => {
          const c: any = {};
          c.from = () => c;
          c.leftJoin = () => c;
          c.where = () => c;
          c.for = () => c;
          c.limit = () => Promise.resolve(opts.existingSlot ? [opts.existingSlot] : []);
          return c;
        },
        insert: () => ({
          values: (v: Record<string, unknown>) => ({
            returning: () => {
              inserted.push(v);
              return Promise.resolve([{ id: 'new-slot' }]);
            },
          }),
        }),
        update: () => ({
          set: (v: Record<string, unknown>) => ({
            where: () => {
              setCalls.push(v);
              return Promise.resolve();
            },
          }),
        }),
      };
      return fn(tx);
    }),
  };

  // Constructor order: db, maps, orderEmail, econt, cache, carrierFulfillment, codRisk, catalogCache
  const svc = new OrdersService(
    db,
    {} as any,
    { sendMoved } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  jest.spyOn(svc as any, 'bustPayments').mockResolvedValue(undefined);
  return { svc, setCalls, inserted, sendMoved };
}

describe('OrdersService.rescheduleOrders', () => {
  const addr = (over: Record<string, unknown> = {}) => ({
    id: UUID(1), status: 'pending', deliveryType: 'address', slotId: 'old-slot', fromDate: '2026-07-09', ...over,
  });

  it('creates a HIDDEN slot for an unopened date and reassigns', async () => {
    const { svc, setCalls, inserted, sendMoved } = makeSvc({ loadRows: [addr()] });
    const res = await svc.rescheduleOrders(TENANT, { orderIds: [UUID(1)], toDate: '2026-12-31' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].isActive).toBe(false);
    expect(inserted[0].date).toBe('2026-12-31');
    expect(setCalls).toEqual([{ slotId: 'new-slot' }]);
    expect(res).toEqual({ moved: 1, toDate: '2026-12-31' });
    expect(sendMoved).toHaveBeenCalledWith(UUID(1), '2026-07-09', '2026-12-31');
  });

  it('reuses an existing slot for the target date (no insert)', async () => {
    const { svc, inserted, setCalls } = makeSvc({ loadRows: [addr()], existingSlot: { id: 'exists' } });
    await svc.rescheduleOrders(TENANT, { orderIds: [UUID(1)], toDate: '2026-12-31' });
    expect(inserted).toHaveLength(0);
    expect(setCalls).toEqual([{ slotId: 'exists' }]);
  });

  it('skips non-address / delivered / cancelled orders', async () => {
    const rows = [
      addr({ id: UUID(1), deliveryType: 'econt' }),
      addr({ id: UUID(2), status: 'delivered' }),
      addr({ id: UUID(3), status: 'cancelled' }),
    ];
    const { svc } = makeSvc({ loadRows: rows });
    await expect(
      svc.rescheduleOrders(TENANT, { orderIds: [UUID(1), UUID(2), UUID(3)], toDate: '2026-12-31' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a past target date', async () => {
    const { svc } = makeSvc({ loadRows: [addr()] });
    await expect(
      svc.rescheduleOrders(TENANT, { orderIds: [UUID(1)], toDate: '2000-01-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('no-ops an order already on the target slot (no email, moved=0)', async () => {
    const { svc, setCalls, sendMoved } = makeSvc({
      loadRows: [addr({ slotId: 'exists' })],
      existingSlot: { id: 'exists' },
    });
    const res = await svc.rescheduleOrders(TENANT, { orderIds: [UUID(1)], toDate: '2026-12-31' });
    expect(setCalls).toHaveLength(0);
    expect(sendMoved).not.toHaveBeenCalled();
    expect(res.moved).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test orders.reschedule`
Expected: FAIL — `rescheduleOrders is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `orders.service.ts`:

(a) Ensure the drizzle import line includes `gte` and `inArray` (add whichever are missing):

```ts
import { and, eq, ne, gte, inArray, sql, /* …existing… */ } from 'drizzle-orm';
```

(b) Add the import for the DTO near the other DTO imports:

```ts
import { RescheduleOrdersDto } from './dto/reschedule-orders.dto';
```

(c) Add the exported result type near `orderWithSlot` (top of file):

```ts
/** One movable order for the "Премести на друг ден" tool (own-delivery orders on a future day). */
export interface ReschedulableOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  totalStotinki: number;
  status: string;
  slotDate: string;
}
```

(d) Add both methods to the class (place them right after `updateOrder`, before `updateStatus`):

```ts
/**
 * Own-delivery orders that can be moved: address delivery, still live
 * (pending/confirmed), on a slot dated today-or-later. The client groups these
 * by `slotDate` into the source-day picker + checkbox list.
 */
async reschedulable(tenantId: string): Promise<ReschedulableOrder[]> {
  const today = bgToday();
  return this.db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      totalStotinki: orders.totalStotinki,
      status: orders.status,
      slotDate: deliverySlots.date,
    })
    .from(orders)
    .innerJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.deliveryType, 'address'),
        inArray(orders.status, ['pending', 'confirmed']),
        gte(deliverySlots.date, today),
      ),
    )
    .orderBy(deliverySlots.date, orders.orderNumber);
}

/**
 * Bulk-move own-delivery orders onto `toDate`. Finds-or-creates the target-day
 * slot; a freshly created one is `isActive=false` so it never surfaces on the
 * storefront picker (the farmer sees it; shoppers don't). Deliberately skips the
 * capacity + same-day guards that `lockAndCheckSlot` enforces — the farmer is
 * intentionally loading their own day. Emails each moved order's buyer.
 */
async rescheduleOrders(
  tenantId: string,
  dto: RescheduleOrdersDto,
): Promise<{ moved: number; toDate: string }> {
  const { orderIds, toDate } = dto;
  if (toDate < bgToday()) {
    throw new BadRequestException('Не може да преместиш поръчки в минал ден.');
  }

  const moved: { id: string; fromDate: string | null }[] = [];
  await this.db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: orders.id,
        status: orders.status,
        deliveryType: orders.deliveryType,
        slotId: orders.slotId,
        fromDate: deliverySlots.date,
      })
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(and(eq(orders.tenantId, tenantId), inArray(orders.id, orderIds)));

    const movable = rows.filter(
      (r) => r.deliveryType === 'address' && (r.status === 'pending' || r.status === 'confirmed'),
    );
    if (!movable.length) {
      throw new BadRequestException('Няма поръчки за преместване.');
    }

    // find-or-create the target-day slot (one row per (tenant, date), like SlotsService.create).
    const [existing] = await tx
      .select({ id: deliverySlots.id })
      .from(deliverySlots)
      .where(and(eq(deliverySlots.tenantId, tenantId), eq(deliverySlots.date, toDate)))
      .for('update')
      .limit(1);
    let targetSlotId = existing?.id;
    if (!targetSlotId) {
      const [created] = await tx
        .insert(deliverySlots)
        .values({
          tenantId,
          date: toDate,
          isActive: false, // hidden from the storefront picker (findPublicBySlug filters isActive)
          generated: false,
          capacity: Math.max(1, movable.length),
          driverNote: 'Преместени поръчки',
        })
        .returning({ id: deliverySlots.id });
      targetSlotId = created.id;
    }

    for (const r of movable) {
      if (r.slotId === targetSlotId) continue; // already on the target day
      await tx
        .update(orders)
        .set({ slotId: targetSlotId })
        .where(and(eq(orders.id, r.id), eq(orders.tenantId, tenantId)));
      moved.push({ id: r.id, fromDate: r.fromDate ?? null });
    }
  });

  await this.bustPayments(tenantId);

  // Fire-and-forget per moved order (sendMoved self-guards when the buyer has no email).
  for (const m of moved) {
    void this.orderEmail.sendMoved(m.id, m.fromDate, toDate);
  }
  return { moved: moved.length, toDate };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter server test orders.reschedule`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/orders.service.ts server/src/modules/orders/orders.reschedule.spec.ts
git commit -m "feat(orders): reschedulable + rescheduleOrders (hidden-slot day move)"
```

---

### Task 4: Controller routes

**Files:**
- Modify: `server/src/modules/orders/orders.controller.ts`
- Test: `server/src/modules/orders/orders.reschedule-controller.spec.ts`

**Interfaces:**
- Consumes: `OrdersService.reschedulable` / `rescheduleOrders` (Task 3), `RescheduleOrdersDto` (Task 1).
- Produces: `GET /orders/reschedulable`, `POST /orders/reschedule`.

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/orders/orders.reschedule-controller.spec.ts`:

```ts
import { OrdersController } from './orders.controller';

function ctrl() {
  const service = {
    reschedulable: jest.fn().mockResolvedValue([{ id: 'o1' }]),
    rescheduleOrders: jest.fn().mockResolvedValue({ moved: 2, toDate: '2026-07-10' }),
  };
  return { c: new OrdersController(service as any), service };
}

describe('OrdersController reschedule routes', () => {
  it('GET /orders/reschedulable delegates with the tenant id', async () => {
    const { c, service } = ctrl();
    await c.reschedulable('t1');
    expect(service.reschedulable).toHaveBeenCalledWith('t1');
  });

  it('POST /orders/reschedule delegates the dto', async () => {
    const { c, service } = ctrl();
    const dto = { orderIds: ['a'], toDate: '2026-07-10' };
    const res = await c.reschedule('t1', dto as any);
    expect(service.rescheduleOrders).toHaveBeenCalledWith('t1', dto);
    expect(res).toEqual({ moved: 2, toDate: '2026-07-10' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter server test orders.reschedule-controller`
Expected: FAIL — `c.reschedulable is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `orders.controller.ts`:

(a) Add the import:

```ts
import { RescheduleOrdersDto } from './dto/reschedule-orders.dto';
```

(b) Add both handlers **before** the `@Get(':id')` handler (so the literal `reschedulable` segment isn't captured as an id), alongside the other literal routes (`production` / `payments` / `mine`):

```ts
// Literal route — declared before `:id`. Own-delivery orders that can be moved to
// another day, grouped client-side by their slot date.
@Get('reschedulable')
@Roles('admin')
reschedulable(@CurrentTenant() tenantId: string) {
  return this.ordersService.reschedulable(tenantId);
}

// Bulk-move the given own-delivery orders onto a target day.
@Post('reschedule')
@Roles('admin')
reschedule(@CurrentTenant() tenantId: string, @Body() dto: RescheduleOrdersDto) {
  return this.ordersService.rescheduleOrders(tenantId, dto);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter server test orders.reschedule-controller`
Expected: PASS (2 tests).

- [ ] **Step 5: Full backend check + commit**

Run: `pnpm --filter server test orders`
Expected: existing orders suites + the 3 new ones all PASS.

```bash
git add server/src/modules/orders/orders.controller.ts server/src/modules/orders/orders.reschedule-controller.spec.ts
git commit -m "feat(orders): GET /orders/reschedulable + POST /orders/reschedule"
```

---

### Task 5: Client API client + types

**Files:**
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/lib/api-client.ts`

**Interfaces:**
- Produces (consumed by Tasks 6–7):
  - type `ReschedulableOrder = { id, orderNumber, customerName, customerPhone, totalStotinki, status, slotDate }`
  - `listReschedulable(): Promise<ReschedulableOrder[]>`
  - `rescheduleOrders(orderIds: string[], toDate: string): Promise<{ moved: number; toDate: string }>`

- [ ] **Step 1: Add the type**

In `client/src/lib/types.ts`, add near the other order types:

```ts
/** A movable own-delivery order for the "Премести на друг ден" tool. */
export interface ReschedulableOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  totalStotinki: number;
  status: string;
  /** YYYY-MM-DD delivery day (its slot's date). */
  slotDate: string;
}
```

- [ ] **Step 2: Add the API calls**

In `client/src/lib/api-client.ts`: add `ReschedulableOrder` to the type import block (the `from './types'` list at the top), then add, in the `// ---- Orders ----` section (after `updateOrder`):

```ts
/** Own-delivery orders eligible to be moved to another day (client groups by slotDate). */
export const listReschedulable = () => apiFetch<ReschedulableOrder[]>('orders/reschedulable');

/** Bulk-move the given orders onto `toDate` (YYYY-MM-DD). */
export const rescheduleOrders = (orderIds: string[], toDate: string) =>
  apiFetch<{ moved: number; toDate: string }>(
    'orders/reschedule',
    { method: 'POST', ...json({ orderIds, toDate }) },
    'Неуспешно преместване на поръчките',
  );
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/types.ts client/src/lib/api-client.ts
git commit -m "feat(client): reschedulable + rescheduleOrders API client"
```

---

### Task 6: SSR gate + toolbar button

**Files:**
- Modify: `client/src/app/(admin)/orders/page.tsx`
- Modify: `client/src/components/orders/orders-client.tsx`

**Interfaces:**
- Consumes: `tenants/me` payload `{ deliveryEnabled?, delivery? }`; `DeliveryConfig` type.
- Produces: `OrdersClient` gains `ownDeliveryEnabled: boolean` and renders a «Премести на друг ден» button (opens a modal via `rescheduleOpen` state — the modal itself is wired in Task 7). Callback `reload = load` exposed to the modal.

- [ ] **Step 1: SSR-fetch the gate in `page.tsx`**

Replace the body of `client/src/app/(admin)/orders/page.tsx` with (adds a parallel `tenants/me` fetch and computes the gate):

```tsx
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { OrdersClient } from '@/components/orders/orders-client';
import { ORDERS_PAGE_SIZE } from '@/lib/orders';
import type { DeliveryConfig, Order, Paged } from '@/lib/types';

export const dynamic = 'force-dynamic';

const EMPTY: Paged<Order> = { items: [], total: 0 };

async function getOrders(token: string | undefined): Promise<Paged<Order> & { ok: boolean }> {
  if (!token) return { ...EMPTY, ok: false };
  try {
    const res = await fetch(`${API_BASE}/orders?page=1&limit=${ORDERS_PAGE_SIZE}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return { ...EMPTY, ok: false };
    const data = (await res.json()) as Paged<Order>;
    return { ...data, ok: true };
  } catch {
    return { ...EMPTY, ok: false };
  }
}

/** Own delivery on = deliveryEnabled master switch AND the ownSlots method flag
 *  (ownSlots defaults on — mirrors buildPublicMethods + setup-panel). */
async function getOwnDeliveryEnabled(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetch(`${API_BASE}/tenants/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const t = (await res.json()) as { deliveryEnabled?: boolean; delivery?: DeliveryConfig | null };
    return !!t.deliveryEnabled && (t.delivery?.methods?.ownSlots?.enabled ?? true);
  } catch {
    return false;
  }
}

export default async function OrdersPage() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  const [{ ok, ...initial }, ownDeliveryEnabled] = await Promise.all([
    getOrders(token),
    getOwnDeliveryEnabled(token),
  ]);
  return <OrdersClient initial={initial} initialOk={ok} ownDeliveryEnabled={ownDeliveryEnabled} />;
}
```

- [ ] **Step 2: Add the prop, state, and button in `orders-client.tsx`**

(a) Extend the lucide import (line 4) to include `ArrowRightLeft`:

```tsx
import { Search, MapPin, Package, Store, Info, ArrowRightLeft } from 'lucide-react';
```

(b) Add `ownDeliveryEnabled` to the props type + destructure (default `false`):

```tsx
export function OrdersClient({
  initial,
  initialOk = true,
  ownDeliveryEnabled = false,
}: {
  initial: Paged<Order>;
  initialOk?: boolean;
  ownDeliveryEnabled?: boolean;
}) {
```

(c) Add modal open state next to the other `useState` hooks:

```tsx
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
```

(d) In the toolbar, insert the button **between the filter-tabs `<div>` (ends `</div>` after the `FILTERS.map`) and the «Обяснения» `<Button>`**. The tabs `<div>` uses `ml-auto`; add the reschedule button after it so it sits between the tabs and «Обяснения»:

```tsx
        {ownDeliveryEnabled && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRescheduleOpen(true)}
            className="max-[680px]:w-full"
          >
            <ArrowRightLeft size={16} /> Премести на друг ден
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setHelp(true)} className="max-[680px]:w-full">
          <Info size={16} /> Обяснения
        </Button>
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: no new errors. (The `rescheduleOpen` state is set but not yet read — that is wired in Task 7; a "declared but never read" note is acceptable at this checkpoint, or temporarily reference it in a comment. It is consumed in Task 7 Step 2.)

- [ ] **Step 4: Commit**

```bash
git add "client/src/app/(admin)/orders/page.tsx" client/src/components/orders/orders-client.tsx
git commit -m "feat(orders-web): own-delivery gate + 'Премести на друг ден' toolbar button"
```

---

### Task 7: Reschedule modal + wiring + verification

**Files:**
- Create: `client/src/components/orders/reschedule-orders-modal.tsx`
- Modify: `client/src/components/orders/orders-client.tsx`

**Interfaces:**
- Consumes: `listReschedulable`, `rescheduleOrders` (Task 5); `ReschedulableOrder` (Task 5); `relDayLabel`, `moneyFromStotinki` (`@/lib/utils`); `Button` (`@/components/ui/button`); `rescheduleOpen`/`setRescheduleOpen` + `load` (Task 6).
- Produces: `RescheduleOrdersModal` component.

- [ ] **Step 1: Create the modal component**

Create `client/src/components/orders/reschedule-orders-modal.tsx`:

```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, ArrowRightLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { relDayLabel, moneyFromStotinki } from '@/lib/utils';
import { ApiError, listReschedulable, rescheduleOrders } from '@/lib/api-client';
import type { ReschedulableOrder } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
/** Local calendar day as YYYY-MM-DD — the date input's floor. */
const todayStr = () => new Date().toLocaleDateString('en-CA');
const orderNo = (o: ReschedulableOrder) =>
  o.orderNumber != null ? `#${o.orderNumber}` : `#${o.id.slice(0, 8)}`;

export function RescheduleOrdersModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  /** Called after a successful move so the parent can reload its list. */
  onDone: () => void;
}) {
  const [rows, setRows] = useState<ReschedulableOrder[] | null>(null);
  const [sourceDate, setSourceDate] = useState<string>('');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [toDate, setToDate] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    listReschedulable()
      .then((r) => {
        if (!live) return;
        setRows(r);
      })
      .catch((e) => {
        if (live) toast.error(errMsg(e));
      });
    return () => {
      live = false;
    };
  }, []);

  // Distinct source days with their orders, sorted ascending.
  const days = useMemo(() => {
    const map = new Map<string, ReschedulableOrder[]>();
    for (const o of rows ?? []) {
      const arr = map.get(o.slotDate) ?? [];
      arr.push(o);
      map.set(o.slotDate, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, orders]) => ({ date, orders }));
  }, [rows]);

  // Default the source day to the first available; pre-check all its orders.
  useEffect(() => {
    if (!days.length) return;
    const first = days[0];
    setSourceDate((cur) => (cur && days.some((d) => d.date === cur) ? cur : first.date));
  }, [days]);

  const sourceOrders = useMemo(
    () => days.find((d) => d.date === sourceDate)?.orders ?? [],
    [days, sourceDate],
  );

  // When the source day changes, pre-check every order on it.
  useEffect(() => {
    setChecked(Object.fromEntries(sourceOrders.map((o) => [o.id, true])));
  }, [sourceOrders]);

  const selectedIds = sourceOrders.filter((o) => checked[o.id]).map((o) => o.id);
  const canSubmit = selectedIds.length > 0 && !!toDate && toDate !== sourceDate && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const res = await rescheduleOrders(selectedIds, toDate);
      toast.success(`Преместени ${res.moved} поръчки за ${relDayLabel(toDate)}`);
      onDone();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ff-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-[16px] font-extrabold text-ff-ink">
            <ArrowRightLeft size={18} /> Премести поръчки на друг ден
          </h2>
          <button onClick={onClose} className="text-ff-muted hover:text-ff-ink" aria-label="Затвори">
            <X size={20} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {rows === null ? (
            <p className="py-8 text-center text-sm text-ff-muted">Зареждане…</p>
          ) : days.length === 0 ? (
            <p className="py-8 text-center text-sm text-ff-muted">
              Няма поръчки с лична доставка за преместване.
            </p>
          ) : (
            <>
              <label className="mb-1.5 block text-[13px] font-bold text-ff-ink-2">От кой ден</label>
              <select
                value={sourceDate}
                onChange={(e) => setSourceDate(e.target.value)}
                className="mb-4 h-11 w-full rounded-xl border border-ff-border bg-ff-surface px-3 text-[14.5px] outline-none focus:border-ff-green-500"
              >
                {days.map((d) => (
                  <option key={d.date} value={d.date}>
                    {relDayLabel(d.date)} · {d.orders.length} поръчки
                  </option>
                ))}
              </select>

              <div className="mb-4 rounded-xl border border-ff-border-2">
                {sourceOrders.map((o) => (
                  <label
                    key={o.id}
                    className="flex cursor-pointer items-center gap-3 border-b border-ff-border-2 px-3.5 py-2.5 last:border-0"
                  >
                    <input
                      type="checkbox"
                      checked={!!checked[o.id]}
                      onChange={(e) => setChecked((c) => ({ ...c, [o.id]: e.target.checked }))}
                      className="h-4 w-4 accent-ff-green-700"
                    />
                    <span className="flex-1 text-[14px] font-semibold text-ff-ink">
                      {orderNo(o)} · {o.customerName ?? '—'}
                    </span>
                    <span className="ff-fig text-[14px] font-bold text-ff-ink-2">
                      {moneyFromStotinki(o.totalStotinki)}
                    </span>
                  </label>
                ))}
              </div>

              <label className="mb-1.5 block text-[13px] font-bold text-ff-ink-2">За кой ден</label>
              <input
                type="date"
                min={todayStr()}
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="h-11 w-full rounded-xl border border-ff-border bg-ff-surface px-3 text-[14.5px] outline-none focus:border-ff-green-500"
              />
              {toDate && toDate === sourceDate && (
                <p className="mt-1.5 text-[12.5px] font-semibold text-ff-amber-600">
                  Избери различен ден от текущия.
                </p>
              )}

              <p className="mt-4 rounded-xl bg-ff-surface-2 px-3.5 py-3 text-[12.5px] leading-relaxed text-ff-ink-2">
                Клиентите с имейл ще получат известие, че поръчката е преместена, и покана да се обадят,
                ако денят не им е удобен.
              </p>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-ff-border px-5 py-4">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Отказ
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!canSubmit}>
            Премести {selectedIds.length || ''} поръчки
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire the modal into `orders-client.tsx`**

(a) Add the import near the other component imports:

```tsx
import { RescheduleOrdersModal } from './reschedule-orders-modal';
```

(b) Render it next to the existing `{help && <HelpModal .../>}` line (bottom of the returned JSX):

```tsx
      {rescheduleOpen && (
        <RescheduleOrdersModal
          onClose={() => setRescheduleOpen(false)}
          onDone={() => void load()}
        />
      )}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter client exec tsc --noEmit`
Expected: no errors (`rescheduleOpen` is now read).

- [ ] **Step 4: Verify in the running app (preview tools)**

1. Start the client dev server with `preview_start` (create `.claude/launch.json` for the client app if absent).
2. Log in as an own-delivery farm (`deliveryEnabled=true`, ownSlots on) and open **Поръчки**.
3. `preview_snapshot` → confirm a «Премести на друг ден» button sits between the status tabs and «Обяснения».
4. `preview_click` it → `preview_snapshot` the modal: source-day `<select>` lists upcoming days with counts; the day's orders show as pre-checked rows; a date picker; the notice text.
5. Pick a future date, confirm → `preview_network` shows `POST /orders/reschedule` returning `{ moved, toDate }`; a success toast appears; the moved orders now show the new day in the «Доставка» column (`relDayLabel(slotDate)`).
6. Negative gate check: for a farm with own delivery OFF, `preview_snapshot` confirms the button is absent.
7. Storefront-leak check: confirm the newly created target day does NOT appear in the storefront slot picker for that farm (it was created `isActive=false`). Inspect via `preview_network` on the storefront `/public/:slug/slots` (the new date must be absent) or the checkout day picker.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/orders/reschedule-orders-modal.tsx client/src/components/orders/orders-client.tsx
git commit -m "feat(orders-web): reschedule-orders modal (pick day, move to any date)"
```

---

## Self-Review

**Spec coverage:**
- Toolbar button, own-delivery gated, between tabs & «Обяснения» → Task 6. ✓
- Source-day picker + all-checked checkboxes → Task 7. ✓
- Free target date (any day) → Task 7 date input + Task 3 free `toDate`. ✓
- Hidden slot (isActive=false) so target day isn't in storefront → Task 3 + verify step 7. ✓
- Reuse existing slot when the target day already has one → Task 3 (find-or-create). ✓
- No capacity / same-day guard → Task 3 (skips lockAndCheckSlot). ✓
- Move even without email → Task 3 (sendMoved self-guards) + Task 2 test. ✓
- Email only, `sendMoved` from→to + farm phone → Task 2. ✓
- Movable = address + pending/confirmed → Task 3 filter + `reschedulable` query. ✓
- Admin-only endpoints → Task 4 `@Roles('admin')`. ✓
- No migration → confirmed; no schema task. ✓
- Testing (service create/reuse/filter/past-date/no-op, email, slot-leak, DTO) → Tasks 1–4 + verify step 7. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code.

**Type consistency:** `ReschedulableOrder` fields identical across service (Task 3), client type (Task 5), api-client return (Task 5), modal usage (Task 7). `rescheduleOrders` returns `{ moved, toDate }` in service, controller, api-client, and modal. `sendMoved(orderId, fromDate|null, toDate)` signature matches its call site in Task 3. Constructor arg order in the Task 3 test (`db, maps, orderEmail, …`) matches `orders.service.ts:427-436`.
