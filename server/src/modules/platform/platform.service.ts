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
import { eq, sql } from 'drizzle-orm';
import { type Database, tenants, users, orders, platformAdmins } from '@farmflow/db';
import type { JwtPayload } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { ChangePasswordDto } from '../auth/dto/change-password.dto';

export interface PlatformTenantRow {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  subscriptionStatus: 'active' | 'inactive';
  createdAt: Date | null;
  orderCount: number;
  lastOrderAt: Date | null;
}

@Injectable()
export class PlatformService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly jwt: JwtService,
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

  /** Every farm + order summary (count, last order). One grouped query. */
  async listTenants(): Promise<PlatformTenantRow[]> {
    const rows = await this.db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        email: tenants.email,
        phone: tenants.phone,
        subscriptionStatus: tenants.subscriptionStatus,
        createdAt: tenants.createdAt,
        orderCount: sql<number>`count(${orders.id})::int`,
        lastOrderAt: sql<Date | null>`max(${orders.createdAt})`,
      })
      .from(tenants)
      .leftJoin(orders, eq(orders.tenantId, tenants.id))
      .groupBy(tenants.id)
      .orderBy(tenants.createdAt);
    return rows as PlatformTenantRow[];
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
