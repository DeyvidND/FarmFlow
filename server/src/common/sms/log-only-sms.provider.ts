import { Logger } from '@nestjs/common';
import { SmsProvider, SmsProviderResult } from './sms.types';
import { smsSegments } from './sms-segments';

/**
 * No-op provider used when no gateway creds are configured. Logs the message
 * instead of sending, so dev/staging (and a misconfigured prod) never spends
 * money or messages a real customer. The whole pipeline is still exercised.
 */
export class LogOnlySmsProvider implements SmsProvider {
  readonly name = 'log-only';
  constructor(private readonly logger: Logger) {}

  async send(to: string, body: string): Promise<SmsProviderResult> {
    this.logger.log(`[sms:log-only] → ${to}: ${body}`);
    return { providerMessageId: null, segments: smsSegments(body) };
  }
}
