import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

/**
 * Authorizes the storefront inline-edit overlay. Accepts ONLY a `site-edit`
 * token (separate derived secret, short-lived, tenant-scoped). Sets
 * req.tenantId. This token authenticates nothing else — only the routes that
 * use THIS guard. Mirrors the reset-token isolation.
 */
@Injectable()
export class EditSessionGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ headers: { authorization?: string }; tenantId?: string }>();
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) throw new UnauthorizedException('Липсва edit токен');
    let payload: { sub?: string; type?: string };
    try {
      payload = await this.jwt.verifyAsync(auth.slice(7), {
        secret: `${this.config.getOrThrow<string>('JWT_SECRET')}::siteedit`,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Невалиден или изтекъл edit токен');
    }
    if (payload.type !== 'site-edit' || !payload.sub) {
      throw new UnauthorizedException('Невалиден edit токен');
    }
    req.tenantId = payload.sub;
    return true;
  }
}
