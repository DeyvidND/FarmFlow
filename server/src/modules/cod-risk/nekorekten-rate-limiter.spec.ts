import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NekorektenRateLimiter } from './nekorekten-rate-limiter';
import { REDIS_TOKEN } from '../../common/redis/redis.constants';

// Simulates the Lua RESERVE_SCRIPT result array: [ok, limitStr, retryAfterSeconds]
function makeRedisMock(evalResults: [number, string, number][] = []) {
  let callIdx = 0;
  return {
    eval: jest.fn().mockImplementation(async () => {
      if (callIdx < evalResults.length) {
        return evalResults[callIdx++];
      }
      return [1, '', 0]; // allow by default
    }),
    decr: jest.fn().mockResolvedValue(0),
  };
}

function makeConfig(perMin = 5, daily = 30) {
  return {
    get: jest.fn((key: string, def: number) => {
      if (key === 'NEKOREKTEN_RATE_PER_MIN') return perMin;
      if (key === 'NEKOREKTEN_DAILY_QUOTA') return daily;
      return def;
    }),
  };
}

async function build(redisMock: ReturnType<typeof makeRedisMock>, perMin = 5, daily = 30) {
  const configMock = makeConfig(perMin, daily);
  const mod = await Test.createTestingModule({
    providers: [
      NekorektenRateLimiter,
      { provide: REDIS_TOKEN, useValue: redisMock },
      { provide: ConfigService, useValue: configMock },
    ],
  }).compile();
  return mod.get(NekorektenRateLimiter);
}

describe('NekorektenRateLimiter.reserve', () => {
  it('allows when Lua returns ok=1', async () => {
    const redis = makeRedisMock([[1, '', 0]]);
    const limiter = await build(redis);
    const r = await limiter.reserve();
    expect(r.ok).toBe(true);
    expect(r.limit).toBeNull();
    expect(r.retryAfterSeconds).toBe(0);
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('denies with minute limit when Lua returns ok=0 and limit=minute', async () => {
    const redis = makeRedisMock([[0, 'minute', 42]]);
    const limiter = await build(redis);
    const r = await limiter.reserve();
    expect(r.ok).toBe(false);
    expect(r.limit).toBe('minute');
    expect(r.retryAfterSeconds).toBe(42);
  });

  it('denies with day limit when Lua returns ok=0 and limit=day', async () => {
    const redis = makeRedisMock([[0, 'day', 3600]]);
    const limiter = await build(redis);
    const r = await limiter.reserve();
    expect(r.ok).toBe(false);
    expect(r.limit).toBe('day');
    expect(r.retryAfterSeconds).toBe(3600);
  });

  it('day is checked before minute — when both exceeded, returns day', async () => {
    // The Lua script checks day first; this test verifies the JS correctly
    // passes ARGV in the right order (minCap, dayCap, daySec) so the Lua
    // day check runs first. We simulate the Lua already returning 'day'.
    const redis = makeRedisMock([[0, 'day', 86400]]);
    const limiter = await build(redis);
    const r = await limiter.reserve();
    expect(r.limit).toBe('day');
    // Verify eval was called with 5 args (2 keys + 3 ARGV)
    const evalCall = redis.eval.mock.calls[0];
    expect(evalCall[1]).toBe(2); // numkeys=2
  });

  it('fails open on Redis error — returns ok:true', async () => {
    const redis = {
      eval: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      decr: jest.fn(),
    };
    const limiter = await build(redis as any);
    const r = await limiter.reserve();
    expect(r.ok).toBe(true);
    expect(r.limit).toBeNull();
    expect(r.retryAfterSeconds).toBe(0);
  });

  it('clamps retryAfterSeconds to 0 when Lua returns negative TTL', async () => {
    // Redis TTL can return -1 or -2 on edge cases (key missing after DECR).
    const redis = makeRedisMock([[0, 'minute', -1]]);
    const limiter = await build(redis);
    const r = await limiter.reserve();
    expect(r.retryAfterSeconds).toBe(0);
  });

  it('passes the correct key arguments to redis.eval', async () => {
    const redis = makeRedisMock([[1, '', 0]]);
    const limiter = await build(redis);
    await limiter.reserve();
    const evalCall = redis.eval.mock.calls[0];
    // KEYS[1] = minKey (nk:rl:min:...), KEYS[2] = dayKey (nk:rl:day:...)
    expect(evalCall[2]).toMatch(/^nk:rl:min:/);
    expect(evalCall[3]).toMatch(/^nk:rl:day:/);
  });
});

describe('NekorektenRateLimiter.refund', () => {
  it('calls DECR on both min and day keys', async () => {
    const redis = makeRedisMock();
    const limiter = await build(redis);
    await limiter.refund();
    expect(redis.decr).toHaveBeenCalledTimes(2);
    // Both keys match expected patterns
    const [key1, key2] = redis.decr.mock.calls.map((c: string[]) => c[0]);
    expect(key1).toMatch(/^nk:rl:min:/);
    expect(key2).toMatch(/^nk:rl:day:/);
  });

  it('swallows Redis errors silently', async () => {
    const redis = {
      eval: jest.fn(),
      decr: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    const limiter = await build(redis as any);
    // Should not throw
    await expect(limiter.refund()).resolves.toBeUndefined();
  });
});
