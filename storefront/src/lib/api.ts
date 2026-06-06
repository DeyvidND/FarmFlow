/**
 * Typed client for the FarmFlow **public** API — the only backend surface the
 * storefront touches (CORS `*`, no auth header). Tenant-auth (Bearer) routes are
 * off-limits here. Money is integer stotinki end-to-end; divide by 100 only for
 * display (see `money()`).
 *
 *   GET  /public/:slug/products
 *   GET  /public/:slug/slots?date=YYYY-MM-DD
 *   POST /public/:slug/orders
 *   GET  /public/:slug/articles
 *   GET  /public/:slug/articles/:articleSlug
 */
import type {
  PublicProduct,
  PublicArticle,
  PublicFarmer,
  PublicSubcategory,
} from '@farmflow/types';
import type { StorefrontDelivery } from './shipping';

export type { PublicProduct, PublicArticle, PublicFarmer, PublicSubcategory };

/** Base URL of the Nest public API. */
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** Demo farm seeded by `@farmflow/db seed` — the default single-tenant slug. */
export const DEFAULT_SLUG = 'ferma-petrovi';

/**
 * Resolve the tenant slug. Single-farm deploys set `STOREFRONT_SLUG`
 * (server) / `NEXT_PUBLIC_STOREFRONT_SLUG` (also available client-side);
 * `?slug=` overrides it for local multi-tenant testing.
 */
export function resolveSlug(override?: string | null): string {
  return (
    override?.trim() ||
    process.env.NEXT_PUBLIC_STOREFRONT_SLUG ||
    process.env.STOREFRONT_SLUG ||
    DEFAULT_SLUG
  );
}

/* ----------------------------- shared types ----------------------------- */

/** Available delivery slot as returned by `GET /public/:slug/slots`. Times may
 *  arrive as `HH:MM:SS` (pg `time`); trim to `HH:MM` for display. */
export interface PublicSlot {
  id: string;
  date: string; // YYYY-MM-DD
  startTime: string;
  endTime: string;
  remaining: number;
}

export type DeliveryType = 'address' | 'econt';

export interface OrderItemInput {
  productId: string;
  quantity: number;
}

/** Body for `POST /public/:slug/orders` — matches the backend `CreateOrderDto`. */
export interface CreateOrderDto {
  items: OrderItemInput[]; // min 1
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  slotId?: string; // uuid
  deliveryType?: DeliveryType;
  deliveryAddress?: string;
  deliveryLat?: number; // precise pin from the checkout map/autocomplete
  deliveryLng?: number;
  econtOffice?: string;
  notes?: string;
}

/** The created order echoed back by the intake endpoint (status `pending`). */
export interface CreatedOrder {
  id: string;
  status: string;
  totalStotinki: number;
  [key: string]: unknown;
}

/* ------------------------------ error model ----------------------------- */

/**
 * The Nest `GlobalExceptionFilter` double-nests the payload:
 * `{ statusCode, message: { statusCode, message: <string|string[]>, error }, timestamp }`.
 * The human text lives at `body.message.message`. `ApiError.message` is already
 * normalized to a single BG string for toasts.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function extractApiMessage(body: unknown, fallback: string): string {
  const inner = (body as { message?: unknown })?.message;
  const text = (inner as { message?: unknown })?.message ?? inner;
  if (Array.isArray(text)) return text.join(', ');
  if (typeof text === 'string') return text;
  return fallback;
}

/* ------------------------------- transport ------------------------------ */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (err) {
    throw new ApiError(
      'Няма връзка със сървъра. Опитайте отново.',
      0,
      err,
    );
  }

  const isJson = res.headers
    .get('content-type')
    ?.includes('application/json');
  const body = isJson ? await res.json().catch(() => undefined) : undefined;

  if (!res.ok) {
    throw new ApiError(
      extractApiMessage(body, 'Възникна грешка. Опитайте отново.'),
      res.status,
      body,
    );
  }
  return body as T;
}

/* -------------------------------- catalog ------------------------------- */

/** Active products for a farm (Redis-cached 300s server-side). */
export function getProducts(slug: string): Promise<PublicProduct[]> {
  return request<PublicProduct[]>(`/public/${slug}/products`, {
    next: { revalidate: 300 },
  } as RequestInit);
}

/** Single active product by its storefront slug. Throws `ApiError` 404 if unknown. */
export function getProduct(
  slug: string,
  productSlug: string,
): Promise<PublicProduct> {
  return request<PublicProduct>(
    `/public/${slug}/products/${productSlug}`,
    { next: { revalidate: 300 } } as RequestInit,
  );
}

/**
 * Lean public storefront profile (`GET /public/:slug`) — farm contact + the
 * module toggles the storefront gates on: `deliveryEnabled` (personal/address
 * delivery + slots), `multiFarmer` (farmers nav/section), `multiSubcat`
 * (subcategory grouping). Throws `ApiError` 404 if the slug is unknown.
 */
export interface StorefrontProfile {
  name: string;
  slug: string;
  phone: string | null;
  email: string | null;
  deliveryEnabled: boolean;
  multiFarmer: boolean;
  multiSubcat: boolean;
  econtEnabled: boolean;
  econtMode: 'off' | 'manual' | 'auto';
  /** Per-tenant delivery fees so the storefront total matches the charge. */
  delivery: StorefrontDelivery;
}

