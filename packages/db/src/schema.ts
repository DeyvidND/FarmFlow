import {
  pgTable,
  pgEnum,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  smallint,
  boolean,
  date,
  time,
  numeric,
  index,
  uniqueIndex,
  unique,
  bigserial,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const userRoleEnum = pgEnum('user_role', ['admin', 'driver', 'customer', 'farmer']);
export const orderStatusEnum = pgEnum('order_status', [
  'pending',
  'confirmed',
  'preparing',
  'out_for_delivery',
  'delivered',
  'cancelled',
]);
export const codOutcomeEnum = pgEnum('cod_outcome', ['received', 'refused']);
export const subscriptionStatusEnum = pgEnum('subscription_status', ['active', 'past_due', 'inactive']);
// Task #14: per-farmer self-tracked prep state for tomorrow's orders — see
// order_fulfillments below. Plain text column (not a pg enum) so a future state
// can be added without an ALTER TYPE migration; validated in the DTO layer.
// Vendor finance (DORMANT until enabled per tenant — see tenants.settings.vendorFinance).
// commission_entries lifecycle: accrued (money collected) → settled (paid out) or
// voided (order cancelled / COD refused). Settled is final.
export const commissionEntryStatusEnum = pgEnum('commission_entry_status', [
  'accrued',
  'voided',
  'settled',
]);
// Vendor monthly subscription charges (the operator collects the fee off-platform
// today; these rows only track who owes what per month).
export const vendorChargeStatusEnum = pgEnum('vendor_charge_status', ['due', 'paid', 'waived']);
// Delivery methods:
//  - `address`       → the farm's own (local) delivery to a street address: slots,
//                      route optimization, flat regional fee. Local only.
//  - `pickup`        → customer collects at the market; no delivery, no fee, no slot.
//  - `econt`         → Econt courier to an office (nationwide; live-priced).
//  - `econt_address` → Econt courier to a home address / door (nationwide; live-priced).
export const deliveryTypeEnum = pgEnum('delivery_type', ['pickup', 'address', 'econt', 'econt_address', 'courier']);
export const paymentMethodEnum = pgEnum('payment_method', ['online', 'cod']);

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
  // Super-admin „пакет Доставки" gate (farmer panel + deliveries add-on). When off,
  // the panel hides delivery config + the dostavki deep-link, the storefront offers
  // no courier methods, and the dostavki app denies access. Default true so existing
  // farms are unaffected; super-admin turns it off for panel-only tenants.
  deliveriesPackageEnabled: boolean('deliveries_package_enabled').notNull().default(true),
  // Optional catalog groupings — when on, the matching admin page + product link
  // field + storefront grouping/attribution activate. Default off.
  multiFarmer: boolean('multi_farmer').notNull().default(false),
  multiSubcat: boolean('multi_subcat').notNull().default(false),
  // Storefront content sections, gated from the «Функции на магазина» panel. When
  // off, the section is hidden on the storefront (and its admin nav link). Default
  // on — preserves the historic always-visible behavior for existing farms.
  articlesEnabled: boolean('articles_enabled').notNull().default(true),
  reviewsEnabled: boolean('reviews_enabled').notNull().default(true),
  // Disposable demo shop created from the super-admin „Създай демо" button. `isDemo`
  // is the only tenant the hard-delete path will remove; a daily cleanup job deletes
  // demos past `demoExpiresAt`. Both default off so real tenants are unaffected.
  isDemo: boolean('is_demo').notNull().default(false),
  demoExpiresAt: timestamp('demo_expires_at', { withTimezone: true }),
  // „Задай наличност" is always on: any active per-product availability window the
  // farmer records is shown on the storefront (no on/off toggle). `availabilityTitle`
  // is the optional storefront heading for that section. NULL → default („Налично сега").
  availabilityTitle: text('availability_title'),
  // Optional «Продукт на седмицата» storefront highlight. `enabled` is the gate;
  // mode 'manual' features `productOfWeekId` (one product), mode 'auto' resolves a
  // weekly ISO-week rotation server-side (no cron). `note` = optional blurb.
  productOfWeekEnabled: boolean('product_of_week_enabled').notNull().default(false),
  productOfWeekMode: text('product_of_week_mode').notNull().default('manual'),
  productOfWeekId: uuid('product_of_week_id').references((): AnyPgColumn => products.id),
  productOfWeekNote: text('product_of_week_note'),
  // Where the highlight renders on the storefront: 'section' (full banner under
  // the hero, the default) or 'bar' (a thin announcement strip above the header,
  // site-wide). Hiding it altogether is the `productOfWeekEnabled` gate.
  productOfWeekPlacement: text('product_of_week_placement').notNull().default('section'),
  stripeAccountId: text('stripe_account_id'),
  // Connected-account capability flags, mirrored from Stripe `account.updated`
  // webhooks so the super-admin oversight table reads status without per-load
  // Stripe calls. Default false until the farm onboards.
  stripeChargesEnabled: boolean('stripe_charges_enabled').notNull().default(false),
  stripePayoutsEnabled: boolean('stripe_payouts_enabled').notNull().default(false),
  stripeDetailsSubmitted: boolean('stripe_details_submitted').notNull().default(false),
  stripeStatusUpdatedAt: timestamp('stripe_status_updated_at', { withTimezone: true }),
  // --- Platform-side SaaS billing (the platform charges the farm; distinct from
  // stripeAccountId, which is the farm's Connect account for customer orders). ---
  premium: boolean('premium').notNull().default(false),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  // Set on first failed payment; the suspend deadline (status flips to inactive after).
  graceUntil: timestamp('grace_until', { withTimezone: true }),
  // Farm origin for delivery-route optimization (nullable until set).
  farmAddress: text('farm_address'),
  farmLat: numeric('farm_lat', { precision: 10, scale: 7 }),
  farmLng: numeric('farm_lng', { precision: 10, scale: 7 }),
  // Reusable operator signature for handover protocols — ENCRYPTED at rest
  // (server/src/common/crypto/signature-crypto). Operator-only; never in a public
  // projection. Stored as its own column (NOT settings.legal, which updateLegal
  // replaces wholesale). NULL = none saved yet. (migration 0110)
  operatorSignaturePng: text('operator_signature_png'),
  settings: jsonb('settings').default({}),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => ({
  // Super-admin tenant list keyset: createdAt ASC + id tiebreaker (fully index-served).
  createdIdx: index('tenants_created_idx').on(t.createdAt, t.id),
  // Stripe webhooks resolve the tenant by connected-account / billing ids on every
  // event. Partial (most tenants are NULL) → tiny index, equality lookup instead of
  // a seq-scan per webhook. `stripeAccountId` is the hottest (every order webhook).
  stripeAccountIdx: index('tenants_stripe_account_idx')
    .on(t.stripeAccountId)
    .where(sql`${t.stripeAccountId} is not null`),
  stripeCustomerIdx: index('tenants_stripe_customer_idx')
    .on(t.stripeCustomerId)
    .where(sql`${t.stripeCustomerId} is not null`),
  stripeSubscriptionIdx: index('tenants_stripe_subscription_idx')
    .on(t.stripeSubscriptionId)
    .where(sql`${t.stripeSubscriptionId} is not null`),
}));

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    role: userRoleEnum('role').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    // Monotonic session epoch. Embedded in the JWT (`tv`) and checked on every
    // authenticated request; bumped on password change/reset so previously issued
    // tokens stop validating (logout-everywhere / revoke-on-reset).
    tokenVersion: integer('token_version').notNull().default(0),
    // Per-user sidebar customization: keys the farmer chose to hide from the side
    // nav — item hrefs (e.g. "/orders") and whole-group keys ("group:Каталог").
    // NULL/empty = show everything. Purely cosmetic; the routes stay reachable.
    hiddenNav: jsonb('hidden_nav').$type<string[]>(),
    // Producer sub-account link: a `role='farmer'` user manages only this producer's
    // data. NULL for owner/driver/customer rows. CASCADE so deleting the producer
    // deletes its login. (See farmers table below — forward ref via thunk.)
    farmerId: uuid('farmer_id').references(() => farmers.id, { onDelete: 'cascade' }),
    // Courier-leg binding for role='driver' logins (0-based, matches
    // orders.courierIndex / settings.routing.couriers[] indexing). NULL = not
    // yet bound to a leg (or not a driver). Set by the courier-access grant
    // flow (Task C2), read by the route API to scope a driver to their own leg
    // (Task C3).
    courierIndex: smallint('courier_index'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // At most one login per producer.
    farmerIdUniq: uniqueIndex('users_farmer_id_uniq')
      .on(t.farmerId)
      .where(sql`${t.farmerId} is not null`),
    // At most one driver login per courier leg — backs the app-level check in
    // CourierAccessService.grantAccess (which is read-then-write, not transactional)
    // so two concurrent grants for the same leg can't both insert.
    courierIndexUniq: uniqueIndex('users_tenant_courier_index_uniq')
      .on(t.tenantId, t.courierIndex)
      .where(sql`${t.role} = 'driver' and ${t.courierIndex} is not null`),
    // listAccess: WHERE tenant_id=? AND role='farmer' — currently a seq-scan.
    tenantRoleIdx: index('users_tenant_role_idx').on(t.tenantId, t.role),
    // Login matches case-insensitively (auth.service: `lower(email) = ?`). The
    // unique index on raw `email` can't serve that predicate, so login was a full
    // seq-scan of users. Functional index makes it sargable. NON-unique on purpose:
    // case-collisions in legacy rows must not block the index build (uniqueness is
    // already enforced by `users_email_unique` on the raw column).
    emailLowerIdx: index('users_email_lower_idx').on(sql`lower(${t.email})`),
  }),
);

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
    // Pickup-only flag: perishable/fragile products the farmer never wants on a
    // courier waybill. true → the storefront hides courier (Econt/Speedy) delivery
    // for any cart holding this product, and the server rejects a carrier order
    // for it. Self-delivery + pickup stay allowed (no waybill involved). Toggled by
    // the farmer (own products) or an admin in the product dialog.
    courierDisabled: boolean('courier_disabled').notNull().default(false),
    // Moderation gate for farmer-submitted products: true = awaiting tenant-admin
    // review, hidden from the public catalog. Admin/operator-created products are
    // born false (live). Cleared only by the explicit approve endpoint.
    needsReview: boolean('needs_review').notNull().default(false),
    // Companion rule: true = can't be ordered alone; the cart must also hold ≥1 other distinct
    // product. Enforced in OrdersService + a storefront pre-check. (migr 0101)
    requiresCompanion: boolean('requires_companion').notNull().default(false),
    // Optional EUR-cents threshold for the companion rule (same unit as priceStotinki): the
    // required other product must be worth ≥ this. NULL = any other product qualifies. (migr 0101)
    companionMinPriceStotinki: integer('companion_min_price_stotinki'),
    imageUrl: text('image_url'),
    // How the cover image is framed in storefront product cards: focal point
    // (x/y, 0..1) + zoom (1..3). NULL = legacy behavior (centered, no zoom).
    // Lets portrait/landscape photos be framed instead of blindly center-cropped.
    coverCrop: jsonb('cover_crop').$type<{ x: number; y: number; zoom: number; shape?: 'wide' | 'square' | 'tall' }>(),
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
    // Promotion: a percentage discount (1..99) applied proportionally to the base
    // price AND every variant. saleEndsAt NULL = until the farmer removes it; a
    // timestamp = auto-expires (pricing logic ignores it once past; a daily cron
    // nulls both columns for admin tidiness). Both NULL = no promo.
    salePercent: integer('sale_percent'),
    saleEndsAt: timestamp('sale_ends_at'),
    // Product-level FIXED promo price (stotinki) — alternative to the % discount,
    // for plain products. NULL = none. Mutually exclusive with salePercent (a fixed
    // price clears the %). Varianted products use product_variants.salePriceStotinki.
    salePriceStotinki: integer('sale_price_stotinki'),
    featured: boolean('featured').notNull().default(false),
    // Farmer-controlled storefront display order. A single global position per
    // tenant; per-category sections sort by the same field, filtered. Backfilled
    // from createdAt on migration so existing order is preserved.
    position: integer('position').notNull().default(0),
    // Soft delete. NULL = live; a timestamp = removed from the catalog. Kept as a
    // separate flag (not `is_active`, which is the user's hide/show toggle and must
    // stay visible in the admin list) so the row — and its order_items / reviews FKs
    // (both ON DELETE no action) — survive while the product leaves every admin read.
    deletedAt: timestamp('deleted_at'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    tenantSlugUnique: uniqueIndex('products_tenant_slug_unique').on(t.tenantId, t.slug),
    // Admin list + public catalog filter by tenant, sort by createdAt. `id` is the
    // keyset tiebreaker — included so (created_at, id) ordering is fully index-served
    // (no Sort node; LIMIT short-circuits the scan).
    tenantCreatedIdx: index('products_tenant_created_idx').on(t.tenantId, t.createdAt, t.id),
    // Storefront/admin display order: filter by tenant, sort by (position, createdAt,
    // id). Mirrors the farmers/subcategories position index — fully index-served.
    tenantPositionIdx: index('products_tenant_position_idx').on(
      t.tenantId,
      t.position,
      t.createdAt,
      t.id,
    ),
    // Serve the per-farmer / per-subcategory reads (digest join, grouping) and
    // make `ON DELETE SET NULL` on a farmer/subcategory delete an index lookup
    // instead of a seq scan over products.
    farmerIdx: index('products_farmer_idx').on(t.farmerId),
    subcategoryIdx: index('products_subcategory_idx').on(t.subcategoryId),
    // Review queue lookups: badge count + pending list are always tenant + flag.
    // Partial — pending rows are few; mirrors 0090_product_review.sql.
    pendingReviewIdx: index('products_tenant_pending_review_idx')
      .on(t.tenantId)
      .where(sql`${t.needsReview} = true`),
  }),
);

