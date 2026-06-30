# Operator Daily Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One daily 07:00 Europe/Sofia email to the operator (`SUPER_ADMIN_EMAIL`) summarizing farms needing attention (with phones to call), new signups, stuck shipments, daily order pulse, and email revenue — reusing existing platform services.

**Architecture:** A pure renderer (`assembleDigest`) + an `OperatorDigestService` (gathers data via `PlatformInsightsService`/`PlatformService` + one new 24h query, then sends) + an `OperatorDigestProcessor` (BullMQ daily repeatable), all inside `PlatformModule`. No new table, no migration. Mirrors the existing `digest` module pattern.

**Tech Stack:** NestJS, BullMQ repeatable jobs, drizzle-orm, EmailService (global, Resend-backed), Jest.

---

## File Structure

- Create `server/src/modules/platform/operator-digest.render.ts` — pure: input types + helpers + `assembleDigest(input, date) -> { html, text, isEmpty }`. No DB, no email. Independently testable.
- Create `server/src/modules/platform/operator-digest.render.spec.ts` — renderer unit tests.
- Create `server/src/modules/platform/operator-digest.service.ts` — `OperatorDigestService`: `dailyPulse()` (new 24h query) + `runDaily()` (gather → render → send).
- Create `server/src/modules/platform/operator-digest.service.spec.ts` — service tests (deps mocked).
- Create `server/src/modules/platform/operator-digest.processor.ts` — BullMQ daily repeatable + job handler.
- Modify `server/src/common/queue/queue.constants.ts` — add `OPERATOR_DIGEST_QUEUE`.
- Modify `server/src/modules/platform/platform.module.ts` — register queue + providers (processor `RUN_WORKERS`-gated).
- Modify `server/src/modules/platform/platform.controller.ts` — `POST platform/digest/operator-test`.

Test command (Jest): `pnpm --filter @fermeribg/api test <pattern>`. Full suite: `pnpm --filter @fermeribg/api test`. Build: `pnpm --filter @fermeribg/api build`.

---

## Task 1: Pure digest renderer

**Files:**
- Create: `server/src/modules/platform/operator-digest.render.ts`
- Test: `server/src/modules/platform/operator-digest.render.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/platform/operator-digest.render.spec.ts`:

```ts
import { assembleDigest, type OperatorDigestInput } from './operator-digest.render';

const EMPTY: OperatorDigestInput = {
  pulse: { orders24h: 0, revenue24hStotinki: 0, newSignups: [] },
  signals: [],
  stuckDrafts: [],
  emailTotals: { recipientTotal: 0, revenueStotinki: 0, marginStotinki: 0 },
};

describe('assembleDigest', () => {
  it('flags a fully-quiet day as empty', () => {
    const r = assembleDigest(EMPTY, '2026-06-30');
    expect(r.isEmpty).toBe(true);
  });

  it('is not empty when there are orders, signups, signals, or stuck drafts', () => {
    expect(assembleDigest({ ...EMPTY, pulse: { ...EMPTY.pulse, orders24h: 1 } }, '2026-06-30').isEmpty).toBe(false);
    expect(assembleDigest({ ...EMPTY, pulse: { ...EMPTY.pulse, newSignups: [{ name: 'Ферма А', createdAt: new Date() }] } }, '2026-06-30').isEmpty).toBe(false);
    expect(assembleDigest({ ...EMPTY, signals: [{ name: 'Ф', phone: null, signals: [{ label: 'x', action: 'y' }] }] }, '2026-06-30').isEmpty).toBe(false);
    expect(assembleDigest({ ...EMPTY, stuckDrafts: [{ farmerName: 'И', tenantName: 'Т', count: 2, oldestAt: new Date() }] }, '2026-06-30').isEmpty).toBe(false);
  });

  it('email revenue alone does NOT make a day non-empty', () => {
    const r = assembleDigest({ ...EMPTY, emailTotals: { recipientTotal: 50, revenueStotinki: 9999, marginStotinki: 3000 } }, '2026-06-30');
    expect(r.isEmpty).toBe(true);
  });

  it('lists a flagged farm with phone and each signal action in the attention section', () => {
    const r = assembleDigest(
      { ...EMPTY, signals: [{ name: 'Зелена Ферма', phone: '0888123456', signals: [{ label: 'Няма активни продукти', action: 'Помогни да качи продукти' }] }] },
      '2026-06-30',
    );
    expect(r.html).toContain('Зелена Ферма');
    expect(r.html).toContain('0888123456');
    expect(r.html).toContain('Помогни да качи продукти');
    expect(r.text).toContain('Зелена Ферма');
    expect(r.text).toContain('0888123456');
  });

  it('renders — for a missing phone', () => {
    const r = assembleDigest({ ...EMPTY, signals: [{ name: 'Ф', phone: null, signals: [{ label: 'l', action: 'a' }] }] }, '2026-06-30');
    expect(r.text).toContain('—');
  });

  it('escapes HTML in farm names', () => {
    const r = assembleDigest({ ...EMPTY, signals: [{ name: 'A & <b>', phone: null, signals: [{ label: 'l', action: 'a' }] }] }, '2026-06-30');
    expect(r.html).toContain('A &amp; &lt;b&gt;');
    expect(r.html).not.toContain('<b>');
  });

  it('omits the stuck-drafts section when there are none but shows it when present', () => {
    expect(assembleDigest({ ...EMPTY, pulse: { ...EMPTY.pulse, orders24h: 1 } }, '2026-06-30').html).not.toContain('Заседнали доставки');
    const withDrafts = assembleDigest({ ...EMPTY, stuckDrafts: [{ farmerName: 'Иван', tenantName: 'Ферма Х', count: 3, oldestAt: new Date() }] }, '2026-06-30');
    expect(withDrafts.html).toContain('Заседнали доставки');
    expect(withDrafts.html).toContain('Иван');
    expect(withDrafts.html).toContain('Ферма Х');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @fermeribg/api test operator-digest.render`
