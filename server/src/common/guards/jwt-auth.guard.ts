import { Injectable, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Tenant-side auth: valid JWT required, and platform tokens are rejected — a
 * platform admin must not reach tenant resources.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = any>(err: any, user: any, info: any): TUser {
    const u = super.handleRequest(err, user, info, undefined as any);
    if ((u as { type?: string })?.type === 'platform') {
      throw new ForbiddenException('Платформен достъп няма права тук');
    }
    return u as TUser;
  }
}
