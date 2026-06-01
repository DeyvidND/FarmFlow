import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  type Database,
  tenants,
  newsletterSubscribers,
  contactMessages,
} from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { NewsletterDto } from './dto/newsletter.dto';
import { ContactDto } from './dto/contact.dto';

/**
 * Public storefront intake: newsletter sign-ups and contact-form messages.
 * Tenant-scoped by storefront slug; both writes are public (CORS `*`).
 */
@Injectable()
export class IntakeService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  private async resolveTenantId(slug: string): Promise<string> {
    const [tenant] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    if (!tenant) throw new NotFoundException('Фермата не е намерена');
    return tenant.id;
  }

  /** Idempotent subscribe — a repeated email for the same farm is a no-op. */
  async subscribe(slug: string, dto: NewsletterDto): Promise<{ ok: true }> {
    const tenantId = await this.resolveTenantId(slug);
    const email = dto.email.trim().toLowerCase();

    const [existing] = await this.db
      .select({ id: newsletterSubscribers.id })
      .from(newsletterSubscribers)
      .where(
        and(
          eq(newsletterSubscribers.tenantId, tenantId),
          eq(newsletterSubscribers.email, email),
        ),
      )
      .limit(1);

    if (!existing) {
      await this.db.insert(newsletterSubscribers).values({ tenantId, email });
    }
    return { ok: true };
  }

  async contact(slug: string, dto: ContactDto): Promise<{ ok: true }> {
    const tenantId = await this.resolveTenantId(slug);
    await this.db.insert(contactMessages).values({
      tenantId,
      name: dto.name.trim(),
      email: dto.email.trim(),
      phone: dto.phone?.trim() || null,
      message: dto.message.trim(),
    });
    return { ok: true };
  }
}
