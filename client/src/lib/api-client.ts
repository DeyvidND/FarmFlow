import type {
  AdminReview,
  AnalyticsSummary,
  Article,
  AvailabilityWindow,
  BundleMember,
  DashboardSummary,
  DayProtocolRow,
  DaySuggestionResult,
  DeliveryConfig,
  DeliveryWindowProposal,
  EcontCity,
  EcontOfficeLive,
  ExpenseCategory,
  ExpenseRow,
  Farmer,
  FarmerAccess,
  FarmerLegal,
  LegalIdentity,
  MediaItem,
  Order,
  Paged,
  Paginated,
  PaymentStatus,
  PnlSummary,
  Product,
  ProductOption,
  ProductVariant,
  ProtocolDraft,
  ProtocolRow,
  ReschedulableOrder,
  ReviewStatus,
  MultiRouteResult,
  RouteAssignment,
  RouteCourier,
  RouteEndMode,
  Shipment,
  Slot,
  SlotRule,
  SlotRuleInput,
  SpeedyConfig,
  SpeedyOffice,
  SpeedySenderSuggestion,
  SpeedySite,
  StatsSummary,
  StatsRange,
  TurnoverBreakdown,
  TurnoverBasis,
  Subcategory,
  TenantProfile,
  TodaySummary,
  UpdateOrderInput,
} from './types';
import type { CheckProtocol } from './protocol-cache';

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
  // A 200 with an empty body is how NestJS serializes a controller that returns
  // null/undefined (e.g. tenants/me/legal before any legal data is saved). Read
  // as text first so an empty body resolves to undefined instead of throwing
  // `SyntaxError: Unexpected end of JSON input` on res.json().
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
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

export const listPendingProducts = (cursor?: string) =>
  apiFetch<Paginated<Product>>(`products?review=pending${qs(cursor).replace('?', '&')}`);

export const approveProduct = (id: string) =>
  apiFetch<Product>(`products/${id}/approve`, { method: 'POST' });

export const pendingReviewCount = () =>
  apiFetch<{ count: number }>('products/review/count');

export const listProductOptions = () => apiFetch<ProductOption[]>('products/options');

/** A variant the dialog sends on save (id present = update existing, absent = create). */
export type VariantWrite = { id?: string; label: string; priceStotinki: number; salePriceStotinki?: number | null; stockQuantity?: number | null };

/** Product write payload: the editable product fields plus the virtual `stock`
 *  number (drives the availability window — number sets it, null clears it back to
 *  unlimited, absent leaves it untouched). `stock` is not a Product column. */
export type ProductWrite = Partial<Product> & {
  stock?: number | null;
  salePercent?: number | null;
  saleEndsAt?: string | null;
  salePriceStotinki?: number | null;
  variants?: VariantWrite[];
};

export const listProductVariants = (productId: string) =>
  apiFetch<ProductVariant[]>(`products/${productId}/variants`, {}, 'Неуспешно зареждане на варианти');

export const createProduct = (data: ProductWrite) =>
  apiFetch<Product>('products', { method: 'POST', ...json(data) }, 'Неуспешно създаване');

export const updateProduct = (id: string, data: ProductWrite) =>
  apiFetch<Product>(`products/${id}`, { method: 'PATCH', ...json(data) }, 'Неуспешно записване');

export const updateCourierBatch = (updates: { id: string; courierDisabled: boolean }[]) =>
  apiFetch<{ ok: true }>('products/courier-batch', { method: 'PATCH', ...json({ updates }) }, 'Неуспешно записване');

/** Bundle contents („Съдържание на пакета", task #1) — only meaningful for a
 *  product with `category === 'bundle'`. Full-replace semantics: `setBundleItems`
 *  sends the whole member list every call (empty array clears it). */
export const getBundleItems = (productId: string) =>
  apiFetch<BundleMember[]>(`products/${productId}/bundle-items`, {}, 'Неуспешно зареждане на съдържанието');

export const setBundleItems = (
  productId: string,
  items: { productId: string; quantity?: number }[],
) =>
  apiFetch<BundleMember[]>(
    `products/${productId}/bundle-items`,
    { method: 'PUT', ...json({ items }) },
    'Неуспешно записване на съдържанието',
  );

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

// Reusable signature (encrypted at rest) — signs handover protocols in one tap.
// Separate endpoint: FarmersService.update spreads its DTO straight into the SQL
// set(), so the signature never travels through the main farmer save.
export const getFarmerSignature = (id: string) =>
  apiFetch<{ signaturePng: string | null }>(`farmers/${id}/signature`);

export const updateFarmerSignature = (id: string, signaturePng: string | null) =>
  apiFetch<{ signaturePng: string | null }>(
    `farmers/${id}/signature`,
    { method: 'PUT', ...json({ signaturePng }) },
    'Подписът не беше записан',
  );

