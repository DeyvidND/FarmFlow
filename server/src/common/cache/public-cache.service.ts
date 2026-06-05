import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import { type Database, tenants } from '@farmflow/db';
import { REDIS_TOKEN } from '../redis/redis.constants';
import {
  buildPublicDelivery,
  type PublicDelivery,
  type DeliveryConfig,
} from '../../modules/orders/delivery-pricing';

/**
 * Lean tenant identity + storefront toggles, cached per slug. Doubles as the
 * `GET /public/:slug` profile payload (minus `id`) and the slug→tenant resolver
 * that every public read shares — so a warm storefront render performs zero
 * tenant lookups against Postgres.
 */
export interface TenantMeta {
  id: string;
  name: string;
  slug: string;
  phone: string | null;
  email: string | null;
  deliveryEnabled: boolean;
  multiFarmer: boolean;
  multiSubcat: boolean;
  // Whether the farm has connected Econt — lets the storefront gate the Econt
  // delivery options so customers aren't offered an unfulfillable method.
  econtEnabled: boolean;
  // Read-only delivery pricing (free-over threshold + per-method fees) so the
  // storefront displays the farm's configured fees instead of hardcoded numbers.
  delivery: PublicDelivery;
}

/**
 * Redis key builders for the public (storefront) read caches. Each resource gets
 * its own namespace so invalidating one never clobbers another. Products and
 * articles keep their existing `catalog:{tid}` / `articles:{tid}` keys (owned by
 * their own cache services); these cover the previously-uncached reads.
 */
export const publicCacheKeys = {
  tenant: (slug: string) => `tenant:${slug}`,
  farmers: (tenantId: string) => `farmers:${tenantId}`,
  subcategories: (tenantId: string) => `subcats:${tenantId}`,
  reviews: (tenantId: string) => `reviews:${tenantId}`,
};

export const PUBLIC_CACHE_TTL = 300;

/**
 * Thin Redis JSON cache for the storefront's read-hot, write-rare public data
 * (tenant profile, farmers, subcategories, reviews). Mirrors the TTL +
 * invalidate-on-write pattern already used for products/articles.
 */
@Injectable()
export class PublicCacheService {
  constructor(@Inject(REDIS_TOKEN) private readonly redis: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set(key: string, value: unknown, ttlSeconds = PUBLIC_CACHE_TTL): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.redis.del(...keys);
  }

  /**
   * Resolve a storefront slug to its tenant identity + toggles, Redis-cached
   * under `tenant:{slug}`. Shared by every public read so the slug→tenant lookup
   * runs once, then serves from cache until a profile write busts the key.
   * Throws 404 for an unknown slug. The caller passes its own Drizzle handle to
   * keep this service a pure Redis wrapper.
   */
  async resolveTenant(db: Database, slug: string): Promise<TenantMeta> {
    const key = publicCacheKeys.tenant(slug);
    const cached = await this.get<TenantMeta>(key);
    if (cached) return cached;

    const [row] = await db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        phone: tenants.phone,
        email: tenants.email,
        deliveryEnabled: tenants.deliveryEnabled,
        multiFarmer: tenants.multiFarmer,
        multiSubcat: tenants.multiSubcat,
        settings: tenants.settings,
      })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    if (!row) throw new NotFoundException('Фермата не е намерена');

    // Derive the Econt flag + public delivery pricing, then drop `settings`
    // (secrets) before caching/returning.
    const delivery = (
      row.settings as { delivery?: DeliveryConfig & { econt?: { configured?: boolean } } } | null
    )?.delivery;
    const { settings: _settings, ...rest } = row;
    const meta: TenantMeta = {
      ...rest,
      econtEnabled: !!delivery?.econt?.configured,
      delivery: buildPublicDelivery(delivery),
    };

    await this.set(key, meta);
    return meta;
  }
}
