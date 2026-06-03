# Digest & Newsletter Broadcast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two NestJS modules — a daily delivery-digest emailer with a manual test endpoint, and a newsletter-broadcast system with personalized unsubscribe links — wired into the existing FarmFlow server.

**Architecture:** Two sibling modules (`digest/` and `newsletter/`) follow the exact same pattern as `routing/`, `dashboard/`, and `intake/` modules: a `*.service.ts` injecting `DB_TOKEN` + `EmailService`, a `*.controller.ts` using `JwtAuthGuard` + `@CurrentTenant()`, and a `*.module.ts` referencing both. `DigestModule` also uses `@nestjs/schedule`'s `@Cron` for the 07:00 Sofia job. `NewsletterModule` imports `AuthModule` so it can inject `JwtService` for signing/verifying unsubscribe tokens. The public unsubscribe endpoint lives on `NewsletterController` under `/public/unsubscribe?token=...` (no guard).

**Tech Stack:** NestJS 10, Drizzle ORM 0.35, `@nestjs/schedule` (already wired), `@nestjs/jwt` (re-exported by `AuthModule`), `class-validator`, Jest / ts-jest.

---

## File Map

### Feature 1 — Digest

| Path | Role |
|------|------|
| `server/src/modules/digest/digest.service.ts` | `buildDigest(tenantId, date)` query + HTML/text render; `runDailyDigests()` cron |
| `server/src/modules/digest/digest.controller.ts` | `POST /digest/test` (JWT-guarded) |
| `server/src/modules/digest/digest.module.ts` | wires service + controller |
| `server/src/modules/digest/digest.service.spec.ts` | unit tests for service |

### Feature 2 — Newsletter broadcast + unsubscribe

| Path | Role |
|------|------|
| `server/src/modules/newsletter/dto/broadcast.dto.ts` | `BroadcastDto` with `subject` + `body` validations |
| `server/src/modules/newsletter/newsletter.service.ts` | `getSubscribers`, `broadcast`, `unsubscribe` |
| `server/src/modules/newsletter/newsletter.controller.ts` | `GET /subscribers`, `POST /broadcast`, `GET /public/unsubscribe` |
| `server/src/modules/newsletter/newsletter.module.ts` | imports `AuthModule` for `JwtService` |
| `server/src/modules/newsletter/newsletter.service.spec.ts` | unit tests for service |

### Modified files

| Path | Change |
|------|--------|
| `server/src/app.module.ts` | import `DigestModule` + `NewsletterModule` |

---

## Task 1 — DigestService: failing tests

**Files:**
- Create: `server/src/modules/digest/digest.service.spec.ts`

- [ ] **Step 1.1: Create the spec file with failing tests**

