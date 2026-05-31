import { Injectable } from '@nestjs/common';
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
    if (payload.type === 'platform') {
      return { type: 'platform', adminId: payload.sub };
    }
    // Tenant token (or legacy token without `type`).
    return {
      type: 'tenant',
      userId: payload.sub,
      tenantId: payload.tenantId as string,
      role: (payload.role ?? 'admin') as TenantRole,
    };
  }
}
