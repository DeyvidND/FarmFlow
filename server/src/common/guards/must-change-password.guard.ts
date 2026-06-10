import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { JwtPayload } from '@farmflow/types';

/**
 * Global guard that locks a principal out while `mustChangePassword` is true.
 * Reads the JWT header directly so it runs independently of route guards.
 * Errors in JWT parsing → pass-through (let the route guard handle auth).
 *
 * - Platform (super-admin): fully locked — only the endpoints needed to read the
 *   identity and rotate the password are reachable. A leaked/initial password
 *   can do nothing else.
 * - Tenant (farmer): all writes blocked, PLUS reads of customer PII blocked, so a
 *   leaked temporary password can't exfiltrate orders/subscribers/messages. The
 *   panel chrome (`/tenants/me`, `/auth/me`) still loads so the force-change modal
 *   can render.
 */
@Injectable()
export class MustChangePasswordGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  // Customer-PII read surfaces blocked while a temp password is in force.
  private static readonly SENSITIVE_READ = /^\/(orders|subscribers|contact-messages)\b/;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      method: string;
      path: string;
      headers: { authorization?: string };
    }>();

    const authHeader = req.headers.authorization ?? '';
    if (!authHeader.startsWith('Bearer ')) return true;

    const token = authHeader.slice(7);
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(token);
    } catch {
      return true; // invalid token — let the route guard deal with it
    }

    if (payload.mustChangePassword !== true) return true;

    const isPlatform = payload.type === 'platform';

    // Endpoints required to render the change-password screen + perform the change.
    const allowed = isPlatform
      ? ['/platform/me', '/platform/change-password']
      : ['/auth/me', '/auth/change-password', '/tenants/me'];
    if (allowed.includes(req.path)) return true;

    // Platform: nothing else is reachable until the password is rotated.
    if (isPlatform) {
      throw new ForbiddenException('Смени временната си парола, за да продължиш');
    }

    // Tenant: block all mutations and all customer-PII reads.
    if (req.method !== 'GET' || MustChangePasswordGuard.SENSITIVE_READ.test(req.path)) {
      throw new ForbiddenException('Смени временната си парола, за да продължиш');
    }

    return true;
  }
}