// ---- Farmer self-service ("Моят профил" in the producer's own Настройки) ----
// A producer sub-account maintains its OWN протокол identity (legal data + contact
// line) and reusable signature through this narrow surface — mirrors the admin-only
// farmers/:id helpers above, but always targets the caller's own row (no id).
// The row comes back with `signaturePng` stripped (it has its own endpoint), and
// `legal.confirmedAt` is stamped server-side — sending one is rejected with a 400,
// so the write type excludes it rather than letting a caller discover that at runtime.
type MyFarmerRow = Omit<Farmer, 'signaturePng'>;
type MyFarmerLegal = Omit<FarmerLegal, 'confirmedAt'>;

export const getMyFarmerProfile = () => apiFetch<MyFarmerRow>('farmers/me');

export const updateMyFarmerProfile = (dto: {
  phone?: string;
  email?: string;
  legal?: MyFarmerLegal;
}) =>
  apiFetch<MyFarmerRow>('farmers/me', { method: 'PATCH', ...json(dto) }, 'Профилът не беше записан');

export const getMyFarmerSignature = () =>
  apiFetch<{ signaturePng: string | null }>('farmers/me/signature');

export const updateMyFarmerSignature = (signaturePng: string | null) =>
  apiFetch<{ signaturePng: string | null }>(
    'farmers/me/signature',
    { method: 'PUT', ...json({ signaturePng }) },
    'Подписът не беше записан',
  );

export const getFarmerAccess = () =>
  apiFetch<Record<string, FarmerAccess>>('farmers/access');

export const grantFarmerAccess = (id: string, email: string) =>
  apiFetch<FarmerAccess>(`farmers/${id}/access`, { method: 'POST', ...json({ email }) }, 'Неуспешна покана');

export const revokeFarmerAccess = (id: string) =>
  apiFetch<{ ok: true }>(`farmers/${id}/access`, { method: 'DELETE' }, 'Неуспешно премахване');

/** Organizer: email selected farmers their orders for a date range + statuses. */
export const sendFarmerOrders = (body: {
  from: string;
  to: string;
  farmerIds: string[];
  statuses: string[];
}) =>
  apiFetch<{ sent: number; skipped: number }>(
    'digest/farmers/send',
    { method: 'POST', ...json(body) },
    'Неуспешно изпращане',
  );

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

/** Undo the image-sanity worker's auto rotate/crop — points the photo back
 *  at the pre-fix upload. Products only (the worker is product-scoped). */
export const revertMediaOriginal = (id: string, mediaId: string) =>
  apiFetch<{ id: string }>(`products/${id}/media/${mediaId}/revert`, { method: 'POST' }, 'Неуспешно връщане на оригинала');

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
  routing?: {
    endMode?: 'home' | 'last' | 'custom';
    endAddress?: string | null;
    courierCount?: number;
    dayStartHour?: number;
    slotSizeMin?: number;
    serviceMin?: number;
    cutoff?: { weekday: number; hour: number };
    couriers?: {
      name?: string | null;
      endMode?: 'home' | 'last' | 'custom';
      homeAddress?: string | null;
      homeLat?: string | number | null;
      homeLng?: string | number | null;
    }[];
  };
  sms?: { dayOfReminder?: boolean; sendHour?: number };
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

/**
 * Reverse geocode a map point to an address — used by the route stop editor
 * when the farmer drops/drags a pin on the embedded map. Returns `address:
 * null` when nothing resolves (never throws for a no-match; only a network/
 * auth failure throws via apiFetch's normal ApiError path).
 */
export const reverseGeocode = (lat: number, lng: number) =>
  apiFetch<{ address: string | null }>(
    `orders/route/reverse-geocode?lat=${lat}&lng=${lng}`,
    undefined,
    'Неуспешно търсене на адрес',
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
  /** Auto = show the first/newest N (count); manual = show the picked `ids`. */
  mode: 'auto' | 'manual';
  count: number;
  /** Hand-picked item ids (manual mode), ordered. */
  ids: string[];
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

// ---- Legal identity (settings.legal) ----

export const getTenantLegal = () => apiFetch<LegalIdentity | null>('tenants/me/legal');

export const updateTenantLegal = (legal: LegalIdentity) =>
  apiFetch<LegalIdentity>(
    'tenants/me/legal',
    { method: 'PATCH', ...json(legal) },
    'Неуспешна промяна',
  );

// ---- Operator signature (settings.legal.signature) — same reusable-signature
// mechanism as the farmer one above; signs handover protocols as the operator. ----
export const getOperatorSignature = () =>
  apiFetch<{ signaturePng: string | null }>('tenants/me/signature');

export const updateOperatorSignature = (signaturePng: string | null) =>
  apiFetch<{ signaturePng: string | null }>(
    'tenants/me/signature',
    { method: 'PUT', ...json({ signaturePng }) },
    'Подписът не беше записан',
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
  /** Bulk-create end date — used together with `weekdays` to open a range. */
  dateTo?: string;
  /** Weekdays to open within [date, dateTo] (0=Sun..6=Sat). */
  weekdays?: number[];
  capacity?: number;
  customerNote?: string;
  driverNote?: string;
  reminderOptOut?: boolean;
}) => apiFetch<Slot>('slots', { method: 'POST', ...json(data) }, 'Неуспешно отваряне на ден за доставка');

