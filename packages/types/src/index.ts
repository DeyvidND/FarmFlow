import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type {
  tenants,
  users,
  products,
  productVariants,
  productBundleItems,
  productAvailabilityWindows,
  farmers,
  subcategories,
  productMedia,
  farmerMedia,
  subcategoryMedia,
  deliverySlots,
  orders,
  orderItems,
  articles,
  articleMedia,
  newsletterSubscribers,
} from '@fermeribg/db';

export type Tenant = InferSelectModel<typeof tenants>;
export type NewTenant = InferInsertModel<typeof tenants>;

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export type Product = InferSelectModel<typeof products>;
export type NewProduct = InferInsertModel<typeof products>;

export type ProductVariant = InferSelectModel<typeof productVariants>;
export type NewProductVariant = InferInsertModel<typeof productVariants>;

export type ProductBundleItem = InferSelectModel<typeof productBundleItems>;
export type NewProductBundleItem = InferInsertModel<typeof productBundleItems>;

export type Farmer = InferSelectModel<typeof farmers>;
export type NewFarmer = InferInsertModel<typeof farmers>;

/**
 * A farmer as returned by the operator CRUD endpoints (GET /farmers, GET/PATCH
 * /farmers/:id). The encrypted signature blob is served only by its dedicated
 * `GET /farmers/:id/signature` endpoint — never in these general payloads (a
 * 13-farmer list carrying megabytes of ciphertext would be pure waste, and the
 * design intent is the blob has exactly one door). Mirrors how `PublicTenant`
 * strips `operatorSignaturePng` below.
 */
export type FarmerRow = Omit<Farmer, 'signaturePng'>;

/**
 * Tier-2 „Бранд идентичност" control layer for a farmer's marketplace subpage.
 * Operator-unlocked, paid. `enabled` is the gate; primary color reuses `farmers.tint`,
 * portrait reuses `farmers.imageUrl`, gallery reuses `farmer_media`. See
 * docs/tier2-brand-identity-spec.md.
 */
export type Tier2Branding = NonNullable<Farmer['branding']>;

/**
 * Legal seller identity for the farmer-as-seller marketplace (each farmer is the
 * legal Продавач). PUBLIC seller disclosure (КЗП): surfaced on the storefront so the
 * buyer knows who they contract with. `kind` selects which id applies — individual
 * (регистриран земеделски производител → `regNo`), sole_trader (ЕТ → `eik`), company
 * (ЕООД/ООД/АД → `eik`, optional `vatNumber`). See farmers.legal in the schema.
 */
export type FarmerLegal = NonNullable<Farmer['legal']>;

/**
 * Shared legal-identity shape for a handover protocol party — either a farmer
 * (`farmers.legal`, see `FarmerLegal` above) or the platform operator
 * (`tenants.settings.legal`, see `TenantSettings` below). Both reference this
 * one type so the handover protocol can treat either side uniformly.
 */
export type LegalIdentity = FarmerLegal;

/**
 * Typed slice of the tenant `settings` jsonb blob (which itself stays untyped —
 * see `VendorFinanceSettings` in server/vendor-finance for the same pattern).
 * `legal` is the operator's own legal identity for the handover protocol,
 * stored at `tenants.settings.legal`.
 */
export interface TenantSettings {
  legal?: LegalIdentity;
}

/**
 * Manual header fields on a consolidated (day/leg) protocol — the paper form's
 * own hand-filled boxes (vehicle, plate, driver, timing). Never derived from
 * orders; `driverName` is SUGGESTED from `route_courier_assignments` when empty
 * but stays independently editable (the car/driver can change the morning of).
 * Stored at `consolidated_protocols.meta` (migration 0113).
 */
export interface ConsolidatedProtocolMeta {
  vehicle?: string;
  plate?: string;
  driverName?: string;
  startPlace?: string;
  startTime?: string;
  plannedEnd?: string;
}

/**
 * A manually-added row on a consolidated protocol — `overrides.extraRows`.
 * `section` says which table it belongs on; the rest is free-form printable
 * cell text (a paper-form escape hatch, not a typed line item).
 */
export interface ConsolidatedProtocolExtraRow {
  section: 'A' | 'B';
  label: string;
  detail?: string;
}

/**
 * Per-row manual correction, keyed by `f:<farmerId>` (section А) or
 * `o:<orderId>` (section Б) in `overrides.fieldOverrides`.
 */
export interface ConsolidatedFieldOverride {
  batch?: string;
  eDoc?: string;
  note?: string;
}

