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
import { verifyResendSignature } from './resend-signature';

/**
 * Resend bounce/complaint receiver (Svix-signed HTTP webhook).
 *
 * Resend POSTs events as JSON: { type: 'email.bounced' | 'email.complained' |
 * ..., data: { to: [...], ... } }, signed via Svix (svix-id / svix-timestamp /
 * svix-signature headers). main.ts captures the body as a raw string for this
 * path — the signature is verified over that exact string.
 *
 * The endpoint is public, so every message is verified against the Resend
 * webhook signing secret before it is acted on — forged bounce/complaint events
 * could suppress a victim's mail. Verification can be disabled with
 * `EMAIL_WEBHOOK_VERIFY=false` for local testing. An optional `?secret=` matching
 * `EMAIL_WEBHOOK_SECRET` adds a cheap first gate.
 *
 * Bounces and complaints go on the suppression list and are skipped on all
 * future sends. (Resend keeps its own server-side suppression too; this mirror
 * lets the app skip them before dialing SMTP.)
 */
@ApiTags('email')
@Controller('email')
export class EmailWebhookController {
  private readonly logger = new Logger(EmailWebhookController.name);

  constructor(
    private readonly suppression: SuppressionService,
    private readonly config: ConfigService,
  ) {}

  // Secret-guarded receiver; Resend/Svix retries on non-2xx, so don't rate-limit it.
  @SkipThrottle()
  @Post('webhook')
  @ApiExcludeEndpoint()
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<Request>, @Query('secret') secret?: string): Promise<{ ok: true }> {
    const expected = this.config.get<string>('EMAIL_WEBHOOK_SECRET');
    if (expected && secret !== expected) {
      throw new ForbiddenException();
    }

    // The path text-parser puts the raw JSON string on req.body; fall back to
    // rawBody / an already-parsed object just in case. The signature is verified
    // over this exact string, so keep `raw` for both verify and parse.
    const raw =
      typeof req.body === 'string'
        ? req.body
        : req.rawBody?.toString('utf8') ??
          (req.body && typeof req.body === 'object' ? JSON.stringify(req.body) : '{}');

    // Cryptographically verify the message actually came from Resend before
    // trusting any field. Off only when explicitly disabled (local testing).
    if (this.config.get<string>('EMAIL_WEBHOOK_VERIFY') !== 'false') {
      const signingSecret = this.config.get<string>('RESEND_WEBHOOK_SECRET') ?? '';
      const valid = verifyResendSignature(
        {
          id: req.headers['svix-id'],
          timestamp: req.headers['svix-timestamp'],
          signature: req.headers['svix-signature'],
        },
        raw,
        signingSecret,
        Math.floor(Date.now() / 1000),
      );
      if (!valid) {
        this.logger.warn('[email:webhook] rejected message with invalid Resend signature');
        throw new ForbiddenException();
      }
    }

    let msg: Record<string, any>;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.logger.warn('[email:webhook] unparseable body');
      return { ok: true };
    }

    await this.handleEvent(msg);
    return { ok: true };
  }

  /** Suppress recipients from a Resend bounce or complaint event. */
  private async handleEvent(msg: Record<string, any>): Promise<void> {
    const type = msg.type;
    const data = msg.data ?? {};
    // `to` is an array of recipients; tolerate a bare string too.
    const recipients: string[] = Array.isArray(data.to)
      ? data.to.filter((r: unknown): r is string => typeof r === 'string')
      : typeof data.to === 'string'
        ? [data.to]
        : [];
    if (recipients.length === 0) return;

    if (type === 'email.bounced') {
      const detail = data.bounce?.message ?? data.bounce?.subType ?? data.bounce?.type ?? undefined;
      await Promise.all(recipients.map((r) => this.suppression.suppress(r, 'bounce', detail)));
    } else if (type === 'email.complained') {
      await Promise.all(recipients.map((r) => this.suppression.suppress(r, 'complaint')));
    }
  }
}