export const updateSlot = (
  id: string,
  data: { capacity?: number; customerNote?: string; driverNote?: string; reminderOptOut?: boolean },
) => apiFetch<Slot>(`slots/${id}`, { method: 'PATCH', ...json(data) }, 'Неуспешна промяна на деня за доставка');

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
export const listOrders = (opts?: { page?: number; limit?: number; q?: string; status?: string; date?: string }) => {
  const p = new URLSearchParams();
  if (opts?.page) p.set('page', String(opts.page));
  if (opts?.limit) p.set('limit', String(opts.limit));
  if (opts?.q) p.set('q', opts.q);
  if (opts?.status && opts.status !== 'all') p.set('status', opts.status);
  if (opts?.date) p.set('date', opts.date);
  const query = p.toString();
  return apiFetch<Paged<Order>>(`orders${query ? `?${query}` : ''}`);
};

export const updateOrderStatus = (id: string, status: string) =>
  apiFetch<Order>(`orders/${id}/status`, { method: 'PATCH', ...json({ status }) }, 'Неуспешна промяна на статуса');

export const updateOrder = (id: string, body: UpdateOrderInput) =>
  apiFetch<Order>(`orders/${id}`, { method: 'PATCH', ...json(body) }, 'Неуспешно записване на поръчката');

/** Full single order (items + payment) — hydrates the order side panel. */
export const getOrder = (id: string) => apiFetch<Order>(`orders/${id}`);

/** Own-delivery orders eligible to be moved to another day (client groups by slotDate). */
export const listReschedulable = () => apiFetch<ReschedulableOrder[]>('orders/reschedulable');

/** Bulk-move the given orders onto `toDate` (YYYY-MM-DD). */
export const rescheduleOrders = (orderIds: string[], toDate: string) =>
  apiFetch<{ moved: number; toDate: string }>(
    'orders/reschedule',
    { method: 'POST', ...json({ orderIds, toDate }) },
    'Неуспешно преместване на поръчките',
  );

export const setCodOutcome = (id: string, outcome: 'received' | 'refused' | 'pending', reason?: string) =>
  apiFetch<Order>(
    `orders/${id}/cod-outcome`,
    { method: 'PATCH', ...json({ outcome, ...(reason ? { reason } : {}) }) },
    'Неуспешна промяна на статуса на плащане',
  );

/** Revert a resolved COD outcome (received/refused) back to «Очаквано». */
export const revertCodOutcome = (id: string) => setCodOutcome(id, 'pending');

/** Confirm every «Нови» (pending) order scheduled for `date` in one call — the
 *  „Днес" pipeline strip's «Потвърди всички» action. */
export const confirmPending = (date: string) =>
  apiFetch<{ confirmed: number }>(
    `orders/confirm-pending?date=${encodeURIComponent(date)}`,
    { method: 'PATCH' },
    'Неуспешно потвърждаване',
  );

export const getRoute = (opts?: { date?: string; end?: string; couriers?: number; ends?: string[] }) => {
  const p = new URLSearchParams();
  if (opts?.date) p.set('date', opts.date);
  if (opts?.end) p.set('end', opts.end);
  if (opts?.couriers) p.set('couriers', String(opts.couriers));
  if (opts?.ends && opts.ends.length) p.set('ends', opts.ends.join(','));
  const q = p.toString();
  return apiFetch<MultiRouteResult>(`orders/route${q ? `?${q}` : ''}`);
};

// «Моят оборот» — a courier's own turnover for a day. Unlike getRoute (live,
// confirmed-only), this counts confirmed AND delivered orders, so the number
// doesn't shrink as the courier marks deliveries done. Driver-scoped to their
// own leg server-side.
export const getMyTurnover = (date?: string) =>
  apiFetch<MultiRouteResult>(
    `orders/route/my-turnover${date ? `?date=${encodeURIComponent(date)}` : ''}`,
  );

/** Geography-first proposal: spread pending address orders across the given days,
 *  each with its own courier count. */
export const suggestDays = (days: { date: string; couriers: number }[]) =>
  apiFetch<DaySuggestionResult>(
    'orders/suggest-days',
    { method: 'POST', ...json({ days }) },
    'Неуспешно предложение за разпределение',
  );