// Per-product priced variants (вид/грамаж): e.g. "Кристализиран 500 г" / "Течен 1 кг".
// A product either sells at its own priceStotinki (no variants) OR via these rows
// (variants present). Each variant carries its own stock (NULL = unlimited, 0 = out).
// position orders them in the picker; deletedAt soft-deletes (order_items keep a label
// snapshot, so a removed variant's history survives). When variants exist the service
// syncs products.priceStotinki to the cheapest variant for sort + "от X" display.
export const productVariants = pgTable(
  'product_variants',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    priceStotinki: integer('price_stotinki').notNull(),
    // Fixed promo price for this variant (stotinki). NULL = no per-variant promo
    // (the variant follows the product-level % promo, if any). Mutually exclusive
    // with the product %: setting any variant's fixed price clears the product %.
    salePriceStotinki: integer('sale_price_stotinki'),
    // NULL = unlimited stock; 0 = out of stock.
    stockQuantity: integer('stock_quantity'),
    position: integer('position').notNull().default(0),
    deletedAt: timestamp('deleted_at'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    productPositionIdx: index('product_variants_product_position_idx').on(
      t.productId,
      t.position,
      t.id,
    ),
  }),
);

// Real product membership for bundle products (products.category='bundle'). See 0100.
export const productBundleItems = pgTable('product_bundle_items', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  bundleId: uuid('bundle_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  quantity: integer('quantity').notNull().default(1),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => ({
  bundleIdx: index('product_bundle_items_bundle_idx').on(t.bundleId, t.position, t.id),
  bundleProductUnique: uniqueIndex('product_bundle_items_bundle_product_unique').on(t.bundleId, t.productId),
  productIdx: index('product_bundle_items_product_idx').on(t.productId),
}));

