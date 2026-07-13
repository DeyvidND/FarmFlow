import { Logger } from '@nestjs/common';
import { SmsProvider, SmsProviderResult } from './sms.types';
import { smsSegments } from './sms-segments';

export interface SmsApiConfig {
  /** SMSAPI send endpoint, e.g. https://api.smsapi.bg/sms.do */
  url: string;
  /** OAuth2 API token (sent as `Authorization: Bearer <token>`). */
  token: string;
  /**
   * Sender name. EMPTY = SMSAPI "ECO" send from a shared numeric (no sender-ID
   * registration, no company needed — works today). Set to a registered
   * alphanumeric ("ФермериБГ") once the A2P sender is approved to brand it —
   * that's an env change only, no code change.
   */
  senderId: string;
}

/** Hard cap on a single gateway request. Node's global fetch has NO default
 *  timeout, so without this a hung gateway would stall the tenant's send loop.
 *  On timeout the fetch rejects → SmsService records a failed row and releases
 *  the claim (retried next run). */
const SMSAPI_TIMEOUT_MS = 10_000;

/**
 * SMSAPI.bg adapter (https://www.smsapi.bg). POSTs form-encoded params to
 * `/sms.do` with a Bearer token and `format=json`, `encoding=utf-8` (Cyrillic).
 * Numeric/ECO by default (no `from`), brandable via `senderId` once registered.
 *
 * NOTE: request/response field names follow SMSAPI's documented `/sms.do` API;
 * verify against the live account on first real send and adjust here if their
 * API differs — the SmsProvider interface stays the same either way. Dormant in
 * prod until SMS_GATEWAY_URL + SMS_GATEWAY_TOKEN are set (factory falls back to
 * LogOnlySmsProvider otherwise).
 */
export class SmsApiProvider implements SmsProvider {
  readonly name = 'smsapi';
  constructor(
    private readonly cfg: SmsApiConfig,
    private readonly logger: Logger,
  ) {}

  async send(to: string, body: string): Promise<SmsProviderResult> {
    const params = new URLSearchParams();
    // SMSAPI wants the number in international form WITHOUT the leading '+'.
    params.set('to', to.replace(/^\+/, ''));
    params.set('message', body);
    params.set('format', 'json');
    params.set('encoding', 'utf-8'); // Cyrillic → UCS-2, SMSAPI counts parts
    // Omit `from` entirely for ECO/numeric (no registered sender). Only send a
    // sender name when one is configured AND approved.
    if (this.cfg.senderId) params.set('from', this.cfg.senderId);

    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Bearer ${this.cfg.token}`,
      },
      body: params.toString(),
      signal: AbortSignal.timeout(SMSAPI_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`smsapi http ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json().catch(() => ({}))) as {
      error?: number;
      message?: string;
      count?: number;
      list?: Array<{ id?: string; points?: number; parts?: number; status?: string }>;
    };
    // SMSAPI signals failures with a top-level `error` code + `message`.
    if (json.error) {
      throw new Error(`smsapi error ${json.error}: ${json.message ?? ''}`.trim());
    }
    const first = json.list?.[0];
    return {
      providerMessageId: first?.id ?? null,
      segments: first?.parts ?? smsSegments(body),
    };
  }
}
