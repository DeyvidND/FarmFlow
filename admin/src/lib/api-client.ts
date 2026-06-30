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
  courierEnabled: boolean;
  hasLogin: boolean;
  loginEmail: string | null;
  invitePending: boolean;
  econtConnected: boolean;
  speedyConnected: boolean;
  products: number;
  courierOrders: number;
  shipments: number;
  draftShipments: number;
  codPendingStotinki: number;
  createdAt: string | null;
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
  courierEnabled: boolean;
  hasLogin: boolean;
  loginEmail: string | null;
  invitePending: boolean;
  econtConnected: boolean;
  speedyConnected: boolean;
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
    courierEnabled: boolean;
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
