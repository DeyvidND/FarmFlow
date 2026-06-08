# Farmer Emails + Per-Farmer Daily Digest + Production Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give farmers an email address, send each farmer a daily email of their own products' deliveries (alongside the unchanged owner digest), and add a farmer filter dropdown to the production prep page.

**Architecture:** Add an `email` column to `farmers`. Extend the existing `DigestService` (07:00 cron) with a `buildFarmerDigest` method gated on tenant `multiFarmer` + farmer email. Extend the `/orders/production` query with farmer attribution and add a client-side dropdown filter on the prep list. No new modules.

**Tech Stack:** NestJS + Drizzle ORM (Postgres), drizzle-kit migrations, Jest, Next.js (App Router) client, class-validator DTOs.

**Spec:** `docs/superpowers/specs/2026-06-08-farmer-emails-daily-digest-design.md`

---

## File Structure

- `packages/db/src/schema.ts` — add `email` to `farmers`.
- `packages/db/drizzle/0031_*.sql` — generated migration (new).
- `server/src/modules/farmers/dto/create-farmer.dto.ts` — add `email`.
- `server/src/modules/farmers/dto/create-farmer.dto.spec.ts` — DTO tests (new).
- `server/src/modules/digest/digest.service.ts` — `buildFarmerDigest`, farmer renderers, `sendFarmerDigests`, cron + test-endpoint wiring.
- `server/src/modules/digest/digest.service.spec.ts` — farmer digest tests.
- `server/src/modules/digest/digest.controller.ts` — test-endpoint return type.
- `server/src/modules/orders/orders.service.ts` — production farmer attribution.
- `client/src/lib/types.ts` — `Farmer.email`, `ProductionItem`/`ProductionSummary` fields.
- `client/src/components/farmers/farmer-panel.tsx` — email input.
- `client/src/components/production/prep-list.tsx` — farmer dropdown filter.

Note: `client/src/lib/api-client.ts` `createFarmer`/`updateFarmer` already accept `Partial<Farmer>`, so no change once `Farmer.email` exists. `farmers.service.ts` `create`/`update` spread the DTO (`{ ...dto }`), so `email` persists automatically once the DTO carries it — no service change.

---

## Task 1: Farmer email field (schema + migration + DTO + types)

**Files:**
- Modify: `server/src/modules/farmers/dto/create-farmer.dto.ts`
- Test: `server/src/modules/farmers/dto/create-farmer.dto.spec.ts` (create)
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0031_*.sql` (via drizzle-kit)
- Modify: `client/src/lib/types.ts`

- [ ] **Step 1: Write the failing DTO test**

Create `server/src/modules/farmers/dto/create-farmer.dto.spec.ts`:

```ts
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateFarmerDto } from './create-farmer.dto';

function errorsFor(payload: Record<string, unknown>) {
  return validate(plainToInstance(CreateFarmerDto, payload));
}

