# Day-of SMS delivery-window reminder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the delivery day, automatically SMS each own-delivery customer their order number + approved delivery time window — once, idempotently, without operator action that morning.

**Architecture:** A new `common/sms` module (swappable `SmsProvider` behind `SmsService`, writing an `sms_log` audit row per send) plus a new `sms-reminder` module whose 08:00 Europe/Sofia BullMQ repeatable fans out per opted-in tenant and runs a claim-before-send loop that mirrors the existing email path `RoutingService.notifyDeliveryWindows`. Dedup uses a dedicated `orders.delivery_window_sms_at` column so the morning SMS is independent of the evening email.

**Tech Stack:** NestJS, Drizzle ORM (`@fermeribg/db`), BullMQ, `@nestjs/config`, Jest. Frontend: Next.js panel (`client/`).

## Global Constraints

- **Migrations are HAND-WRITTEN.** Add the `.sql` file AND the matching `_journal.json` entry. **Never leave a journal `idx` gap** — a gap silently breaks the drizzle migrator (caused a prod outage before). Current journal head: `idx: 101`, tag `0103`. Next: `idx: 102`, tag `0104`.
- **Own-delivery only:** the reminder targets `deliveryType='address'`, `status='confirmed'` orders. Econt/Speedy courier orders are excluded (they have carrier SMS).
- **Per-tenant opt-in:** `tenants.settings.sms.dayOfReminder` (boolean, default `false`). A tenant with it off never enters the fan-out.
- **Transactional message, Cyrillic:** `ФермериБГ: доставка днес на поръчка #<n>, между <HH:MM>–<HH:MM> ч.` Platform sender ID (default `ФермериБГ`), configurable via env.
- **Phone normalization:** reuse `normalizePhone` from `server/src/modules/cod-risk/cod-risk.helpers.ts` (E.164 BG; returns `null` if un-normalisable).
- **Idempotency:** dedicated column `orders.delivery_window_sms_at`; atomic claim-before-send; release the claim on send failure so it retries. Never reuse the email column `delivery_window_notified_at`.
- **Web/worker split:** register the processor provider only when `RUN_WORKERS` (see `server/src/config/app-role.ts`), like `DigestModule`.
- **Safe by default:** with no gateway creds configured, `SmsService` uses `LogOnlySmsProvider` (logs, no real send, no spend).

---

## File Structure

**Create:**
- `server/src/common/sms/sms.constants.ts` — queue name + DI tokens + env keys
- `server/src/common/sms/sms.types.ts` — `SmsProvider` interface, `SmsSendResult`, `SmsSendMeta`
- `server/src/common/sms/sms-segments.ts` — `smsSegments(body)` helper
- `server/src/common/sms/log-only-sms.provider.ts` — `LogOnlySmsProvider`
- `server/src/common/sms/http-sms.provider.ts` — `HttpSmsProvider` (BG gateway)
- `server/src/common/sms/sms.provider.factory.ts` — picks Http vs LogOnly from env
- `server/src/common/sms/sms.service.ts` — `SmsService.sendSms(...)` + `sms_log` write
- `server/src/common/sms/sms.module.ts` — `SmsModule` (exports `SmsService`)
- `server/src/common/sms/*.spec.ts` — unit tests (segments, provider factory, service)
- `server/src/modules/sms-reminder/sms-reminder.service.ts` — eligible tenants + per-tenant send loop
- `server/src/modules/sms-reminder/sms-reminder.processor.ts` — cron register + fan-out
- `server/src/modules/sms-reminder/sms-reminder.controller.ts` — manual trigger (operator)
- `server/src/modules/sms-reminder/sms-reminder.module.ts` — module
- `server/src/modules/sms-reminder/*.spec.ts` — tests
- `packages/db/drizzle/0104_sms_reminder.sql` — migration
- `client/src/components/settings/sms-reminder-card.tsx` — operator toggle

**Modify:**
- `packages/db/src/schema.ts` — add `smsLog` table + `orders.deliveryWindowSmsAt`; export `smsLog`
- `packages/db/drizzle/meta/_journal.json` — append `idx: 102` entry
- `server/src/modules/tenants/dto/update-tenant.dto.ts` — add `sms?` field
- `server/src/modules/tenants/tenants.service.ts:198-217` — merge `sms` into `settings`
- `server/src/modules/tenants/tenants.mapper.ts` (wherever `toPublicTenant` lives) — surface `sms`
- `packages/types/src/index.ts` — add `sms?` to `PublicTenant`
- `server/src/app.module.ts` — import `SmsModule` + `SmsReminderModule`
- `server/src/common/queue/queue.constants.ts` — add `SMS_QUEUE`
- `client/src/lib/api-client.ts:348` — add `sms?` to `updateTenant` data type
- `client/src/components/delivery/delivery-client.tsx` — mount `SmsReminderCard`

---

## Task 1: DB schema + migration (`sms_log` table + `orders.delivery_window_sms_at`)

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0104_sms_reminder.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`

**Interfaces:**
- Produces: `smsLog` table export; `orders.deliveryWindowSmsAt` column (`timestamptz`, nullable).

- [ ] **Step 1: Add the `deliveryWindowSmsAt` column to `orders`**

In `packages/db/src/schema.ts`, in the `orders` table, immediately after `deliveryWindowNotifiedAt` (around line 478):

```ts
    // Day-of SMS reminder claim/idempotency marker (separate from the email's
    // delivery_window_notified_at): the morning SMS must fire exactly once even
    // when the window email already went out the evening before. Migration 0104.
    deliveryWindowSmsAt: timestamp('delivery_window_sms_at', { withTimezone: true }),
