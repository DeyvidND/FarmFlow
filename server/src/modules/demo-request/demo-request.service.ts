import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../../common/email/email.service';
import { DemoRequestDto } from './dto/demo-request.dto';

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Marketing-site demo leads. Emails the operator inbox via the shared Resend
 * transport; no persistence (no leads table by design). Replaces the old
 * third-party FormSubmit relay, which some BG ISPs block as phishing — this
 * runs on the platform's own domain so it can't be filtered the same way.
 */
@Injectable()
export class DemoRequestService {
  private readonly logger = new Logger(DemoRequestService.name);

  constructor(
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  /** Silent-ok on honeypot so a scraper never learns which field is the trap. */
  async submit(dto: DemoRequestDto): Promise<{ ok: true }> {
    if (dto.honey && dto.honey.trim()) return { ok: true };

    const to =
      this.config.get<string>('DEMO_LEADS_EMAIL') ||
      this.config.get<string>('SUPER_ADMIN_EMAIL') ||
      'hello@fermeribg.com';

    const name = dto.name.trim();
    const rows: Array<[string, string | undefined]> = [
      ['Име', name],
      ['Ферма', dto.farm?.trim()],
      ['Имейл', dto.email.trim()],
      ['Телефон', dto.phone?.trim()],
      ['Съобщение', dto.message?.trim()],
    ];
    const html =
      `<h2>Нова заявка за демо</h2>` +
      `<table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif">` +
      rows
        .filter(([, v]) => v)
        .map(
          ([k, v]) =>
            `<tr><td style="font-weight:600;vertical-align:top">${k}</td>` +
            `<td>${escapeHtml(v as string)}</td></tr>`,
        )
        .join('') +
      `</table>`;

    await this.email.sendMail({
      to,
      subject: `Нова заявка за демо — ${name}`,
      html,
    });
    this.logger.log(`demo-request lead from ${dto.email.trim()} → ${to}`);
    return { ok: true };
  }
}
