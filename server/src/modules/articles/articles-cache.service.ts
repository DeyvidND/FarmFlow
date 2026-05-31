import { Injectable, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_TOKEN } from '../../common/redis/redis.constants';

/**
 * Redis cache for the public articles feed, keyed per tenant. Separate key space
 * from the product catalog (catalog:{tenantId}) so the two invalidate independently.
 */
@Injectable()
export class ArticlesCacheService {
  constructor(@Inject(REDIS_TOKEN) private readonly redis: Redis) {}

  private key(tenantId: string) {
    return `articles:${tenantId}`;
  }

  async get(tenantId: string): Promise<unknown> {
    const raw = await this.redis.get(this.key(tenantId));
    return raw ? (JSON.parse(raw) as unknown) : null;
  }

  async set(tenantId: string, data: unknown, ttl = 300): Promise<void> {
    await this.redis.set(this.key(tenantId), JSON.stringify(data), 'EX', ttl);
  }

  async invalidate(tenantId: string): Promise<void> {
    await this.redis.del(this.key(tenantId));
  }
}