/**
 * A reusable transport (vehicle + driver) the operator saved once and picks
 * from on every consolidated protocol's В.Транспорт form instead of retyping
 * it. Identity fields only — start/end times are per-day (carried/derived by
 * the draft prefill, not part of the preset). Stored as a plain list at
 * `tenants.settings.transportPresets`.
 */
export interface TransportPreset {
  id: string;
  vehicle?: string;
  plate?: string;
  driverName?: string;
  startPlace?: string;
}

/**
 * The `overrides` jsonb layer on `consolidated_protocols` (spec §1.4). Applied
 * on top of the live-computed rows while `status='draft'`; folded into
 * `frozen_rows` at sign time and never consulted again after that.
 */
export interface ConsolidatedProtocolOverrides {
  excludedOrderIds?: string[];
  extraRows?: ConsolidatedProtocolExtraRow[];
  fieldOverrides?: Record<string, ConsolidatedFieldOverride>;
}

/**
 * How a catalog cover image is framed in the storefront. `x`/`y` are the focal
 * point as fractions (0..1) of the source image; `zoom` magnifies (1..3). Stored
 * on `farmers.coverCrop` / `subcategories.coverCrop` / `products.coverCrop`;
 * NULL = centered, no zoom. `shape` (products only) is the card aspect the farmer
 * framed for — the storefront card + admin grid mirror it (square→1:1, tall→4:5,
 * wide/absent→4:3) so what they frame is what shows.
 */
export type CoverCrop = {
  x: number;
  y: number;
  zoom: number;
  shape?: 'wide' | 'square' | 'tall';
};

export type Subcategory = InferSelectModel<typeof subcategories>;
export type NewSubcategory = InferInsertModel<typeof subcategories>;

export type ProductMedia = InferSelectModel<typeof productMedia>;
export type NewProductMedia = InferInsertModel<typeof productMedia>;

export type FarmerMedia = InferSelectModel<typeof farmerMedia>;
export type NewFarmerMedia = InferInsertModel<typeof farmerMedia>;

export type SubcategoryMedia = InferSelectModel<typeof subcategoryMedia>;
export type NewSubcategoryMedia = InferInsertModel<typeof subcategoryMedia>;

export type DeliverySlot = InferSelectModel<typeof deliverySlots>;
export type NewDeliverySlot = InferInsertModel<typeof deliverySlots>;

export type Order = InferSelectModel<typeof orders>;
export type NewOrder = InferInsertModel<typeof orders>;

export type OrderItem = InferSelectModel<typeof orderItems>;
export type NewOrderItem = InferInsertModel<typeof orderItems>;

export type Article = InferSelectModel<typeof articles>;
export type NewArticle = InferInsertModel<typeof articles>;

export type ArticleMedia = InferSelectModel<typeof articleMedia>;
export type NewArticleMedia = InferInsertModel<typeof articleMedia>;

export type NewsletterSubscriber = InferSelectModel<typeof newsletterSubscribers>;
export type NewNewsletterSubscriber = InferInsertModel<typeof newsletterSubscribers>;

/** An article plus its ordered media — the admin GET /articles/:id shape. */
export type ArticleWithMedia = Article & { media: ArticleMedia[] };

/** Public storefront shape: tenant_id stripped from the article and its media. */
export type PublicArticleMedia = Omit<ArticleMedia, 'tenantId' | 'articleId'>;
export type PublicArticle = Omit<Article, 'tenantId' | 'sentAt'> & {
  media: PublicArticleMedia[];
};

/** A variant as exposed to the storefront. Raw stock count is NOT leaked (mirrors
 *  product stockQuantity being stripped) — only `soldOut` + the prices. */
export type PublicProductVariant = {
  id: string;
  label: string;
  priceStotinki: number;
  /** Discounted price when a promo is active; absent otherwise. */
  salePriceStotinki?: number;
  soldOut: boolean;
};

/** A resolved bundle member as exposed to the storefront (task #1). Built by
 *  looking up each product_bundle_items row against the already-built public
 *  products array — no separate private-field stripping needed. */
export type PublicBundleItem = {
  productId: string;
  name: string;
  slug: string | null;
  image: string | null;
  quantity: number;
  priceStotinki: number;
};

/**
 * Public storefront shape: tenant_id + private fields stripped. `salePriceStotinki`
 * is the server-computed discounted headline price (present only while a promo is
 * active). `variants` is empty for products sold without variants.
 */
export type PublicProduct = Omit<
  Product,
  'tenantId' | 'stockQuantity' | 'stripeProductId' | 'stripePriceId' | 'deletedAt' | 'salePriceStotinki'
