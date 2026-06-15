# Scale-prep Foundation Implementation Plan (Phases A–D)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FarmFlow safe and correct to run as multiple copies of one Docker image — capped DB pool, real readiness probe, graceful shutdown, a BullMQ job queue, async email, and cluster-safe scheduled jobs — with single-box behavior unchanged by default.

**Architecture:** One codebase, one Docker image, an `APP_ROLE` env flag selecting `all` (default — HTTP + workers + crons, today's behavior), `web` (HTTP + enqueue only), or `worker` (drains queues + runs scheduled jobs once). Slow work (email, digests) moves onto a Redis-backed BullMQ queue drained by worker copies. The three `@Cron` jobs become BullMQ **repeatable jobs**, which run exactly once across the cluster by construction. No microservices.

**Tech Stack:** NestJS 10, BullMQ + `@nestjs/bullmq`, ioredis (already present), drizzle-orm + pg, Jest + ts-jest. Companion plan `2026-06-15-scale-prep-image-queue.md` covers Phase E (image-resize queue).

**Spec:** `docs/superpowers/specs/2026-06-15-scale-prep-queues-design.md`

---

## File Structure

**Phase A — safe to multi-copy (no BullMQ):**
- Modify `packages/db/src/index.ts` — `createDb(conn, { max })`.
- Modify `server/src/common/drizzle/drizzle.module.ts` — pass `DB_POOL_MAX`, end pool on shutdown.
- Modify `server/src/common/redis/redis.module.ts` — quit client on shutdown.
- Modify `server/src/config/env.validation.ts` — `DB_POOL_MAX`, `APP_ROLE`.
- Create `server/src/common/health/health.service.ts` — DB + Redis readiness check.
- Create `server/src/common/health/health.controller.ts` — `GET /health/ready`.
- Create `server/src/common/health/health.module.ts`.
- Modify `server/src/app.module.ts` — import `HealthModule`.
- Modify `server/src/main.ts` — `enableShutdownHooks()`.

**Phase B — BullMQ foundation + APP_ROLE:**
- Modify `server/package.json` — add `bullmq`, `@nestjs/bullmq`.
- Create `server/src/config/app-role.ts` — role parsing + `RUN_WORKERS`.
- Create `server/src/common/queue/queue.constants.ts` — queue names.
- Create `server/src/common/queue/register-repeatable.ts` — repeatable-job helper.
- Create `server/src/common/queue/queue.module.ts` — BullMQ root (dedicated Redis connection).
- Modify `server/src/app.module.ts` — import `QueueModule`.

**Phase C — email queue:**
- Create `server/src/common/email/email.processor.ts` — worker that sends.
- Modify `server/src/common/email/email.service.ts` — `sendMail` enqueues; new `deliver()` holds the send logic.
- Modify `server/src/common/email/email.module.ts` — register queue + gated processor.

**Phase D — crons → repeatable jobs:**
- Create `server/src/modules/digest/digest.processor.ts`.
- Modify `server/src/modules/digest/digest.service.ts` — drop `@Cron`.
- Modify `server/src/modules/digest/digest.module.ts` — queue + gated processor.
- Create `server/src/modules/slots/slots.processor.ts`.
- Modify `server/src/modules/slots/slots.service.ts` — drop `@Cron`.
- Modify `server/src/modules/slots/slots.module.ts` — queue + gated processor.
- Create `server/src/modules/billing/billing.processor.ts`.
- Modify `server/src/modules/billing/billing.service.ts` — drop `@Cron`.
- Modify `server/src/modules/billing/billing.module.ts` — queue + gated processor.
- Modify `server/src/app.module.ts` — remove `ScheduleModule`.
- Modify `server/package.json` — remove `@nestjs/schedule`.
- Modify `server/.env.example` + `.env.example` — document `APP_ROLE`, `DB_POOL_MAX`.

---

## Conventions for every task

- Tests run from `server/`: `pnpm --filter @farmflow/api test -- <file>` (or `cd server; pnpm test -- <file>`).
- This machine flakes when jest + builds + the dev server run together — **run test commands sequentially.**
- Mock style matches `server/src/modules/billing/billing.service.spec.ts`: chainable `makeDb()`, `cfg()` config stub, Logger spies.

---

# PHASE A — Safe to run as multiple copies

## Task A1: Cap the Postgres connection pool

**Files:**
- Modify: `packages/db/src/index.ts`
- Modify: `server/src/common/drizzle/drizzle.module.ts`
- Modify: `server/src/config/env.validation.ts:46` (near `PORT`)

- [ ] **Step 1: Add `max` option to `createDb`**

`packages/db/src/index.ts` — replace the `createDb` function:

```ts
export function createDb(connectionString: string, opts: { max?: number } = {}) {
  const pool = new Pool({ connectionString, max: opts.max });
  return drizzle(pool, { schema });
}
```

- [ ] **Step 2: Add the `DB_POOL_MAX` env var**

`server/src/config/env.validation.ts` — add after the `PORT` line:

```ts
  // Max Postgres connections THIS process opens. With N app copies the cluster
  // opens N × DB_POOL_MAX connections — keep that under Postgres max_connections
  // (~100 default), or front Postgres with PgBouncer (infra runbook).
  DB_POOL_MAX: Joi.number().default(10),
```

- [ ] **Step 3: Pass it through in the Drizzle provider**

`server/src/common/drizzle/drizzle.module.ts` — replace the file:

```ts
import { Global, Module, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDb, type Database } from '@farmflow/db';
import { DB_TOKEN } from './drizzle.constants';

@Global()
@Module({
  providers: [
    {
      provide: DB_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createDb(config.getOrThrow<string>('DATABASE_URL'), {
          max: config.get<number>('DB_POOL_MAX', 10),
        }),
    },
  ],
  exports: [DB_TOKEN],
})
export class DrizzleModule implements OnModuleDestroy {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  // Drain the pg pool on shutdown so a rolling deploy closes connections cleanly
  // instead of leaking them until Postgres times them out. drizzle exposes the
  // underlying pg Pool as `$client`.
  async onModuleDestroy(): Promise<void> {
    await (this.db as unknown as { $client: { end(): Promise<void> } }).$client.end();
  }
}
```

- [ ] **Step 4: Build the db package + server to verify types**

Run: `pnpm --filter @farmflow/db build && pnpm --filter @farmflow/api build`
Expected: both succeed (the `$client` access compiles via the cast).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/index.ts server/src/common/drizzle/drizzle.module.ts server/src/config/env.validation.ts
git commit -m "feat(db): cap pg pool via DB_POOL_MAX + drain on shutdown"
```

---

## Task A2: Readiness probe (`GET /health/ready`)

**Files:**
- Create: `server/src/common/health/health.service.ts`
- Create: `server/src/common/health/health.controller.ts`
- Create: `server/src/common/health/health.module.ts`
- Create (test): `server/src/common/health/health.service.spec.ts`
- Modify: `server/src/app.module.ts`

- [ ] **Step 1: Write the failing test**

`server/src/common/health/health.service.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { HealthService } from './health.service';
import { DB_TOKEN } from '../drizzle/drizzle.constants';
import { REDIS_TOKEN } from '../redis/redis.constants';

function makeDb(execute = jest.fn().mockResolvedValue(undefined)) {
  return { execute } as any;
}
function makeRedis(ping = jest.fn().mockResolvedValue('PONG')) {
  return { ping } as any;
}

async function build(db: any, redis: any): Promise<HealthService> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      HealthService,
      { provide: DB_TOKEN, useValue: db },
      { provide: REDIS_TOKEN, useValue: redis },
    ],
  }).compile();
  return mod.get(HealthService);
}

