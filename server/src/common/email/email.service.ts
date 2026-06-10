import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';
import { SuppressionService } from './suppression.service';

/** Which reputation lane the mail rides. Transactional (resets, digests) is kept
 *  separate from bulk (newsletters) so a marketing reputation hit never kills
 *  critical mail like password resets. */
export type EmailStream = 'transactional' | 'bulk';

export interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Defaults to 'transactional'. */
  stream?: EmailStream;
  /**
   * Skip the per-recipient suppression DB lookup. Set ONLY when the caller has
   * already batch-filtered the recipient list against the suppression list (e.g.
   * NewsletterService.broadcast) — avoids one SELECT per recipient on a large send.
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

  constructor(
    private readonly config: ConfigService,
    private readonly suppression: SuppressionService,
  ) {
    // `||` (not `??`) so a present-but-empty env var falls back to the default.
    // An empty `EMAIL_TRANSACTIONAL_FROM` would otherwise yield an empty From
    // header, which SES and most SMTP servers reject.
    this.fallbackFrom = config.get<string>('SMTP_FROM') || 'FarmFlow <no-reply@farmsteadflow.com>';
    this.txFrom = config.get<string>('EMAIL_TRANSACTIONAL_FROM') || this.fallbackFrom;
    this.bulkFrom = config.get<string>('EMAIL_BULK_FROM') || this.txFrom;
    this.previewDir =
      config.get<string>('MAIL_PREVIEW_DIR') ?? path.join(process.cwd(), '.mail-preview');
    this.isDevMode = !config.get<string>('SMTP_HOST');
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

  async sendMail(options: SendMailOptions): Promise<void> {
    const stream: EmailStream = options.stream ?? 'transactional';

    // Never mail a hard-bounced / complained address again. Skipped when the
    // caller already batch-filtered against the suppression list (bulk broadcast).
    if (!options.skipSuppressionCheck && (await this.suppression.isSuppressed(options.to))) {
      this.logger.warn(`[email] skipped suppressed recipient to=${options.to}`);
      return;
    }

    // Reputation lanes (transactional resets/digests vs bulk newsletters) are
    // kept apart by from-address; if a hard split is ever needed, point the bulk
    // lane at a separate Resend sending domain.
    const from = this.streamFrom(stream);

    if (!this.isDevMode && this.transporter) {
      // Real SMTP — let errors propagate so callers can handle them.
      await this.transporter.sendMail({
        from,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      });
      return;
    }

    // Dev preview transport — write to file, never throw.
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