> & {
  images: string[];
  // Server-computed effective sale price (fixed product-level price OR the
  // %-derived one), present only while a promo is active. Distinct from the raw
  // `products.salePriceStotinki` input column (stripped above).
  salePriceStotinki?: number;
  variants: PublicProductVariant[];
  // True when the product can go on a courier waybill (Econt/Speedy) = !courierDisabled.
  // Positive alias for clear storefront display. (task #11)
  courierShippable: boolean;
  // Resolved member products for category='bundle' products; absent/empty otherwise. (task #1)
  bundleProducts?: PublicBundleItem[];
};

export type AvailabilityWindow = InferSelectModel<typeof productAvailabilityWindows>;
export type NewAvailabilityWindow = InferInsertModel<typeof productAvailabilityWindows>;

/** Active-window overlay the storefront merges onto the public catalog by
 *  `productId`. `tenantId` stripped; only what the storefront needs. */
export type PublicAvailabilityWindow = {
  productId: string;
  startsAt: string;
  endsAt: string;
  quantity: number;
  remaining: number;
};

/**
 * Tenant profile for the admin panel. `settings` + `stripeAccountId` are always
 * stripped; the delivery config (kept under `settings.delivery`) is surfaced as
 * `delivery` so the panel can hydrate its saved settings. Shape is owned by the
 * client. Stripe/billing fields are owner-only — the server omits them entirely
 * for the `driver` role, so they're typed optional here rather than required.
 */
export type PublicTenant = Omit<
  Tenant,
  | 'stripeAccountId' | 'settings' | 'operatorSignaturePng'
  | 'stripeCustomerId' | 'stripeSubscriptionId' | 'subscriptionStatus' | 'subscriptionSince'
  | 'premium' | 'graceUntil'
  | 'stripeChargesEnabled' | 'stripePayoutsEnabled' | 'stripeDetailsSubmitted' | 'stripeStatusUpdatedAt'
> & {
  stripeCustomerId?: Tenant['stripeCustomerId'];
  stripeSubscriptionId?: Tenant['stripeSubscriptionId'];
  subscriptionStatus?: Tenant['subscriptionStatus'];
  subscriptionSince?: Tenant['subscriptionSince'];
  premium?: Tenant['premium'];
  graceUntil?: Tenant['graceUntil'];
  stripeChargesEnabled?: Tenant['stripeChargesEnabled'];
  stripePayoutsEnabled?: Tenant['stripePayoutsEnabled'];
  stripeDetailsSubmitted?: Tenant['stripeDetailsSubmitted'];
  stripeStatusUpdatedAt?: Tenant['stripeStatusUpdatedAt'];
  delivery?: unknown;
  routing?: unknown;
  sms?: { dayOfReminder: boolean };
};

/** Public storefront shapes — tenant_id stripped. `images` = ordered gallery
 *  (cover first), fallback [imageUrl] for legacy single-image rows, else []).
 *  `email`/`phone` ARE included deliberately — the farmer subpage shows each
 *  farmer's own contact (site-wide official contact stays the tenant's, kept
 *  separate). Product decision made 2026-07-02; see farmers.service.ts.
 *  `commissionRateBps`/`subscriptionFeeStotinki` (the operator's commercial
 *  terms with this farmer) are owner/admin-only — NEVER the storefront's.
 *  `internalNotes`/`payout` are operator-only too (private notes, bank payout
 *  details) — NEVER the storefront's. `story` (the "За фермата" long bio) IS
 *  public and stays in. */
export type PublicFarmer = Omit<
  Farmer,
  'tenantId' | 'commissionRateBps' | 'subscriptionFeeStotinki' | 'lat' | 'lng' | 'geocodedAt'
  | 'internalNotes' | 'payout' | 'signaturePng'
> & {
  images: string[];
  /** Phase 2: farmer offers nationwide courier (≥1 carrier connected). */
  courierReady: boolean;
  /** Approximate map pin — geocoded from address/city, or manually overridden.
   *  `null` when no location is known yet. Farmer.lat/lng are Drizzle numeric
   *  columns (`string | null`); re-declared here as `number | null` because the
   *  public projection converts to number for the storefront map — hence 'lat' |
   *  'lng' stay in the Omit above (TS can't narrow a same-named intersection
   *  member, it only conjoins the two types). */
  lat: number | null;
  lng: number | null;
};
export type PublicSubcategory = Omit<Subcategory, 'tenantId'> & { images: string[] };
export type SafeUser = Omit<User, 'passwordHash'>;

export type TenantRole = 'admin' | 'driver' | 'customer' | 'farmer';

