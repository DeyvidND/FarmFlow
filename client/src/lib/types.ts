/** Keyset-paginated list envelope returned by admin list endpoints. */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
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
  imageUrl: string | null;
  farmerId: string | null;
  subcategoryId: string | null;
  createdAt: string;
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
  position: number;
  createdAt: string;
}

export interface Subcategory {
  id: string;
  name: string;
  description: string | null;
  tint: string | null;
  imageUrl: string | null;
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
  deliveryEnabled: boolean;
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
export type PricingType = 'free' | 'flat' | 'byWeight' | 'freeOver';
export type Payer = 'customer' | 'farm';

/** Per-method price rule. Money in integer stotinki (cents). */
export interface MethodPricing {
  type: PricingType;
  feeStotinki?: number;
  freeOverStotinki?: number;
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

export interface WeightTier {
  uptoKg: number;
  feeStotinki: number;
}
export interface DeliveryZone {
  region: string;
  feeStotinki: number;
}

export interface DeliveryPricing {
  freeThresholdStotinki: number;
  model: 'flat' | 'byWeight' | 'byZone';
  flatFeeStotinki?: number;
  weightTiers?: WeightTier[];
  zones?: DeliveryZone[];
  packagingFeeStotinki?: number;
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

/** The full per-tenant delivery config blob (without the master `enabled` flag,
 *  which maps to the tenant's `deliveryEnabled` column). */
export interface DeliveryConfig {
  methods: DeliveryMethods;
  schedule: DeliverySchedule;
  pricing: DeliveryPricing;
  econt: EcontConfig;
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

/** An order with its Econt waybill (mock for now). */
export interface Shipment {
  orderId: string;
  orderNumber: string;
  customerName: string;
  method: DeliveryMethodKey;
  status: ShipmentStatus;
  trackingNumber?: string;
  priceStotinki?: number;
  history?: ShipmentEvent[];
  /** The Econt shipment row id (present once a waybill exists) — for void/refresh. */
  shipmentId?: string;
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

/** Delivery slot with its live `booked` count (GET /slots). */
export interface Slot {
  id: string;
  date: string; // YYYY-MM-DD
  timeFrom: string; // HH:MM:SS
  timeTo: string; // HH:MM:SS
  maxOrders: number;
  currentOrders: number | null;
  isActive: boolean;
  booked: number;
  customerNote: string | null;
  driverNote: string | null;
  generated: boolean;
}

/** The single recurring self-delivery rule (settings.slotRule). */
export interface SlotRule {
  active: boolean;
  repeat: 'weekdays' | 'interval';
  weekdays: number[]; // 0=Sun..6=Sat
  intervalDays: number;
  anchorDate: string; // YYYY-MM-DD
  timeFrom: string; // HH:MM
  timeTo: string; // HH:MM
  maxOrders: number;
  customerNote?: string;
  driverNote?: string;
  horizonDays: number;
  skipDates: string[];
  lastMaterializedDate?: string;
}

export interface OrderItem {
  id: string;
  productId: string | null;
  productName: string | null;
  quantity: number;
  priceStotinki: number;
}

/** A slot with its live booked count, as returned in the dashboard summary. */
export interface DashboardSlot {
  id: string;
  timeFrom: string;
  timeTo: string;
  maxOrders: number;
  booked: number;
}

/** Today's dashboard summary (GET /dashboard?date=). */
export interface DashboardSummary {
  date: string;
  orderCount: number;
  orderDelta: number;
  revenueStotinki: number;
  pendingCount: number;
  nextSlot: DashboardSlot | null;
  slots: DashboardSlot[];
  subscriptionActive: boolean;
}

/** One delivery stop on the optimized route (GET /orders/route). */
export interface RouteStop {
  id: string;
  customer: string | null;
  phone: string | null;
  address: string | null;
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
  deliveryType: 'pickup' | 'address' | 'econt' | 'econt_address';
  deliveryAddress: string | null;
  econtOffice: string | null;
  notes: string | null;
  createdAt: string;
  slotFrom: string | null;
  slotTo: string | null;
  items: OrderItem[];
}