export function getStorefront(slug: string): Promise<StorefrontProfile> {
  return request<StorefrontProfile>(`/public/${slug}`, {
    next: { revalidate: 300 },
  } as RequestInit);
}

/** Farmers for a storefront — `[]` when the farm runs single-producer (toggle off). */
export function getFarmers(slug: string): Promise<PublicFarmer[]> {
  return request<PublicFarmer[]>(`/public/${slug}/farmers`, {
    next: { revalidate: 300 },
  } as RequestInit);
}

/** Subcategory sections — `[]` when grouping is off (toggle off). */
export function getSubcategories(slug: string): Promise<PublicSubcategory[]> {
  return request<PublicSubcategory[]>(`/public/${slug}/subcategories`, {
    next: { revalidate: 300 },
  } as RequestInit);
}

/** Available delivery slots for a date (`[]` when delivery is disabled). */
export function getSlots(slug: string, date?: string): Promise<PublicSlot[]> {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  return request<PublicSlot[]>(`/public/${slug}/slots${qs}`, {
    cache: 'no-store',
  });
}

/** Place an order. Throws `ApiError` (409 on slot over-capacity). */
export function createOrder(
  slug: string,
  dto: CreateOrderDto,
): Promise<CreatedOrder> {
  return request<CreatedOrder>(`/public/${slug}/orders`, {
    method: 'POST',
    body: JSON.stringify(dto),
  });
}

/** Result of `POST /public/:slug/checkout`. */
export interface CheckoutResult {
  orderId: string;
  /** Stripe-hosted Checkout URL — redirect here. `null` = cash farm; go to confirmation. */
  checkoutUrl: string | null;
}

/**
 * Place an order AND open payment. Same body as {@link createOrder}; returns a
 * Stripe Checkout URL when the farm has Stripe, else `checkoutUrl: null` (the
 * order is placed for cash). Throws `ApiError` (409 on slot over-capacity).
 */
export function createCheckout(
  slug: string,
  dto: CreateOrderDto,
): Promise<CheckoutResult> {
  return request<CheckoutResult>(`/public/${slug}/checkout`, {
    method: 'POST',
    body: JSON.stringify(dto),
  });
}

/** Safe public order recap for the confirmation page (`GET /public/:slug/orders/:id`). */
export interface PublicOrderSummary {
  id: string;
  status: string;
  paidAt: string | null;
  totalStotinki: number;
  customerName: string | null;
  deliveryType: DeliveryType;
  deliveryAddress: string | null;
  econtOffice: string | null;
  slot: { date: string; startTime: string; endTime: string } | null;
  items: { name: string; quantity: number; priceStotinki: number }[];
  createdAt: string | null;
}

/** Fetch a public order recap by id. Throws `ApiError` (404 unknown, 400 bad id). */
export function getOrder(slug: string, id: string): Promise<PublicOrderSummary> {
  return request<PublicOrderSummary>(`/public/${slug}/orders/${id}`, {
    cache: 'no-store',
  });
}

/* -------------------------------- articles ------------------------------ */

export function getArticles(slug: string): Promise<PublicArticle[]> {
  return request<PublicArticle[]>(`/public/${slug}/articles`, {
    next: { revalidate: 300 },
  } as RequestInit);
}

export function getArticle(
  slug: string,
  articleSlug: string,
): Promise<PublicArticle> {
  return request<PublicArticle>(`/public/${slug}/articles/${articleSlug}`, {
    next: { revalidate: 300 },
  } as RequestInit);
}

/* --------------------------------- intake ------------------------------- */

export interface ContactInput {
  name: string;
  email: string;
  phone?: string;
  message: string;
}

/** Subscribe an email to the farm's newsletter (idempotent). Throws `ApiError`. */
export function subscribeNewsletter(slug: string, email: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/public/${slug}/newsletter`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

/** Send a contact-form message. Throws `ApiError` (400 on validation). */
export function submitContact(slug: string, dto: ContactInput): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/public/${slug}/contact`, {
    method: 'POST',
    body: JSON.stringify(dto),
  });
}

/* --------------------------------- reviews ------------------------------ */

export interface PublicReview {
  id: string;
  authorName: string;
  authorLocation: string | null;
  rating: number;
  body: string;
  createdAt: string | null;
}

export interface ReviewSummary {
  average: number;
  count: number;
  reviews: PublicReview[];
}

export interface ReviewInput {
  authorName: string;
  authorLocation?: string;
  rating: number;
  body: string;
}

/** Published reviews + average + count. */
export function getReviews(slug: string): Promise<ReviewSummary> {
  return request<ReviewSummary>(`/public/${slug}/reviews`, { cache: 'no-store' });
}

/** Submit a review — lands `pending` (moderated). Throws `ApiError` (400 invalid). */
export function submitReview(
  slug: string,
  dto: ReviewInput,
): Promise<{ ok: true; status: string }> {
  return request<{ ok: true; status: string }>(`/public/${slug}/reviews`, {
    method: 'POST',
    body: JSON.stringify(dto),
  });
}

/* --------------------------------- money -------------------------------- */

/** Format integer cents as `"6,50 €"`. */
export function money(stotinki: number): string {
  return (stotinki / 100).toFixed(2).replace('.', ',') + ' €';
}
