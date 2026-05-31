import {
  pgTable,
  pgEnum,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  boolean,
  date,
  time,
  numeric,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const userRoleEnum = pgEnum('user_role', ['admin', 'driver', 'customer']);
export const orderStatusEnum = pgEnum('order_status', [
  'pending',
  'confirmed',
  'preparing',
  'out_for_delivery',
  'delivered',
  'cancelled',
]);
export const subscriptionStatusEnum = pgEnum('subscription_status', ['active', 'inactive']);
export const deliveryTypeEnum = pgEnum('delivery_type', ['address', 'econt']);

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  phone: text('phone'),
  email: text('email'),
  subscriptionStatus: subscriptionStatusEnum('subscription_status').notNull().default('active'),
  subscriptionSince: timestamp('subscription_since'),
  // Farmer opts in to self-delivery; only then do slots surface on the storefront.
  deliveryEnabled: boolean('delivery_enabled').notNull().default(false),
  stripeAccountId: text('stripe_account_id'),
  // Farm origin for delivery-route optimization (nullable until set).
  farmAddress: text('farm_address'),
  farmLat: numeric('farm_lat', { precision: 10, scale: 7 }),
  farmLng: numeric('farm_lng', { precision: 10, scale: 7 }),
  settings: jsonb('settings').default({}),
  createdAt: timestamp('created_at').defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: userRoleEnum('role').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const products = pgTable('products', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  name: text('name').notNull(),
  description: text('description'),
  priceStotinki: integer('price_stotinki').notNull(),
  unit: text('unit').notNull(),
  weight: text('weight'),
  category: text('category'),
  tint: text('tint'),
  // NULL = unlimited stock; 0 = out of stock.
  stockQuantity: integer('stock_quantity').default(0),
  isActive: boolean('is_active').default(true),
  imageUrl: text('image_url'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const deliverySlots = pgTable('delivery_slots', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  date: date('date').notNull(),
  timeFrom: time('time_from').notNull(),
  timeTo: time('time_to').notNull(),
  maxOrders: integer('max_orders').notNull(),
  currentOrders: integer('current_orders').default(0),
  isActive: boolean('is_active').default(true),
});

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  // Guest checkout: customer has no account; identity is snapshotted here.
  customerId: uuid('customer_id').references(() => users.id),
  customerName: text('customer_name'),
  customerPhone: text('customer_phone'),
  customerEmail: text('customer_email'),
  slotId: uuid('slot_id').references(() => deliverySlots.id),
  status: orderStatusEnum('status').default('pending'),
  totalStotinki: integer('total_stotinki').notNull(),
  deliveryType: deliveryTypeEnum('delivery_type').notNull().default('address'),
  deliveryAddress: text('delivery_address'),
  econtOffice: text('econt_office'),
  deliveryLat: numeric('delivery_lat', { precision: 10, scale: 7 }),
  deliveryLng: numeric('delivery_lng', { precision: 10, scale: 7 }),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  orderId: uuid('order_id').references(() => orders.id),
  productId: uuid('product_id').references(() => products.id),
  productName: text('product_name'),
  quantity: integer('quantity').notNull(),
  priceStotinki: integer('price_stotinki').notNull(),
});

// Platform-level admins (FarmFlow staff) — NOT tied to any tenant. Manage all farms.
export const platformAdmins = pgTable('platform_admins', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// Audit trail of admin mutations (who did what, when). Written by AuditInterceptor.
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  userId: uuid('user_id').references(() => users.id),
  action: text('action').notNull(), // HTTP method
  path: text('path').notNull(), // request path
  statusCode: integer('status_code'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const articleStatusEnum = pgEnum('article_status', ['draft', 'published']);
export const articleMediaTypeEnum = pgEnum('article_media_type', [
  'image',
  'video',
  'youtube',
  'instagram',
]);

// Per-farm news feed. Drafts live only in the panel; published rows are served to
// the farm's external storefront via the public API. `sent_at` is an email-ready
// hook (Phase 2) — laid down now, unused.
export const articles = pgTable(
  'articles',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    excerpt: text('excerpt'),
    body: text('body'),
    coverImageUrl: text('cover_image_url'),
    status: articleStatusEnum('status').notNull().default('draft'),
    publishedAt: timestamp('published_at'),
    sentAt: timestamp('sent_at'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (t) => ({
    tenantSlugUnique: uniqueIndex('articles_tenant_slug_unique').on(t.tenantId, t.slug),
    tenantStatusPublishedIdx: index('articles_tenant_status_published_idx').on(
      t.tenantId,
      t.status,
      t.publishedAt,
    ),
  }),
);

// Ordered media blocks for an article. `url` is the R2 url for uploads or the source
// URL for embeds; `embed_id` is the parsed YouTube video id / Instagram shortcode.
export const articleMedia = pgTable(
  'article_media',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    articleId: uuid('article_id').references(() => articles.id),
    // Denormalized for tenant-scoped queries / deletes without a join.
    tenantId: uuid('tenant_id').references(() => tenants.id),
    type: articleMediaTypeEnum('type').notNull(),
    url: text('url').notNull(),
    embedId: text('embed_id'),
    caption: text('caption'),
    position: integer('position').notNull().default(0),
  },
  (t) => ({
    articlePositionIdx: index('article_media_article_position_idx').on(t.articleId, t.position),
  }),
);

// Email-ready scaffold (Phase 2). Created now, empty, no send logic.
export const newsletterSubscribers = pgTable('newsletter_subscribers', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  email: text('email').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  unsubscribedAt: timestamp('unsubscribed_at'),
});

export const schema = {
  tenants,
  users,
  products,
  deliverySlots,
  orders,
  orderItems,
  auditLogs,
  platformAdmins,
  articles,
  articleMedia,
  newsletterSubscribers,
  userRoleEnum,
  orderStatusEnum,
  subscriptionStatusEnum,
  articleStatusEnum,
  articleMediaTypeEnum,
};