```

- [ ] **Step 2: Add the `smsLog` table**

In `packages/db/src/schema.ts`, after the `cod_risk_events` table block (near line 780; ensure `smallint` and `index` are already imported at the top — they are used elsewhere in this file):

```ts
// One row per attempted SMS send — audit trail, dedup evidence, and cost
// accounting (segments). `kind` lets future message types reuse the table.
export const smsLog = pgTable(
  'sms_log',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    phone: text('phone').notNull(), // normalized E.164 BG
    body: text('body').notNull(),
    segments: smallint('segments').notNull().default(1),
    provider: text('provider').notNull(), // 'http' | 'log-only'
    providerMessageId: text('provider_message_id'),
    status: text('status').notNull(), // 'sent' | 'failed'
    error: text('error'),
    kind: text('kind').notNull().default('delivery_window'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    tenantCreatedIdx: index('sms_log_tenant_created_idx').on(t.tenantId, t.createdAt),
    orderIdx: index('sms_log_order_idx').on(t.orderId),
  }),
);
```

- [ ] **Step 3: Export `smsLog` in the aggregate schema object**

In `packages/db/src/schema.ts`, find the aggregate export list that contains `deliverySlots,` (around line 1346) and add `smsLog,` to it (keep alphabetin-neighbourhood ordering loose — match the file's existing style).

- [ ] **Step 4: Write the migration SQL**

Create `packages/db/drizzle/0104_sms_reminder.sql`:

```sql
CREATE TABLE IF NOT EXISTS "sms_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"tenant_id" uuid,
	"order_id" uuid,
	"phone" text NOT NULL,
	"body" text NOT NULL,
	"segments" smallint DEFAULT 1 NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text,
	"status" text NOT NULL,
	"error" text,
	"kind" text DEFAULT 'delivery_window' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sms_log" ADD CONSTRAINT "sms_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sms_log" ADD CONSTRAINT "sms_log_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_log_tenant_created_idx" ON "sms_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sms_log_order_idx" ON "sms_log" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "delivery_window_sms_at" timestamp with time zone;
```

- [ ] **Step 5: Append the journal entry (NO idx gap)**

In `packages/db/drizzle/meta/_journal.json`, append to the `entries` array after the `idx: 101` entry:

```json
    ,{
      "idx": 102,
      "version": "7",
      "when": 1784100000000,
      "tag": "0104_sms_reminder",
      "breakpoints": true
    }
```

(Match the existing formatting — the appended object must be a sibling of the `idx: 101` object inside `entries`.)

- [ ] **Step 6: Build the db package to typecheck the schema**

Run: `npm run build --workspace @fermeribg/db` (or the repo's db build script)
Expected: build succeeds; `smsLog` and `orders.deliveryWindowSmsAt` are exported types.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0104_sms_reminder.sql packages/db/drizzle/meta/_journal.json
git commit -m "feat(db): sms_log table + orders.delivery_window_sms_at (migration 0104)"
```

---

## Task 2: `SmsProvider` interface, segments helper, providers + factory

**Files:**
- Create: `server/src/common/sms/sms.types.ts`
- Create: `server/src/common/sms/sms.constants.ts`
- Create: `server/src/common/sms/sms-segments.ts`
- Create: `server/src/common/sms/log-only-sms.provider.ts`
- Create: `server/src/common/sms/http-sms.provider.ts`
- Create: `server/src/common/sms/sms.provider.factory.ts`
- Test: `server/src/common/sms/sms-segments.spec.ts`, `server/src/common/sms/sms.provider.factory.spec.ts`

**Interfaces:**
- Produces:
  - `interface SmsProvider { send(to: string, body: string): Promise<{ providerMessageId: string | null; segments: number }>; readonly name: string; }`
  - `smsSegments(body: string): number`
  - `class LogOnlySmsProvider implements SmsProvider`
  - `class HttpSmsProvider implements SmsProvider`
  - `createSmsProvider(config: ConfigService, logger: Logger): SmsProvider`
  - Tokens: `SMS_PROVIDER` (DI token), `SMS_QUEUE = 'sms'`
  - Env keys: `SMS_GATEWAY_URL`, `SMS_GATEWAY_TOKEN`, `SMS_SENDER_ID`

- [ ] **Step 1: Write the failing test for `smsSegments`**

Create `server/src/common/sms/sms-segments.spec.ts`:

```ts
import { smsSegments } from './sms-segments';

describe('smsSegments', () => {
  it('counts a short Latin message as 1 segment', () => {
    expect(smsSegments('Hello')).toBe(1);
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
  });

  it('counts Cyrillic (UCS-2) at 70/67 chars per segment', () => {
    expect(smsSegments('Здравей')).toBe(1); // 7 chars
    expect(smsSegments('я'.repeat(70))).toBe(1);
    expect(smsSegments('я'.repeat(71))).toBe(2); // >70 → multipart → 67/seg
  });

  it('empty string is 1 segment', () => {
    expect(smsSegments('')).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --workspace server -- sms-segments`
Expected: FAIL — cannot find module `./sms-segments`.

- [ ] **Step 3: Implement `sms-segments.ts`**

Create `server/src/common/sms/sms-segments.ts`:

```ts
/**
 * Estimate how many SMS segments `body` will use. GSM-7 messages fit 160 chars
 * (153 per part when multipart); any non-GSM-7 char (e.g. Cyrillic) forces
 * UCS-2 at 70 chars (67 per part when multipart). We only need a good-enough
 * count for cost accounting, so we treat "has a non-GSM-7 char" as UCS-2.
 */
const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

function isGsm7(body: string): boolean {
  for (const ch of body) {
    if (!GSM7.includes(ch)) return false;
  }
  return true;
}

export function smsSegments(body: string): number {
  if (body.length === 0) return 1;
  const ucs2 = !isGsm7(body);
  const single = ucs2 ? 70 : 160;
  const multi = ucs2 ? 67 : 153;
  const len = ucs2 ? [...body].length : body.length;
  if (len <= single) return 1;
  return Math.ceil(len / multi);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace server -- sms-segments`
Expected: PASS.

- [ ] **Step 5: Write `sms.types.ts` and `sms.constants.ts`**

Create `server/src/common/sms/sms.constants.ts`:

```ts
export const SMS_QUEUE = 'sms';
/** DI token for the resolved SmsProvider (Http or LogOnly). */
export const SMS_PROVIDER = 'SMS_PROVIDER';
```

Create `server/src/common/sms/sms.types.ts`:

```ts
export interface SmsProviderResult {
  providerMessageId: string | null;
  segments: number;
}

export interface SmsProvider {
  /** Human-readable provider name, recorded in sms_log.provider. */
  readonly name: string;
  /** Send `body` to E.164 `to`. Throws on gateway failure. */
  send(to: string, body: string): Promise<SmsProviderResult>;
}

/** Extra context for the sms_log row. */
export interface SmsSendMeta {
  tenantId?: string | null;
  orderId?: string | null;
  kind?: string; // default 'delivery_window'
}

export interface SmsSendResult {
  status: 'sent' | 'failed';
  providerMessageId: string | null;
  segments: number;
}
```

- [ ] **Step 6: Write `LogOnlySmsProvider`**

Create `server/src/common/sms/log-only-sms.provider.ts`:

```ts
import { Logger } from '@nestjs/common';
import { SmsProvider, SmsProviderResult } from './sms.types';
import { smsSegments } from './sms-segments';

/**
 * No-op provider used when no gateway creds are configured. Logs the message
 * instead of sending, so dev/staging (and a misconfigured prod) never spends
 * money or messages a real customer. The whole pipeline is still exercised.
 */
export class LogOnlySmsProvider implements SmsProvider {
  readonly name = 'log-only';
  constructor(private readonly logger: Logger) {}

  async send(to: string, body: string): Promise<SmsProviderResult> {
    this.logger.log(`[sms:log-only] → ${to}: ${body}`);
    return { providerMessageId: null, segments: smsSegments(body) };
  }
}
```

