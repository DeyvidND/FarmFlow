import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as nodemailer from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';
import { SuppressionService } from './suppression.service';
import { EMAIL_QUEUE } from '../queue/queue.constants';

/** Which reputation lane the mail rides. Transactional (resets, digests) is kept
 *  separate from bulk (newsletters) so a marketing reputation hit never kills
 *  critical mail like password resets. */
export type EmailStream = 'transactional' | 'bulk';

/**
 * Crude HTML → plain text for the multipart `text/plain` alternative. Its job is
 * deliverability, not fidelity: HTML-only mail scores worse with spam filters, so
 * every message gets a text part. Not exported for rendering — only as a fallback.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#3?9;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /**
   * Reply-To header. Falls back to the `EMAIL_REPLY_TO` env. A monitored, replyable
   * address (vs the `no-reply` From) reads as legitimate to spam filters and lets
   * recipients actually reply.
   */
  replyTo?: string;
  /** Extra SMTP headers — e.g. `List-Unsubscribe` / `List-Unsubscribe-Post` for bulk. */
  headers?: Record<string, string>;
  /** Defaults to 'transactional'. */
  stream?: EmailStream;
  /**
   * Skip the per-recipient suppression DB lookup. Set ONLY when the caller has
   * already batch-filtered the recipient list against the suppression list (e.g.
   * NewsletterService.sendCampaign) — avoids one SELECT per recipient on a large send.
   * Transactional callers must leave this false so a suppressed address is honored.
   */
  skipSuppressionCheck?: boolean;
}

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private readonly fallbackFrom: string;
  private readonly txFrom: string;
  private readonly bulkFrom: string;
  private readonly previewDir: string;
  private readonly isDevMode: boolean;
  private readonly defaultReplyTo: string | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly suppression: SuppressionService,
    @InjectQueue(EMAIL_QUEUE) private readonly queue: Queue,
  ) {
    // `||` (not `??`) so a present-but-empty env var falls back to the default.
    // An empty `EMAIL_TRANSACTIONAL_FROM` would otherwise yield an empty From
    // header, which SES and most SMTP servers reject.
    this.fallbackFrom = config.get<string>('SMTP_FROM') || 'ФермериБГ <no-reply@fermeribg.com>';
    this.txFrom = config.get<string>('EMAIL_TRANSACTIONAL_FROM') || this.fallbackFrom;
    this.bulkFrom = config.get<string>('EMAIL_BULK_FROM') || this.txFrom;
    this.previewDir =
      config.get<string>('MAIL_PREVIEW_DIR') ?? path.join(process.cwd(), '.mail-preview');
    this.isDevMode = !config.get<string>('SMTP_HOST');
    // A monitored reply address (Email Routing forwards it) beats a bare no-reply
    // From for deliverability. Per-call `replyTo` overrides this.
    this.defaultReplyTo = config.get<string>('EMAIL_REPLY_TO') || undefined;
  }

  onModuleInit(): void {
    const host = this.config.get<string>('SMTP_HOST');
    if (host) {
      const port = this.config.get<number>('SMTP_PORT') ?? 587;
      const user = this.config.get<string>('SMTP_USER');
      const pass = this.config.get<string>('SMTP_PASS');
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: user ? { user, pass } : undefined,
        // Reuse a small pool of SMTP connections instead of a fresh TLS+AUTH
        // handshake per message. Newsletter broadcasts and the per-farmer daily
        // digest loop send many in a burst; pooling cuts the cron's wall-clock.
        pool: true,
        maxConnections: 3,
        maxMessages: 100,
        // Fail fast instead of nodemailer's 2-minute default. A pooled socket can
        // go stale (Resend / firewall drops idle TCP between bursts); without these
        // a reused dead connection hangs the worker slot for 2 min before the queue
        // can retry. 10s connect/greeting, 20s socket → BullMQ retries quickly and
        // the pool reopens a fresh connection on the next attempt.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
      this.logger.log(`Email: SMTP transport → ${host}:${port}`);
    } else {
      this.logger.log(`Email: dev-preview transport → ${this.previewDir}`);
    }
  }

  /** Resolve the from-address for a stream. */
  private streamFrom(stream: EmailStream): string {
    return stream === 'bulk' ? this.bulkFrom : this.txFrom;
  }

  /**
   * Enqueue an email for asynchronous, retried delivery by the email worker.
   * Returns once the job is queued — the actual send (and suppression check) runs
   * in `deliver()` on a worker. At-least-once: a worker crash mid-job can re-send;
   * tolerated for transactional mail (low harm).
   */
  async sendMail(options: SendMailOptions): Promise<void> {
    await this.queue.add('send', options);
  }

  /** Actually send (called by EmailProcessor). Honors suppression at send time. */
  async deliver(options: SendMailOptions): Promise<void> {
    const stream: EmailStream = options.stream ?? 'transactional';

    if (!options.skipSuppressionCheck && (await this.suppression.isSuppressed(options.to))) {
      this.logger.warn(`[email] skipped suppressed recipient to=${options.to}`);
      return;
    }

    const from = this.streamFrom(stream);
    // Every message ships a text/plain alternative (auto-derived from the HTML when
    // a caller didn't supply one) — HTML-only mail scores worse with spam filters.
    const text = options.text ?? htmlToText(options.html);
    const replyTo = options.replyTo ?? this.defaultReplyTo;

    if (!this.isDevMode && this.transporter) {
      await this.transporter.sendMail({
        from,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text,
        ...(replyTo ? { replyTo } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
      });
      return;
    }

    await this.writePreview(options, from, stream);
  }

  private async writePreview(options: SendMailOptions, from: string, stream: EmailStream): Promise<void> {
    try {
      await fs.promises.mkdir(this.previewDir, { recursive: true });
      const sanitizedTo = options.to.replace(/[^a-zA-Z0-9@._-]/g, '_');
      const filename = `${Date.now()}-${sanitizedTo}.html`;
      const filePath = path.join(this.previewDir, filename);
      const now = new Date().toISOString();
      const content = `<!-- to: ${options.to} | from: ${from} | stream: ${stream} | subject: ${options.subject} | date: ${now} -->\n${options.html}`;
      await fs.promises.writeFile(filePath, content, 'utf8');
      this.logger.log(
        `[email:preview] stream=${stream} to=${options.to} subject="${options.subject}" file=${filePath}`,
      );
    } catch (err) {
      this.logger.error(
        `[email:preview] failed to write preview file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
