/** Product as returned by the API (GET /products). */
export interface Product {
  id: string;
  name: string;
  description: string | null;
  priceStotinki: number;
  unit: string;
  weight: string | null;
  category: string | null;
  tint: string | null;
  /** NULL = unlimited stock. */
  stockQuantity: number | null;
  isActive: boolean;
  imageUrl: string | null;
  farmerId: string | null;
  subcategoryId: string | null;
  createdAt: string;
}

export interface Farmer {
  id: string;
  name: string;
  role: string | null;
  bio: string | null;
  phone: string | null;
  since: string | null;
  tint: string | null;
  imageUrl: string | null;
  position: number;
  createdAt: string;
}

export interface Subcategory {
  id: string;
  name: string;
  description: string | null;
  tint: string | null;
  imageUrl: string | null;
  position: number;
  createdAt: string;
}

/** Subset of the tenant profile the panels read (GET /tenants/me). */
export interface TenantProfile {
  id: string;
  name: string;
  multiFarmer: boolean;
  multiSubcat: boolean;
  deliveryEnabled: boolean;
}

export type ArticleStatus = 'draft' | 'published';
export type ArticleMediaType = 'image' | 'video' | 'youtube' | 'instagram';

/** One ordered media block of an article. */
export interface ArticleMedia {
  id: string;
  articleId?: string | null;
  type: ArticleMediaType;
  /** R2 url for uploads; source URL for embeds. */
  url: string;
  /** Parsed YouTube video id / Instagram shortcode (embeds only). */
  embedId: string | null;
  caption: string | null;
  position: number;
}

/** Article with its ordered media (admin GET /articles, GET /articles/:id). */
export interface Article {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body: string | null;
  coverImageUrl: string | null;
  status: ArticleStatus;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  media: ArticleMedia[];
}

/** Delivery slot with its live `booked` count (GET /slots). */
export interface Slot {
  id: string;
  date: string; // YYYY-MM-DD
  timeFrom: string; // HH:MM:SS
  timeTo: string; // HH:MM:SS
  maxOrders: number;
  currentOrders: number | null;
  isActive: boolean;
  booked: number;
}

export interface OrderItem {
  id: string;
  productId: string | null;
  productName: string | null;
  quantity: number;
  priceStotinki: number;
}

/** A slot with its live booked count, as returned in the dashboard summary. */
export interface DashboardSlot {
  id: string;
  timeFrom: string;
  timeTo: string;
  maxOrders: number;
  booked: number;
}

/** Today's dashboard summary (GET /dashboard?date=). */
export interface DashboardSummary {
  date: string;
  orderCount: number;
  orderDelta: number;
  revenueStotinki: number;
  pendingCount: number;
  nextSlot: DashboardSlot | null;
  slots: DashboardSlot[];
  subscriptionActive: boolean;
}

/** One delivery stop on the optimized route (GET /orders/route). */
export interface RouteStop {
  id: string;
  customer: string | null;
  phone: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  summary: string;
  slotFrom: string | null;
  slotTo: string | null;
}

/** Delivery route for a date (GET /orders/route?date=). */
export interface RouteResult {
  date: string; // YYYY-MM-DD
  origin: { address: string | null; lat: number | null; lng: number | null };
  stops: RouteStop[];
  totalDistanceM: number | null;
  totalDurationS: number | null;
  optimized: boolean;
}

/** One aggregated product row in the daily prep list. */
export interface ProductionItem {
  productName: string;
  totalQty: number;
  orderCount: number;
}

/** Daily prep list (GET /orders/production?date=). */
export interface ProductionSummary {
  date: string; // YYYY-MM-DD
  confirmedOrders: number;
  items: ProductionItem[];
}

/** Order as returned by GET /orders (with items + joined slot times). */
export interface Order {
  id: string;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  status: 'pending' | 'confirmed' | 'delivered' | 'cancelled';
  totalStotinki: number;
  deliveryType: 'address' | 'econt';
  deliveryAddress: string | null;
  econtOffice: string | null;
  notes: string | null;
  createdAt: string;
  slotFrom: string | null;
  slotTo: string | null;
  items: OrderItem[];
}