- [ ] **Step 7: Write `HttpSmsProvider`**

Create `server/src/common/sms/http-sms.provider.ts`:

```ts
import { Logger } from '@nestjs/common';
import { SmsProvider, SmsProviderResult } from './sms.types';
import { smsSegments } from './sms-segments';

export interface HttpSmsConfig {
  url: string;
  token: string;
  senderId: string;
}

/**
 * Generic BG HTTP SMS gateway adapter (SMSAPI.bg / Mobica / iSMS-style). POSTs a
 * JSON body { from, to, message } with a Bearer token and expects a JSON reply
 * carrying a message id. Adjust the request/response mapping to the concrete
 * gateway once its account exists — the interface stays the same.
 */
export class HttpSmsProvider implements SmsProvider {
  readonly name = 'http';
  constructor(
    private readonly cfg: HttpSmsConfig,
    private readonly logger: Logger,
  ) {}

  async send(to: string, body: string): Promise<SmsProviderResult> {
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.token}`,
      },
      body: JSON.stringify({ from: this.cfg.senderId, to, message: body }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`sms gateway ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      messageId?: string;
      segments?: number;
    };
    return {
      providerMessageId: json.id ?? json.messageId ?? null,
      segments: json.segments ?? smsSegments(body),
    };
  }
}
```

- [ ] **Step 8: Write the failing test for the factory**

Create `server/src/common/sms/sms.provider.factory.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSmsProvider } from './sms.provider.factory';

function cfg(map: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

describe('createSmsProvider', () => {
  const logger = new Logger('test');

  it('returns HttpSmsProvider when url + token are set', () => {
    const p = createSmsProvider(
      cfg({ SMS_GATEWAY_URL: 'https://gw', SMS_GATEWAY_TOKEN: 't' }),
      logger,
    );
    expect(p.name).toBe('http');
  });

  it('falls back to LogOnlySmsProvider when creds are missing', () => {
    expect(createSmsProvider(cfg({}), logger).name).toBe('log-only');
    expect(createSmsProvider(cfg({ SMS_GATEWAY_URL: 'https://gw' }), logger).name).toBe(
      'log-only',
    );
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `npm test --workspace server -- sms.provider.factory`
Expected: FAIL — cannot find `./sms.provider.factory`.

- [ ] **Step 10: Implement the factory**

Create `server/src/common/sms/sms.provider.factory.ts`:

```ts
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsProvider } from './sms.types';
import { HttpSmsProvider } from './http-sms.provider';
import { LogOnlySmsProvider } from './log-only-sms.provider';

export function createSmsProvider(config: ConfigService, logger: Logger): SmsProvider {
  const url = config.get<string>('SMS_GATEWAY_URL');
  const token = config.get<string>('SMS_GATEWAY_TOKEN');
  const senderId = config.get<string>('SMS_SENDER_ID') ?? 'ФермериБГ';
  if (url && token) {
    return new HttpSmsProvider({ url, token, senderId }, logger);
  }
  logger.warn('[sms] no gateway creds — using LogOnlySmsProvider (no real sends)');
  return new LogOnlySmsProvider(logger);
}
```

- [ ] **Step 11: Run the factory test to verify it passes**

Run: `npm test --workspace server -- sms.provider.factory`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add server/src/common/sms/
git commit -m "feat(sms): SmsProvider interface, segments helper, http/log-only providers + factory"
```

---

## Task 3: `SmsService` (normalize → send → `sms_log`)

**Files:**
- Create: `server/src/common/sms/sms.service.ts`
- Test: `server/src/common/sms/sms.service.spec.ts`

**Interfaces:**
- Consumes: `SmsProvider` (via `SMS_PROVIDER` token), `Database` (via `DB_TOKEN`), `smsLog` table, `normalizePhone`.
- Produces: `class SmsService { sendSms(phone: string, body: string, meta?: SmsSendMeta): Promise<SmsSendResult> }`.

- [ ] **Step 1: Write the failing test**

Create `server/src/common/sms/sms.service.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import { SmsService } from './sms.service';
import { SmsProvider } from './sms.types';

function makeDb() {
  const rows: any[] = [];
  const db = {
    insert: () => ({ values: async (v: any) => { rows.push(v); } }),
  };
  return { db: db as any, rows };
}

describe('SmsService', () => {
  const logger = new Logger('test');

  it('normalizes the phone, sends, and writes a sent log row', async () => {
    const provider: SmsProvider = {
      name: 'http',
      send: jest.fn().mockResolvedValue({ providerMessageId: 'm1', segments: 2 }),
    };
    const { db, rows } = makeDb();
    const svc = new SmsService(db, provider, logger);

    const res = await svc.sendSms('0888123456', 'здравей', { tenantId: 't1', orderId: 'o1' });

    expect(provider.send).toHaveBeenCalledWith('+359888123456', 'здравей');
    expect(res).toEqual({ status: 'sent', providerMessageId: 'm1', segments: 2 });
    expect(rows[0]).toMatchObject({
      tenantId: 't1', orderId: 'o1', phone: '+359888123456',
      provider: 'http', status: 'sent', providerMessageId: 'm1', segments: 2,
      kind: 'delivery_window',
    });
  });

  it('rejects an un-normalisable phone without calling the provider', async () => {
    const provider: SmsProvider = { name: 'http', send: jest.fn() };
    const { db, rows } = makeDb();
    const svc = new SmsService(db, provider, logger);

    const res = await svc.sendSms('123', 'x', { tenantId: 't1' });

    expect(provider.send).not.toHaveBeenCalled();
    expect(res.status).toBe('failed');
    expect(rows[0]).toMatchObject({ status: 'failed', error: 'invalid_phone' });
  });

  it('records a failed row (and does not throw) when the provider throws', async () => {
    const provider: SmsProvider = {
      name: 'http',
      send: jest.fn().mockRejectedValue(new Error('gw 500')),
    };
    const { db, rows } = makeDb();
    const svc = new SmsService(db, provider, logger);

    const res = await svc.sendSms('0888123456', 'здравей');

    expect(res.status).toBe('failed');
    expect(rows[0]).toMatchObject({ status: 'failed', provider: 'http' });
    expect(rows[0].error).toContain('gw 500');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --workspace server -- sms.service`
Expected: FAIL — cannot find `./sms.service`.

