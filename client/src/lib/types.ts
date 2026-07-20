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
  /** true = farmer-submitted, awaiting admin review; hidden from the storefront. */
  needsReview: boolean;
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
  /** Companion rule: true = can't be ordered alone; the cart must also hold ≥1
   *  other distinct product. See `companionMinPriceStotinki` for the optional
   *  value gate. Enforced server-side (OrdersService) for every delivery method. */
  requiresCompanion: boolean;
  /** Optional EUR-cents threshold for the companion rule (same unit as
   *  priceStotinki): the required other product must cost ≥ this. null = any
   *  other product qualifies. */
  companionMinPriceStotinki: number | null;
  createdAt: string;
}

/** A member product of a bundle ( category='bundle' product), as returned by
 *  GET/PUT /products/:id/bundle-items. */
export interface BundleMember {
  productId: string;
  name: string;
  slug: string;
  image: string | null;
  quantity: number;
  position: number;
  priceStotinki: number;
  isActive: boolean;
  courierDisabled: boolean;
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

/** Tier-2 „Бранд идентичност" control layer. Mirrors @fermeribg/types Tier2Branding.
 *  Operator-unlocked, paid. `enabled` gates the branded marketplace subpage; primary
 *  color reuses `Farmer.tint`, portrait reuses `imageUrl`, gallery reuses farmer media. */
export interface Tier2Branding {
  enabled: boolean;
  plan?: 'tier2';
  accent?: string;
  headingFont?: string;
  gallery?: 'wide' | 'mosaic' | 'row' | 'grid';
  badges?: string[];
  unlockedAt?: string;
  unlockedBy?: string;
}

/** Legal seller identity (farmer-as-seller marketplace) — КЗП/НАП disclosure. Mirrors
 *  @fermeribg/types FarmerLegal. PUBLIC (shown on the storefront so the buyer knows who
 *  they contract with). `kind`: individual → регистрационен № (Наредба 3), sole_trader
 *  (ЕТ) / company → ЕИК. */
export interface FarmerLegal {
  kind?: 'individual' | 'sole_trader' | 'company';
  name?: string;
  eik?: string;
  vatNumber?: string;
  address?: string;
  regNo?: string;
  confirmedAt?: string;
}

export interface Farmer {
  id: string;
  name: string;
  role: string | null;
  bio: string | null;
  phone: string | null;
  email: string | null;
  since: string | null;
  /** Home settlement of the farm (free text, e.g. "Варна"). NULL = not set. */
  city: string | null;
  tint: string | null;
  imageUrl: string | null;
  coverCrop: CoverCrop | null;
  /** Tier-2 „Бранд идентичност" control layer. NULL / enabled:false = default card. */
  branding: Tier2Branding | null;
  /** Legal seller identity (КЗП/НАП disclosure). NULL = not yet provided. */
  legal?: FarmerLegal | null;
  position: number;
  createdAt: string;
  /** Commission override in basis points (500 = 5%). NULL = inherits the tenant default. */
  commissionRateBps?: number | null;
  /** Monthly subscription fee override in stotinki/eurocents. NULL = inherits the tenant default. */
  subscriptionFeeStotinki?: number | null;
  /** „За фермата" — long public story shown on the storefront farmer subpage. */
  story?: string | null;
  /** Operator-only private notes about this producer — never public. */
  internalNotes?: string | null;
  /** Operator-only payout account for marketplace settlement — never public. */
  payout?: { iban?: string; holder?: string; bic?: string } | null;
}

export interface FarmerAccess {
  hasLogin: true;
  loginEmail: string;
  invitePending: boolean;
}

/** One entry in the read-only tenant courier roster (`GET
 *  orders/route/couriers`) — drivers with an account plus the caller's own
 *  account, flagged via `isSelf`. Account creation itself happens in the
 *  super-admin console, not here. */
export interface RouteCourier {
  accountId: string;
  email: string;
  isSelf: boolean;
}

/** One row of the per-day leg board (`GET/PUT orders/route/assignments`) —
 *  "this account drives leg N on this date." Whole-day replace semantics on
 *  write; see `client/src/components/route/courier-assignment-board.tsx`. */
export interface RouteAssignment {
  accountId: string;
  legIndex: number;
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
 *  The cover is whichever photo sits at position 0. The `autoFixed`/`sanity*`
 *  fields are only ever set on product photos (the image-sanity worker is
 *  product-scoped today) — always undefined for farmer/subcategory items. */
export interface MediaItem {
  id: string;
  url: string;
  position: number;
  /** Pre-fix upload — present only when the worker replaced `url`. */
  originalUrl?: string | null;
  autoFixed?: boolean;
  sanityVerdict?: 'ok' | 'unusable' | null;
  sanityReason?: string | null;
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
  /** Day-of SMS reminder config (settings.sms). Always present — defaults to
   *  { dayOfReminder: false, channel: 'email', sendHour: 8 } server-side even
   *  when settings.sms is unset. `sendHour` is the Europe/Sofia hour (0–23) the
   *  morning reminder goes out. */
  sms: { dayOfReminder: boolean; sendHour: number };
}

export type RouteEndMode = 'home' | 'last' | 'custom';

/**
 * A REAL courier/leg number — what a route's `courierIndex` and every index into
 * `settings.routing.couriers[]` mean. Declared here because the client mirrors
 * shared types rather than depending on @fermeribg/types.
 *
 * A day's legs can be NON-CONTIGUOUS: the assignment board lets each roster row
 * pick any leg, so legs [0, 2] (nobody on leg 1) is a normal shape, while
 * `routes[]` stays DENSE. A leg's POSITION in that array is therefore not its leg
 * number. Conflating them has been fixed three times server-side and twice in the
 * courier modals; the brand makes the mix-up a type error.
 */
export type LegIndex = number & { readonly __brand: 'LegIndex' };

/** A position in the DENSE `routes[]` array. Never index couriers[] with this. */
export type LegPos = number & { readonly __brand: 'LegPos' };

/** Assert a number is a real leg number (e.g. a route's `courierIndex`). */
export const asLegIndex = (n: number): LegIndex => n as LegIndex;

export interface RoutingConfig {
  endMode?: RouteEndMode;
  endAddress?: string | null;
  endLat?: string | null;
  endLng?: string | null;
  /** Default number of couriers to split the route between (1-10). */
  courierCount?: number;
  /** Per-courier config (task #7 home „У дома" + name/end). Index-aligned. */
  couriers?: {
    name?: string | null;
    endMode?: RouteEndMode;
    homeAddress?: string | null;
    homeLat?: string | null;
    homeLng?: string | null;
    /** Per-courier START override — where this courier's leg begins (else base). */
    startAddress?: string | null;
    startLat?: string | null;
    startLng?: string | null;
  }[];
  /** Delivery day-plan tuning (task #13 window generation). */
  dayStartHour?: number;
  slotSizeMin?: number;
  serviceMin?: number;
  /** Weekly order-intake cutoff (task #13): weekday 0=Sun..6=Sat, hour 0-23 (Europe/Sofia). */
  cutoff?: { weekday: number; hour: number };
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

/** Delivery slot with its live `booked` count (GET /slots). A day-row: `timeFrom`/
 *  `timeTo` are null (post migration 0081 — slots are days, not time windows).
 *  Free while `booked` is below `capacity`. */
export interface Slot {
  id: string;
  date: string; // YYYY-MM-DD
  timeFrom: string | null; // HH:MM:SS — legacy pre-0081 rows only, else null
  timeTo: string | null; // HH:MM:SS — legacy pre-0081 rows only, else null
  isActive: boolean;
  booked: number;
  capacity: number;
  customerNote: string | null;
  driverNote: string | null;
  generated: boolean;
  reminderOptOut: boolean;
}

/** One delivery window (hours only). Legacy shape — kept only because
 *  `WindowFields` (recurrence-card.tsx) is reused by the pickup method's fixed
 *  schedule picker in methods-section.tsx, which still deals in hours. The slot
 *  rule itself no longer uses this. */
export interface SlotWindow {
  timeFrom: string; // HH:MM
  timeTo: string; // HH:MM
}

/** A weekday (0=Sun..6=Sat) with how many orders it can take. */
export interface SlotDay {
  dow: number;
  capacity: number;
}

/** The single recurring self-delivery rule (settings.slotRule). Day-based:
 *  the customer picks a day, not an hour — capacity caps how many orders that
 *  day takes. */
export interface SlotRule {
  active: boolean;
  repeat: 'weekdays' | 'interval';
  days: SlotDay[]; // weekdays mode — one capacity per picked weekday
  intervalDays: number;
  intervalCapacity: number; // interval mode — single capacity
  anchorDate: string; // YYYY-MM-DD
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
  /** Snapshotted at purchase time (e.g. "500г", "1кг") — the variant/weight
   *  actually ordered, distinct from `productName`. Null for products sold
   *  without variants. */
  variantLabel: string | null;
  quantity: number;
  priceStotinki: number;
}

/** A slot with its live booked count, as returned in the dashboard summary.
 *  Day-row: `timeFrom`/`timeTo` are null (see `Slot`). */
export interface DashboardSlot {
  id: string;
  timeFrom: string | null;
  timeTo: string | null;
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

// ── Turnover breakdown (GET /stats/turnover) — Task #9/#10. Explicit switchable
//    basis + lifetime to-date + platform income + undelivered split. Separate
//    from StatsSummary above (which stays basis-implicit = order-placed day). ──
export type TurnoverBasis = 'placed' | 'delivery' | 'delivered';

export interface TurnoverPoint {
  t: string;
  revenueStotinki: number;
  orderCount: number;
}

export interface TurnoverBreakdown {
  basis: TurnoverBasis;
  range: StatsRangeTag;
  bucket: StatsBucket;
  from: string;
  to: string;
  includeUndelivered: boolean;
  turnoverStotinki: number;
  orderCount: number;
  turnoverToDateStotinki: number;
  commissionEnabled: boolean;
  commissionRateBps: number;
  platformIncomeStotinki: number;
  platformIncomeToDateStotinki: number;
  undeliveredRevenueStotinki: number;
  undeliveredOrderCount: number;
  points: TurnoverPoint[];
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
  /** Order money (stotinki): goods subtotal, delivery fee, grand total with delivery. */
  itemsSubtotalStotinki: number;
  deliveryFeeStotinki: number;
  totalStotinki: number;
  /** Operator's manual courier pin (0-based), or null for auto geographic split. */
  courierIndex: number | null;
  /** Delivery time window (HH:MM, Europe/Sofia) + review status (draft|approved|sent), null until generated. */
  deliveryWindowStart: string | null;
  deliveryWindowEnd: string | null;
  deliveryWindowStatus: string | null;
}

/** Delivery route for a date (GET /orders/route?date=). */
export interface RouteEnd {
  mode: RouteEndMode;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

/** One courier's leg of the day's route. */
export interface CourierRoute {
  stops: RouteStop[];
  totalDistanceM: number | null;
  totalDurationS: number | null;
  optimized: boolean;
  /** Encoded road-geometry legs for the final visit order; the map decodes +
   *  draws them so the route line follows streets. null → straight-segment
   *  fallback between pins. */
  polyline: string[] | null;
  /** This courier's own end mode (home = back to base, last = end at last stop). */
  endMode: RouteEndMode;
  /** Where THIS courier's leg ends (task #7 „У дома"): resolved end coords, or null for a one-way leg. */
  endAddress: string | null;
  endLat: number | null;
  endLng: number | null;
  /** Where THIS courier's leg STARTS: the per-courier start override, or the
   *  farm origin when unset. Drives the drawn line + deep-link nav origin. */
  startAddress: string | null;
  startLat: number | null;
  startLng: number | null;
  /** 0-based index of this courier (== position in routes). */
  courierIndex: number;
  /** Operator-set courier name, else null. */
  name: string | null;
  /** This courier's day money (stotinki), summed from its stops. */
  itemsSubtotalStotinki: number;
  deliveryFeeStotinki: number;
  totalStotinki: number;
}

/** The day's route, split across 1+ couriers (GET /orders/route?date=&couriers=). */
export interface MultiRouteResult {
  date: string; // YYYY-MM-DD
  origin: { address: string | null; lat: number | null; lng: number | null };
  /** Where the van(s) go after the last delivery — shared across all couriers. */
  end: RouteEnd;
  /** Effective courier count — equals `routes.length`. */
  couriers: number;
  routes: CourierRoute[];
}

/** One order's generated/edited delivery window (task #13 proposal). */
export interface DeliveryWindowStop {
  id: string;
  customer: string | null;
  email: string | null;
  windowStart: string; // 'HH:MM'
  windowEnd: string;    // 'HH:MM'
  hasEmail: boolean;
  /** Straight-line metres from the previous stop (courier start for the first). */
  distanceFromPrevM: number;
  /** Estimated drive seconds from the previous stop. */
  durationFromPrevS: number;
}
/** POST /orders/route/windows/generate response — proposed windows per courier. */
export interface DeliveryWindowProposal {
  date: string;
  slotMin: number;
  couriers: { courierIndex: number; name: string | null; stops: DeliveryWindowStop[] }[];
  /** Orders that got a window but have no email (can't be notified). */
  withoutEmail: number;
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
  orderCount: number;
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
  status: 'pending' | 'confirmed' | 'preparing' | 'out_for_delivery' | 'delivered' | 'cancelled';
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

/** A movable own-delivery order for the "Премести на друг ден" tool. */
export interface ReschedulableOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  totalStotinki: number;
  status: string;
  /** YYYY-MM-DD delivery day (its slot's date). */
  slotDate: string;
}

/** A crop/product line to harvest for a proposed delivery day. */
export interface HarvestLine {
  productName: string;
  quantity: number;
}

/** One order as placed into a proposed delivery day by the suggester. */
export interface SuggestedDayOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  lat: number | null;
  lng: number | null;
  totalStotinki: number;
}

/** One courier's leg within a proposed delivery day. */
export interface RouteEstimate {
  stops: SuggestedDayOrder[];
  km: number;
  driveMinutes: number;
}

/** One proposed delivery day from POST /orders/suggest-days. */
export interface SuggestedDay {
  date: string;
  couriers: number;
  routes: RouteEstimate[];
  driveMinutesMakespan: number;
  totalKm: number;
  harvest: HarvestLine[];
  reason: string;
}

/** An order the suggester couldn't place geographically (no coords). */
export interface UnplacedOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  totalStotinki: number;
}

/** Response shape of POST /orders/suggest-days. */
export interface DaySuggestionResult {
  days: SuggestedDay[];
  unplaced: UnplacedOrder[];
}

/** One party (seller or buyer) on a handover protocol. Same shape as `FarmerLegal`
 *  plus `phone` — the protocol snapshots identity at signing time, independent of
 *  the farmer/tenant record it was drawn from. */
export interface LegalIdentity {
  kind?: 'individual' | 'sole_trader' | 'company';
  name?: string;
  eik?: string;
  vatNumber?: string;
  address?: string;
  regNo?: string;
  phone?: string;
  confirmedAt?: string;
}

/** One line item on a handover protocol. */
export interface ProtocolItem {
  productName: string;
  variantLabel?: string;
  quantity: number;
  unit?: string;
  priceStotinki: number;
  orderNumber?: number;
}

/** Draft preview for a not-yet-created handover protocol (GET /handover/draft). */
export interface ProtocolDraft {
  kind: string;
  from: LegalIdentity;
  to: LegalIdentity;
  items: ProtocolItem[];
  total: number;
}

/** A saved handover protocol row (GET /handover). */
export interface ProtocolRow {
  id: string;
  kind: string;
  farmerId: string | null;
  orderId: string | null;
  slotId: string | null;
  protocolNumber: number | null;
  status: string;
  signMode: string;
  totalStotinki: number;
  createdAt: string;
  fromSnapshot: LegalIdentity;
  toSnapshot: LegalIdentity;
}

/** A row in the day's LIVE protocol view (GET /handover/day). A virtual target
 *  that hasn't been created yet has `id: null` / `protocolNumber: null`. */
export interface DayProtocolRow {
  id: string | null;
  kind: string;
  farmerId: string | null;
  orderId: string | null;
  slotId: string | null;
  protocolNumber: number | null;
  status: string;
  signMode: string;
  totalStotinki: number;
  createdAt: string | null;
  fromSnapshot: LegalIdentity;
  toSnapshot: LegalIdentity;
}