describe('HealthService', () => {
  it('ready() resolves { status: "ok" } when DB + Redis both respond', async () => {
    const svc = await build(makeDb(), makeRedis());
    await expect(svc.ready()).resolves.toEqual({ status: 'ok' });
  });

  it('ready() rejects when the DB query fails', async () => {
    const db = makeDb(jest.fn().mockRejectedValue(new Error('db down')));
    const svc = await build(db, makeRedis());
    await expect(svc.ready()).rejects.toThrow('db down');
  });

  it('ready() rejects when Redis ping fails', async () => {
    const redis = makeRedis(jest.fn().mockRejectedValue(new Error('redis down')));
    const svc = await build(makeDb(), redis);
    await expect(svc.ready()).rejects.toThrow('redis down');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @farmflow/api test -- health.service.spec`
Expected: FAIL — cannot find module `./health.service`.

- [ ] **Step 3: Implement the service**

`server/src/common/health/health.service.ts`:

```ts
import { Injectable, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { type Database } from '@farmflow/db';
import { DB_TOKEN } from '../drizzle/drizzle.constants';
import { REDIS_TOKEN } from '../redis/redis.constants';

/** Deep readiness: proves this copy can actually reach its backing stores, not
 *  just that the process is alive. The load balancer polls /health/ready and
 *  pulls a copy out of rotation when this fails. */
@Injectable()
export class HealthService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
  ) {}

  async ready(): Promise<{ status: 'ok' }> {
    await this.db.execute(sql`select 1`);
    await this.redis.ping();
    return { status: 'ok' };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @farmflow/api test -- health.service.spec`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the controller + module**

`server/src/common/health/health.controller.ts`:

```ts
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  // Distinct from the liveness GET /health on AppController: this one verifies
  // DB + Redis and returns 503 when either is unreachable.
  @Get('ready')
  @SkipThrottle()
  async ready(): Promise<{ status: 'ok' }> {
    try {
      return await this.health.ready();
    } catch {
      throw new ServiceUnavailableException('not ready');
    }
  }
}
```

`server/src/common/health/health.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { HealthService } from './health.service';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
```

- [ ] **Step 6: Register the module**

`server/src/app.module.ts` — add the import near the other common-module imports:

```ts
import { HealthModule } from './common/health/health.module';
```

and add `HealthModule,` to the `imports` array (place it right after `RedisModule,`).

- [ ] **Step 7: Build to verify wiring**

Run: `pnpm --filter @farmflow/api build`
Expected: success.

- [ ] **Step 8: Commit**

```bash
git add server/src/common/health server/src/app.module.ts
git commit -m "feat(health): add GET /health/ready DB+Redis readiness probe"
```

---

## Task A3: Graceful shutdown (SIGTERM drains)

**Files:**
- Modify: `server/src/main.ts:41` (after `NestFactory.create`)
- Modify: `server/src/common/redis/redis.module.ts`

- [ ] **Step 1: Quit the Redis client on shutdown**

`server/src/common/redis/redis.module.ts` — replace the file:

```ts
import { Global, Module, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_TOKEN } from './redis.constants';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis(config.getOrThrow<string>('REDIS_URL')),
    },
  ],
  exports: [REDIS_TOKEN],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_TOKEN) private readonly redis: Redis) {}

  // Close the connection cleanly on shutdown so a rolling deploy doesn't leave a
  // half-open socket. `quit()` flushes pending commands first.
  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
