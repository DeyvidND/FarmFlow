import { Module } from '@nestjs/common';
import { AuthCoreModule } from './auth-core.module';
import { AuthController } from './auth.controller';

/**
 * Full FarmFlow auth module: the controller-less {@link AuthCoreModule} (JWT,
 * strategy, AuthService) plus the `/auth/*` controller. Re-exports AuthCoreModule
 * so existing consumers keep getting `JwtModule` / `PassportModule` / `AuthService`.
 */
@Module({
  imports: [AuthCoreModule],
  controllers: [AuthController],
  exports: [AuthCoreModule],
})
export class AuthModule {}
