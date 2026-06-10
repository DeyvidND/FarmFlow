import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';
import { type Database, tenants, products } from '@farmflow/db';
import type { PublicTenant, Tenant } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { MapsService } from '../../common/maps/maps.service';
import { PublicCacheService, publicCacheKeys } from '../../common/cache/public-cache.service';
import { StorageService } from '../storage/storage.service';
import { PRODUCT_IMAGE_EXT_BY_MIME } from '../storage/dto/upload-image.dto';
import { sniffMime } from '../storage/magic-mime';
import { type PublicDelivery, type PublicMethods, type EcontMode } from '../orders/delivery-pricing';
import { StripeService } from '../stripe/stripe.service';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { SiteContactDto } from './dto/site-contact.dto';
import {
  getMediaCatalog,
  isValidSlot,
  type MediaSlotDef,
} from './media-slots.catalog';
import {
  buildPublicContact,
  normalizeSiteContact,
  type PublicContact,
} from './site-contact';

/** One stored site-media value. `key` is the R2 object key (for replace/delete);
 *  only `url` is ever exposed publicly. */
export interface MediaSlotValue {
  url: string;
  key: string;
}

/** Public site-media map: slot key → image url. */
export type PublicMediaMap = Record<string, { url: string }>;

/** Lean storefront profile shape returned by `GET /public/:slug` (no secrets). */
export interface PublicStorefront {
  name: string;
  slug: string;
  phone: string | null;
  email: string | null;
  deliveryEnabled: boolean;
  multiFarmer: boolean;
  multiSubcat: boolean;
  articlesEnabled: boolean;
  reviewsEnabled: boolean;
  econtEnabled: boolean;
  econtMode: EcontMode;
  codEnabled: boolean;
  stripeEnabled: boolean;
  delivery: PublicDelivery;
  methods: PublicMethods;
  // Tenant-uploaded photos for the storefront's static decorative slots, keyed by
  // catalog slot id. Empty/missing slot → the storefront renders its `.ph` mock.
  media: PublicMediaMap;
  // Editable contact block (settings.contact). Empty/missing → nulls; the
  // storefront falls back to its own static copy.
  contact: PublicContact;
  // Tenant website icon (settings.brand.favicon.url) and browser theme color
  // (settings.brand.themeColor). Null → storefront defaults.
  faviconUrl: string | null;
  themeColor: string | null;
}

