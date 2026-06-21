import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import Redis from 'ioredis';
import { eq } from 'drizzle-orm';
import { type Database, tenants } from '@farmflow/db';
import { REDIS_TOKEN } from '../redis/redis.constants';
import {
  buildPublicDelivery,
  buildPublicMethods,
  econtMode,
  codEnabled,
  cardEnabled,
  type PublicDelivery,
  type PublicMethods,
  type DeliveryConfig,
  type EcontMode,
} from '../../modules/orders/delivery-pricing';
import { buildPublicContact, type PublicContact } from '../../modules/tenants/site-contact';
import { resolveLanding, type PublicLanding } from '../../modules/tenants/landing';
import {
  resolveMerchandising,
  type PublicMerchandising,
} from '../../modules/tenants/merchandising';
import {
  buildPublicMarketing,
  type PublicMarketing,
} from '../../modules/tenants/site-marketing';
import { buildPublicCopy, buildPublicFaq, type PublicFaqItem } from '../../modules/tenants/site-copy';

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
  // Storefront content sections, gated from the «Функции на магазина» panel.
  articlesEnabled: boolean;
  reviewsEnabled: boolean;
  // «Продукт на седмицата» highlight config. The bootstrap resolver turns these
  // into the featured product (manual pick or weekly ISO-week rotation).
  productOfWeekEnabled: boolean;
  productOfWeekMode: string;
  productOfWeekId: string | null;
  productOfWeekNote: string | null;
  // 'section' (full banner under the hero) | 'bar' (thin strip above the header).
  productOfWeekPlacement: string;
  // Whether the farm offers Econt at all (manual or automatic) — gates the Econt
  // delivery radios on the storefront.
  econtEnabled: boolean;
  // Which Econt mode: 'off' | 'manual' (free-text office, flat fee, ship-it-yourself)
  // | 'auto' (live API office picker + price). The storefront uses the API office
  // picker only in 'auto'.
  econtMode: EcontMode;
  // Whether наложен платеж (COD) is offered — gates the storefront's COD radio.
  codEnabled: boolean;
  // Internal: whether the farm accepts card payment (the farmer's override). Folded
  // into `stripeEnabled` in TenantsService, then stripped — not sent to the storefront.
  cardEnabled: boolean;
  // Internal: the farm's connected Stripe account id. Used to derive `stripeEnabled`
  // in TenantsService, then stripped — never sent to the storefront.
  stripeAccountId: string | null;
  // Internal: whether the connected account has completed onboarding and can take
  // charges (Stripe `charges_enabled`, persisted via the account.updated webhook).
  // Folded into `stripeEnabled` so a linked-but-not-live account never offers card.
  stripeChargesEnabled: boolean;
  // Read-only delivery pricing (free-over threshold + per-method fees) so the
  // storefront displays the farm's configured fees instead of hardcoded numbers.
  delivery: PublicDelivery;
  // Which delivery methods are switched on — the storefront shows only these, so
  // a disabled method (e.g. Econt 'до адрес' left off) never reaches a customer.
  methods: PublicMethods;
  // Tenant-uploaded photos for the storefront's static decorative slots, keyed by
  // catalog slot id. Empty/missing → the storefront renders its `.ph` mock.
  media: Record<string, { url: string }>;
  // Editable contact block + website icon + theme color (settings.contact /
  // settings.brand). Derived here so a warm storefront render needs no extra read.
  contact: PublicContact;
  faviconUrl: string | null;
  themeColor: string | null;
  // Configurable landing blocks (settings.landing) — which of the three dynamic
  // home blocks show and how many items each shows. Resolved+clamped, always present.
  landing: PublicLanding;
  // Merchandising toggles (settings.merchandising) — the „Най-продавани" shop chip
  // and the „Често купувано заедно" cart picks. Resolved, always present.
  merchandising: PublicMerchandising;
  // Per-vendor ad/analytics tracking IDs (settings.marketing). Derived here so a
  // warm storefront render needs no extra read; empty → all-null.
  marketing: PublicMarketing;
  // Editable body copy (settings.copy) + FAQ list (settings.faq). Derived here so
  // a warm storefront render needs no extra read. Empty → storefront defaults.
  copy: Record<string, string>;
  faq: PublicFaqItem[];
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
  // Farmer-picked home-page reviews (settings.landing.reviews.ids). Separate from
  // the full `reviews:` summary so the landing edit + a publish/hide can bust the
  // home block without clobbering the storefront's reviews-page cache.
  homeReviews: (tenantId: string) => `home-reviews:${tenantId}`,
};

