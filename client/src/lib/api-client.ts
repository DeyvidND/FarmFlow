import type {
  AdminReview,
  Article,
  ArticleMedia,
  DashboardSummary,
  DeliveryConfig,
  EcontCity,
  EcontOfficeLive,
  Farmer,
  MediaItem,
  Order,
  Paginated,
  Product,
  ProductOption,
  ProductionSummary,
  ReviewStatus,
  RouteResult,
  Shipment,
  Slot,
  SlotRule,
  SlotRuleInput,
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

export const createProduct = (data: Partial<Product>) =>
  apiFetch<Product>('products', { method: 'POST', ...json(data) }, 'Неуспешно създаване');

export const updateProduct = (id: string, data: Partial<Product>) =>
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

export function uploadProductImage(id: string, file: File) {
  const fd = new FormData();
  fd.append('image', file);
  return apiFetch<Product>(`products/${id}/image`, { method: 'POST', body: fd }, 'Неуспешно качване');
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

export function uploadFarmerImage(id: string, file: File) {
  const fd = new FormData();
  fd.append('image', file);
  return apiFetch<Farmer>(`farmers/${id}/image`, { method: 'POST', body: fd }, 'Неуспешно качване');
}

// ---- Subcategories ----
export const listSubcategories = () => apiFetch<Subcategory[]>('subcategories');

export const createSubcategory = (data: Partial<Subcategory>) =>
  apiFetch<Subcategory>('subcategories', { method: 'POST', ...json(data) }, 'Неуспешно създаване');

export const updateSubcategory = (id: string, data: Partial<Subcategory>) =>
  apiFetch<Subcategory>(`subcategories/${id}`, { method: 'PATCH', ...json(data) }, 'Неуспешно записване');

export const deleteSubcategory = (id: string) =>
  apiFetch<{ id: string }>(`subcategories/${id}`, { method: 'DELETE' }, 'Неуспешно изтриване');

export function uploadSubcategoryImage(id: string, file: File) {
  const fd = new FormData();
  fd.append('image', file);
  return apiFetch<Subcategory>(`subcategories/${id}/image`, { method: 'POST', body: fd }, 'Неуспешно качване');
}

// ---- Media galleries (products / farmers / subcategories) ----
// All three resources share the same media endpoints + shape, so one generic set
// of helpers covers them. The cover is whichever photo is at position 0.
export type MediaResource = 'products' | 'farmers' | 'subcategories';

export const listMedia = (resource: MediaResource, id: string) =>
  apiFetch<MediaItem[]>(`${resource}/${id}/media`);

export function addMedia(resource: MediaResource, id: string, file: File) {
  const fd = new FormData();
  fd.append('image', file);
  return apiFetch<MediaItem>(`${resource}/${id}/media`, { method: 'POST', body: fd }, 'Неуспешно качване');
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

// ---- Site media (editable storefront photos) ----
/** One editable decorative slot on the storefront (catalog entry). */
export interface SiteMediaSlotDef {
  key: string;
  label: string;
  ratio: string;
  page: string;
  note?: string;
  rounded?: boolean;
}

export interface SiteMediaResponse {
  catalog: SiteMediaSlotDef[];
  values: Record<string, { url: string }>;
}

export const getSiteMedia = () => apiFetch<SiteMediaResponse>('tenants/me/media');

export function uploadSiteMedia(slotKey: string, file: File) {
  const fd = new FormData();
  fd.append('image', file);
  return apiFetch<{ slotKey: string; url: string }>(
    `tenants/me/media/${encodeURIComponent(slotKey)}`,
    { method: 'POST', body: fd },
    'Неуспешно качване',
  );
}

export const deleteSiteMedia = (slotKey: string) =>
  apiFetch<{ ok: true }>(
    `tenants/me/media/${encodeURIComponent(slotKey)}`,
    { method: 'DELETE' },
    'Неуспешно изтриване',
  );

// ---- Site contact + website icon ----
export interface SocialLink {
  label: string;
  url: string;
}

export interface SiteContactResponse {
  contact: {
    address: string | null;
    hours: string | null;
    tagline: string | null;
    email: string | null;
    social: SocialLink[];
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
  email: string;
  social: SocialLink[];
  mapLat: string;
  mapLng: string;
  themeColor: string;
}) =>
  apiFetch<{ contact: SiteContactResponse['contact']; themeColor: string | null }>(
    'tenants/me/site-contact',
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

export function uploadArticleMedia(id: string, file: File) {
  const fd = new FormData();
  fd.append('file', file);
  return apiFetch<ArticleMedia>(`articles/${id}/media`, { method: 'POST', body: fd }, 'Неуспешно качване');
}

export const addArticleEmbed = (id: string, url: string, caption?: string) =>
  apiFetch<ArticleMedia>(
    `articles/${id}/media/embed`,
    { method: 'POST', ...json({ url, caption }) },
    'Невалиден YouTube или Instagram адрес',
  );

export const updateArticleMedia = (id: string, mediaId: string, caption: string) =>
  apiFetch<ArticleMedia>(
    `articles/${id}/media/${mediaId}`,
    { method: 'PATCH', ...json({ caption }) },
    'Неуспешно записване',
  );

export const deleteArticleMedia = (id: string, mediaId: string) =>
  apiFetch<{ id: string }>(`articles/${id}/media/${mediaId}`, { method: 'DELETE' }, 'Неуспешно изтриване');

export const reorderArticleMedia = (id: string, items: { id: string; position: number }[]) =>
  apiFetch<ArticleMedia[]>(
    `articles/${id}/media/reorder`,
    { method: 'PATCH', ...json({ items }) },
    'Неуспешно подреждане',
  );

// ---- Slots ----
export const listSlots = (from: string, to: string) =>
  apiFetch<Slot[]>(`slots?from=${from}&to=${to}`);

export const createSlot = (data: {
  date: string;
  timeFrom: string;
  timeTo: string;
  maxOrders: number;
  customerNote?: string;
  driverNote?: string;
}) => apiFetch<Slot>('slots', { method: 'POST', ...json(data) }, 'Неуспешно създаване на слот');

export const updateSlot = (
  id: string,
  data: { timeFrom?: string; timeTo?: string; maxOrders?: number; customerNote?: string; driverNote?: string },
) => apiFetch<Slot>(`slots/${id}`, { method: 'PATCH', ...json(data) }, 'Неуспешна промяна на слот');

export const deleteSlot = (id: string) =>
  apiFetch<{ id: string }>(`slots/${id}`, { method: 'DELETE' }, 'Неуспешно изтриване');

export const getSlotRule = () => apiFetch<SlotRule | null>('slots/rule');

export const saveSlotRule = (rule: SlotRuleInput) =>
  apiFetch<SlotRule>('slots/rule', { method: 'PUT', ...json(rule) }, 'Неуспешно записване на правилото');

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
  emailPriceStotinki: number;
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

export const sendBroadcast = (data: { subject: string; body: string }) =>
  apiFetch<{ sent: number }>('broadcast', { method: 'POST', ...json(data) }, 'Неуспешно изпращане');

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