@Injectable()
export class TenantsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly maps: MapsService,
    private readonly publicCache: PublicCacheService,
    private readonly storage: StorageService,
    private readonly stripe: StripeService,
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
    // the profile shape plus internal `id`/`stripeAccountId` — strip them, and
    // derive the public `stripeEnabled` flag (same gate the checkout uses).
    const { id: _id, stripeAccountId, ...profile } = await this.publicCache.resolveTenant(
      this.db,
      slug,
    );
    return { ...profile, stripeEnabled: this.stripe.isEnabledForAccount(stripeAccountId) };
  }

  async updateMe(tenantId: string, dto: UpdateTenantDto): Promise<PublicTenant> {
    // `delivery` and `routing` aren't columns — they merge into `settings` jsonb.
    const { delivery, routing, farmAddress, farmLat, farmLng, ...flat } = dto;
    const set: Record<string, unknown> = { ...flat };

    // A manually-featured «Продукт на седмицата» must belong to this tenant.
    if (dto.productOfWeekId) {
      const [p] = await this.db
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.id, dto.productOfWeekId), eq(products.tenantId, tenantId)))
        .limit(1);
      if (!p) throw new BadRequestException('Продуктът не е намерен');
    }

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
      if (delivery !== undefined) {
        // Carry the encrypted Econt password over from storage — the client no
        // longer receives it (toPublicTenant strips it), so a plain
        // delivery-settings save must not wipe it.
        nextSettings.delivery = preserveEcontSecret(existing.delivery, sanitizeDelivery(delivery));
      }
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

  // ---- Site media (editable storefront photos) ----

  /** Catalog + current values for the admin editor. `key` is stripped from the
   *  values — the admin only needs the public url. */
  async getSiteMedia(
    tenantId: string,
  ): Promise<{ catalog: MediaSlotDef[]; values: PublicMediaMap }> {
    const settings = await this.loadSettings(tenantId);
    return {
      catalog: getMediaCatalog(this.themeOf(settings)),
      values: toPublicMedia(settings.media),
    };
  }

  /** Upload (or replace) the photo for one slot. Validates the slot against the
   *  tenant's catalog, stores under a tenant-scoped R2 key, drops any previous
   *  object, and busts the public profile cache. */
  async setSiteMedia(
    tenantId: string,
    slotKey: string,
    file: Express.Multer.File,
  ): Promise<{ slotKey: string; url: string }> {
    const { slug, settings } = await this.loadTenantForMedia(tenantId);
    if (!isValidSlot(this.themeOf(settings), slotKey)) {
      throw new BadRequestException('Непознат слот за снимка');
    }

    const ext = PRODUCT_IMAGE_EXT_BY_MIME[file.mimetype] ?? 'bin';
    const key = `tenants/${tenantId}/site/${slotKey}/${randomUUID()}.${ext}`;
    const { url } = await this.storage.upload(file.buffer, key, file.mimetype);

    const prev = readMedia(settings)[slotKey];

    // Atomic, race-safe merge: set ONLY settings.media[slotKey] in a single
    // UPDATE that reads the row's own column, so a concurrent upload to another
    // slot can't clobber this one (a JS read-modify-write of the whole blob
    // would). The `|| jsonb_build_object('media', …)` ensures the `media` object
    // exists before jsonb_set writes into it.
    const value = JSON.stringify({ url, key });
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(
          coalesce(${tenants.settings}, '{}'::jsonb)
            || jsonb_build_object('media', coalesce(${tenants.settings} -> 'media', '{}'::jsonb)),
          array['media', ${slotKey}],
          ${value}::jsonb,
          true
        )`,
      })
      .where(eq(tenants.id, tenantId));

    // Drop the replaced object after the new one + DB row are committed (best
    // effort — a leaked object is harmless next to a broken live image).
    if (prev?.key && prev.key !== key) {
      await this.storage.delete(prev.key).catch(() => undefined);
    }
    await this.publicCache.del(publicCacheKeys.tenant(slug));
    return { slotKey, url };
  }

  /** Remove the photo for one slot (reverts to the storefront mock). Idempotent. */
  async deleteSiteMedia(tenantId: string, slotKey: string): Promise<{ ok: true }> {
    const { slug, settings } = await this.loadTenantForMedia(tenantId);
    const prev = readMedia(settings)[slotKey];
    if (!prev) return { ok: true };

    // Atomic removal of just settings.media[slotKey] (race-safe vs sibling writes).
    await this.db
      .update(tenants)
      .set({
        settings: sql`coalesce(${tenants.settings}, '{}'::jsonb) #- array['media', ${slotKey}]`,
      })
      .where(eq(tenants.id, tenantId));

    if (prev.key) await this.storage.delete(prev.key).catch(() => undefined);
    await this.publicCache.del(publicCacheKeys.tenant(slug));
    return { ok: true };
  }

  // ---- Site contact + website icon ----

  /** Current contact block + favicon url + theme color for the admin editor. */
  async getSiteContact(tenantId: string): Promise<{
    contact: PublicContact;
    favicon: { url: string } | null;
    themeColor: string | null;
  }> {
    const settings = await this.loadSettings(tenantId);
    const brand = readBrand(settings);
    const url = typeof brand.favicon?.url === 'string' ? brand.favicon.url : '';
    return {
      contact: buildPublicContact(settings.contact),
      favicon: url ? { url } : null,
      themeColor: typeof brand.themeColor === 'string' && brand.themeColor ? brand.themeColor : null,
    };
  }

  /** Replace the whole settings.contact block, and set/clear brand.themeColor
   *  when the field was sent. Both are atomic per-path writes (favicon untouched). */
  async updateSiteContact(
    tenantId: string,
    dto: SiteContactDto,
  ): Promise<{ contact: PublicContact; themeColor: string | null }> {
    const { slug } = await this.loadTenantForMedia(tenantId);
    const { contact, themeColor } = normalizeSiteContact(dto);

    // Build the settings expression so the contact + themeColor write lands in a
    // single atomic UPDATE (a crash can't persist one without the other).
    const settingsExpr =
      themeColor === undefined
        ? // field not sent → leave brand.themeColor untouched, write only contact
          sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['contact'], ${JSON.stringify(contact)}::jsonb, true)`
        : themeColor
          ? // non-empty string → set it, preserving brand.favicon
            sql`jsonb_set(
                jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['contact'], ${JSON.stringify(contact)}::jsonb, true)
                  || jsonb_build_object('brand', coalesce(${tenants.settings} -> 'brand', '{}'::jsonb)),
                array['brand', 'themeColor'],
                ${JSON.stringify(themeColor)}::jsonb,
                true
              )`
          : // '' or null → write contact then clear the themeColor key
            sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['contact'], ${JSON.stringify(contact)}::jsonb, true) #- array['brand', 'themeColor']`;

    await this.db
      .update(tenants)
      .set({ settings: settingsExpr })
      .where(eq(tenants.id, tenantId));

    await this.publicCache.del(publicCacheKeys.tenant(slug));
    return { contact: buildPublicContact(contact), themeColor: themeColor ?? null };
  }

  /** Upload/replace the website icon. PNG or ICO only — verified by magic bytes
   *  (the declared mime is spoofable). Stored at brand.favicon = { url, key }. */
  async setFavicon(tenantId: string, file: Express.Multer.File): Promise<{ url: string }> {
    const { slug, settings } = await this.loadTenantForMedia(tenantId);

    const detected = sniffMime(file.buffer);
    if (detected !== 'image/png' && detected !== 'image/x-icon') {
      throw new BadRequestException('Иконата трябва да е PNG или ICO файл.');
    }
    const ext = detected === 'image/png' ? 'png' : 'ico';
    const key = `tenants/${tenantId}/site/favicon/${randomUUID()}.${ext}`;
    // Upload with the *detected* (canonical) content type, not the client header.
    const { url } = await this.storage.upload(file.buffer, key, detected);

    const prevKey = readBrand(settings).favicon?.key;
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(
          coalesce(${tenants.settings}, '{}'::jsonb)
            || jsonb_build_object('brand', coalesce(${tenants.settings} -> 'brand', '{}'::jsonb)),
          array['brand', 'favicon'],
          ${JSON.stringify({ url, key })}::jsonb,
          true
        )`,
      })
      .where(eq(tenants.id, tenantId));

    if (typeof prevKey === 'string' && prevKey && prevKey !== key) {
      await this.storage.delete(prevKey).catch(() => undefined);
    }
    await this.publicCache.del(publicCacheKeys.tenant(slug));
    return { url };
  }

  /** Remove the website icon (reverts to the storefront's static favicon). Idempotent. */
  async deleteFavicon(tenantId: string): Promise<{ ok: true }> {
    const { slug, settings } = await this.loadTenantForMedia(tenantId);
    const prevKey = readBrand(settings).favicon?.key;

    await this.db
      .update(tenants)
      .set({
        settings: sql`coalesce(${tenants.settings}, '{}'::jsonb) #- array['brand', 'favicon']`,
      })
      .where(eq(tenants.id, tenantId));

    if (typeof prevKey === 'string' && prevKey) {
      await this.storage.delete(prevKey).catch(() => undefined);
    }
    await this.publicCache.del(publicCacheKeys.tenant(slug));
    return { ok: true };
  }

  private async loadSettings(tenantId: string): Promise<Record<string, unknown>> {
    const [row] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!row) throw new NotFoundException('Фермата не е намерена');
    return (row.settings as Record<string, unknown> | null) ?? {};
  }

  private async loadTenantForMedia(
    tenantId: string,
  ): Promise<{ slug: string; settings: Record<string, unknown> }> {
    const [row] = await this.db
      .select({ slug: tenants.slug, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!row) throw new NotFoundException('Фермата не е намерена');
    return { slug: row.slug, settings: (row.settings as Record<string, unknown> | null) ?? {} };
  }

  private themeOf(settings: Record<string, unknown>): string | undefined {
    return typeof settings.siteTheme === 'string' ? settings.siteTheme : undefined;
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

/** Carry the stored encrypted Econt password into an incoming delivery blob when
 *  the client didn't send one — so a delivery-settings save doesn't erase creds
 *  the client never sees. */
function preserveEcontSecret(
  existingDelivery: unknown,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const inc = incoming.econt;
  if (!inc || typeof inc !== 'object' || Array.isArray(inc)) return incoming;
  const incEcont = inc as Record<string, unknown>;
  if (incEcont.passwordEnc) return incoming;
  const prevEcont =
    existingDelivery && typeof existingDelivery === 'object' && !Array.isArray(existingDelivery)
      ? (existingDelivery as Record<string, unknown>).econt
      : undefined;
  const prevEnc =
    prevEcont && typeof prevEcont === 'object' && !Array.isArray(prevEcont)
      ? (prevEcont as Record<string, unknown>).passwordEnc
      : undefined;
  if (typeof prevEnc !== 'string' || !prevEnc) return incoming;
  return { ...incoming, econt: { ...incEcont, passwordEnc: prevEnc } };
}

/** Remove Econt secrets (encrypted or plaintext) from a delivery blob before it
 *  leaves the server. The AES-GCM ciphertext is useless without ENCRYPTION_KEY,
 *  but the client never needs it. */
function stripEcontSecrets(delivery: unknown): unknown {
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) return delivery ?? null;
  const d = delivery as Record<string, unknown>;
  const econt = d.econt;
  if (!econt || typeof econt !== 'object' || Array.isArray(econt)) return delivery;
  const { passwordEnc, password, apiPassword, pass, ...safeEcont } = econt as Record<string, unknown>;
  void passwordEnc;
  void password;
  void apiPassword;
  void pass;
  return { ...d, econt: safeEcont };
}

/** Read the raw site-media map (slot key → { url, key }) from a settings blob. */
function readMedia(settings: Record<string, unknown>): Record<string, MediaSlotValue> {
  const m = settings.media;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
  return m as Record<string, MediaSlotValue>;
}

/** Read the raw settings.brand object (favicon + themeColor) from a settings blob. */
function readBrand(settings: Record<string, unknown>): {
  favicon?: { url?: unknown; key?: unknown };
  themeColor?: unknown;
} {
  const b = settings.brand;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return {};
  return b as { favicon?: { url?: unknown; key?: unknown }; themeColor?: unknown };
}

/** Project the stored site-media map to its public shape (drop the R2 `key`). */
export function toPublicMedia(media: unknown): PublicMediaMap {
  if (!media || typeof media !== 'object' || Array.isArray(media)) return {};
  const out: PublicMediaMap = {};
  for (const [k, v] of Object.entries(media as Record<string, unknown>)) {
    const url = (v as { url?: unknown } | null)?.url;
    if (typeof url === 'string' && url) out[k] = { url };
  }
  return out;
}

/** Strip internal fields the client should never see, but surface the delivery
 *  config from `settings` so the admin panel can read its saved settings back. */
function toPublicTenant(t: Tenant): PublicTenant {
  const { stripeAccountId, settings, ...rest } = t;
  const s = settings as Record<string, unknown> | null;
  return { ...rest, delivery: stripEcontSecrets(s?.delivery) ?? null, routing: s?.routing ?? null };
}
