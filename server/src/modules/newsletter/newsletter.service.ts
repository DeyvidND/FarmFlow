import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, getTableColumns, gte, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import {
  type Database,
  newsletterSubscribers,
  newsletterCampaigns,
  emailPushes,
  tenants,
} from '@fermeribg/db';
import type {
  NewsletterBlock,
  NewsletterColumn,
  NewsletterCampaign,
  NewsletterQuote,
} from '@fermeribg/types';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EmailService } from '../../common/email/email.service';
import { SuppressionService } from '../../common/email/suppression.service';
import { BillingService } from '../billing/billing.service';
import { StorageService } from '../storage/storage.service';
import { optimizeImage } from '../storage/image.util';
import { tenantSlug } from '../../common/tenant-slug.util';
import { priceForRecipients } from '../billing/billing.pricing';
import { renderEmail, type RenderOpts } from './email-render';
import { sanitizeNewsletterHtml } from './newsletter.util';
import { UpsertCampaignDto } from './dto/campaign.dto';
import {
  clampLimit,
  keysetAfter,
  buildKeysetPage,
  cursorTs,
  KEYSET_TS,
  type Paginated,
} from '../../common/pagination/keyset';
import { decodeCursor } from '../../common/pagination/cursor';
import { bgToday, bgDayBounds } from '../../common/time/bg-time';

export interface SubscribersResult {
  items: { id: string; email: string; createdAt: Date | null }[];
  nextCursor: string | null;
  activeCount: number;
  unsubscribedCount: number;
}

export interface UnsubscribeResult {
  success: boolean;
}

const IMG_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Sanitize the html-bearing block fields (text blocks + text columns). */
function sanitizeBlocks(blocks: NewsletterBlock[]): NewsletterBlock[] {
  const col = (c: NewsletterColumn): NewsletterColumn =>
    c.kind === 'text' ? { kind: 'text', html: sanitizeNewsletterHtml(c.html) } : c;
  return (blocks ?? []).map((b) => {
    if (b.type === 'text') return { ...b, html: sanitizeNewsletterHtml(b.html) };
    if (b.type === 'columns') return { ...b, left: col(b.left), right: col(b.right) };
    return b;
  });
}

type CampaignRow = typeof newsletterCampaigns.$inferSelect;

function toCampaign(r: CampaignRow): NewsletterCampaign {
  return {
    id: r.id,
    subject: r.subject,
    blocks: (r.blocks as NewsletterBlock[]) ?? [],
    status: r.status as 'draft' | 'sent',
    recipientCount: r.recipientCount ?? null,
    priceStotinki: r.priceStotinki ?? null,
    sentAt: r.sentAt ? new Date(r.sentAt).toISOString() : null,
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
  };
}