Expected: FAIL — `Cannot find module './operator-digest.render'`.

- [ ] **Step 3: Write the renderer**

Create `server/src/modules/platform/operator-digest.render.ts`:

```ts
/** Pure renderer for the operator's daily digest email. No DB, no email — just
 *  input → { html, text, isEmpty }. Kept dependency-free so it is unit-testable. */

export interface OperatorDigestInput {
  pulse: {
    orders24h: number;
    revenue24hStotinki: number;
    newSignups: { name: string; createdAt: Date | null }[];
  };
  /** Farms needing attention (the "call list"), pre-sorted by urgency. */
  signals: { name: string; phone: string | null; signals: { label: string; action: string }[] }[];
  stuckDrafts: { farmerName: string; tenantName: string; count: number; oldestAt: Date | null }[];
  emailTotals: { recipientTotal: number; revenueStotinki: number; marginStotinki: number };
}

export interface OperatorDigestRender {
  html: string;
  text: string;
  isEmpty: boolean;
}

function eur(stotinki: number): string {
  return (stotinki / 100).toFixed(2).replace('.', ',') + ' €';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Whole days since `d` (0 if null/future), for "преди N дни". */
function daysAgo(d: Date | null, nowMs: number): number {
  if (!d) return 0;
  return Math.max(0, Math.floor((nowMs - new Date(d).getTime()) / 86_400_000));
}

export function assembleDigest(input: OperatorDigestInput, date: string, nowMs = Date.now()): OperatorDigestRender {
  const { pulse, signals, stuckDrafts, emailTotals } = input;

  const isEmpty =
    signals.length === 0 &&
    stuckDrafts.length === 0 &&
    pulse.newSignups.length === 0 &&
    pulse.orders24h === 0;

  // ── HTML sections ──
  const pulseHtml =
    pulse.orders24h > 0
      ? `<p style="font-size:14px;color:#555">Поръчки (24ч): <strong>${pulse.orders24h}</strong> &nbsp;|&nbsp; Приход: <strong>${eur(pulse.revenue24hStotinki)}</strong></p>`
      : '';

  const attentionHtml =
    signals.length > 0
      ? `<h2 style="font-size:16px;color:#333;margin:24px 0 8px">Ферми за внимание (${signals.length})</h2>` +
        signals
          .map((f) => {
            const items = f.signals
              .map((s) => `<li>${escapeHtml(s.label)} — <span style="color:#555">${escapeHtml(s.action)}</span></li>`)
              .join('');
            return `
        <div style="margin:0 0 12px;padding:10px 12px;border:1px solid #eee;border-radius:8px">
          <div style="font-weight:bold">${escapeHtml(f.name)} <span style="font-weight:normal;color:#2d6a4f">${escapeHtml(f.phone ?? '—')}</span></div>
          <ul style="margin:6px 0 0;padding-left:18px;font-size:14px">${items}</ul>
        </div>`;
          })
          .join('')
      : '';

  const signupsHtml =
    pulse.newSignups.length > 0
      ? `<h2 style="font-size:16px;color:#333;margin:24px 0 8px">Нови регистрации (24ч) (${pulse.newSignups.length})</h2>` +
        `<ul style="font-size:14px">${pulse.newSignups.map((s) => `<li>${escapeHtml(s.name)}</li>`).join('')}</ul>`
      : '';

  const draftsHtml =
    stuckDrafts.length > 0
      ? `<h2 style="font-size:16px;color:#333;margin:24px 0 8px">Заседнали доставки (${stuckDrafts.length})</h2>` +
        `<ul style="font-size:14px">${stuckDrafts
          .map((d) => `<li>${escapeHtml(d.farmerName)} · ${escapeHtml(d.tenantName)} — <strong>${d.count}</strong> чернови (най-стара преди ${daysAgo(d.oldestAt, nowMs)} дни)</li>`)
          .join('')}</ul>`
      : '';

  const emailHtml =
    emailTotals.recipientTotal > 0
      ? `<h2 style="font-size:16px;color:#333;margin:24px 0 8px">Имейл приход (този месец)</h2>` +
        `<p style="font-size:14px;color:#555">Получатели: <strong>${emailTotals.recipientTotal}</strong> &nbsp;|&nbsp; Приход: <strong>${eur(emailTotals.revenueStotinki)}</strong> &nbsp;|&nbsp; Марж: <strong>${eur(emailTotals.marginStotinki)}</strong></p>`
      : '';

  const html = `<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>Дневен отчет за ${date}</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <h1 style="font-size:20px;color:#2d6a4f;border-bottom:2px solid #2d6a4f;padding-bottom:8px">Дневен отчет за ${date}</h1>
  ${pulseHtml}
  ${attentionHtml}
  ${signupsHtml}
  ${draftsHtml}
  ${emailHtml}
  <p style="font-size:12px;color:#999;margin-top:32px">ФермериБГ — автоматичен отчет за оператора</p>