export const productAvailabilityWindows = pgTable(
  'product_availability_windows',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    // Inclusive BG-local date range. day = from == to; week/month/several = wider.
    startsAt: date('starts_at').notNull(),
    endsAt: date('ends_at').notNull(),
    // `quantity` = the amount the farmer set; `remaining` decrements on each order
    // and blocks at 0. An active window's `remaining` is the product's real stock.
    quantity: integer('quantity').notNull(),
    remaining: integer('remaining').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // Active-window lookup: "this product's window covering today".
    productRangeIdx: index('product_availability_windows_product_range_idx').on(t.productId, t.startsAt, t.endsAt),
    // Tenant-scoped admin list.
    tenantIdx: index('product_availability_windows_tenant_idx').on(t.tenantId),
    // Storefront "active windows for this farm today" overlay: tenant_id eq +
    // ends_at >= today (range) leads so expired windows are skipped before the
    // starts_at <= today filter. The product_range_idx above can't serve this —
    // it leads with product_id, absent from this WHERE.
    tenantRangeIdx: index('product_availability_windows_tenant_range_idx').on(
      t.tenantId,
      t.endsAt,
      t.startsAt,
    ),
  }),
);

export const deliverySlots = pgTable(
  'delivery_slots',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    date: date('date').notNull(),
    // NULL on day-based slots (one row per delivery day, no hours). Non-null
    // only on legacy pre-0081 rows, kept for history display.
    timeFrom: time('time_from'),
    timeTo: time('time_to'),
    isActive: boolean('is_active').default(true),
    // Customer-facing note shown in the storefront slot picker (e.g. "ще се обадя
    // преди доставка"). Safe to expose publicly.
    customerNote: text('customer_note'),
    // Private note for whoever drives the route (area, phone, order). Admin-only —
    // never serialized to the storefront.
    driverNote: text('driver_note'),
    // True for rows created by the recurrence rule (vs. one-off manual slots). The
    // generator only ever touches generated rows.
    generated: boolean('generated').notNull().default(false),
    // Daily order ceiling for this delivery day (see migration 0081). Booked count
    // is computed live from non-cancelled orders; this is just the ceiling. Default
    // 1 preserves the historical one-order-per-slot behaviour on legacy rows.
    capacity: integer('capacity').notNull().default(1),
    // Per-day suppression of the 08:00 "delivery today" reminder (sms-reminder
    // module) — lets a farmer skip one uncertain day without disabling the
    // tenant-wide toggle. Default false = send (see migration 0106).
    reminderOptOut: boolean('reminder_opt_out').notNull().default(false),
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
    // Deleting a slot orphans its orders (set null) rather than being blocked by
    // the FK — see migration 0068. The app refuses to delete a slot with a live order.
    slotId: uuid('slot_id').references(() => deliverySlots.id, { onDelete: 'set null' }),
    status: orderStatusEnum('status').default('pending'),
    // Human-friendly per-tenant order number (#1, #2, …) shown to the farmer and
    // customer. Assigned on create; NULL only on legacy rows until backfilled.
    orderNumber: integer('order_number'),
    totalStotinki: integer('total_stotinki').notNull(),
    deliveryType: deliveryTypeEnum('delivery_type').notNull().default('address'),
    // Which courier the customer chose when both carriers were offered (door delivery
    // comparison). NULL = legacy / single-carrier order; carrier inferred from deliveryType.
    carrier: text('carrier'),
    // Which farmer this (split) courier order belongs to. Set ONLY on
    // delivery_type='courier' orders, which are always single-farmer; NULL for
    // local/pickup/Econt orders. See migration 0070.
    farmerId: uuid('farmer_id').references(() => farmers.id, { onDelete: 'set null' }),
    deliveryAddress: text('delivery_address'),
    // Settlement for Econt door delivery (the structured city Econt needs to route
    // a waybill to an address). NULL for office/local delivery.
    deliveryCity: text('delivery_city'),
    // Block/entrance/floor/flat (бл./вх./ет./ап.) + courier hint, kept OUT of
    // delivery_address so it never pollutes geocoding. Populated for local-delivery
    // orders only (enforced in orders.service intake); econt_address keeps the full
    // string in delivery_address (Econt needs it).
    deliveryNote: text('delivery_note'),
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
    // Наложен платеж (COD) money outcome — orthogonal to `status` (fulfillment).
    // NULL = Очаквано (pending). Set from a real courier signal (source='courier')
    // or a manual click (source='manual'); a manual value is authoritative and is
    // never overwritten by a later courier refresh. Only meaningful for
    // payment_method='cod'. See migration 0078.
    codOutcome: codOutcomeEnum('cod_outcome'),
    codOutcomeAt: timestamp('cod_outcome_at', { withTimezone: true }),
    codOutcomeReason: text('cod_outcome_reason'),
    codOutcomeSource: text('cod_outcome_source'),
    // Day the order was ACTUALLY delivered — distinct from created_at (order-placed
    // day) and the delivery_slots.date it was scheduled for. NULL until the first
    // transition into status='delivered'; cleared back to NULL if that transition is
    // ever reverted (kept in lockstep with `status`). Feeds the turnover-by-basis
    // stat (Task #9/#10) — see migration 0097 for the backfill of legacy rows.
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    // How the customer chose to pay: 'online' (Stripe card) or 'cod' (наложен
    // платеж — collected at delivery/Econt office). Normalized at checkout to
    // reflect reality: any order with no Stripe session is recorded as 'cod'.
    paymentMethod: paymentMethodEnum('payment_method').notNull().default('online'),
    // Cookieless daily visitor hash of the checkout request (IP+UA+day+tenant+salt),
    // captured so the server-emitted 'purchase' site_event carries the SAME hash as
    // that shopper's page_view rows (funnel counts distinct visitor_hash). Nullable:
    // legacy rows + any order created before this column existed.
    visitorHash: text('visitor_hash'),
    // Manual courier assignment for the route/маршрути screen (own delivery). NULL =
    // auto (sweep-split by geography); 0-based index of the courier the operator
    // pinned this order to. Out-of-range (courier count later lowered) is ignored by
    // the router → falls back to auto. See migration 0093.
    courierIndex: smallint('courier_index'),
    // Persisted manual stop order within a courier's leg (0-based position).
    // NULL = not manually ordered (auto/optimized order applies). Set via
    // PATCH /orders/route/order/sequence when the operator drags stops around
    // on the route screen, so slot regeneration honours it. Migration 0095.
    routeSeq: smallint('route_seq'),
    // Delivery time window (task #13). Wall-clock Europe/Sofia, per order, generated
    // from the optimized route then approved/edited by the operator and emailed to the
    // customer. start/end are 'HH:MM' times; status draft→approved→sent; notifiedAt is
    // when the customer was told. All NULL until a window is generated. Migration 0094.
    deliveryWindowStart: time('delivery_window_start'),
    deliveryWindowEnd: time('delivery_window_end'),
    deliveryWindowStatus: text('delivery_window_status'),
    deliveryWindowNotifiedAt: timestamp('delivery_window_notified_at', { withTimezone: true }),
    // Day-of SMS reminder claim/idempotency marker (separate from the email's
    // delivery_window_notified_at): the morning SMS must fire exactly once even
    // when the window email already went out the evening before. Migration 0104.
    deliveryWindowSmsAt: timestamp('delivery_window_sms_at', { withTimezone: true }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // Admin list + dashboard: tenant-scoped, newest-first. `id` tiebreaker makes
    // the (created_at, id) keyset order fully index-served (no Sort, LIMIT seeks).
    tenantCreatedIdx: index('orders_tenant_created_idx').on(t.tenantId, t.createdAt, t.id),
    // Status aggregates (pending/confirmed counts, bulk confirm).
    tenantStatusIdx: index('orders_tenant_status_idx').on(t.tenantId, t.status),
    // Slot-capacity check + admin list leftJoin on slot.
    slotIdx: index('orders_slot_idx').on(t.slotId),
    // Refund webhook fallback: resolve the order by payment-intent when the event
    // carries no orderId. Partial (NULL for cash orders) → no seq-scan per refund.
    stripePaymentIntentIdx: index('orders_stripe_pi_idx')
      .on(t.stripePaymentIntentId)
      .where(sql`${t.stripePaymentIntentId} is not null`),
    // One sequence of order numbers per tenant (NULLs allowed for legacy rows).
    tenantNumberUnique: uniqueIndex('orders_tenant_number_unique').on(t.tenantId, t.orderNumber),
    // Farmer-scoped order lookups (courier split orders).
    farmerIdx: index('orders_farmer_idx').on(t.farmerId),
    // Turnover-by-delivered-day bucketing / to-date sums (Task #9/#10). Partial:
    // most orders are NULL here at any given time (not yet delivered).
    tenantDeliveredIdx: index('orders_tenant_delivered_idx')
      .on(t.tenantId, t.deliveredAt)
      .where(sql`${t.deliveredAt} is not null`),
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
    // Variant snapshot (NULL for products sold without variants). variantLabel is
    // captured at purchase time like productName, so order history survives a later
    // variant rename/removal. priceStotinki already stores the unit price paid.
    variantId: uuid('variant_id').references(() => productVariants.id),
    variantLabel: text('variant_label'),
    // Basket („кошница") child line: points at the parent basket line in the same
    // order. NULL for every ordinary line. The parent carries the basket's fixed
    // price; children are priced 0 so the order total is unchanged, and exist so
    // prep lists, stock restore and per-product stats see the real products.
    bundleParentId: uuid('bundle_parent_id').references((): AnyPgColumn => orderItems.id, {
      onDelete: 'cascade',
    }),
  },
  // Production prep-list join + per-order item batch load.
  (t) => ({
    orderIdx: index('order_items_order_idx').on(t.orderId),
    // Farmer stats / payments / recommendations: GROUP BY / JOIN on product_id.
    // Composite (productId, orderId) also serves distinct-order counts per product.
    productIdx: index('order_items_product_idx').on(t.productId, t.orderId),
    bundleParentIdx: index('order_items_bundle_parent_idx')
      .on(t.bundleParentId)
      .where(sql`${t.bundleParentId} is not null`),
  }),
);

