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
}

/** Next page of tenants for "load more" (client-side, via the BFF proxy). */
export const listTenants = (cursor?: string) =>
  apiFetch<Paginated<PlatformTenant>>(
    `platform/tenants${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  );

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
  multiFarmer: boolean;
  multiSubcat: boolean;
  econtConfigured: boolean;
  stripeConnected: boolean;
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