@Injectable()
export class NewsletterService {
  private readonly logger = new Logger(NewsletterService.name);
  /** Origin of the API that serves the unsubscribe page (GET /unsubscribe). */
  private readonly apiBaseUrl: string;
  private readonly perRecipientMicro: number;
  private readonly maxRecipients: number;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly email: EmailService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly suppression: SuppressionService,
    private readonly billing: BillingService,
    private readonly storage: StorageService,
  ) {
    this.apiBaseUrl = config.get<string>('API_PUBLIC_URL') ?? 'http://localhost:3001';
    this.perRecipientMicro = config.get<number>('EMAIL_PRICE_PER_RECIPIENT_MICRO') ?? 555;
    this.maxRecipients = config.get<number>('EMAIL_PUSH_MAX_RECIPIENTS') ?? 5000;
  }

  /* ------------------------------ subscribers ------------------------------ */

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
        [KEYSET_TS]: cursorTs(newsletterSubscribers.createdAt),
      })
      .from(newsletterSubscribers)
      .where(and(...conds))
      .orderBy(asc(newsletterSubscribers.createdAt), asc(newsletterSubscribers.id))
      .limit(lim + 1);

    const page = buildKeysetPage(rows, lim);

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

  /* ------------------------------- campaigns ------------------------------- */

  async listCampaigns(
    tenantId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<Paginated<NewsletterCampaign>> {
    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    const conds = [eq(newsletterCampaigns.tenantId, tenantId)];
    if (cur) conds.push(keysetAfter(newsletterCampaigns.updatedAt, newsletterCampaigns.id, cur, 'desc'));

    const rows = await this.db
      .select({
        ...getTableColumns(newsletterCampaigns),
        // Keyset boundary is updatedAt here (see orderBy). Coalesce NULL to epoch so
        // the cursor matches the old `updatedAt ?? new Date(0)` fallback; micro
        // precision keeps pagination advancing when many campaigns share a ms.
        [KEYSET_TS]: sql<string>`to_char(coalesce(${newsletterCampaigns.updatedAt}, timestamp 'epoch'), 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
      })
      .from(newsletterCampaigns)
      .where(and(...conds))
      .orderBy(desc(newsletterCampaigns.updatedAt), desc(newsletterCampaigns.id))
      .limit(lim + 1);

    const page = buildKeysetPage(rows, lim);
    return { items: page.items.map(toCampaign), nextCursor: page.nextCursor };
  }

  private async campaignRow(id: string, tenantId: string): Promise<CampaignRow> {
    const [row] = await this.db
      .select()
      .from(newsletterCampaigns)
      .where(and(eq(newsletterCampaigns.id, id), eq(newsletterCampaigns.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new NotFoundException('Бюлетинът не е намерен');
    return row;
  }

  async getCampaign(id: string, tenantId: string): Promise<NewsletterCampaign> {
    return toCampaign(await this.campaignRow(id, tenantId));
  }

  async createCampaign(tenantId: string, dto: UpsertCampaignDto): Promise<NewsletterCampaign> {
    const [row] = await this.db
      .insert(newsletterCampaigns)
      .values({
        tenantId,
        subject: dto.subject,
        blocks: sanitizeBlocks(dto.blocks),
      })
      .returning();
    return toCampaign(row);
  }

  async updateCampaign(
    id: string,
    tenantId: string,
    dto: UpsertCampaignDto,
  ): Promise<NewsletterCampaign> {
    const existing = await this.campaignRow(id, tenantId);
    if (existing.status === 'sent') {
      throw new BadRequestException('Изпратен бюлетин не може да се променя');
    }
    const [row] = await this.db
      .update(newsletterCampaigns)
      .set({
        subject: dto.subject,
        blocks: sanitizeBlocks(dto.blocks),
        updatedAt: new Date(),
      })
      .where(and(eq(newsletterCampaigns.id, id), eq(newsletterCampaigns.tenantId, tenantId)))
      .returning();
    return toCampaign(row);
  }

  async deleteCampaign(id: string, tenantId: string): Promise<{ success: boolean }> {
    const existing = await this.campaignRow(id, tenantId);
    if (existing.status === 'sent') {
      throw new BadRequestException('Изпратен бюлетин не може да се изтрива');
    }
    await this.db
      .delete(newsletterCampaigns)
      .where(and(eq(newsletterCampaigns.id, id), eq(newsletterCampaigns.tenantId, tenantId)));
    try {
      const slug = await tenantSlug(this.db, tenantId);
      await this.storage.deleteByPrefix(`tenants/${slug}/newsletter/${id}/`);
    } catch (err) {
      this.logger.warn(`[newsletter] image sweep failed for ${id}: ${this.errText(err)}`);
    }
    return { success: true };
  }

  /** Upload an inline image for a campaign → absolute R2 url. */
  async addInlineImage(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<{ url: string }> {
    await this.campaignRow(id, tenantId); // scope check (404 cross-tenant)
    const img = await optimizeImage(file.buffer, file.mimetype, IMG_EXT_BY_MIME[file.mimetype] ?? 'jpg');
    const slug = await tenantSlug(this.db, tenantId);
    const key = `tenants/${slug}/newsletter/${id}/${randomUUID()}.${img.ext}`;
    const { url } = await this.storage.upload(img.buffer, key, img.contentType);
    return { url };
  }

  /** Render the campaign to email HTML for the live preview. */
  async preview(id: string, tenantId: string): Promise<{ html: string }> {
    const campaign = await this.campaignRow(id, tenantId);
    const opts = await this.renderOpts(tenantId, campaign.subject, `${this.apiBaseUrl}/unsubscribe?token=preview`);
    return { html: renderEmail((campaign.blocks as NewsletterBlock[]) ?? [], opts) };
  }

  /* --------------------------------- quote --------------------------------- */

  /** Cost preview for the composer: active count + what a send costs now. */
  async quote(tenantId: string): Promise<NewsletterQuote> {
    const [counts] = await this.db
      .select({
        active: sql<number>`count(*) filter (where ${newsletterSubscribers.unsubscribedAt} is null)::int`,
      })
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.tenantId, tenantId))
      .limit(1);
    const activeCount = counts?.active ?? 0;

    const [t] = await this.db
      .select({ premium: tenants.premium })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const premium = !!t?.premium;

    const monthFrom = bgDayBounds(`${bgToday().slice(0, 7)}-01`).from;
    const [mtd] = await this.db
      .select({
        count: sql<number>`coalesce(sum(${emailPushes.recipientCount}),0)::int`,
        cost: sql<number>`coalesce(sum(${emailPushes.priceStotinki}),0)::int`,
      })
      .from(emailPushes)
      .where(and(eq(emailPushes.tenantId, tenantId), gte(emailPushes.createdAt, monthFrom)))
      .limit(1);

    return {
      activeCount,
      perRecipientMicro: this.perRecipientMicro,
      sendCostStotinki: premium ? 0 : priceForRecipients(activeCount, this.perRecipientMicro),
      monthToDateCount: mtd?.count ?? 0,
      monthToDateStotinki: mtd?.cost ?? 0,
      premium,
    };
  }

  /* --------------------------------- send ---------------------------------- */

  async sendCampaign(id: string, tenantId: string): Promise<{ sent: number; recipients: number }> {
    // Billability gate: a send is billed as a Stripe invoice item that needs a
    // customer to land on. Without one (non-premium farm that never set up
    // billing) refuse up front rather than email first and fail to charge.
    if (!(await this.billing.isBillable(tenantId))) {
      throw new BadRequestException('Настройте плащане (абонамент) преди да изпращате бюлетини.');
    }

    const campaign = await this.campaignRow(id, tenantId);
    if (campaign.status === 'sent') {
      throw new BadRequestException('Този бюлетин вече е изпратен.');
    }

    // Cap the fetch at maxRecipients+1 so an oversized list never loads the whole
    // table; the +1 row is enough to detect "over cap".
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
      .limit(this.maxRecipients + 1);

    if (active.length > this.maxRecipients) {
      throw new BadRequestException(
        `Списъкът е твърде голям за едно изпращане (${active.length} получателя, лимит ${this.maxRecipients}). Раздели изпращането.`,
      );
    }

    // Drop suppressed addresses (hard bounces / complaints) to protect the domain.
    const suppressed = await this.suppression.filterSuppressed(active.map((a) => a.email));
    const recipients = active.filter((a) => !suppressed.has(a.email.trim().toLowerCase()));

    // Render the body ONCE with a placeholder unsubscribe URL, then swap per
    // recipient (a string replace, not a full re-render of the block tree).
    const opts = await this.renderOpts(tenantId, campaign.subject, '{{UNSUB}}');
    const bodyTemplate = renderEmail((campaign.blocks as NewsletterBlock[]) ?? [], opts);

    let sent = 0;
    for (const subscriber of recipients) {
      try {
        const token = this.jwt.sign(
          { sub: subscriber.id, typ: 'unsub' },
          { secret: this.unsubSecret(), expiresIn: '3650d' },
        );
        const unsubscribeUrl = `${this.apiBaseUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
        const html = bodyTemplate.replace('{{UNSUB}}', unsubscribeUrl);
        const text = `${campaign.subject}\n\n---\nОтпишете се: ${unsubscribeUrl}`;

        await this.email.sendMail({
          to: subscriber.email,
          subject: campaign.subject,
          html,
          text,
          stream: 'bulk', // newsletters ride the bulk reputation lane
          skipSuppressionCheck: true, // already filtered above (one batch query)
          // Gmail/Yahoo bulk-sender rules: one-click unsubscribe. The GET URL is the
          // human link; the POST (RFC 8058) is the mailbox provider's one-click button.
          headers: {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });
        sent++;
      } catch (err) {
        this.logger.error(
          `[newsletter] Failed to send to subscriber=${subscriber.id}: ${this.errText(err)}`,
        );
      }
    }

    // Usage ledger: one row per send, valued per recipient, then billed to the
    // farm's Stripe subscription (premium → free).
    const priceStotinki = priceForRecipients(recipients.length, this.perRecipientMicro);
    if (recipients.length > 0) {
      try {
        const [push] = await this.db
          .insert(emailPushes)
          .values({
            tenantId,
            campaignId: id,
            subject: campaign.subject,
            recipientCount: recipients.length,
            priceStotinki,
          })
          .returning({ id: emailPushes.id });
        await this.billing.billPush(push.id);
      } catch (err) {
        this.logger.error(`[newsletter] push-record/bill failed: ${this.errText(err)}`);
      }
    }

    await this.db
      .update(newsletterCampaigns)
      .set({ status: 'sent', sentAt: new Date(), recipientCount: recipients.length, priceStotinki })
      .where(and(eq(newsletterCampaigns.id, id), eq(newsletterCampaigns.tenantId, tenantId)));

    return { sent, recipients: recipients.length };
  }

  /* ------------------------------ unsubscribe ------------------------------ */

  async unsubscribe(token: string): Promise<UnsubscribeResult> {
    let payload: { sub?: string; typ?: string };
    try {
      payload = this.jwt.verify(token, { secret: this.unsubSecret() }) as { sub?: string; typ?: string };
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

    if (!subscriber) return { success: false };
    if (subscriber.unsubscribedAt != null) return { success: true }; // idempotent

    await this.db
      .update(newsletterSubscribers)
      .set({ unsubscribedAt: new Date() })
      .where(eq(newsletterSubscribers.id, subscriber.id))
      .returning();

    return { success: true };
  }

  /* -------------------------------- helpers -------------------------------- */

  /** Build the renderer's brand/contact options from the tenant's settings. */
  private async renderOpts(
    tenantId: string,
    subject: string,
    unsubscribeUrl: string,
  ): Promise<RenderOpts> {
    const [t] = await this.db
      .select({ name: tenants.name, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const settings = (t?.settings ?? {}) as Record<string, any>;
    const brand = (settings.brand ?? {}) as Record<string, any>;
    const contact = (settings.contact ?? {}) as Record<string, any>;
    const logoUrl = typeof brand?.favicon?.url === 'string' ? brand.favicon.url : undefined;
    const themeColor =
      typeof brand?.themeColor === 'string' && brand.themeColor ? brand.themeColor : '#2d6a4f';
    const contactLine = [contact.address, contact.phone].filter((s) => typeof s === 'string' && s).join(' · ');

    return {
      subject,
      brand: { logoUrl, themeColor, farmName: t?.name ?? 'Фермата' },
      contact: contactLine ? { line: contactLine } : null,
      unsubscribeUrl,
    };
  }

  /**
   * Unsubscribe tokens use a SEPARATE derived secret so a token emailed to every
   * subscriber can never validate against the main JWT_SECRET. Mirrors
   * AuthService.resetSecret().
   */
  private unsubSecret(): string {
    return `${this.config.getOrThrow<string>('JWT_SECRET')}::unsub`;
  }

  private errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