```typescript
// server/src/modules/digest/digest.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { DigestService } from './digest.service';
import { EmailService } from '../../common/email/email.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

// ── Mock DB builder ─────────────────────────────────────────────────────────
function makeDb() {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    leftJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([]),
  };
}

function makeEmailService() {
  return { sendMail: jest.fn().mockResolvedValue(undefined) };
}

const TENANT_ID = 'tenant-uuid-1';
const TODAY = '2026-06-03';

describe('DigestService', () => {
  let service: DigestService;
  let db: ReturnType<typeof makeDb>;
  let emailService: ReturnType<typeof makeEmailService>;

  beforeEach(async () => {
    db = makeDb();
    emailService = makeEmailService();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DigestService,
        { provide: DB_TOKEN, useValue: db },
        { provide: EmailService, useValue: emailService },
      ],
    }).compile();

    service = module.get(DigestService);
    // Suppress logger noise in tests
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  // ── buildDigest ─────────────────────────────────────────────────────────

  describe('buildDigest', () => {
    it('returns null when there are no confirmed orders for the date', async () => {
      // DB query returns empty array for orders
      db.orderBy.mockResolvedValue([]);

      const result = await service.buildDigest(TENANT_ID, TODAY);

      expect(result).toBeNull();
    });

    it('splits address orders vs econt orders into the correct groups', async () => {
      const addressOrder = {
        id: 'ord-1',
        deliveryType: 'address',
        customerName: 'Иван Иванов',
        deliveryAddress: 'ул. Роза 5, София',
        econtOffice: null,
        slotFrom: '10:00:00',
        slotTo: '12:00:00',
      };
      const econtOrder = {
        id: 'ord-2',
        deliveryType: 'econt',
        customerName: 'Мария Петрова',
        deliveryAddress: null,
        econtOffice: 'Офис Пловдив Център',
        slotFrom: null,
        slotTo: null,
      };
      db.orderBy.mockResolvedValue([addressOrder, econtOrder]);

      const result = await service.buildDigest(TENANT_ID, TODAY);

      expect(result).not.toBeNull();
      expect(result!.summary.selfDeliveryCount).toBe(1);
      expect(result!.summary.econtCount).toBe(1);
      expect(result!.summary.totalOrders).toBe(2);
      expect(result!.summary.distinctCustomers).toBe(2);
    });

    it('generates html containing customer names', async () => {
      const addressOrder = {
        id: 'ord-1',
        deliveryType: 'address',
        customerName: 'Иван Иванов',
        deliveryAddress: 'ул. Роза 5, София',
        econtOffice: null,
        slotFrom: '10:00:00',
        slotTo: '12:00:00',
      };
      db.orderBy.mockResolvedValue([addressOrder]);

      const result = await service.buildDigest(TENANT_ID, TODAY);

      expect(result!.html).toContain('Иван Иванов');
      expect(result!.text).toContain('Иван Иванов');
    });

    it('generates html containing econt office name', async () => {
      const econtOrder = {
        id: 'ord-1',
        deliveryType: 'econt',
        customerName: 'Мария Петрова',
        deliveryAddress: null,
        econtOffice: 'Офис Пловдив Център',
        slotFrom: null,
        slotTo: null,
      };
      db.orderBy.mockResolvedValue([econtOrder]);

      const result = await service.buildDigest(TENANT_ID, TODAY);

      expect(result!.html).toContain('Офис Пловдив Център');
      expect(result!.text).toContain('Офис Пловдив Център');
    });

    it('includes slot time range for address orders that have a slot', async () => {
      const addressOrder = {
        id: 'ord-1',
        deliveryType: 'address',
        customerName: 'Иван Иванов',
        deliveryAddress: 'ул. Роза 5',
        econtOffice: null,
        slotFrom: '10:00:00',
        slotTo: '12:00:00',
      };
      db.orderBy.mockResolvedValue([addressOrder]);

      const result = await service.buildDigest(TENANT_ID, TODAY);

      expect(result!.html).toContain('10:00');
      expect(result!.html).toContain('12:00');
    });
  });

  // ── runDailyDigests ─────────────────────────────────────────────────────

  describe('runDailyDigests', () => {
    it('sends an email when a tenant has a non-null email and has orders', async () => {
      const tenantRow = { id: TENANT_ID, email: 'farmer@test.bg' };
      // First call: get all tenants with email
      db.orderBy.mockResolvedValueOnce([tenantRow]);
      // Second call: buildDigest → orders query
      const addressOrder = {
        id: 'ord-1',
        deliveryType: 'address',
        customerName: 'Тест Клиент',
        deliveryAddress: 'ул. 1',
        econtOffice: null,
        slotFrom: null,
        slotTo: null,
      };
      db.orderBy.mockResolvedValueOnce([addressOrder]);

      await service.runDailyDigests();

      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'farmer@test.bg' }),
      );
    });

    it('does not send when digest returns null (no orders)', async () => {
      const tenantRow = { id: TENANT_ID, email: 'farmer@test.bg' };
      db.orderBy.mockResolvedValueOnce([tenantRow]);
      // buildDigest returns null (no orders)
      db.orderBy.mockResolvedValueOnce([]);

      await service.runDailyDigests();

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it('catches error for one tenant and continues to the next', async () => {
      const tenant1 = { id: 'tenant-1', email: 'farmer1@test.bg' };
      const tenant2 = { id: 'tenant-2', email: 'farmer2@test.bg' };
      db.orderBy.mockResolvedValueOnce([tenant1, tenant2]);

      // tenant1 buildDigest throws
      db.orderBy
        .mockRejectedValueOnce(new Error('DB error for tenant 1'))
        // tenant2 buildDigest succeeds with one order
        .mockResolvedValueOnce([
          {
            id: 'ord-1',
            deliveryType: 'address',
            customerName: 'Клиент 2',
            deliveryAddress: 'ул. 2',
            econtOffice: null,
            slotFrom: null,
            slotTo: null,
          },
        ]);

      await expect(service.runDailyDigests()).resolves.toBeUndefined();

      // Only tenant2 email sent
      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'farmer2@test.bg' }),
      );
    });
  });
});
```

- [ ] **Step 1.2: Run to confirm failures**

```bash
cd server
pnpm test -- --testPathPattern=digest.service.spec --no-coverage
```

Expected: "Cannot find module './digest.service'" — all tests fail with import error.

---

## Task 2 — DigestService implementation

**Files:**
- Create: `server/src/modules/digest/digest.service.ts`

- [ ] **Step 2.1: Create the service**