// ---- Route: road geometry for an explicit stop order (task #5) ----
export const measureRoute = (body: {
  date?: string;
  stopIds: string[];
  courierIndex?: number;
  endMode?: 'home' | 'last' | 'custom';
  /** Start the measured line from the courier's live position (or last
   *  finished drop) instead of the depot, when known — task en-route fix. */
  startLat?: number;
  startLng?: number;
}) =>
  apiFetch<{ polyline: string[] | null; totalDistanceM: number | null; totalDurationS: number | null }>(
    'orders/route/measure',
    { method: 'POST', ...json(body) },
    'Неуспешно изчисляване на маршрута',
  );

// ---- Route: move an order to a courier / clear the pin (task #6) ----
export const setOrderCourier = (orderId: string, courierIndex: number | null) =>
  apiFetch<{ id: string; courierIndex: number | null }>(
    `orders/route/order/${orderId}/courier`,
    { method: 'PATCH', ...json({ courierIndex }) },
    'Неуспешна промяна на куриера',
  );

// ---- Route: persist the operator's manual stop order server-side, so slot
// generation (delivery windows) honours it instead of always re-optimizing.
// Empty stopIds clears the override for that courier. ----
export const setOrderSequence = (body: { date?: string; courierIndex: number; stopIds: string[] }) =>
  apiFetch<{ courierIndex: number; count: number }>(
    'orders/route/order/sequence',
    { method: 'PATCH', ...json(body) },
    'Неуспешно запазване на реда',
  );

// ---- Route: reset the day back to full auto-distribution — clears every
// manual courier pin AND manual stop order for the date, so the next route
// fetch re-runs the geographic split from scratch. ----
export const rebalanceRoute = (date?: string) =>
  apiFetch<{ cleared: number; date: string }>(
    'orders/route/rebalance',
    { method: 'PATCH', ...json({ date }) },
    'Неуспешно авто-разпределение',
  );

// ---- Route: read-only roster of the tenant's couriers (drivers + own
// account), for the farmer panel. Account creation itself now happens in the
// super-admin console — this endpoint is read-only by design. ----
export const listRouteCouriers = () =>
  apiFetch<RouteCourier[]>('orders/route/couriers');

// ---- Route: per-day courier assignment board (Task C2) — which account
// drives which leg on a given date. Whole-day replace on write: the PUT
// always sends the FULL set of rows for that date, matching
// CourierAssignmentService.setAssignmentsForDay's delete-then-insert
// semantics (not a per-row patch). A double-book (same account or same leg
// twice, incl. a concurrent-edit race) comes back as a 409 with a
// user-facing BG message — see `assignmentErrorMessage` in
// `components/route/courier-assignment.ts`. ----
export const getRouteAssignments = (date: string) =>
  apiFetch<RouteAssignment[]>(`orders/route/assignments?date=${encodeURIComponent(date)}`);
export const setRouteAssignments = (date: string, assignments: RouteAssignment[]) =>
  apiFetch<RouteAssignment[]>(
    'orders/route/assignments',
    { method: 'PUT', ...json({ date, assignments }) },
    'Неуспешно запазване на разпределението',
  );

// ---- Route: per-order delivery time windows (task #13) ----
export const generateDeliveryWindows = (body: {
  date?: string;
  couriers?: number;
  ends?: string;
  /** When the round starts (Europe/Sofia hour 0–23); overrides the saved default. */
  startHour?: number;
  /** Courier's current position — first stop's distance/time is measured from here. */
  startLat?: number;
  startLng?: number;
}) =>
  apiFetch<DeliveryWindowProposal>(
    'orders/route/windows/generate',
    { method: 'POST', ...json(body) },
    'Неуспешно генериране на часове',
  );
export const updateDeliveryWindow = (orderId: string, start: string, end: string) =>
  apiFetch<{ id: string; windowStart: string; windowEnd: string; status: string }>(
    `orders/route/window/${orderId}`,
    { method: 'PATCH', ...json({ start, end }) },
    'Неуспешна промяна на часа',
  );
/** Cascade shift: nudge one stop's window by ±minutes and slide every later stop
 *  on the same courier leg by the same amount (WP9 — inline stop time edit). */
export const shiftDeliveryWindow = (date: string, fromStopId: string, deltaMin: number) =>
  apiFetch<{ shifted: number }>(
    'orders/route/windows/shift',
    { method: 'POST', ...json({ date, fromStopId, deltaMin }) },
    'Неуспешна промяна на часа',
  );
export const approveDeliveryWindows = (date?: string) =>
  apiFetch<{ approved: number; date: string }>(
    'orders/route/windows/approve',
    { method: 'POST', ...json({ date }) },
    'Неуспешно одобрение на часовете',
  );
export const notifyDeliveryWindows = (date?: string) =>
  apiFetch<{ sent: number; skipped: number; failed: number; total: number; date: string }>(
    'orders/route/windows/notify',
    { method: 'POST', ...json({ date }) },
    'Неуспешно изпращане на известия',
  );

export const getDashboard = (date?: string) =>
  apiFetch<DashboardSummary>(`dashboard${date ? `?date=${date}` : ''}`);