```

- [ ] **Step 2: Enable Nest shutdown hooks**

`server/src/main.ts` — add immediately after `const app = await NestFactory.create(AppModule, { rawBody: true });`:

```ts
  // Wire SIGTERM/SIGINT to Nest's lifecycle so OnModuleDestroy hooks run: BullMQ
  // workers finish in-flight jobs, the pg pool and Redis client close cleanly.
  // Required for zero-drop rolling deploys. The orchestrator (Dokploy) must allow
  // a termination grace period long enough for in-flight work to drain.
  app.enableShutdownHooks();
```

- [ ] **Step 3: Build to verify**

Run: `pnpm --filter @farmflow/api build`
Expected: success.

- [ ] **Step 4: Run the full suite (nothing regressed)**

Run: `pnpm --filter @farmflow/api test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add server/src/main.ts server/src/common/redis/redis.module.ts
git commit -m "feat(server): graceful shutdown — enableShutdownHooks + quit Redis"
```

---

# PHASE B — BullMQ foundation + APP_ROLE

## Task B1: Add deps + the `APP_ROLE` helper

**Files:**
- Modify: `server/package.json`
- Modify: `server/src/config/env.validation.ts`
- Create: `server/src/config/app-role.ts`
- Create (test): `server/src/config/app-role.spec.ts`

- [ ] **Step 1: Install BullMQ**

Run: `pnpm --filter @farmflow/api add bullmq @nestjs/bullmq`
Expected: both added to `server/package.json` dependencies.

- [ ] **Step 2: Write the failing test for the role helper**

`server/src/config/app-role.spec.ts`:

```ts
import { parseAppRole, runsWorkers } from './app-role';

