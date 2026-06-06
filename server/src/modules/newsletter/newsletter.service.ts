import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { type Database, newsletterSubscribers, emailPushes } from '@farmflow/db';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EmailService } from '../../common/email/email.service';
import { SuppressionService } from '../../common/email/suppression.service';
import { BillingService } from '../billing/billing.service';
import { BroadcastDto } from './dto/broadcast.dto';
import { clampLimit, keysetAfter, buildPage } from '../../common/pagination/keyset';
import { decodeCursor } from '../../common/pagination/cursor';

export interface SubscribersResult {
  items: { id: string; email: string; createdAt: Date | null }[];
  nextCursor: string | null;
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
    private readonly suppression: SuppressionService,
    private readonly billing: BillingService,
  ) {
    this.apiBaseUrl =
      config.get<string>('API_PUBLIC_URL') ?? 'http://localhost:3001';
  }

  async getSubscribers(
    tenantId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<SubscribersResult> {
    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    const conds = [eq(newsletterSubscribers.tenantId, tenantId)];
    if (cur) conds.push(keysetAfter(newsletterSubscribers.createdAt, newsletterSubscribers.id, cur, 'asc'));

    const rows = await this.db
      .select({
        id: newsletterSubscribers.id,
        email: newsletterSubscribers.email,
        createdAt: newsletterSubscribers.createdAt,
      })
      .from(newsletterSubscribers)
      .where(and(...conds))
      .orderBy(asc(newsletterSubscribers.createdAt), asc(newsletterSubscribers.id))
      .limit(lim + 1);

    const page = buildPage(rows, lim, (r) => ({ createdAt: r.createdAt!, id: r.id }));

    // Headline counts cover ALL rows (not just the page), so they come from SQL.
    // Computed once on the first page; cursored pages reuse the client's copy.
    // `.limit(1)` is a harmless no-op on a single-row aggregate (keeps the unit mock simple).
    let activeCount = 0;
    let unsubscribedCount = 0;
    if (!cur) {
      const [c] = await this.db
        .select({
          active: sql<number>`count(*) filter (where ${newsletterSubscribers.unsubscribedAt} is null)::int`,
          unsub: sql<number>`count(*) filter (where ${newsletterSubscribers.unsubscribedAt} is not null)::int`,
        })
        .from(newsletterSubscribers)
        .where(eq(newsletterSubscribers.tenantId, tenantId))
        .limit(1);
      activeCount = c?.active ?? 0;
      unsubscribedCount = c?.unsub ?? 0;
    }

    return { items: page.items, nextCursor: page.nextCursor, activeCount, unsubscribedCount };
  }

  async broadcast(
    tenantId: string,
    dto: BroadcastDto,
  ): Promise<{ sent: number; recipients: number }> {
    // Billability gate: a push costs €2, billed as a Stripe invoice item that
    // needs a customer to land on. Without one (non-premium farm that never set
    // up billing) the send would go out unbilled, so refuse it up front rather
    // than email first and silently fail to charge.
    if (!(await this.billing.isBillable(tenantId))) {
      throw new BadRequestException(
        'Настройте плащане (абонамент) преди да изпращате бюлетини.',
      );
    }

    // Guard the flat per-push price: a huge list on a flat fee loses money and
    // strains the shared domain. Reject over the cap rather than silently truncate.
    const maxRecipients = this.config.get<number>('EMAIL_PUSH_MAX_RECIPIENTS') ?? 5000;

    // Filter unsubscribed in SQL (index-backed) and pull only the columns the
    // send needs. Cap the fetch at maxRecipients+1 so an oversized list never
    // loads the whole table into memory — the +1 row is enough to detect "over cap".
    const active = await this.db
      .select({ id: newsletterSubscribers.id, email: newsletterSubscribers.email })
      .from(newsletterSubscribers)
      .where(
        and(
          eq(newsletterSubscribers.tenantId, tenantId),
          isNull(newsletterSubscribers.unsubscribedAt),
        ),
      )
      .orderBy(newsletterSubscribers.createdAt)
      .limit(maxRecipients + 1);

    if (active.length > maxRecipients) {
      throw new BadRequestException(
        `Списъкът е твърде голям за едно изпращане (${active.length} получателя, лимит ${maxRecipients}). Раздели изпращането.`,
      );
    }

    // Drop suppressed addresses (hard bounces / complaints) to protect the domain.
    const suppressed = await this.suppression.filterSuppressed(active.map((a) => a.email));
    const recipients = active.filter((a) => !suppressed.has(a.email.trim().toLowerCase()));

    let sent = 0;
    for (const subscriber of recipients) {
      try {
        const token = this.jwt.sign(
          { sub: subscriber.id, typ: 'unsub' },
          { secret: this.unsubSecret(), expiresIn: '3650d' },
        );
        const unsubscribeUrl = `${this.apiBaseUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
        const html = this.renderBroadcastHtml(dto.subject, dto.body, unsubscribeUrl);
        const text = `${dto.body}\n\n---\nОтпишете се: ${unsubscribeUrl}`;

        await this.email.sendMail({
          to: subscriber.email,
          subject: dto.subject,
          html,
          text,
          stream: 'bulk', // newsletters ride the bulk reputation lane
        });
        sent++;
      } catch (err) {
        this.logger.error(
          `[newsletter] Failed to send to subscriber=${subscriber.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Usage ledger: one row per push, valued at the per-push price, then billed
    // to the farm's Stripe subscription as a €2 invoice item (premium → free).
    const priceStotinki = this.config.get<number>('EMAIL_PUSH_PRICE_STOTINKI') ?? 200;
    if (recipients.length > 0) {
      try {
        const [push] = await this.db
          .insert(emailPushes)
          .values({ tenantId, subject: dto.subject, recipientCount: recipients.length, priceStotinki })
          .returning({ id: emailPushes.id });
        await this.billing.billPush(push.id);
      } catch (err) {
        this.logger.error(
          `[newsletter] push-record/bill failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { sent, recipients: recipients.length };
  }

  async unsubscribe(token: string): Promise<UnsubscribeResult> {
    let payload: { sub?: string; typ?: string };
    try {
      payload = this.jwt.verify(token, { secret: this.unsubSecret() }) as {
        sub?: string;
        typ?: string;
      };
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

  /**
   * Unsubscribe tokens use a SEPARATE derived secret so a token emailed to every
   * subscriber can never validate against the main JWT_SECRET (i.e. never be
   * replayed as an auth/session token). Mirrors AuthService.resetSecret().
   */
  private unsubSecret(): string {
    return `${this.config.getOrThrow<string>('JWT_SECRET')}::unsub`;
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
