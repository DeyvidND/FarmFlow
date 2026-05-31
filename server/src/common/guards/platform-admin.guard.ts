import { Injectable, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Platform-side auth: valid JWT required AND it must be a platform token. */
@Injectable()
export class PlatformAdminGuard extends AuthGuard('jwt') {
  handleRequest<TUser = any>(err: any, user: any, info: any): TUser {
    const u = super.handleRequest(err, user, info, undefined as any);
    if ((u as { type?: string })?.type !== 'platform') {
      throw new ForbiddenException('Изисква се платформен достъп');
    }
    return u as TUser;
  }
}
