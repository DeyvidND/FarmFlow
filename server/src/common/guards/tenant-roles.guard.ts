import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { JwtPayload, TenantRole } from '@farmflow/types';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Default-deny role guard for tenant tokens. Runs globally and decodes the JWT
 * itself (like MustChangePasswordGuard) so it doesn't depend on guard ordering.
 *
 * Every tenant route requires role `admin` UNLESS a `@Roles(...)` decorator opens
 * it to more roles. Today only `admin` tenant users exist, so this is a no-op now
 * — but it future-proofs the `driver`/`customer` roles already plumbed through the
 * JWT: a new non-admin account can't silently inherit full farm-admin authority.
 *
 * Anonymous (public storefront) and platform requests pass straight through.
 */
@Injectable()
export class TenantRolesGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ headers: { authorization?: string } }>();
    const authHeader = req.headers.authorization ?? '';
    if (!authHeader.startsWith('Bearer ')) return true;

    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(authHeader.slice(7));
    } catch {
      return true; // invalid token — let the route's auth guard reject it
    }

    // Only tenant tokens carry a role to enforce.
    if (payload.type !== 'tenant') return true;

    const allowed =
      this.reflector.getAllAndOverride<TenantRole[]>(ROLES_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? (['admin'] as TenantRole[]);

    const role = (payload.role ?? 'admin') as TenantRole;
    if (!allowed.includes(role)) {
      throw new ForbiddenException('Нямате достъп до това действие');
    }
    return true;
  }
}