```typescript
// server/src/modules/digest/digest.service.ts
import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { type Database, orders, deliverySlots, tenants } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EmailService } from '../../common/email/email.service';

interface DigestOrder {
  id: string;
  deliveryType: string;
  customerName: string | null;
  deliveryAddress: string | null;
  econtOffice: string | null;
  slotFrom: string | null;
  slotTo: string | null;
}

export interface DigestSummary {
  selfDeliveryCount: number;
  econtCount: number;
  totalOrders: number;
  distinctCustomers: number;
}

export interface DigestResult {
  html: string;
  text: string;
  summary: DigestSummary;
}

function hhmm(t: string | null): string {
  return t ? t.slice(0, 5) : '';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml(date: string, addressOrders: DigestOrder[], econtOrders: DigestOrder[]): string {
  const totalOrders = addressOrders.length + econtOrders.length;
  const distinctCustomers = new Set(
    [...addressOrders, ...econtOrders].map((o) => o.customerName?.trim().toLowerCase()),
  ).size;

  const addressRows = addressOrders
    .map((o) => {
      const slot =
        o.slotFrom && o.slotTo
          ? `${hhmm(o.slotFrom)}–${hhmm(o.slotTo)}`
          : '—';
      return `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(o.customerName ?? '—')}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(o.deliveryAddress ?? '—')}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${slot}</td>
        </tr>`;
    })
    .join('');

  const econtRows = econtOrders
    .map(
      (o) => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(o.customerName ?? '—')}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(o.econtOffice ?? '—')}</td>
        </tr>`,
    )
    .join('');

  const addressSection =
    addressOrders.length > 0
      ? `
      <h2 style="font-size:16px;color:#333;margin:24px 0 8px">Доставка до адрес (${addressOrders.length})</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="padding:6px 8px;text-align:left;border-bottom:2px solid #ddd">Клиент</th>
            <th style="padding:6px 8px;text-align:left;border-bottom:2px solid #ddd">Адрес</th>
            <th style="padding:6px 8px;text-align:left;border-bottom:2px solid #ddd">Час</th>
          </tr>
        </thead>
        <tbody>${addressRows}</tbody>
      </table>`
      : '';

  const econtSection =
    econtOrders.length > 0
      ? `
      <h2 style="font-size:16px;color:#333;margin:24px 0 8px">Еконт офис (${econtOrders.length})</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="padding:6px 8px;text-align:left;border-bottom:2px solid #ddd">Клиент</th>
            <th style="padding:6px 8px;text-align:left;border-bottom:2px solid #ddd">Офис</th>
          </tr>
        </thead>
        <tbody>${econtRows}</tbody>
      </table>`
      : '';

  return `<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>Доставки за ${date}</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <h1 style="font-size:20px;color:#2d6a4f;border-bottom:2px solid #2d6a4f;padding-bottom:8px">
    Доставки за ${date}
  </h1>
  <p style="font-size:14px;color:#555">
    Общо поръчки: <strong>${totalOrders}</strong> &nbsp;|&nbsp;
    До адрес: <strong>${addressOrders.length}</strong> &nbsp;|&nbsp;
    Еконт: <strong>${econtOrders.length}</strong> &nbsp;|&nbsp;
    Уникални клиенти: <strong>${distinctCustomers}</strong>
  </p>
  ${addressSection}
  ${econtSection}
  <p style="font-size:12px;color:#999;margin-top:32px">FarmFlow — автоматичен дайджест</p>
</body>
</html>`;
}

