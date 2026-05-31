import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Database, tenants } from '@farmflow/db';
import type { PublicTenant, Tenant } from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { UpdateTenantDto } from './dto/update-tenant.dto';

@Injectable()
export class TenantsService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async getMe(tenantId: string): Promise<PublicTenant> {
    const [row] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!row) throw new NotFoundException('Фермата не е намерена');
    return toPublicTenant(row);
  }

  async updateMe(tenantId: string, dto: UpdateTenantDto): Promise<PublicTenant> {
    const [row] = await this.db
      .update(tenants)
      .set({ ...dto })
      .where(eq(tenants.id, tenantId))
      .returning();
    if (!row) throw new NotFoundException('Фермата не е намерена');
    return toPublicTenant(row);
  }
}

/** Strip internal fields the client should never see. */
function toPublicTenant(t: Tenant): PublicTenant {
  const { stripeAccountId, settings, ...rest } = t;
  return rest;
}
