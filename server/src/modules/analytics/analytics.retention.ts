import { Injectable, Inject, Logger } from '@nestjs/common';
import { lt, sql } from 'drizzle-orm';
import { type Database, siteEvents } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

/** Raw events are only needed for the rolling analytics windows; keep 180 days
 *  and prune nightly so the table stays small (roughly a 1 GB/year ceiling,
 *  then bounded). Kept as a plain injectable (no queue import) so the delete
 *  logic is unit-testable without BullMQ scaffolding — see
 *  analytics-retention.processor.ts for the scheduling side. */
const RETENTION_DAYS = 180;

@Injectable()
export class AnalyticsRetention {
  private readonly log = new Logger(AnalyticsRetention.name);
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async prune(): Promise<void> {
    const cutoff = sql`now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`;
    await this.db.delete(siteEvents).where(lt(siteEvents.createdAt, cutoff as any));
    this.log.log(`Pruned site_events older than ${RETENTION_DAYS} days`);
  }
}
