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

export interface PlatformTenant {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  subscriptionStatus: 'active' | 'inactive';
  createdAt: string | null;
  orderCount: number;
  lastOrderAt: string | null;
}

export interface PlatformTenantDetail {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  subscriptionStatus: 'active' | 'inactive';
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

export interface PlatformEmailBilling {
  tenantId: string;
  name: string;
  slug: string;
  email: string | null;
  pushCount: number;
  totalStotinki: number;
  lastPushAt: string | null;
}

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

export const changePassword = (data: { currentPassword: string; newPassword: string }) =>
  apiFetch<void>(
    'platform/change-password',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    },
    'Неуспешна смяна на паролата',
  );
