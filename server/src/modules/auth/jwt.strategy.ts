import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { JwtPayload, RequestUser, TenantRole } from '@farmflow/types';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<RequestUser> {
    // Only tokens that explicitly declare their kind may authenticate. Requiring
    // `type` to be exactly 'platform' or 'tenant' rejects single-purpose tokens
    // (password-reset `type:'reset'`, newsletter unsubscribe `typ:'unsub'`) and
    // any legacy/foreign token that omits `type` — closing the privilege-
    // escalation hole where a type-less token was accepted as an admin tenant.
    if (payload.type === 'platform') {
      return { type: 'platform', adminId: payload.sub };
    }
    if (payload.type === 'tenant') {
      // A real tenant token always carries tenantId (login rejects users with
      // none). A tenant token without it is malformed — refuse rather than mint
      // a session scoped to `undefined`.
      if (!payload.tenantId) {
        throw new UnauthorizedException();
      }
      return {
        type: 'tenant',
        userId: payload.sub,
        tenantId: payload.tenantId,
        role: (payload.role ?? 'admin') as TenantRole,
      };
    }
    throw new UnauthorizedException();
  }
}
