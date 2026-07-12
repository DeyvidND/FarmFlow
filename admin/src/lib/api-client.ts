export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

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

async function apiFetch<T>(path: string, init?: RequestInit, fallbackErr = 'Възникна грешка'): Promise<T> {
  const res = await fetch(`/bff/${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, firstApiMessage(body, fallbackErr));
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Keyset-paginated list envelope returned by admin list endpoints. */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export interface PlatformTenant {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  subscriptionStatus: 'active' | 'past_due' | 'inactive';
  premium: boolean;
  graceUntil: string | null;
  createdAt: string | null;
  orderCount: number;
  lastOrderAt: string | null;
  isDemo: boolean;
  demoExpiresAt: string | null;
}

/** Next page of tenants for "load more" (client-side, via the BFF proxy). */
export const listTenants = (cursor?: string) =>
  apiFetch<Paginated<PlatformTenant>>(
    `platform/tenants${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  );

/** One farmer (producer) in the cross-tenant directory. */
export interface GlobalFarmer {
  id: string;
  name: string;
  role: string | null;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  isDemo: boolean;
  hasLogin: boolean;
  loginEmail: string | null;
  invitePending: boolean;
  econtConnected: boolean;
  speedyConnected: boolean;
  /** Farmer-as-seller go-live readiness (legal identity + own carrier). */
  sellerReady: boolean;
  products: number;
  courierOrders: number;
  shipments: number;
  draftShipments: number;
  codPendingStotinki: number;
  createdAt: string | null;
  tier: number;
}

/** Next page of the cross-tenant farmer directory (client-side "load more"). */
export const listAllFarmers = (cursor?: string) =>
  apiFetch<Paginated<GlobalFarmer>>(
    `platform/farmers${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  );

/** One farmer's super-admin detail (producer drill-down page). */
export interface FarmerDetail {
  id: string;
  name: string;
  role: string | null;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  hasLogin: boolean;
  loginEmail: string | null;
  invitePending: boolean;
  econtConnected: boolean;
  speedyConnected: boolean;
  /** Farmer-as-seller go-live readiness: legal seller identity + own carrier connected. */
  sellerReadiness: {
    ready: boolean;
    hasLegalIdentity: boolean;
    hasOwnCarrier: boolean;
    missing: string[];
  };
  counts: { products: number; courierOrders: number; shipments: number; draftShipments: number };
  cod: { pendingStotinki: number; collectedStotinki: number };
  recentShipments: {
    id: string;
    receiverName: string | null;
    carrier: string | null;
    status: string;
    codAmountStotinki: number | null;
    trackingNumber: string | null;
    createdAt: string | null;
  }[];
  recentOrders: {
    id: string;
    customerName: string | null;
    totalStotinki: number;
    status: string | null;
    createdAt: string | null;
  }[];
  tier: number;
  isFarmerOfWeek: boolean;
  products: { id: string; name: string; imageUrl: string | null; featured: boolean }[];
}

/** One enriched audit-log row for the super-admin audit viewer. */
export interface AuditLog {
  id: string;
  action: string;
  path: string;
  statusCode: number | null;
  createdAt: string | null;
  actorType: 'admin' | 'user' | 'system';
  actorEmail: string | null;
  tenantId: string | null;
  tenantName: string | null;
}

/** Next page of the cross-tenant audit log (mutations only, newest-first).
 *  Optional tenantId / farmerId scope the feed to one farm or one producer. */
export const listAuditLogs = (cursor?: string, opts?: { tenantId?: string; farmerId?: string }) => {
  const p = new URLSearchParams();
  if (cursor) p.set('cursor', cursor);
  if (opts?.tenantId) p.set('tenantId', opts.tenantId);
  if (opts?.farmerId) p.set('farmerId', opts.farmerId);
  const qs = p.toString();
  return apiFetch<Paginated<AuditLog>>(`platform/audit${qs ? `?${qs}` : ''}`);
};

/** Mint a one-click SSO link to open the farmer's „Доставки" as them (super-admin). */
export const impersonateFarmer = (farmerId: string) =>
  apiFetch<{ url: string }>(`platform/impersonate/${farmerId}`, { method: 'POST' }, 'Неуспешно влизане като фермер');

/** Mint a one-click SSO link to open the farm's FULL farmer panel as its owner (super-admin support). */
export const impersonateOwner = (tenantId: string) =>
  apiFetch<{ url: string }>(`platform/impersonate-panel/${tenantId}`, { method: 'POST' }, 'Неуспешно влизане в панела');

/** Cross-tenant delivery operations snapshot (super-admin ops board). */
export interface DeliveryOps {
  shipments: { total: number; drafts: number; created: number; shipped: number; delivered: number; returned: number; refused: number };
  cod: { pendingStotinki: number; collectedStotinki: number; settledStotinki: number; outstandingStotinki: number };
  stuckDrafts: {
    farmerId: string | null;
    farmerName: string;
    tenantId: string;
    tenantName: string;
    count: number;
    oldestAt: string | null;
  }[];
}

export interface PlatformTenantDetail {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  subscriptionStatus: 'active' | 'past_due' | 'inactive';
  premium: boolean;
  graceUntil: string | null;
  createdAt: string | null;
  deliveryEnabled: boolean;
  /** Super-admin „пакет Доставки" gate (panel + deliveries add-on). */
  deliveriesPackageEnabled: boolean;
  multiFarmer: boolean;
  multiSubcat: boolean;
  econtConfigured: boolean;
  /** True when the farm also has the standalone delivery service enabled. */
  deliveryAccount: boolean;
  stripeConnected: boolean;
  /** Set by the super-admin — used by the farm's „Редактирай сайта" button. */
  siteUrl?: string | null;
  orders: {
    total: number;
    pending: number;
    confirmed: number;
    delivered: number;
    cancelled: number;
    revenueStotinki: number;
    lastOrderAt: string | null;
  };
  products: { total: number; active: number };
  subscribers: { active: number; unsubscribed: number };
  reviews: { total: number; avgRating: number };
  emailUsage: { pushCount: number; owedStotinki: number; lastPushAt: string | null };
  recentOrders: {
    id: string;
    customerName: string | null;
    totalStotinki: number;
    status: string | null;
    createdAt: string | null;
  }[];
  farmers: {
    id: string;
    name: string;
    role: string | null;
    hasLogin: boolean;
    loginEmail: string | null;
    invitePending: boolean;
    econtConnected: boolean;
    speedyConnected: boolean;
    products: number;
    courierOrders: number;
    courierRevenueStotinki: number;
    shipments: number;
    draftShipments: number;
    codPendingStotinki: number;
  }[];
}

export interface PlatformEmailBillingRow {
  tenantId: string;
  name: string;
  slug: string;
  email: string | null;
  pushCount: number;
  recipientTotal: number;
  /** Revenue charged to the farm. */
  totalStotinki: number;
  /** Underlying Resend cost. */
  costStotinki: number;
  /** Platform margin = revenue − cost. */
  marginStotinki: number;
  lastPushAt: string | null;
}

export interface PlatformEmailBilling {
  rows: PlatformEmailBillingRow[];
  totals: {
    recipientTotal: number;
    revenueStotinki: number;
    costStotinki: number;
    marginStotinki: number;
  };
}

/** Per-farm Stripe Connect status for the oversight table. */
export interface PlatformStripeAccount {
  tenantId: string;
  name: string;
  slug: string;
  email: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  statusUpdatedAt: string | null;
}

// ── «Анализ» (farm-health insights) ──

export type SignalKey =
  | 'empty_shop'
  | 'no_orders'
  | 'dormant'
  | 'dropping'
  | 'stripe_incomplete'
  | 'econt_incomplete';

export interface FarmSignal {
  key: SignalKey;
  label: string;
  action: string;
  severity: number;
}

export interface FarmSignals {
  tenantId: string;
  name: string;
  slug: string;
  phone: string | null;
  email: string | null;
  signals: FarmSignal[];
  maxSeverity: number;
}

export interface AdoptionRow {
  key: string;
  label: string;
  count: number;
  total: number;
  pct: number;
}

export interface PlatformInsights {
  totalFarms: number;
  farms: { id: string; name: string }[];
  signals: FarmSignals[];
  adoption: AdoptionRow[];
}

export type TimeseriesRange = '7d' | '30d' | '90d' | '1y' | 'all';
export type TimeseriesBucket = 'day' | 'week' | 'month';

export interface TimeseriesPoint {
  t: string;
  orders: number;
  revenueStotinki: number;
}

export interface PlatformTimeseries {
  range: TimeseriesRange;
  bucket: TimeseriesBucket;
  points: TimeseriesPoint[];
}

/** Trend chart series (client-side, via the BFF proxy). */
export const getInsightsTimeseries = (range: TimeseriesRange, tenantId?: string) =>
  apiFetch<PlatformTimeseries>(
    `platform/insights/timeseries?range=${range}${tenantId ? `&tenantId=${encodeURIComponent(tenantId)}` : ''}`,
    undefined,
    'Неуспешно зареждане на графиката',
  );

export const setTenantStatus = (id: string, status: 'active' | 'inactive') =>
  apiFetch<{ id: string; subscriptionStatus: string }>(
    `platform/tenants/${id}/status`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    },
    'Неуспешна промяна на статуса',
  );

/** Toggle a farm's premium (free) billing plan. */
export const setTenantPremium = (id: string, premium: boolean) =>
  apiFetch<{ id: string; premium: boolean }>(
    `platform/tenants/${id}/premium`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ premium }),
    },
    'Неуспешна промяна на плана',
  );

export const setProductFeatured = (id: string, featured: boolean) =>
  apiFetch<{ id: string; featured: boolean }>(
    `platform/products/${id}/featured`,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ featured }) },
    'Неуспешна промяна на „Хит"',
  );

export const setFarmerTier = (id: string, tier: number) =>
  apiFetch<{ id: string; tier: number }>(
    `platform/farmers/${id}/tier`,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tier }) },
    'Неуспешна промяна на тиър',
  );

export const setFarmerOfWeek = (id: string, enabled: boolean) =>
  apiFetch<{ id: string; farmerOfWeek: string | null }>(
    `platform/farmers/${id}/farmer-of-week`,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) },
    'Неуспешна промяна на „Фермер на седмицата"',
  );

export const createTenant = (data: {
  farmName: string;
  email: string;
  tempPassword: string;
  phone?: string;
}) =>
  apiFetch<{ id: string; name: string; slug: string; email: string }>(
    'platform/tenants',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    },
    'Неуспешно създаване на ферма',
  );

/** One-click demo account → returns shareable credentials. */
export const createDemoTenant = (days?: number) =>
  apiFetch<{ id: string; name: string; slug: string; email: string; password: string; expiresAt: string }>(
    'platform/tenants/demo',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(days ? { days } : {}),
    },
    'Неуспешно създаване на демо',
  );

/** Hard-delete a tenant + all its data. Real farms require `confirmSlug` to match
 *  the farm's slug exactly (server-enforced); demos delete without one. */
export const deleteTenant = (id: string, confirmSlug?: string) =>
  apiFetch<{ id: string }>(
    `platform/tenants/${id}${confirmSlug ? `?confirm=${encodeURIComponent(confirmSlug)}` : ''}`,
    { method: 'DELETE' },
    'Неуспешно изтриване',
  );

/** Reset a farm owner's password → returns a fresh one-time temp password. */
export const resetTenantPassword = (id: string) =>
  apiFetch<{ id: string; name: string; email: string | null; tempPassword: string }>(
    `platform/tenants/${id}/reset-password`,
    { method: 'PATCH' },
    'Неуспешно нулиране на паролата',
  );

// ── AI product import (super-admin onboarding) ──

/** One AI-extracted product row, editable in the preview before commit. */
export interface ExtractedProduct {
  name: string;
  priceStotinki: number;
  unit: string;
  weight?: string;
  category?: string;
  description?: string;
}

/**
 * Send a pasted price list (text) and/or an uploaded file (.txt/.csv/.xlsx) to the
 * AI extractor. Multipart: do NOT set content-type — the browser sets the boundary
 * and the BFF forwards it. Returns rows only (no products created yet).
 */
export const extractProducts = (tenantId: string, input: { file?: File; text?: string }) => {
  const fd = new FormData();
  if (input.file) fd.append('file', input.file);
  if (input.text) fd.append('text', input.text);
  return apiFetch<{ products: ExtractedProduct[] }>(
    `platform/tenants/${tenantId}/products/extract`,
    { method: 'POST', body: fd },
    'Неуспешно извличане на продукти',
  );
};

/** Commit the reviewed rows to the farm's catalog via the existing import endpoint.
 *  `farmerId` attaches each product to the producer whose page this is. */
export const importTenantProducts = (
  tenantId: string,
  products: (ExtractedProduct & { farmerId?: string; isActive?: boolean })[],
) =>
  apiFetch<{ products: number; farmers: number; categories: number; contact: boolean; favicon: boolean }>(
    `platform/tenants/${tenantId}/import`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ products }),
    },
    'Неуспешно създаване на продукти',
  );

/**
 * Change the super-admin password. Goes through the session route handler (NOT
 * the BFF) because the API bumps tokenVersion on change — the route re-sets the
 * cookie with the fresh token so the session survives the rotation.
 */
export const changePassword = async (data: { currentPassword: string; newPassword: string }) => {
  const res = await fetch('/api/session/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, firstApiMessage(body, 'Неуспешна смяна на паролата'));
  }
};

// ── Delivery accounts (standalone Econt/Speedy service) ──
export interface DeliveryOverview {
  total: number;
  codPendingStotinki: number;
  codCollectedStotinki: number;
  econt: number;
  speedy: number;
  lastShipmentAt: string | null;
}

export interface DeliveryAccount {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  type: 'delivery' | 'farm' | 'both';
  active: boolean;
  isDemo: boolean;
  createdAt: string | null;
  overview: DeliveryOverview;
}

export interface DeliveryShipment {
  id: string;
  /** Receiver of an order-less/manual shipment; null for order-linked rows. */
  receiverName: string | null;
  carrier: string;
  status: string;
  codAmountStotinki: number | null;
  codCollectedAt: string | null;
  codSettledAt: string | null;
  createdAt: string | null;
  trackingNumber: string | null;
  econtShipmentNumber: string | null;
}

export const listDeliveryAccounts = (cursor?: string) =>
  apiFetch<Paginated<DeliveryAccount>>(
    `platform/delivery/accounts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  );

/** Full paginated shipment history for one delivery account ("load more"). */
export const listDeliveryShipments = (id: string, cursor?: string) =>
  apiFetch<Paginated<DeliveryShipment>>(
    `platform/delivery/accounts/${id}/shipments${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    undefined,
    'Неуспешно зареждане на пратките',
  );

export const createDeliveryAccount = (data: {
  email: string;
  name: string;
  phone?: string;
  shop: boolean;
  delivery: boolean;
  active: boolean;
  demo?: boolean;
}) =>
  apiFetch<{ id: string; name: string; slug: string; email: string; inviteLink: string }>(
    'platform/delivery/accounts',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    },
    'Неуспешно създаване на акаунт',
  );

/** Resend/regenerate the set-password invite link (also re-emailed by the API). */
export const resendDeliveryInvite = (id: string) =>
  apiFetch<{ inviteLink: string }>(
    `platform/delivery/accounts/${id}/invite`,
    { method: 'POST' },
    'Неуспешно изпращане на покана',
  );

export const setDeliveryActive = (id: string, active: boolean) =>
  apiFetch<{ id: string; active: boolean }>(
    `platform/delivery/accounts/${id}/active`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active }),
    },
    'Неуспешна промяна на услугата',
  );

export const enableDeliveryOnFarm = (id: string) =>
  apiFetch<{ id: string; delivery: boolean }>(
    `platform/delivery/accounts/${id}/enable-delivery`,
    { method: 'PATCH' },
    'Неуспешно включване на доставка',
  );

// ── «Проблеми» (unified cross-farm problems feed) ──

export type ProblemSeverity = 'high' | 'med' | 'low';

/** One unified cross-farm problem row for the super-admin «Проблеми» feed.
 *  Mirrors `server/src/modules/platform/problems.service.ts` — response shape is FIXED. */
export interface PlatformProblem {
  severity: ProblemSeverity;
  /** Machine key, e.g. 'server_error' | 'stuck_shipment' | 'empty_shop' | 'no_orders' |
   *  'dormant' | 'stripe_incomplete' | 'econt_incomplete' | 'dropping' | 'cod_outstanding'. */
  kind: string;
  tenantId: string | null;
  tenantName: string | null;
  /** Short BG label. */
  title: string;
  /** BG specifics. */
  detail: string;
  count?: number;
  /** ISO timestamp. */
  lastAt?: string;
  /** Present for kind:'server_error' — needed to resolve/reopen the group. */
  path?: string;
}

export interface ProblemsResponse {
  items: PlatformProblem[];
  generatedAt: string;
  notes?: string[];
}

/** Unified, severity-ranked cross-farm problems feed (client-side, via the BFF proxy). */
export const getProblems = () =>
  apiFetch<ProblemsResponse>('platform/problems', undefined, 'Неуспешно зареждане на проблемите');

/** Marks a server-error problem group (tenantId+path) as resolved — it drops out of
 *  the «Проблеми» feed until a NEW error for that exact group arrives. */
export const resolveProblem = (tenantId: string | null, path: string) =>
  apiFetch<{ ok: true }>(
    'platform/problems/resolve',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId, path }) },
    'Неуспешно маркиране като оправено',
  );

// ── «Здраве» (system health board) ──

export type ServiceStatus = 'up' | 'down';

/** One BullMQ queue's live depth + a derived triage status.
 *  Mirrors `server/src/modules/platform/health-board.service.ts` — response shape is FIXED. */
export interface QueueHealth {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  status: 'ok' | 'backlog' | 'error';
}

/** One recent server-side failure with its verbatim message (the real cause). */
export interface RecentError {
  method: string;
  path: string;
  statusCode: number;
  message: string | null;
  tenantId: string | null;
  tenantName: string | null;
  createdAt: string;
  /** True when an operator has already marked this error's group resolved in
   *  «Проблеми» — shown as an "✅ Оправено" badge rather than hidden. */
  resolved: boolean;
}

export interface HealthBoard {
  generatedAt: string;
  services: { db: ServiceStatus; redis: ServiceStatus };
  queues: QueueHealth[];
  errors: {
    last24h: number;
    topPaths: { path: string; count: number }[];
    topTenants: { tenantId: string | null; tenantName: string | null; count: number }[];
    recent: RecentError[];
  };
  notes?: string[];
}

/** Cross-tenant system health snapshot — services, queues, 24h error digest (client-side, via the BFF proxy). */
export const getHealthBoard = () =>
  apiFetch<HealthBoard>('platform/health-board', undefined, 'Неуспешно зареждане на здравето');

// ── «Финанси на пазара» (marketplace vendor-finance oversight, super-admin) ──

/** One marketplace brand (multi-producer tenant) with its commission roll-up. */
export interface MarketplaceBrand {
  id: string;
  name: string;
  slug: string;
  isDemo: boolean;
  commissionEnabled: boolean;
  defaultRateBps: number;
  farmerCount: number;
  totalGrossStotinki: number;
  totalCommissionStotinki: number;
}

export interface CommissionFarmerSummary {
  farmerId: string;
  farmerName: string | null;
  orderCount: number;
  grossStotinki: number;
  commissionStotinki: number;
}

export interface CommissionSummary {
  commissionEnabled: boolean;
  defaultRateBps: number;
  farmers: CommissionFarmerSummary[];
  totalGrossStotinki: number;
  totalCommissionStotinki: number;
}

export type VendorChargeStatus = 'due' | 'paid' | 'waived';

export interface VendorCharge {
  id: string;
  farmerId: string;
  farmerName: string | null;
  period: string;
  feeStotinki: number;
  status: VendorChargeStatus;
  note: string | null;
}

/** All marketplace brands + commission totals (super-admin, via the BFF proxy). */
export const listMarketplaceBrands = () =>
  apiFetch<MarketplaceBrand[]>('platform/marketplace/brands', undefined, 'Неуспешно зареждане на пазара');

/** One brand's per-producer commission summary. */
export const getBrandCommission = (id: string, opts?: { from?: string; to?: string }) => {
  const p = new URLSearchParams();
  if (opts?.from) p.set('from', opts.from);
  if (opts?.to) p.set('to', opts.to);
  const qs = p.toString();
  return apiFetch<CommissionSummary>(
    `platform/marketplace/brands/${id}/commission${qs ? `?${qs}` : ''}`,
    undefined,
    'Неуспешно зареждане на комисионата',
  );
};

/** One brand's monthly vendor charges (optionally scoped to a YYYY-MM period). */
export const listBrandCharges = (id: string, period?: string) =>
  apiFetch<VendorCharge[]>(
    `platform/marketplace/brands/${id}/subscriptions${period ? `?period=${encodeURIComponent(period)}` : ''}`,
    undefined,
    'Неуспешно зареждане на таксите',
  );

/** Create the month's `due` charge rows for a brand. */
export const generateBrandCharges = (id: string, period: string) =>
  apiFetch<{ created: number; skipped: number }>(
    `platform/marketplace/brands/${id}/subscriptions/generate`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ period }) },
    'Неуспешно генериране на таксите',
  );

/** Set a charge's status (due / paid / waived). */
export const updateBrandCharge = (
  id: string,
  chargeId: string,
  body: { status: VendorChargeStatus; note?: string },
) =>
  apiFetch<VendorCharge>(
    `platform/marketplace/brands/${id}/subscriptions/${chargeId}`,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    'Неуспешна промяна на таксата',
  );

// ── One-shot producer onboarding (create + AI-import + invite link) ──

export interface OnboardProducerResult {
  farmerId: string;
  productsCreated: number;
  inviteLink: string | null;
}

// ── «Карта на производители» (cross-tenant producers map, task #12) ──

/** One producer pin (or table row when unlocated) for the producers map.
 *  Mirrors `server/src/modules/platform/platform.service.ts` — response shape is FIXED. */
export interface ProducerMapPoint {
  id: string;
  name: string;
  tenantName: string;
  tenantSlug: string;
  isDemo: boolean;
  city: string | null;
  tier: number;
  tint: string | null;
  imageUrl: string | null;
  /** Null when the producer/tenant address hasn't been geocoded yet — not plotted
   *  on the map, but still listed in the fallback table. */
  lat: number | null;
  lng: number | null;
}

export interface ProducersMapResult {
  producers: ProducerMapPoint[];
  withLocation: number;
  withoutLocation: number;
  /** False when GOOGLE_MAPS_API_KEY is unset on the server — the page falls back
   *  to the table only. */
  mapsEnabled: boolean;
}

/** Cross-tenant producers map snapshot (client-side, via the BFF proxy). */
export const getProducersMap = () =>
  apiFetch<ProducersMapResult>('platform/producers/map', undefined, 'Неуспешно зареждане на картата');

/** Multipart: do NOT set content-type — the browser sets the boundary. */
export const onboardProducer = (
  tenantId: string,
  input: { name: string; phone?: string; email?: string; pricelistText?: string; file?: File },
) => {
  const fd = new FormData();
  fd.append('name', input.name);
  if (input.phone) fd.append('phone', input.phone);
  if (input.email) fd.append('email', input.email);
  if (input.pricelistText) fd.append('pricelistText', input.pricelistText);
  if (input.file) fd.append('file', input.file);
  return apiFetch<OnboardProducerResult>(
    `platform/tenants/${tenantId}/producers/onboard`,
    { method: 'POST', body: fd },
    'Неуспешно създаване на производителя',
  );
};