/** „Днес" delivery-day operations cockpit — pipeline, prep, route, protocols, COD. */
export const getTodaySummary = (date?: string) =>
  apiFetch<TodaySummary>(`dashboard/today${date ? `?date=${encodeURIComponent(date)}` : ''}`);

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

// ---- Turnover breakdown (Task #9/#10) — explicit basis + to-date + platform income ----
export const getTurnover = (
  opts: ({ range: StatsRange } | { from: string; to: string }) & {
    basis?: TurnoverBasis;
    includeUndelivered?: boolean;
    farmerId?: string;
  },
) => {
  const base =
    'from' in opts
      ? `from=${encodeURIComponent(opts.from)}&to=${encodeURIComponent(opts.to)}`
      : `range=${opts.range}`;
  const basis = opts.basis ? `&basis=${opts.basis}` : '';
  const inc = opts.includeUndelivered === undefined ? '' : `&includeUndelivered=${opts.includeUndelivered}`;
  const fid = opts.farmerId ? `&farmerId=${encodeURIComponent(opts.farmerId)}` : '';
  return apiFetch<TurnoverBreakdown>(`stats/turnover?${base}${basis}${inc}${fid}`);
};

// ---- Приходи / разходи / печалба ----

export const getPnl = (opts: { range: StatsRange } | { from: string; to: string }) => {
  const base =
    'from' in opts
      ? `from=${encodeURIComponent(opts.from)}&to=${encodeURIComponent(opts.to)}`
      : `range=${opts.range}`;
  return apiFetch<PnlSummary>(`stats/pnl?${base}`);
};

