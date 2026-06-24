import { Injectable, Inject, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NekorektenCheck, parseReports } from './cod-risk.helpers';

const BASE = 'https://api.nekorekten.com/api/v1';

/**
 * Thin client for nekorekten.com (BG bad-COD-customer registry). One platform-wide
 * key from env `NEKOREKTEN_API_KEY` (+ server IP whitelisted in their dashboard).
 * Reads never throw (degrade to empty); a report throws a clear error if unconfigured
 * or the call fails, so the caller can keep the candidate for retry.
 */
@Injectable()
export class NekorektenClient {
  private readonly logger = new Logger(NekorektenClient.name);
  private readonly apiKey: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.apiKey = config.get<string>('NEKOREKTEN_API_KEY', '');
  }

  get configured(): boolean {
    return !!this.apiKey;
  }

  /** Check a phone against the registry. Never throws — degrades to empty. */
  async checkPhone(phone: string): Promise<NekorektenCheck> {
    if (!this.apiKey) return { configured: false, found: false, count: 0, reports: [] };
    try {
      const res = await fetch(`${BASE}/reports?phone=${encodeURIComponent(phone)}&searchMode=one-of`, {
        headers: { 'Api-Key': this.apiKey },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        this.logger.warn(`nekorekten check ${res.status}`);
        return { configured: true, found: false, count: 0, reports: [] };
      }
      return parseReports(await res.json());
    } catch (err) {
      this.logger.warn(`nekorekten check failed: ${err instanceof Error ? err.message : err}`);
      return { configured: true, found: false, count: 0, reports: [] };
    }
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
