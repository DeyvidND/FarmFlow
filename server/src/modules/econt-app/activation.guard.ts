import { CanActivate, ExecutionContext, Injectable, Inject, ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Database, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { isEcontAccountActive } from './econt-app.helpers';

/** Allow only activated (paid) standalone accounts past. Runs after JwtAuthGuard,
 *  so `request.user.tenantId` is set. */
@Injectable()
export class ActivationGuard implements CanActivate {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const tenantId: string | undefined = req.user?.tenantId;
    if (!tenantId) throw new ForbiddenException('Няма достъп');
    const [row] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!isEcontAccountActive(row?.settings)) {
      throw new ForbiddenException('Активирай акаунта си, за да създаваш товарителници');
    }
    return true;
  }
}