export const listExpenses = (from: string, to: string) =>
  apiFetch<ExpenseRow[]>(`stats/expenses?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

export const createExpense = (data: {
  date: string;
  amountStotinki: number;
  category: ExpenseCategory;
  courierAccountId?: string;
  note?: string;
}) => apiFetch<{ id: string }>('stats/expenses', { method: 'POST', ...json(data) });

export const updateExpense = (
  id: string,
  data: {
    date?: string;
    amountStotinki?: number;
    category?: ExpenseCategory;
    courierAccountId?: string | null;
    note?: string | null;
  },
) => apiFetch<{ id: string }>(`stats/expenses/${id}`, { method: 'PATCH', ...json(data) });

export const deleteExpense = (id: string) =>
  apiFetch<{ ok: true }>(`stats/expenses/${id}`, { method: 'DELETE' });

export const setCommissionBps = (bps: number) =>
  apiFetch<{ bps: number }>('stats/commission', { method: 'PATCH', ...json({ bps }) });

// ---- Site analytics ----
export const getAnalytics = (opts: { range: StatsRange } | { from: string; to: string }) => {
  const base =
    'from' in opts
      ? `from=${encodeURIComponent(opts.from)}&to=${encodeURIComponent(opts.to)}`
      : `range=${opts.range}`;
  return apiFetch<AnalyticsSummary>(`analytics?${base}`);
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
  /** COD money outcome: 'received' | 'refused' | null (=Очаквано). */
  codOutcome: 'received' | 'refused' | null;
  codOutcomeReason: string | null;
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

// ---- Моите поръчки (farmer fulfillment view) — every status, per-item detail ----
export interface FarmerOrderItem {
  productId: string;
  productName: string;
  quantity: number;
  priceStotinki: number;
}

export interface FarmerOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  status: string;
  deliveryType: string;
  paymentMethod: PaymentChannel;
  day: string;
  createdAt: string | null;
  slotFrom: string | null;
  slotTo: string | null;
  codOutcome: 'received' | 'refused' | null;
  codOutcomeReason: string | null;
  /** True when the order also has another producer's items — actions are
   *  hidden; only the shop owner can mark a shared order delivered. */
  shared: boolean;
  subtotalStotinki: number;
  items: FarmerOrderItem[];
}

export interface FarmerOrdersPage {
  orders: FarmerOrder[];
  nextCursor: string | null;
}

export const getMyOrders = (opts?: {
  status?: string;
  q?: string;
  cursor?: string;
  limit?: number;
  /** Owner-only preview of one producer's view. */
  farmerId?: string;
}) => {
  const p = new URLSearchParams();
  if (opts?.status) p.set('status', opts.status);
  if (opts?.q) p.set('q', opts.q);
  if (opts?.cursor) p.set('cursor', opts.cursor);
  if (opts?.limit) p.set('limit', String(opts.limit));
  if (opts?.farmerId) p.set('farmerId', opts.farmerId);
  const query = p.toString();
  return apiFetch<FarmerOrdersPage>(`orders/mine${query ? `?${query}` : ''}`);
};

// ---- «Утре» (Task #14) — tomorrow's orders + self-tracked fulfilment state ----
export type FulfillmentState = 'pending' | 'in_production' | 'fulfilled';

export interface TomorrowOrderItem {
  productId: string;
  productName: string;
  variantLabel?: string | null;
  quantity: number;
}

export interface TomorrowOrder {
  id: string;
  orderNumber: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  deliveryType: string;
  day: string;
  slotFrom: string | null;
  slotTo: string | null;
  fulfillmentState: FulfillmentState;
  items: TomorrowOrderItem[];
  /** Route ordering (server-stamped from the day's delivery route): 1-based visit
   *  position within its courier's leg, the real leg index, and that courier's
   *  name. All null for an order not on the route (pickup/Econt, or un-geocoded).
   *  The feed comes pre-sorted to match the route (pin #1 first). */
  routeSeq: number | null;
  courierIndex: number | null;
  courierName: string | null;
}

export const setFulfillment = (id: string, state: FulfillmentState, farmerId?: string) =>
  apiFetch<{ orderId: string; farmerId: string; state: FulfillmentState }>(
    `orders/${id}/fulfillment${farmerId ? `?farmerId=${encodeURIComponent(farmerId)}` : ''}`,
    { method: 'PATCH', ...json({ state }) },
    'Неуспешно отбелязване',
  );

export interface PrepSummary {
  date: string;
  confirmedOrders: number;
  pendingOrders: number;
  orders: TomorrowOrder[];
}

export const getPrep = (date?: string, farmerId?: string) => {
  const qs = new URLSearchParams();
  if (date) qs.set('date', date);
  if (farmerId) qs.set('farmerId', farmerId);
  const q = qs.toString();
  return apiFetch<PrepSummary>(`orders/prep${q ? `?${q}` : ''}`);
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

// ---- Vendor finance (дремещ модул: комисиона + месечни такси на производители) ----
export interface CommissionFarmerSummary {
  farmerId: string;
  farmerName: string | null;
  orderCount: number;
  grossStotinki: number;
  commissionStotinki: number;
  settledCommissionStotinki: number;
}
export interface CommissionSummary {
  commissionEnabled: boolean;
  defaultRateBps: number;
  farmers: CommissionFarmerSummary[];
  totalGrossStotinki: number;
  totalCommissionStotinki: number;
}
export const getCommissionSummary = (opts?: { farmerId?: string; from?: string; to?: string }) => {
  const p = new URLSearchParams();
  if (opts?.farmerId) p.set('farmerId', opts.farmerId);
  if (opts?.from) p.set('from', opts.from);
  if (opts?.to) p.set('to', opts.to);
  const query = p.toString();
  return apiFetch<CommissionSummary>(`vendor-finance/commission/summary${query ? `?${query}` : ''}`);
};

export interface VendorCharge {
  id: string;
  farmerId: string | null;
  farmerName: string | null;
  period: string;
  feeStotinki: number;
  status: 'due' | 'paid' | 'waived';
  paidAt: string | null;
  note: string | null;
}
export const listVendorCharges = (period?: string) =>
  apiFetch<VendorCharge[]>(`vendor-finance/subscriptions${period ? `?period=${period}` : ''}`);

/** Explicit owner action (no cron). Refuses (409) while subscriptionEnabled is off. */
export const generateVendorCharges = (period: string) =>
  apiFetch<{ created: number; skipped: number }>(
    'vendor-finance/subscriptions/generate',
    { method: 'POST', ...json({ period }) },
    'Неуспешно генериране на такси',
  );

export const updateVendorCharge = (
  id: string,
  data: { status: 'due' | 'paid' | 'waived'; note?: string },
) =>
  apiFetch<VendorCharge>(
    `vendor-finance/subscriptions/${id}`,
    { method: 'PATCH', ...json(data) },
    'Неуспешно записване',
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

/** Mint a short-TTL token to open the standalone delivery app (dostavki) without a
 *  second login. The panel hands this off via the dostavki `?handoff=` landing. */
export const requestDeliveryHandoff = () =>
  apiFetch<{ token: string }>(
    'auth/delivery-handoff',
    { method: 'POST' },
    'Неуспешно отваряне на доставки',
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

/** Unified shipment list — always fetched from the econt endpoint (returns all carriers).
 *  Keyset-paginated server-side; first page only (server default limit) for now. */
export const listShipments = async () => {
  const page = await apiFetch<{ items: Shipment[]; nextCursor: string | null }>('econt/shipments');
  return page.items;
};

/**
 * Create a waybill for an order. Routes to the carrier endpoint based on which
 * courier the customer chose at checkout.
 */
export const createShipment = (orderId: string, carrier: 'econt' | 'speedy') =>
  apiFetch<ShipmentRecord>(
    carrier === 'speedy' ? `speedy/orders/${orderId}/label` : `econt/shipments/${orderId}`,
    { method: 'POST' },
    'Неуспешно създаване на товарителница',
  );

/** Refresh a shipment's status from its carrier. */
export const refreshShipment = (id: string, carrier: 'econt' | 'speedy') =>
  apiFetch<ShipmentRecord>(`${carrier}/shipments/${id}/refresh`, { method: 'POST' }, 'Неуспешно обновяване на статуса');

/** Void/cancel a waybill via its carrier. */
export const voidShipment = (id: string, carrier: 'econt' | 'speedy') =>
  apiFetch<{ id: string }>(`${carrier}/shipments/${id}`, { method: 'DELETE' }, 'Неуспешно анулиране');

// ---- Handover protocols ----

/** Draft preview (unsaved) for a handover protocol — used to render the sign dialog. */
export const getProtocolDraft = (q: { kind: string; farmerId?: string; orderId?: string; slotId?: string }) => {
  const p = new URLSearchParams();
  if (q.kind) p.set('kind', q.kind);
  if (q.farmerId) p.set('farmerId', q.farmerId);
  if (q.orderId) p.set('orderId', q.orderId);
  if (q.slotId) p.set('slotId', q.slotId);
  return apiFetch<ProtocolDraft>(`handover/draft?${p.toString()}`);
};

export const createProtocol = (body: unknown) =>
  apiFetch<{ id: string; protocolNumber: number }>('handover', { method: 'POST', ...json(body) }, 'Протоколът не беше записан');

export const listProtocols = (q?: { slotId?: string; date?: string; kind?: string }) => {
  const p = new URLSearchParams();
  if (q?.slotId) p.set('slotId', q.slotId);
  if (q?.date) p.set('date', q.date);
  if (q?.kind) p.set('kind', q.kind);
  const query = p.toString();
  return apiFetch<ProtocolRow[]>(`handover${query ? `?${query}` : ''}`);
};

export const createProtocolBatch = (body: { slotId?: string; date?: string; kind?: string }) =>
  apiFetch<{
    ids: string[];
    skipped: { kind: string; farmerId?: string; orderId?: string; slotId?: string; reason: string }[];
  }>('handover/batch', { method: 'POST', ...json(body) }, 'Батчът не беше създаден');

/** Paper-sign every target for the day at once (optionally one leg via kind). */
export const signAllProtocols = (body: { slotId?: string; date?: string; kind?: string }) =>
  apiFetch<{ signed: number }>('handover/sign-all', { method: 'POST', ...json(body) }, 'Неуспешно подписване');

export const markProtocolSigned = (id: string) =>
  apiFetch<void>(`handover/${id}/mark-signed`, { method: 'PATCH' }, 'Неуспешно маркиране');

/** Live day view: every handover-ready target for the date, virtual (id=null) or
 *  persisted. Populated without «Печат за деня» first. */
export const listDayProtocols = (q: { slotId?: string; date?: string }) => {
  const p = new URLSearchParams();
  if (q.slotId) p.set('slotId', q.slotId);
  if (q.date) p.set('date', q.date);
  const query = p.toString();
  return apiFetch<DayProtocolRow[]>(`handover/day${query ? `?${query}` : ''}`);
};

/** Materialize a virtual target into a numbered draft (returns its id) so its PDF
 *  prints with a protocol number. Idempotent — returns the existing row if any. */
export const ensureProtocolDraft = (target: {
  kind: string;
  farmerId?: string;
  orderId?: string;
  slotId?: string;
}) => apiFetch<{ id: string }>('handover/ensure', { method: 'POST', ...json(target) }, 'Протоколът не беше създаден');

/** Paper-sign one target — creates + numbers the protocol if it's still virtual. */
export const signProtocolPaper = (target: {
  kind: string;
  farmerId?: string;
  orderId?: string;
  slotId?: string;
}) => apiFetch<{ id: string }>('handover/sign-paper', { method: 'POST', ...json(target) }, 'Неуспешно подписване');

/** Fullscreen «Проверка» (Task 12) — the day's SIGNED protocols, signatures
 *  already decrypted as PNG data-URLs, prices/order numbers stripped server-side. */
/** The roadside check screen's fetch. Takes a timeout because the failure mode
 *  there is a STALLED connection, not a clean offline one — a bare fetch hangs
 *  until the browser gives up, stranding a courier on „Зареждане…" with an
 *  officer waiting and a usable cache one layer away. Aborting fast lets the
 *  caller fall back to IndexedDB. */
export const getCheckProtocols = (date: string, timeoutMs = 6000) =>
  apiFetch<CheckProtocol[]>(`handover/check?date=${encodeURIComponent(date)}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });

