import { Injectable, Inject, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NekorektenCheck, parseReports } from './cod-risk.helpers';
import { NekorektenRateLimiter } from './nekorekten-rate-limiter';

const BASE = 'https://api.nekorekten.com/api/v1';

/**
 * Thin client for nekorekten.com (BG bad-COD-customer registry). One platform-wide
 * key from env `NEKOREKTEN_API_KEY` (+ server IP whitelisted in their dashboard).
 * Reads never throw (degrade to empty); a report throws a clear error if unconfigured
 * or the call fails, so the caller can keep the candidate for retry.
 *
 * Every outbound check goes through the global NekorektenRateLimiter first.
 * Quota is refunded when the call fails with a network / timeout / 5xx error
 * so only real answers consume quota.
 */
@Injectable()
export class NekorektenClient {
  private readonly logger = new Logger(NekorektenClient.name);
  private readonly apiKey: string;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    private readonly limiter: NekorektenRateLimiter,
  ) {
    this.apiKey = config.get<string>('NEKOREKTEN_API_KEY', '');
  }

  get configured(): boolean {
    return !!this.apiKey;
  }

  /** Check a phone against the registry. Never throws — degrades gracefully. */
  async checkPhone(phone: string): Promise<NekorektenCheck> {
    // 1. Unconfigured — no key.
    if (!this.apiKey) {
      return { configured: false, found: false, count: 0, reports: [], status: 'unconfigured' };
    }

    // 2. Reserve a rate-limit slot BEFORE fetching.
    const reservation = await this.limiter.reserve();
    if (!reservation.ok) {
      this.logger.warn(`nekorekten rate limit hit (${reservation.limit}), retryAfter=${reservation.retryAfterSeconds}s`);
      return {
        configured: true,
        found: false,
        count: 0,
        reports: [],
        status: 'rate_limited',
        retryAfterSeconds: reservation.retryAfterSeconds,
      };
    }

    // 3. Fetch.
    let res: Response;
    try {
      res = await fetch(
        `${BASE}/reports?phone=${encodeURIComponent(phone)}&searchMode=one-of`,
        {
          headers: { 'Api-Key': this.apiKey },
          signal: AbortSignal.timeout(8000),
        },
      );
    } catch (err) {
      // Network error / timeout — refund the reservation.
      this.logger.warn(`nekorekten check network error: ${err instanceof Error ? err.message : err}`);
      await this.limiter.refund(reservation.keys);
      return { configured: true, found: false, count: 0, reports: [], status: 'unavailable' };
    }

    // 4. Interpret the response.
    if (res.status === 429) {
      // We hit their actual rate-limit even though our counter said ok
      // (clock skew, multi-replica, etc.). Keep the reservation consumed.
      const retryHeader = res.headers.get('Retry-After');
      let retryAfterSeconds: number;
      if (retryHeader) {
        const parsed = parseInt(retryHeader, 10);
        retryAfterSeconds = Number.isFinite(parsed) ? parsed : 60;
      } else {
        // Default: seconds to the end of the current minute.
        retryAfterSeconds = 60 - (Math.floor(Date.now() / 1000) % 60);
      }
      this.logger.warn(`nekorekten HTTP 429, retryAfter=${retryAfterSeconds}s`);
      return {
        configured: true,
        found: false,
        count: 0,
        reports: [],
        status: 'rate_limited',
        retryAfterSeconds,
      };
    }

    if (!res.ok) {
      // 5xx / other non-ok — refund the reservation (non-answer).
      this.logger.warn(`nekorekten check HTTP ${res.status}`);
      await this.limiter.refund(reservation.keys);
      return { configured: true, found: false, count: 0, reports: [], status: 'unavailable' };
    }

    // 5. Success — parse and return with status ok/not_found.
    return parseReports(await res.json());
  }

  /** Report a bad payer. Throws on unconfigured / failure (caller keeps the candidate). */
  async reportPhone(input: { phone: string; text: string; name?: string }): Promise<{ ok: true }> {
    if (!this.apiKey) throw new BadRequestException('nekorekten не е конфигуриран');
    const body: Record<string, unknown> = { phone: input.phone, text: input.text };
    if (input.name) body.firstName = input.name;
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(`${BASE}/reports`, {
        method: 'POST',
        headers: { 'Api-Key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      throw new BadRequestException(`nekorekten недостъпен: ${err instanceof Error ? err.message : 'network'}`);
    }
    if (!res.ok) throw new BadRequestException(`nekorekten грешка (${res.status})`);
    return { ok: true };
  }
}