describe('CreateFarmerDto — email', () => {
  it('accepts a valid email', async () => {
    const errs = await errorsFor({ name: 'Петър', email: 'petar@ferma.bg' });
    expect(errs).toHaveLength(0);
  });

  it('rejects an invalid email', async () => {
    const errs = await errorsFor({ name: 'Петър', email: 'not-an-email' });
    expect(errs.some((e) => e.property === 'email')).toBe(true);
  });

  it('allows omitting email', async () => {
    const errs = await errorsFor({ name: 'Петър' });
    expect(errs).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @farmflow/api test -- create-farmer.dto.spec`
Expected: FAIL — "rejects an invalid email" fails (no `email` validation yet; `not-an-email` produces no error).

- [ ] **Step 3: Add `email` to the DTO**

In `server/src/modules/farmers/dto/create-farmer.dto.ts`, add the import for `IsEmail` and the field. Change line 1 from:

```ts
import { IsString, IsOptional, IsInt, IsUrl, Min } from 'class-validator';
```

to:

```ts
import { IsString, IsOptional, IsInt, IsUrl, IsEmail, Min } from 'class-validator';
```

Then add this field after the `phone` field (after line 22):

```ts
  @ApiPropertyOptional({ example: 'petar@ferma.bg' })
  @IsOptional()
  @IsEmail()
  email?: string;
```

- [ ] **Step 4: Run the DTO test to verify it passes**

Run: `pnpm --filter @farmflow/api test -- create-farmer.dto.spec`
Expected: PASS (3 passing).

- [ ] **Step 5: Add the column to the Drizzle schema**

In `packages/db/src/schema.ts`, inside the `farmers` table (around line 451–474), add the `email` column right after `phone`:

```ts
    phone: text('phone'),
    email: text('email'),
```

- [ ] **Step 6: Generate the migration and rebuild db + types dist**

Run:
```bash
pnpm --filter @farmflow/db generate
pnpm --filter @farmflow/db build
pnpm --filter @farmflow/types build
```
Expected: a new `packages/db/drizzle/0031_*.sql` file containing `ALTER TABLE "farmers" ADD COLUMN "email" text;`, and both builds succeed. Open the generated SQL and confirm it only adds the `farmers.email` column (no unintended diffs).

- [ ] **Step 7: Add `email` to the client `Farmer` type**

In `client/src/lib/types.ts`, in the `Farmer` interface (lines 39–50), add after `phone`:

```ts
  phone: string | null;
  email: string | null;
```

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/farmers/dto/create-farmer.dto.ts \
        server/src/modules/farmers/dto/create-farmer.dto.spec.ts \
        packages/db/src/schema.ts packages/db/drizzle client/src/lib/types.ts
git commit -m "feat(farmers): add email field (schema 0031 + DTO + types)"
```

---

## Task 2: `buildFarmerDigest` (server logic, TDD)

**Files:**
- Modify: `server/src/modules/digest/digest.service.ts`
- Test: `server/src/modules/digest/digest.service.spec.ts`

- [ ] **Step 1: Extend the mock DB builder + write failing tests**

In `server/src/modules/digest/digest.service.spec.ts`, update `makeDb()` (lines 9–18) to add `innerJoin` (the new query joins `orderItems → orders → products`):

```ts
function makeDb() {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([]),
  };
}
```

Then add this describe block after the `buildDigest` block (after line 146):

```ts
  // ── buildFarmerDigest ─────────────────────────────────────────────────────
  describe('buildFarmerDigest', () => {
    it('returns null when the farmer has no items that day', async () => {
      db.orderBy.mockResolvedValueOnce([]);
      const result = await service.buildFarmerDigest(TENANT_ID, 'farmer-1', TODAY, 'Петър');
      expect(result).toBeNull();
    });

    it('builds a prep summary + per-order items for the farmer', async () => {
      db.orderBy.mockResolvedValueOnce([
        { orderId: 'o1', deliveryType: 'address', customerName: 'Иван', deliveryAddress: 'ул. 1',
          deliveryCity: null, econtOffice: null, slotFrom: '10:00:00', slotTo: '12:00:00',
          productName: 'Домати', quantity: 3 },
        { orderId: 'o1', deliveryType: 'address', customerName: 'Иван', deliveryAddress: 'ул. 1',
          deliveryCity: null, econtOffice: null, slotFrom: '10:00:00', slotTo: '12:00:00',
          productName: 'Краставици', quantity: 2 },
        { orderId: 'o2', deliveryType: 'econt', customerName: 'Мария', deliveryAddress: null,
          deliveryCity: null, econtOffice: 'Офис Пловдив', slotFrom: null, slotTo: null,
          productName: 'Домати', quantity: 5 },
      ]);

      const result = await service.buildFarmerDigest(TENANT_ID, 'farmer-1', TODAY, 'Петър');

      expect(result).not.toBeNull();
      expect(result!.summary.totalOrders).toBe(2);
      // prep summary: Домати 3+5 = 8, Краставици 2
      expect(result!.html).toContain('Домати');
      expect(result!.html).toContain('Краставици');
      expect(result!.text).toContain('8'); // tomato total
      // delivery breakdown shows customers + econt destination
      expect(result!.html).toContain('Иван');
      expect(result!.html).toContain('Офис Пловдив');
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @farmflow/api test -- digest.service.spec`
Expected: FAIL — `service.buildFarmerDigest is not a function`.

- [ ] **Step 3: Implement `buildFarmerDigest` + renderers**

In `server/src/modules/digest/digest.service.ts`:

(a) Extend the `@farmflow/db` import (line 4) to add `orderItems` and `products`:

```ts
import { type Database, orders, orderItems, products, deliverySlots, tenants } from '@farmflow/db';
```

(b) After the `DigestOrder` interface (after line 18), add the farmer row/order types:

```ts
interface FarmerItem {
  productName: string;
  quantity: number;
}

interface FarmerOrder extends DigestOrder {
  items: FarmerItem[];
}
```

(c) After `renderText` (after line 159), add the farmer renderers:

```ts
function renderFarmerHtml(
  date: string,
  farmerName: string,
  prep: FarmerItem[],
  addressOrders: FarmerOrder[],
  econtOrders: FarmerOrder[],
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

  return `<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>Твоите доставки за ${date}</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <h1 style="font-size:20px;color:#2d6a4f;border-bottom:2px solid #2d6a4f;padding-bottom:8px">
    ${escapeHtml(farmerName)} — доставки за ${date}
  </h1>
  <h2 style="font-size:16px;color:#333;margin:20px 0 8px">За приготвяне</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px"><tbody>${prepRows}</tbody></table>
  ${addressSection}
  ${econtSection}
  <p style="font-size:12px;color:#999;margin-top:32px">FarmFlow — автоматичен дайджест за фермер</p>
</body>
</html>`;
}

function renderFarmerText(
  date: string,
  farmerName: string,
  prep: FarmerItem[],
  addressOrders: FarmerOrder[],
  econtOrders: FarmerOrder[],
): string {
  const lines: string[] = [`${farmerName} — доставки за ${date}`, '', 'За приготвяне:'];
  for (const p of prep) lines.push(`  • ${p.productName} — ${p.quantity} бр`);
  lines.push('');

  if (addressOrders.length > 0) {
    lines.push(`Доставка до адрес (${addressOrders.length}):`);
    for (const o of addressOrders) {
      const slot = o.slotFrom && o.slotTo ? ` [${hhmm(o.slotFrom)}–${hhmm(o.slotTo)}]` : '';
      lines.push(`  • ${o.customerName ?? '—'} — ${o.deliveryAddress ?? '—'}${slot}`);
      for (const it of o.items) lines.push(`      - ${it.productName} × ${it.quantity}`);
    }
    lines.push('');
  }

  if (econtOrders.length > 0) {
    lines.push(`Еконт — за изпращане (${econtOrders.length}):`);
    for (const o of econtOrders) {
      lines.push(`  • ${o.customerName ?? '—'} — ${econtDestination(o)}`);
      for (const it of o.items) lines.push(`      - ${it.productName} × ${it.quantity}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
```

(d) Add the method to the `DigestService` class, after `buildDigest` (after line 220):

```ts
  /**
   * Build a per-farmer digest: only orders containing this farmer's products,
   * showing a prep summary + per-order breakdown of the farmer's own line items.
   * Returns null when the farmer has no items on the date.
   */
  async buildFarmerDigest(
    tenantId: string,
    farmerId: string,
    date: string,
    farmerName = '',
  ): Promise<DigestResult | null> {
    const rows = await this.db
      .select({
        orderId: orders.id,
        deliveryType: orders.deliveryType,
        customerName: orders.customerName,
        deliveryAddress: orders.deliveryAddress,
        deliveryCity: orders.deliveryCity,
        econtOffice: orders.econtOffice,
        slotFrom: deliverySlots.timeFrom,
        slotTo: deliverySlots.timeTo,
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
          eq(orders.status, 'confirmed'),
          sql`${bgDate(orders.createdAt)} = ${date}`,
          eq(products.farmerId, farmerId),
        )!,
      )
      .orderBy(orders.createdAt);

    if (rows.length === 0) return null;

    // Group line items by order.
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
          items: [],
        };
        byOrder.set(r.orderId, o);
      }
      o.items.push({ productName: r.productName ?? '—', quantity: r.quantity });
    }
    const orderList = [...byOrder.values()];
    const addressOrders = orderList.filter((o) => o.deliveryType === 'address');
    const econtOrders = orderList.filter(
      (o) => o.deliveryType === 'econt' || o.deliveryType === 'econt_address',
    );

    // Prep summary: total qty per product across the day.
    const prepMap = new Map<string, number>();
    for (const r of rows) {
      const name = r.productName ?? '—';
      prepMap.set(name, (prepMap.get(name) ?? 0) + r.quantity);
    }
    const prep: FarmerItem[] = [...prepMap.entries()]
      .map(([productName, quantity]) => ({ productName, quantity }))
      .sort((a, b) => b.quantity - a.quantity);

    const distinctCustomers = new Set(
      orderList.map((o) => o.customerName?.trim().toLowerCase()),
    ).size;

    return {
      html: renderFarmerHtml(date, farmerName, prep, addressOrders, econtOrders),
      text: renderFarmerText(date, farmerName, prep, addressOrders, econtOrders),
      summary: {
        selfDeliveryCount: addressOrders.length,
        econtCount: econtOrders.length,
        totalOrders: orderList.length,
        distinctCustomers,
      },
    };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @farmflow/api test -- digest.service.spec`
Expected: PASS — including the two new `buildFarmerDigest` tests and all existing tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/digest/digest.service.ts server/src/modules/digest/digest.service.spec.ts
git commit -m "feat(digest): buildFarmerDigest — per-farmer prep + delivery breakdown"
```

---

## Task 3: Wire farmer digests into the cron + test endpoint

**Files:**
- Modify: `server/src/modules/digest/digest.service.ts`
- Modify: `server/src/modules/digest/digest.controller.ts`
- Test: `server/src/modules/digest/digest.service.spec.ts`

- [ ] **Step 1: Write the failing cron test**

In `server/src/modules/digest/digest.service.spec.ts`, add this test inside the existing `describe('runDailyDigests', ...)` block (after line 213):

```ts
    it('sends farmer digests for a multi-farmer tenant with no owner email', async () => {
      // tenant query: multiFarmer on, no owner email
      db.orderBy.mockResolvedValueOnce([{ id: TENANT_ID, email: null, multiFarmer: true }]);
      // farmers-with-email query
      db.orderBy.mockResolvedValueOnce([{ id: 'f1', name: 'Петър', email: 'petar@ferma.bg' }]);
      // buildFarmerDigest items query
      db.orderBy.mockResolvedValueOnce([
        { orderId: 'o1', deliveryType: 'address', customerName: 'Иван', deliveryAddress: 'ул. 1',
          deliveryCity: null, econtOffice: null, slotFrom: null, slotTo: null,
          productName: 'Домати', quantity: 3 },
      ]);

      await service.runDailyDigests();

      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'petar@ferma.bg' }),
      );
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @farmflow/api test -- digest.service.spec`
Expected: FAIL — no email sent to the farmer (cron doesn't loop farmers yet); also the tenant query currently filters out null-email tenants.

- [ ] **Step 3: Add `or` to the drizzle import**

In `server/src/modules/digest/digest.service.ts`, change line 3 from:

```ts
import { and, eq, isNotNull, sql } from 'drizzle-orm';
```

to:

```ts
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
```

Add `farmers` to the `@farmflow/db` import (the line edited in Task 2 Step 3a):

```ts
import { type Database, orders, orderItems, products, deliverySlots, tenants, farmers } from '@farmflow/db';
```

- [ ] **Step 4: Add the `sendFarmerDigests` helper**

In `DigestService`, add after `buildFarmerDigest`:

```ts
  /**
   * Send a per-farmer digest to every farmer of the tenant that has an email
   * and items for the date. Returns how many emails were sent. Per-farmer
   * try/catch so one failure does not abort the rest.
   */
  private async sendFarmerDigests(tenantId: string, date: string): Promise<number> {
    const farmerRows = await this.db
      .select({ id: farmers.id, name: farmers.name, email: farmers.email })
      .from(farmers)
      .where(and(eq(farmers.tenantId, tenantId), isNotNull(farmers.email))!)
      .orderBy(farmers.id);

    let sent = 0;
    for (const f of farmerRows) {
      if (!f.email) continue;
      try {
        const digest = await this.buildFarmerDigest(tenantId, f.id, date, f.name);
        if (!digest) continue;
        await this.email.sendMail({
          to: f.email,
          subject: 'Твоите доставки за днес — FarmFlow',
          html: digest.html,
          text: digest.text,
        });
        sent++;
        this.logger.log(`[digest] Farmer sent tenant=${tenantId} farmer=${f.id}`);
      } catch (err) {
        this.logger.error(
          `[digest] Farmer failed tenant=${tenantId} farmer=${f.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return sent;
  }
```

- [ ] **Step 5: Update `runDailyDigests` to load multiFarmer + loop farmers**

Replace the tenant query and loop in `runDailyDigests` (lines 228–258) with:

```ts
    const today = bgToday();

    const tenantRows = await this.db
      .select({ id: tenants.id, email: tenants.email, multiFarmer: tenants.multiFarmer })
      .from(tenants)
      .where(or(isNotNull(tenants.email), eq(tenants.multiFarmer, true))!)
      .orderBy(tenants.id);

    for (const tenant of tenantRows) {
      // Owner digest (unchanged) — only when the tenant has an email.
      if (tenant.email) {
        try {
          const digest = await this.buildDigest(tenant.id, today);
          if (!digest) {
            this.logger.log(`[digest] No orders for tenant=${tenant.id} on ${today} — skipping`);
          } else {
            await this.email.sendMail({
              to: tenant.email,
              subject: 'Доставки за днес — FarmFlow',
              html: digest.html,
              text: digest.text,
            });
            this.logger.log(
              `[digest] Sent to tenant=${tenant.id} orders=${digest.summary.totalOrders}`,
            );
          }
        } catch (err) {
          this.logger.error(
            `[digest] Failed for tenant=${tenant.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Per-farmer digests — only in multi-farmer mode.
      if (tenant.multiFarmer) {
        try {
          await this.sendFarmerDigests(tenant.id, today);
        } catch (err) {
          this.logger.error(
            `[digest] Farmer batch failed tenant=${tenant.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @farmflow/api test -- digest.service.spec`
Expected: PASS — new farmer-cron test plus all existing runDailyDigests tests still green. (The existing tests' tenant rows lack `multiFarmer`, so it reads as `undefined` → falsy → farmer path skipped. Owner-digest behavior unchanged.)

- [ ] **Step 7: Extend the test endpoint to also fire farmer digests**

Replace `sendTestDigest` (lines 265–291) with:

```ts
  /**
   * Used by POST /digest/test: build today's owner digest for the tenant and
   * (in multi-farmer mode) the per-farmer digests, sending immediately.
   */
  async sendTestDigest(
    tenantId: string,
  ): Promise<{ sent: boolean; reason?: string; farmersSent: number }> {
    const today = bgToday();

    const [tenant] = await this.db
      .select({ email: tenants.email, multiFarmer: tenants.multiFarmer })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const farmersSent = tenant?.multiFarmer
      ? await this.sendFarmerDigests(tenantId, today)
      : 0;

    if (!tenant?.email) {
      return { sent: false, reason: 'no-email', farmersSent };
    }

    const digest = await this.buildDigest(tenantId, today);
    if (!digest) {
      return { sent: false, reason: 'no-orders', farmersSent };
    }

    await this.email.sendMail({
      to: tenant.email,
      subject: 'Доставки за днес — FarmFlow (тест)',
      html: digest.html,
      text: digest.text,
    });

    return { sent: true, farmersSent };
  }
```

- [ ] **Step 8: Update the controller return type**

In `server/src/modules/digest/digest.controller.ts`, change the `testDigest` signature (lines 16–18) to:

```ts
  @Post('test')
  testDigest(
    @CurrentTenant() tenantId: string,
  ): Promise<{ sent: boolean; reason?: string; farmersSent: number }> {
    return this.digestService.sendTestDigest(tenantId);
  }
```

- [ ] **Step 9: Run the digest tests again**

Run: `pnpm --filter @farmflow/api test -- digest.service.spec`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/src/modules/digest/digest.service.ts \
        server/src/modules/digest/digest.service.spec.ts \
        server/src/modules/digest/digest.controller.ts
git commit -m "feat(digest): send per-farmer daily emails from cron + test endpoint"
```

---

## Task 4: Production farmer attribution (server)

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts`

No unit test: the change is a SQL join + a pass-through map, not testable with the lightweight chain mock used in this codebase (the existing orders spec only tests the pure `serializeOrder`). Covered by typecheck (Task 7) and manual production-page verification (Task 7 Step 5).

- [ ] **Step 1: Add `farmers` to the `@farmflow/db` import**

In `server/src/modules/orders/orders.service.ts`, extend the import (lines 10–17) to include `farmers`:

```ts
import {
  type Database,
  orders,
  orderItems,
  products,
  deliverySlots,
  tenants,
  farmers,
} from '@farmflow/db';
```

- [ ] **Step 2: Add farmer fields to the production interfaces**

Replace `ProductionItem` and `ProductionSummary` (lines 61–71) with:

```ts
export interface ProductionItem {
  productName: string;
  totalQty: number;
  orderCount: number;
  farmerId: string | null;
  farmerName: string | null;
}

export interface ProductionSummary {
  date: string;
  confirmedOrders: number;
  multiFarmer: boolean;
  items: ProductionItem[];
}
```

- [ ] **Step 3: Join farmer data + multiFarmer flag in `production()`**

Replace the body of `production()` (lines 181–215) with:

```ts
  async production(tenantId: string, date?: string): Promise<ProductionSummary> {
    const day = date ?? bgToday();
    const onDay = and(
      eq(orders.tenantId, tenantId),
      eq(orders.status, 'confirmed'),
      sql`${bgDate(orders.createdAt)} = ${day}`,
    )!;

    const rows = await this.db
      .select({
        productName: orderItems.productName,
        totalQty: sql<number>`sum(${orderItems.quantity})::int`,
        orderCount: sql<number>`count(distinct ${orderItems.orderId})::int`,
        farmerId: products.farmerId,
        farmerName: farmers.name,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .leftJoin(products, eq(orderItems.productId, products.id))
      .leftJoin(farmers, eq(products.farmerId, farmers.id))
      .where(onDay)
      .groupBy(orderItems.productName, products.farmerId, farmers.name)
      .orderBy(sql`sum(${orderItems.quantity}) desc`, orderItems.productName);

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(onDay);

    const [tenant] = await this.db
      .select({ multiFarmer: tenants.multiFarmer })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    return {
      date: day,
      confirmedOrders: count,
      multiFarmer: tenant?.multiFarmer ?? false,
      items: rows.map((r) => ({
        productName: r.productName ?? '',
        totalQty: r.totalQty,
        orderCount: r.orderCount,
        farmerId: r.farmerId ?? null,
        farmerName: r.farmerName ?? null,
      })),
    };
  }
```

- [ ] **Step 4: Verify the server still compiles + all tests pass**

Run: `pnpm --filter @farmflow/api test`
Expected: PASS (all tests, no regressions).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/orders.service.ts
git commit -m "feat(orders): farmer attribution + multiFarmer flag in production summary"
```

---

## Task 5: Farmer email input (client)

**Files:**
- Modify: `client/src/components/farmers/farmer-panel.tsx`

- [ ] **Step 1: Add email state**

In `client/src/components/farmers/farmer-panel.tsx`, after the `phone` state (line 35), add:

```ts
  const [email, setEmail] = useState(farmer.email ?? '');
```

- [ ] **Step 2: Include email in the save payload**

In `save()`, change the `data` object (lines 53–59) to include email (sent as `null` when blank so it can be cleared; `@IsOptional()` skips validation on `null`):

```ts
      const data = {
        name: name.trim(),
        role: role.trim(),
        bio: bio.trim(),
        phone: phone.trim(),
        email: email.trim() || null,
        since: since.trim(),
      };
```

- [ ] **Step 3: Add the email input field**

After the phone/since grid `</div>` (after line 156), add:

```tsx
          <label className={labelCls}>
            Имейл (за дневния списък с доставки)
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="напр. petar@ferma.bg"
              className={field}
            />
          </label>
```

- [ ] **Step 4: Verify the client builds**

Run: `pnpm --filter @farmflow/web build`
Expected: build succeeds. (If the client package name differs, use the name from `client/package.json`; confirm with `cat client/package.json | grep '"name"'`.)

- [ ] **Step 5: Commit**

```bash
git add client/src/components/farmers/farmer-panel.tsx
git commit -m "feat(farmers-ui): email input on the farmer panel"
```

---

## Task 6: Production page farmer dropdown (client)

**Files:**
- Modify: `client/src/lib/types.ts`
- Modify: `client/src/components/production/prep-list.tsx`

- [ ] **Step 1: Mirror the new fields in client types**

In `client/src/lib/types.ts`, replace `ProductionItem` and `ProductionSummary` (lines 374–385) with:

```ts
export interface ProductionItem {
  productName: string;
  totalQty: number;
  orderCount: number;
  farmerId: string | null;
  farmerName: string | null;
}

/** Daily prep list (GET /orders/production?date=). */
export interface ProductionSummary {
  date: string; // YYYY-MM-DD
  confirmedOrders: number;
  multiFarmer: boolean;
  items: ProductionItem[];
}
```

- [ ] **Step 2: Add `useMemo` import + filter state**

In `client/src/components/production/prep-list.tsx`, change the React import (line 3) to:

```ts
import { useEffect, useMemo, useState } from 'react';
```

After `const [done, setDone] = useState<Record<string, boolean>>({});` (line 27), add the filter state and derived data:

```ts
  const [farmerFilter, setFarmerFilter] = useState<string>('all');

  // Distinct farmers present in today's items (+ whether any item is unassigned).
  const { farmerList, hasUnassigned } = useMemo(() => {
    const m = new Map<string, string>();
    let unassigned = false;
    for (const it of items) {
      if (it.farmerId && it.farmerName) m.set(it.farmerId, it.farmerName);
      else unassigned = true;
    }
    return { farmerList: [...m.entries()], hasUnassigned: unassigned };
  }, [items]);

  const showFarmerFilter = summary.multiFarmer && (farmerList.length > 0 || hasUnassigned);

  // Items after applying the farmer filter.
  const shown = items.filter((it) => {
    if (farmerFilter === 'all') return true;
    if (farmerFilter === 'none') return !it.farmerId;
    return it.farmerId === farmerFilter;
  });
```

- [ ] **Step 3: Compute totals from the filtered set**

Replace the `totalQty` / `doneQty` lines (lines 39–40) with:

```ts
  const totalQty = shown.reduce((s, r) => s + r.totalQty, 0);
  const doneQty = shown.filter((r) => done[r.productName]).reduce((s, r) => s + r.totalQty, 0);
```

- [ ] **Step 4: Render the dropdown next to the date picker**

In the summary/date-pick row, immediately before the `<label>` date picker (before line 62), add:

```tsx
        {showFarmerFilter && (
          <select
            value={farmerFilter}
            onChange={(e) => setFarmerFilter(e.target.value)}
            aria-label="Филтър по фермер"
            className="rounded-xl border border-ff-border bg-ff-surface px-3.5 py-2.5 text-[13.5px] font-bold text-ff-ink-2 shadow-ff-sm transition-colors hover:bg-ff-surface-2"
          >
            <option value="all">Всички фермери</option>
            {farmerList.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
            {hasUnassigned && <option value="none">Без фермер</option>}
          </select>
        )}
```

- [ ] **Step 5: Render the filtered list instead of all items**

In the prep list, replace the three `items` references with `shown`:
- Line 90: `{items.map((r, i) => {` → `{shown.map((r, i) => {`
- Line 98: `i < items.length - 1 && 'border-b border-ff-border-2',` → `i < shown.length - 1 && 'border-b border-ff-border-2',`
- Line 142: `{items.length === 0 && (` → `{shown.length === 0 && (`

(Leave the localStorage tick logic keyed by `productName` unchanged.)

- [ ] **Step 6: Verify the client builds**

Run: `pnpm --filter @farmflow/web build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/types.ts client/src/components/production/prep-list.tsx
git commit -m "feat(production-ui): farmer filter dropdown on the prep list"
```

---

## Task 7: Full verification + memory update

**Files:**
- Modify: `C:\Users\Lenovo\.claude\projects\C--Users-Lenovo-source-repos-FarmFlow\memory\*` (per the consolidate-memory convention)

- [ ] **Step 1: Typecheck + build everything**

Run: `pnpm build`
Expected: turbo builds db, types, server, client — all succeed.

- [ ] **Step 2: Run the full server test suite**

Run: `pnpm --filter @farmflow/api test`
Expected: PASS — total count = previous 141 + new tests (3 DTO + 2 buildFarmerDigest + 1 cron = 147).

- [ ] **Step 3: Apply the migration locally**

Run: `pnpm --filter @farmflow/db migrate`
Expected: `0031_*` applied; `farmers.email` column exists. (Dev DB on port 5433 per project notes.)

- [ ] **Step 4: Manual — farmer email saves**

Start the stack, open the admin Farmers page, edit a farmer, enter an email, save. Reload and confirm the email persists. Enter an invalid email and confirm the save is rejected (400 from DTO validation).

- [ ] **Step 5: Manual — production dropdown**

With `multiFarmer` enabled and products assigned to ≥2 farmers, confirm orders for a day, open Подготви продукти. Confirm the dropdown appears with «Всички фермери» + each farmer (+ «Без фермер» if any product is unassigned). Switch farmers and confirm the list + the progress totals filter correctly. With `multiFarmer` off, confirm the dropdown is hidden.

- [ ] **Step 6: Manual — per-farmer email**

With a farmer that has an email and items in today's confirmed orders, `POST /digest/test` (admin-authed). Confirm the response includes `farmersSent >= 1` and that the farmer's email appears in the dev mail preview (`.mail-preview/`, since no SMTP in dev) containing the prep summary + per-order breakdown of only that farmer's items.

- [ ] **Step 7: Update project memory**

Add a memory entry (new file + index line) summarizing: farmer `email` column (migration 0031), per-farmer daily digest riding the 07:00 cron (gated on `multiFarmer` + farmer email; owner digest unchanged), and the production-page farmer filter. Branch `feat/farmer-emails-daily-digest`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: verify farmer-emails feature + update project memory"
```

---

## Self-Review

- **Spec coverage:** farmer email field (Task 1) ✓; per-farmer digest content both prep-summary + breakdown (Task 2) ✓; 07:00 cron wiring + owner digest unchanged (Task 3) ✓; test endpoint (Task 3) ✓; production attribution + multiFarmer flag (Task 4) ✓; farmer email input (Task 5) ✓; production dropdown gated on multiFarmer with «Без фермер» bucket (Task 6) ✓; tests for DTO + buildFarmerDigest + cron (Tasks 1–3) ✓; edge cases (unassigned excluded from farmer emails, null-on-empty, multiFarmer-off hides dropdown) handled in Tasks 2/3/4/6 ✓.
- **Placeholder scan:** none — every code step has full content.
- **Type consistency:** `buildFarmerDigest(tenantId, farmerId, date, farmerName)` signature matches its callers in `sendFarmerDigests` and the tests; `ProductionItem`/`ProductionSummary` shapes identical in server (Task 4) and client (Task 6); `sendTestDigest` return type `{ sent, reason?, farmersSent }` matches the controller (Task 3 Steps 7–8); `FarmerOrder extends DigestOrder` so `econtDestination(o)` accepts it.
- **Verification note:** Task 4 has no unit test by design (SQL join, not chain-mockable here) — explicitly covered by typecheck + manual production verification.
