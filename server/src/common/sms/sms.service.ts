import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { type Database, smsLog } from '@fermeribg/db';
import { DB_TOKEN } from '../drizzle/drizzle.constants';
import { normalizePhone } from '../../modules/cod-risk/cod-risk.helpers';
import { SMS_PROVIDER } from './sms.constants';
import { SmsProvider, SmsSendMeta, SmsSendResult } from './sms.types';
import { smsSegments } from './sms-segments';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    @Inject(SMS_PROVIDER) private readonly provider: SmsProvider,
    // Optional logger param kept for tests; falls back to the class logger.
    // @Optional() so Nest DI won't try to resolve a bare Logger provider.
    @Optional() logger?: Logger,
  ) {
    if (logger) this.logger = logger;
  }

  /**
   * Normalize `phone` to E.164 BG, send `body`, and record the attempt in
   * sms_log. Never throws to the caller — a bad number or gateway error is
   * recorded and returned as { status: 'failed' } so a batch loop can decide
   * whether to release its claim and retry.
   */
  async sendSms(phone: string, body: string, meta: SmsSendMeta = {}): Promise<SmsSendResult> {
    const kind = meta.kind ?? 'delivery_window';
    const normalized = normalizePhone(phone);
    if (!normalized) {
      await this.write({
        tenantId: meta.tenantId ?? null,
        orderId: meta.orderId ?? null,
        phone: phone ?? '',
        body,
        segments: 0,
        provider: this.provider.name,
        providerMessageId: null,
        status: 'failed',
        error: 'invalid_phone',
        kind,
      });
      return { status: 'failed', providerMessageId: null, segments: 0 };
    }
    try {
      const { providerMessageId, segments } = await this.provider.send(normalized, body);
      await this.write({
        tenantId: meta.tenantId ?? null,
        orderId: meta.orderId ?? null,
        phone: normalized,
        body,
        segments,
        provider: this.provider.name,
        providerMessageId,
        status: 'sent',
        error: null,
        kind,
      });
      return { status: 'sent', providerMessageId, segments };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`sms send failed to ${normalized}: ${message}`);
      await this.write({
        tenantId: meta.tenantId ?? null,
        orderId: meta.orderId ?? null,
        phone: normalized,
        body,
        segments: smsSegments(body),
        provider: this.provider.name,
        providerMessageId: null,
        status: 'failed',
        error: message.slice(0, 500),
        kind,
      });
      return { status: 'failed', providerMessageId: null, segments: smsSegments(body) };
    }
  }

  private async write(row: typeof smsLog.$inferInsert): Promise<void> {
    try {
      await this.db.insert(smsLog).values(row);
    } catch (err) {
      // Logging the SMS must never fail the send path.
      this.logger.error(`sms_log insert failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
