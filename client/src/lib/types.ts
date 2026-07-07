/** Admin view of an availability window (GET /availability-windows). */
export interface AvailabilityWindow {
  id: string;
  productId: string;
  startsAt: string; // 'YYYY-MM-DD'
  endsAt: string;
  quantity: number;
  remaining: number;
}

/** Keyset-paginated list envelope returned by admin list endpoints. */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

/** Numbered-page response (offset pagination) — e.g. GET /orders. */
export interface Paged<T> {
  items: T[];
  total: number;
}

export type ReviewStatus = 'pending' | 'published' | 'hidden';

/** Admin view of a review (GET /reviews). */
export interface AdminReview {
  id: string;
  authorName: string;
  authorLocation: string | null;
  rating: number;
  body: string;
  status: ReviewStatus;
  productId: string | null;
  createdAt: string;
}

/** Lean product shape from GET /products/options (cross-page counts/notifs). */
export interface ProductOption {
  id: string;
  name: string;
  weight: string | null;
  tint: string | null;
  isActive: boolean | null;
  stockQuantity: number | null;
  farmerId: string | null;
  subcategoryId: string | null;
  courierDisabled: boolean;
}

/** Product as returned by the API (GET /products). */
export interface Product {
  id: string;
  name: string;
  description: string | null;
  priceStotinki: number;
  unit: string;
  weight: string | null;
  category: string | null;
  tint: string | null;
  /** NULL = unlimited stock. */
  stockQuantity: number | null;
  isActive: boolean;
  /** Pickup-only: never shipped by courier (perishable/fragile). Storefront hides
   *  courier delivery when such a product is in the cart. */
  courierDisabled: boolean;
  imageUrl: string | null;
  /** Cover framing for the storefront card; null = centered, no zoom. */
  coverCrop: CoverCrop | null;
  farmerId: string | null;
  subcategoryId: string | null;
  /** Storefront display order (farmer-controlled). Lower = earlier. */
  position: number;
  /** Promotion: discount percent (1..99) or null. */
  salePercent: number | null;
  /** Promotion end date (ISO) or null = no end. */
  saleEndsAt: string | null;
  /** Product-level fixed promo price (stotinki) or null. Plain products only. */
  salePriceStotinki: number | null;
  createdAt: string;
}

/** A product variant (вид/грамаж) as edited in the panel. */
export interface ProductVariant {
  id: string;
  label: string;
  priceStotinki: number;
  /** Fixed promo price (stotinki); null = no per-variant promo. */
  salePriceStotinki: number | null;
  /** null = unlimited stock. */
  stockQuantity: number | null;
  position: number;
}

/** How a cover image is framed on the storefront: focal point (x/y, 0..1) + zoom
 *  (1..3). null = centered, no zoom. Mirrors @fermeribg/types CoverCrop. */
export interface CoverCrop {
  x: number;
  y: number;
  zoom: number;
  shape?: 'wide' | 'square' | 'tall';
}

export interface Farmer {
  id: string;
  name: string;
  role: string | null;
  bio: string | null;
  phone: string | null;
  email: string | null;
  since: string | null;
  tint: string | null;
  imageUrl: string | null;
  coverCrop: CoverCrop | null;
  position: number;
  createdAt: string;
}

export interface FarmerAccess {
  hasLogin: true;
  loginEmail: string;
  invitePending: boolean;
}

export interface Subcategory {
  id: string;
  name: string;
  description: string | null;
  tint: string | null;
  imageUrl: string | null;
  coverCrop: CoverCrop | null;
  position: number;
  createdAt: string;
}

/** One gallery photo (admin GET /{products|farmers|subcategories}/:id/media).
 *  The cover is whichever photo sits at position 0. */
export interface MediaItem {
  id: string;
  url: string;
  position: number;
}

/** Subset of the tenant profile the panels read (GET /tenants/me). */
export interface TenantProfile {
  id: string;
  name: string;
  multiFarmer: boolean;
  multiSubcat: boolean;
  /** Storefront content sections, gated from the «Функции на магазина» panel. */
  articlesEnabled: boolean;
  reviewsEnabled: boolean;
  deliveryEnabled: boolean;
  /** Super-admin „пакет Доставки" gate. When false, the panel hides delivery
   *  config + the dostavki deep-link, and the storefront offers no courier. */
  deliveriesPackageEnabled: boolean;
  /** «Продукт на седмицата» highlight config. */
  productOfWeekEnabled: boolean;
  productOfWeekMode: 'manual' | 'auto';
  productOfWeekId: string | null;
  productOfWeekNote: string | null;
  /** Where the highlight renders: full 'section' or a thin 'bar' above the header. */
  productOfWeekPlacement: 'section' | 'bar';
  /** Home / depot — the delivery route origin. */
  farmAddress: string | null;
  farmLat: string | null;
  farmLng: string | null;
  /** Per-tenant delivery config (settings.delivery). Null until first saved. */
  delivery: DeliveryConfig | null;
  /** Route-end config (settings.routing): { endMode, endAddress, endLat, endLng }. */
  routing: RoutingConfig | null;
}