describe('app-role', () => {
  it('defaults to "all" when unset or unknown', () => {
    expect(parseAppRole(undefined)).toBe('all');
    expect(parseAppRole('')).toBe('all');
    expect(parseAppRole('nonsense')).toBe('all');
  });

  it('passes through valid roles', () => {
    expect(parseAppRole('web')).toBe('web');
    expect(parseAppRole('worker')).toBe('worker');
    expect(parseAppRole('all')).toBe('all');
  });

  it('runsWorkers is true for all + worker, false for web', () => {
    expect(runsWorkers('all')).toBe(true);
    expect(runsWorkers('worker')).toBe(true);
    expect(runsWorkers(undefined)).toBe(true);
    expect(runsWorkers('web')).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @farmflow/api test -- app-role.spec`
Expected: FAIL — cannot find module `./app-role`.

- [ ] **Step 4: Implement the helper**

`server/src/config/app-role.ts`:

```ts
export type AppRole = 'all' | 'web' | 'worker';

/** Parse APP_ROLE; anything unrecognised (incl. undefined/empty) → 'all' so the
 *  default single-box deploy keeps doing everything, unchanged. */
export function parseAppRole(value?: string): AppRole {
  return value === 'web' || value === 'worker' ? value : 'all';
}

/** Does this copy run BullMQ workers + register repeatable (cron) jobs?
 *  'all' and 'worker' do; 'web' is HTTP + enqueue only. */
export function runsWorkers(value?: string): boolean {
  return parseAppRole(value) !== 'web';
}

/** Computed once at boot from the process env. Feature modules use this to
 *  conditionally register their processor provider (so a `web` copy never starts
 *  a worker). Reading process.env directly is fine — APP_ROLE is fixed per process. */
export const RUN_WORKERS = runsWorkers(process.env.APP_ROLE);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @farmflow/api test -- app-role.spec`
Expected: PASS (3 tests).

- [ ] **Step 6: Add `APP_ROLE` to env validation**

`server/src/config/env.validation.ts` — add right after the `DB_POOL_MAX` line from Task A1:

```ts
  // Which job this process does: 'all' (default — HTTP + workers + scheduled jobs,
  // the single-box behavior), 'web' (HTTP + enqueue only), 'worker' (drains queues
  // + runs scheduled jobs). Scale horizontally by running copies with different roles.
  APP_ROLE: Joi.string().valid('all', 'web', 'worker').default('all'),
```

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/src/config/app-role.ts server/src/config/app-role.spec.ts server/src/config/env.validation.ts
git commit -m "feat(config): add APP_ROLE flag + RUN_WORKERS gate + bullmq deps"
```

---

## Task B2: BullMQ root module (dedicated Redis connection)

**Files:**
- Create: `server/src/common/queue/queue.constants.ts`
- Create: `server/src/common/queue/register-repeatable.ts`
- Create: `server/src/common/queue/queue.module.ts`
- Modify: `server/src/app.module.ts`

- [ ] **Step 1: Queue-name constants**

`server/src/common/queue/queue.constants.ts`:

```ts
export const EMAIL_QUEUE = 'email';
export const DIGEST_QUEUE = 'digest';
export const SLOTS_QUEUE = 'slots';
export const BILLING_QUEUE = 'billing';
```

- [ ] **Step 2: Repeatable-job registration helper**

`server/src/common/queue/register-repeatable.ts`:

```ts
import type { Queue } from 'bullmq';

/**
 * Idempotently register a repeatable (cron-style) job. BullMQ keys the schedule
 * by `jobId`, so calling this on every worker boot is safe — the schedule exists
 * exactly once and each fire is consumed by exactly one worker. Replaces in-process
 * @Cron, which would fire on every copy.
 */
export async function registerRepeatable(
  queue: Queue,
  name: string,
  pattern: string,
): Promise<void> {
  await queue.add(
    name,
    {},
    {
      jobId: name,
      repeat: { pattern, tz: 'Europe/Sofia' },
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
}
```

- [ ] **Step 3: BullMQ root module**

`server/src/common/queue/queue.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import IORedis from 'ioredis';

/**
 * BullMQ root. Uses a DEDICATED Redis connection (not the shared REDIS_TOKEN
 * client): BullMQ workers require `maxRetriesPerRequest: null`, which the cache/
 * throttler client must not have. Same REDIS_URL, separate client.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: new IORedis(config.getOrThrow<string>('REDIS_URL'), {
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        }),
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
```

- [ ] **Step 4: Register the root module FIRST among feature modules**

`server/src/app.module.ts` — add the import:

```ts
import { QueueModule } from './common/queue/queue.module';
```

and add `QueueModule,` to `imports` immediately after `RedisModule,` (it must load before any module that registers a queue).

- [ ] **Step 5: Build to verify**

Run: `pnpm --filter @farmflow/api build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add server/src/common/queue server/src/app.module.ts
git commit -m "feat(queue): BullMQ root module on a dedicated Redis connection"
```

---

# PHASE C — Email queue

## Task C1: Move email sending onto the queue

**Files:**
- Modify: `server/src/common/email/email.service.ts`
- Create: `server/src/common/email/email.processor.ts`
- Modify: `server/src/common/email/email.module.ts`
- Create (test): `server/src/common/email/email.service.spec.ts`

- [ ] **Step 1: Write the failing test (sendMail enqueues; deliver sends)**

`server/src/common/email/email.service.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { EmailService } from './email.service';
import { SuppressionService } from './suppression.service';
import { EMAIL_QUEUE } from '../queue/queue.constants';

const cfg = (over: Record<string, any> = {}) => ({
  get: (k: string, d?: any) => (k in over ? over[k] : d),
});

function makeQueue() {
  return { add: jest.fn().mockResolvedValue({ id: 'job1' }) };
}
function makeSuppression(suppressed = false) {
  return { isSuppressed: jest.fn().mockResolvedValue(suppressed) };
}

async function build(queue: any, suppression: any, config = cfg()): Promise<EmailService> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      EmailService,
      { provide: ConfigService, useValue: config },
      { provide: SuppressionService, useValue: suppression },
      { provide: getQueueToken(EMAIL_QUEUE), useValue: queue },
    ],
  }).compile();
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const svc = mod.get(EmailService);
  svc.onModuleInit(); // dev mode (no SMTP_HOST) — sets up the preview transport
  return svc;
}

describe('EmailService.sendMail (enqueue)', () => {
  it('enqueues the payload onto the email queue instead of sending inline', async () => {
    const queue = makeQueue();
    const svc = await build(queue, makeSuppression());
    await svc.sendMail({ to: 'a@b.bg', subject: 'Hi', html: '<p>x</p>' });
    expect(queue.add).toHaveBeenCalledWith(
      'send',
      expect.objectContaining({ to: 'a@b.bg', subject: 'Hi', html: '<p>x</p>' }),
    );
  });
});

describe('EmailService.deliver (worker send path)', () => {
  it('skips a suppressed recipient without writing a preview', async () => {
    const svc = await build(makeQueue(), makeSuppression(true));
    const spy = jest.spyOn(svc as any, 'writePreview');
    await svc.deliver({ to: 'bounced@b.bg', subject: 'x', html: 'x' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('delivers (dev preview) a non-suppressed recipient', async () => {
    const svc = await build(makeQueue(), makeSuppression(false));
    const spy = jest.spyOn(svc as any, 'writePreview').mockResolvedValue(undefined);
    await svc.deliver({ to: 'ok@b.bg', subject: 'x', html: '<p>y</p>' });
    expect(spy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @farmflow/api test -- email.service.spec`
Expected: FAIL — `EmailService` has no queue dependency / no `deliver` / no `writePreview`.

- [ ] **Step 3: Refactor EmailService — `sendMail` enqueues, `deliver` sends**

`server/src/common/email/email.service.ts` — apply these changes:

(a) Add imports at the top:

```ts
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EMAIL_QUEUE } from '../queue/queue.constants';
```

(b) Inject the queue in the constructor (add the parameter after `suppression`):

```ts
  constructor(
    private readonly config: ConfigService,
    private readonly suppression: SuppressionService,
    @InjectQueue(EMAIL_QUEUE) private readonly queue: Queue,
  ) {
```

(c) Replace the body of `sendMail` so it only enqueues:

```ts
  /**
   * Enqueue an email for asynchronous, retried delivery by the email worker.
   * Returns once the job is queued — the actual send (and suppression check) runs
   * in `deliver()` on a worker. At-least-once: a worker crash mid-job can re-send;
   * tolerated for transactional mail (low harm).
   */
  async sendMail(options: SendMailOptions): Promise<void> {
    await this.queue.add('send', options);
  }
```

(d) Rename the OLD send logic to `deliver()`. Take the previous body of `sendMail` (suppression check + transporter send + dev preview) and put it in a new public method `deliver(options: SendMailOptions): Promise<void>` with the SAME body the old `sendMail` had. Then extract the dev-preview block into a private `writePreview` so the test can spy it:

```ts
  /** Actually send (called by EmailProcessor). Honors suppression at send time. */
  async deliver(options: SendMailOptions): Promise<void> {
    const stream: EmailStream = options.stream ?? 'transactional';

    if (!options.skipSuppressionCheck && (await this.suppression.isSuppressed(options.to))) {
      this.logger.warn(`[email] skipped suppressed recipient to=${options.to}`);
      return;
    }

    const from = this.streamFrom(stream);

    if (!this.isDevMode && this.transporter) {
      await this.transporter.sendMail({
        from,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      });
      return;
    }

    await this.writePreview(options, from, stream);
  }

  private async writePreview(options: SendMailOptions, from: string, stream: EmailStream): Promise<void> {
    try {
      await fs.promises.mkdir(this.previewDir, { recursive: true });
      const sanitizedTo = options.to.replace(/[^a-zA-Z0-9@._-]/g, '_');
      const filename = `${Date.now()}-${sanitizedTo}.html`;
      const filePath = path.join(this.previewDir, filename);
      const now = new Date().toISOString();
      const content = `<!-- to: ${options.to} | from: ${from} | stream: ${stream} | subject: ${options.subject} | date: ${now} -->\n${options.html}`;
      await fs.promises.writeFile(filePath, content, 'utf8');
      this.logger.log(
        `[email:preview] stream=${stream} to=${options.to} subject="${options.subject}" file=${filePath}`,
      );
    } catch (err) {
      this.logger.error(
        `[email:preview] failed to write preview file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
```

> Note: 12 existing callers of `sendMail` are unchanged — the signature is identical.

- [ ] **Step 4: Create the processor**

`server/src/common/email/email.processor.ts`:

```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmailService, SendMailOptions } from './email.service';
import { EMAIL_QUEUE } from '../queue/queue.constants';

// Concurrency + rate limit sized to stay inside the Resend plan: a newsletter or
// the daily digest fan-out can enqueue a burst; the limiter smooths the send rate.
@Processor(EMAIL_QUEUE, { concurrency: 5, limiter: { max: 10, duration: 1000 } })
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(private readonly email: EmailService) {
    super();
  }

  async process(job: Job<SendMailOptions>): Promise<void> {
    await this.email.deliver(job.data);
  }
}
```

`SendMailOptions` must be exported — confirm `export interface SendMailOptions` in `email.service.ts` (it already is).

- [ ] **Step 5: Wire the queue + gated processor into EmailModule**

`server/src/common/email/email.module.ts` — replace the file:

```ts
import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EmailService } from './email.service';
import { SuppressionService } from './suppression.service';
import { EmailWebhookController } from './email-webhook.controller';
import { EmailProcessor } from './email.processor';
import { EMAIL_QUEUE } from '../queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';

@Global()
@Module({
  imports: [
    BullModule.registerQueue({
      name: EMAIL_QUEUE,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    }),
  ],
  controllers: [EmailWebhookController],
  // The processor (a BullMQ Worker) starts only on copies that run workers.
  // A `web` copy still gets the producer (queue) so it can enqueue.
  providers: [EmailService, SuppressionService, ...(RUN_WORKERS ? [EmailProcessor] : [])],
  exports: [EmailService, SuppressionService],
})
export class EmailModule {}
```

- [ ] **Step 6: Run the email test + full suite**

Run: `pnpm --filter @farmflow/api test -- email.service.spec`
Expected: PASS (3 tests).

Run: `pnpm --filter @farmflow/api test`
Expected: all green (existing specs mock `EmailService`, so they're unaffected).

- [ ] **Step 7: Build**

Run: `pnpm --filter @farmflow/api build`
Expected: success.

- [ ] **Step 8: Commit**

```bash
git add server/src/common/email
git commit -m "feat(email): send via BullMQ email queue (retry+backoff, worker-gated)"
```

---

# PHASE D — Crons → BullMQ repeatable jobs

> After this phase, all three scheduled jobs run **exactly once across the cluster**
> (a repeatable occurrence is consumed by one worker). `@nestjs/schedule` is removed.

## Task D1: Digest cron → repeatable + fan-out

**Files:**
- Modify: `server/src/modules/digest/digest.service.ts`
- Create: `server/src/modules/digest/digest.processor.ts`
- Modify: `server/src/modules/digest/digest.module.ts`
- Create (test): `server/src/modules/digest/digest.processor.spec.ts`

- [ ] **Step 1: Drop `@Cron` from the digest service**

`server/src/modules/digest/digest.service.ts`:

(a) Remove the import `import { Cron } from '@nestjs/schedule';` (line 2).

(b) **Delete** the whole `runDailyDigests` method (decorator + body, lines ~610-660). The fan-out below (`eligibleTenantIds` + `runForTenant`, driven by the processor) replaces it. Its per-tenant logic is preserved in `runForTenant`; the helpers it called (`buildDigest`, `sendFarmerDigests`, `bgToday`) stay. `sendTestDigest` (the `POST /digest/test` path) is untouched.

(c) Add a public method that lists tenant ids for the fan-out (insert near `runDailyDigests`):

```ts
  /** Tenant ids eligible for a daily digest (have an email OR are multi-farmer). */
  async eligibleTenantIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(or(isNotNull(tenants.email), eq(tenants.multiFarmer, true))!)
      .orderBy(tenants.id);
    return rows.map((r) => r.id);
  }

  /** Build + enqueue (via EmailService) the digests for ONE tenant. Mirrors the
   *  per-tenant body of runDailyDigests so each tenant retries independently. */
  async runForTenant(tenantId: string): Promise<void> {
    const today = bgToday();
    const [tenant] = await this.db
      .select({ id: tenants.id, email: tenants.email, multiFarmer: tenants.multiFarmer })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) return;

    if (tenant.email) {
      const digest = await this.buildDigest(tenant.id, today);
      if (digest) {
        await this.email.sendMail({
          to: tenant.email,
          subject: 'Доставки за днес — FarmFlow',
          html: digest.html,
          text: digest.text,
        });
      }
    }
    if (tenant.multiFarmer) {
      await this.sendFarmerDigests(tenant.id, today);
    }
  }
