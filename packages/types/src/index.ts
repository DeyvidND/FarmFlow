import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type {
  tenants,
  users,
  products,
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
>;
export type PublicTenant = Omit<Tenant, 'stripeAccountId' | 'settings'>;
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
