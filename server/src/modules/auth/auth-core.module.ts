import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

/**
 * Auth providers WITHOUT the controller — so a second app (the standalone Econt
 * service) can reuse AuthService + the JWT strategy/guard without also mounting
 * the FarmFlow `/auth/*` routes. `AuthModule` adds the controller on top of this.
 */
@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '7d', algorithm: 'HS256' },
        // Pin the accepted algorithm for every JwtService.verify().
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  providers: [AuthService, JwtStrategy],
  exports: [JwtModule, PassportModule, AuthService],
})
export class AuthCoreModule {}
