import { Injectable, Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, gte, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { type Database, errorEvents, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { REDIS_TOKEN } from '../../common/redis/redis.constants';
import {
  EMAIL_QUEUE,
  OPERATOR_DIGEST_QUEUE,
  ECONT_QUEUE,
  SPEEDY_QUEUE,
  NEWSLETTER_DRAFT_QUEUE,
  IMAGE_QUEUE,
  BILLING_QUEUE,
  ANALYTICS_QUEUE,
  CLEANUP_QUEUE,
} from '../../common/queue/queue.constants';

export type ServiceStatus = 'up' | 'down';

export interface QueueHealth {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  status: 'ok' | 'backlog' | 'error';
}

/** Live platform technical pulse for the super-admin «Здраве» screen.
 *  Response shape is FIXED — the admin UI depends on it exactly as-is. */
export interface HealthBoard {
  generatedAt: string;
  services: { db: ServiceStatus; redis: ServiceStatus };
  queues: QueueHealth[];
  errors: {
    last24h: number;
    topPaths: { path: string; count: number }[];
    topTenants: { tenantId: string | null; tenantName: string | null; count: number }[];
  };
  notes?: string[];
}

// A queue is flagged 'backlog' once waiting+delayed crosses this — not an outage,
// just "a human should look at this soon". Tuned for this platform's scale; revisit
// if a legitimately bursty queue (e.g. a bulk import) trips it under normal use.
const QUEUE_BACKLOG_THRESHOLD = 100;
const ERROR_WINDOW_HOURS = 24;

/**
 * Live system health for the super-admin «Здраве» board: DB/Redis reachability,
 * BullMQ queue depths, and the 24h error-rate summary from `error_events`. Every
 * probe is independently guarded — a single dead dependency (a queue's Redis call,
 * the DB) degrades its own slice of the payload instead of 500ing the whole board.
 *
 * Queue coverage: the operationally important queues (email, operator-digest,
 * econt, speedy, newsletter-draft, image, billing, analytics) plus `cleanup`
 * (already registered in this module for DemoCleanupProcessor, so free to add).
 * `digest`, `slots` and `products` are omitted to avoid growing this module's
 * wiring for completeness — noted in the response so the omission is visible,
 * not silent.
 */
@Injectable()
export class HealthBoardService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    @InjectQueue(EMAIL_QUEUE) private readonly emailQueue: Queue,
    @InjectQueue(OPERATOR_DIGEST_QUEUE) private readonly operatorDigestQueue: Queue,
    @InjectQueue(ECONT_QUEUE) private readonly econtQueue: Queue,
    @InjectQueue(SPEEDY_QUEUE) private readonly speedyQueue: Queue,
    @InjectQueue(NEWSLETTER_DRAFT_QUEUE) private readonly newsletterDraftQueue: Queue,
    @InjectQueue(IMAGE_QUEUE) private readonly imageQueue: Queue,
    @InjectQueue(BILLING_QUEUE) private readonly billingQueue: Queue,
    @InjectQueue(ANALYTICS_QUEUE) private readonly analyticsQueue: Queue,
    @InjectQueue(CLEANUP_QUEUE) private readonly cleanupQueue: Queue,
  ) {}

  async healthBoard(): Promise<HealthBoard> {
    const notes: string[] = [
      'Опашките "digest", "slots" и "products" не са включени в таблото (wiring само за важните опашки).',
    ];

    const queueDefs: { name: string; queue: Queue }[] = [
      { name: EMAIL_QUEUE, queue: this.emailQueue },
      { name: OPERATOR_DIGEST_QUEUE, queue: this.operatorDigestQueue },
      { name: ECONT_QUEUE, queue: this.econtQueue },
      { name: SPEEDY_QUEUE, queue: this.speedyQueue },
      { name: NEWSLETTER_DRAFT_QUEUE, queue: this.newsletterDraftQueue },
      { name: IMAGE_QUEUE, queue: this.imageQueue },
      { name: BILLING_QUEUE, queue: this.billingQueue },
      { name: ANALYTICS_QUEUE, queue: this.analyticsQueue },
      { name: CLEANUP_QUEUE, queue: this.cleanupQueue },
    ];

    const [db, redis, queues, errors] = await Promise.all([
      this.dbStatus(),
      this.redisStatus(),
      Promise.all(queueDefs.map((q) => this.queueHealth(q.name, q.queue))),
      this.errorStats(notes),
    ]);

    for (const q of queues) {
      if (q.status === 'error') notes.push(`Опашка "${q.name}" не отговори при четене на брояча заявки.`);
    }

    return {
      generatedAt: new Date().toISOString(),
      services: { db, redis },
      queues,
      errors,
      notes: notes.length ? notes : undefined,
    };
  }

  /** Mirrors `HealthService.ready()`'s DB probe — trivial query, never throws out. */
  private async dbStatus(): Promise<ServiceStatus> {
    try {
      await this.db.execute(sql`select 1`);
      return 'up';
    } catch {
      return 'down';
    }
  }

  /** Mirrors `HealthService.ready()`'s Redis probe. */
  private async redisStatus(): Promise<ServiceStatus> {
    try {
      await this.redis.ping();
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async queueHealth(name: string, queue: Queue): Promise<QueueHealth> {
    try {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      const waiting = counts.waiting ?? 0;
      const active = counts.active ?? 0;
      const delayed = counts.delayed ?? 0;
      const failed = counts.failed ?? 0;
      const status: QueueHealth['status'] =
        waiting + delayed > QUEUE_BACKLOG_THRESHOLD || failed > 0 ? 'backlog' : 'ok';
      return { name, waiting, active, delayed, failed, status };
    } catch {
      return { name, waiting: 0, active: 0, delayed: 0, failed: 0, status: 'error' };
    }
  }

  /** 24h error-rate summary from `error_events`: total + top-5 paths + top-5 tenants
   *  (null tenant/tenantName grouped together for platform-level/unauthenticated
   *  errors). Guarded as a whole — if the table/query fails, degrade to zeros with
   *  a note rather than failing the entire health board. */
  private async errorStats(notes: string[]): Promise<HealthBoard['errors']> {
    const since = new Date(Date.now() - ERROR_WINDOW_HOURS * 60 * 60 * 1000);
    try {
      const [[totalRow], topPaths, topTenantsRaw] = await Promise.all([
        this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(errorEvents)
          .where(gte(errorEvents.createdAt, since)),
        this.db
          .select({ path: errorEvents.path, count: sql<number>`count(*)::int` })
          .from(errorEvents)
          .where(gte(errorEvents.createdAt, since))
          .groupBy(errorEvents.path)
          .orderBy(sql`count(*) desc`)
          .limit(5),
        this.db
          .select({
            tenantId: errorEvents.tenantId,
            tenantName: tenants.name,
            count: sql<number>`count(*)::int`,
          })
          .from(errorEvents)
          .leftJoin(tenants, eq(errorEvents.tenantId, tenants.id))
          .where(gte(errorEvents.createdAt, since))
          .groupBy(errorEvents.tenantId, tenants.name)
          .orderBy(sql`count(*) desc`)
          .limit(5),
      ]);

      return {
        last24h: totalRow?.count ?? 0,
        topPaths,
        topTenants: topTenantsRaw.map((r) => ({
          tenantId: r.tenantId,
          tenantName: r.tenantName ?? null,
          count: r.count,
        })),
      };
    } catch {
      notes.push('Грешките (error_events) не можаха да бъдат прочетени за последните 24ч.');
      return { last24h: 0, topPaths: [], topTenants: [] };
    }
  }
}
