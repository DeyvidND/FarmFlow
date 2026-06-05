import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Database, tenants } from '@farmflow/db';
import type { PublicTenant, Tenant } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { MapsService } from '../../common/maps/maps.service';
import { PublicCacheService, publicCacheKeys } from '../../common/cache/public-cache.service';
import { type PublicDelivery, type EcontMode } from '../orders/delivery-pricing';
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
  econtEnabled: boolean;
  econtMode: EcontMode;
  delivery: PublicDelivery;
}

@Injectable()
export class TenantsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly maps: MapsService,
    private readonly publicCache: PublicCacheService,
  ) {}

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
    // Reuses the shared, Redis-cached slug→tenant resolver. The cached meta IS
    // the profile shape plus an internal `id` — strip it before returning.
    const { id: _id, ...profile } = await this.publicCache.resolveTenant(this.db, slug);
    return profile;
  }

  async updateMe(tenantId: string, dto: UpdateTenantDto): Promise<PublicTenant> {
    // `delivery` and `routing` aren't columns — they merge into `settings` jsonb.
    const { delivery, routing, farmAddress, farmLat, farmLng, ...flat } = dto;
    const set: Record<string, unknown> = { ...flat };

    // Home / depot. Prefer explicit pin coords; else geocode the typed address.
    if (farmAddress !== undefined) {
      set.farmAddress = farmAddress;
      if (farmLat != null && farmLng != null) {
        set.farmLat = String(farmLat);
        set.farmLng = String(farmLng);
      } else if (farmAddress) {
        const geo = await this.maps.geocode(farmAddress);
        if (geo) {
          set.farmLat = String(geo.lat);
          set.farmLng = String(geo.lng);
        }
      }
    } else if (farmLat != null && farmLng != null) {
      set.farmLat = String(farmLat);
      set.farmLng = String(farmLng);
    }

    if (delivery !== undefined || routing !== undefined) {
      const [cur] = await this.db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      if (!cur) throw new NotFoundException('Фермата не е намерена');
      const existing = (cur.settings as Record<string, unknown> | null) ?? {};
      const nextSettings: Record<string, unknown> = { ...existing };
      if (delivery !== undefined) nextSettings.delivery = sanitizeDelivery(delivery);
      if (routing !== undefined) {
        nextSettings.routing = await this.resolveRouting(existing.routing, routing);
      }
      set.settings = nextSettings;
    }

    const [row] = await this.db
      .update(tenants)
      .set(set)
      .where(eq(tenants.id, tenantId))
      .returning();
    if (!row) throw new NotFoundException('Фермата не е намерена');

    // Bust the cached profile, and the farmers/subcategories lists too: flipping
    // multiFarmer/multiSubcat changes whether those endpoints return data or [].
    await this.publicCache.del(
      publicCacheKeys.tenant(row.slug),
      publicCacheKeys.farmers(tenantId),
      publicCacheKeys.subcategories(tenantId),
    );
    return toPublicTenant(row);
  }

  /**
   * Merge route-end config and geocode a custom end address into endLat/endLng.
   * Clears the coords when the address is removed.
   */
  private async resolveRouting(
    prev: unknown,
    routing: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const next: Record<string, unknown> = {
      ...((prev as Record<string, unknown> | null) ?? {}),
      ...routing,
    };
    if ('endAddress' in routing) {
      const endAddress = (routing.endAddress as string | null) ?? '';
      if (endAddress) {
        const geo = await this.maps.geocode(endAddress);
        next.endLat = geo ? String(geo.lat) : null;
        next.endLng = geo ? String(geo.lng) : null;
      } else {
        next.endLat = null;
        next.endLng = null;
      }
    }
    return next;
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
  const s = settings as Record<string, unknown> | null;
  return { ...rest, delivery: s?.delivery ?? null, routing: s?.routing ?? null };
}