/**
 * JWT body. `type` discriminates platform admins from tenant users; absent =
 * legacy tenant token (treated as 'tenant'). Platform tokens carry only `sub`
 * (the platform admin id).
 */
export type JwtPayload = {
  sub: string;
  type?: 'tenant' | 'platform';
  tenantId?: string;
  role?: TenantRole;
  /** Present only on producer sub-account tokens (role='farmer'): the farmers.id
   *  this login is scoped to. */
  farmerId?: string;
  /** Present only on driver logins bound to a courier leg (role='driver'):
   *  the 0-based courier index into settings.routing.couriers[]. */
  courierIndex?: number;
  mustChangePassword?: boolean;
  // Session epoch — must equal the principal's current tokenVersion in the DB,
  // else the token has been revoked (password change/reset). Absent on legacy
  // pre-feature tokens; treated as 0.
  tv?: number;
  /** Set only on an impersonation session minted by a platform admin — the acting super-admin's id, for attribution. */
  actingAdminId?: string;
  iat?: number;
  exp?: number;
};

export type TenantRequestUser = {
  type: 'tenant';
  userId: string;
  tenantId: string;
  role: TenantRole;
  /** Producer scope for role='farmer' (else undefined). */
  farmerId?: string;
  /** Courier-leg scope for role='driver' (else undefined). */
  courierIndex?: number;
  /** Present only on an impersonation session — the acting super-admin's id. */
  actingAdminId?: string;
};

export type PlatformRequestUser = {
  type: 'platform';
  adminId: string;
};

export type RequestUser = TenantRequestUser | PlatformRequestUser;

// ── Route leg indexing (brands) ─────────────────────────────────────────────
/**
 * A REAL courier/leg number — what `orders.courierIndex`, a
 * `route_courier_assignments.leg_index`, every index into
 * `settings.routing.couriers[]`, and a route's emitted `courierIndex` all mean.
 *
 * A day's legs can be NON-CONTIGUOUS: the assignment board lets each roster row
 * pick any leg, so legs [0, 2] (nobody on leg 1) is a normal shape, while the
 * emitted `routes[]` array stays DENSE. A leg's POSITION in that dense array is
 * therefore NOT its leg number ({@link LegPos}). Conflating the two has been
 * fixed three times server-side and twice in the client courier modals; these
 * brands make the mix-up a compile error rather than a silent runtime bug (a
 * driver on a non-contiguous leg seeing zero stops, a pin landing on the wrong
 * courier, a leg ending at another courier's home).
 *
 * The client (`@fermeribg/web`) deliberately does not depend on this package and
 * mirrors these declarations in `client/src/lib/types.ts` — keep them in sync.
 */
export type LegIndex = number & { readonly __brand: 'LegIndex' };

/** A POSITION in the DENSE `routes[]` array. Never index `couriers[]` / a real
 *  leg map with this — that's exactly the bug the brands guard against. */
export type LegPos = number & { readonly __brand: 'LegPos' };

/** Assert a number is a real leg number (e.g. a stored `courierIndex`). */
export const asLegIndex = (n: number): LegIndex => n as LegIndex;

/** Assert a number is a dense `routes[]` position. */
export const asLegPos = (n: number): LegPos => n as LegPos;

// ── Newsletter block-builder ───────────────────────────────────────────────
// Structured email content. Persisted as JSON on newsletter_campaigns.blocks and
// rendered to email-safe HTML by the server (renderEmail). `image` fields hold
// absolute https R2/CDN urls; `html` fields are server-sanitized Quill output.
export type NewsletterColumn =
  | { kind: 'text'; html: string }
  | { kind: 'image'; image: string; alt?: string };

export type NewsletterBlock =
  | { type: 'hero'; image: string; alt?: string; href?: string }
  | { type: 'heading'; text: string; level?: 1 | 2 }
  | { type: 'text'; html: string }
  | { type: 'image'; image: string; alt?: string; href?: string; caption?: string }
  | { type: 'button'; label: string; href: string }
  | { type: 'columns'; left: NewsletterColumn; right: NewsletterColumn }
  | { type: 'divider' }
  | { type: 'spacer'; size?: 'sm' | 'md' | 'lg' };

export interface NewsletterCampaign {
  id: string;
  subject: string;
  blocks: NewsletterBlock[];
  status: 'draft' | 'sent';
  recipientCount: number | null;
  priceStotinki: number | null;
  sentAt: string | null;
  updatedAt: string | null;
}

export interface NewsletterQuote {
  activeCount: number;
  perRecipientMicro: number;
  sendCostStotinki: number;
  monthToDateCount: number;
  monthToDateStotinki: number;
  premium: boolean;
}
