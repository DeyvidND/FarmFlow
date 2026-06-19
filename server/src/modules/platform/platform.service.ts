import {
  Injectable,
  Inject,
  UnauthorizedException,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { asc, eq, sql, desc } from 'drizzle-orm';
import { BillingService } from '../billing/billing.service';
import { emailCostStotinki } from '../billing/billing.pricing';
import { ProductsService } from '../products/products.service';
import { FarmersService } from '../farmers/farmers.service';
import { SubcategoriesService } from '../subcategories/subcategories.service';
import { TenantsService } from '../tenants/tenants.service';
import { StorageService } from '../storage/storage.service';
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
} from '@farmflow/db';
import type { JwtPayload } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService, publicCacheKeys } from '../../common/cache/public-cache.service';
import { clampLimit, keysetAfter, buildPage, type Paginated } from '../../common/pagination/keyset';
import { decodeCursor } from '../../common/pagination/cursor';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { ChangePasswordDto } from '../auth/dto/change-password.dto';
import { sanitizeSiteUrl } from '../tenants/site-copy';
import { DEMO_SEED } from './demo-seed';

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
  multiFarmer: boolean;
  multiSubcat: boolean;
  econtConfigured: boolean;
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
}

@Injectable()
export class PlatformService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly jwt: JwtService,
    private readonly billing: BillingService,
    private readonly publicCache: PublicCacheService,
    private readonly config: ConfigService,
    private readonly productsSvc: ProductsService,
    private readonly farmersSvc: FarmersService,
    private readonly subcategoriesSvc: SubcategoriesService,
    private readonly tenantsSvc: TenantsService,
    private readonly storage: StorageService,
  ) {}

  /** Platform admin login → platform-typed JWT. */
  async login(email: string, password: string): Promise<{ accessToken: string }> {
    const [admin] = await this.db
      .select()
      .from(platformAdmins)
      .where(eq(platformAdmins.email, email))
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

  /** Every farm + order summary (count, last order). One grouped query, keyset-paginated. */
  async listTenants(
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<Paginated<PlatformTenantRow>> {
    const lim = clampLimit(opts.limit);
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
      })
      .from(tenants)
      .leftJoin(orders, eq(orders.tenantId, tenants.id));

    const scoped = cur ? base.where(keysetAfter(tenants.createdAt, tenants.id, cur, 'asc')) : base;

    const rows = (await scoped
      .groupBy(tenants.id)
      .orderBy(asc(tenants.createdAt), asc(tenants.id))
      .limit(lim + 1)) as PlatformTenantRow[];

    return buildPage(rows, lim, (r) => ({ createdAt: r.createdAt!, id: r.id }));
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

    const [[o], [p], [s], [r], [e], recentOrders] = await Promise.all([
      oP,
      pP,
      sP,
      rP,
      eP,
      recentOrdersP,
    ]);

    const settings = (t.settings as Record<string, any> | null) ?? {};
    const econtConfigured = !!settings?.delivery?.econt?.configured;

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
      multiFarmer: t.multiFarmer,
      multiSubcat: t.multiSubcat,
      econtConfigured,
      stripeConnected: !!t.stripeAccountId,
      siteUrl: sanitizeSiteUrl(settings.siteUrl),
      orders: o,
      products: p,
      subscribers: s,
      reviews: r,
      emailUsage: e,
      recentOrders,
    };
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

  /** Hard-delete a DEMO tenant and ALL its data. Refuses non-demo tenants — this is
   *  the only hard-delete in the system, fenced to disposable demos. Deletes children
   *  in FK-safe order inside one transaction, then sweeps the tenant's R2 prefix. */
  async deleteTenant(id: string): Promise<{ id: string }> {
    const [t] = await this.db
      .select({ id: tenants.id, slug: tenants.slug, isDemo: tenants.isDemo })
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);
    if (!t) throw new NotFoundException('Фермата не е намерена');
    if (!t.isDemo) {
      throw new BadRequestException('Само демо акаунти могат да се изтриват напълно');
    }

    await this.db.transaction(async (tx) => {
      // Clear the self-reference first so deleting products can't violate
      // tenants.product_of_week_id (NO ACTION).
      await tx
        .update(tenants)
        .set({ productOfWeekId: null, productOfWeekEnabled: false })
        .where(eq(tenants.id, id));

      // Order matters: delete children before parents (most FKs are NO ACTION).
      await tx.delete(emailPushes).where(eq(emailPushes.tenantId, id));
      await tx.delete(newsletterCampaigns).where(eq(newsletterCampaigns.tenantId, id));
      // order_items has no tenant_id — scope via its parent orders.
      await tx
        .delete(orderItems)
        .where(sql`${orderItems.orderId} in (select ${orders.id} from ${orders} where ${orders.tenantId} = ${id})`);
      await tx.delete(shipments).where(eq(shipments.tenantId, id)); // before orders (shipments.orderId NOT NULL)
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
      await tx.delete(auditLogs).where(eq(auditLogs.tenantId, id));
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

  /** Onboard a new farm: tenant + owner user with mustChangePassword=true. */
  async createTenant(dto: CreateTenantDto): Promise<{ id: string; name: string; slug: string; email: string }> {
    // Reject duplicate email
    const existing = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, dto.email))
      .limit(1);
    if (existing.length) throw new ConflictException('Имейлът вече е зает');

    const slug = await this.uniqueSlug(dto.farmName);

    const [tenant] = await this.db
      .insert(tenants)
      .values({
        name: dto.farmName,
        slug,
        phone: dto.phone,
        email: dto.email,
        subscriptionStatus: 'active',
        subscriptionSince: new Date(),
        // Make the shop sellable the moment it goes live: cash-on-delivery + market
        // pickup ON. Seed the brand colour under settings.brand (where the storefront
        // and Контакти read it) when auto-extracted from the logo at onboarding.
        deliveryEnabled: true,
        settings: {
          ...(dto.themeColor ? { brand: { themeColor: dto.themeColor } } : {}),
          delivery: {
            methods: {
              pickup: { enabled: true },
              ownSlots: { enabled: false },
              econtOffice: { enabled: false },
              econtAddress: { enabled: false },
            },
            cod: { enabled: true },
            card: { enabled: true },
            econt: { mode: 'off' },
          },
        },
      })
      .returning();

    await this.db
      .insert(users)
      .values({
        tenantId: tenant.id,
        email: dto.email,
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
    const email = `demo-${tag}@demo.farmflow.bg`;
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
        settings: {
          delivery: {
            methods: {
              pickup: { enabled: true },
              ownSlots: { enabled: false },
              econtOffice: { enabled: false },
              econtAddress: { enabled: false },
            },
            cod: { enabled: true },
            card: { enabled: true },
            econt: { mode: 'off' },
          },
        },
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
