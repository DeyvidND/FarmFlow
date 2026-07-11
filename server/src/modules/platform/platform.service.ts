import {
  Injectable,
  Inject,
  Logger,
  UnauthorizedException,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { and, asc, eq, isNull, ne, sql, desc, inArray } from 'drizzle-orm';
import { AuthService } from '../auth/auth.service';
import { BillingService } from '../billing/billing.service';
import { emailCostStotinki } from '../billing/billing.pricing';
import { ProductsService } from '../products/products.service';
import { FarmersService } from '../farmers/farmers.service';
import { SubcategoriesService } from '../subcategories/subcategories.service';
import { TenantsService } from '../tenants/tenants.service';
import { StorageService } from '../storage/storage.service';
import { CatalogCacheService } from '../catalog-cache/catalog-cache.service';
import { PlatformImportDto } from './dto/platform-import.dto';
import {
  type Database,
  tenants,
  users,
  orders,
  orderItems,
  shipments,
  productAvailabilityWindows,
  subcategories,
  farmers,
  articles,
  deliverySlots,
  contactMessages,
  auditLogs,
  newsletterCampaigns,
  platformAdmins,
  emailPushes,
  products,
  newsletterSubscribers,
  reviews,
} from '@fermeribg/db';
import type { JwtPayload } from '@fermeribg/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService, publicCacheKeys } from '../../common/cache/public-cache.service';
import {
  clampLimit,
  keysetAfter,
  buildKeysetPage,
  cursorTs,
  KEYSET_TS,
  type Paginated,
} from '../../common/pagination/keyset';
import { decodeCursor } from '../../common/pagination/cursor';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { ChangePasswordDto } from '../auth/dto/change-password.dto';
import { sanitizeSiteUrl } from '../tenants/site-copy';
import { DEMO_SEED } from './demo-seed';
import { econtTenantSettings, withEcontActive } from '../econt-app/econt-app.helpers';
import { farmDefaultSettings } from './platform.helpers';
import { CreateDeliveryAccountDto } from './dto/create-delivery-account.dto';
import {
  deliveryCapabilities,
  buildDeliveryOverview,
  type DeliveryOverview,
} from './delivery-accounts.helpers';

export interface DeliveryAccountRow {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  type: 'delivery' | 'farm' | 'both';
  active: boolean;
  isDemo: boolean;
  createdAt: Date | null;
  overview: DeliveryOverview;
}

export interface DeliveryShipmentRow {
  id: string;
  /** Receiver of an order-less/manual shipment; null for order-linked rows. */
  receiverName: string | null;
  carrier: string;
  status: string;
  codAmountStotinki: number | null;
  codCollectedAt: Date | null;
  codSettledAt: Date | null;
  createdAt: Date | null;
  trackingNumber: string | null;
  econtShipmentNumber: string | null;
}

export interface DeliveryAccountDetail extends DeliveryAccountRow {
  recentShipments: DeliveryShipmentRow[];
}

export interface PlatformTenantRow {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  subscriptionStatus: 'active' | 'past_due' | 'inactive';
  premium: boolean;
  graceUntil: Date | null;
  createdAt: Date | null;
  orderCount: number;
  lastOrderAt: Date | null;
  isDemo: boolean;
  demoExpiresAt: Date | null;
}

/** Per-farm email usage → revenue, Resend cost, and the platform's margin. */
export interface PlatformEmailBillingRow {
  tenantId: string;
  name: string;
  slug: string;
  email: string | null;
  pushCount: number;
  recipientTotal: number;
  /** Revenue charged to the farm (sum of per-send price_stotinki, historical). */
  totalStotinki: number;
  /** Underlying Resend cost (recipients × cost rate). */
  costStotinki: number;
  /** Platform margin = revenue − cost. */
  marginStotinki: number;
  lastPushAt: Date | null;
}

/** Email-billing table + platform-wide totals — "how much do I make on email". */
export interface PlatformEmailBilling {
  rows: PlatformEmailBillingRow[];
  totals: {
    recipientTotal: number;
    revenueStotinki: number;
    costStotinki: number;
    marginStotinki: number;
  };
}

/** Per-farm Stripe Connect status for the super-admin oversight table. */
export interface PlatformStripeAccountRow {
  tenantId: string;
  name: string;
  slug: string;
  email: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  statusUpdatedAt: Date | null;
}

/** Full per-farm snapshot for the super-admin detail view. */
export interface PlatformTenantDetail {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  subscriptionStatus: 'active' | 'past_due' | 'inactive';
  premium: boolean;
  graceUntil: Date | null;
  createdAt: Date | null;
  deliveryEnabled: boolean;
  deliveriesPackageEnabled: boolean;
  multiFarmer: boolean;
  multiSubcat: boolean;
  econtConfigured: boolean;
  deliveryAccount: boolean;
  stripeConnected: boolean;
  siteUrl: string;
  orders: {
    total: number;
    pending: number;
    confirmed: number;
    delivered: number;
    cancelled: number;
    revenueStotinki: number;
    lastOrderAt: Date | null;
  };
  products: { total: number; active: number };
  subscribers: { active: number; unsubscribed: number };
  reviews: { total: number; avgRating: number };
  emailUsage: { pushCount: number; owedStotinki: number; lastPushAt: Date | null };
  recentOrders: {
    id: string;
    customerName: string | null;
    totalStotinki: number;
    status: string | null;
    createdAt: Date | null;
  }[];
  // Per-farmer (producer) breakdown for the super-admin relationship view: each
  // farmer of this tenant, their login, carrier connection and courier activity.
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

/** One row of the super-admin cross-tenant farmer (producer) directory. */
export interface GlobalFarmerRow {
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
  products: number;
  courierOrders: number;
  shipments: number;
  draftShipments: number;
  codPendingStotinki: number;
  createdAt: Date | null;
}

/** One enriched audit-log row for the super-admin audit viewer. */
export interface AuditLogRow {
  id: string;
  action: string;
  path: string;
  statusCode: number | null;
  createdAt: Date | null;
  actorType: 'admin' | 'user' | 'system';
  actorEmail: string | null;
  tenantId: string | null;
  tenantName: string | null;
}

/** One farmer's full super-admin detail (producer drill-down page). */
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
  // Marketplace ranking tier (1..3) — mirrors farmers.tier. For the curation screen's
  // tier picker.
  tier: number;
  // Whether this farmer is currently the tenant's «Фермер на седмицата»
  // (settings.farmerOfWeek.farmerId === this farmer's id).
  isFarmerOfWeek: boolean;
  // Lean product list (active, non-deleted) for the «Хит» toggle grid.
  products: { id: string; name: string; imageUrl: string | null; featured: boolean }[];
  counts: { products: number; courierOrders: number; shipments: number; draftShipments: number };
  cod: { pendingStotinki: number; collectedStotinki: number };
  recentShipments: {
    id: string;
    receiverName: string | null;
    carrier: string | null;
    status: string;
    codAmountStotinki: number | null;
    trackingNumber: string | null;
    createdAt: Date | null;
  }[];
  recentOrders: {
    id: string;
    customerName: string | null;
    totalStotinki: number;
    status: string | null;
    createdAt: Date | null;
  }[];
}

/** Cross-tenant delivery operations snapshot for the super-admin ops board. */
export interface DeliveryOpsSummary {
  shipments: { total: number; drafts: number; created: number; shipped: number; delivered: number; returned: number; refused: number };
  cod: { pendingStotinki: number; collectedStotinki: number; settledStotinki: number; outstandingStotinki: number };
  stuckDrafts: { farmerId: string | null; farmerName: string; tenantId: string; tenantName: string; count: number; oldestAt: Date | null }[];
}

@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
    private readonly billing: BillingService,
    private readonly publicCache: PublicCacheService,
    private readonly config: ConfigService,
    private readonly productsSvc: ProductsService,
    private readonly farmersSvc: FarmersService,
    private readonly subcategoriesSvc: SubcategoriesService,
    private readonly tenantsSvc: TenantsService,
    private readonly storage: StorageService,
    private readonly catalogCache: CatalogCacheService,
  ) {}

  /** Origin the delivery set-password ("invite") link is aimed at. */
  private deliveryPublicUrl(): string {
    const url = this.config.get<string>('DELIVERY_PUBLIC_URL');
    return url && url.trim() ? url.trim() : 'https://dostavki.fermeribg.com';
  }

  /** Platform admin login → platform-typed JWT. */
  async login(email: string, password: string): Promise<{ accessToken: string }> {
    // Case-insensitive match: the bootstrap super-admin and onboarded accounts are
    // stored lowercased, but a legacy/mixed-case row must not lock the operator out.
    const normalized = email.trim().toLowerCase();
    const [admin] = await this.db
      .select()
      .from(platformAdmins)
      .where(sql`lower(${platformAdmins.email}) = ${normalized}`)
      .limit(1);

    const invalid = new UnauthorizedException('Грешен имейл или парола');
    if (!admin) {
      // Constant-time: an unknown email pays the same Argon2 cost as a wrong
      // password, so the most privileged login can't be enumerated by timing.
      await this.burnPasswordTime(password);
      throw invalid;
    }
    if (!(await argon2.verify(admin.passwordHash, password))) throw invalid;

    const payload: JwtPayload = {
      sub: admin.id,
      type: 'platform',
      mustChangePassword: admin.mustChangePassword,
      tv: admin.tokenVersion,
    };
    return { accessToken: this.jwt.sign(payload) };
  }

  /** Identity for the admin panel's server-side auth gate + force-change flow. */
  async me(adminId: string): Promise<{ email: string; mustChangePassword: boolean }> {
    const [admin] = await this.db
      .select({ email: platformAdmins.email, mustChangePassword: platformAdmins.mustChangePassword })
      .from(platformAdmins)
      .where(eq(platformAdmins.id, adminId))
      .limit(1);
    if (!admin) throw new UnauthorizedException();
    return admin;
  }

  private dummyHashPromise?: Promise<string>;
  private burnPasswordTime(password: string): Promise<void> {
    this.dummyHashPromise ??= argon2.hash('argon2-timing-equalizer-placeholder');
    return this.dummyHashPromise
      .then((h) => argon2.verify(h, password))
      .then(() => undefined)
      .catch(() => undefined);
  }

  /**
   * Every farm + order summary (count, last order). One grouped query,
   * keyset-paginated, Redis-cached per (cursor, limit) for 60 s.
   *
   * Why cache instead of correlated subqueries: the correlated-subquery rewrite
   * is theoretically faster on large tables but requires emitting raw SQL for
   * Drizzle and risks breaking the keyset cursor shape. The cache approach is
   * lower-risk and fully sufficient for a super-admin-only list: at most one
   * operator refreshes this every few seconds, so a 60 s TTL absorbs all repeat
   * loads with zero extra Postgres work, and a write-bust is not needed because
   * staleness of 60 s is acceptable for a management overview.
   */
  async listTenants(
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<Paginated<PlatformTenantRow>> {
    const lim = clampLimit(opts.limit);
    // Include both inputs in the cache key so different pages are separate entries.
    const cacheKey = `platform:tenants:${opts.cursor ?? ''}:${lim}`;
    const cached = await this.publicCache.get<Paginated<PlatformTenantRow>>(cacheKey);
    if (cached) {
      // Dates are serialised to strings in JSON — restore them so callers get
      // real Date objects (same as a live DB row).
      cached.items = cached.items.map((r) => ({
        ...r,
        createdAt: r.createdAt ? new Date(r.createdAt) : null,
        lastOrderAt: r.lastOrderAt ? new Date(r.lastOrderAt) : null,
        graceUntil: r.graceUntil ? new Date(r.graceUntil) : null,
        demoExpiresAt: r.demoExpiresAt ? new Date(r.demoExpiresAt) : null,
      }));
      return cached;
    }

    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;

    const base = this.db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        email: tenants.email,
        phone: tenants.phone,
        subscriptionStatus: tenants.subscriptionStatus,
        premium: tenants.premium,
        graceUntil: tenants.graceUntil,
        createdAt: tenants.createdAt,
        orderCount: sql<number>`count(${orders.id})::int`,
        lastOrderAt: sql<Date | null>`max(${orders.createdAt})`,
        isDemo: tenants.isDemo,
        demoExpiresAt: tenants.demoExpiresAt,
        [KEYSET_TS]: cursorTs(tenants.createdAt),
      })
      .from(tenants)
      .leftJoin(orders, eq(orders.tenantId, tenants.id));

    const scoped = cur ? base.where(keysetAfter(tenants.createdAt, tenants.id, cur, 'asc')) : base;

    const rows = (await scoped
      .groupBy(tenants.id)
      .orderBy(asc(tenants.createdAt), asc(tenants.id))
      .limit(lim + 1)) as Array<PlatformTenantRow & { [KEYSET_TS]: string }>;

    const page = buildKeysetPage(rows, lim);
    await this.publicCache.set(cacheKey, page, 60);
    return page;
  }

  /**
   * Email-push usage per farm — how much each owes the platform for newsletter
   * pushes. The platform owner collects payment manually; this is just the ledger.
   * Only farms with at least one push are returned, highest owed first.
   */
  async emailBilling(): Promise<PlatformEmailBilling> {
    const raw = await this.db
      .select({
        tenantId: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        email: tenants.email,
        pushCount: sql<number>`count(${emailPushes.id})::int`,
        recipientTotal: sql<number>`coalesce(sum(${emailPushes.recipientCount}), 0)::int`,
        totalStotinki: sql<number>`coalesce(sum(${emailPushes.priceStotinki}), 0)::int`,
        lastPushAt: sql<Date | null>`max(${emailPushes.createdAt})`,
      })
      .from(tenants)
      .innerJoin(emailPushes, eq(emailPushes.tenantId, tenants.id))
      .groupBy(tenants.id)
      .orderBy(sql`sum(${emailPushes.priceStotinki}) desc`);

    const costMicro = this.config.get<number>('EMAIL_COST_PER_RECIPIENT_MICRO', 370);
    const rows: PlatformEmailBillingRow[] = raw.map((r) => {
      const costStotinki = emailCostStotinki(r.recipientTotal, costMicro);
      return { ...r, costStotinki, marginStotinki: r.totalStotinki - costStotinki };
    });
    const totals = rows.reduce(
      (acc, r) => ({
        recipientTotal: acc.recipientTotal + r.recipientTotal,
        revenueStotinki: acc.revenueStotinki + r.totalStotinki,
        costStotinki: acc.costStotinki + r.costStotinki,
        marginStotinki: acc.marginStotinki + r.marginStotinki,
      }),
      { recipientTotal: 0, revenueStotinki: 0, costStotinki: 0, marginStotinki: 0 },
    );
    return { rows, totals };
  }

  /**
   * Per-farm Stripe Connect status (only farms that have started connecting —
   * i.e. have a connected-account id). Reads the mirrored capability flags, so
   * no Stripe calls; the `account.updated` webhook keeps them fresh.
   */
  async stripeAccounts(): Promise<PlatformStripeAccountRow[]> {
    const rows = await this.db
      .select({
        tenantId: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        email: tenants.email,
        chargesEnabled: tenants.stripeChargesEnabled,
        payoutsEnabled: tenants.stripePayoutsEnabled,
        detailsSubmitted: tenants.stripeDetailsSubmitted,
        statusUpdatedAt: tenants.stripeStatusUpdatedAt,
      })
      .from(tenants)
      .where(sql`${tenants.stripeAccountId} is not null`)
      .orderBy(asc(tenants.name));
    return rows as PlatformStripeAccountRow[];
  }

  /** Full snapshot of one farm (stats + recent orders) for the detail view. */
  async tenantDetail(id: string): Promise<PlatformTenantDetail> {
    const [t] = await this.db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!t) throw new NotFoundException('Фермата не е намерена');

    // All six aggregates below are independent of each other — run concurrently.
    const oP = this.db
      .select({
        total: sql<number>`count(*)::int`,
        pending: sql<number>`count(*) filter (where ${orders.status} = 'pending')::int`,
        confirmed: sql<number>`count(*) filter (where ${orders.status} = 'confirmed')::int`,
        delivered: sql<number>`count(*) filter (where ${orders.status} = 'delivered')::int`,
        cancelled: sql<number>`count(*) filter (where ${orders.status} = 'cancelled')::int`,
        revenueStotinki: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${orders.status} <> 'cancelled'), 0)::int`,
        lastOrderAt: sql<Date | null>`max(${orders.createdAt})`,
      })
      .from(orders)
      .where(eq(orders.tenantId, id));

    const pP = this.db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${products.isActive})::int`,
      })
      .from(products)
      .where(eq(products.tenantId, id));

    const sP = this.db
      .select({
        active: sql<number>`count(*) filter (where ${newsletterSubscribers.unsubscribedAt} is null)::int`,
        unsubscribed: sql<number>`count(*) filter (where ${newsletterSubscribers.unsubscribedAt} is not null)::int`,
      })
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.tenantId, id));

    const rP = this.db
      .select({
        total: sql<number>`count(*)::int`,
        avgRating: sql<number>`coalesce(round(avg(${reviews.rating}), 1), 0)::float`,
      })
      .from(reviews)
      .where(eq(reviews.tenantId, id));

    const eP = this.db
      .select({
        pushCount: sql<number>`count(*)::int`,
        owedStotinki: sql<number>`coalesce(sum(${emailPushes.priceStotinki}), 0)::int`,
        lastPushAt: sql<Date | null>`max(${emailPushes.createdAt})`,
      })
      .from(emailPushes)
      .where(eq(emailPushes.tenantId, id));

    const recentOrdersP = this.db
      .select({
        id: orders.id,
        customerName: orders.customerName,
        totalStotinki: orders.totalStotinki,
        status: orders.status,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(eq(orders.tenantId, id))
      .orderBy(desc(orders.createdAt))
      .limit(8);

    // Per-farmer breakdown: every producer of this tenant + their login (left
    // join), so a farmer with no login still shows. Carrier connection comes from
    // the settings namespace below; the three count maps attribute products,
    // courier orders and shipments to each farmer.
    const farmersBaseP = this.db
      .select({
        id: farmers.id,
        name: farmers.name,
        role: farmers.role,
        userId: users.id,
        loginEmail: users.email,
        mustChange: users.mustChangePassword,
      })
      .from(farmers)
      .leftJoin(users, and(eq(users.farmerId, farmers.id), eq(users.tenantId, id)))
      .where(eq(farmers.tenantId, id))
      .orderBy(asc(farmers.position), asc(farmers.createdAt));

    const prodByFarmerP = this.db
      .select({ farmerId: products.farmerId, n: sql<number>`count(*)::int` })
      .from(products)
      .where(and(eq(products.tenantId, id), sql`${products.farmerId} is not null`))
      .groupBy(products.farmerId);

    const orderByFarmerP = this.db
      .select({
        farmerId: orders.farmerId,
        n: sql<number>`count(*)::int`,
        revenueStotinki: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${orders.status} <> 'cancelled'), 0)::int`,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, id), sql`${orders.farmerId} is not null`))
      .groupBy(orders.farmerId);

    const shipByFarmerP = this.db
      .select({
        farmerId: shipments.farmerId,
        total: sql<number>`count(*) filter (where ${shipments.status} <> 'draft')::int`,
        drafts: sql<number>`count(*) filter (where ${shipments.status} = 'draft')::int`,
        codPendingStotinki: sql<number>`coalesce(sum(${shipments.codAmountStotinki}) filter (where ${shipments.status} <> 'draft' and ${shipments.codCollectedAt} is null), 0)::int`,
      })
      .from(shipments)
      .where(and(eq(shipments.tenantId, id), sql`${shipments.farmerId} is not null`))
      .groupBy(shipments.farmerId);

    const [[o], [p], [s], [r], [e], recentOrders, farmerRows, prodByFarmer, orderByFarmer, shipByFarmer] =
      await Promise.all([oP, pP, sP, rP, eP, recentOrdersP, farmersBaseP, prodByFarmerP, orderByFarmerP, shipByFarmerP]);

    const settings = (t.settings as Record<string, any> | null) ?? {};
    const econtConfigured = !!settings?.delivery?.econt?.configured;
    const deliveryAccount = deliveryCapabilities(settings).delivery;

    // Merge the per-farmer aggregates + the carrier namespace into one row each.
    const prodMap = new Map(prodByFarmer.map((x) => [x.farmerId, x.n]));
    const orderMap = new Map(orderByFarmer.map((x) => [x.farmerId, x]));
    const shipMap = new Map(shipByFarmer.map((x) => [x.farmerId, x]));
    const farmerNs = (settings?.delivery?.farmers ?? {}) as Record<string, any>;
    const farmerList = farmerRows.map((f) => {
      const ns = farmerNs[f.id] ?? {};
      const om = orderMap.get(f.id);
      const sm = shipMap.get(f.id);
      return {
        id: f.id,
        name: f.name,
        role: f.role,
        hasLogin: !!f.userId,
        loginEmail: f.loginEmail ?? null,
        invitePending: !!f.userId && !!f.mustChange,
        econtConnected: !!ns?.econt?.configured,
        speedyConnected: !!ns?.speedy?.configured,
        products: prodMap.get(f.id) ?? 0,
        courierOrders: om?.n ?? 0,
        courierRevenueStotinki: om?.revenueStotinki ?? 0,
        shipments: sm?.total ?? 0,
        draftShipments: sm?.drafts ?? 0,
        codPendingStotinki: sm?.codPendingStotinki ?? 0,
      };
    });

    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      email: t.email,
      phone: t.phone,
      subscriptionStatus: t.subscriptionStatus,
      premium: t.premium,
      graceUntil: t.graceUntil,
      createdAt: t.createdAt,
      deliveryEnabled: t.deliveryEnabled,
      deliveriesPackageEnabled: t.deliveriesPackageEnabled,
      multiFarmer: t.multiFarmer,
      multiSubcat: t.multiSubcat,
      econtConfigured,
      deliveryAccount,
      stripeConnected: !!t.stripeAccountId,
      siteUrl: sanitizeSiteUrl(settings.siteUrl),
      orders: o,
      products: p,
      subscribers: s,
      reviews: r,
      emailUsage: e,
      recentOrders,
      farmers: farmerList,
    };
  }

  /**
   * Every farmer (producer) across ALL tenants — the super-admin cross-tenant
   * directory. Keyset-paginated newest-first; the per-page count maps attribute
   * products / courier orders / shipments to each farmer (scoped to the page's
   * ids, like listDeliveryAccounts), and carriers come from the farmer's tenant
   * settings namespace. Search + sort stay client-side over the drained list.
   */
  async listAllFarmers(
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<Paginated<GlobalFarmerRow>> {
    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;

    const base = this.db
      .select({
        id: farmers.id,
        name: farmers.name,
        role: farmers.role,
        createdAt: farmers.createdAt,
        tenantId: tenants.id,
        tenantName: tenants.name,
        tenantSlug: tenants.slug,
        isDemo: tenants.isDemo,
        settings: tenants.settings,
        userId: users.id,
        loginEmail: users.email,
        mustChange: users.mustChangePassword,
        [KEYSET_TS]: cursorTs(farmers.createdAt),
      })
      .from(farmers)
      .innerJoin(tenants, eq(farmers.tenantId, tenants.id))
      .leftJoin(users, and(eq(users.farmerId, farmers.id), eq(users.tenantId, farmers.tenantId)));

    const scoped = cur ? base.where(keysetAfter(farmers.createdAt, farmers.id, cur, 'desc')) : base;
    const rows = await scoped.orderBy(desc(farmers.createdAt), desc(farmers.id)).limit(lim + 1);

    const page = buildKeysetPage(rows, lim);
    const ids = page.items.map((r) => r.id);

    const [prodCounts, orderCounts, shipCounts] = ids.length
      ? await Promise.all([
          this.db
            .select({ farmerId: products.farmerId, n: sql<number>`count(*)::int` })
            .from(products)
            .where(inArray(products.farmerId, ids))
            .groupBy(products.farmerId),
          this.db
            .select({ farmerId: orders.farmerId, n: sql<number>`count(*)::int` })
            .from(orders)
            .where(inArray(orders.farmerId, ids))
            .groupBy(orders.farmerId),
          this.db
            .select({
              farmerId: shipments.farmerId,
              total: sql<number>`count(*) filter (where ${shipments.status} <> 'draft')::int`,
              drafts: sql<number>`count(*) filter (where ${shipments.status} = 'draft')::int`,
              codPendingStotinki: sql<number>`coalesce(sum(${shipments.codAmountStotinki}) filter (where ${shipments.status} <> 'draft' and ${shipments.codCollectedAt} is null), 0)::int`,
            })
            .from(shipments)
            .where(inArray(shipments.farmerId, ids))
            .groupBy(shipments.farmerId),
        ])
      : [[], [], []];

    const prodMap = new Map(prodCounts.map((x) => [x.farmerId, x.n]));
    const orderMap = new Map(orderCounts.map((x) => [x.farmerId, x.n]));
    const shipMap = new Map(shipCounts.map((x) => [x.farmerId, x]));

    const items: GlobalFarmerRow[] = page.items.map((r) => {
      const ns = ((r.settings as any)?.delivery?.farmers?.[r.id] ?? {}) as Record<string, any>;
      const sm = shipMap.get(r.id);
      return {
        id: r.id,
        name: r.name,
        role: r.role,
        tenantId: r.tenantId,
        tenantName: r.tenantName,
        tenantSlug: r.tenantSlug,
        isDemo: !!r.isDemo,
        hasLogin: !!r.userId,
        loginEmail: r.loginEmail ?? null,
        invitePending: !!r.userId && !!r.mustChange,
        econtConnected: !!ns?.econt?.configured,
        speedyConnected: !!ns?.speedy?.configured,
        products: prodMap.get(r.id) ?? 0,
        courierOrders: orderMap.get(r.id) ?? 0,
        shipments: sm?.total ?? 0,
        draftShipments: sm?.drafts ?? 0,
        codPendingStotinki: sm?.codPendingStotinki ?? 0,
        createdAt: r.createdAt,
      };
    });

    return { items, nextCursor: page.nextCursor };
  }

  /**
   * Cross-tenant delivery operations snapshot: one aggregate over all shipments
   * (status breakdown + COD pending/collected/settled/outstanding) plus the list
   * of farmers sitting on un-finalized courier DRAFTS (oldest first) — i.e. orders
   * that came in but where no товарителница has been created yet.
   */
  async deliveryOps(): Promise<DeliveryOpsSummary> {
    const [agg] = await this.db
      .select({
        total: sql<number>`count(*) filter (where ${shipments.status} <> 'draft')::int`,
        drafts: sql<number>`count(*) filter (where ${shipments.status} = 'draft')::int`,
        created: sql<number>`count(*) filter (where ${shipments.status} = 'created')::int`,
        shipped: sql<number>`count(*) filter (where ${shipments.status} = 'shipped')::int`,
        delivered: sql<number>`count(*) filter (where ${shipments.status} = 'delivered')::int`,
        returned: sql<number>`count(*) filter (where ${shipments.status} = 'returned')::int`,
        refused: sql<number>`count(*) filter (where ${shipments.status} = 'refused')::int`,
        pendingStotinki: sql<number>`coalesce(sum(${shipments.codAmountStotinki}) filter (where ${shipments.status} not in ('draft','returned','refused','cancelled') and ${shipments.codCollectedAt} is null and ${shipments.codSettledAt} is null), 0)::int`,
        collectedStotinki: sql<number>`coalesce(sum(${shipments.codAmountStotinki}) filter (where ${shipments.codCollectedAt} is not null or ${shipments.codSettledAt} is not null), 0)::int`,
        settledStotinki: sql<number>`coalesce(sum(${shipments.codAmountStotinki}) filter (where ${shipments.codSettledAt} is not null), 0)::int`,
        outstandingStotinki: sql<number>`coalesce(sum(${shipments.codAmountStotinki}) filter (where ${shipments.codCollectedAt} is not null and ${shipments.codSettledAt} is null), 0)::int`,
      })
      .from(shipments);

    const stuckDrafts = (await this.db
      .select({
        farmerId: shipments.farmerId,
        farmerName: farmers.name,
        tenantId: tenants.id,
        tenantName: tenants.name,
        count: sql<number>`count(*)::int`,
        oldestAt: sql<Date | null>`min(${shipments.createdAt})`,
      })
      .from(shipments)
      .innerJoin(farmers, eq(shipments.farmerId, farmers.id))
      .innerJoin(tenants, eq(shipments.tenantId, tenants.id))
      .where(eq(shipments.status, 'draft'))
      .groupBy(shipments.farmerId, farmers.name, tenants.id, tenants.name)
      .orderBy(sql`min(${shipments.createdAt}) asc`)
      .limit(20)) as DeliveryOpsSummary['stuckDrafts'];

    return {
      shipments: {
        total: agg?.total ?? 0,
        drafts: agg?.drafts ?? 0,
        created: agg?.created ?? 0,
        shipped: agg?.shipped ?? 0,
        delivered: agg?.delivered ?? 0,
        returned: agg?.returned ?? 0,
        refused: agg?.refused ?? 0,
      },
      cod: {
        pendingStotinki: agg?.pendingStotinki ?? 0,
        collectedStotinki: agg?.collectedStotinki ?? 0,
        settledStotinki: agg?.settledStotinki ?? 0,
        outstandingStotinki: agg?.outstandingStotinki ?? 0,
      },
      stuckDrafts,
    };
  }

  /** One farmer's super-admin detail — base + login + carriers, the delivery/order
   *  counts, COD totals, and recent shipments/orders. 404 if the farmer is gone. */
  async farmerDetail(farmerId: string): Promise<FarmerDetail> {
    const [base] = await this.db
      .select({
        id: farmers.id,
        name: farmers.name,
        role: farmers.role,
        tier: farmers.tier,
        tenantId: tenants.id,
        tenantName: tenants.name,
        tenantSlug: tenants.slug,
        settings: tenants.settings,
        userId: users.id,
        loginEmail: users.email,
        mustChange: users.mustChangePassword,
      })
      .from(farmers)
      .innerJoin(tenants, eq(farmers.tenantId, tenants.id))
      .leftJoin(users, and(eq(users.farmerId, farmers.id), eq(users.tenantId, farmers.tenantId)))
      .where(eq(farmers.id, farmerId))
      .limit(1);
    if (!base) throw new NotFoundException('Фермерът не е намерен');

    const prodP = this.db.select({ n: sql<number>`count(*)::int` }).from(products).where(eq(products.farmerId, farmerId));
    const orderCountP = this.db.select({ n: sql<number>`count(*)::int` }).from(orders).where(eq(orders.farmerId, farmerId));
    const shipAggP = this.db
      .select({
        total: sql<number>`count(*) filter (where ${shipments.status} <> 'draft')::int`,
        drafts: sql<number>`count(*) filter (where ${shipments.status} = 'draft')::int`,
        pendingStotinki: sql<number>`coalesce(sum(${shipments.codAmountStotinki}) filter (where ${shipments.status} not in ('draft','returned','refused','cancelled') and ${shipments.codCollectedAt} is null and ${shipments.codSettledAt} is null), 0)::int`,
        collectedStotinki: sql<number>`coalesce(sum(${shipments.codAmountStotinki}) filter (where ${shipments.codCollectedAt} is not null or ${shipments.codSettledAt} is not null), 0)::int`,
      })
      .from(shipments)
      .where(eq(shipments.farmerId, farmerId));
    const recentShipP = this.db
      .select({
        id: shipments.id,
        receiverName: shipments.receiverName,
        carrier: shipments.carrier,
        status: shipments.status,
        codAmountStotinki: shipments.codAmountStotinki,
        trackingNumber: shipments.trackingNumber,
        createdAt: shipments.createdAt,
      })
      .from(shipments)
      .where(eq(shipments.farmerId, farmerId))
      .orderBy(desc(shipments.createdAt))
      .limit(20);
    const recentOrdP = this.db
      .select({
        id: orders.id,
        customerName: orders.customerName,
        totalStotinki: orders.totalStotinki,
        status: orders.status,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(eq(orders.farmerId, farmerId))
      .orderBy(desc(orders.createdAt))
      .limit(10);

    // Lean product list for the super-admin «Хит» toggle grid — active (non-deleted),
    // farmer's own display order.
    const productRowsP = this.db
      .select({
        id: products.id,
        name: products.name,
        imageUrl: products.imageUrl,
        featured: products.featured,
      })
      .from(products)
      .where(and(eq(products.farmerId, farmerId), isNull(products.deletedAt)))
      .orderBy(asc(products.position), asc(products.createdAt))
      .limit(200);

    const [[prod], [orderCount], [shipAgg], recentShipments, recentOrders, productRows] = await Promise.all([
      prodP,
      orderCountP,
      shipAggP,
      recentShipP,
      recentOrdP,
      productRowsP,
    ]);

    const ns = ((base.settings as any)?.delivery?.farmers?.[base.id] ?? {}) as Record<string, any>;
    // «Фермер на седмицата» pointer already lives on the tenant row we loaded above
    // (base.settings) — no extra query needed.
    const fow = (base.settings as { farmerOfWeek?: { farmerId?: string } } | null)?.farmerOfWeek;
    const isFarmerOfWeek = fow?.farmerId === base.id;
    return {
      id: base.id,
      name: base.name,
      role: base.role,
      tenantId: base.tenantId,
      tenantName: base.tenantName,
      tenantSlug: base.tenantSlug,
      hasLogin: !!base.userId,
      loginEmail: base.loginEmail ?? null,
      invitePending: !!base.userId && !!base.mustChange,
      econtConnected: !!ns?.econt?.configured,
      speedyConnected: !!ns?.speedy?.configured,
      tier: base.tier,
      isFarmerOfWeek,
      products: productRows,
      counts: {
        products: prod?.n ?? 0,
        courierOrders: orderCount?.n ?? 0,
        shipments: shipAgg?.total ?? 0,
        draftShipments: shipAgg?.drafts ?? 0,
      },
      cod: { pendingStotinki: shipAgg?.pendingStotinki ?? 0, collectedStotinki: shipAgg?.collectedStotinki ?? 0 },
      recentShipments: recentShipments as FarmerDetail['recentShipments'],
      recentOrders: recentOrders as FarmerDetail['recentOrders'],
    };
  }

  /**
   * Recent audit-log rows across ALL tenants, enriched with the actor (platform
   * admin / farmer user / system) and tenant name. Keyset-paginated newest-first.
   * Defaults to mutations only (POST/PATCH/PUT/DELETE) — GET request noise would
   * otherwise drown the signal; pass mutationsOnly=false for the raw stream.
   */
  async listAuditLogs(
    opts: { cursor?: string; limit?: number; mutationsOnly?: boolean; tenantId?: string; farmerId?: string } = {},
  ): Promise<Paginated<AuditLogRow>> {
    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    const mutationsOnly = opts.mutationsOnly !== false;

    const conds = [];
    if (mutationsOnly) conds.push(sql`${auditLogs.action} <> 'GET'`);
    // Drill-down filters (super-admin audit viewer): scope to one farm or one producer.
    if (opts.tenantId) conds.push(eq(auditLogs.tenantId, opts.tenantId));
    if (opts.farmerId) conds.push(eq(auditLogs.farmerId, opts.farmerId));
    if (cur) conds.push(keysetAfter(auditLogs.createdAt, auditLogs.id, cur, 'desc'));

    const baseQ = this.db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        path: auditLogs.path,
        statusCode: auditLogs.statusCode,
        createdAt: auditLogs.createdAt,
        userEmail: users.email,
        adminEmail: platformAdmins.email,
        tenantId: auditLogs.tenantId,
        tenantName: tenants.name,
        [KEYSET_TS]: cursorTs(auditLogs.createdAt),
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .leftJoin(platformAdmins, eq(auditLogs.adminId, platformAdmins.id))
      .leftJoin(tenants, eq(auditLogs.tenantId, tenants.id));

    const scoped = conds.length ? baseQ.where(and(...conds)) : baseQ;
    const rows = await scoped.orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(lim + 1);

    const page = buildKeysetPage(rows, lim);
    const items: AuditLogRow[] = page.items.map((r) => ({
      id: r.id,
      action: r.action,
      path: r.path,
      statusCode: r.statusCode,
      createdAt: r.createdAt,
      actorType: r.adminEmail ? 'admin' : r.userEmail ? 'user' : 'system',
      actorEmail: r.adminEmail ?? r.userEmail ?? null,
      tenantId: r.tenantId,
      tenantName: r.tenantName,
    }));
    return { items, nextCursor: page.nextCursor };
  }

  /**
   * Mint a one-click SSO link that opens the farmer's „Доставки" app AS that
   * farmer — for super-admin support/debug. Reuses the proven, DB-scoped delivery
   * handoff (120s TTL, signed) so no new auth surface is introduced, and writes an
   * explicit audit row (who impersonated whom). 400 if the farmer has no login.
   */
  async impersonate(farmerId: string, adminId: string): Promise<{ url: string }> {
    const [u] = await this.db
      .select({ id: users.id, tenantId: users.tenantId, farmerId: users.farmerId })
      .from(users)
      .where(eq(users.farmerId, farmerId))
      .limit(1);
    if (!u?.id || !u.tenantId) throw new BadRequestException('Фермерът няма акаунт за вход');

    const { token } = await this.auth.issueDeliveryHandoff(u.id, u.tenantId, u.farmerId ?? undefined);
    await this.db.insert(auditLogs).values({
      adminId,
      tenantId: u.tenantId,
      action: 'IMPERSONATE',
      path: `/platform/impersonate/${farmerId}`,
      statusCode: 200,
    });

    const base = this.config.get<string>('DELIVERY_URL') ?? 'https://dostavki.fermeribg.com';
    return { url: `${base}/api/session/handoff?token=${encodeURIComponent(token)}` };
  }

  /**
   * Mint a one-click SSO link that opens the farm's FULL farmer panel AS its owner —
   * for super-admin support/debug. Resolves the tenant's owner (role='admin'), mints a
   * short-TTL panel handoff carrying the acting admin id, audit-logs it, and returns the
   * client-app handoff URL. 400 if the farm has no owner login.
   */
  async impersonatePanel(tenantId: string, adminId: string): Promise<{ url: string }> {
    const [owner] = await this.db
      .select({ id: users.id, tokenVersion: users.tokenVersion })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.role, 'admin')))
      .limit(1);
    if (!owner?.id) throw new BadRequestException('Фермата няма собственик за вход');

    const { token } = await this.auth.issuePanelHandoff(adminId, owner.id, tenantId);
    await this.db.insert(auditLogs).values({
      adminId,
      tenantId,
      action: 'IMPERSONATE_PANEL',
      path: `/platform/impersonate-panel/${tenantId}`,
      statusCode: 200,
    });

    // PUBLIC_APP_URL is the established, validated env var for the farmer-panel
    // origin (see env.validation.ts) — not a new CLIENT_URL.
    const panelBase = this.config.get<string>('PUBLIC_APP_URL') ?? 'https://app.fermeribg.com';
    return { url: `${panelBase}/api/session/handoff?token=${encodeURIComponent(token)}` };
  }

  /** Toggle a farm's subscription (active/inactive). */
  async setStatus(id: string, status: 'active' | 'inactive') {
    const [row] = await this.db
      .update(tenants)
      .set({ subscriptionStatus: status })
      .where(eq(tenants.id, id))
      .returning({ id: tenants.id, subscriptionStatus: tenants.subscriptionStatus });
    if (!row) throw new NotFoundException('Фермата не е намерена');
    return row;
  }

  /** Toggle a farm's premium (free) plan — cancels any Stripe subscription. */
  async setPremium(id: string, premium: boolean): Promise<{ id: string; premium: boolean }> {
    await this.billing.setPremium(id, premium);
    return { id, premium };
  }

  /** Look up a farmer's tenant id + slug (for cache busting). */
  private async farmerTenant(id: string): Promise<{ tenantId: string; slug: string }> {
    const [row] = await this.db
      .select({ tenantId: farmers.tenantId, slug: tenants.slug })
      .from(farmers)
      .innerJoin(tenants, eq(farmers.tenantId, tenants.id))
      .where(eq(farmers.id, id))
      .limit(1);
    if (!row?.tenantId || !row.slug) throw new NotFoundException('Фермерът не е намерен');
    return { tenantId: row.tenantId, slug: row.slug };
  }

  /** Mark/unmark a product as „Хит" (products.featured) for the marketplace curation
   *  screen. Busts the product catalog cache (`catalog:{tenantId}`, owned by
   *  CatalogCacheService — the same one ProductsService.findPublicBySlug reads; there
   *  is no `publicCacheKeys.products` builder) and the assembled bootstrap bundle. */
  async setProductFeatured(id: string, featured: boolean): Promise<{ id: string; featured: boolean }> {
    const [row] = await this.db
      .update(products)
      .set({ featured })
      .where(eq(products.id, id))
      .returning({ id: products.id, featured: products.featured, tenantId: products.tenantId });
    if (!row) throw new NotFoundException('Продуктът не е намерен');
    if (row.tenantId) {
      const [t] = await this.db
        .select({ slug: tenants.slug })
        .from(tenants)
        .where(eq(tenants.id, row.tenantId))
        .limit(1);
      await this.catalogCache.invalidate(row.tenantId);
      if (t?.slug) await this.publicCache.del(publicCacheKeys.bootstrap(t.slug));
    }
    return { id: row.id, featured: row.featured };
  }

  /** Assign a farmer's marketplace ranking tier (1..3). Busts the farmers list
   *  cache + bootstrap bundle for the farmer's tenant. */
  async setFarmerTier(id: string, tier: number): Promise<{ id: string; tier: number }> {
    const { tenantId, slug } = await this.farmerTenant(id);
    const [row] = await this.db
      .update(farmers)
      .set({ tier })
      .where(eq(farmers.id, id))
      .returning({ id: farmers.id, tier: farmers.tier });
    if (!row) throw new NotFoundException('Фермерът не е намерен');
    await this.publicCache.del(publicCacheKeys.farmers(tenantId), publicCacheKeys.bootstrap(slug));
    return { id: row.id, tier: row.tier };
  }

  /** Make (or clear) this farmer as their tenant's «Фермер на седмицата»
   *  (settings.farmerOfWeek — write path; resolveFarmerOfWeek validates it at read
   *  time). Busts the tenant profile cache + bootstrap bundle. */
  async setFarmerOfWeek(id: string, enabled: boolean): Promise<{ id: string; farmerOfWeek: string | null }> {
    const { tenantId, slug } = await this.farmerTenant(id);
    const value = enabled ? JSON.stringify({ farmerId: id }) : 'null';
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['farmerOfWeek'], ${value}::jsonb, true)`,
      })
      .where(eq(tenants.id, tenantId));
    await this.publicCache.del(publicCacheKeys.tenant(slug), publicCacheKeys.bootstrap(slug));
    return { id, farmerOfWeek: enabled ? id : null };
  }

  /** Activate/deactivate a standalone Econt account (one-time payment gate). */
  async setEcontAppActive(tenantId: string, active: boolean): Promise<{ id: string; active: boolean }> {
    const [t] = await this.db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!t) throw new NotFoundException('Акаунтът не е намерен');
    await this.db
      .update(tenants)
      .set({ settings: withEcontActive(t.settings, active) })
      .where(eq(tenants.id, tenantId));
    return { id: tenantId, active };
  }

  /** Super-admin list of delivery-capable tenants (those with an econtApp settings
   *  block), each with a folded shipment/COD overview. Keyset-paginated like
   *  listTenants. Not cached — single-operator, low-traffic, must reflect toggles
   *  immediately. One shipments query for the whole page (no N+1). */
  async listDeliveryAccounts(
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<Paginated<DeliveryAccountRow>> {
    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    const econtFilter = sql`${tenants.settings} -> 'econtApp' is not null`;
    const where = cur
      ? and(econtFilter, keysetAfter(tenants.createdAt, tenants.id, cur, 'asc'))
      : econtFilter;

    const rows = await this.db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        email: tenants.email,
        phone: tenants.phone,
        settings: tenants.settings,
        isDemo: tenants.isDemo,
        createdAt: tenants.createdAt,
        [KEYSET_TS]: cursorTs(tenants.createdAt),
      })
      .from(tenants)
      .where(where)
      .orderBy(asc(tenants.createdAt), asc(tenants.id))
      .limit(lim + 1);

    const page = buildKeysetPage(rows, lim);

    const ids = page.items.map((r) => r.id);
    const ship = ids.length
      ? await this.db
          .select({
            tenantId: shipments.tenantId,
            carrier: shipments.carrier,
            status: shipments.status,
            codAmountStotinki: shipments.codAmountStotinki,
            codCollectedAt: shipments.codCollectedAt,
            codSettledAt: shipments.codSettledAt,
            createdAt: shipments.createdAt,
          })
          .from(shipments)
          // Exclude courier DRAFTS — un-dispatched parcels carry a COD amount + the
          // 'econt' carrier placeholder but aren't real shipments yet; counting them
          // inflates the operator's Econt shipment + pending-COD totals.
          .where(and(inArray(shipments.tenantId, ids), ne(shipments.status, 'draft')))
      : [];

    const byTenant = new Map<string, typeof ship>();
    for (const s of ship) {
      if (!s.tenantId) continue;
      const arr = byTenant.get(s.tenantId) ?? [];
      arr.push(s);
      byTenant.set(s.tenantId, arr);
    }

    const items: DeliveryAccountRow[] = page.items.map((r) => {
      const caps = deliveryCapabilities(r.settings);
      return {
        id: r.id,
        name: r.name,
        slug: r.slug,
        email: r.email,
        phone: r.phone,
        type: caps.type,
        active: caps.active,
        isDemo: !!r.isDemo,
        createdAt: r.createdAt,
        overview: buildDeliveryOverview(byTenant.get(r.id) ?? []),
      };
    });

    return { items, nextCursor: page.nextCursor };
  }

  /** One delivery account: overview over ALL its shipments + the last 20 for a
   *  read-only recent list. 404 if the tenant is missing or not delivery-capable. */
  async getDeliveryAccount(tenantId: string): Promise<DeliveryAccountDetail> {
    const [t] = await this.db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        email: tenants.email,
        phone: tenants.phone,
        settings: tenants.settings,
        isDemo: tenants.isDemo,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const caps = t ? deliveryCapabilities(t.settings) : null;
    if (!t || !caps?.delivery) throw new NotFoundException('Акаунтът не е намерен');

    const ship = await this.db
      .select({
        id: shipments.id,
        receiverName: shipments.receiverName,
        carrier: shipments.carrier,
        status: shipments.status,
        codAmountStotinki: shipments.codAmountStotinki,
        codCollectedAt: shipments.codCollectedAt,
        codSettledAt: shipments.codSettledAt,
        createdAt: shipments.createdAt,
        trackingNumber: shipments.trackingNumber,
        econtShipmentNumber: shipments.econtShipmentNumber,
      })
      .from(shipments)
      // Exclude courier drafts (un-dispatched; placeholder carrier/COD) from the overview.
      .where(and(eq(shipments.tenantId, tenantId), ne(shipments.status, 'draft')));

    const recentShipments = [...ship]
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
      .slice(0, 20);

    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      email: t.email,
      phone: t.phone,
      type: caps.type,
      active: caps.active,
      isDemo: !!t.isDemo,
      createdAt: t.createdAt,
      overview: buildDeliveryOverview(ship),
      recentShipments,
    };
  }

  /** Full paginated shipment history for ONE delivery account — the "load more"
   *  source behind getDeliveryAccount's last-20 recent list. Newest-first, keyset
   *  by (createdAt, id) like the orders list. Scoped strictly to :tenantId (the
   *  super-admin is cross-tenant, but each call serves only the requested account).
   *  Includes BOTH order-linked and order-less/manual shipments — the single
   *  tenant_id filter naturally covers both, exactly as getDeliveryAccount does.
   *  404 if the tenant is missing or not delivery-capable (same guard). */
  async listDeliveryShipments(
    tenantId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<Paginated<DeliveryShipmentRow>> {
    const [t] = await this.db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const caps = t ? deliveryCapabilities(t.settings) : null;
    if (!t || !caps?.delivery) throw new NotFoundException('Акаунтът не е намерен');

    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    // Exclude courier drafts (un-dispatched) from the operator's shipment list.
    const notDraft = ne(shipments.status, 'draft');
    const where = cur
      ? and(eq(shipments.tenantId, tenantId), notDraft, keysetAfter(shipments.createdAt, shipments.id, cur, 'desc'))
      : and(eq(shipments.tenantId, tenantId), notDraft);

    const rows = (await this.db
      .select({
        id: shipments.id,
        receiverName: shipments.receiverName,
        carrier: shipments.carrier,
        status: shipments.status,
        codAmountStotinki: shipments.codAmountStotinki,
        codCollectedAt: shipments.codCollectedAt,
        codSettledAt: shipments.codSettledAt,
        createdAt: shipments.createdAt,
        trackingNumber: shipments.trackingNumber,
        econtShipmentNumber: shipments.econtShipmentNumber,
        [KEYSET_TS]: cursorTs(shipments.createdAt),
      })
      .from(shipments)
      .where(where)
      .orderBy(desc(shipments.createdAt), desc(shipments.id))
      .limit(lim + 1)) as Array<DeliveryShipmentRow & { [KEYSET_TS]: string }>;

    return buildKeysetPage(rows, lim);
  }

  /** Super-admin-driven account creation. Capabilities pick the settings shape:
   *  delivery-only → econt-standalone; shop-only → farm; both → farm + econtApp.
   *  No password is set — the admin user gets a RANDOM unusable hash and
   *  mustChangePassword=true; onboarding completes via a 7-day set-password
   *  ("invite") link, emailed to the account and returned ONCE so the operator can
   *  also share it (Viber etc.). The invitee opens it and sets their own password. */
  async createDeliveryAccount(
    dto: CreateDeliveryAccountDto,
  ): Promise<{ id: string; name: string; slug: string; email: string; inviteLink: string }> {
    if (!dto.shop && !dto.delivery) throw new BadRequestException('Изберете поне една роля');

    const email = dto.email.trim().toLowerCase();
    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    if (existing.length) throw new ConflictException('Имейлът вече е зает');

    const slug = await this.uniqueSlug(dto.name);
    const active = dto.active !== false; // default true

    let settings: Record<string, unknown>;
    if (dto.delivery && !dto.shop) settings = withEcontActive(econtTenantSettings(), active);
    else if (dto.shop && !dto.delivery) settings = farmDefaultSettings();
    else settings = { ...farmDefaultSettings(), econtApp: { active } };

    // No real password is ever set on create: hash a random throwaway (never
    // disclosed) so the column is non-null, and force a change. The invitee sets
    // their actual password via the invite link below. Hash outside the txn
    // (CPU-bound), then create tenant + user atomically so a failed user insert
    // can't leave an orphaned delivery tenant behind.
    const passwordHash = await argon2.hash(randomBytes(24).toString('hex'));
    const created = await this.db.transaction(async (tx) => {
      const [t] = await tx
        .insert(tenants)
        .values({
          name: dto.name,
          slug,
          phone: dto.phone,
          email,
          subscriptionStatus: 'active',
          subscriptionSince: new Date(),
          // Demo account → carriers run on their demo environments (derived from
          // this flag in econt/speedy services), never creating real waybills.
          isDemo: dto.demo === true,
          // Storefront delivery toggle only matters for shop accounts.
          deliveryEnabled: dto.shop,
          settings,
        })
        .returning();

      const [u] = await tx
        .insert(users)
        .values({
          tenantId: t.id,
          email,
          passwordHash,
          role: 'admin',
          mustChangePassword: true,
        })
        .returning({ id: users.id });
      return { tenant: t, userId: u.id };
    });

    const { link } = await this.auth.issueInvite(created.userId, {
      appUrl: this.deliveryPublicUrl(),
      email: true,
    });

    return {
      id: created.tenant.id,
      name: created.tenant.name,
      slug: created.tenant.slug,
      email: created.tenant.email ?? email,
      inviteLink: link,
    };
  }

  /** Re-mint + re-email the set-password invite for a delivery account's admin
   *  user (e.g. the first link expired or never arrived). 404 if the tenant is
   *  missing or not delivery-capable. Returns the fresh link so the operator can
   *  also copy/share it. */
  async resendDeliveryInvite(tenantId: string): Promise<{ inviteLink: string }> {
    const [t] = await this.db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const caps = t ? deliveryCapabilities(t.settings) : null;
    if (!t || !caps?.delivery) throw new NotFoundException('Акаунтът не е намерен');

    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.role, 'admin')))
      .limit(1);
    if (!user) throw new NotFoundException('Акаунтът няма потребител');

    const { link } = await this.auth.issueInvite(user.id, {
      appUrl: this.deliveryPublicUrl(),
      email: true,
    });
    return { inviteLink: link };
  }

  /** "Link" an existing farm to the delivery service by merging an econtApp block
   *  into its settings (additive — all farm keys preserved). Idempotent. */
  async enableDeliveryOnFarm(tenantId: string): Promise<{ id: string; delivery: true }> {
    const [t] = await this.db
      .select({ id: tenants.id, settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!t) throw new NotFoundException('Фермата не е намерена');

    const s = (t.settings ?? {}) as Record<string, any>;
    if (s.econtApp == null) {
      await this.db
        .update(tenants)
        .set({ settings: { ...s, econtApp: { active: true } } })
        .where(eq(tenants.id, tenantId));
    }
    return { id: tenantId, delivery: true };
  }

  /** Reset a farm OWNER's password: mint a fresh temp password, force a change on
   *  next login, and bump the owner's tokenVersion so any live session is revoked.
   *  Targets the tenant's admin (owner) user(s); farmer sub-accounts are untouched.
   *  Returns the plaintext temp password ONCE for the operator to hand over. */
  async resetOwnerPassword(
    id: string,
  ): Promise<{ id: string; name: string; email: string | null; tempPassword: string }> {
    const [t] = await this.db
      .select({ id: tenants.id, name: tenants.name, email: tenants.email })
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);
    if (!t) throw new NotFoundException('Фермата не е намерена');

    const tempPassword = genDemoPassword();
    const passwordHash = await argon2.hash(tempPassword);

    const updated = await this.db
      .update(users)
      .set({
        passwordHash,
        mustChangePassword: true,
        // Revoke old sessions: tokens carry `tv` and are checked on every request.
        tokenVersion: sql`${users.tokenVersion} + 1`,
      })
      .where(and(eq(users.tenantId, id), eq(users.role, 'admin')))
      .returning({ id: users.id });
    if (!updated.length) throw new NotFoundException('Фермата няма собственик');

    return { id, name: t.name, email: t.email, tempPassword };
  }

  /** Edit a farm's core profile + feature flags from the super-admin detail view.
   *  Partial: only the keys present in the DTO are written. */
  async updateTenant(id: string, dto: UpdateTenantDto): Promise<{ id: string }> {
    const [existing] = await this.db
      .select({ id: tenants.id, slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);
    if (!existing) throw new NotFoundException('Фермата не е намерена');

    if (dto.slug !== undefined) {
      const [clash] = await this.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, dto.slug))
        .limit(1);
      if (clash && clash.id !== id) throw new ConflictException('Този slug вече е зает');
    }

    const patch: Partial<typeof tenants.$inferInsert> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.slug !== undefined) patch.slug = dto.slug;
    if (dto.email !== undefined) patch.email = dto.email;
    if (dto.phone !== undefined) patch.phone = dto.phone;
    if (dto.deliveryEnabled !== undefined) patch.deliveryEnabled = dto.deliveryEnabled;
    if (dto.deliveriesPackageEnabled !== undefined)
      patch.deliveriesPackageEnabled = dto.deliveriesPackageEnabled;
    if (dto.multiFarmer !== undefined) patch.multiFarmer = dto.multiFarmer;
    if (dto.multiSubcat !== undefined) patch.multiSubcat = dto.multiSubcat;

    if (Object.keys(patch).length > 0) {
      await this.db.update(tenants).set(patch).where(eq(tenants.id, id));
      // Bust the storefront caches — name/slug/email/phone + the delivery/
      // multiFarmer/multiSubcat toggles all live in the cached public payloads.
      // Mirror TenantsService.updateMe (which busts these on the tenant-side edit);
      // a slug change must also clear the OLD slug key. Toggling multiFarmer/
      // multiSubcat changes whether farmers/subcats return data or [].
      const keys = [
        publicCacheKeys.tenant(existing.slug),
        publicCacheKeys.farmers(id),
        publicCacheKeys.subcategories(id),
      ];
      if (dto.slug !== undefined && dto.slug !== existing.slug) {
        keys.push(publicCacheKeys.tenant(dto.slug));
      }
      await this.publicCache.del(...keys);
    }

    if (dto.siteUrl !== undefined) {
      const siteUrl = sanitizeSiteUrl(dto.siteUrl);
      await this.db
        .update(tenants)
        .set({ settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), array['siteUrl'], ${JSON.stringify(siteUrl)}::jsonb, true)` })
        .where(eq(tenants.id, id));
      await this.publicCache.del(publicCacheKeys.tenant(existing.slug));
    }

    return { id };
  }

  /** Hard-delete a tenant and ALL its data. Demos delete freely (disposable); a
   *  REAL farm requires `confirmSlug` to exactly match its slug — the typed-slug
   *  guard that prevents an accidental wipe of a live shop. This is the only
   *  hard-delete in the system. Deletes children in FK-safe order inside one
   *  transaction, then sweeps the tenant's R2 prefix. */
  async deleteTenant(id: string, confirmSlug?: string): Promise<{ id: string }> {
    const [t] = await this.db
      .select({ id: tenants.id, slug: tenants.slug, isDemo: tenants.isDemo })
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);
    if (!t) throw new NotFoundException('Фермата не е намерена');
    // Real farms are irreversible: demand an exact slug echo as confirmation.
    // Demos stay one-click (the daily cleanup + UI trash both call without a slug).
    if (!t.isDemo && confirmSlug !== t.slug) {
      throw new BadRequestException(
        'За изтриване на истинска ферма въведете точно нейния slug за потвърждение',
      );
    }

    await this.db.transaction(async (tx) => {
      // Clear the self-reference first so deleting products can't violate
      // tenants.product_of_week_id (NO ACTION).
      await tx
        .update(tenants)
        .set({ productOfWeekId: null, productOfWeekEnabled: false })
        .where(eq(tenants.id, id));

      // Order matters: delete children before parents (most FKs are NO ACTION).
      // audit_logs.user_id → users is NO ACTION: audit rows must be removed before users.
      await tx.delete(auditLogs).where(eq(auditLogs.tenantId, id));
      await tx.delete(emailPushes).where(eq(emailPushes.tenantId, id));
      await tx.delete(newsletterCampaigns).where(eq(newsletterCampaigns.tenantId, id));
      // order_items has no tenant_id — scope via its parent orders.
      await tx
        .delete(orderItems)
        .where(sql`${orderItems.orderId} in (select ${orders.id} from ${orders} where ${orders.tenantId} = ${id})`);
      await tx.delete(shipments).where(eq(shipments.tenantId, id)); // before orders (shipments FK → orders)
      await tx.delete(orders).where(eq(orders.tenantId, id));
      await tx.delete(productAvailabilityWindows).where(eq(productAvailabilityWindows.tenantId, id));
      await tx.delete(reviews).where(eq(reviews.tenantId, id));
      await tx.delete(products).where(eq(products.tenantId, id)); // productMedia cascades
      await tx.delete(subcategories).where(eq(subcategories.tenantId, id)); // subcategoryMedia cascades
      await tx.delete(users).where(eq(users.tenantId, id));
      await tx.delete(farmers).where(eq(farmers.tenantId, id)); // farmerMedia cascades
      await tx.delete(articles).where(eq(articles.tenantId, id)); // articleMedia cascades
      await tx.delete(deliverySlots).where(eq(deliverySlots.tenantId, id));
      await tx.delete(contactMessages).where(eq(contactMessages.tenantId, id));
      await tx.delete(newsletterSubscribers).where(eq(newsletterSubscribers.tenantId, id));
      await tx.delete(tenants).where(eq(tenants.id, id));
    });

    // Sweep all R2 objects for this tenant (best-effort; never block the delete).
    try {
      await this.storage.deleteByPrefix(`tenants/${t.slug}/`);
    } catch {
      /* logged by the provider; orphaned objects are harmless */
    }

    // Bust storefront caches (the slug/tenant payloads).
    await this.publicCache.del(
      publicCacheKeys.tenant(t.slug),
      publicCacheKeys.farmers(id),
      publicCacheKeys.subcategories(id),
    );

    return { id };
  }

  /** Daily cleanup: hard-delete every demo whose lifetime has elapsed. Per-tenant
   *  failures are swallowed so one bad row doesn't block the rest. */
  async deleteExpiredDemos(): Promise<{ deleted: number }> {
    const expired = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(sql`${tenants.isDemo} = true and ${tenants.demoExpiresAt} is not null and ${tenants.demoExpiresAt} < now()`);

    let deleted = 0;
    let failed = 0;
    for (const { id } of expired) {
      try {
        await this.deleteTenant(id);
        deleted++;
      } catch (err) {
        failed++;
        this.logger.warn(
          `[cleanup] failed to delete expired demo ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // skip & continue; next run retries
      }
    }
    if (failed) this.logger.warn(`[cleanup] ${failed} expired demo(s) failed to delete`);
    return { deleted };
  }

  /** Onboard a new farm: tenant + owner user with mustChangePassword=true. */
  async createTenant(dto: CreateTenantDto): Promise<{ id: string; name: string; slug: string; email: string }> {
    // Store and match emails lowercased so login (also case-insensitive) can never
    // miss the row, and a case-variant duplicate (Admin@x vs admin@x) is rejected.
    const email = dto.email.trim().toLowerCase();
    // Reject duplicate email
    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    if (existing.length) throw new ConflictException('Имейлът вече е зает');

    const slug = await this.uniqueSlug(dto.farmName);

    const [tenant] = await this.db
      .insert(tenants)
      .values({
        name: dto.farmName,
        slug,
        phone: dto.phone,
        email,
        subscriptionStatus: 'active',
        subscriptionSince: new Date(),
        // Make the shop sellable the moment it goes live: cash-on-delivery + market
        // pickup ON. Seed the brand colour under settings.brand (where the storefront
        // and Контакти read it) when auto-extracted from the logo at onboarding.
        deliveryEnabled: true,
        settings: farmDefaultSettings(dto.themeColor),
      })
      .returning();

    await this.db
      .insert(users)
      .values({
        tenantId: tenant.id,
        email,
        passwordHash: await argon2.hash(dto.tempPassword),
        role: 'admin',
        mustChangePassword: true,
      })
      .returning();

    return { id: tenant.id, name: tenant.name, slug: tenant.slug, email: tenant.email ?? dto.email };
  }

  /** One-click disposable demo: auto creds + fixed seed catalog. Owner can log in
   *  immediately (no forced password change), and the account auto-deletes after
   *  `days` (default 14). Returns the shareable credentials. */
  async createDemoTenant(
    days = 14,
  ): Promise<{ id: string; name: string; slug: string; email: string; password: string; expiresAt: string }> {
    const tag = randomBytes(3).toString('hex'); // 6 hex chars
    const name = `Демо ферма ${tag}`;
    const email = `demo-${tag}@demo.fermeribg.bg`;
    const password = genDemoPassword();

    // Astronomically unlikely with a random tag, but keep the unique-email contract.
    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing.length) throw new ConflictException('Имейлът вече е зает — опитайте пак');

    const slug = await this.uniqueSlug(name);
    const expiresAt = new Date(Date.now() + days * 86_400_000);

    const [tenant] = await this.db
      .insert(tenants)
      .values({
        name,
        slug,
        email,
        subscriptionStatus: 'active',
        subscriptionSince: new Date(),
        deliveryEnabled: true,
        isDemo: true,
        demoExpiresAt: expiresAt,
        settings: farmDefaultSettings(),
      })
      .returning();

    await this.db
      .insert(users)
      .values({
        tenantId: tenant.id,
        email,
        passwordHash: await argon2.hash(password),
        role: 'admin',
        // Demos skip the forced reset so a friend logs straight in with these creds.
        mustChangePassword: false,
      })
      .returning();

    // Seed the sample catalog via the same path super-admin onboarding uses.
    // Deliberately NOT transactional with the inserts above (mirrors createTenant):
    // a mid-seed failure leaves a half-seeded demo, which the hard-delete / daily
    // cleanup reaps — acceptable for a disposable account.
    await this.importTenant(tenant.id, DEMO_SEED);

    return { id: tenant.id, name: tenant.name, slug: tenant.slug, email, password, expiresAt: expiresAt.toISOString() };
  }

  /** Super-admin onboarding seed: bulk-create catalog + contact + favicon for a
   *  tenant by id. Runs as the operator, so it bypasses the new tenant's
   *  mustChangePassword lock (which blocks every owner-side write pre-handoff).
   *  Reuses the tenant-facing create/site-contact/favicon services for the same
   *  validation, slug generation and cache busting as a manual create. */
  async importTenant(
    tenantId: string,
    dto: PlatformImportDto,
  ): Promise<{ products: number; farmers: number; categories: number; contact: boolean; favicon: boolean }> {
    const [tenant] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new NotFoundException('Фермата не е намерена');

    const counts = { products: 0, farmers: 0, categories: 0, contact: false, favicon: false };

    // Categories before products so the farmer can group them afterwards.
    for (const c of dto.categories ?? []) { await this.subcategoriesSvc.create(tenantId, c); counts.categories++; }
    for (const f of dto.farmers ?? []) { await this.farmersSvc.create(tenantId, f); counts.farmers++; }
    for (const p of dto.products ?? []) { await this.productsSvc.create(tenantId, p); counts.products++; }

    if (dto.contact) { await this.tenantsSvc.updateSiteContact(tenantId, dto.contact); counts.contact = true; }
    if (dto.faviconBase64) {
      await this.tenantsSvc.setFavicon(tenantId, { buffer: Buffer.from(dto.faviconBase64, 'base64') } as Express.Multer.File);
      counts.favicon = true;
    }
    return counts;
  }

  /** Platform admin changes own password → fresh token (old sessions revoked). */
  async platformChangePassword(
    adminId: string,
    dto: ChangePasswordDto,
  ): Promise<{ accessToken: string }> {
    const [admin] = await this.db
      .select()
      .from(platformAdmins)
      .where(eq(platformAdmins.id, adminId))
      .limit(1);

    if (!admin || !(await argon2.verify(admin.passwordHash, dto.currentPassword))) {
      throw new UnauthorizedException('Грешна текуща парола');
    }

    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException('Новата парола трябва да е различна от текущата');
    }

    const passwordHash = await argon2.hash(dto.newPassword);
    const [updated] = await this.db
      .update(platformAdmins)
      .set({
        passwordHash,
        mustChangePassword: false,
        // Bump the session epoch so the bootstrap/old token can't be reused.
        tokenVersion: sql`${platformAdmins.tokenVersion} + 1`,
      })
      .where(eq(platformAdmins.id, adminId))
      .returning();

    const payload: JwtPayload = {
      sub: updated.id,
      type: 'platform',
      mustChangePassword: false,
      tv: updated.tokenVersion,
    };
    return { accessToken: this.jwt.sign(payload) };
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base = slugify(name) || 'ferma';
    let slug = base;
    let n = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const hit = await this.db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .limit(1);
      if (!hit.length) return slug;
      n += 1;
      slug = `${base}-${n}`;
    }
  }
}

const CYRILLIC_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's',
  т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht',
  ъ: 'a', ь: 'y', ю: 'yu', я: 'ya',
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .split('')
    .map((ch) => CYRILLIC_MAP[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const DEMO_PW_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
/** 14-char CSPRNG password for a demo owner (server-side; the UI never sees the hash). */
function genDemoPassword(): string {
  const bytes = randomBytes(14);
  let p = '';
  for (let i = 0; i < bytes.length; i++) p += DEMO_PW_CHARS[bytes[i] % DEMO_PW_CHARS.length];
  return p;
}
