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
