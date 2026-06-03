import { Injectable, Inject, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Database, newsletterSubscribers } from '@farmflow/db';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EmailService } from '../../common/email/email.service';
import { BroadcastDto } from './dto/broadcast.dto';

export interface SubscribersResult {
  subscribers: { id: string; email: string; createdAt: Date | null }[];
  activeCount: number;
  unsubscribedCount: number;
}

export interface UnsubscribeResult {
  success: boolean;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nl2br(s: string): string {
  return escapeHtml(s).replace(/\n/g, '<br>');
}

@Injectable()
export class NewsletterService {
  private readonly logger = new Logger(NewsletterService.name);
  /** Origin of the API that serves the unsubscribe page (GET /unsubscribe). */
  private readonly apiBaseUrl: string;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly email: EmailService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    this.apiBaseUrl =
      config.get<string>('API_PUBLIC_URL') ?? 'http://localhost:3001';
  }

  async getSubscribers(tenantId: string): Promise<SubscribersResult> {
    const rows = await this.db
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.tenantId, tenantId))
      .orderBy(newsletterSubscribers.createdAt);

    const activeCount = rows.filter((r) => r.unsubscribedAt == null).length;
    const unsubscribedCount = rows.length - activeCount;

    return {
      subscribers: rows.map((r) => ({
        id: r.id,
        email: r.email,
        createdAt: r.createdAt,
      })),
      activeCount,
      unsubscribedCount,
    };
  }

  async broadcast(tenantId: string, dto: BroadcastDto): Promise<{ sent: number }> {
    const rows = await this.db
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.tenantId, tenantId))
      .orderBy(newsletterSubscribers.createdAt);

    const active = rows.filter((r) => r.unsubscribedAt == null);
    let sent = 0;

    for (const subscriber of active) {
      try {
        const token = this.jwt.sign(
          { sub: subscriber.id, typ: 'unsub' },
          { expiresIn: '3650d' },
        );
        const unsubscribeUrl = `${this.apiBaseUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
        const html = this.renderBroadcastHtml(dto.subject, dto.body, unsubscribeUrl);
        const text = `${dto.body}\n\n---\nОтпишете се: ${unsubscribeUrl}`;

        await this.email.sendMail({
          to: subscriber.email,
          subject: dto.subject,
          html,
          text,
        });
        sent++;
      } catch (err) {
        this.logger.error(
          `[newsletter] Failed to send to subscriber=${subscriber.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { sent };
  }

  async unsubscribe(token: string): Promise<UnsubscribeResult> {
    let payload: { sub?: string; typ?: string };
    try {
      payload = this.jwt.verify(token) as { sub?: string; typ?: string };
    } catch {
      return { success: false };
    }

    if (payload.typ !== 'unsub' || !payload.sub) {
      return { success: false };
    }

    const [subscriber] = await this.db
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.id, payload.sub))
      .limit(1);

    if (!subscriber) {
      return { success: false };
    }

    if (subscriber.unsubscribedAt != null) {
      // Already unsubscribed — idempotent success
      return { success: true };
    }

    await this.db
      .update(newsletterSubscribers)
      .set({ unsubscribedAt: new Date() })
      .where(eq(newsletterSubscribers.id, subscriber.id))
      .returning();

    return { success: true };
  }

  private renderBroadcastHtml(subject: string, body: string, unsubscribeUrl: string): string {
    return `<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <div style="border-bottom:2px solid #2d6a4f;padding-bottom:12px;margin-bottom:20px">
    <h1 style="font-size:20px;color:#2d6a4f;margin:0">${escapeHtml(subject)}</h1>
  </div>
  <div style="font-size:15px;line-height:1.6">${nl2br(body)}</div>
  <div style="margin-top:40px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#999">
    <p>Получавате този имейл, защото сте се абонирали за новини от фермата.</p>
    <p><a href="${unsubscribeUrl}" style="color:#999">Отпишете се от абонамента</a></p>
  </div>
</body>
</html>`;
  }
}
