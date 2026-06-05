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
// Delivery methods:
//  - `address`       → the farm's own (local) delivery to a street address: slots,
//                      route optimization, flat regional fee. Local only.
//  - `econt`         → Econt courier to an office (nationwide; live-priced).
//  - `econt_address` → Econt courier to a home address / door (nationwide; live-priced).
export const deliveryTypeEnum = pgEnum('delivery_type', ['address', 'econt', 'econt_address']);

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
  // Optional catalog groupings — when on, the matching admin page + product link
  // field + storefront grouping/attribution activate. Default off.
  multiFarmer: boolean('multi_farmer').notNull().default(false),
  multiSubcat: boolean('multi_subcat').notNull().default(false),
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
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow(),
});

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    name: text('name').notNull(),
    // URL key for the storefront product page (/product/[slug]). Unique per
    // tenant; nullable-safe (admin-created rows may lack one until set).
    slug: text('slug'),
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
    // Optional multi-producer + section grouping links (admin toggles). FK SET NULL
    // on delete so removing a farmer/subcategory just unlinks its products.
    farmerId: uuid('farmer_id').references(() => farmers.id, { onDelete: 'set null' }),
    subcategoryId: uuid('subcategory_id').references(() => subcategories.id, {
      onDelete: 'set null',
    }),
    // Synced ids for the farm's Stripe catalog (per connected account). Set by
    // StripeService.syncCatalog; NULL until synced (checkout falls back to
    // inline price_data so it never blocks).
    stripeProductId: text('stripe_product_id'),
    stripePriceId: text('stripe_price_id'),
    // Bundles (category='bundle'): the curated contents (one line each, e.g.
    // "Малини 250 г"), the struck-through "old" price, and a featured flag for
    // the "★ Най-популярен" ribbon. NULL/false for regular products.
    bundleItems: jsonb('bundle_items').$type<string[]>(),
    compareAtPriceStotinki: integer('compare_at_price_stotinki'),
    featured: boolean('featured').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    tenantSlugUnique: uniqueIndex('products_tenant_slug_unique').on(t.tenantId, t.slug),
    // Admin list + public catalog both filter by tenant and sort by createdAt.
    tenantCreatedIdx: index('products_tenant_created_idx').on(t.tenantId, t.createdAt),
  }),
);

export const deliverySlots = pgTable(
  'delivery_slots',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    date: date('date').notNull(),
    timeFrom: time('time_from').notNull(),
    timeTo: time('time_to').notNull(),
    maxOrders: integer('max_orders').notNull(),
    currentOrders: integer('current_orders').default(0),
    isActive: boolean('is_active').default(true),
  },
  // Slot lists + dashboard summary filter by tenant, usually over a date window.
  (t) => ({
    tenantDateIdx: index('delivery_slots_tenant_date_idx').on(t.tenantId, t.date),
  }),
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    // Guest checkout: customer has no account; identity is snapshotted here.
    customerId: uuid('customer_id').references(() => users.id),
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    customerEmail: text('customer_email'),
    slotId: uuid('slot_id').references(() => deliverySlots.id),
    status: orderStatusEnum('status').default('pending'),
    // Human-friendly per-tenant order number (#1, #2, …) shown to the farmer and
    // customer. Assigned on create; NULL only on legacy rows until backfilled.
    orderNumber: integer('order_number'),
    totalStotinki: integer('total_stotinki').notNull(),
    deliveryType: deliveryTypeEnum('delivery_type').notNull().default('address'),
    deliveryAddress: text('delivery_address'),
    // Settlement for Econt door delivery (the structured city Econt needs to route
    // a waybill to an address). NULL for office/local delivery.
    deliveryCity: text('delivery_city'),
    econtOffice: text('econt_office'),
    deliveryLat: numeric('delivery_lat', { precision: 10, scale: 7 }),
    deliveryLng: numeric('delivery_lng', { precision: 10, scale: 7 }),
    notes: text('notes'),
    // Stripe payment linkage (set by the checkout + webhook flow). `paidAt` is the
    // paid marker — status flips to `confirmed` on a successful payment (no extra
    // enum value); these stay NULL for cash / no-Stripe orders.
    stripeCheckoutSessionId: text('stripe_checkout_session_id'),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // Admin list + dashboard: tenant-scoped, newest-first (btree scans either way).
    tenantCreatedIdx: index('orders_tenant_created_idx').on(t.tenantId, t.createdAt),
    // Status aggregates (pending/confirmed counts, bulk confirm).
    tenantStatusIdx: index('orders_tenant_status_idx').on(t.tenantId, t.status),
    // Slot-capacity check + admin list leftJoin on slot.
    slotIdx: index('orders_slot_idx').on(t.slotId),
    // One sequence of order numbers per tenant (NULLs allowed for legacy rows).
    tenantNumberUnique: uniqueIndex('orders_tenant_number_unique').on(t.tenantId, t.orderNumber),
  }),
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    orderId: uuid('order_id').references(() => orders.id),
    productId: uuid('product_id').references(() => products.id),
    productName: text('product_name'),
    quantity: integer('quantity').notNull(),
    priceStotinki: integer('price_stotinki').notNull(),
  },
  // Production prep-list join + per-order item batch load.
  (t) => ({
    orderIdx: index('order_items_order_idx').on(t.orderId),
  }),
);

