import {
  Controller,
  Post,
  Req,
  Query,
  HttpCode,
  ForbiddenException,
  Logger,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiTags, ApiExcludeEndpoint } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { SuppressionService } from './suppression.service';

/**
 * Amazon SES bounce/complaint receiver (via SNS HTTP subscription). SNS posts JSON
 * as `text/plain`, so we read the raw body (main.ts sets `rawBody: true`).
 *
 * Two message types: a one-time `SubscriptionConfirmation` (we GET the SubscribeURL
 * to confirm), and `Notification` events carrying SES bounce/complaint data — those
 * recipients go on the suppression list. Optionally guarded by `?secret=` matching
 * `EMAIL_WEBHOOK_SECRET`.
 */
@ApiTags('email')
@Controller('email')
export class EmailWebhookController {
  private readonly logger = new Logger(EmailWebhookController.name);

  constructor(
    private readonly suppression: SuppressionService,
    private readonly config: ConfigService,
  ) {}

  // Secret-guarded SNS receiver; SNS retries on non-2xx, so don't rate-limit it.
  @SkipThrottle()
  @Post('webhook')
  @ApiExcludeEndpoint()
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<Request>, @Query('secret') secret?: string): Promise<{ ok: true }> {
    const expected = this.config.get<string>('EMAIL_WEBHOOK_SECRET');
    if (expected && secret !== expected) {
      throw new ForbiddenException();
    }

    let msg: Record<string, any>;
    try {
      // SNS sends text/plain → the path text-parser puts the string on req.body;
      // fall back to rawBody / an already-parsed object just in case.
      const raw =
        typeof req.body === 'string'
          ? req.body
          : req.rawBody?.toString('utf8') ??
            (req.body && typeof req.body === 'object' ? JSON.stringify(req.body) : '{}');
      msg = JSON.parse(raw);
    } catch {
      this.logger.warn('[email:webhook] unparseable body');
      return { ok: true };
    }

    const type = msg.Type ?? req.headers['x-amz-sns-message-type'];

    if (type === 'SubscriptionConfirmation' && typeof msg.SubscribeURL === 'string') {
      // Confirm the SNS subscription by visiting the URL Amazon sent.
      try {
        await fetch(msg.SubscribeURL);
        this.logger.log('[email:webhook] SNS subscription confirmed');
      } catch (err) {
        this.logger.error(`[email:webhook] confirm failed: ${err instanceof Error ? err.message : err}`);
      }
      return { ok: true };
    }

    if (type === 'Notification') {
      let inner: Record<string, any> = {};
      try {
        inner = typeof msg.Message === 'string' ? JSON.parse(msg.Message) : (msg.Message ?? {});
      } catch {
        inner = {};
      }
      await this.handleSesEvent(inner);
    }

    return { ok: true };
  }

  /** Suppress recipients from an SES bounce (permanent only) or complaint event. */
  private async handleSesEvent(e: Record<string, any>): Promise<void> {
    const kind = e.notificationType ?? e.eventType; // raw SES vs config-set event

    if (kind === 'Bounce' && e.bounce) {
      // Only permanent (hard) bounces — transient ones may recover.
      if (e.bounce.bounceType === 'Permanent') {
        for (const r of e.bounce.bouncedRecipients ?? []) {
          if (r.emailAddress) await this.suppression.suppress(r.emailAddress, 'bounce', r.diagnosticCode);
        }
      }
    } else if (kind === 'Complaint' && e.complaint) {
      for (const r of e.complaint.complainedRecipients ?? []) {
        if (r.emailAddress) await this.suppression.suppress(r.emailAddress, 'complaint');
      }
    }
  }
}