export type RouteEndMode = 'home' | 'last' | 'custom';
export type RouteOrderMode = 'slots' | 'distance';

export interface RoutingConfig {
  endMode?: RouteEndMode;
  endAddress?: string | null;
  endLat?: string | null;
  endLng?: string | null;
}

// ---- Delivery configuration (persisted to tenant.settings.delivery) ----

export type DeliveryMethodKey = 'econtOffice' | 'econtAddress' | 'ownSlots' | 'pickup';
export type PricingType = 'free' | 'flat';
export type Payer = 'customer' | 'farm';

/** Per-method price rule. Money in integer stotinki (cents). */
export interface MethodPricing {
  type: PricingType;
  feeStotinki?: number;
}

export interface DeliveryMethod {
  enabled: boolean;
  label: string;
  pricing?: MethodPricing;
  etaText?: string;
  payer?: Payer;
  minOrderStotinki?: number;
  /** pickup only */
  address?: string;
  hours?: string;
  /** pickup only — optional fixed recurring schedule (0=Sun..6=Sat). When set,
   *  the storefront shows a computed schedule line instead of `hours`. */
  pickupWeekday?: number;
  pickupFrom?: string; // HH:MM
  pickupTo?: string; // HH:MM
}

export interface DeliveryMethods {
  econtOffice: DeliveryMethod;
  econtAddress: DeliveryMethod;
  ownSlots: DeliveryMethod;
  pickup: DeliveryMethod;
  /** display order of the method keys */
  order: DeliveryMethodKey[];
}

export interface DeliverySchedule {
  weekdays: number[]; // 0=Sun … 6=Sat
  cutoffTime: string; // HH:MM
  leadDays: number;
  sameDay: boolean;
  maxPerDay: number;
  blackout: string[]; // ISO dates
}

export interface DeliveryPricing {
  freeThresholdStotinki: number;
}

export interface EcontSender {
  name: string;
  phone: string;
  cityId: number;
  cityName: string;
  mode: 'office' | 'address';
  officeCode?: string;
  address?: string;
}

export interface EcontConfig {
  env: 'demo' | 'prod';
  /**
   * How the farm fulfils Econt orders:
   *  - `off`    — Econt not offered.
   *  - `manual` — offered at a flat fee; the farm ships each order itself (no API).
   *  - `auto`   — live Econt API (price + waybill + tracking).
   * Optional for back-compat; absent + `configured` is treated as `auto`.
   */
  mode?: 'off' | 'manual' | 'auto';
  /** True once credentials have been saved. The raw password is never stored/returned. */
  configured: boolean;
  username?: string;
  sender: EcontSender;
  defaultPackage: { weightKg: number; dimensions?: string; contents: string };
  cod: { enabled: boolean; feePayer: Payer };
  label: { paper: 'A4' | 'A6'; autoCreate: boolean };
  nomenclature: { lastSyncedAt: string; cities: number; offices: number };
}

/** Sender profile for Speedy waybills (id-based addresses). Mirrors the server
 *  `SpeedyStored.sender`; `siteName` is a client-only display label. */
export interface SpeedySender {
  contactName?: string;
  phone?: string;
  mode?: 'office' | 'address';
  officeId?: number;
  officeName?: string;
  siteId?: number;
  siteName?: string;
  streetId?: number;
  streetName?: string;
  streetNo?: string;
}

/** Per-tenant Speedy config (settings.delivery.speedy). The encrypted password is
 *  owned by the server and never reaches the client (mirrors EcontConfig). */
