import { Inject, Injectable } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { REDIS_TOKEN } from '../redis/redis.constants';

/**
 * Atomic, distributed rate-limit counter backed by the app's existing Redis.
 *
 * Mirrors the semantics of `@nestjs/throttler`'s in-memory `ThrottlerStorageService`
 * but holds state in Redis so limits are shared across every API instance and
 * survive restarts (in-memory would reset on each deploy and be per-process).
 *
 * One EVAL per request keeps the read-increment-block decision atomic (no TOCTOU
 * race between concurrent requests sharing a key). Two keys per (throttler, client):
 *   throttle:{name}:{key}        — hit counter, expires after the window (ttl)
 *   throttle:block:{name}:{key}  — present only while the client is blocked
 *
 * Returns times in SECONDS to match the reference storage (the guard puts these
 * straight into the `Retry-After` / `RateLimit-Reset` headers).
 */
const INCREMENT_SCRIPT = `
local hitKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

-- Already blocked: do not count this hit, just report the remaining block time.
local blockTtl = redis.call('PTTL', blockKey)
if blockTtl > 0 then
  local hits = tonumber(redis.call('GET', hitKey))
  if not hits or hits <= limit then hits = limit + 1 end
  local hitTtl = redis.call('PTTL', hitKey)
  if hitTtl < 0 then hitTtl = blockTtl end
  return { hits, hitTtl, 1, blockTtl }
end

local hits = redis.call('INCR', hitKey)
if hits == 1 then
  redis.call('PEXPIRE', hitKey, ttl)
end
local hitTtl = redis.call('PTTL', hitKey)
if hitTtl < 0 then
  redis.call('PEXPIRE', hitKey, ttl)
  hitTtl = ttl
end

if hits > limit then
  local bd = blockDuration
  if bd <= 0 then bd = hitTtl end
  redis.call('SET', blockKey, '1', 'PX', bd)
  return { hits, hitTtl, 1, bd }
end

return { hits, hitTtl, 0, 0 }
`;

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(@Inject(REDIS_TOKEN) private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<{ totalHits: number; timeToExpire: number; isBlocked: boolean; timeToBlockExpire: number }> {
    const hitKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `throttle:block:${throttlerName}:${key}`;

    const [totalHits, ttlMs, isBlocked, blockMs] = (await this.redis.eval(
      INCREMENT_SCRIPT,
      2,
      hitKey,
      blockKey,
      ttl,
      limit,
      blockDuration,
    )) as [number, number, number, number];

    return {
      totalHits,
      timeToExpire: Math.ceil(ttlMs / 1000),
      isBlocked: isBlocked === 1,
      timeToBlockExpire: Math.ceil(blockMs / 1000),
    };
  }
}
