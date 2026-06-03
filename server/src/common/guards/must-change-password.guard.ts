import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { JwtPayload } from '@farmflow/types';

/**
 * Global guard that blocks tenant writes while mustChangePassword is true.
 * It reads the JWT header directly so it runs independently of route guards.
 * Errors in JWT parsing → pass-through (let the route guard handle auth).
 */
@Injectable()
export class MustChangePasswordGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

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

    // Platform tokens are never subject to this check.
    if (payload.type === 'platform') return true;

    // Only block non-GET mutations when the flag is set.
    if (
      payload.mustChangePassword === true &&
      req.method !== 'GET' &&
      req.path !== '/auth/change-password'
    ) {
      throw new ForbiddenException('Смени временната си парола, за да продължиш');
    }

    return true;
  }
}