export interface SpeedyConfig {
  env?: 'demo' | 'prod';
  /** True once credentials have been validated + saved. */
  configured?: boolean;
  userName?: string;
  clientSystemId?: number;
  /** Default Speedy courier-service code used for estimates. */
  defaultServiceId?: number;
  sender?: SpeedySender;
  defaultPackage?: { parcelsCount?: number; weightKg?: number; contents?: string };
  cod?: { enabled?: boolean; processingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER' };
  label?: { autoCreate?: boolean };
}

/** Which carrier fulfils a door order when the farm runs BOTH carriers. */
export type CarrierPolicy = 'customer' | 'cheapest' | 'econt' | 'speedy';

/** Carrier-agnostic handling policy applied to every COD/courier shipment.
 *  inspectBeforePay only ever applies to наложен платеж; ignored on prepaid. */
export type InspectBeforePay = 'off' | 'open' | 'test';
export interface HandlingPolicy {
  inspectBeforePay: InspectBeforePay; // отвори / тествай преди плащане
  refrigerated: boolean;              // хладилна доставка
}

/** The full per-tenant delivery config blob (without the master `enabled` flag,
 *  which maps to the tenant's `deliveryEnabled` column). */
export interface DeliveryConfig {
  methods: DeliveryMethods;
  schedule: DeliverySchedule;
  pricing: DeliveryPricing;
  econt: EcontConfig;
  /** Live Speedy integration (second courier). Absent → not offered. */
  speedy?: SpeedyConfig;
  /** Which carrier wins a door order when both are live. Absent → 'customer'. */
  carrierPolicy?: CarrierPolicy;
  /** Customer-facing наложен платеж (COD) toggle. Absent → treated as enabled. */
  cod?: { enabled: boolean };
  /** Card (online/Stripe) toggle. Absent → enabled; off → COD-only even with Stripe connected. */
  card?: { enabled: boolean };
  /** Shared handling policy (inspect-before-pay + refrigerated). Absent → all off. */
  handling?: HandlingPolicy;
}

/** A Speedy settlement (нас. място) for the sender-site autocomplete. */
export interface SpeedySite {
  id: number;
  name: string;
  postCode: string | null;
}

/** A Speedy office for the sender office picker. */
export interface SpeedyOffice {
  id: number;
  name: string;
  address: string | null;
}

/** A Speedy contract-client suggestion (prefills the sender profile). */
export interface SpeedySenderSuggestion {
  name: string;
  phone: string;
  clientNumber: string | null;
}

/** Econt office nomenclature row (global, mock for now). */
export interface EcontOffice {
  code: string;
  name: string;
  address: string;
  cityName: string;
  workingHours: string;
  dist?: string;
}

/** A settlement from Econt's live nomenclature (admin city autocomplete). */
export interface EcontCity {
  id: number;
  name: string;
  postCode: string | null;
}

/** A live Econt office for the admin picker + map (with coordinates + hours). */
export interface EcontOfficeLive {
  code: string;
  name: string;
  city: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  hours: string | null;
}

export type ShipmentStatus = 'pending' | 'created' | 'shipped' | 'delivered' | 'returned';

export interface ShipmentEvent {
  at: string;
  label: string;
  location?: string;
}

/** An order with its carrier waybill. */
export interface Shipment {
  orderId: string;
  orderNumber: string;
  customerName: string;
  method: DeliveryMethodKey;
  status: ShipmentStatus;
  /** Which carrier owns this shipment — used to route print/create/void/refresh actions. */
  carrier: 'econt' | 'speedy';
  trackingNumber?: string;
  priceStotinki?: number;
  history?: ShipmentEvent[];
  /** The shipment row id (present once a waybill exists) — for void/refresh. */
  shipmentId?: string;
  /** When set, the farm can print the carrier waybill PDF. */
  labelPdfUrl?: string;
}

export type ArticleStatus = 'draft' | 'published';
export type ArticleMediaType = 'image' | 'video' | 'youtube' | 'instagram';

/** One ordered media block of an article. */
export interface ArticleMedia {
  id: string;
  articleId?: string | null;
  type: ArticleMediaType;
  /** R2 url for uploads; source URL for embeds. */
  url: string;
  /** Parsed YouTube video id / Instagram shortcode (embeds only). */
  embedId: string | null;
  caption: string | null;
  position: number;
}

/** Article with its ordered media (admin GET /articles, GET /articles/:id). */
export interface Article {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body: string | null;
  coverImageUrl: string | null;
  status: ArticleStatus;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  media: ArticleMedia[];
}

/** Delivery slot with its live `booked` count (GET /slots). Free while
 *  `booked` is below `capacity`. */
export interface Slot {
  id: string;
  date: string; // YYYY-MM-DD
  timeFrom: string; // HH:MM:SS
  timeTo: string; // HH:MM:SS
  isActive: boolean;
  booked: number;
  capacity: number;
  customerNote: string | null;
  driverNote: string | null;
  generated: boolean;
}

/** One delivery window (hours only — capacity is tracked separately). */
export interface SlotWindow {
  timeFrom: string; // HH:MM
  timeTo: string; // HH:MM
}

/** A window bound to a weekday (0=Sun..6=Sat). */
export interface SlotDay extends SlotWindow {
  dow: number;
}

/** The single recurring self-delivery rule (settings.slotRule). */
export interface SlotRule {
  active: boolean;
  repeat: 'weekdays' | 'interval';
  days: SlotDay[]; // weekdays mode — one window per picked weekday
  intervalDays: number;
  intervalWindow: SlotWindow; // interval mode — single window
  anchorDate: string; // YYYY-MM-DD
  /** Minutes one delivery takes; >0 splits each window into slots of this length. 0/absent = one slot. */
  slotMinutes?: number;
  defaultCapacity?: number;
  customerNote?: string;
  driverNote?: string;
  horizonDays: number;
  skipDates: string[];
  lastMaterializedDate?: string;
}

/** What the admin form sends to PUT /slots/rule — server owns skipDates + lastMaterializedDate. */
export type SlotRuleInput = Omit<SlotRule, 'skipDates' | 'lastMaterializedDate'>;

export interface OrderItem {
  id: string;
  productId: string | null;
  variantId: string | null;
  productName: string | null;
  quantity: number;
  priceStotinki: number;
}

/** A slot with its live booked count, as returned in the dashboard summary. */
export interface DashboardSlot {
  id: string;
  timeFrom: string;
  timeTo: string;
  booked: number;
  capacity: number;
}

/** Today's dashboard summary (GET /dashboard?date=). */
export interface DashboardSummary {
  date: string;
  orderCount: number;
  orderDelta: number;
  /** Product turnover for the day (delivery fees excluded). */
  revenueStotinki: number;
  /** Delivery fees collected today, kept apart from turnover. */
  deliveryRevenueStotinki: number;
  pendingCount: number;
  nextSlot: DashboardSlot | null;
  slots: DashboardSlot[];
  subscriptionActive: boolean;
}

// ── Sales statistics (GET /stats?range=) — the over-time companion to the
//    today-only dashboard. ──
export type StatsRange = '7d' | '30d' | '90d' | '1y';
/** Either a quick preset or a farmer-picked custom from→to window. */
export type StatsRangeTag = StatsRange | 'custom';
export type StatsBucket = 'day' | 'week' | 'month';

/** One point on the trend line. Both metrics travel together so the UI toggles
 *  Поръчки/Оборот without a refetch. */
export interface StatsPoint {
  t: string;
  orders: number;
  revenueStotinki: number;
}

export interface TopProduct {
  name: string;
  quantity: number;
  revenueStotinki: number;
}

export interface WeekdayLoad {
  /** 0=Sunday … 6=Saturday. */
  dow: number;
  orders: number;
  revenueStotinki: number;
}

export interface StatsSummary {
  range: StatsRangeTag;
  bucket: StatsBucket;
  /** Resolved window (BG dates, both inclusive). */
  from: string;
  to: string;
  /** Product turnover (delivery fees excluded). */
  revenueStotinki: number;
  /** Delivery fees collected in the window, kept apart from turnover. */
  deliveryRevenueStotinki: number;
  orderCount: number;
  avgOrderStotinki: number;
  prevRevenueStotinki: number;
  prevOrderCount: number;
  customerCount: number;
  returningCustomers: number;
  newCustomers: number;
  codOrders: number;
  codRevenueStotinki: number;
  onlineOrders: number;
  onlineRevenueStotinki: number;
  topProducts: TopProduct[];
  /** Least-sold active products (zero-sellers first) — discount/drop candidates. */
  slowProducts: TopProduct[];
  /** Orders + revenue per weekday (7 entries, dow 0..6) — capacity planning. */
  weekdayLoad: WeekdayLoad[];
  /** Too few orders for the lists/loyalty to mean anything yet. */
  sparse: boolean;
  points: StatsPoint[];
}

/** One delivery stop on the optimized route (GET /orders/route). */
export interface RouteStop {
  id: string;
  customer: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  /** Block/entrance/floor/flat detail for the driver (бл./вх.). */
  note: string | null;
  lat: number | null;
  lng: number | null;
  summary: string;
  slotFrom: string | null;
  slotTo: string | null;
}

/** Delivery route for a date (GET /orders/route?date=). */
export interface RouteEnd {
  mode: RouteEndMode;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

export interface RouteResult {
  date: string; // YYYY-MM-DD
  origin: { address: string | null; lat: number | null; lng: number | null };
  stops: RouteStop[];
  /** Where the van goes after the last delivery. */
  end: RouteEnd;
  /** How stops were ordered (by time slot, or by shortest distance). */
  orderMode: RouteOrderMode;
  totalDistanceM: number | null;
  totalDurationS: number | null;
  optimized: boolean;
  /** Encoded road-geometry legs for the final visit order; the map decodes +
   *  draws them so the route line follows streets. null → straight-segment
   *  fallback between pins. */
  polyline: string[] | null;
}

// ── Site analytics (GET /analytics?range=) — visitors/funnel/traffic, the
//    behavioral companion to the order-driven `StatsSummary` above. ──
export type FunnelKey =
  | 'page_view'
  | 'product_view'
  | 'add_to_cart'
  | 'checkout_start'
  | 'purchase';

export interface FunnelStep {
  key: FunnelKey;
  label: string;
  visitors: number;
}

export interface AnalyticsPoint {
  t: string;
  visitors: number;
  pageViews: number;
  purchases: number;
}

export interface WeekdayStat {
  label: string;
  visitors: number;
  purchasers: number;
  conversionPct: number;
}

export interface AnalyticsSummary {
  range: StatsRangeTag;
  bucket: StatsBucket;
  /** Resolved window (BG dates, both inclusive). */
  from: string;
  to: string;
  visitors: number;
  pageViews: number;
  prevVisitors: number;
  purchases: number;
  conversionPct: number;
  prevConversionPct: number;
  funnel: FunnelStep[];
  sources: { host: string; visitors: number; purchases: number; conversionPct: number }[];
  topPages: { path: string; label: string; views: number }[];
  devices: { mobile: number; desktop: number };
  points: AnalyticsPoint[];
  weekdayPattern: WeekdayStat[];
  /** Too few visitors for the breakdowns to mean anything yet. */
  sparse: boolean;
}

/** One aggregated product row in the daily prep list. */
export interface ProductionItem {
  productName: string;
  totalQty: number;
  orderCount: number;
  farmerId: string | null;
  farmerName: string | null;
}

/** Daily prep list (GET /orders/production?date=). */
export interface ProductionSummary {
  date: string; // YYYY-MM-DD
  confirmedOrders: number;
  /** Still-pending orders for the day — not yet in the prep list (nudge to confirm). */
  pendingOrders: number;
  multiFarmer: boolean;
  items: ProductionItem[];
}

/** How an order was paid, derived server-side from Stripe state. */
export type PaymentStatus = 'paid' | 'pending_online' | 'cash';

/** Order as returned by GET /orders (with items + joined slot times). */
export interface Order {
  id: string;
  /** Human-friendly per-tenant number (#1, #2, …); null on legacy rows. */
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  status: 'pending' | 'confirmed' | 'delivered' | 'cancelled';
  /** Paid online (card) / started online but unpaid / cash on delivery. */
  paymentStatus: PaymentStatus;
  /** ISO timestamp the online (Stripe) payment was captured, else null. */
  paidAt: string | null;
  totalStotinki: number;
  deliveryType: 'pickup' | 'address' | 'econt' | 'econt_address' | 'courier';
  codOutcome: 'received' | 'refused' | null;
  codOutcomeReason: string | null;
  codOutcomeAt: string | null;
  deliveryAddress: string | null;
  /** Block/entrance/floor/flat detail (бл./вх.), kept separate from the street. */
  deliveryNote: string | null;
  econtOffice: string | null;
  notes: string | null;
  createdAt: string;
  /** Chosen delivery slot (local/address delivery): day + time window. */
  slotId: string | null;
  slotDate: string | null;
  slotFrom: string | null;
  slotTo: string | null;
  items: OrderItem[];
}

/** Payload for PATCH /orders/:id — every field optional. `items` replaces all
 *  lines; `slotId: null` clears the slot. */
export interface UpdateOrderInput {
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string | null;
  deliveryAddress?: string;
  deliveryNote?: string | null;
  econtOffice?: string;
  slotId?: string | null;
  notes?: string | null;
  items?: { productId: string; quantity: number; variantId?: string }[];
}
