import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { type Database, tenants, products } from '@fermeribg/db';
import { jsonbDeepMerge } from '../../common/db/jsonb';
import type { PublicTenant, Tenant, LegalIdentity, TenantRole } from '@fermeribg/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { MapsService } from '../../common/maps/maps.service';
import { PublicCacheService, publicCacheKeys } from '../../common/cache/public-cache.service';
import { StorageService } from '../storage/storage.service';
import { PRODUCT_IMAGE_EXT_BY_MIME } from '../storage/dto/upload-image.dto';
import { optimizeImage, squareFavicon } from '../storage/image.util';
import { sniffMime } from '../storage/magic-mime';
import { type PublicDelivery, type PublicMethods, type PublicPickup, type PublicOwnSlots, type EcontMode } from '../orders/delivery-pricing';
import { StripeService } from '../stripe/stripe.service';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { SiteContactDto } from './dto/site-contact.dto';
import { SiteMarketingDto } from './dto/site-marketing.dto';
import { LandingDto } from './dto/landing.dto';
import { resolveLanding, type PublicLanding } from './landing';
import { MerchandisingDto } from './dto/merchandising.dto';
import { resolveMerchandising, type PublicMerchandising } from './merchandising';
import {
  buildPublicMarketing,
  normalizeMarketing,
  type PublicMarketing,
} from './site-marketing';
import {
  buildPublicContact,
  normalizeSiteContact,
  type PublicContact,
} from './site-contact';
import { buildPublicCopy, buildPublicFaq, cleanCopy, normalizeFaq, sanitizeSiteUrl, isValidSlotKey, type PublicFaqItem } from './site-copy';
import { SiteEditContentDto } from './dto/site-edit-content.dto';
import { LegalDto } from './dto/legal.dto';
import { normalizeLegal } from './legal';
import { parseSmsSettings } from './sms-settings';
import { encryptSignature, decryptSignature, SignatureKeyMissingError } from '../../common/crypto/signature-crypto';

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
  // «Продукт на седмицата» highlight config — carried through from TenantMeta so
  // the bootstrap endpoint can resolve the featured product without a re-read or
  // an unchecked cast. Structurally matches ProductOfWeekConfig.
  productOfWeekEnabled: boolean;
  productOfWeekMode: string;
  productOfWeekId: string | null;
  productOfWeekNote: string | null;
  productOfWeekPlacement: string;
  // «Фермер на седмицата» pointer (settings.farmerOfWeek). Null when unset. The
  // bootstrap endpoint validates the id against the public farmer list.
  farmerOfWeek: { farmerId?: string | null; note?: string | null } | null;
  delivery: PublicDelivery;
  methods: PublicMethods;
  pickup: PublicPickup;
  ownSlots: PublicOwnSlots;
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
  // Configurable landing blocks (settings.landing) — which of the three dynamic
  // home blocks show and how many items each shows. Always present (resolved).
  landing: PublicLanding;
  // Merchandising toggles (settings.merchandising) — the „Най-продавани" shop chip
  // and the „Често купувано заедно" cart picks. Always present (resolved).
  merchandising: PublicMerchandising;
  // Per-vendor ad/analytics tracking IDs (settings.marketing). Empty → all-null
  // (no scripts injected). The storefront templates the loader from the id.
  marketing: PublicMarketing;
  // Editable body copy (settings.copy) — slot key → override text. Empty/missing
  // slot → the storefront renders its inline default. Theme-cleaned.
  copy: Record<string, string>;
  // Editable FAQ list (settings.faq). Empty → storefront falls back to DEFAULT_FAQ.
  faq: PublicFaqItem[];
  // Weekly order-intake cutoff for the storefront banner (settings.routing.cutoff),
  // carried through from TenantMeta. Null if unset.
  orderCutoff: { weekday: number; hour: number } | null;
}