// Stripe webhook idempotency ledger. Every handled event id is recorded so a
// redelivered webhook (Stripe retries on non-2xx / network blips) is a no-op.
export const stripeEvents = pgTable('stripe_events', {
  id: text('id').primaryKey(), // Stripe event id, e.g. evt_...
  type: text('type').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// Econt courier shipments — one per order sent via Econt. Created when the farm
// generates a waybill (label); `status` mirrors Econt's lifecycle. One shipment
// per order (unique). `tracking_json` caches the last status payload from Econt.
export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    orderId: uuid('order_id')
      .references(() => orders.id)
      .notNull(),
    econtShipmentNumber: text('econt_shipment_number'),
    status: text('status').notNull().default('pending'),
    labelPdfUrl: text('label_pdf_url'),
    courierPriceStotinki: integer('courier_price_stotinki'),
    codAmountStotinki: integer('cod_amount_stotinki'),
    trackingJson: jsonb('tracking_json'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (t) => ({
    orderUnique: uniqueIndex('shipments_order_unique').on(t.orderId),
    // Tenant-scoped shipment list + scoped delete.
    tenantIdx: index('shipments_tenant_idx').on(t.tenantId),
  }),
);

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
    // Free-text editorial category (e.g. "Рецепти" / "От полето" / "Съвети") —
    // powers the storefront blog filter tabs + per-article tag. Nullable.
    category: text('category'),
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
export const newsletterSubscribers = pgTable(
  'newsletter_subscribers',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    email: text('email').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
    unsubscribedAt: timestamp('unsubscribed_at'),
  },
  // Subscriber list + broadcast filter by tenant, sort by createdAt.
  (t) => ({
    tenantCreatedIdx: index('newsletter_subscribers_tenant_created_idx').on(
      t.tenantId,
      t.createdAt,
    ),
  }),
);

// Global do-not-send list. Populated from SES bounce/complaint webhooks (and
// manual adds). Checked before every send to protect the shared sending domain's
// reputation — a hard bounce or spam complaint must never be mailed again.
export const emailSuppressions = pgTable('email_suppressions', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  email: text('email').notNull().unique(),
  reason: text('reason').notNull(), // 'bounce' | 'complaint' | 'manual'
  detail: text('detail'),
  createdAt: timestamp('created_at').defaultNow(),
});