export const PUBLIC_CACHE_TTL = 300;

/**
 * Sentinel stored under `tenant:{slug}` when the slug does not exist in the
 * DB. Real cached payloads are always plain objects; this distinct string value
 * is never confused with one. TTL is intentionally short (45 s) so a
 * freshly-provisioned slug is visible within the minute without requiring a
 * manual cache bust.
 */
const TENANT_NOT_FOUND_SENTINEL = '__404__';
const TENANT_NOT_FOUND_TTL = 45;

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
    const raw = await this.redis.get(key);
    if (raw !== null) {
      if (raw === TENANT_NOT_FOUND_SENTINEL) throw new NotFoundException('Фермата не е намерена');
      return JSON.parse(raw) as TenantMeta;
    }

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
        articlesEnabled: tenants.articlesEnabled,
        reviewsEnabled: tenants.reviewsEnabled,
        productOfWeekEnabled: tenants.productOfWeekEnabled,
        productOfWeekMode: tenants.productOfWeekMode,
        productOfWeekId: tenants.productOfWeekId,
        productOfWeekNote: tenants.productOfWeekNote,
        productOfWeekPlacement: tenants.productOfWeekPlacement,
        settings: tenants.settings,
        stripeAccountId: tenants.stripeAccountId,
        stripeChargesEnabled: tenants.stripeChargesEnabled,
      })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    if (!row) {
      await this.redis.set(key, TENANT_NOT_FOUND_SENTINEL, 'EX', TENANT_NOT_FOUND_TTL);
      throw new NotFoundException('Фермата не е намерена');
    }

    // Derive the Econt flag + public delivery pricing + site-media map, then drop
    // `settings` (secrets) before caching/returning.
    const settingsObj = row.settings as
      | {
          delivery?: DeliveryConfig & { econt?: { configured?: boolean } };
          media?: Record<string, { url?: unknown }>;
          contact?: unknown;
          brand?: { favicon?: { url?: unknown }; themeColor?: unknown };
          landing?: unknown;
          merchandising?: unknown;
          marketing?: unknown;
          copy?: unknown;
          faq?: unknown;
          siteTheme?: unknown;
        }
      | null;
    const delivery = settingsObj?.delivery;
    const { settings: _settings, ...rest } = row;
    const mode = econtMode(delivery);
    const media: Record<string, { url: string }> = {};
    for (const [k, v] of Object.entries(settingsObj?.media ?? {})) {
      if (typeof v?.url === 'string' && v.url) media[k] = { url: v.url };
    }
    const brand = settingsObj?.brand;
    const faviconUrl =
      typeof brand?.favicon?.url === 'string' && brand.favicon.url ? brand.favicon.url : null;
    const themeColor =
      typeof brand?.themeColor === 'string' && brand.themeColor ? brand.themeColor : null;
    const meta: TenantMeta = {
      ...rest,
      econtEnabled: mode !== 'off',
      econtMode: mode,
      codEnabled: codEnabled(delivery),
      cardEnabled: cardEnabled(delivery),
      stripeAccountId: row.stripeAccountId ?? null,
      delivery: buildPublicDelivery(delivery),
      methods: buildPublicMethods(delivery),
      media,
      contact: buildPublicContact(settingsObj?.contact),
      faviconUrl,
      themeColor,
      landing: resolveLanding(settingsObj?.landing),
      merchandising: resolveMerchandising(settingsObj?.merchandising),
      marketing: buildPublicMarketing(settingsObj?.marketing),
      copy: buildPublicCopy(settingsObj?.copy),
      faq: buildPublicFaq(settingsObj?.faq),
    };

    await this.set(key, meta);
    return meta;
  }
}