@Injectable()
export class TenantsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly maps: MapsService,
    private readonly publicCache: PublicCacheService,
    private readonly storage: StorageService,
    private readonly stripe: StripeService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async getMe(tenantId: string, role?: TenantRole): Promise<PublicTenant> {
    const [row] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!row) throw new NotFoundException('Фермата не е намерена');
    return toPublicTenant(row, role);
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
    const { id: _id, stripeAccountId, cardEnabled, stripeChargesEnabled, ...profile } =
      await this.publicCache.resolveTenant(this.db, slug);
    // Card is offered only when the Stripe account is linked AND actually able to
    // charge (onboarding complete → charges_enabled) AND the farmer hasn't turned
    // card off (the COD-only override). Linked-but-not-live accounts must NOT show
    // card, or the buyer would pick it and the payment would fail. `cardEnabled`
    // and `stripeChargesEnabled` stay internal — stripped here.
    return {
      ...profile,
      stripeEnabled:
        this.stripe.isEnabledForAccount(stripeAccountId) && stripeChargesEnabled && cardEnabled,
    };
  }

  async updateMe(tenantId: string, dto: UpdateTenantDto): Promise<PublicTenant> {
    // `delivery`, `routing`, `sms` aren't columns — they merge into `settings` jsonb.
    const { delivery, routing, sms, farmAddress, farmLat, farmLng, ...flat } = dto;
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
        // Re-geocode the typed address. On failure CLEAR the old coords rather
        // than leaving them: a changed address with a stale pin would silently
        // route from the wrong origin. Cleared coords show the farm un-mapped so
        // the farmer re-pins (mirrors the custom route-end in resolveRouting).
        const geo = await this.maps.geocode(farmAddress);
        set.farmLat = geo ? String(geo.lat) : null;
        set.farmLng = geo ? String(geo.lng) : null;
      } else {
        // Address cleared → drop the pin too.
        set.farmLat = null;
        set.farmLng = null;
      }
    } else if (farmLat != null && farmLng != null) {
      set.farmLat = String(farmLat);
      set.farmLng = String(farmLng);
    }

    if (delivery !== undefined || routing !== undefined || sms !== undefined) {
      const [cur] = await this.db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      if (!cur) throw new NotFoundException('Фермата не е намерена');
      const existing = (cur.settings as Record<string, unknown> | null) ?? {};
      // Write each touched sub-key with an ATOMIC path-merge instead of rewriting the
      // WHOLE settings blob. A concurrent atomic write to a SIBLING key (settings.
      // marketing / brand.favicon / farmerOfWeek / landing / media — all jsonb_set)
      // committed during this method's read→geocode→write window is no longer reverted.
      // (The `delivery` sub-tree is still written wholesale, so a concurrent per-farmer
      // carrier-cred save under delivery.farmers.* can still be clobbered — a narrower
      // race than the top-level-key clobber this closes.)
      let settingsExpr: SQL = sql`${tenants.settings}`;
      let settingsTouched = false;
      const mergeInto = (key: string, value: unknown) => {
        settingsExpr = jsonbDeepMerge(settingsExpr, [key], value);
        settingsTouched = true;
      };
      if (delivery !== undefined) {
        // Carry the encrypted Econt password over from storage — the client no
        // longer receives it (toPublicTenant strips it), so a plain
        // delivery-settings save must not wipe it.
        mergeInto('delivery', applyDeliverySecrets(existing.delivery, delivery));
      }
      if (routing !== undefined) {
        mergeInto('routing', await this.resolveRouting(existing.routing, routing));
      }
      if (sms !== undefined) {
        // Sanitize to the keys we support; never store arbitrary ones. PARTIAL:
        // only touch a key the payload actually carries, so saving the send-hour
        // alone doesn't clobber the master toggle (and vice-versa).
        const curSms = (existing.sms as Record<string, unknown> | undefined) ?? {};
        const nextSms: Record<string, unknown> = { ...curSms };
        const payload = sms as { dayOfReminder?: unknown; sendHour?: unknown };
        if ('dayOfReminder' in payload) {
          nextSms.dayOfReminder = payload.dayOfReminder === true;
        }
        if ('sendHour' in payload) {
          const h = Number(payload.sendHour);
          // Ignore out-of-range/garbage — leave the stored value (or default) intact.
          if (Number.isInteger(h) && h >= 0 && h <= 23) nextSms.sendHour = h;
        }
        mergeInto('sms', nextSms);
      }
      if (settingsTouched) set.settings = settingsExpr;
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

  /** Upload (or replace) the photo for one slot. Validates the slot key by pattern,
   *  stores under a tenant-scoped R2 key, drops any previous object, and busts the
   *  public profile cache. */
  async setSiteMedia(
    tenantId: string,
    slotKey: string,
    file: Express.Multer.File,
  ): Promise<{ slotKey: string; url: string }> {
    const { slug, settings } = await this.loadTenantForMedia(tenantId);
    if (!isValidSlotKey(slotKey)) {
      throw new BadRequestException('Непознат слот');
    }

    const img = await optimizeImage(
      file.buffer,
      file.mimetype,
      PRODUCT_IMAGE_EXT_BY_MIME[file.mimetype] ?? 'bin',
    );
    const key = `tenants/${slug}/site/${slotKey}/${randomUUID()}.${img.ext}`;
    const { url } = await this.storage.upload(img.buffer, key, img.contentType);

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

  // ---- Edit-session token ----

  /** Edit-session tokens use a derived secret so they can't be replayed as auth
   *  tokens (mirrors auth.service resetSecret). */
  private editSecret(): string {
    return `${this.config.getOrThrow<string>('JWT_SECRET')}::siteedit`;
  }

  /** Issue a short-lived, tenant-scoped token for the storefront edit overlay.
   *  Returns the token + the farm's storefront URL (set by the operator). */
  async createEditSession(
    tenantId: string,
  ): Promise<{ token: string; siteUrl: string; expiresIn: number }> {
    const { settings } = await this.loadTenantForMedia(tenantId);
    const siteUrl = sanitizeSiteUrl(settings.siteUrl);
    if (!siteUrl) {
      throw new BadRequestException('Адресът на сайта не е зададен. Свържи се с поддръжката.');
    }
    const token = await this.jwt.signAsync(
      { sub: tenantId, type: 'site-edit' },
      { secret: this.editSecret(), expiresIn: '30m' },
    );
    return { token, siteUrl, expiresIn: 1800 };
  }

  // ---- Site copy (editable storefront text + FAQ) ----

  /** Current overrides for the inline editor (no siteUrl — operator-managed). */
  async getSiteEditData(tenantId: string): Promise<{
    copy: Record<string, string>;
    media: Record<string, { url: string }>;
    faq: PublicFaqItem[];
  }> {
    const settings = await this.loadSettings(tenantId);
    return {
      copy: buildPublicCopy(settings.copy),
      media: toPublicMedia(settings.media),
      faq: buildPublicFaq(settings.faq),
    };
  }

  /** Write copy + faq (slot content only) atomically; siteUrl untouched. */
  async setSiteCopyContent(
    tenantId: string,
    dto: SiteEditContentDto,
  ): Promise<{ copy: Record<string, string>; faq: PublicFaqItem[] }> {
    const { slug } = await this.loadTenantForMedia(tenantId);
    const copy = cleanCopy(dto.copy);
    const faq = normalizeFaq(dto.faq);
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(
          jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['copy'], ${JSON.stringify(copy)}::jsonb, true),
          array['faq'], ${JSON.stringify(faq)}::jsonb, true)`,
      })
      .where(eq(tenants.id, tenantId));
    await this.publicCache.del(publicCacheKeys.tenant(slug));
    return { copy, faq };
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

  // ---- Operator legal identity (handover-protocol приел/предал party) ----

  /** Current operator legal identity, or null if never set. */
  async getLegal(tenantId: string): Promise<LegalIdentity | null> {
    const settings = await this.loadSettings(tenantId);
    return (settings.legal as LegalIdentity | undefined) ?? null;
  }

  /** Atomic write to settings.legal. */
  async updateLegal(tenantId: string, dto: LegalDto): Promise<LegalIdentity> {
    const legal = normalizeLegal(dto);
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['legal'], ${JSON.stringify(legal)}::jsonb, true)`,
      })
      .where(eq(tenants.id, tenantId));
    return legal;
  }

  // ---- Operator signature (handover-protocol приел/предал auto-sign) ----

  /** Operator's saved signature, decrypted, for the settings preview + auto-sign. */
  async getSignature(tenantId: string): Promise<{ signaturePng: string | null }> {
    const [row] = await this.db
      .select({ signaturePng: tenants.operatorSignaturePng })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return { signaturePng: decryptSignature(row?.signaturePng ?? null) };
  }

  /** Store (encrypted) or clear the operator's reusable signature. Refuses to store
   *  anything when ENCRYPTION_KEY is unset — a signature is never persisted in
   *  plaintext. Clearing (png === null) stays allowed with no key. */
  async setSignature(tenantId: string, png: string | null): Promise<{ signaturePng: string | null }> {
    let enc: string | null = null;
    if (png) {
      try {
        enc = encryptSignature(png);
      } catch (e) {
        if (e instanceof SignatureKeyMissingError) {
          throw new ServiceUnavailableException(
            'Подписът не може да бъде запазен — липсва ключ за криптиране на сървъра.',
          );
        }
        throw e;
      }
    }
    await this.db
      .update(tenants)
      .set({ operatorSignaturePng: enc })
      .where(eq(tenants.id, tenantId));
    return { signaturePng: png };
  }

  // ---- Landing-page blocks (settings.landing) ----

  /** Current landing config for the admin editor (resolved + clamped). */
  async getLanding(tenantId: string): Promise<{ landing: PublicLanding }> {
    const settings = await this.loadSettings(tenantId);
    return { landing: resolveLanding(settings.landing) };
  }

  /** Replace settings.landing with the resolved (clamped) incoming config in a
   *  single atomic per-path write, then bust the cached public profile. */
  async updateLanding(tenantId: string, dto: LandingDto): Promise<{ landing: PublicLanding }> {
    const { slug } = await this.loadTenantForMedia(tenantId);
    const landing = resolveLanding(dto);
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['landing'], ${JSON.stringify(landing)}::jsonb, true)`,
      })
      .where(eq(tenants.id, tenantId));
    // settings.landing.reviews.ids drives the cached home-reviews block — a re-pick
    // (or toggling the block) must bust it alongside the profile cache.
    await this.publicCache.del(
      publicCacheKeys.tenant(slug),
      publicCacheKeys.homeReviews(tenantId),
    );
    return { landing };
  }

  // ---- Merchandising toggles (settings.merchandising) ----

  /** Current merchandising config for the admin editor (resolved). */
  async getMerchandising(tenantId: string): Promise<{ merchandising: PublicMerchandising }> {
    const settings = await this.loadSettings(tenantId);
    return { merchandising: resolveMerchandising(settings.merchandising) };
  }

  /** Replace settings.merchandising with the resolved incoming config in a single
   *  atomic per-path write, then bust the cached public profile so the storefront
   *  shows/hides the best-sellers chip + cart recs on its next render. */
  async updateMerchandising(
    tenantId: string,
    dto: MerchandisingDto,
  ): Promise<{ merchandising: PublicMerchandising }> {
    const { slug } = await this.loadTenantForMedia(tenantId);
    const merchandising = resolveMerchandising(dto);
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['merchandising'], ${JSON.stringify(merchandising)}::jsonb, true)`,
      })
      .where(eq(tenants.id, tenantId));
    await this.publicCache.del(publicCacheKeys.tenant(slug));
    return { merchandising };
  }

  // ---- Marketing / tracking IDs (settings.marketing) ----

  /** Current tracking IDs for the admin editor (validated, malformed → null). */
  async getMarketing(tenantId: string): Promise<{ marketing: PublicMarketing }> {
    const settings = await this.loadSettings(tenantId);
    return { marketing: buildPublicMarketing(settings.marketing) };
  }

  /** Replace the whole settings.marketing block with the validated incoming IDs
   *  in a single atomic per-path write, then bust the cached public profile so
   *  the storefront picks up the new (or cleared) IDs on its next render. */
  async updateMarketing(
    tenantId: string,
    dto: SiteMarketingDto,
  ): Promise<{ marketing: PublicMarketing }> {
    const { slug } = await this.loadTenantForMedia(tenantId);
    const marketing = normalizeMarketing(dto);
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['marketing'], ${JSON.stringify(marketing)}::jsonb, true)`,
      })
      .where(eq(tenants.id, tenantId));
    await this.publicCache.del(publicCacheKeys.tenant(slug));
    return { marketing: buildPublicMarketing(marketing) };
  }

  /** Upload/replace the website icon. PNG or ICO only — verified by magic bytes
   *  (the declared mime is spoofable). Stored at brand.favicon = { url, key }. */
  async setFavicon(tenantId: string, file: Express.Multer.File): Promise<{ url: string }> {
    const { slug, settings } = await this.loadTenantForMedia(tenantId);

    const detected = sniffMime(file.buffer);
    if (detected !== 'image/png' && detected !== 'image/x-icon') {
      throw new BadRequestException('Иконата трябва да е PNG или ICO файл.');
    }
    // Center-crop/resize to a proper square icon — an arbitrary-aspect-ratio
    // logo/banner upload renders fine in a browser tab but Google's favicon
    // crawler rejects it and shows a generic globe instead.
    const processed = await squareFavicon(file.buffer, detected);
    const ext = detected === 'image/png' ? 'png' : 'ico';
    const key = `tenants/${slug}/site/favicon/${randomUUID()}.${ext}`;
    // Upload with the *detected* (canonical) content type, not the client header.
    const { url } = await this.storage.upload(processed, key, detected);

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
    // Geocode the route-end address and every courier's home address concurrently —
    // independent (cache-first) Google Maps lookups that previously ran in series.
    // Each branch keeps its own guard, so a missing field leaves `next` untouched.
    const endTask = (async (): Promise<void> => {
      if (!('endAddress' in routing)) return;
      const endAddress = (routing.endAddress as string | null) ?? '';
      if (endAddress) {
        const geo = await this.maps.geocode(endAddress);
        next.endLat = geo ? String(geo.lat) : null;
        next.endLng = geo ? String(geo.lng) : null;
      } else {
        next.endLat = null;
        next.endLng = null;
      }
    })();
    // Per-courier home „У дома" (task #7): geocode each courier's homeAddress into
    // homeLat/homeLng when the client sent an address without coords (typed, not
    // map-picked); clear the coords when the address is removed. The client sends
    // the FULL couriers array (index-aligned), so it replaces the stored one.
    const couriersTask = Array.isArray(routing.couriers)
      ? Promise.all(
          (routing.couriers as unknown[]).map(async (c) => {
            if (!c || typeof c !== 'object' || Array.isArray(c)) return c;
            const cfg = { ...(c as Record<string, unknown>) };
            const homeAddress = typeof cfg.homeAddress === 'string' ? cfg.homeAddress.trim() : '';
            const hasCoords = cfg.homeLat != null && cfg.homeLng != null;
            if (homeAddress && !hasCoords) {
              const geo = await this.maps.geocode(homeAddress);
              cfg.homeLat = geo ? String(geo.lat) : null;
              cfg.homeLng = geo ? String(geo.lng) : null;
            } else if (!homeAddress) {
              cfg.homeLat = null;
              cfg.homeLng = null;
            }
            // Per-courier START override — same geocode-on-typed-address contract
            // as the home above (map-picked coords pass through untouched; a
            // cleared address clears the coords so the leg falls back to the base).
            const startAddress = typeof cfg.startAddress === 'string' ? cfg.startAddress.trim() : '';
            const hasStartCoords = cfg.startLat != null && cfg.startLng != null;
            if (startAddress && !hasStartCoords) {
              const geo = await this.maps.geocode(startAddress);
              cfg.startLat = geo ? String(geo.lat) : null;
              cfg.startLng = geo ? String(geo.lng) : null;
            } else if (!startAddress) {
              cfg.startLat = null;
              cfg.startLng = null;
            }
            return cfg;
          }),
        )
      : null;
    const [, couriersResult] = await Promise.all([endTask, couriersTask]);
    if (couriersResult) next.couriers = couriersResult;
    return next;
  }
}

/** Carrier keys whose credential fields live in settings.delivery and must never
 *  be client-writable: the encrypted password slot is owned solely by each
 *  carrier service's saveCredentials. Add a carrier here and it's covered on every
 *  path (sanitize-in, preserve, strip-out) at once. */
const CARRIER_KEYS = ['econt', 'speedy'] as const;
type CarrierKey = (typeof CARRIER_KEYS)[number];

/** Strip every credential field (plaintext + `passwordEnc`) from one carrier blob. */
function stripCarrierCreds(carrier: Record<string, unknown>): Record<string, unknown> {
  const { password, apiPassword, pass, passwordEnc, ...safe } = carrier;
  void password;
  void apiPassword;
  void pass;
  void passwordEnc;
  return safe;
}

/**
 * Never persist carrier API secrets in the settings.delivery jsonb. The normal
 * client keeps the password in local state and only sends non-secret config
 * (`configured`, sender, package…), but enforce it server-side so no caller (or
 * attacker) can stash a courier password in the blob. Applies to every carrier in
 * CARRIER_KEYS so adding a carrier can't silently reopen the hole.
 */
function sanitizeDelivery(delivery: Record<string, unknown>): Record<string, unknown> {
  const out = { ...delivery };
  for (const key of CARRIER_KEYS) {
    const c = out[key];
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      out[key] = stripCarrierCreds(c as Record<string, unknown>);
    }
  }
  return out;
}

/** Carry the stored encrypted password for one carrier into an incoming delivery
 *  blob when the client didn't send one — so a delivery-settings save doesn't erase
 *  creds the client never sees (they get stripped on the way out). */
function preserveCarrierSecret(
  existingDelivery: unknown,
  incoming: Record<string, unknown>,
  key: CarrierKey,
): Record<string, unknown> {
  const inc = incoming[key];
  if (!inc || typeof inc !== 'object' || Array.isArray(inc)) return incoming;
  const incCarrier = inc as Record<string, unknown>;
  if (incCarrier.passwordEnc) return incoming;
  const prevCarrier =
    existingDelivery && typeof existingDelivery === 'object' && !Array.isArray(existingDelivery)
      ? (existingDelivery as Record<string, unknown>)[key]
      : undefined;
  const prevEnc =
    prevCarrier && typeof prevCarrier === 'object' && !Array.isArray(prevCarrier)
      ? (prevCarrier as Record<string, unknown>).passwordEnc
      : undefined;
  if (typeof prevEnc !== 'string' || !prevEnc) return incoming;
  return { ...incoming, [key]: { ...incCarrier, passwordEnc: prevEnc } };
}

/** The single delivery-secrets entry point updateMe uses: strip any client-sent
 *  creds, then carry every carrier's stored secret forward. */
export function applyDeliverySecrets(
  existingDelivery: unknown,
  delivery: Record<string, unknown>,
): Record<string, unknown> {
  let next = sanitizeDelivery(delivery);
  for (const key of CARRIER_KEYS) next = preserveCarrierSecret(existingDelivery, next, key);
  return next;
}

/** Remove carrier secrets (encrypted or plaintext) from a delivery blob before it
 *  leaves the server. The AES-GCM ciphertext is useless without ENCRYPTION_KEY, but
 *  the client never needs it. */
export function stripCarrierSecrets(delivery: unknown): unknown {
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) return delivery ?? null;
  const d = { ...(delivery as Record<string, unknown>) };
  for (const key of CARRIER_KEYS) {
    const c = d[key];
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      d[key] = stripCarrierCreds(c as Record<string, unknown>);
    }
  }
  return d;
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
 *  config from `settings` so the admin panel can read its saved settings back.
 *  Stripe/billing fields (customer/subscription ids, subscription status,
 *  premium, grace period, charges/payouts flags) are owner-only — `role`
 *  gates them out for the lower-trust `driver` login (often an externally
 *  hired courier), which otherwise has no legitimate reason to see them. */
function toPublicTenant(t: Tenant, role?: TenantRole): PublicTenant {
  const {
    stripeAccountId, settings,
    stripeCustomerId, stripeSubscriptionId, subscriptionStatus, subscriptionSince,
    premium, graceUntil, stripeChargesEnabled, stripePayoutsEnabled,
    stripeDetailsSubmitted, stripeStatusUpdatedAt,
    // The operator's stored signature is an encrypted blob served only by its own
    // dedicated endpoint (GET /tenants/me/signature). getMe is reachable by the
    // 'farmer' and 'driver' roles too, and `...rest` would otherwise hand them the
    // ciphertext on every call.
    operatorSignaturePng: _operatorSignaturePng,
    ...rest
  } = t;
  const s = settings as Record<string, unknown> | null;
  const billing = role === 'driver' ? {} : {
    stripeCustomerId, stripeSubscriptionId, subscriptionStatus, subscriptionSince,
    premium, graceUntil, stripeChargesEnabled, stripePayoutsEnabled,
    stripeDetailsSubmitted, stripeStatusUpdatedAt,
  };
  return {
    ...rest,
    ...billing,
    delivery: stripCarrierSecrets(s?.delivery) ?? null,
    routing: s?.routing ?? null,
    sms: parseSmsSettings(settings),
  };
}