- [ ] **Step 3: Implement `SmsService`**

Create `server/src/common/sms/sms.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Database, smsLog } from '@fermeribg/db';
import { DB_TOKEN } from '../drizzle/drizzle.constants';
import { normalizePhone } from '../../modules/cod-risk/cod-risk.helpers';
import { SMS_PROVIDER } from './sms.constants';
import { SmsProvider, SmsSendMeta, SmsSendResult } from './sms.types';
import { smsSegments } from './sms-segments';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    @Inject(SMS_PROVIDER) private readonly provider: SmsProvider,
    // Optional logger param kept for tests; falls back to the class logger.
    logger?: Logger,
  ) {
    if (logger) this.logger = logger;
  }

  /**
   * Normalize `phone` to E.164 BG, send `body`, and record the attempt in
   * sms_log. Never throws to the caller — a bad number or gateway error is
   * recorded and returned as { status: 'failed' } so a batch loop can decide
   * whether to release its claim and retry.
   */
  async sendSms(phone: string, body: string, meta: SmsSendMeta = {}): Promise<SmsSendResult> {
    const kind = meta.kind ?? 'delivery_window';
    const normalized = normalizePhone(phone);
    if (!normalized) {
      await this.write({
        tenantId: meta.tenantId ?? null,
        orderId: meta.orderId ?? null,
        phone: phone ?? '',
        body,
        segments: 0,
        provider: this.provider.name,
        providerMessageId: null,
        status: 'failed',
        error: 'invalid_phone',
        kind,
      });
      return { status: 'failed', providerMessageId: null, segments: 0 };
    }
    try {
      const { providerMessageId, segments } = await this.provider.send(normalized, body);
      await this.write({
        tenantId: meta.tenantId ?? null,
        orderId: meta.orderId ?? null,
        phone: normalized,
        body,
        segments,
        provider: this.provider.name,
        providerMessageId,
        status: 'sent',
        error: null,
        kind,
      });
      return { status: 'sent', providerMessageId, segments };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`sms send failed to ${normalized}: ${message}`);
      await this.write({
        tenantId: meta.tenantId ?? null,
        orderId: meta.orderId ?? null,
        phone: normalized,
        body,
        segments: smsSegments(body),
        provider: this.provider.name,
        providerMessageId: null,
        status: 'failed',
        error: message.slice(0, 500),
        kind,
      });
      return { status: 'failed', providerMessageId: null, segments: smsSegments(body) };
    }
  }

  private async write(row: typeof smsLog.$inferInsert): Promise<void> {
    try {
      await this.db.insert(smsLog).values(row);
    } catch (err) {
      // Logging the SMS must never fail the send path.
      this.logger.error(`sms_log insert failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace server -- sms.service`
Expected: PASS.

> Note: the constructor's optional `logger?` param is for the unit test's plain `new SmsService(...)`. Nest injects only the two `@Inject` params; the third is undefined in DI, which is fine.

- [ ] **Step 5: Commit**

```bash
git add server/src/common/sms/sms.service.ts server/src/common/sms/sms.service.spec.ts
git commit -m "feat(sms): SmsService — normalize, send, sms_log audit row"
```

---

## Task 4: `SmsModule` wiring + queue constant

**Files:**
- Create: `server/src/common/sms/sms.module.ts`
- Modify: `server/src/common/queue/queue.constants.ts`

**Interfaces:**
- Consumes: `createSmsProvider`, `SmsService`, `SMS_PROVIDER`.
- Produces: `SmsModule` (exports `SmsService`); `SMS_QUEUE` re-exported from `sms.constants.ts` (already defined there). Add `SMS_QUEUE` to `queue.constants.ts` for symmetry with other queues.

- [ ] **Step 1: Add `SMS_QUEUE` to `queue.constants.ts`**

In `server/src/common/queue/queue.constants.ts`, append:

```ts
export const SMS_QUEUE = 'sms';
```

- [ ] **Step 2: Write `SmsModule`**

Create `server/src/common/sms/sms.module.ts`:

```ts
import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmsService } from './sms.service';
import { SMS_PROVIDER } from './sms.constants';
import { createSmsProvider } from './sms.provider.factory';
import { SmsProvider } from './sms.types';

@Module({
  providers: [
    {
      provide: SMS_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SmsProvider =>
        createSmsProvider(config, new Logger('SmsProvider')),
    },
    SmsService,
  ],
  exports: [SmsService],
})
export class SmsModule {}
```

- [ ] **Step 3: Verify the server still compiles**

Run: `npm run build --workspace server`
Expected: build succeeds (module not yet imported anywhere — that's Task 8/9).

- [ ] **Step 4: Commit**

```bash
git add server/src/common/sms/sms.module.ts server/src/common/queue/queue.constants.ts
git commit -m "feat(sms): SmsModule (provider factory + SmsService) + SMS_QUEUE constant"
```

---

## Task 5: Persist `settings.sms.dayOfReminder` (DTO + service merge + public surface)

**Files:**
- Create: `server/src/modules/tenants/sms-settings.ts` (defensive parse helper)
- Modify: `server/src/modules/tenants/dto/update-tenant.dto.ts`
- Modify: `server/src/modules/tenants/tenants.service.ts:198-217`
- Modify: the `toPublicTenant` mapper (find with `rg -n "function toPublicTenant"`) to surface `sms`
- Modify: `packages/types/src/index.ts` — add `sms?` to `PublicTenant`
- Modify: `client/src/lib/api-client.ts:348` — add `sms?` to `updateTenant` data type
- Test: `server/src/modules/tenants/sms-settings.spec.ts`

**Interfaces:**
- Produces: `parseSmsSettings(settings: unknown): { dayOfReminder: boolean }`; `PublicTenant.sms?: { dayOfReminder: boolean }`; `updateTenant({ sms })` client accepts `{ dayOfReminder?: boolean }`.

- [ ] **Step 1: Write the failing test for the parse helper**

Create `server/src/modules/tenants/sms-settings.spec.ts`:

```ts
import { parseSmsSettings } from './sms-settings';