</body>
</html>`;

  // ── Text sections ──
  const lines: string[] = [`Дневен отчет за ${date}`, ''];
  if (pulse.orders24h > 0) {
    lines.push(`Поръчки (24ч): ${pulse.orders24h} | Приход: ${eur(pulse.revenue24hStotinki)}`, '');
  }
  if (signals.length > 0) {
    lines.push(`Ферми за внимание (${signals.length}):`);
    for (const f of signals) {
      lines.push(`  • ${f.name} — ${f.phone ?? '—'}`);
      for (const s of f.signals) lines.push(`      - ${s.label} — ${s.action}`);
    }
    lines.push('');
  }
  if (pulse.newSignups.length > 0) {
    lines.push(`Нови регистрации (24ч) (${pulse.newSignups.length}):`);
    for (const s of pulse.newSignups) lines.push(`  • ${s.name}`);
    lines.push('');
  }
  if (stuckDrafts.length > 0) {
    lines.push(`Заседнали доставки (${stuckDrafts.length}):`);
    for (const d of stuckDrafts) lines.push(`  • ${d.farmerName} · ${d.tenantName} — ${d.count} чернови (преди ${daysAgo(d.oldestAt, nowMs)} дни)`);
    lines.push('');
  }
  if (emailTotals.recipientTotal > 0) {
    lines.push(`Имейл приход (този месец): получатели ${emailTotals.recipientTotal} | приход ${eur(emailTotals.revenueStotinki)} | марж ${eur(emailTotals.marginStotinki)}`, '');
  }

  return { html, text: lines.join('\n'), isEmpty };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @fermeribg/api test operator-digest.render`