function renderText(date: string, addressOrders: DigestOrder[], econtOrders: DigestOrder[]): string {
  const lines: string[] = [`Доставки за ${date}`, ''];
  lines.push(`Общо: ${addressOrders.length + econtOrders.length} поръчки`);
  lines.push('');

  if (addressOrders.length > 0) {
    lines.push(`Доставка до адрес (${addressOrders.length}):`);
    for (const o of addressOrders) {
      const slot = o.slotFrom && o.slotTo ? ` [${hhmm(o.slotFrom)}–${hhmm(o.slotTo)}]` : '';
      lines.push(`  • ${o.customerName ?? '—'} — ${o.deliveryAddress ?? '—'}${slot}`);
    }
    lines.push('');
  }

  if (econtOrders.length > 0) {
    lines.push(`Еконт (${econtOrders.length}):`);
    for (const o of econtOrders) {
      lines.push(`  • ${o.customerName ?? '—'} — ${o.econtOffice ?? '—'}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly email: EmailService,
  ) {}

  /**
   * Query confirmed orders for a tenant on a given date and build email content.
   * Returns null when there are zero confirmed orders.
   */
  async buildDigest(tenantId: string, date: string): Promise<DigestResult | null> {
    const rows = await this.db
      .select({
        id: orders.id,
        deliveryType: orders.deliveryType,
        customerName: orders.customerName,
        deliveryAddress: orders.deliveryAddress,
        econtOffice: orders.econtOffice,
        slotFrom: deliverySlots.timeFrom,
        slotTo: deliverySlots.timeTo,
      })
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'confirmed'),
          sql`${orders.createdAt}::date = ${date}`,
        )!,
      )
      .orderBy(orders.createdAt);

    if (rows.length === 0) return null;

    const addressOrders = rows.filter((r) => r.deliveryType === 'address');
    const econtOrders = rows.filter((r) => r.deliveryType === 'econt');
    const distinctCustomers = new Set(
      rows.map((o) => o.customerName?.trim().toLowerCase()),
    ).size;

    const html = renderHtml(date, addressOrders, econtOrders);
    const text = renderText(date, addressOrders, econtOrders);

    return {
      html,
      text,
      summary: {
        selfDeliveryCount: addressOrders.length,
        econtCount: econtOrders.length,
        totalOrders: rows.length,
        distinctCustomers,
      },
    };
  }

  /**
   * Daily cron at 07:00 Europe/Sofia: send digests to all tenants that have
   * an email configured and confirmed orders for today.
   */
  @Cron('0 7 * * *', { timeZone: 'Europe/Sofia' })
  async runDailyDigests(): Promise<void> {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });

    const tenantRows = await this.db
      .select({ id: tenants.id, email: tenants.email })
      .from(tenants)
      .where(isNotNull(tenants.email))
      .orderBy(tenants.id);

    for (const tenant of tenantRows) {
      if (!tenant.email) continue;
      try {
        const digest = await this.buildDigest(tenant.id, today);
        if (!digest) {
          this.logger.log(`[digest] No orders for tenant=${tenant.id} on ${today} — skipping`);
          continue;
        }
        await this.email.sendMail({
          to: tenant.email,
          subject: 'Доставки за днес — FarmFlow',
          html: digest.html,
          text: digest.text,
        });
        this.logger.log(
          `[digest] Sent to tenant=${tenant.id} orders=${digest.summary.totalOrders}`,
        );
      } catch (err) {
        this.logger.error(
          `[digest] Failed for tenant=${tenant.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
```

- [ ] **Step 2.2: Run digest service tests — expect green**

```bash
cd server
pnpm test -- --testPathPattern=digest.service.spec --no-coverage
```

Expected: all tests pass.

---

## Task 3 — DigestController + DigestModule

**Files:**
- Create: `server/src/modules/digest/digest.controller.ts`
- Create: `server/src/modules/digest/digest.module.ts`

- [ ] **Step 3.1: Create the controller**

```typescript
// server/src/modules/digest/digest.controller.ts
import { Controller, Post, UseGuards, Logger } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DigestService } from './digest.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('digest')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('digest')
export class DigestController {
  private readonly logger = new Logger(DigestController.name);

  constructor(private readonly digestService: DigestService) {}

  /**
   * Trigger a digest email for today manually — useful for testing SMTP config
   * without waiting for the 07:00 cron.
   */
  @Post('test')
  async testDigest(
    @CurrentTenant() tenantId: string,
  ): Promise<{ sent: boolean; reason?: string }> {
    // Resolve tenant email
    const { db } = this.digestService as any;
    // We delegate entirely to the service: pull tenant, build, send.
    return this.digestService.sendTestDigest(tenantId);
  }
}
```

Wait — the controller calls `sendTestDigest` which doesn't exist yet. We'll add it to the service in the next step.

- [ ] **Step 3.2: Add `sendTestDigest` to DigestService**

Open `server/src/modules/digest/digest.service.ts` and add this method **before** the closing `}` of the class:

```typescript
  /**
   * Used by POST /digest/test: build today's digest for the given tenant and
   * send it to that tenant's email immediately. Returns { sent, reason? }.
   */
  async sendTestDigest(tenantId: string): Promise<{ sent: boolean; reason?: string }> {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' });

    const [tenant] = await this.db
      .select({ email: tenants.email })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant?.email) {
      return { sent: false, reason: 'no-email' };
    }

    const digest = await this.buildDigest(tenantId, today);
    if (!digest) {
      return { sent: false, reason: 'no-orders' };
    }

    await this.email.sendMail({
      to: tenant.email,
      subject: 'Доставки за днес — FarmFlow (тест)',
      html: digest.html,
      text: digest.text,
    });

    return { sent: true };
  }
```

- [ ] **Step 3.3: Fix the controller to call `sendTestDigest` directly (no casting)**

Replace the controller body:

```typescript
// server/src/modules/digest/digest.controller.ts
import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DigestService } from './digest.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('digest')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('digest')
export class DigestController {
  constructor(private readonly digestService: DigestService) {}

  @Post('test')
  testDigest(@CurrentTenant() tenantId: string): Promise<{ sent: boolean; reason?: string }> {
    return this.digestService.sendTestDigest(tenantId);
  }
}
```

- [ ] **Step 3.4: Create the module**

```typescript
// server/src/modules/digest/digest.module.ts
import { Module } from '@nestjs/common';
import { DigestService } from './digest.service';
import { DigestController } from './digest.controller';

@Module({
  controllers: [DigestController],
  providers: [DigestService],
})
export class DigestModule {}
```

- [ ] **Step 3.5: Run digest tests again — still green**

```bash
cd server
pnpm test -- --testPathPattern=digest.service.spec --no-coverage
```

Expected: all tests pass.

---

## Task 4 — NewsletterService: failing tests

**Files:**
- Create: `server/src/modules/newsletter/newsletter.service.spec.ts`

- [ ] **Step 4.1: Create the spec file with failing tests**

```typescript
// server/src/modules/newsletter/newsletter.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { NewsletterService } from './newsletter.service';
import { EmailService } from '../../common/email/email.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

// ── Mock DB builder ─────────────────────────────────────────────────────────
function makeDb() {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([]),
  };
}

function makeEmailService() {
  return { sendMail: jest.fn().mockResolvedValue(undefined) };
}

function makeJwtService() {
  return {
    sign: jest.fn().mockReturnValue('unsub-token-abc'),
    verify: jest.fn(),
  };
}

function makeConfigService() {
  return {
    get: jest.fn().mockReturnValue(undefined),
  };
}

const TENANT_ID = 'tenant-uuid-1';
const OTHER_TENANT_ID = 'tenant-uuid-2';