describe('parseSmsSettings', () => {
  it('defaults to dayOfReminder=false on absent/garbage input', () => {
    expect(parseSmsSettings(null)).toEqual({ dayOfReminder: false });
    expect(parseSmsSettings({})).toEqual({ dayOfReminder: false });
    expect(parseSmsSettings({ sms: 'nope' })).toEqual({ dayOfReminder: false });
    expect(parseSmsSettings({ sms: { dayOfReminder: 'yes' } })).toEqual({ dayOfReminder: false });
  });

  it('reads a real boolean', () => {
    expect(parseSmsSettings({ sms: { dayOfReminder: true } })).toEqual({ dayOfReminder: true });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test --workspace server -- sms-settings`
Expected: FAIL — cannot find `./sms-settings`.

- [ ] **Step 3: Implement the parse helper**

Create `server/src/modules/tenants/sms-settings.ts`:

```ts
/** SMS config, stored per tenant in `tenants.settings.sms`. */
export interface SmsSettings {
  dayOfReminder: boolean;
}

/** Defensive parse of the untyped settings jsonb — absent/garbage → off. */
export function parseSmsSettings(settings: unknown): SmsSettings {
  const sms = (settings as { sms?: unknown } | null)?.sms;
  const dayOfReminder =
    typeof (sms as { dayOfReminder?: unknown })?.dayOfReminder === 'boolean'
      ? ((sms as { dayOfReminder: boolean }).dayOfReminder)
      : false;
  return { dayOfReminder };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace server -- sms-settings`
Expected: PASS.

- [ ] **Step 5: Add the `sms` field to `UpdateTenantDto`**

In `server/src/modules/tenants/dto/update-tenant.dto.ts`, add near the `routing?` field (mirror its decorators; import `IsObject` if not already imported):

```ts
  /**
   * SMS config blob, persisted to `settings.sms`. Validated only as an object;
   * shape parsed defensively server-side (parseSmsSettings). e.g. { dayOfReminder: true }.
   */
  @ApiPropertyOptional({ description: 'SMS config (persisted to settings.sms)' })
  @IsOptional()
  @IsObject()
  sms?: Record<string, unknown>;
```

- [ ] **Step 6: Merge `sms` into settings in `tenants.service.ts`**

In `server/src/modules/tenants/tenants.service.ts`, in `updateMe`:

Change the destructure (line 161) to also pull `sms`:

```ts
    const { delivery, routing, sms, farmAddress, farmLat, farmLng, ...flat } = dto;
```

Change the settings-merge guard (line 198) to also trigger on `sms`:

```ts
    if (delivery !== undefined || routing !== undefined || sms !== undefined) {
```

Inside that block, after the `routing` merge (line 215), add:

```ts
      if (sms !== undefined) {
        // Sanitize to the one boolean we support; never store arbitrary keys.
        const cur = (existing.sms as Record<string, unknown> | undefined) ?? {};
        nextSettings.sms = { ...cur, dayOfReminder: (sms as { dayOfReminder?: unknown }).dayOfReminder === true };
      }
```

- [ ] **Step 7: Surface `sms` on the public tenant**

Find the mapper: `rg -n "function toPublicTenant" server/src/modules/tenants`. In it, alongside where `routing`/`delivery` are read from `settings` and attached to the returned object, add:

```ts
    sms: parseSmsSettings(row.settings),
```

(Import `parseSmsSettings` from `./sms-settings`. Use the same `row.settings` variable the mapper already reads for `delivery`/`routing`.)

- [ ] **Step 8: Add `sms` to the `PublicTenant` type**

In `packages/types/src/index.ts`, in the `PublicTenant` type (around line 192), add alongside `routing?: unknown`:

```ts
  sms?: { dayOfReminder: boolean };
```

- [ ] **Step 9: Add `sms` to the client `updateTenant` data type**

In `client/src/lib/api-client.ts`, in the `updateTenant` data object type (starts line 348, has `routing?`), add:

```ts
  sms?: { dayOfReminder?: boolean };
```

- [ ] **Step 10: Extend the tenants update spec**

In `server/src/modules/tenants/tenants.update.spec.ts`, add a test mirroring the existing "merges delivery into settings without dropping other keys" test:

```ts
  it('merges sms.dayOfReminder into settings without dropping other keys', async () => {
    const existing = { delivery: { foo: 1 }, media: { hero: {} } };
    const { db, captured } = makeDb([[{ settings: existing }]], baseRow);
    const svc = makeService(db);
    await svc.updateMe('t1', { sms: { dayOfReminder: true } } as any);
    expect(captured.set.settings).toMatchObject({
      delivery: { foo: 1 },
      media: { hero: {} },
      sms: { dayOfReminder: true },
    });
  });
```

(Match the file's existing `makeDb`/`makeService`/`captured` helpers — read the top of the spec to reuse them exactly.)

- [ ] **Step 11: Run the tenants tests**

Run: `npm test --workspace server -- tenants`
Expected: PASS (existing + new).

- [ ] **Step 12: Build types + client typecheck**

Run: `npm run build --workspace @fermeribg/types && npm run -w client typecheck` (or the client's tsc script)
Expected: succeeds.

- [ ] **Step 13: Commit**

```bash
git add server/src/modules/tenants packages/types/src/index.ts client/src/lib/api-client.ts
git commit -m "feat(sms): persist + surface settings.sms.dayOfReminder"
```

---

## Task 6: SMS reminder service (eligible tenants + per-tenant claim-before-send loop)

**Files:**
- Create: `server/src/modules/sms-reminder/sms-reminder.service.ts`
- Test: `server/src/modules/sms-reminder/sms-reminder.service.spec.ts`

**Interfaces:**
- Consumes: `Database` (`DB_TOKEN`), `SmsService.sendSms`, `orders`, `deliverySlots`, `tenants`, `scheduledForDay`, `bgToday`, `normalizePhone`.
- Produces:
  - `class SmsReminderService`
  - `eligibleTenantIds(): Promise<string[]>` — tenants with `settings.sms.dayOfReminder = true`
  - `sendForTenant(tenantId: string, date?: string): Promise<{ sent: number; skipped: number; failed: number; total: number; date: string }>`
  - `buildBody(orderNumber: number | null, start: string, end: string): string` (exported for tests)

- [ ] **Step 1: Write the failing tests**

Create `server/src/modules/sms-reminder/sms-reminder.service.spec.ts`:

```ts
import { SmsReminderService, buildBody } from './sms-reminder.service';

describe('buildBody', () => {
  it('formats the Cyrillic reminder', () => {
    expect(buildBody(42, '10:00', '12:00')).toBe(
      'ФермериБГ: доставка днес на поръчка #42, между 10:00–12:00 ч.',
    );
  });
});

describe('SmsReminderService.sendForTenant', () => {
  // Minimal query-builder stub: select() → chainable → resolves to `rows`;
  // update() → chainable → returning() resolves to the claim result.
  function makeDb(rows: any[], claimWins: boolean[]) {
    let claimCall = 0;
    const select = () => {
      const q: any = {};
      for (const m of ['from', 'leftJoin', 'where']) q[m] = () => q;
      q.then = (res: any) => res(rows);
      return q;
    };
    const update = () => {
      const q: any = {};
      q.set = () => q;
      q.where = () => q;
      q.returning = async () => (claimWins[claimCall++] ? [{ id: 'x' }] : []);
      return q;
    };
    return { select, update } as any;
  }

  const baseRow = {
    id: 'o1', phone: '0888123456', orderNumber: 7,
    windowStart: '09:00:00', windowEnd: '11:00:00',
  };

  it('claims, sends, and counts a successful reminder', async () => {
    const sms = { sendSms: jest.fn().mockResolvedValue({ status: 'sent' }) };
    const db = makeDb([baseRow], [true]);
    const svc = new SmsReminderService(db, sms as any);
    const res = await svc.sendForTenant('t1', '2026-07-13');
    expect(sms.sendSms).toHaveBeenCalledWith(
      '0888123456',
      'ФермериБГ: доставка днес на поръчка #7, между 09:00–11:00 ч.',
      { tenantId: 't1', orderId: 'o1', kind: 'delivery_window' },
    );
    expect(res).toMatchObject({ sent: 1, skipped: 0, failed: 0, total: 1 });
  });

  it('skips a row with no phone without claiming', async () => {
    const sms = { sendSms: jest.fn() };
    const db = makeDb([{ ...baseRow, phone: null }], [true]);
    const svc = new SmsReminderService(db, sms as any);
    const res = await svc.sendForTenant('t1', '2026-07-13');
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(res).toMatchObject({ sent: 0, skipped: 1, total: 1 });
  });

  it('skips when the claim is lost (idempotent re-run)', async () => {
    const sms = { sendSms: jest.fn() };
    const db = makeDb([baseRow], [false]);
    const svc = new SmsReminderService(db, sms as any);
    const res = await svc.sendForTenant('t1', '2026-07-13');
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(res).toMatchObject({ sent: 0, skipped: 1 });
  });

  it('releases the claim and counts failed when the send fails', async () => {
    const sms = { sendSms: jest.fn().mockResolvedValue({ status: 'failed' }) };
    const db = makeDb([baseRow], [true]);
    const releaseSpy = jest.spyOn(db, 'update');
    const svc = new SmsReminderService(db, sms as any);
    const res = await svc.sendForTenant('t1', '2026-07-13');
    expect(res).toMatchObject({ failed: 1, sent: 0 });
    // update() called twice: once to claim, once to release.
    expect(releaseSpy).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace server -- sms-reminder.service`
Expected: FAIL — cannot find `./sms-reminder.service`.

- [ ] **Step 3: Implement `SmsReminderService`**

Create `server/src/modules/sms-reminder/sms-reminder.service.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { type Database, orders, deliverySlots, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { SmsService } from '../../common/sms/sms.service';
import { normalizePhone } from '../cod-risk/cod-risk.helpers';
import { scheduledForDay } from '../orders/order-scheduling';
import { bgToday } from '../../common/time/bg-time';

/** 'HH:MM:SS' pg time → 'HH:MM'. */
const hhmm = (t: string | null): string => (t ?? '').slice(0, 5);

/** The Cyrillic day-of reminder body. */
export function buildBody(orderNumber: number | null, start: string, end: string): string {
  const n = orderNumber != null ? `#${orderNumber}` : '';
  return `ФермериБГ: доставка днес на поръчка ${n}, между ${start}–${end} ч.`.replace(
    'поръчка ,',
    'поръчка,',
  );
}

@Injectable()
export class SmsReminderService {
  private readonly logger = new Logger(SmsReminderService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly sms: SmsService,
  ) {}

  /** Tenants that opted into the day-of SMS reminder. */
  async eligibleTenantIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(sql`(${tenants.settings} #>> '{sms,dayOfReminder}') = 'true'`);
    return rows.map((r) => r.id);
  }

  /**
   * SMS every own-delivery customer their approved window for `date` (default
   * today, Europe/Sofia). Claim-before-send on delivery_window_sms_at makes this
   * idempotent: a re-run or concurrent worker never double-sends. Mirrors the
   * email path RoutingService.notifyDeliveryWindows.
   */
  async sendForTenant(
    tenantId: string,
    date?: string,
  ): Promise<{ sent: number; skipped: number; failed: number; total: number; date: string }> {
    const day = date ?? bgToday();
    const rows = await this.db
      .select({
        id: orders.id,
        phone: orders.customerPhone,
        orderNumber: orders.orderNumber,
        windowStart: orders.deliveryWindowStart,
        windowEnd: orders.deliveryWindowEnd,
      })
      .from(orders)
      // scheduledForDay references deliverySlots.date — join per its contract.
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'confirmed'),
          eq(orders.deliveryType, 'address'),
          scheduledForDay(day),
          // Approved OR already-emailed (sent): the morning SMS still fires.
          inArray(orders.deliveryWindowStatus, ['approved', 'sent']),
          isNotNull(orders.deliveryWindowStart),
          isNull(orders.deliveryWindowSmsAt),
        ),
      );

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    for (const r of rows) {
      const phone = normalizePhone(r.phone);
      if (!phone) {
        skipped += 1;
        continue;
      }
      // Atomic claim: only one runner sets sms_at from NULL → now().
      const [claimed] = await this.db
        .update(orders)
        .set({ deliveryWindowSmsAt: new Date() })
        .where(
          and(
            eq(orders.id, r.id),
            eq(orders.tenantId, tenantId),
            isNull(orders.deliveryWindowSmsAt),
          ),
        )
        .returning({ id: orders.id });
      if (!claimed) {
        skipped += 1;
        continue;
      }
      const body = buildBody(r.orderNumber, hhmm(r.windowStart), hhmm(r.windowEnd));
      const res = await this.sms.sendSms(phone, body, {
        tenantId,
        orderId: r.id,
        kind: 'delivery_window',
      });
      if (res.status === 'sent') {
        sent += 1;
      } else {
        // Release the claim so a later run retries — no dup (send failed).
        await this.db
          .update(orders)
          .set({ deliveryWindowSmsAt: null })
          .where(and(eq(orders.id, r.id), eq(orders.tenantId, tenantId)));
        failed += 1;
      }
    }
    return { sent, skipped, failed, total: rows.length, date: day };
  }
}
```

> Note on `buildBody`: the `.replace('поръчка ,', 'поръчка,')` tidies the comma when `orderNumber` is null. Since real orders always have a number, the primary branch is `#<n>`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --workspace server -- sms-reminder.service`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/sms-reminder/sms-reminder.service.ts server/src/modules/sms-reminder/sms-reminder.service.spec.ts
git commit -m "feat(sms): reminder service — eligible tenants + idempotent per-tenant send loop"
```

---

## Task 7: Cron processor + module + manual-trigger controller

**Files:**
- Create: `server/src/modules/sms-reminder/sms-reminder.processor.ts`
- Create: `server/src/modules/sms-reminder/sms-reminder.controller.ts`
- Create: `server/src/modules/sms-reminder/sms-reminder.module.ts`
- Test: `server/src/modules/sms-reminder/sms-reminder.processor.spec.ts`

**Interfaces:**
- Consumes: `SmsReminderService`, `registerRepeatable`, `SMS_QUEUE`, `RUN_WORKERS`, `SmsModule`.
- Produces: `SmsReminderProcessor` (registers `'0 8 * * *'` Europe/Sofia; fan-out `sms-daily` → `sms-tenant`), `SmsReminderController` (`POST /sms-reminder/run`), `SmsReminderModule`.

- [ ] **Step 1: Write the failing processor test**

Create `server/src/modules/sms-reminder/sms-reminder.processor.spec.ts`:

```ts
import { SmsReminderProcessor } from './sms-reminder.processor';

describe('SmsReminderProcessor', () => {
  function makeQueue() {
    const added: any[] = [];
    return { added, add: jest.fn(async (name, data, opts) => { added.push({ name, data, opts }); }) };
  }

  it('registers the 08:00 Europe/Sofia repeatable on boot', async () => {
    const queue = makeQueue();
    const svc = { eligibleTenantIds: jest.fn(), sendForTenant: jest.fn() };
    const p = new SmsReminderProcessor(svc as any, queue as any);
    await p.onModuleInit();
    expect(queue.add).toHaveBeenCalledWith(
      'sms-daily', {},
      expect.objectContaining({ repeat: { pattern: '0 8 * * *', tz: 'Europe/Sofia' } }),
    );
  });

  it('fans out one sms-tenant job per eligible tenant', async () => {
    const queue = makeQueue();
    const svc = { eligibleTenantIds: jest.fn().mockResolvedValue(['a', 'b']), sendForTenant: jest.fn() };
    const p = new SmsReminderProcessor(svc as any, queue as any);
    await p.process({ name: 'sms-daily' } as any);
    expect(queue.add).toHaveBeenCalledWith('sms-tenant', { tenantId: 'a' });
    expect(queue.add).toHaveBeenCalledWith('sms-tenant', { tenantId: 'b' });
  });

  it('runs the per-tenant send for an sms-tenant job', async () => {
    const queue = makeQueue();
    const svc = { eligibleTenantIds: jest.fn(), sendForTenant: jest.fn().mockResolvedValue({ sent: 1 }) };
    const p = new SmsReminderProcessor(svc as any, queue as any);
    await p.process({ name: 'sms-tenant', data: { tenantId: 'a' } } as any);
    expect(svc.sendForTenant).toHaveBeenCalledWith('a');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace server -- sms-reminder.processor`
Expected: FAIL — cannot find `./sms-reminder.processor`.

- [ ] **Step 3: Implement the processor**

Create `server/src/modules/sms-reminder/sms-reminder.processor.ts`:

```ts
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { SmsReminderService } from './sms-reminder.service';
import { SMS_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(SMS_QUEUE)
export class SmsReminderProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(SmsReminderProcessor.name);

  constructor(
    private readonly reminder: SmsReminderService,
    @InjectQueue(SMS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  // 08:00 Europe/Sofia, once per worker boot (idempotent). Windows must be
  // approved by the operator the evening before for the send to have content.
  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'sms-daily', '0 8 * * *');
  }

  async process(job: Job): Promise<void> {
    if (job.name === 'sms-daily') {
      const ids = await this.reminder.eligibleTenantIds();
      for (const tenantId of ids) {
        await this.queue.add('sms-tenant', { tenantId });
      }
      this.logger.log(`[sms] fanned out ${ids.length} tenant reminder job(s)`);
      return;
    }
    if (job.name === 'sms-tenant') {
      const res = await this.reminder.sendForTenant((job.data as { tenantId: string }).tenantId);
      this.logger.log(
        `[sms] tenant ${(job.data as { tenantId: string }).tenantId}: ` +
          `sent=${res.sent} skipped=${res.skipped} failed=${res.failed}`,
      );
      return;
    }
    this.logger.warn(`[sms] unknown job name=${job.name}`);
  }
}
```

- [ ] **Step 4: Run the processor test to verify it passes**

Run: `npm test --workspace server -- sms-reminder.processor`
Expected: PASS.

- [ ] **Step 5: Write the manual-trigger controller**

Create `server/src/modules/sms-reminder/sms-reminder.controller.ts` (mirror `digest.controller.ts` auth guards — read it first to copy the exact operator/admin guard decorators):

```ts
import { Body, Controller, Post } from '@nestjs/common';
import { SmsReminderService } from './sms-reminder.service';
// TODO(worker): copy the exact guard imports/decorators from digest.controller.ts
// (same operator/super-admin protection). Do NOT leave this endpoint unguarded.

@Controller('sms-reminder')
export class SmsReminderController {
  constructor(private readonly reminder: SmsReminderService) {}

  /** Fire the day-of SMS send for one tenant now (testing / re-send). */
  @Post('run')
  async run(@Body() body: { tenantId: string; date?: string }) {
    return this.reminder.sendForTenant(body.tenantId, body.date);
  }
}
```

> Replace the TODO with the real guard(s) used by `digest.controller.ts` before committing. The endpoint must carry the same operator/super-admin protection as the digest test-trigger.

- [ ] **Step 6: Write the module**

Create `server/src/modules/sms-reminder/sms-reminder.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SmsReminderService } from './sms-reminder.service';
import { SmsReminderController } from './sms-reminder.controller';
import { SmsReminderProcessor } from './sms-reminder.processor';
import { SMS_QUEUE } from '../../common/queue/queue.constants';
import { SmsModule } from '../../common/sms/sms.module';
import { RUN_WORKERS } from '../../config/app-role';

@Module({
  imports: [
    SmsModule,
    BullModule.registerQueue({
      name: SMS_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    }),
  ],
  controllers: [SmsReminderController],
  providers: [SmsReminderService, ...(RUN_WORKERS ? [SmsReminderProcessor] : [])],
})
export class SmsReminderModule {}
```

- [ ] **Step 7: Wire into `AppModule`**

In `server/src/app.module.ts`, add `SmsReminderModule` to the `imports` array (alongside `DigestModule`). `SmsModule` is imported by `SmsReminderModule`, so no separate top-level import is required.

- [ ] **Step 8: Build the server**

Run: `npm run build --workspace server`
Expected: build succeeds.

- [ ] **Step 9: Commit**

```bash
git add server/src/modules/sms-reminder server/src/app.module.ts
git commit -m "feat(sms): 08:00 reminder cron, per-tenant fan-out, manual-trigger endpoint, module wiring"
```

---

## Task 8: Operator toggle (`SmsReminderCard`) in delivery settings

**Files:**
- Create: `client/src/components/settings/sms-reminder-card.tsx`
- Modify: `client/src/components/delivery/delivery-client.tsx` (mount the card)

**Interfaces:**
- Consumes: `getTenant()` (reads `sms.dayOfReminder`), `updateTenant({ sms: { dayOfReminder } })`, `ToggleSwitch`, `SaveBar` (mirror `nav-visibility-card.tsx`).

- [ ] **Step 1: Write the toggle card**

Create `client/src/components/settings/sms-reminder-card.tsx`:

```tsx
'use client';

/**
 * Settings → SMS напомняне в деня на доставка. When on, the platform SMSes each
 * own-delivery customer their approved time window on the morning of delivery
 * (server cron). Off by default — SMS costs money per message.
 */
import * as React from 'react';
import { MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { SaveBar } from '@/components/panels/panel-ui';
import { ApiError, getTenant, updateTenant } from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

export function SmsReminderCard() {
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [on, setOn] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    getTenant()
      .then((t) => {
        if (!active) return;
        const v = !!t.sms?.dayOfReminder;
        setSaved(v);
        setOn(v);
      })
      .catch(() => active && toast.error('Неуспешно зареждане на настройките'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const dirty = on !== saved;

  const save = async () => {
    setSaving(true);
    try {
      await updateTenant({ sms: { dayOfReminder: on } });
      setSaved(on);
      toast.success('Настройката е запазена');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;

  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-start gap-3">
        <MessageSquare className="mt-0.5 h-5 w-5 text-muted-foreground" />
        <div className="flex-1">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-medium">SMS напомняне в деня на доставка</div>
              <div className="text-sm text-muted-foreground">
                Клиентът получава SMS сутринта с часовия диапазон за доставка. Изисква
                одобрени часове предната вечер. SMS-ите се таксуват.
              </div>
            </div>
            <ToggleSwitch checked={on} onChange={setOn} />
          </div>
        </div>
      </div>
      {dirty && <SaveBar onSave={save} saving={saving} />}
    </div>
  );
}
```

> Verify the exact prop names for `ToggleSwitch` (`checked`/`onChange`) and `SaveBar` (`onSave`/`saving`) against their definitions before finalizing — read `client/src/components/ui/toggle-switch.tsx` and `client/src/components/panels/panel-ui.tsx` and adjust if the props differ.

- [ ] **Step 2: Mount the card in the delivery settings screen**

In `client/src/components/delivery/delivery-client.tsx`, import and render `<SmsReminderCard />` in the settings/notifications area of the screen (near the delivery-config sections). Import:

```tsx
import { SmsReminderCard } from '@/components/settings/sms-reminder-card';
```

- [ ] **Step 3: Typecheck the client**

Run: `npm run -w client typecheck` (or the client's tsc script)
Expected: succeeds.

- [ ] **Step 4: Verify in the browser**

Start the panel dev server (via the preview tool / `.claude/launch.json`), open Настройки → Доставка, confirm the toggle renders, flips, saves (toast), and persists on reload. Confirm the network `PATCH` carries `{ sms: { dayOfReminder: true } }`.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/settings/sms-reminder-card.tsx client/src/components/delivery/delivery-client.tsx
git commit -m "feat(sms): operator toggle for day-of SMS reminder"
```

---

## Task 9: Full integration verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole server test suite**

Run: `npm test --workspace server`
Expected: all pass (baseline green per project convention, plus the new specs).

- [ ] **Step 2: Build server + db + types + client**

Run: `npm run build --workspace @fermeribg/db && npm run build --workspace @fermeribg/types && npm run build --workspace server && npm run -w client typecheck`
Expected: all succeed.

- [ ] **Step 3: Migration dry-check**

Confirm `packages/db/drizzle/meta/_journal.json` has no `idx` gap (last two entries `idx: 101` then `idx: 102`) and `0104_sms_reminder.sql` exists. Optionally run the project's migrate script against a throwaway DB and verify `sms_log` + `orders.delivery_window_sms_at` are created.

- [ ] **Step 4: End-to-end log-only smoke (no gateway creds)**

With no `SMS_GATEWAY_URL`/`SMS_GATEWAY_TOKEN` set, seed a confirmed address order scheduled today with an approved window + a phone, then `POST /sms-reminder/run { tenantId }`. Confirm: a `[sms:log-only]` line logs the Cyrillic body, an `sms_log` row is written with `status='sent' provider='log-only'`, `orders.delivery_window_sms_at` is set, and a second `run` sends nothing (idempotent).

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "test(sms): integration verification fixups"
```

---

## Self-Review

**Spec coverage:**
- SmsService + swappable provider + log-only fallback → Tasks 2–4. ✅
- `sms_log` table + `delivery_window_sms_at` column → Task 1. ✅
- Per-tenant `settings.sms.dayOfReminder` (default off) + UI → Tasks 5, 8. ✅
- 08:00 Europe/Sofia cron + per-tenant fan-out + claim-before-send loop mirroring `notifyDeliveryWindows` → Tasks 6, 7. ✅
- Own-delivery (`address`) only, `status IN ('approved','sent')`, phone required → Task 6 query. ✅
- Cyrillic message, platform sender ID → Task 6 `buildBody` + Task 2 factory default. ✅
- Idempotency via dedicated column + release-on-failure → Task 6. ✅
- Manual trigger endpoint (guarded) → Task 7. ✅
- Migration discipline (no journal gap) → Task 1 + Task 9 check. ✅
- Web/worker split → Task 7 module (`RUN_WORKERS`). ✅

**Placeholder scan:** One intentional TODO in Task 7 Step 5 (copy the exact auth guard from `digest.controller.ts`) — flagged explicitly with "do not leave unguarded", not a silent gap. All code steps contain real code.

**Type consistency:** `SmsProvider.send` → `{ providerMessageId, segments }` consistent across providers, factory, service. `SmsSendResult.status` (`'sent'|'failed'`) consumed identically by `SmsReminderService`. `sendSms(phone, body, meta)` signature matches its call site in Task 6. `smsLog.$inferInsert` fields match the columns defined in Task 1. `settings.sms.dayOfReminder` boolean consistent across parse helper, DTO merge, public type, client type, UI.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-13-day-of-sms-delivery-window-reminder.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