export const handoverProtocols = pgTable(
  'handover_protocols',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    // 'farmer_to_operator' | 'operator_to_customer'
    kind: text('kind').notNull(),
    farmerId: uuid('farmer_id').references(() => farmers.id, { onDelete: 'set null' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    slotId: uuid('slot_id').references(() => deliverySlots.id, { onDelete: 'set null' }),
    protocolNumber: integer('protocol_number'),
    fromSnapshot: jsonb('from_snapshot').notNull(),
    toSnapshot: jsonb('to_snapshot').notNull(),
    items: jsonb('items').notNull(),
    orderIds: uuid('order_ids').array(),
    totalStotinki: integer('total_stotinki').notNull().default(0),
    fromSignaturePng: text('from_signature_png'),
    toSignaturePng: text('to_signature_png'),
    // 'digital' | 'paper' | 'pending'
    signMode: text('sign_mode').notNull().default('pending'),
    meta: jsonb('meta'),
    // 'draft' | 'signed'
    status: text('status').notNull().default('draft'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    tenantCreatedIdx: index('handover_tenant_created_idx').on(t.tenantId, t.createdAt, t.id),
    tenantNumberUnique: uniqueIndex('handover_tenant_number_unique').on(t.tenantId, t.protocolNumber),
    farmerIdx: index('handover_farmer_idx').on(t.farmerId),
    orderIdx: index('handover_order_idx').on(t.orderId),
  }),
);

// Per-day courier leg board (migr 0109): "who runs which leg on date X" —
// replaces the fixed users.courierIndex login↔leg binding with a per-day
// assignment. Source of truth for `resolveMyLeg` (Task A2) and driver-facing
// leg-ownership checks. See docs/superpowers/specs/2026-07-15-courier-assignment-board-design.md §1.
export const routeCourierAssignments = pgTable(
  'route_courier_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // ISO YYYY-MM-DD, Europe/Sofia — same convention as deliverySlots.date / scheduledForDay.
    date: text('date').notNull(),
    // The assigned login: a role='driver' row OR the tenant owner's role='admin' row.
    // Deliberately NOT discriminated by role (spec §1.1) — the caller always knows
    // the role from context.
    accountId: uuid('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 0-based leg number, same indexing as orders.courierIndex / settings.routing.couriers[].
    legIndex: smallint('leg_index').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // One leg per account per day — an account can't be two legs at once.
    accountUniq: unique('route_courier_assign_tenant_date_account_uniq').on(t.tenantId, t.date, t.accountId),
    // One account per leg per day — a leg can't have two drivers. Hard DB
    // constraints (not app checks) so concurrent board edits can't double-book.
    legUniq: unique('route_courier_assign_tenant_date_leg_uniq').on(t.tenantId, t.date, t.legIndex),
  }),
);