describe('NewsletterService', () => {
  let service: NewsletterService;
  let db: ReturnType<typeof makeDb>;
  let emailService: ReturnType<typeof makeEmailService>;
  let jwtService: ReturnType<typeof makeJwtService>;

  beforeEach(async () => {
    db = makeDb();
    emailService = makeEmailService();
    jwtService = makeJwtService();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NewsletterService,
        { provide: DB_TOKEN, useValue: db },
        { provide: EmailService, useValue: emailService },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: makeConfigService() },
      ],
    }).compile();

    service = module.get(NewsletterService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  // ── getSubscribers ──────────────────────────────────────────────────────

  describe('getSubscribers', () => {
    it('returns only the calling tenant subscribers, not another tenant\'s', async () => {
      const mySubscriber = {
        id: 'sub-1',
        email: 'a@test.bg',
        createdAt: new Date('2026-01-01'),
        unsubscribedAt: null,
        tenantId: TENANT_ID,
      };
      // Simulate that DB returns only this tenant's subscribers
      db.orderBy.mockResolvedValue([mySubscriber]);

      const result = await service.getSubscribers(TENANT_ID);

      // Verify DB was called with the correct tenantId condition (not OTHER_TENANT_ID)
      expect(result.subscribers).toHaveLength(1);
      expect(result.subscribers[0].email).toBe('a@test.bg');
    });

    it('correctly counts active vs unsubscribed', async () => {
      const active = {
        id: 'sub-1',
        email: 'a@test.bg',
        createdAt: new Date('2026-01-01'),
        unsubscribedAt: null,
        tenantId: TENANT_ID,
      };
      const unsubscribed = {
        id: 'sub-2',
        email: 'b@test.bg',
        createdAt: new Date('2026-01-02'),
        unsubscribedAt: new Date('2026-03-01'),
        tenantId: TENANT_ID,
      };
      db.orderBy.mockResolvedValue([active, unsubscribed]);

      const result = await service.getSubscribers(TENANT_ID);

      expect(result.activeCount).toBe(1);
      expect(result.unsubscribedCount).toBe(1);
    });
  });

  // ── broadcast ──────────────────────────────────────────────────────────

  describe('broadcast', () => {
    it('only sends to active subscribers (unsubscribedAt is null)', async () => {
      const active = {
        id: 'sub-1',
        email: 'active@test.bg',
        createdAt: new Date(),
        unsubscribedAt: null,
        tenantId: TENANT_ID,
      };
      const unsubscribed = {
        id: 'sub-2',
        email: 'gone@test.bg',
        createdAt: new Date(),
        unsubscribedAt: new Date(),
        tenantId: TENANT_ID,
      };
      db.orderBy.mockResolvedValue([active, unsubscribed]);

      const result = await service.broadcast(TENANT_ID, {
        subject: 'Новини',
        body: 'Добре дошли!',
      });

      expect(result.sent).toBe(1);
      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'active@test.bg' }),
      );
    });

    it('sent count matches number of active subscribers', async () => {
      const activeList = [
        { id: 'sub-1', email: 'a@test.bg', createdAt: new Date(), unsubscribedAt: null, tenantId: TENANT_ID },
        { id: 'sub-2', email: 'b@test.bg', createdAt: new Date(), unsubscribedAt: null, tenantId: TENANT_ID },
        { id: 'sub-3', email: 'c@test.bg', createdAt: new Date(), unsubscribedAt: null, tenantId: TENANT_ID },
      ];
      db.orderBy.mockResolvedValue(activeList);

      const result = await service.broadcast(TENANT_ID, { subject: 'Test', body: 'Body' });

      expect(result.sent).toBe(3);
    });

    it('each sent email html contains an unsubscribe link with a token', async () => {
      const active = {
        id: 'sub-1',
        email: 'active@test.bg',
        createdAt: new Date(),
        unsubscribedAt: null,
        tenantId: TENANT_ID,
      };
      db.orderBy.mockResolvedValue([active]);

      await service.broadcast(TENANT_ID, { subject: 'Test', body: 'Здравей!' });

      const callArg = emailService.sendMail.mock.calls[0][0];
      expect(callArg.html).toContain('/public/unsubscribe');
      expect(callArg.html).toContain('unsub-token-abc');
    });

    it('continues sending to remaining subscribers when one fails', async () => {
      const activeList = [
        { id: 'sub-1', email: 'a@test.bg', createdAt: new Date(), unsubscribedAt: null, tenantId: TENANT_ID },
        { id: 'sub-2', email: 'b@test.bg', createdAt: new Date(), unsubscribedAt: null, tenantId: TENANT_ID },
      ];
      db.orderBy.mockResolvedValue(activeList);

      emailService.sendMail
        .mockRejectedValueOnce(new Error('SMTP error'))
        .mockResolvedValueOnce(undefined);

      const result = await service.broadcast(TENANT_ID, { subject: 'Test', body: 'Body' });

      // Only the second one succeeded
      expect(result.sent).toBe(1);
    });
  });

  // ── unsubscribe ────────────────────────────────────────────────────────

  describe('unsubscribe', () => {
    it('sets unsubscribedAt for a valid token pointing to an active subscriber', async () => {
      jwtService.verify.mockReturnValue({ sub: 'sub-1', typ: 'unsub' });
      const subscriber = {
        id: 'sub-1',
        tenantId: TENANT_ID,
        email: 'a@test.bg',
        unsubscribedAt: null,
      };
      db.limit.mockResolvedValue([subscriber]);
      db.returning.mockResolvedValue([{ ...subscriber, unsubscribedAt: new Date() }]);

      const result = await service.unsubscribe('valid-token');

      expect(result.success).toBe(true);
      expect(db.update).toHaveBeenCalled();
    });

    it('is idempotent — already-unsubscribed subscriber still returns success', async () => {
      jwtService.verify.mockReturnValue({ sub: 'sub-1', typ: 'unsub' });
      const subscriber = {
        id: 'sub-1',
        tenantId: TENANT_ID,
        email: 'a@test.bg',
        unsubscribedAt: new Date('2026-01-01'),
      };
      db.limit.mockResolvedValue([subscriber]);

      const result = await service.unsubscribe('valid-token');

      expect(result.success).toBe(true);
      // No update call — already unsubscribed
      expect(db.update).not.toHaveBeenCalled();
    });

    it('returns success:false for an invalid/expired token', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('jwt malformed');
      });

      const result = await service.unsubscribe('bad-token');

      expect(result.success).toBe(false);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('returns success:false when token typ is not "unsub"', async () => {
      jwtService.verify.mockReturnValue({ sub: 'sub-1', typ: 'access' });

      const result = await service.unsubscribe('wrong-typ-token');

      expect(result.success).toBe(false);
    });

    it('returns success:false when subscriber is not found', async () => {
      jwtService.verify.mockReturnValue({ sub: 'sub-999', typ: 'unsub' });
      db.limit.mockResolvedValue([]);

      const result = await service.unsubscribe('token-for-unknown');

      expect(result.success).toBe(false);
    });
  });

  // ── broadcast excludes already-unsubscribed ────────────────────────────

  describe('broadcast excludes unsubscribed after an unsubscribe call', () => {
    it('an unsubscribed subscriber is not in the active list passed to broadcast', async () => {
      // Simulate DB already filtering: broadcast's query returns only active
      db.orderBy.mockResolvedValue([
        // sub-2 is gone now
        { id: 'sub-1', email: 'active@test.bg', createdAt: new Date(), unsubscribedAt: null, tenantId: TENANT_ID },
      ]);

      const result = await service.broadcast(TENANT_ID, { subject: 'S', body: 'B' });

      expect(result.sent).toBe(1);
      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'active@test.bg' }),
      );
    });
  });
});
```

- [ ] **Step 4.2: Run to confirm failures**

```bash
cd server
pnpm test -- --testPathPattern=newsletter.service.spec --no-coverage
```

Expected: "Cannot find module './newsletter.service'" — all tests fail.

---

## Task 5 — NewsletterService implementation

**Files:**
- Create: `server/src/modules/newsletter/dto/broadcast.dto.ts`
- Create: `server/src/modules/newsletter/newsletter.service.ts`

- [ ] **Step 5.1: Create the DTO**

```typescript
// server/src/modules/newsletter/dto/broadcast.dto.ts
import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BroadcastDto {
  @ApiProperty({ example: 'Новини от фермата', minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200)
  subject: string;

  @ApiProperty({ example: 'Здравейте! Имаме нови продукти...', minLength: 1, maxLength: 5000 })
  @IsString()
  @Length(1, 5000)
  body: string;
}
```

- [ ] **Step 5.2: Create the service**

```typescript
// server/src/modules/newsletter/newsletter.service.ts
import { Injectable, Inject, Logger } from '@nestjs/common';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { type Database, newsletterSubscribers } from '@farmflow/db';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EmailService } from '../../common/email/email.service';
import { BroadcastDto } from './dto/broadcast.dto';