```

> `sendFarmerDigests` and `buildDigest` stay `private` — `runForTenant` calls them from inside the same class, which is fine.

- [ ] **Step 2: Write the failing processor test**

`server/src/modules/digest/digest.processor.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { DigestProcessor } from './digest.processor';
import { DigestService } from './digest.service';
import { getQueueToken } from '@nestjs/bullmq';
import { DIGEST_QUEUE } from '../../common/queue/queue.constants';

function makeQueue() {
  return { add: jest.fn().mockResolvedValue(undefined) };
}

async function build(svc: any, queue: any): Promise<DigestProcessor> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      DigestProcessor,
      { provide: DigestService, useValue: svc },
      { provide: getQueueToken(DIGEST_QUEUE), useValue: queue },
    ],
  }).compile();
  return mod.get(DigestProcessor);
}

describe('DigestProcessor', () => {
  it('"daily" fans out one "tenant" job per eligible tenant', async () => {
    const queue = makeQueue();
    const svc = { eligibleTenantIds: jest.fn().mockResolvedValue(['t1', 't2']), runForTenant: jest.fn() };
    const proc = await build(svc, queue);
    await proc.process({ name: 'daily', data: {} } as Job);
    expect(queue.add).toHaveBeenCalledWith('tenant', { tenantId: 't1' });
    expect(queue.add).toHaveBeenCalledWith('tenant', { tenantId: 't2' });
  });

  it('"tenant" runs the digest for that tenant', async () => {
    const svc = { eligibleTenantIds: jest.fn(), runForTenant: jest.fn().mockResolvedValue(undefined) };
    const proc = await build(svc, makeQueue());
    await proc.process({ name: 'tenant', data: { tenantId: 't9' } } as Job);
    expect(svc.runForTenant).toHaveBeenCalledWith('t9');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @farmflow/api test -- digest.processor.spec`
Expected: FAIL — cannot find module `./digest.processor`.

- [ ] **Step 4: Implement the processor (with repeatable registration)**

`server/src/modules/digest/digest.processor.ts`:

```ts
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { DigestService } from './digest.service';
import { DIGEST_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(DIGEST_QUEUE)
export class DigestProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(DigestProcessor.name);

  constructor(
    private readonly digest: DigestService,
    @InjectQueue(DIGEST_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  // Register the 07:00 Europe/Sofia repeatable once on worker boot (idempotent).
  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'daily', '0 7 * * *');
  }

  async process(job: Job): Promise<void> {
    if (job.name === 'daily') {
      const ids = await this.digest.eligibleTenantIds();
      for (const tenantId of ids) {
        await this.queue.add('tenant', { tenantId });
      }
      this.logger.log(`[digest] fanned out ${ids.length} tenant job(s)`);
      return;
    }
    if (job.name === 'tenant') {
      await this.digest.runForTenant((job.data as { tenantId: string }).tenantId);
    }
  }
}
```

- [ ] **Step 5: Wire the queue + gated processor into DigestModule**

`server/src/modules/digest/digest.module.ts` — replace the file:

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DigestService } from './digest.service';
import { DigestController } from './digest.controller';
import { DigestProcessor } from './digest.processor';
import { DIGEST_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';

@Module({
  imports: [BullModule.registerQueue({ name: DIGEST_QUEUE })],
  controllers: [DigestController],
  providers: [DigestService, ...(RUN_WORKERS ? [DigestProcessor] : [])],
})
export class DigestModule {}
```

- [ ] **Step 6: Run the processor test + full suite**

Run: `pnpm --filter @farmflow/api test -- digest.processor.spec`
Expected: PASS (2 tests).

Run: `pnpm --filter @farmflow/api test`
Expected: green (existing digest behavior unchanged; cron removal doesn't break specs).

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/digest
git commit -m "feat(digest): repeatable 07:00 job with per-tenant fan-out (was @Cron)"
```

---

## Task D2: Slots cron → repeatable

**Files:**
- Modify: `server/src/modules/slots/slots.service.ts`
- Create: `server/src/modules/slots/slots.processor.ts`
- Modify: `server/src/modules/slots/slots.module.ts`
- Create (test): `server/src/modules/slots/slots.processor.spec.ts`

- [ ] **Step 1: Drop `@Cron` from the slots service**

`server/src/modules/slots/slots.service.ts`:

(a) Remove `Cron` from the `@nestjs/schedule` import (line 7) — delete the whole line `import { Cron } from '@nestjs/schedule';`.

(b) Remove the decorator `@Cron('30 6 * * *', { timeZone: 'Europe/Sofia' })` above `materializeAllRules` (keep the method).

- [ ] **Step 2: Write the failing processor test**

`server/src/modules/slots/slots.processor.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { SlotsProcessor } from './slots.processor';
import { SlotsService } from './slots.service';
import { getQueueToken } from '@nestjs/bullmq';
import { SLOTS_QUEUE } from '../../common/queue/queue.constants';

describe('SlotsProcessor', () => {
  it('"materialize" rolls every active rule forward', async () => {
    const svc = { materializeAllRules: jest.fn().mockResolvedValue(undefined) };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        SlotsProcessor,
        { provide: SlotsService, useValue: svc },
        { provide: getQueueToken(SLOTS_QUEUE), useValue: { add: jest.fn() } },
      ],
    }).compile();
    const proc = mod.get(SlotsProcessor);
    await proc.process({ name: 'materialize' } as Job);
    expect(svc.materializeAllRules).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @farmflow/api test -- slots.processor.spec`
Expected: FAIL — cannot find module `./slots.processor`.

- [ ] **Step 4: Implement the processor**

`server/src/modules/slots/slots.processor.ts`:

```ts
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { SlotsService } from './slots.service';
import { SLOTS_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(SLOTS_QUEUE)
export class SlotsProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private readonly slots: SlotsService,
    @InjectQueue(SLOTS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'materialize', '30 6 * * *');
  }

  async process(_job: Job): Promise<void> {
    await this.slots.materializeAllRules();
  }
}
```

- [ ] **Step 5: Wire the queue + gated processor into SlotsModule**

`server/src/modules/slots/slots.module.ts` — add to the module (keep existing providers/controllers):

```ts
import { BullModule } from '@nestjs/bullmq';
import { SlotsProcessor } from './slots.processor';
import { SLOTS_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';
```

- Add `BullModule.registerQueue({ name: SLOTS_QUEUE })` to the module's `imports` array (create an `imports:` array if none exists).
- Append `...(RUN_WORKERS ? [SlotsProcessor] : [])` to the `providers` array.

- [ ] **Step 6: Run the processor test + full suite**

Run: `pnpm --filter @farmflow/api test -- slots.processor.spec`
Expected: PASS (1 test).

Run: `pnpm --filter @farmflow/api test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/slots
git commit -m "feat(slots): repeatable 06:30 materialize job (was @Cron, fixes multi-copy double-insert)"
```

---

## Task D3: Billing grace cron → repeatable

**Files:**
- Modify: `server/src/modules/billing/billing.service.ts`
- Create: `server/src/modules/billing/billing.processor.ts`
- Modify: `server/src/modules/billing/billing.module.ts`
- Create (test): `server/src/modules/billing/billing.processor.spec.ts`

- [ ] **Step 1: Drop `@Cron` from the billing service**

`server/src/modules/billing/billing.service.ts`:

(a) Remove `import { Cron } from '@nestjs/schedule';` (line 8).

(b) Remove the decorator `@Cron('0 3 * * *', { timeZone: 'Europe/Sofia' })` above `suspendExpiredGrace` (keep the method — `billing.service.spec.ts` already tests it directly and stays green).

- [ ] **Step 2: Write the failing processor test**

`server/src/modules/billing/billing.processor.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { BillingProcessor } from './billing.processor';
import { BillingService } from './billing.service';
import { getQueueToken } from '@nestjs/bullmq';
import { BILLING_QUEUE } from '../../common/queue/queue.constants';

describe('BillingProcessor', () => {
  it('"suspend-grace" suspends farms past their grace window', async () => {
    const svc = { suspendExpiredGrace: jest.fn().mockResolvedValue(undefined) };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        BillingProcessor,
        { provide: BillingService, useValue: svc },
        { provide: getQueueToken(BILLING_QUEUE), useValue: { add: jest.fn() } },
      ],
    }).compile();
    const proc = mod.get(BillingProcessor);
    await proc.process({ name: 'suspend-grace' } as Job);
    expect(svc.suspendExpiredGrace).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @farmflow/api test -- billing.processor.spec`
Expected: FAIL — cannot find module `./billing.processor`.

- [ ] **Step 4: Implement the processor**

`server/src/modules/billing/billing.processor.ts`:

```ts
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { BillingService } from './billing.service';
import { BILLING_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(BILLING_QUEUE)
export class BillingProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    private readonly billing: BillingService,
    @InjectQueue(BILLING_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'suspend-grace', '0 3 * * *');
  }

  async process(_job: Job): Promise<void> {
    await this.billing.suspendExpiredGrace();
  }
}
```

- [ ] **Step 5: Wire the queue + gated processor into BillingModule**

`server/src/modules/billing/billing.module.ts` — add:

```ts
import { BullModule } from '@nestjs/bullmq';
import { BillingProcessor } from './billing.processor';
import { BILLING_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';
```

- Add `BullModule.registerQueue({ name: BILLING_QUEUE })` to the module `imports`.
- Append `...(RUN_WORKERS ? [BillingProcessor] : [])` to `providers`.

- [ ] **Step 6: Run the processor test + full suite**

Run: `pnpm --filter @farmflow/api test -- billing.processor.spec`
Expected: PASS (1 test).

Run: `pnpm --filter @farmflow/api test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/billing
git commit -m "feat(billing): repeatable 03:00 grace-suspend job (was @Cron)"
```

---

## Task D4: Remove `@nestjs/schedule`

**Files:**
- Modify: `server/src/app.module.ts`
- Modify: `server/package.json`

- [ ] **Step 1: Confirm no remaining `@Cron`/`ScheduleModule` usage**

Run: `git grep -n "@nestjs/schedule\|@Cron\|ScheduleModule" server/src`
Expected: only `server/src/app.module.ts:4` (`import { ScheduleModule }`) and `:52` (`ScheduleModule.forRoot(),`) remain.

- [ ] **Step 2: Remove from app.module**

`server/src/app.module.ts` — delete the import line `import { ScheduleModule } from '@nestjs/schedule';` and the `ScheduleModule.forRoot(),` line in `imports`.

- [ ] **Step 3: Uninstall the package**

Run: `pnpm --filter @farmflow/api remove @nestjs/schedule`
Expected: removed from `server/package.json`.

- [ ] **Step 4: Build + full suite**

Run: `pnpm --filter @farmflow/api build && pnpm --filter @farmflow/api test`
Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.module.ts server/package.json pnpm-lock.yaml
git commit -m "chore: drop @nestjs/schedule — crons are BullMQ repeatable jobs now"
```

---

## Task D5: Document the new env vars

**Files:**
- Modify: `server/.env.example`
- Modify: `.env.example`

- [ ] **Step 1: Append to both `.env.example` files**

```dotenv
# --- Horizontal scaling (see docs/superpowers/specs/2026-06-15-scale-prep-queues-design.md) ---
# Process role: all (default — HTTP + workers + scheduled jobs) | web (HTTP + enqueue) | worker (queues + scheduled jobs)
APP_ROLE=all
# Max Postgres connections this process opens. instances × DB_POOL_MAX must stay
# under Postgres max_connections (~100), else front Postgres with PgBouncer.
DB_POOL_MAX=10
```

- [ ] **Step 2: Commit**

```bash
git add server/.env.example .env.example
git commit -m "docs(env): document APP_ROLE + DB_POOL_MAX"
```

---

## Final verification (whole foundation)

- [ ] **Build + full test suite**

Run: `pnpm --filter @farmflow/api build && pnpm --filter @farmflow/api test`
Expected: build success; all specs green.

- [ ] **Manual multi-role smoke (local, shared Redis + Postgres)**

1. Terminal 1: `APP_ROLE=web pnpm --filter @farmflow/api start` → hit `GET /health/ready` → 200.
2. Terminal 2: `APP_ROLE=worker pnpm --filter @farmflow/api start`.
3. Trigger `POST /digest/test` against the web copy → confirm the email is delivered **once** (one `.mail-preview` file / one SMTP send), proving the worker drained the queued job and there's no double-send.
4. Stop Redis → `GET /health/ready` on either copy returns **503**; restart Redis → 200.
5. Send SIGTERM to the worker mid-job → it finishes the in-flight job before exiting (check logs).

---

## Self-review notes (author)

- Spec coverage: Phase A (pool/health/shutdown) ✅; Phase B (BullMQ + APP_ROLE) ✅; Phase C (email queue) ✅; Phase D (3 crons → repeatable, covers cron-safety row) ✅. Phase E (image) → companion plan.
- `RUN_WORKERS` name is consistent across all module wirings.
- Queue-name constants (`EMAIL_QUEUE`/`DIGEST_QUEUE`/`SLOTS_QUEUE`/`BILLING_QUEUE`) are referenced identically in processors, modules, and tests.
- `EmailService.deliver` / `writePreview` names match between service and spec.