Expected: PASS — all renderer cases green.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/platform/operator-digest.render.ts server/src/modules/platform/operator-digest.render.spec.ts
git commit -m "feat(platform): pure operator-digest renderer"
```

---

## Task 2: OperatorDigestService

**Files:**
- Create: `server/src/modules/platform/operator-digest.service.ts`
- Test: `server/src/modules/platform/operator-digest.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/modules/platform/operator-digest.service.spec.ts`:

```ts
import { OperatorDigestService } from './operator-digest.service';

function makeSvc(opts: {
  superAdminEmail?: string | null;
  signals?: unknown[];
  stuckDrafts?: unknown[];
  emailTotals?: unknown;
  pulse?: unknown;
}) {
  const email = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const insights = { insights: jest.fn().mockResolvedValue({ signals: opts.signals ?? [] }) };
  const platform = {
    deliveryOps: jest.fn().mockResolvedValue({ stuckDrafts: opts.stuckDrafts ?? [] }),
    emailBilling: jest.fn().mockResolvedValue({ totals: opts.emailTotals ?? { recipientTotal: 0, revenueStotinki: 0, costStotinki: 0, marginStotinki: 0 } }),
  };
  const config = { get: (k: string) => (k === 'SUPER_ADMIN_EMAIL' ? (opts.superAdminEmail ?? '') : undefined) };
  const db = {} as any;
  const svc = new OperatorDigestService(db, insights as any, platform as any, email as any, config as any);
  // Override the DB-bound pulse query so the service tests need no database.
  (svc as any).dailyPulse = jest.fn().mockResolvedValue(
    opts.pulse ?? { orders24h: 0, revenue24hStotinki: 0, newSignups: [] },
  );
  return { svc, email, insights, platform };
}