// Ръчно въведени разходи на фермата (гориво, амбалаж, заплати…). Няма автоматичен
// източник — собственикът ги пише сам, за да има смислена печалба в Статистика.
// `courierAccountId` NULL = общ разход, който НЕ се разпределя по куриери.
export const manualExpenses = pgTable(
  'manual_expenses',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // БГ календарен ден на разхода (YYYY-MM-DD), същата конвенция като deliverySlots.date.
    date: date('date').notNull(),
    amountStotinki: integer('amount_stotinki').notNull(),
    // 'fuel' | 'packaging' | 'salary' | 'fees' | 'other' — валидира се в DTO-то, не в enum,
    // за да не иска миграция всяка нова категория.
    category: text('category').notNull(),
    // Изтрит куриерски акаунт превръща разхода в общ, вместо да го изгуби.
    courierAccountId: uuid('courier_account_id').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    createdAt: timestamp('created_at').defaultNow(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => ({
    // Периодните заявки на /stats/pnl: WHERE tenant_id = ? AND date BETWEEN ? AND ?
    tenantDateIdx: index('manual_expenses_tenant_date_idx').on(t.tenantId, t.date),
    // Разбивката по куриер.
    tenantCourierIdx: index('manual_expenses_tenant_courier_idx').on(t.tenantId, t.courierAccountId),
  }),
);

export const siteEvents = pgTable(
  'site_events',
  {
    // bigserial, not uuid: high write volume, no need for global
    // uniqueness/obfuscation like the tenant-facing tables below.
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    // Cookieless daily hash of IP+UA+salt+tenant. The raw IP is NEVER stored —
    // only this hash — and the salt rotates daily so it can't track across days.
    visitorHash: text('visitor_hash').notNull(),
    // One of: page_view | product_view | add_to_cart | checkout_start | purchase.
    eventType: text('event_type').notNull(),
    path: text('path'),
    // Storefront-supplied human label for this page (e.g. "Продукт", "Фермери"),
    // set by the page itself via <Layout pageLabel="...">. Lets "Топ страници"
    // group/label pages without the backend hardcoding a per-storefront route
    // list — every storefront (chaika, template-factory sites, future ones)
    // self-describes its own pages. Null for older clients that haven't been
    // rebuilt with this yet; analytics.helpers.ts falls back to a path-shape
    // guess (`labelPage()`) in that case.
    pageLabel: text('page_label'),
    // Referrer HOST only (no full URL / query) — privacy.
    referrerHost: text('referrer_host'),
    // No FK on productId/orderId (unlike orderItems): analytics rows must
    // survive product/order deletion and shouldn't gate deletes or add
    // insert-time join overhead on this high-write table.
    productId: uuid('product_id'),
    orderId: uuid('order_id'),
    valueStotinki: integer('value_stotinki'),
    device: text('device').notNull().default('desktop'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantCreatedIdx: index('site_events_tenant_created_idx').on(t.tenantId, t.createdAt),
    tenantTypeCreatedIdx: index('site_events_tenant_type_created_idx').on(
      t.tenantId,
      t.eventType,
      t.createdAt,
    ),
    // Purchase idempotency: one purchase row per (tenant, order). Lets recordPurchase
    // use ON CONFLICT DO NOTHING instead of a racy, unindexed check-then-insert.
    purchaseOrderUniq: uniqueIndex('site_events_purchase_order_uniq')
      .on(t.tenantId, t.orderId)
      .where(sql`${t.eventType} = 'purchase'`),
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
    orderId: uuid('order_id').references(() => orders.id),
    // Phase 3 (migration 0071): which farmer owns/ships this courier parcel.
    // Copied from orders.farmer_id when the draft is created. NULL for tenant-level
    // (marketplace) Econt/Speedy shipments.
    farmerId: uuid('farmer_id').references(() => farmers.id, { onDelete: 'set null' }),
    econtShipmentNumber: text('econt_shipment_number'),
    // --- Multi-carrier (Speedy added alongside Econt) ---
    // Which courier owns this row. Existing rows + Econt inserts default 'econt';
    // Speedy inserts set 'speedy'. Each carrier's code reads only its own columns.
    carrier: text('carrier').notNull().default('econt'),
    // Speedy parcel barcode (the trackable number). Econt keeps econtShipmentNumber.
    trackingNumber: text('tracking_number'),
    // Speedy shipment id (needed for cancel/print/info). Null for Econt.
    carrierShipmentId: text('carrier_shipment_id'),
    status: text('status').notNull().default('pending'),
    labelPdfUrl: text('label_pdf_url'),
    courierPriceStotinki: integer('courier_price_stotinki'),
    codAmountStotinki: integer('cod_amount_stotinki'),
    trackingJson: jsonb('tracking_json'),
    customerNotifiedAt: timestamp('customer_notified_at', { withTimezone: true }),
    codCollectedAt: timestamp('cod_collected_at', { withTimezone: true }),
    codSettledAt: timestamp('cod_settled_at', { withTimezone: true }),
    // --- Courier consolidation (migration 0083) ---
    // Links the per-farmer courier shipments physically shipped as one parcel. The
    // MASTER (the collector's shipment) carries its OWN id here and its
    // cod_amount_stotinki holds the whole group's COD; each CHILD carries the
    // master's id and status='consolidated' (superseded, no waybill of its own).
    // NULL for every non-consolidated shipment.
    consolidationGroupId: uuid('consolidation_group_id').references((): AnyPgColumn => shipments.id, {
      onDelete: 'set null',
    }),
    // --- Standalone (order-less) shipments: a producer types the receiver in by
    // hand via the standalone Econt app, so there is no `orders` row to derive
    // from. NULL for FarmFlow shipments (which keep deriving from `orders`). ---
    receiverName: text('receiver_name'),
    receiverPhone: text('receiver_phone'),
    deliveryMode: text('delivery_mode'), // 'office' | 'address'
    receiverOfficeCode: text('receiver_office_code'),
    receiverCity: text('receiver_city'),
    receiverAddress: text('receiver_address'),
    weightKg: numeric('weight_kg'),
    contents: text('contents'),
    // Econt courier-pickup request lifecycle (requestCourier / getRequestCourierStatus).
    courierRequestId: text('courier_request_id'),
    courierRequestStatus: text('courier_request_status'),
    // nekorekten reporting lifecycle for a returned/refused COD parcel:
    // 'none' (default) → 'candidate' (cron flagged it) → 'reported' | 'refuted'.
    reportStatus: text('report_status').notNull().default('none'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (t) => ({
    orderUnique: uniqueIndex('shipments_order_unique').on(t.orderId),
    // Tenant-scoped shipment list + scoped delete.
    tenantIdx: index('shipments_tenant_idx').on(t.tenantId),
    // Status-refresh crons scan live (non-terminal) shipments per carrier; also
    // serves Speedy listShipments (WHERE carrier='speedy'). Was a full-table scan.
    carrierStatusIdx: index('shipments_carrier_status_idx').on(t.carrier, t.status),
    // cod-risk listCandidates: WHERE tenant_id=? AND report_status='candidate'.
    tenantReportIdx: index('shipments_tenant_report_idx').on(t.tenantId, t.reportStatus),
    tenantFarmerIdx: index('shipments_tenant_farmer_idx').on(t.tenantId, t.farmerId),
    // Panel/dostavki shipments list keyset: WHERE tenant_id=? ORDER BY created_at desc, id desc.
    tenantCreatedIdx: index('shipments_tenant_created_idx').on(t.tenantId, t.createdAt, t.id),
    consolidationGroupIdx: index('shipments_consolidation_group_idx').on(t.consolidationGroupId),
  }),
);

// --- Bulk import (standalone): staging for an uploaded Excel/CSV of recipients ---
// A batch holds one uploaded file; rows are editable drafts until committed into
// real `shipments`. Tenant-scoped like everything else in the standalone surface.
export const importBatches = pgTable(
  'import_batches',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    fileName: text('file_name'),
    carrierDefault: text('carrier_default').notNull().default('econt'), // 'econt' | 'speedy'
    currency: text('currency').notNull().default('EUR'), // 'BGN' | 'EUR'
    status: text('status').notNull().default('validating'), // validating|ready|partial|done
    settings: jsonb('settings'), // sender override, package preset, COD type, speedyServiceId
    aiReport: jsonb('ai_report'), // { aiAvailable, ok, warn, error }
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    tenantIdx: index('import_batches_tenant_idx').on(t.tenantId),
  }),
);

export const importRows = pgTable(
  'import_rows',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    rowIndex: integer('row_index').notNull(),
    raw: jsonb('raw'),
    receiverName: text('receiver_name'),
    receiverPhone: text('receiver_phone'),
    deliveryMode: text('delivery_mode'), // 'office' | 'address'
    city: text('city'),
    office: text('office'),
    address: text('address'),
    streetNo: text('street_no'),
    weightGrams: integer('weight_grams'),
    contents: text('contents'),
    codAmountStotinki: integer('cod_amount_stotinki'),
    declaredValueStotinki: integer('declared_value_stotinki'),
    carrier: text('carrier').notNull().default('econt'),
    validationStatus: text('validation_status').notNull().default('error'), // ok|warn|error
    validation: jsonb('validation'), // { issues: [...] }
    resolvedRefs: jsonb('resolved_refs'), // econtOfficeCode / siteId / officeId / streetId / candidates
    shipmentId: uuid('shipment_id').references(() => shipments.id),
    createStatus: text('create_status'), // null | 'creating' (transient claim) | 'created' | 'failed'
    createError: text('create_error'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    batchIdx: index('import_rows_batch_idx').on(t.batchId),
    tenantIdx: index('import_rows_tenant_idx').on(t.tenantId),
  }),
);

// Cross-tenant COD-risk registry: one row per normalized customer phone, counting
// refused/returned cash-on-delivery parcels seen across ALL farms (network effect).
export const codRisk = pgTable('cod_risk', {
  phone: text('phone').primaryKey(), // normalized E.164 BG, e.g. +359888123456
  strikes: integer('strikes').notNull().default(0),
  lastEventType: text('last_event_type'),
  lastEventAt: timestamp('last_event_at', { withTimezone: true }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  // Durable Nekorekten snapshot (replaces Redis cache). NULL nk_checked_at = never checked.
  nkFound: boolean('nk_found'),
  nkCount: integer('nk_count'),
  nkReports: jsonb('nk_reports'), // raw NekorektenReport[]
  nkCheckedAt: timestamp('nk_checked_at', { withTimezone: true }),
});

// Append-only provenance for each strike / report (who saw it, on which shipment).
export const codRiskEvents = pgTable(
  'cod_risk_events',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    phone: text('phone').notNull(),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    shipmentId: uuid('shipment_id').references(() => shipments.id),
    type: text('type').notNull(), // 'returned' (a strike) | 'reported' (sent to nekorekten)
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    phoneIdx: index('cod_risk_events_phone_idx').on(t.phone),
  }),
);

