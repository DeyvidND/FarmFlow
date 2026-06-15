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
