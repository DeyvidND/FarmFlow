import type {
  Article,
  ArticleMedia,
  DashboardSummary,
  Farmer,
  Order,
  Product,
  ProductionSummary,
  RouteResult,
  Slot,
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

export const listProducts = () => apiFetch<Product[]>('products');

export const createProduct = (data: Partial<Product>) =>
  apiFetch<Product>('products', { method: 'POST', ...json(data) }, 'Неуспешно създаване');

export const updateProduct = (id: string, data: Partial<Product>) =>
  apiFetch<Product>(`products/${id}`, { method: 'PATCH', ...json(data) }, 'Неуспешно записване');

export const deleteProduct = (id: string) =>
  apiFetch<{ id: string }>(`products/${id}`, { method: 'DELETE' }, 'Неуспешно изтриване');

export function uploadProductImage(id: string, file: File) {
  const fd = new FormData();
  fd.append('image', file);
  return apiFetch<Product>(`products/${id}/image`, { method: 'POST', body: fd }, 'Неуспешно качване');
}

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

// ---- Tenant toggles ----
export const updateTenant = (data: { multiFarmer?: boolean; multiSubcat?: boolean }) =>
  apiFetch<TenantProfile>('tenants/me', { method: 'PATCH', ...json(data) }, 'Неуспешна промяна');

// ---- Articles ----
export const listArticles = () => apiFetch<Article[]>('articles');

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
}) => apiFetch<Slot>('slots', { method: 'POST', ...json(data) }, 'Неуспешно създаване на слот');

export const deleteSlot = (id: string) =>
  apiFetch<{ id: string }>(`slots/${id}`, { method: 'DELETE' }, 'Неуспешно изтриване');

// ---- Orders ----
export const listOrders = () => apiFetch<Order[]>('orders');

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

// ---- Tenant ----
export const setDeliveryEnabled = (enabled: boolean) =>
  apiFetch<{ deliveryEnabled: boolean }>(
    'tenants/me',
    { method: 'PATCH', ...json({ deliveryEnabled: enabled }) },
    'Неуспешна промяна',
  );