// One row per attempted SMS send — audit trail, dedup evidence, and cost
// accounting (segments). `kind` lets future message types reuse the table.
export const smsLog = pgTable(
  'sms_log',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    phone: text('phone').notNull(), // normalized E.164 BG
    body: text('body').notNull(),
    segments: smallint('segments').notNull().default(1),
    provider: text('provider').notNull(), // 'http' | 'log-only'
    providerMessageId: text('provider_message_id'),
    status: text('status').notNull(), // 'sent' | 'failed'
    error: text('error'),
    kind: text('kind').notNull().default('delivery_window'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    tenantCreatedIdx: index('sms_log_tenant_created_idx').on(t.tenantId, t.createdAt),
    orderIdx: index('sms_log_order_idx').on(t.orderId),
  }),
);

// Platform-level admins (ФермериБГ staff) — NOT tied to any tenant. Manage all farms.
export const platformAdmins = pgTable('platform_admins', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  // Forces a password change on first login — set true on the env-bootstrapped
  // super-admin so the seed/initial password can't persist indefinitely.
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  // Session epoch (see users.tokenVersion) — revokes platform tokens on change.
  tokenVersion: integer('token_version').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow(),
});

// Audit trail of admin mutations (who did what, when). Written by AuditInterceptor.
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    userId: uuid('user_id').references(() => users.id),
    // Super-admin (platform) actor — mutually exclusive with userId. Separate FK
    // because a platform admin is NOT a row in `users`; writing its id into user_id
    // would violate that FK and silently drop the audit row.
    adminId: uuid('admin_id').references(() => platformAdmins.id),
    // Producer (farmer sub-account) actor, when the mutating user is a farmer-role
    // login. NULL for owner/admin/system actions. Lets the super-admin audit viewer
    // drill into one producer's actions. Populated going forward (no backfill).
    farmerId: uuid('farmer_id').references(() => farmers.id),
    action: text('action').notNull(), // HTTP method
    path: text('path').notNull(), // request path
    statusCode: integer('status_code'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // revokeAccess looks up audit rows by user_id; deleteTenant deletes by tenant_id.
    userIdx: index('audit_logs_user_idx').on(t.userId),
    tenantIdx: index('audit_logs_tenant_idx').on(t.tenantId),
    // Producer drill-down: filter the audit feed to one farmer, newest-first.
    farmerIdx: index('audit_logs_farmer_idx').on(t.farmerId, t.createdAt),
    // Unfiltered super-admin feed: ORDER BY created_at desc, id desc, no filter.
    createdIdx: index('audit_logs_created_idx').on(t.createdAt, t.id),
  }),
);

// Server-side 5xx failures, written fire-and-forget by GlobalExceptionFilter. Backs
// the super-admin cross-tenant "Проблеми" feed (recent errors grouped by farm/path).
export const errorEvents = pgTable(
  'error_events',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    userId: uuid('user_id').references(() => users.id),
    adminId: uuid('admin_id').references(() => platformAdmins.id),
    method: text('method').notNull(),
    path: text('path').notNull(),
    statusCode: integer('status_code').notNull(),
    message: text('message'),
    stack: text('stack'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // Unfiltered feed / 24-48h window scans: ORDER BY created_at desc, id desc.
    createdIdx: index('error_events_created_idx').on(t.createdAt, t.id),
    // Per-farm drill-down, newest-first.
    tenantIdx: index('error_events_tenant_idx').on(t.tenantId, t.createdAt),
  }),
);

// Operator-marked "resolved" server-error groups, keyed by (tenant_id, path) — the
// same tuple errorProblems() groups by. A group is suppressed from the «Проблеми»
// feed while a resolution exists AND no newer error_events row for that group has
// created_at > resolved_at (a fresh error auto-reopens it).
export const errorResolutions = pgTable(
  'error_resolutions',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id), // nullable: platform-wide errors
    path: text('path').notNull(),
    resolvedAt: timestamp('resolved_at').notNull().defaultNow(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // Null-safe uniqueness via two partial unique indexes (Postgres treats NULLs as
    // distinct in a plain UNIQUE, so tenant_id IS NULL rows need their own index).
    tenantPathIdx: uniqueIndex('error_resolutions_tenant_path_idx')
      .on(t.tenantId, t.path)
      .where(sql`tenant_id is not null`),
    platformPathIdx: uniqueIndex('error_resolutions_platform_path_idx')
      .on(t.path)
      .where(sql`tenant_id is null`),
  }),
);

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
    // Admin list keyset: tenant-scoped, createdAt DESC + id tiebreaker (fully index-served).
    tenantCreatedIdx: index('articles_tenant_created_idx').on(t.tenantId, t.createdAt, t.id),
  }),
);