type SubscriberRow = typeof newsletterSubscribers.$inferSelect;

export interface SubscribersResult {
  subscribers: { id: string; email: string; createdAt: Date | null }[];
  activeCount: number;
  unsubscribedCount: number;
}

export interface UnsubscribeResult {
  success: boolean;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nl2br(s: string): string {
  return escapeHtml(s).replace(/\n/g, '<br>');
}

@Injectable()
export class NewsletterService {
  private readonly logger = new Logger(NewsletterService.name);
  private readonly appUrl: string;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly email: EmailService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    this.appUrl = config.get<string>('PUBLIC_APP_URL') ?? 'http://localhost:3000';
  }

  async getSubscribers(tenantId: string): Promise<SubscribersResult> {
    const rows = await this.db
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.tenantId, tenantId))
      .orderBy(newsletterSubscribers.createdAt);

    const activeCount = rows.filter((r) => r.unsubscribedAt == null).length;
    const unsubscribedCount = rows.length - activeCount;

    return {
      subscribers: rows.map((r) => ({
        id: r.id,
        email: r.email,
        createdAt: r.createdAt,
      })),
      activeCount,
      unsubscribedCount,
    };
  }

  async broadcast(tenantId: string, dto: BroadcastDto): Promise<{ sent: number }> {
    const rows = await this.db
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.tenantId, tenantId))
      .orderBy(newsletterSubscribers.createdAt);

    const active = rows.filter((r) => r.unsubscribedAt == null);
    let sent = 0;

    for (const subscriber of active) {
      try {
        const token = this.jwt.sign(
          { sub: subscriber.id, typ: 'unsub' },
          { expiresIn: '3650d' },
        );
        const unsubscribeUrl = `${this.appUrl}/public/unsubscribe?token=${encodeURIComponent(token)}`;
        const html = this.renderBroadcastHtml(dto.subject, dto.body, unsubscribeUrl);
        const text = `${dto.body}\n\n---\nОтпишете се: ${unsubscribeUrl}`;

        await this.email.sendMail({
          to: subscriber.email,
          subject: dto.subject,
          html,
          text,
        });
        sent++;
      } catch (err) {
        this.logger.error(
          `[newsletter] Failed to send to subscriber=${subscriber.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { sent };
  }

  async unsubscribe(token: string): Promise<UnsubscribeResult> {
    let payload: { sub?: string; typ?: string };
    try {
      payload = this.jwt.verify(token) as { sub?: string; typ?: string };
    } catch {
      return { success: false };
    }

    if (payload.typ !== 'unsub' || !payload.sub) {
      return { success: false };
    }

    const [subscriber] = await this.db
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.id, payload.sub))
      .limit(1);

    if (!subscriber) {
      return { success: false };
    }

    if (subscriber.unsubscribedAt != null) {
      // Already unsubscribed — idempotent success
      return { success: true };
    }

    await this.db
      .update(newsletterSubscribers)
      .set({ unsubscribedAt: new Date() })
      .where(eq(newsletterSubscribers.id, subscriber.id))
      .returning();

    return { success: true };
  }

  private renderBroadcastHtml(subject: string, body: string, unsubscribeUrl: string): string {
    return `<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <div style="border-bottom:2px solid #2d6a4f;padding-bottom:12px;margin-bottom:20px">
    <h1 style="font-size:20px;color:#2d6a4f;margin:0">${escapeHtml(subject)}</h1>
  </div>
  <div style="font-size:15px;line-height:1.6">${nl2br(body)}</div>
  <div style="margin-top:40px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#999">
    <p>Получавате този имейл, защото сте се абонирали за новини от фермата.</p>
    <p><a href="${unsubscribeUrl}" style="color:#999">Отпишете се от абонамента</a></p>
  </div>
</body>
</html>`;
  }
}
```

- [ ] **Step 5.3: Run newsletter service tests — expect green**

```bash
cd server
pnpm test -- --testPathPattern=newsletter.service.spec --no-coverage
```

Expected: all tests pass.

---

## Task 6 — NewsletterController + NewsletterModule

**Files:**
- Create: `server/src/modules/newsletter/newsletter.controller.ts`
- Create: `server/src/modules/newsletter/newsletter.module.ts`

- [ ] **Step 6.1: Create the controller**

```typescript
// server/src/modules/newsletter/newsletter.controller.ts
import { Controller, Get, Post, Query, Body, UseGuards, Res, Header } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { NewsletterService } from './newsletter.service';
import { BroadcastDto } from './dto/broadcast.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('newsletter')
@Controller()
export class NewsletterController {
  constructor(private readonly newsletterService: NewsletterService) {}

  /** List all subscribers for the current tenant (active + unsubscribed). */
  @Get('subscribers')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  getSubscribers(@CurrentTenant() tenantId: string) {
    return this.newsletterService.getSubscribers(tenantId);
  }

  /** Send a broadcast to all active subscribers. */
  @Post('broadcast')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  broadcast(@CurrentTenant() tenantId: string, @Body() dto: BroadcastDto) {
    return this.newsletterService.broadcast(tenantId, dto);
  }

  /**
   * Public unsubscribe endpoint — no auth guard.
   * Verifies the JWT token, sets unsubscribedAt, returns an HTML confirmation page.
   */
  @Get('public/unsubscribe')
  @ApiQuery({ name: 'token', required: true })
  async publicUnsubscribe(@Query('token') token: string, @Res() res: Response) {
    const result = await this.newsletterService.unsubscribe(token ?? '');

    if (result.success) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>Отписване</title></head>
<body style="font-family:Arial,sans-serif;max-width:480px;margin:60px auto;text-align:center;color:#333">
  <h1 style="font-size:24px;color:#2d6a4f">Отписахте се успешно.</h1>
  <p style="color:#555">Вече няма да получавате имейли от тази ферма.</p>
</body>
</html>`);
    } else {
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>Грешка</title></head>
<body style="font-family:Arial,sans-serif;max-width:480px;margin:60px auto;text-align:center;color:#333">
  <h1 style="font-size:24px;color:#c0392b">Невалидна връзка.</h1>
  <p style="color:#555">Връзката за отписване е невалидна или е изтекла.</p>
</body>
</html>`);
    }
  }
}
```

- [ ] **Step 6.2: Create the module**

```typescript
// server/src/modules/newsletter/newsletter.module.ts
import { Module } from '@nestjs/common';
import { NewsletterService } from './newsletter.service';
import { NewsletterController } from './newsletter.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [NewsletterController],
  providers: [NewsletterService],
})
export class NewsletterModule {}
```

---

## Task 7 — Wire both modules into AppModule

**Files:**
- Modify: `server/src/app.module.ts`

- [ ] **Step 7.1: Add imports**

In `server/src/app.module.ts`, add after the `ArticlesModule` import line:

```typescript
import { DigestModule } from './modules/digest/digest.module';
import { NewsletterModule } from './modules/newsletter/newsletter.module';
```

And add to the `imports` array (after `ArticlesModule`):

```typescript
    DigestModule,
    NewsletterModule,
```

The full modified imports array will look like:

```typescript
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../.env', '.env'],
      validationSchema: envValidationSchema,
    }),
    ScheduleModule.forRoot(),
    DrizzleModule,
    RedisModule,
    EmailModule,
    AuthModule,
    TenantsModule,
    ProductsModule,
    FarmersModule,
    SubcategoriesModule,
    SlotsModule,
    RoutingModule,
    OrdersModule,
    DashboardModule,
    PlatformModule,
    StripeModule,
    IntakeModule,
    ReviewsModule,
    CatalogCacheModule,
    StorageModule,
    ArticlesModule,
    DigestModule,
    NewsletterModule,
  ],
```

---

## Task 8 — Build verification

- [ ] **Step 8.1: Run TypeScript build**

```bash
cd server
pnpm --filter @farmflow/api build
```

Expected: zero TS errors, `dist/` created.

If you see errors like:
- `Property 'sendTestDigest' does not exist` → verify the method was added to `digest.service.ts`
- `Cannot find module` → check all import paths and that `digest.module.ts` / `newsletter.module.ts` exist

---

## Task 9 — Run all tests

- [ ] **Step 9.1: Run full test suite**

```bash
cd server
pnpm --filter @farmflow/api test
```

Expected output includes all existing tests (20+) plus new:
- `DigestService > buildDigest > returns null when there are no confirmed orders` ✓
- `DigestService > buildDigest > splits address orders vs econt orders` ✓
- `DigestService > buildDigest > generates html containing customer names` ✓
- `DigestService > buildDigest > generates html containing econt office name` ✓
- `DigestService > buildDigest > includes slot time range` ✓
- `DigestService > runDailyDigests > sends an email when tenant has orders` ✓
- `DigestService > runDailyDigests > does not send when digest returns null` ✓
- `DigestService > runDailyDigests > catches error for one tenant and continues` ✓
- `NewsletterService > getSubscribers > returns only the calling tenant subscribers` ✓
- `NewsletterService > getSubscribers > correctly counts active vs unsubscribed` ✓
- `NewsletterService > broadcast > only sends to active subscribers` ✓
- `NewsletterService > broadcast > sent count matches active subscribers` ✓
- `NewsletterService > broadcast > each email html contains an unsubscribe link with token` ✓
- `NewsletterService > broadcast > continues when one fails` ✓
- `NewsletterService > unsubscribe > sets unsubscribedAt for valid token` ✓
- `NewsletterService > unsubscribe > is idempotent` ✓
- `NewsletterService > unsubscribe > returns success:false for invalid token` ✓
- `NewsletterService > unsubscribe > returns success:false for wrong typ` ✓
- `NewsletterService > unsubscribe > returns success:false when subscriber not found` ✓
- `NewsletterService > broadcast excludes unsubscribed` ✓

---

## Self-Review Checklist

### Spec coverage

| Requirement | Task covering it |
|---|---|
| `buildDigest(tenantId, date)` with address vs econt split | Task 1 + 2 |
| Slot from/to times in digest | Task 1 (test) + Task 2 (service) |
| HTML email body + plain-text fallback | Task 2 (`renderHtml`, `renderText`) |
| Returns null when zero confirmed orders | Task 1 (test) + Task 2 |
| `@Cron('0 7 * * *', { timeZone: 'Europe/Sofia' })` | Task 2 (`runDailyDigests`) |
| Cron per-tenant try/catch + continue | Task 1 (test) + Task 2 |
| `POST /digest/test` (JWT, tenant) | Task 3 |
| `POST /digest/test` returns `{sent, reason?}` | Task 3 (`sendTestDigest`) |
| `GET /subscribers` (tenant JWT, scoped) | Task 4 (test) + Task 5 + Task 6 |
| `POST /broadcast` (tenant JWT, active only) | Task 4 (test) + Task 5 + Task 6 |
| Broadcast: personalized unsubscribe link in email | Task 4 (test) + Task 5 |
| Broadcast: per-recipient failure does not abort | Task 4 (test) + Task 5 |
| `GET /public/unsubscribe?token=` (no guard, HTML response) | Task 4 (test unsubscribe service) + Task 6 (controller) |
| Valid token → sets `unsubscribedAt` | Task 4 (test) + Task 5 |
| Invalid token → error page | Task 4 (test) + Task 6 (controller) |
| Already-unsubscribed → idempotent success | Task 4 (test) + Task 5 |
| `DigestModule` + `NewsletterModule` in `app.module.ts` | Task 7 |
| `pnpm --filter @farmflow/api build` → zero TS errors | Task 8 |
| `pnpm --filter @farmflow/api test` → all green | Task 9 |

All requirements covered. No placeholders found.

### Type consistency

- `DigestResult.summary` uses `selfDeliveryCount / econtCount / totalOrders / distinctCustomers` consistently across spec and service.
- `UnsubscribeResult.success` used consistently in spec and service.
- `BroadcastDto` (`subject`, `body`) used consistently in DTO, service, and controller.
- `sendTestDigest` defined in Task 3.2 before it is called in Task 3.3 (final controller).
