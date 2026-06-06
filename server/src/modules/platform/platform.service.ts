import {
  Injectable,
  Inject,
  UnauthorizedException,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { asc, eq, sql, desc } from 'drizzle-orm';
import { BillingService } from '../billing/billing.service';
import {
  type Database,
  tenants,
  users,
  orders,
  platformAdmins,
  emailPushes,
  products,
  newsletterSubscribers,
  reviews,
} from '@farmflow/db';
import type { JwtPayload } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { clampLimit, keysetAfter, buildPage, type Paginated } from '../../common/pagination/keyset';
import { decodeCursor } from '../../common/pagination/cursor';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { ChangePasswordDto } from '../auth/dto/change-password.dto';

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

/** Per-farm email-push usage → what the farm owes the platform (collected manually). */
export interface PlatformEmailBillingRow {
  tenantId: string;
  name: string;
  slug: string;
  email: string | null;
  pushCount: number;
  totalStotinki: number;
  lastPushAt: Date | null;
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
  ) {}

  /** Platform admin login → platform-typed JWT. */
  async login(email: string, password: string): Promise<{ accessToken: string }> {
    const [admin] = await this.db
      .select()
      .from(platformAdmins)
      .where(eq(platformAdmins.email, email))
      .limit(1);

    const invalid = new UnauthorizedException('Грешен имейл или парола');
    if (!admin) throw invalid;
    if (!(await argon2.verify(admin.passwordHash, password))) throw invalid;

    const payload: JwtPayload = { sub: admin.id, type: 'platform' };
    return { accessToken: this.jwt.sign(payload) };
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
  async emailBilling(): Promise<PlatformEmailBillingRow[]> {
    const rows = await this.db
      .select({
        tenantId: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        email: tenants.email,
        pushCount: sql<number>`count(${emailPushes.id})::int`,
        totalStotinki: sql<number>`coalesce(sum(${emailPushes.priceStotinki}), 0)::int`,
        lastPushAt: sql<Date | null>`max(${emailPushes.createdAt})`,
      })
      .from(tenants)
      .innerJoin(emailPushes, eq(emailPushes.tenantId, tenants.id))
      .groupBy(tenants.id)
      .orderBy(sql`sum(${emailPushes.priceStotinki}) desc`);
    return rows as PlatformEmailBillingRow[];
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

    const [o] = await this.db
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

    const [p] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${products.isActive})::int`,
      })
      .from(products)
      .where(eq(products.tenantId, id));

    const [s] = await this.db
      .select({
        active: sql<number>`count(*) filter (where ${newsletterSubscribers.unsubscribedAt} is null)::int`,
        unsubscribed: sql<number>`count(*) filter (where ${newsletterSubscribers.unsubscribedAt} is not null)::int`,
      })
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.tenantId, id));

    const [r] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        avgRating: sql<number>`coalesce(round(avg(${reviews.rating}), 1), 0)::float`,
      })
      .from(reviews)
      .where(eq(reviews.tenantId, id));

    const [e] = await this.db
      .select({
        pushCount: sql<number>`count(*)::int`,
        owedStotinki: sql<number>`coalesce(sum(${emailPushes.priceStotinki}), 0)::int`,
        lastPushAt: sql<Date | null>`max(${emailPushes.createdAt})`,
      })
      .from(emailPushes)
      .where(eq(emailPushes.tenantId, id));

    const recentOrders = await this.db
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
      .select({ id: tenants.id })
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
    }
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

  /** Platform admin changes own password. Returns nothing (204). */
  async platformChangePassword(adminId: string, dto: ChangePasswordDto): Promise<void> {
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
    await this.db
      .update(platformAdmins)
      .set({ passwordHash })
      .where(eq(platformAdmins.id, adminId))
      .returning();
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