// Ordered media blocks for an article. `url` is the R2 url for uploads or the source
// URL for embeds; `embed_id` is the parsed YouTube video id / Instagram shortcode.
export const articleMedia = pgTable(
  'article_media',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    articleId: uuid('article_id').references(() => articles.id, { onDelete: 'cascade' }),
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
  // Subscriber list + broadcast filter by tenant, sort by createdAt. `id` tiebreaker
  // makes the keyset (created_at, id) order fully index-served.
  (t) => ({
    tenantCreatedIdx: index('newsletter_subscribers_tenant_created_idx').on(
      t.tenantId,
      t.createdAt,
      t.id,
    ),
    // UNIQUE (tenant + email): backs `onConflictDoNothing` so concurrent sign-ups
    // can't race past a select-then-insert check and create duplicate rows (which
    // would inflate the active count + double-bill broadcasts).
    tenantEmailUnique: uniqueIndex('newsletter_subscribers_tenant_email_idx').on(t.tenantId, t.email),
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

// Block-builder newsletter campaigns: editor content (block JSON) + draft/sent
// state. Drafts persist so a farmer can come back; on send the campaign flips to
// 'sent' and an immutable email_pushes ledger row is written for billing.
export const newsletterCampaigns = pgTable('newsletter_campaigns', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  subject: text('subject').notNull().default(''),
  blocks: jsonb('blocks').notNull().default(sql`'[]'::jsonb`),
  status: text('status').notNull().default('draft'), // 'draft' | 'sent'
  recipientCount: integer('recipient_count'),
  priceStotinki: integer('price_stotinki'),
  // Set true on drafts created by the weekly auto-draft cron (so it can dedup —
  // skip a tenant that still has an unreviewed auto-draft). Farmer/manual drafts
  // stay false.
  autoGenerated: boolean('auto_generated').notNull().default(false),
  sentAt: timestamp('sent_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (t) => ({
  // Campaign list is newest-edited first, tenant-scoped.
  tenantUpdatedIdx: index('newsletter_campaigns_tenant_updated_idx').on(t.tenantId, t.updatedAt),
}));

// Billing ledger of newsletter sends — the immutable usage record the farm is
// charged for (per-recipient price, captured per row so historical pricing is
// preserved). One row per send; links back to its campaign.
export const emailPushes = pgTable('email_pushes', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  tenantId: uuid('tenant_id').references(() => tenants.id),
  campaignId: uuid('campaign_id').references(() => newsletterCampaigns.id),
  subject: text('subject'),
  recipientCount: integer('recipient_count').notNull(),
  priceStotinki: integer('price_stotinki').notNull(),
  // Stripe invoice-item id created when the push is billed (double-bill guard;
  // null = not billed, e.g. premium farm or a billing error).
  stripeInvoiceItemId: text('stripe_invoice_item_id'),
  createdAt: timestamp('created_at').defaultNow(),
}, (t) => ({
  // Super-admin email-billing aggregates join/filter by tenant.
  tenantIdx: index('email_pushes_tenant_idx').on(t.tenantId),
}));

// Storefront contact-form submissions (public intake). Read in the admin panel
// later; for now just persisted.
export const contactMessages = pgTable(
  'contact_messages',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    name: text('name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    message: text('message').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  // The admin inbox lists a tenant's messages newest-first — index-serve it.
  (t) => ({
    tenantCreatedIdx: index('contact_messages_tenant_created_idx').on(t.tenantId, t.createdAt),
  }),
);

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
  // `id` tiebreaker → status-filtered keyset + the public "latest 60" list are fully
  // index-served (no Sort).
  (t) => ({
    tenantStatusCreatedIdx: index('reviews_tenant_status_created_idx').on(
      t.tenantId,
      t.status,
      t.createdAt,
      t.id,
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
    email: text('email'),
    since: text('since'),
    // Home settlement of the farm (free text, e.g. "Варна"). Public — surfaced on
    // the marketplace so shoppers see where a producer is based and can filter by
    // delivery area. NULL = not set.
    city: text('city'),
    // Vendor finance overrides (DORMANT): NULL = inherit the tenant default from
    // tenants.settings.vendorFinance. Rate in basis points (500 = 5%); fee in the
    // same minor unit as order totals.
    commissionRateBps: integer('commission_rate_bps'),
    subscriptionFeeStotinki: integer('subscription_fee_stotinki'),
    tint: text('tint'),
    imageUrl: text('image_url'),
    // How the cover image is framed in storefront cards: focal point (x/y, 0..1)
    // + zoom (1..3). NULL = legacy behavior (centered, no zoom). See CoverCrop.
    coverCrop: jsonb('cover_crop').$type<{ x: number; y: number; zoom: number; shape?: 'wide' | 'square' | 'tall' }>(),
    // Tier-2 „Бранд идентичност" — paid, operator-unlocked per-farmer branding for the
    // farmer's marketplace subpage. NULL / enabled:false = default compact card (today's
    // behavior, zero blast radius). Primary brand color reuses `tint`; portrait reuses
    // `imageUrl`; gallery reuses `farmer_media`. Only the control layer lives here.
    // `enabled` is the paid gate (billing/collection is a separate seam, like vendorFinance
    // dormant). `gallery` picks the photo-grid layout; `badges` render as chips.
    branding: jsonb('branding').$type<{
      enabled: boolean;
      plan?: 'tier2';
      accent?: string;
      headingFont?: string;
      gallery?: 'wide' | 'mosaic' | 'row' | 'grid';
      badges?: string[];
      unlockedAt?: string;
      unlockedBy?: string;
    }>(),
    // Legal seller identity for the FARMER-AS-SELLER marketplace model: on farmmarket
    // each producer is the legal Продавач (own Econt waybill, own COD/IBAN, self-reports
    // to НАП), so КЗП requires the buyer be shown exactly who they contract with. This
    // is PUBLIC seller disclosure (surfaced on the storefront), NOT owner-only finance —
    // it IS included in the public projection (contrast commissionRateBps, which is
    // stripped). NULL = not yet provided (gradual onboarding; a farmer without it can't
    // be flipped to a live seller). `kind` drives which fields matter: individual =
    // физическо лице / регистриран земеделски производител (use `regNo`), sole_trader =
    // ЕТ (use `eik`), company = ЕООД/ООД/АД (use `eik`, optional `vatNumber`). Final
    // field set to be confirmed with the юрист/счетоводител — jsonb keeps that cheap.
    legal: jsonb('legal').$type<{
      kind?: 'individual' | 'sole_trader' | 'company';
      /** Юридическо/фирмено име на продавача, напр. „ЕТ Димка Четова", „Пчеларство ЕООД",
       *  или трите имена за физическо лице. */
      name?: string;
      /** ЕИК/БУЛСТАТ (ЕТ/фирма). */
      eik?: string;
      /** ДДС номер, ако е регистриран по ЗДДС (по избор). */
      vatNumber?: string;
      /** Адрес на управление/седалище/за кореспонденция. */
      address?: string;
      /** Регистрационен номер на земеделски производител (Наредба 3), за физ. лице. */
      regNo?: string;
      /** Кога операторът/фермерът е потвърдил данните (одит следа). */
      confirmedAt?: string;
    }>(),
    // Farmer profile v1 (migration 0105). internalNotes + payout are OPERATOR-ONLY
    // (never in the public projection); story IS public (added to findPublicBySlug).
    internalNotes: text('internal_notes'),
    story: text('story'),
    payout: jsonb('payout').$type<{ iban?: string; holder?: string; bic?: string }>(),
    // Reusable farmer signature for handover protocols — ENCRYPTED at rest
    // (server/src/common/crypto/signature-crypto). Operator-only; never in the public
    // projection. NULL = none saved yet. (migration 0110)
    signaturePng: text('signature_png'),
    // Marketplace ranking tier (operator-assigned). 1 = базов листинг, 2 = Бранд
    // идентичност, 3 = собствен сайт. The marketplace sorts farmers by tier DESC
    // (tier 3 on top, tier 1 at the bottom), then position. Auto-bumps to >=2 when
    // branding.enabled (in farmers.service.update), operator can override.
    tier: smallint('tier').notNull().default(1),
    position: integer('position').notNull().default(0),
    // Producer-map coordinates (logistics), geocoded from legal.address/city and cached.
    // NULL = unresolved. (migr 0102)
    lat: numeric('lat', { precision: 10, scale: 7 }),
    lng: numeric('lng', { precision: 10, scale: 7 }),
    geocodedAt: timestamp('geocoded_at', { withTimezone: true }),
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
    // How the cover image is framed in the storefront section banner: focal point
    // (x/y, 0..1) + zoom (1..3). NULL = legacy behavior (centered, no zoom).
    coverCrop: jsonb('cover_crop').$type<{ x: number; y: number; zoom: number; shape?: 'wide' | 'square' | 'tall' }>(),
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
    /** Pre-fix upload, kept so the panel can offer "върни оригинала" — set only
     *  when the image-sanity worker replaces `url` with an auto-rotated/cropped
     *  derivative. Null for every photo the worker never touched. */
    originalUrl: text('original_url'),
    /** True once the image-sanity worker has replaced `url` with a fixed version. */
    autoFixed: boolean('auto_fixed').notNull().default(false),
    /** Vision worker's verdict on the flagged photo — 'ok' (fixed) | 'unusable'
     *  (left as-is, flagged for the operator) | null (never flagged / not yet run). */
    sanityVerdict: text('sanity_verdict'),
    /** BG-facing reason for the verdict, e.g. „снимката е замъглена". */
    sanityReason: text('sanity_reason'),
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

// Commission ledger (DORMANT until tenants.settings.vendorFinance.commissionEnabled).
// One row per (order, farmer): the farmer's item-only gross (delivery fee excluded,
// matching the turnover rule) and the commission at the rate SNAPSHOTTED at accrual
// time — enabling commission later must never retro-charge old orders. Accrual fires
// on the collected-money signal (COD received / Stripe paid), void on cancel/refusal.
export const commissionEntries = pgTable(
  'commission_entries',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    farmerId: uuid('farmer_id').references(() => farmers.id, { onDelete: 'cascade' }),
    grossStotinki: integer('gross_stotinki').notNull(),
    rateBps: integer('rate_bps').notNull(),
    commissionStotinki: integer('commission_stotinki').notNull(),
    status: commissionEntryStatusEnum('status').notNull().default('accrued'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // Idempotent accrual: re-running accrueForOrder must not duplicate rows.
    orderFarmerUniq: uniqueIndex('commission_entries_order_farmer_uniq').on(t.orderId, t.farmerId),
    // Farmer statement + owner summary: tenant-scoped, per farmer, by period.
    tenantFarmerCreatedIdx: index('commission_entries_tenant_farmer_created_idx').on(
      t.tenantId,
      t.farmerId,
      t.createdAt,
    ),
  }),
);

// Task #14: per-(order, farmer) fulfilment self-tracking, driven off the daily
// «tomorrow» farmer email. A shared multi-farmer order gets one independent row
// per producer — one farm running behind never blocks another's status on the
// same order. 'pending' (default, nothing marked) → 'in_production' → 'fulfilled'.
// See migration 0098.
export const orderFulfillments = pgTable(
  'order_fulfillments',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }),
    farmerId: uuid('farmer_id').references(() => farmers.id, { onDelete: 'cascade' }),
    state: text('state').notNull().default('pending'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Re-marking a row updates in place — never a duplicate per (order, farmer).
    orderFarmerUniq: uniqueIndex('order_fulfillments_order_farmer_uniq').on(t.orderId, t.farmerId),
    // «Утре» panel: this farmer's fulfilment rows, tenant-scoped.
    tenantFarmerIdx: index('order_fulfillments_tenant_farmer_idx').on(t.tenantId, t.farmerId),
  }),
);

// Vendor monthly subscription charges (DORMANT until
// tenants.settings.vendorFinance.subscriptionEnabled). Generated per farmer per
// 'YYYY-MM' period; the operator collects the money off-platform and marks rows
// paid/waived. No auto-charging anywhere.
export const vendorSubscriptionCharges = pgTable(
  'vendor_subscription_charges',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
    tenantId: uuid('tenant_id').references(() => tenants.id),
    farmerId: uuid('farmer_id').references(() => farmers.id, { onDelete: 'cascade' }),
    // Billing month as 'YYYY-MM' (Europe/Sofia semantics decided by the caller).
    period: text('period').notNull(),
    feeStotinki: integer('fee_stotinki').notNull(),
    status: vendorChargeStatusEnum('status').notNull().default('due'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    note: text('note'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => ({
    // Idempotent generation: one charge per farmer per month.
    farmerPeriodUniq: uniqueIndex('vendor_subscription_charges_farmer_period_uniq').on(
      t.farmerId,
      t.period,
    ),
    tenantPeriodIdx: index('vendor_subscription_charges_tenant_period_idx').on(
      t.tenantId,
      t.period,
    ),
  }),
);

export const schema = {
  tenants,
  users,
  products,
  productVariants,
  productAvailabilityWindows,
  farmers,
  subcategories,
  productMedia,
  farmerMedia,
  subcategoryMedia,
  deliverySlots,
  smsLog,
  orders,
  orderItems,
  handoverProtocols,
  orderFulfillments,
  commissionEntries,
  vendorSubscriptionCharges,
  siteEvents,
  stripeEvents,
  shipments,
  importBatches,
  importRows,
  auditLogs,
  errorEvents,
  errorResolutions,
  platformAdmins,
  articles,
  articleMedia,
  newsletterSubscribers,
  contactMessages,
  reviews,
  userRoleEnum,
  reviewStatusEnum,
  orderStatusEnum,
  codOutcomeEnum,
  subscriptionStatusEnum,
  commissionEntryStatusEnum,
  vendorChargeStatusEnum,
  articleStatusEnum,
  articleMediaTypeEnum,
};
