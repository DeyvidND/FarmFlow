import {
  Injectable,
  Inject,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Database, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../drizzle/drizzle.constants';

/**
 * Blocks tenant features that require an active subscription (route, production,
 * slot creation). Inactive tenants get 403 "Абонаментът е неактивен". Must run
 * after JwtAuthGuard (needs request.user.tenantId).
 */
@Injectable()
export class ActiveSubscriptionGuard implements CanActivate {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const tenantId = req.user?.tenantId;
    if (!tenantId) return true; // not a tenant request — other guards decide

    const [t] = await this.db
      .select({ status: tenants.subscriptionStatus })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (t?.status === 'inactive') {
      throw new ForbiddenException('Абонаментът е неактивен');
    }
    return true;
  }
}
