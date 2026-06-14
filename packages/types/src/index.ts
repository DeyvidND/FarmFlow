import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type {
  tenants,
  users,
  products,
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
} from '@farmflow/db';

export type Tenant = InferSelectModel<typeof tenants>;
export type NewTenant = InferInsertModel<typeof tenants>;

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export type Product = InferSelectModel<typeof products>;
export type NewProduct = InferInsertModel<typeof products>;

export type Farmer = InferSelectModel<typeof farmers>;
export type NewFarmer = InferInsertModel<typeof farmers>;

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

export type PublicProduct = Omit<
  Product,
  'tenantId' | 'stockQuantity' | 'stripeProductId' | 'stripePriceId'
> & {
  // Ordered gallery (cover first). Falls back to [imageUrl] for legacy single-image
  // items, or [] when the item has no photo. `imageUrl` stays the cover for back-compat.
  images: string[];
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
 * Tenant profile for the admin panel. `settings` + `stripeAccountId` are stripped,
 * but the delivery config (kept under `settings.delivery`) is surfaced as `delivery`
 * so the panel can hydrate its saved settings. Shape is owned by the client.
 */
export type PublicTenant = Omit<Tenant, 'stripeAccountId' | 'settings'> & {
  delivery?: unknown;
  routing?: unknown;
};

/** Public storefront shapes — tenant_id stripped. `images` = ordered gallery
 *  (cover first), fallback [imageUrl] for legacy single-image rows, else []. */
export type PublicFarmer = Omit<Farmer, 'tenantId' | 'email' | 'phone'> & { images: string[] };
export type PublicSubcategory = Omit<Subcategory, 'tenantId'> & { images: string[] };
export type SafeUser = Omit<User, 'passwordHash'>;

export type TenantRole = 'admin' | 'driver' | 'customer';

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
  mustChangePassword?: boolean;
  // Session epoch — must equal the principal's current tokenVersion in the DB,
  // else the token has been revoked (password change/reset). Absent on legacy
  // pre-feature tokens; treated as 0.
  tv?: number;
  iat?: number;
  exp?: number;
};

export type TenantRequestUser = {
  type: 'tenant';
  userId: string;
  tenantId: string;
  role: TenantRole;
};

export type PlatformRequestUser = {
  type: 'platform';
  adminId: string;
};

export type RequestUser = TenantRequestUser | PlatformRequestUser;

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
