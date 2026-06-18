import type {
  AdminReview,
  Article,
  AvailabilityWindow,
  DashboardSummary,
  DeliveryConfig,
  EcontCity,
  EcontOfficeLive,
  Farmer,
  FarmerAccess,
  MediaItem,
  Order,
  Paginated,
  PaymentStatus,
  Product,
  ProductOption,
  ProductionSummary,
  ReviewStatus,
  RouteResult,
  Shipment,
  Slot,
  SlotRule,
  SlotRuleInput,
  StatsSummary,
  StatsRange,
  Subcategory,
  TenantProfile,
} from './types';

/** Thrown by apiFetch on a non-2xx response, carrying the API's BG message. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Dig the human message out of the API's (double-nested) error body. */
function firstApiMessage(body: unknown, fallback: string): string {
  const outer = (body as { message?: unknown })?.message;
  const inner =
    outer && typeof outer === 'object' && !Array.isArray(outer)
      ? (outer as { message?: unknown }).message
      : outer;
  if (Array.isArray(inner)) return typeof inner[0] === 'string' ? inner[0] : fallback;
  if (typeof inner === 'string') return inner;
  return fallback;
}

async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  fallbackErr = 'Възникна грешка',
): Promise<T> {
  const res = await fetch(`/bff/${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, firstApiMessage(body, fallbackErr));
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const json = (data: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(data),
});

/** Build a `?cursor=&limit=` query string for paginated list fetches. */
const qs = (cursor?: string, limit?: number) => {
  const p = new URLSearchParams();
  if (cursor) p.set('cursor', cursor);
  if (limit) p.set('limit', String(limit));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const listProducts = (cursor?: string) =>
  apiFetch<Paginated<Product>>(`products${qs(cursor)}`);

export const listProductOptions = () => apiFetch<ProductOption[]>('products/options');

/** Product write payload: the editable product fields plus the virtual `stock`
 *  number (drives the availability window — number sets it, null clears it back to
 *  unlimited, absent leaves it untouched). `stock` is not a Product column. */
export type ProductWrite = Partial<Product> & { stock?: number | null };

export const createProduct = (data: ProductWrite) =>
  apiFetch<Product>('products', { method: 'POST', ...json(data) }, 'Неуспешно създаване');

export const updateProduct = (id: string, data: ProductWrite) =>
  apiFetch<Product>(`products/${id}`, { method: 'PATCH', ...json(data) }, 'Неуспешно записване');

export const deleteProduct = (id: string) =>
  apiFetch<{ id: string }>(`products/${id}`, { method: 'DELETE' }, 'Неуспешно изтриване');

/** Bulk-link products to a farmer and/or subcategory (`null` unlinks). */
export const assignProducts = (data: {
  productIds: string[];
  farmerId?: string | null;
  subcategoryId?: string | null;
}) =>
  apiFetch<{ updated: number }>(
    'products/assign',
    { method: 'PATCH', ...json(data) },
    'Неуспешно свързване',
  );

// ---- Async image-processing helpers ----

/**
 * Poll listMedia for a resource until every item has a non-empty url
 * (the background worker may insert a placeholder row before the R2 url is ready)
 * or ~6 s elapses.  Resolves with the final media list.
 */
export async function waitForMediaItems(
  resource: MediaResource,
  id: string,
  maxMs = 6000,
  intervalMs = 600,
): Promise<MediaItem[]> {
  const deadline = Date.now() + maxMs;
  let last: MediaItem[] = [];
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, intervalMs));
    try {
      const items = await apiFetch<MediaItem[]>(`${resource}/${id}/media`);
      last = items;
      if (items.every((m) => m.url)) return items;
    } catch {
      // swallow transient errors during polling
    }
  }
  return last;
}

/** One `{ id, position }` pair for a catalog reorder. */
export type ReorderItem = { id: string; position: number };

/** Persist a new display order for products / farmers / subcategories. */
export const reorderProducts = (items: ReorderItem[]) =>
  apiFetch<{ ok: true }>('products/reorder', { method: 'PATCH', ...json({ items }) }, 'Неуспешно подреждане');

export const reorderFarmers = (items: ReorderItem[]) =>
  apiFetch<{ ok: true }>('farmers/reorder', { method: 'PATCH', ...json({ items }) }, 'Неуспешно подреждане');

export const reorderSubcategories = (items: ReorderItem[]) =>
  apiFetch<{ ok: true }>('subcategories/reorder', { method: 'PATCH', ...json({ items }) }, 'Неуспешно подреждане');

// ---- Farmers ----
export const listFarmers = () => apiFetch<Farmer[]>('farmers');

export const createFarmer = (data: Partial<Farmer>) =>
  apiFetch<Farmer>('farmers', { method: 'POST', ...json(data) }, 'Неуспешно създаване');

export const updateFarmer = (id: string, data: Partial<Farmer>) =>
  apiFetch<Farmer>(`farmers/${id}`, { method: 'PATCH', ...json(data) }, 'Неуспешно записване');

export const deleteFarmer = (id: string) =>
  apiFetch<{ id: string }>(`farmers/${id}`, { method: 'DELETE' }, 'Неуспешно изтриване');

export const getFarmerAccess = () =>
  apiFetch<Record<string, FarmerAccess>>('farmers/access');

export const grantFarmerAccess = (id: string, email: string) =>
  apiFetch<FarmerAccess>(`farmers/${id}/access`, { method: 'POST', ...json({ email }) }, 'Неуспешна покана');

export const revokeFarmerAccess = (id: string) =>
  apiFetch<{ ok: true }>(`farmers/${id}/access`, { method: 'DELETE' }, 'Неуспешно премахване');

// ---- Subcategories ----
export const listSubcategories = () => apiFetch<Subcategory[]>('subcategories');

export const createSubcategory = (data: Partial<Subcategory>) =>
  apiFetch<Subcategory>('subcategories', { method: 'POST', ...json(data) }, 'Неуспешно създаване');

export const updateSubcategory = (id: string, data: Partial<Subcategory>) =>
  apiFetch<Subcategory>(`subcategories/${id}`, { method: 'PATCH', ...json(data) }, 'Неуспешно записване');

export const deleteSubcategory = (id: string) =>
  apiFetch<{ id: string }>(`subcategories/${id}`, { method: 'DELETE' }, 'Неуспешно изтриване');

// ---- Media galleries (products / farmers / subcategories) ----
// All three resources share the same media endpoints + shape, so one generic set
// of helpers covers them. The cover is whichever photo is at position 0.
export type MediaResource = 'products' | 'farmers' | 'subcategories';

export const listMedia = (resource: MediaResource, id: string) =>
  apiFetch<MediaItem[]>(`${resource}/${id}/media`);

/**
 * Upload one gallery photo.  When the server moves to the async queue the
 * response is `{ imageProcessing: true }` (no url yet).  In that case we
 * snapshot the current media list, then poll until a NEW item with a
 * populated url appears (or ~6 s), then return that item — so existing
 * callers that read `item.url` still get a real url.
 */
export async function addMedia(
  resource: MediaResource,
  id: string,
  file: File,
): Promise<MediaItem & { imageProcessing?: boolean }> {
  // Snapshot existing ids so we can detect the newly inserted row.
  let existingIds: Set<string>;
  try {
    const before = await apiFetch<MediaItem[]>(`${resource}/${id}/media`);
    existingIds = new Set(before.map((m) => m.id));
  } catch {
    existingIds = new Set();
  }

  const fd = new FormData();
  fd.append('image', file);
  const raw = await apiFetch<MediaItem | { imageProcessing: boolean }>(
    `${resource}/${id}/media`,
    { method: 'POST', body: fd },
    'Неуспешно качване',
  );

  // Sync path (old server behaviour): the upload returned a MediaItem directly.
  if ((raw as MediaItem).id && (raw as MediaItem).url !== undefined) {
    return raw as MediaItem;
  }

  // Async path: worker will insert the row later; poll until it appears.
  const deadline = Date.now() + 6000;
  let lastNew: MediaItem | undefined;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 600));
    try {
      const items = await apiFetch<MediaItem[]>(`${resource}/${id}/media`);
      const newWithUrl = items.find((m) => !existingIds.has(m.id) && m.url);
      if (newWithUrl) return { ...newWithUrl, imageProcessing: true };
      // Track newest row even without url yet (for fallback)
      lastNew = items.find((m) => !existingIds.has(m.id)) ?? lastNew;
    } catch {
      // swallow transient polling errors
    }
  }
  // Timeout — return whatever we found (url may be empty)
  return lastNew
    ? { ...lastNew, imageProcessing: true }
    : { id: '', url: '', position: 0, imageProcessing: true };
}

export const deleteMedia = (resource: MediaResource, id: string, mediaId: string) =>
  apiFetch<{ id: string }>(`${resource}/${id}/media/${mediaId}`, { method: 'DELETE' }, 'Неуспешно изтриване');

export const reorderMedia = (
  resource: MediaResource,
  id: string,
  items: { id: string; position: number }[],
) =>
  apiFetch<MediaItem[]>(
    `${resource}/${id}/media/reorder`,
    { method: 'PATCH', ...json({ items }) },
    'Неуспешно подреждане',
  );

// ---- Tenant toggles ----
export const getTenant = () => apiFetch<TenantProfile>('tenants/me');

export const updateTenant = (data: {
  name?: string;
  multiFarmer?: boolean;
  multiSubcat?: boolean;
  articlesEnabled?: boolean;
  reviewsEnabled?: boolean;
  deliveryEnabled?: boolean;
  productOfWeekEnabled?: boolean;
  productOfWeekMode?: 'manual' | 'auto';
  productOfWeekId?: string | null;
  productOfWeekNote?: string | null;
  productOfWeekPlacement?: 'section' | 'bar';
  farmAddress?: string;
  farmLat?: number;
  farmLng?: number;
  routing?: { endMode?: 'home' | 'last' | 'custom'; endAddress?: string | null };
}) => apiFetch<TenantProfile>('tenants/me', { method: 'PATCH', ...json(data) }, 'Неуспешна промяна');

// ---- Route stops ----
/**
 * Fix a route stop with no map pin: send `address` to re-geocode it, or
 * `lat`+`lng` for a pin dropped manually on the map. Returns the saved point.
 */
export const setStopLocation = (
  orderId: string,
  data: { address?: string; lat?: number; lng?: number },
) =>
  apiFetch<{ lat: number; lng: number; address: string | null }>(
    `orders/route/stop/${orderId}`,
    { method: 'PATCH', ...json(data) },
    'Неуспешно записване на адреса',
  );

// ---- Site editor ----
export const createEditSession = () =>
  apiFetch<{ token: string; siteUrl: string; expiresIn: number }>(
    'tenants/me/edit-session',
    { method: 'POST' },
    'Неуспешно отваряне на редактора',
  );

// ---- Site contact + website icon ----
export interface SocialLink {
  // Known network key ('fb'|'ig'|'yt'|'tt'|'viber'|'telegram'|'whatsapp'|'x'|'other').
  // '' on older rows → the storefront guesses the icon from the url.
  network: string;
  label: string;
  url: string;
}

export interface CustomField {
  label: string;
  value: string;
}

export interface SiteContactResponse {
  contact: {
    address: string | null;
    hours: string | null;
    tagline: string | null;
    phone: string | null;
    email: string | null;
    social: SocialLink[];
    custom: CustomField[];
    mapLat: string | null;
    mapLng: string | null;
  };
  favicon: { url: string } | null;
  themeColor: string | null;
}

export const getSiteContact = () => apiFetch<SiteContactResponse>('tenants/me/site-contact');

export const updateSiteContact = (data: {
  address: string;
  hours: string;
  tagline: string;
  phone: string;
  email: string;
  social: SocialLink[];
  custom: CustomField[];
  mapLat: string;
  mapLng: string;
  themeColor: string;
}) =>
  apiFetch<{ contact: SiteContactResponse['contact']; themeColor: string | null }>(
    'tenants/me/site-contact',
    { method: 'PATCH', ...json(data) },
    'Неуспешно записване',
  );

// ---- Marketing / tracking IDs (settings.marketing) ----

export interface MarketingIds {
  ga4: string | null;
  googleAds: string | null;
  googleAdsLabel: string | null;
  metaPixel: string | null;
  gtm: string | null;
  tiktok: string | null;
}

export const getSiteMarketing = () =>
  apiFetch<{ marketing: MarketingIds }>('tenants/me/site-marketing');

export const updateSiteMarketing = (data: {
  ga4: string;
  googleAds: string;
  googleAdsLabel: string;
  metaPixel: string;
  gtm: string;
  tiktok: string;
}) =>
  apiFetch<{ marketing: MarketingIds }>(
    'tenants/me/site-marketing',
    { method: 'PATCH', ...json(data) },
    'Неуспешно записване',
  );

// ---- Landing-page blocks (settings.landing) ----

export interface LandingBlock {
  show: boolean;
  count: number;
}
export interface LandingConfig {
  categories: LandingBlock;
  farmers: LandingBlock;
  latest: LandingBlock;
  reviews: { show: boolean; ids: string[] };
}

export const getLanding = () => apiFetch<{ landing: LandingConfig }>('tenants/me/landing');

export const updateLanding = (landing: LandingConfig) =>
  apiFetch<{ landing: LandingConfig }>(
    'tenants/me/landing',
    { method: 'PATCH', ...json(landing) },
    'Неуспешна промяна',
  );

// ---- Merchandising toggles (settings.merchandising) ----

export interface MerchandisingConfig {
  bestSellers: { show: boolean };
  recommendations: { show: boolean };
}

export const getMerchandising = () =>
  apiFetch<{ merchandising: MerchandisingConfig }>('tenants/me/merchandising');

export const updateMerchandising = (merchandising: MerchandisingConfig) =>
  apiFetch<{ merchandising: MerchandisingConfig }>(
    'tenants/me/merchandising',
    { method: 'PATCH', ...json(merchandising) },
    'Неуспешна промяна',
  );

export function uploadFavicon(file: File) {
  const fd = new FormData();
  fd.append('image', file);
  return apiFetch<{ url: string }>(
    'tenants/me/favicon',
    { method: 'POST', body: fd },
    'Неуспешно качване',
  );
}

export const deleteFavicon = () =>
  apiFetch<{ ok: true }>('tenants/me/favicon', { method: 'DELETE' }, 'Неуспешно изтриване');

// ---- Articles ----
export const listArticles = (cursor?: string) =>
  apiFetch<Paginated<Article>>(`articles${qs(cursor)}`);

export const getArticle = (id: string) => apiFetch<Article>(`articles/${id}`);

export const createArticle = (data: { title: string; excerpt?: string; body?: string }) =>
  apiFetch<Article>('articles', { method: 'POST', ...json(data) }, 'Неуспешно създаване');

export const updateArticle = (
  id: string,
  data: Partial<Pick<Article, 'title' | 'excerpt' | 'body' | 'status' | 'slug'>>,
) => apiFetch<Article>(`articles/${id}`, { method: 'PATCH', ...json(data) }, 'Неуспешно записване');

export const deleteArticle = (id: string) =>
  apiFetch<{ id: string }>(`articles/${id}`, { method: 'DELETE' }, 'Неуспешно изтриване');

export function uploadArticleCover(id: string, file: File) {
  const fd = new FormData();
  fd.append('file', file);
  return apiFetch<Article>(`articles/${id}/cover`, { method: 'POST', body: fd }, 'Неуспешно качване');
}

export function uploadArticleInlineImage(id: string, file: File) {
  const fd = new FormData();
  fd.append('file', file);
  return apiFetch<{ url: string }>(`articles/${id}/images`, { method: 'POST', body: fd }, 'Неуспешно качване');
}

// ---- Slots ----
export const listSlots = (from: string, to: string) =>
  apiFetch<Slot[]>(`slots?from=${from}&to=${to}`);

export const createSlot = (data: {
  date: string;
  timeFrom: string;
  timeTo: string;
  customerNote?: string;
  driverNote?: string;
}) => apiFetch<Slot>('slots', { method: 'POST', ...json(data) }, 'Неуспешно създаване на слот');

export const updateSlot = (
  id: string,
  data: { timeFrom?: string; timeTo?: string; customerNote?: string; driverNote?: string },
) => apiFetch<Slot>(`slots/${id}`, { method: 'PATCH', ...json(data) }, 'Неуспешна промяна на слот');

export const deleteSlot = (id: string) =>
  apiFetch<{ id: string }>(`slots/${id}`, { method: 'DELETE' }, 'Неуспешно изтриване');

export const getSlotRule = () => apiFetch<SlotRule | null>('slots/rule');

export const saveSlotRule = (rule: SlotRuleInput) =>
  apiFetch<SlotRule>('slots/rule', { method: 'PUT', ...json(rule) }, 'Неуспешно записване на правилото');

/** Close a calendar day: deletes its unbooked slots + the rule skips the date. */
export const closeSlotDay = (date: string) =>
  apiFetch<{ date: string; removed: number; kept: number }>(
    'slots/close-day',
    { method: 'POST', ...json({ date }) },
    'Неуспешно затваряне на деня',
  );

/** Reopen a closed day: un-skips the date and the rule refills it immediately. */
export const openSlotDay = (date: string) =>
  apiFetch<{ date: string; created: number }>(
    'slots/open-day',
    { method: 'POST', ...json({ date }) },
    'Неуспешно отваряне на деня',
  );

// ---- Orders ----
export const listOrders = (cursor?: string) =>
  apiFetch<Paginated<Order>>(`orders${qs(cursor)}`);

export const updateOrderStatus = (id: string, status: string) =>
  apiFetch<Order>(`orders/${id}/status`, { method: 'PATCH', ...json({ status }) }, 'Неуспешна промяна на статуса');

export const confirmPendingOrders = (date?: string) =>
  apiFetch<{ confirmed: number }>(
    `orders/confirm-pending${date ? `?date=${date}` : ''}`,
    { method: 'PATCH' },
    'Неуспешно потвърждаване',
  );

export const getProduction = (date?: string) =>
  apiFetch<ProductionSummary>(`orders/production${date ? `?date=${date}` : ''}`);

export const getRoute = (date?: string) =>
  apiFetch<RouteResult>(`orders/route${date ? `?date=${date}` : ''}`);

export const getDashboard = (date?: string) =>
  apiFetch<DashboardSummary>(`dashboard${date ? `?date=${date}` : ''}`);

// ---- Sales statistics ----
export const getStats = (
  opts: ({ range: StatsRange } | { from: string; to: string }) & { farmerId?: string },
) => {
  const base =
    'from' in opts
      ? `from=${encodeURIComponent(opts.from)}&to=${encodeURIComponent(opts.to)}`
      : `range=${opts.range}`;
  const fid = opts.farmerId ? `&farmerId=${encodeURIComponent(opts.farmerId)}` : '';
  return apiFetch<StatsSummary>(`stats?${base}${fid}`);
};

// ---- Stripe (payments / Connect) ----
export interface StripeSummary {
  /** Stripe is configured on the server (secret key present). */
  enabled: boolean;
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** Stripe balance, minor units (EUR cents). */
  availableStotinki: number;
  pendingStotinki: number;
  nextPayout: { amountStotinki: number; arrivalDate: string } | null;
  /** Most recent payments on the connected account (native dashboard table). */
  recentPayments: {
    amountStotinki: number;
    currency: string;
    status: string;
    created: string;
    description: string | null;
  }[];
  /** Platform commission in basis points (100 = 1%). */
  feeBps: number;
}

export const getStripeSummary = () => apiFetch<StripeSummary>('stripe/connect/summary');

// ---- Payments (Плащания screen) — order-derived, both COD + card channels ----
export type PaymentChannel = 'cod' | 'online';
/** One order on the payments screen, with contact details for searching. */
export interface PaymentOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  totalStotinki: number;
  status: string;
  deliveryType: string;
  paymentMethod: PaymentChannel;
  /** paid (card captured) / pending_online (card unpaid) / cash (COD). */
  paymentStatus: PaymentStatus;
  /** True once the money is in hand — COD delivered, or card paid. */
  collected: boolean;
  /** BG calendar day of delivery, "YYYY-MM-DD". */
  day: string;
  createdAt: string | null;
  paidAt: string | null;
  slotFrom: string | null;
  slotTo: string | null;
}
export type PaymentMethodFilter = 'all' | 'cod';

/** Tenant-wide totals (every counted order), independent of search/page. */
export interface PaymentTotals {
  /** COD due + card received (minor units, EUR cents). */
  totalStotinki: number;
  count: number;
  /** Total counted orders across both channels — the «Всичко» tab badge. */
  allCount: number;
  codTotalStotinki: number;
  codCount: number;
  cardTotalStotinki: number;
  cardCount: number;
}

/** A page of the payments list: totals (first page only) + rows + cursor. */
export interface PaymentsPage {
  /** Present on the first page (no cursor); null on «load more» fetches. */
  totals: PaymentTotals | null;
  orders: PaymentOrder[];
  nextCursor: string | null;
}

export const getPayments = (opts?: {
  method?: PaymentMethodFilter;
  q?: string;
  cursor?: string;
  limit?: number;
  /** Owner-only: scope to one producer's line items (mirrors /stats?farmerId). */
  farmerId?: string;
}) => {
  const p = new URLSearchParams();
  if (opts?.method && opts.method !== 'all') p.set('method', opts.method);
  if (opts?.q) p.set('q', opts.q);
  if (opts?.cursor) p.set('cursor', opts.cursor);
  if (opts?.limit) p.set('limit', String(opts.limit));
  if (opts?.farmerId) p.set('farmerId', opts.farmerId);
  const query = p.toString();
  return apiFetch<PaymentsPage>(`orders/payments${query ? `?${query}` : ''}`);
};

/**
 * Create (if needed) the farm's Standard connected account and get a hosted
 * Stripe onboarding URL — the caller redirects the browser to it.
 */
export const startStripeOnboarding = () =>
  apiFetch<{ url: string }>(
    'stripe/connect/onboard',
    { method: 'POST' },
    'Неуспешна връзка със Stripe',
  );

// ---- SaaS billing (the platform's subscription charged to the farm) ----
export interface BillingSummary {
  /** STRIPE_SECRET_KEY + billing price id both present on the server. */
  enabled: boolean;
  plan: 'standard' | 'premium';
  status: 'active' | 'past_due' | 'inactive';
  graceUntil: string | null;
  hasCard: boolean;
  cardBrand: string | null;
  cardLast4: string | null;
  basePriceStotinki: number;
  emailPricePerRecipientMicro: number;
  pushesThisCycle: number;
  estimatedNextStotinki: number;
  invoices: { amountStotinki: number; status: string; date: string; url: string | null }[];
}

export const getBillingSummary = () => apiFetch<BillingSummary>('billing/summary');

/** Start the hosted Checkout (subscription mode) — caller redirects to the URL. */
export const startBillingCheckout = () =>
  apiFetch<{ url: string | null }>(
    'billing/checkout',
    { method: 'POST' },
    'Неуспешно стартиране на плащане',
  );

/** Open the Stripe Billing Portal — caller redirects to the URL. */
export const openBillingPortal = () =>
  apiFetch<{ url: string }>(
    'billing/portal',
    { method: 'POST' },
    'Неуспешно отваряне на портала',
  );

// ---- Tenant ----
export const setDeliveryEnabled = (enabled: boolean) =>
  apiFetch<{ deliveryEnabled: boolean }>(
    'tenants/me',
    { method: 'PATCH', ...json({ deliveryEnabled: enabled }) },
    'Неуспешна промяна',
  );

/** Persist the master toggle + the full delivery config (settings.delivery). */
export const saveDelivery = (data: { deliveryEnabled: boolean; delivery: DeliveryConfig }) =>
  apiFetch<TenantProfile>(
    'tenants/me',
    { method: 'PATCH', ...json(data) },
    'Неуспешно записване на настройките',
  );

// ---- Econt (courier) ----
export interface EcontConfigView {
  env?: 'demo' | 'prod';
  username?: string;
  configured: boolean;
  sender?: Record<string, unknown>;
  nomenclature?: { lastSyncedAt?: string; cities?: number; offices?: number };
}

/** Raw shipment row (returned by create/refresh). */
export interface ShipmentRecord {
  id: string;
  orderId: string;
  econtShipmentNumber: string | null;
  status: string;
  labelPdfUrl: string | null;
  courierPriceStotinki: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const getEcontConfig = () => apiFetch<EcontConfigView>('econt/config');

export const saveEcontCredentials = (data: { env?: 'demo' | 'prod'; username: string; password: string }) =>
  apiFetch<{ configured: true; env: 'demo' | 'prod' }>(
    'econt/credentials',
    { method: 'POST', ...json(data) },
    'Неуспешна връзка с Еконт — провери данните',
  );

export const syncEcontNomenclature = () =>
  apiFetch<{ cities: number; offices: number }>(
    'econt/nomenclature/sync',
    { method: 'POST' },
    'Неуспешно обновяване на номенклатурата',
  );

/** Live Econt city autocomplete (requires a connected Econt account). */
export const listEcontCities = (q?: string) =>
  apiFetch<EcontCity[]>(`econt/cities${q ? `?q=${encodeURIComponent(q)}` : ''}`);

/** Live Econt offices for one city — sender picker + office map. */
export const listEcontOffices = (cityId: number) =>
  apiFetch<EcontOfficeLive[]>(`econt/offices?cityId=${cityId}`);

export const listShipments = () => apiFetch<Shipment[]>('econt/shipments');

export const createShipment = (orderId: string) =>
  apiFetch<ShipmentRecord>(`econt/shipments/${orderId}`, { method: 'POST' }, 'Неуспешно създаване на товарителница');

export const refreshShipment = (id: string) =>
  apiFetch<ShipmentRecord>(`econt/shipments/${id}/refresh`, { method: 'POST' }, 'Неуспешно обновяване на статуса');

export const voidShipment = (id: string) =>
  apiFetch<{ id: string }>(`econt/shipments/${id}`, { method: 'DELETE' }, 'Неуспешно анулиране');

// ---- Newsletters ----
export interface Subscriber {
  id: string;
  email: string;
  createdAt: string | null;
}

export const listSubscribers = (cursor?: string) =>
  apiFetch<Paginated<Subscriber> & { activeCount: number; unsubscribedCount: number }>(
    `subscribers${qs(cursor)}`,
  );

// ─── Newsletter block-builder campaigns ─────────────────────────────────────
// Local mirror of @farmflow/types NewsletterBlock (client doesn't consume the
// types package). Keep in sync with packages/types/src/index.ts.
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

export const listCampaigns = (cursor?: string) =>
  apiFetch<Paginated<NewsletterCampaign>>(`newsletter/campaigns${qs(cursor)}`);

export const getCampaign = (id: string) =>
  apiFetch<NewsletterCampaign>(`newsletter/campaigns/${id}`);

export const createCampaign = (data: { subject: string; blocks: NewsletterBlock[] }) =>
  apiFetch<NewsletterCampaign>('newsletter/campaigns', { method: 'POST', ...json(data) }, 'Неуспешно създаване');

export const updateCampaign = (id: string, data: { subject: string; blocks: NewsletterBlock[] }) =>
  apiFetch<NewsletterCampaign>(`newsletter/campaigns/${id}`, { method: 'PATCH', ...json(data) }, 'Неуспешно записване');

export const deleteCampaign = (id: string) =>
  apiFetch<{ success: boolean }>(`newsletter/campaigns/${id}`, { method: 'DELETE' }, 'Неуспешно изтриване');

export const previewCampaign = (id: string) =>
  apiFetch<{ html: string }>(`newsletter/campaigns/${id}/preview`, { method: 'POST' });

export const sendCampaign = (id: string) =>
  apiFetch<{ sent: number; recipients: number }>(
    `newsletter/campaigns/${id}/send`,
    { method: 'POST' },
    'Неуспешно изпращане',
  );

export const getNewsletterQuote = () => apiFetch<NewsletterQuote>('newsletter/quote');

export function uploadCampaignInlineImage(id: string, file: File) {
  const fd = new FormData();
  fd.append('file', file);
  return apiFetch<{ url: string }>(
    `newsletter/campaigns/${id}/images`,
    { method: 'POST', body: fd },
    'Неуспешно качване',
  );
}

// ─── Account / side-nav preferences ────────────────────────────────────────────

export interface AccountMe {
  email: string;
  role: string;
  mustChangePassword: boolean;
  /** Keys the user hid from the side nav — item hrefs + "group:<title>". */
  hiddenNav: string[];
}

export const getMe = () => apiFetch<AccountMe>('auth/me');

export const updateHiddenNav = (hidden: string[]) =>
  apiFetch<{ hiddenNav: string[] }>(
    'auth/me/nav',
    { method: 'PATCH', ...json({ hidden }) },
    'Неуспешно запазване',
  );

// ─── Reviews ────────────────────────────────────────────────────────────────────

export const listReviews = (status?: ReviewStatus, cursor?: string) => {
  const p = new URLSearchParams();
  if (status) p.set('status', status);
  if (cursor) p.set('cursor', cursor);
  const q = p.toString();
  return apiFetch<Paginated<AdminReview>>(`reviews${q ? `?${q}` : ''}`);
};

export const setReviewStatus = (id: string, status: ReviewStatus) =>
  apiFetch<AdminReview>(`reviews/${id}/status`, { method: 'PATCH', ...json({ status }) }, 'Неуспешна промяна');

// ─── Availability windows ────────────────────────────────────────────────────

export const listAvailabilityWindows = (productId?: string): Promise<AvailabilityWindow[]> => {
  const q = productId ? `?productId=${encodeURIComponent(productId)}` : '';
  return apiFetch<AvailabilityWindow[]>(`availability-windows${q}`);
};

export const createAvailabilityWindow = (body: {
  productId: string;
  quantity: number;
}): Promise<AvailabilityWindow> =>
  apiFetch<AvailabilityWindow>(
    'availability-windows',
    { method: 'POST', ...json(body) },
    'Неуспешно създаване',
  );

export const createBulkAvailabilityWindows = (body: {
  items: { productId: string; quantity: number }[];
}): Promise<{
  created: AvailabilityWindow[];
  skipped: { productId: string; reason: 'not-found' | 'overlap' }[];
}> =>
  apiFetch(
    'availability-windows/bulk',
    { method: 'POST', ...json(body) },
    'Неуспешно записване',
  );

export const updateAvailabilityWindow = (
  id: string,
  body: Partial<{ quantity: number }>,
): Promise<AvailabilityWindow> =>
  apiFetch<AvailabilityWindow>(
    `availability-windows/${id}`,
    { method: 'PATCH', ...json(body) },
    'Неуспешно записване',
  );

export const deleteAvailabilityWindow = (id: string): Promise<{ id: string }> =>
  apiFetch<{ id: string }>(
    `availability-windows/${id}`,
    { method: 'DELETE' },
    'Неуспешно изтриване',
  );
