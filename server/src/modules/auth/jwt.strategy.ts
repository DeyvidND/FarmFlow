import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { type Database, users, platformAdmins } from '@fermeribg/db';
import { JwtPayload, RequestUser, TenantRole } from '@fermeribg/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @Inject(DB_TOKEN) private readonly db: Database,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      // Pin the accepted algorithm — never let a token dictate verification
      // (rejects `none` and any RS256/HS-confusion attempt). We only ever sign HS256.
      algorithms: ['HS256'],
    });
  }

  async validate(payload: JwtPayload): Promise<RequestUser> {
    // Only tokens that explicitly declare their kind may authenticate. Requiring
    // `type` to be exactly 'platform' or 'tenant' rejects single-purpose tokens
    // (password-reset `type:'reset'`, newsletter unsubscribe `typ:'unsub'`) and
    // any legacy/foreign token that omits `type` — closing the privilege-
    // escalation hole where a type-less token was accepted as an admin tenant.
    if (payload.type === 'platform') {
      // Revocation check: the token's session epoch must match the admin's
      // current tokenVersion (a password change bumps it, killing old tokens).
      // Legacy tokens carry no `tv` → treated as 0, matching freshly-migrated rows.
      const [admin] = await this.db
        .select({ tokenVersion: platformAdmins.tokenVersion })
        .from(platformAdmins)
        .where(eq(platformAdmins.id, payload.sub))
        .limit(1);
      if (!admin || admin.tokenVersion !== (payload.tv ?? 0)) {
        throw new UnauthorizedException();
      }
      return { type: 'platform', adminId: payload.sub };
    }
    if (payload.type === 'tenant') {
      // A real tenant token always carries tenantId (login rejects users with
      // none). A tenant token without it is malformed — refuse rather than mint
      // a session scoped to `undefined`.
      if (!payload.tenantId) {
        throw new UnauthorizedException();
      }
      // Revocation check: re-read tokenVersion fresh from the DB on every
      // request (a password change / revoke bumps it, killing old tokens
      // without waiting for expiry).
      //
      // Task A4: this strategy STOPS selecting/injecting `courierIndex`. Leg
      // ownership is now resolved per-request via
      // CourierAssignmentService.resolveMyLeg(tenantId, userId, date) — a
      // date-scoped lookup against routeCourierAssignments (Task A2) — inside
      // each driver-facing endpoint, which has the `date` in scope. The JWT
      // strategy runs before the route handler/params and has no `date`, so it
      // can no longer answer "which leg am I on?" (that question is inherently
      // per-date now, not a single global binding). `users.courierIndex` was
      // the LAST reader of this field on the auth path (Tasks A1-A3 already
      // migrated getRoute/measure off it) — retiring it here leaves nothing
      // broken. `TenantRequestUser.courierIndex` stays typed-optional in
      // @fermeribg/types; the column itself is dropped in a later, separate PR.
      const [user] = await this.db
        .select({ tokenVersion: users.tokenVersion })
        .from(users)
        .where(eq(users.id, payload.sub))
        .limit(1);
      if (!user || user.tokenVersion !== (payload.tv ?? 0)) {
        throw new UnauthorizedException();
      }
      return {
        type: 'tenant',
        userId: payload.sub,
        tenantId: payload.tenantId,
        role: (payload.role ?? 'admin') as TenantRole,
        ...(payload.farmerId ? { farmerId: payload.farmerId } : {}),
        ...(payload.actingAdminId ? { actingAdminId: payload.actingAdminId } : {}),
      };
    }
    throw new UnauthorizedException();
  }
}
