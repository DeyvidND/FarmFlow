import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';

export interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private readonly from: string;
  private readonly previewDir: string;
  private readonly isDevMode: boolean;

  constructor(private readonly config: ConfigService) {
    this.from =
      config.get<string>('SMTP_FROM') ?? 'FarmFlow <no-reply@farmflow.bg>';
    this.previewDir =
      config.get<string>('MAIL_PREVIEW_DIR') ??
      path.join(process.cwd(), '.mail-preview');
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
        secure: false,
        auth: user ? { user, pass } : undefined,
      });
      this.logger.log(`Email: SMTP transport → ${host}:${port}`);
    } else {
      this.logger.log(`Email: dev-preview transport → ${this.previewDir}`);
    }
  }

  async sendMail(options: SendMailOptions): Promise<void> {
    if (!this.isDevMode && this.transporter) {
      // Real SMTP — let errors propagate so callers can handle them.
      await this.transporter.sendMail({
        from: this.from,
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
      const content = `<!-- to: ${options.to} | subject: ${options.subject} | date: ${now} -->\n${options.html}`;
      await fs.promises.writeFile(filePath, content, 'utf8');
      this.logger.log(
        `[email:preview] to=${options.to} subject="${options.subject}" file=${filePath}`,
      );
    } catch (err) {
      this.logger.error(
        `[email:preview] failed to write preview file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