export const protocolPdfHref = (id: string) => `/bff/handover/${id}/pdf`;

/** On-the-fly PDF for a virtual (not-yet-created) target — no number burned. */
export const protocolPreviewPdfHref = (target: {
  kind: string;
  farmerId?: string;
  orderId?: string;
  slotId?: string;
}) => {
  const p = new URLSearchParams();
  p.set('kind', target.kind);
  if (target.farmerId) p.set('farmerId', target.farmerId);
  if (target.orderId) p.set('orderId', target.orderId);
  if (target.slotId) p.set('slotId', target.slotId);
  return `/bff/handover/preview.pdf?${p.toString()}`;
};

export const protocolBatchPdfHref = (q?: { slotId?: string; date?: string; kind?: string }) => {
  const p = new URLSearchParams();
  if (q?.slotId) p.set('slotId', q.slotId);
  if (q?.date) p.set('date', q.date);
  if (q?.kind) p.set('kind', q.kind);
  const query = p.toString();
  return `/bff/handover/batch.pdf${query ? `?${query}` : ''}`;
};

export interface CodReconRow {
  orderId: string;
  expectedStotinki: number | null;
  collectedAt: string | null;
  settledAt: string | null;
}
export const getCodReconciliation = () =>
  apiFetch<CodReconRow[]>('econt/cod-reconciliation');