describe('OperatorDigestService.runDaily', () => {
  it('skips when no SUPER_ADMIN_EMAIL is configured', async () => {
    const { svc, email } = makeSvc({ superAdminEmail: '', pulse: { orders24h: 5, revenue24hStotinki: 1000, newSignups: [] } });
    const res = await svc.runDaily();
    expect(res).toEqual({ sent: false, reason: 'no-recipient' });
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  it('skips a fully-quiet day without sending', async () => {
    const { svc, email } = makeSvc({ superAdminEmail: 'op@ferma.bg' });
    const res = await svc.runDaily();
    expect(res).toEqual({ sent: false, reason: 'empty' });
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  it('sends to the operator when there is something to report', async () => {
    const { svc, email } = makeSvc({
      superAdminEmail: 'op@ferma.bg',
      signals: [{ name: 'Ферма А', phone: '0888000000', signals: [{ key: 'empty_shop', label: 'Няма продукти', action: 'Качи продукти', severity: 90 }] }],
    });
    const res = await svc.runDaily();
    expect(res).toEqual({ sent: true });
    expect(email.sendMail).toHaveBeenCalledTimes(1);
    const arg = email.sendMail.mock.calls[0][0];
    expect(arg.to).toBe('op@ferma.bg');
    expect(arg.subject).toContain('Дневен отчет');
    expect(arg.html).toContain('Ферма А');
    expect(arg.html).toContain('0888000000');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @fermeribg/api test operator-digest.service`
Expected: FAIL — `Cannot find module './operator-digest.service'`.

- [ ] **Step 3: Write the service**

Create `server/src/modules/platform/operator-digest.service.ts`:

```ts
import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, gte, sql } from 'drizzle-orm';
import { type Database, tenants, orders } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EmailService } from '../../common/email/email.service';
import { bgToday } from '../../common/time/bg-time';
import { PlatformInsightsService } from './insights.service';
import { PlatformService } from './platform.service';
import { assembleDigest } from './operator-digest.render';

interface DailyPulse {
  orders24h: number;
  revenue24hStotinki: number;
  newSignups: { name: string; createdAt: Date | null }[];
}

export type RunDailyResult = { sent: true } | { sent: false; reason: 'no-recipient' | 'empty' };

@Injectable()
export class OperatorDigestService {
  private readonly logger = new Logger(OperatorDigestService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly insights: PlatformInsightsService,
    private readonly platform: PlatformService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  /** New signups + order/revenue pulse over the last 24h (demo tenants excluded). */
  private async dailyPulse(): Promise<DailyPulse> {
    const notDemo = sql`${orders.tenantId} in (select ${tenants.id} from ${tenants} where ${tenants.isDemo} = false)`;
    const [pulseRow] = await this.db
      .select({
        orders24h: sql<number>`count(*)::int`,
        revenue24hStotinki: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${orders.status} is distinct from 'cancelled'), 0)::int`,
      })
      .from(orders)
      .where(and(gte(orders.createdAt, sql`now() - interval '24 hours'`), notDemo));

    const signupRows = await this.db
      .select({ name: tenants.name, createdAt: tenants.createdAt })
      .from(tenants)
      .where(and(sql`${tenants.isDemo} = false`, gte(tenants.createdAt, sql`now() - interval '24 hours'`)))
      .orderBy(tenants.createdAt);

    return {
      orders24h: pulseRow?.orders24h ?? 0,
      revenue24hStotinki: pulseRow?.revenue24hStotinki ?? 0,
      newSignups: signupRows,
    };
  }

  /** Build + send today's operator digest. Skips on no recipient or a quiet day. */
  async runDaily(): Promise<RunDailyResult> {
    const to = this.config.get<string>('SUPER_ADMIN_EMAIL');
    if (!to) {
      this.logger.warn('[operator-digest] SUPER_ADMIN_EMAIL not set — skipping');
      return { sent: false, reason: 'no-recipient' };
    }

    const [insights, deliveryOps, billing, pulse] = await Promise.all([
      this.insights.insights(),
      this.platform.deliveryOps(),
      this.platform.emailBilling(),
      this.dailyPulse(),
    ]);

    const { html, text, isEmpty } = assembleDigest(
      {
        pulse,
        signals: insights.signals.map((f) => ({
          name: f.name,
          phone: f.phone,
          signals: f.signals.map((s) => ({ label: s.label, action: s.action })),
        })),
        stuckDrafts: deliveryOps.stuckDrafts.map((d) => ({
          farmerName: d.farmerName,
          tenantName: d.tenantName,
          count: d.count,
          oldestAt: d.oldestAt,
        })),
        emailTotals: {
          recipientTotal: billing.totals.recipientTotal,
          revenueStotinki: billing.totals.revenueStotinki,
          marginStotinki: billing.totals.marginStotinki,
        },
      },
      bgToday(),
    );

    if (isEmpty) {
      this.logger.log('[operator-digest] quiet day — skipping send');
      return { sent: false, reason: 'empty' };
    }

    await this.email.sendMail({ to, subject: 'Дневен отчет — ФермериБГ', html, text });
    this.logger.log(`[operator-digest] sent to ${to}`);
    return { sent: true };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @fermeribg/api test operator-digest.service`
Expected: PASS — all three runDaily cases green.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/platform/operator-digest.service.ts server/src/modules/platform/operator-digest.service.spec.ts
git commit -m "feat(platform): operator-digest service (gather + send)"
```

---

## Task 3: Processor, queue, module + test endpoint

**Files:**
- Create: `server/src/modules/platform/operator-digest.processor.ts`
- Modify: `server/src/common/queue/queue.constants.ts`
- Modify: `server/src/modules/platform/platform.module.ts`
- Modify: `server/src/modules/platform/platform.controller.ts`

- [ ] **Step 1: Add the queue constant**

In `server/src/common/queue/queue.constants.ts`, add a line after the existing constants:

```ts
export const OPERATOR_DIGEST_QUEUE = 'operator-digest';
```

- [ ] **Step 2: Write the processor**

Create `server/src/modules/platform/operator-digest.processor.ts`:

```ts
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { OperatorDigestService } from './operator-digest.service';
import { OPERATOR_DIGEST_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(OPERATOR_DIGEST_QUEUE)
export class OperatorDigestProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(OperatorDigestProcessor.name);

  constructor(
    private readonly digest: OperatorDigestService,
    @InjectQueue(OPERATOR_DIGEST_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  // Register the 07:00 Europe/Sofia repeatable once on worker boot (idempotent).
  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'daily', '0 7 * * *');
  }

  async process(job: Job): Promise<void> {
    if (job.name === 'daily') {
      const res = await this.digest.runDaily();
      this.logger.log(`[operator-digest] daily run → ${JSON.stringify(res)}`);
      return;
    }
    this.logger.warn(`[operator-digest] unknown job name=${job.name}`);
  }
}
```

- [ ] **Step 3: Wire the module**

In `server/src/modules/platform/platform.module.ts`:

Add imports near the other platform imports:

```ts
import { OperatorDigestService } from './operator-digest.service';
import { OperatorDigestProcessor } from './operator-digest.processor';
import { OPERATOR_DIGEST_QUEUE } from '../../common/queue/queue.constants';
```

Add a second `BullModule.registerQueue` inside the `imports` array (after the existing `CLEANUP_QUEUE` registration):

```ts
    BullModule.registerQueue({
      name: OPERATOR_DIGEST_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    }),
```

Add the providers (service always; processor only under `RUN_WORKERS`):

```ts
  providers: [
    PlatformService,
    PlatformInsightsService,
    ProductExtractService,
    OperatorDigestService,
    ...(RUN_WORKERS ? [DemoCleanupProcessor, OperatorDigestProcessor] : []),
  ],
```

(`EmailService` is provided by the `@Global() EmailModule`, so no import is needed for it.)

- [ ] **Step 4: Add the manual test endpoint**

In `server/src/modules/platform/platform.controller.ts`, add the import:

```ts
import { OperatorDigestService } from './operator-digest.service';
```

Inject it into `PlatformController`'s constructor (alongside the existing deps):

```ts
  constructor(
    private readonly platform: PlatformService,
    private readonly insights: PlatformInsightsService,
    private readonly productExtract: ProductExtractService,
    private readonly operatorDigest: OperatorDigestService,
  ) {}
```

Add the endpoint (place it near the other `@Post` platform routes, e.g. just below the `tenants/:id/products/extract` method):

```ts
  /** Manual trigger: build + send today's operator digest now (to SUPER_ADMIN_EMAIL).
   *  Returns the same outcome the daily cron would produce. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('digest/operator-test')
  runOperatorDigest() {
    return this.operatorDigest.runDaily();
  }
```

- [ ] **Step 5: Build to verify it compiles**

Run: `pnpm --filter @fermeribg/api build`
Expected: build succeeds, no TS errors.

- [ ] **Step 6: Run the full server suite**

Run: `pnpm --filter @fermeribg/api test`
Expected: all tests green (existing suite + Tasks 1–2 tests).

- [ ] **Step 7: Commit**

```bash
git add server/src/common/queue/queue.constants.ts server/src/modules/platform/operator-digest.processor.ts server/src/modules/platform/platform.module.ts server/src/modules/platform/platform.controller.ts
git commit -m "feat(platform): daily operator-digest cron + manual test endpoint"
```

---

## Self-Review Notes

**Spec coverage:**
- Daily 07:00 Sofia repeatable → Task 3 processor (`'0 7 * * *'`, `registerRepeatable` tz Sofia). ✓
- Five sections (pulse, attention+phones, signups, stuck drafts, email revenue) → Task 1 renderer. ✓
- Skip on quiet day → Task 1 `isEmpty` + Task 2 `runDaily` early-return. ✓
- Recipient `SUPER_ADMIN_EMAIL`, unset → skip+warn → Task 2. ✓
- Reuse `insights()`/`deliveryOps()`/`emailBilling()` + new 24h query → Task 2 `dailyPulse` + `runDaily`. ✓
- Worker-gated processor, queue in module → Task 3. ✓
- Manual test endpoint `POST platform/digest/operator-test` → Task 3. ✓
- No table/migration; no farmer-facing anything → nothing of the sort in any task. ✓
- Tests: pure renderer + mocked service → Tasks 1–2. ✓

**Placeholder scan:** none — every step has full code/commands.

**Type consistency:** `OperatorDigestInput` (Task 1) is the exact shape `runDaily` builds (Task 2) — `pulse`, `signals[{name,phone,signals[{label,action}]}]`, `stuckDrafts[{farmerName,tenantName,count,oldestAt}]`, `emailTotals[{recipientTotal,revenueStotinki,marginStotinki}]`. `assembleDigest` and `runDaily`/`RunDailyResult` names consistent across Tasks 1–3. `OPERATOR_DIGEST_QUEUE` defined in Task 3 Step 1 before use in Steps 2–3.

**Env note:** `SUPER_ADMIN_EMAIL` already validated (optional) in `env.validation.ts` — no new var. Ensure it is set in the worker's environment for the cron to actually send.