// Billing ledger of broadcast "pushes" — the unit the farmer is charged for
// (flat price per push, regardless of recipient count). One row per broadcast.
export const emailPushes = pgTable('email_pushes', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  subject: text('subject'),
  recipientCount: integer('recipient_count').notNull(),
  priceStotinki: integer('price_stotinki').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// Storefront contact-form submissions (public intake). Read in the admin panel
// later; for now just persisted.
export const contactMessages = pgTable('contact_messages', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  name: text('name').notNull(),
  email: text('email').notNull(),
  phone: text('phone'),
  message: text('message').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const reviewStatusEnum = pgEnum('review_status', ['pending', 'published', 'hidden']);

// Customer reviews. Public submissions land as `pending` (moderated in the admin
// panel); only `published` rows are served to the storefront. `productId` null =
// a site-wide review; set = a review tied to one product.
export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    productId: uuid('product_id').references(() => products.id),
    authorName: text('author_name').notNull(),
    authorLocation: text('author_location'),
    rating: integer('rating').notNull(), // 1–5
    body: text('body').notNull(),
    status: reviewStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  // Public API + admin moderation both filter (tenant, status) and sort by createdAt.
  (t) => ({
    tenantStatusCreatedIdx: index('reviews_tenant_status_created_idx').on(
      t.tenantId,
      t.status,
      t.createdAt,
    ),
  }),
);

// Producers behind one storefront (multi-farmer mode). A product may link to one.
export const farmers = pgTable(
  'farmers',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    name: text('name').notNull(),
    role: text('role'),
    bio: text('bio'),
    phone: text('phone'),
    since: text('since'),
    tint: text('tint'),
    imageUrl: text('image_url'),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow(),
  },
  // Admin + storefront lists filter by tenant, sort by (position, createdAt).
  (t) => ({
    tenantPositionIdx: index('farmers_tenant_position_idx').on(
      t.tenantId,
      t.position,
      t.createdAt,
    ),
  }),
);

// Optional product grouping into photographed storefront sections.
export const subcategories = pgTable(
  'subcategories',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    name: text('name').notNull(),
    description: text('description'),
    tint: text('tint'),
    imageUrl: text('image_url'),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow(),
  },
  // Admin + storefront lists filter by tenant, sort by (position, createdAt).
  (t) => ({
    tenantPositionIdx: index('subcategories_tenant_position_idx').on(
      t.tenantId,
      t.position,
      t.createdAt,
    ),
  }),
);

// Ordered image galleries (image-only) for catalog entities. One row per photo;
// `position` orders the gallery and position 0 is the cover (mirrored into the
// owner's `image_url` for back-compat reads). `tenant_id` is denormalized for
// tenant-scoped queries/deletes. FK is ON DELETE CASCADE so removing an owner
// drops its photos (the service still purges the R2 objects). Pattern mirrors
// `article_media`, minus the type/embed columns (these are uploads only).
export const productMedia = pgTable(
  'product_media',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    url: text('url').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    productPositionIdx: index('product_media_product_position_idx').on(t.productId, t.position),
  }),
);

export const farmerMedia = pgTable(
  'farmer_media',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    farmerId: uuid('farmer_id').references(() => farmers.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    url: text('url').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    farmerPositionIdx: index('farmer_media_farmer_position_idx').on(t.farmerId, t.position),
  }),
);

export const subcategoryMedia = pgTable(
  'subcategory_media',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    subcategoryId: uuid('subcategory_id').references(() => subcategories.id, {
      onDelete: 'cascade',
    }),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    url: text('url').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    subcategoryPositionIdx: index('subcategory_media_subcategory_position_idx').on(
      t.subcategoryId,
      t.position,
    ),
  }),
);

export const schema = {
  tenants,
  users,
  products,
  farmers,
  subcategories,
  productMedia,
  farmerMedia,
  subcategoryMedia,
  deliverySlots,
  orders,
  orderItems,
  stripeEvents,
  shipments,
  auditLogs,
  platformAdmins,
  articles,
  articleMedia,
  newsletterSubscribers,
  contactMessages,
  reviews,
  userRoleEnum,
  reviewStatusEnum,
  orderStatusEnum,
  subscriptionStatusEnum,
  articleStatusEnum,
  articleMediaTypeEnum,
};