// ---- Speedy (second courier) ----
/** Public Speedy config (GET /speedy/config) — encrypted password is stripped. */
export interface SpeedyConfigView extends SpeedyConfig {
  isDemo?: boolean;
}

export const getSpeedyConfig = () => apiFetch<SpeedyConfigView>('speedy/config');

export const saveSpeedyCredentials = (data: {
  env?: 'demo' | 'prod';
  userName: string;
  password: string;
  clientSystemId?: number;
  defaultServiceId?: number;
}) =>
  apiFetch<{ configured: true }>(
    'speedy/credentials',
    { method: 'POST', ...json(data) },
    'Неуспешна връзка със Speedy — провери данните',
  );

/** Live Speedy settlement autocomplete (requires a connected Speedy account). */
export const listSpeedySites = (q?: string) =>
  apiFetch<SpeedySite[]>(`speedy/sites${q ? `?q=${encodeURIComponent(q)}` : ''}`);

/** Live Speedy offices for one settlement — sender office picker. */
export const listSpeedyOffices = (siteId: number) =>
  apiFetch<SpeedyOffice[]>(`speedy/offices?siteId=${siteId}`);

/** Speedy contract-client suggestions to prefill the sender profile. */
export const listSpeedyProfiles = () => apiFetch<SpeedySenderSuggestion[]>('speedy/profiles');

// ---- Farmer-scoped carrier status helpers (main-API farmer-aware endpoints) ----
// These hit the FARMER-AWARE read-only endpoints on the main panel API (econt/config
// and speedy/config) to show a connected/not-connected badge in the farmer panel.
// The farmer panel JWT carries farmerId so calls here read the farmer sub-namespace
// of settings.delivery.farmers.<farmerId> — the same store the dostavki SSO session
// also reads. Admin calls to getEcontConfig/getSpeedyConfig above hit the same routes
// but are dispatched to the tenant level server-side. Credential writes (connecting a
// carrier, editing the sender profile) now happen ONLY in dostavki — there is no
// farmer-panel save endpoint for these anymore.

/** Farmer Econt config via the main-API farmer-aware econt/config endpoint. */
export const getFarmerEcontConfig = () =>
  apiFetch<{ configured?: boolean; username?: string; sender?: { phone?: string | null } | null }>('econt/config');

/** Farmer Speedy config via the main-API farmer-aware speedy/config endpoint. */
export const getFarmerSpeedyConfig = () =>
  apiFetch<{ configured?: boolean; userName?: string; sender?: { phone?: string | null } | null }>('speedy/config');

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
// Local mirror of @fermeribg/types NewsletterBlock (client doesn't consume the
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

export const askHelpAi = (question: string) =>
  apiFetch<{ answer: string }>(
    'help/ai/ask',
    { method: 'POST', ...json({ surface: 'panel', question }) },
    'AI помощникът не е достъпен в момента',
  );

// ── AI product import (photo / pasted list → preview → commit) ──────────────

export interface AiExtractedProduct {
  name: string;
  priceStotinki: number;
  unit: string;
  weight?: string;
  category?: string;
  description?: string;
  isActive?: boolean;
}

/** Photo or pasted text → AI-extracted preview rows. Multipart: do NOT set
 *  content-type — the browser sets the boundary and the BFF forwards it. */
export const extractAiProducts = (input: { file?: File; text?: string }) => {
  const fd = new FormData();
  if (input.file) fd.append('file', input.file);
  if (input.text) fd.append('text', input.text);
  return apiFetch<{ products: AiExtractedProduct[] }>(
    'products/ai-import/extract',
    { method: 'POST', body: fd },
    'Неуспешно разчитане',
  );
};

/** Publish the reviewed rows (owner may target one producer via farmerId — the
 *  server forces a farmer sub-account to its own id regardless). */
export const commitAiProducts = (products: AiExtractedProduct[], farmerId?: string) =>
  apiFetch<{ created: number }>(
    'products/ai-import/commit',
    { method: 'POST', ...json({ products, ...(farmerId ? { farmerId } : {}) }) },
    'Неуспешно публикуване',
  );
