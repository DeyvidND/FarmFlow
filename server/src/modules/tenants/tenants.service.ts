import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Database, tenants } from '@farmflow/db';
import type { PublicTenant, Tenant } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { UpdateTenantDto } from './dto/update-tenant.dto';

/** Lean storefront profile shape returned by `GET /public/:slug` (no secrets). */
export interface PublicStorefront {
  name: string;
  slug: string;
  phone: string | null;
  email: string | null;
  deliveryEnabled: boolean;
  multiFarmer: boolean;
  multiSubcat: boolean;
}

@Injectable()
export class TenantsService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async getMe(tenantId: string): Promise<PublicTenant> {
    const [row] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!row) throw new NotFoundException('Фермата не е намерена');
    return toPublicTenant(row);
  }

  /**
   * Lean public storefront profile by slug — the only tenant data the storefront
   * may read (no auth). Surfaces the module toggles so the storefront can gate
   * personal (address) delivery + slots, multi-farmer nav and subcategory
   * grouping without inferring them from empty list responses. 404 if unknown.
   */
  async findPublicProfileBySlug(slug: string): Promise<PublicStorefront> {
    const [row] = await this.db
      .select({
        name: tenants.name,
        slug: tenants.slug,
        phone: tenants.phone,
        email: tenants.email,
        deliveryEnabled: tenants.deliveryEnabled,
        multiFarmer: tenants.multiFarmer,
        multiSubcat: tenants.multiSubcat,
      })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    if (!row) throw new NotFoundException('Фермата не е намерена');
    return row;
  }

  async updateMe(tenantId: string, dto: UpdateTenantDto): Promise<PublicTenant> {
    // `delivery` is not a column — it's merged into the `settings` jsonb.
    const { delivery, ...flat } = dto;
    const set: Record<string, unknown> = { ...flat };

    if (delivery !== undefined) {
      const [cur] = await this.db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      if (!cur) throw new NotFoundException('Фермата не е намерена');
      const existing = (cur.settings as Record<string, unknown> | null) ?? {};
      set.settings = { ...existing, delivery: sanitizeDelivery(delivery) };
    }

    const [row] = await this.db
      .update(tenants)
      .set(set)
      .where(eq(tenants.id, tenantId))
      .returning();
    if (!row) throw new NotFoundException('Фермата не е намерена');
    return toPublicTenant(row);
  }
}

/**
 * Never persist Econt API secrets in the settings.delivery jsonb. The normal
 * client keeps the password in local state and only sends `econt.configured` /
 * `econt.username`, but enforce it server-side so no caller (or attacker) can
 * stash a plaintext courier password in the blob. (Encrypted storage will land
 * with the live Econt integration.)
 */
function sanitizeDelivery(delivery: Record<string, unknown>): Record<string, unknown> {
  const econt = delivery.econt;
  if (econt && typeof econt === 'object' && !Array.isArray(econt)) {
    const { password, apiPassword, pass, ...safeEcont } = econt as Record<string, unknown>;
    void password;
    void apiPassword;
    void pass;
    return { ...delivery, econt: safeEcont };
  }
  return delivery;
}

/** Strip internal fields the client should never see, but surface the delivery
 *  config from `settings` so the admin panel can read its saved settings back. */
function toPublicTenant(t: Tenant): PublicTenant {
  const { stripeAccountId, settings, ...rest } = t;
  const delivery = (settings as Record<string, unknown> | null)?.delivery ?? null;
  return { ...rest, delivery };
}
