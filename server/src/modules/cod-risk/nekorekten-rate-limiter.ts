import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS_TOKEN } from '../../common/redis/redis.constants';

/**
 * Global, atomic rate-limiter for outbound Nekorekten API calls.
 *
 * Limits are per-API-key (platform-wide, shared across all tenants and all
 * web replicas). Two sliding windows:
 *   nk:rl:min:<SofiaYYYYMMDDHHmm>  — per-minute counter (expires in 60s)
 *   nk:rl:day:<SofiaYYYY-MM-DD>    — per-day counter   (expires at Sofia midnight)
 *
 * Sofia timezone is used for DST-correct day boundaries.
 *
 * On Redis error, reserve() FAILS OPEN (returns ok:true) so a Redis outage
 * never blocks risk checks — the Nekorekten key cap is the backstop.
 */

export interface ReserveResult {
  ok: boolean;
  limit: 'minute' | 'day' | null;
  retryAfterSeconds: number;
  /** The exact counter keys this reservation incremented (present on ok:true). Pass
   *  them to refund() so a call that straddles a minute boundary decrements the bucket
   *  it actually incremented, not whichever minute is current at refund time. */
  keys?: { minKey: string; dayKey: string };
}

/**
 * One atomic Lua script: INCR both counters, set TTL on first write,
 * then decide (day checked first so "exhausted daily quota" reports
 * "утре" not "след малко"). DECR both on deny to undo the INCR.
 */
const RESERVE_SCRIPT = `
local minKey  = KEYS[1]
local dayKey  = KEYS[2]
local minCap  = tonumber(ARGV[1])
local dayCap  = tonumber(ARGV[2])
local daySec  = tonumber(ARGV[3])

local m = redis.call('INCR', minKey)
if m == 1 then redis.call('EXPIRE', minKey, 60) end

local d = redis.call('INCR', dayKey)
if d == 1 then redis.call('EXPIRE', dayKey, daySec) end

if d > dayCap then
  redis.call('DECR', minKey)
  redis.call('DECR', dayKey)
  return {0, 'day', redis.call('TTL', dayKey)}
end

if m > minCap then
  redis.call('DECR', minKey)
  redis.call('DECR', dayKey)
  return {0, 'minute', redis.call('TTL', minKey)}
end

return {1, '', 0}
`;

/** Returns the current Sofia date/time components for building rate-limit keys. */
function sofiaBuckets(): { minKey: string; dayKey: string; daySec: number } {
  const now = new Date();

  // en-CA locale gives YYYY-MM-DD format natively.
  const dayPart = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now); // e.g. "2026-06-26"

  // Hour + minute parts for the per-minute key.
  const hourPart = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now); // e.g. "14:37"

  // Build YYYYMMDDHHmm (no separators) for the minute key.
  const dayCompact = dayPart.replace(/-/g, ''); // "20260626"
  const hourCompact = hourPart.replace(':', '');  // "1437"
  const minKey = `nk:rl:min:${dayCompact}${hourCompact}`;
  const dayKey = `nk:rl:day:${dayPart}`;

  // Seconds until next Sofia midnight (for EXPIRE on the day counter).
  // We compute Sofia midnight by parsing the next calendar day at 00:00 Sofia.
  const [year, month, day] = dayPart.split('-').map(Number);
  // Next midnight in Sofia: increment the day by 1.
  const nextMidnightSofia = new Date(
    Date.UTC(year, month - 1, day + 1, 0, 0, 0) -
      getTimezoneOffsetMs('Europe/Sofia', new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0))),
  );
  const daySec = Math.max(1, Math.ceil((nextMidnightSofia.getTime() - now.getTime()) / 1000));

  return { minKey, dayKey, daySec };
}

/**
 * Returns the timezone offset in milliseconds for the given timezone at the
 * given UTC instant. Uses Intl to handle DST correctly.
 */
function getTimezoneOffsetMs(tz: string, utcDate: Date): number {
  // Format the date as if it were local in the target timezone, then parse
  // back to UTC to find the offset.
  const localStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(utcDate);

  // localStr is like "2026-06-26, 03:00:00" (en-CA with time)
  // Parse it back as a UTC date and subtract from the actual UTC time.
  const normalized = localStr.replace(', ', 'T').replace(/(\d{2}):(\d{2}):(\d{2})$/, '$1:$2:$3');
  const localAsUtc = new Date(normalized + 'Z');
  return utcDate.getTime() - localAsUtc.getTime();
}

@Injectable()
export class NekorektenRateLimiter {
  private readonly logger = new Logger(NekorektenRateLimiter.name);
  private readonly minCap: number;
  private readonly dayCap: number;

  constructor(
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.minCap = config.get<number>('NEKOREKTEN_RATE_PER_MIN', 5);
    this.dayCap = config.get<number>('NEKOREKTEN_DAILY_QUOTA', 30);
  }

  /**
   * Reserve one Nekorekten API slot.
   *
   * Returns:
   *   { ok: true,  limit: null,       retryAfterSeconds: 0   } — allowed
   *   { ok: false, limit: 'minute'|'day', retryAfterSeconds: N } — denied
   *
   * On Redis error, FAILS OPEN (ok:true) so Redis outages don't block checks.
   */
  async reserve(): Promise<ReserveResult> {
    try {
      const { minKey, dayKey, daySec } = sofiaBuckets();
      const result = (await this.redis.eval(
        RESERVE_SCRIPT,
        2,
        minKey,
        dayKey,
        String(this.minCap),
        String(this.dayCap),
        String(daySec),
      )) as [number, string, number];

      const [ok, limitStr, retryAfterSeconds] = result;
      if (ok === 1) {
        return { ok: true, limit: null, retryAfterSeconds: 0, keys: { minKey, dayKey } };
      }
      return {
        ok: false,
        limit: limitStr as 'minute' | 'day',
        retryAfterSeconds: Math.max(0, retryAfterSeconds),
      };
    } catch (err) {
      this.logger.warn(`NekorektenRateLimiter.reserve Redis error (fail-open): ${err instanceof Error ? err.message : err}`);
      return { ok: true, limit: null, retryAfterSeconds: 0 };
    }
  }

  /**
   * Refund one slot — call when a reserved API call did NOT reach a real answer
   * (network error / timeout / 5xx) so quota isn't wasted on a non-answer.
   * Best-effort: errors are swallowed.
   */
  async refund(keys?: { minKey: string; dayKey: string }): Promise<void> {
    try {
      // Prefer the keys captured at reserve time; fall back to the current buckets for
      // back-compat. Using the reserved keys avoids leaking quota from the wrong minute
      // when the API call spanned a minute boundary.
      const { minKey, dayKey } = keys ?? sofiaBuckets();
      await Promise.all([
        this.redis.decr(minKey),
        this.redis.decr(dayKey),
      ]);
    } catch (err) {
      this.logger.warn(`NekorektenRateLimiter.refund error (ignored): ${err instanceof Error ? err.message : err}`);
    }
  }
}
