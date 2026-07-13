import { Logger } from '@nestjs/common';
import { SmsProvider, SmsProviderResult } from './sms.types';
import { smsSegments } from './sms-segments';

export interface HttpSmsConfig {
  url: string;
  token: string;
  senderId: string;
}

/**
 * Generic BG HTTP SMS gateway adapter (SMSAPI.bg / Mobica / iSMS-style). POSTs a
 * JSON body { from, to, message } with a Bearer token and expects a JSON reply
 * carrying a message id. Adjust the request/response mapping to the concrete
 * gateway once its account exists — the interface stays the same.
 */
export class HttpSmsProvider implements SmsProvider {
  readonly name = 'http';
  constructor(
    private readonly cfg: HttpSmsConfig,
    private readonly logger: Logger,
  ) {}

  async send(to: string, body: string): Promise<SmsProviderResult> {
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.token}`,
      },
      body: JSON.stringify({ from: this.cfg.senderId, to, message: body }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`sms gateway ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      messageId?: string;
      segments?: number;
    };
    return {
      providerMessageId: json.id ?? json.messageId ?? null,
      segments: json.segments ?? smsSegments(body),
    };
  }
}
