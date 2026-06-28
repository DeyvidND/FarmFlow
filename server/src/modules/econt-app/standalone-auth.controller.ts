import { Controller, Post, Get, Body, UseGuards, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from '../auth/auth.service';
import { LoginDto } from '../auth/dto/login.dto';
import { ChangePasswordDto } from '../auth/dto/change-password.dto';
import { ResetPasswordDto } from '../auth/dto/reset-password.dto';
import { HandoffDto } from '../auth/dto/handoff.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

// Accounts are provisioned by the super-admin (platform „Доставка"), not
// self-service — there is intentionally NO public signup route here.
@Controller('auth')
export class StandaloneAuthController {
  constructor(private readonly auth: AuthService) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  // SSO handoff from the farmer panel: exchange the short-TTL handoff token for a
  // real delivery session. Gated on the tenant's „пакет Доставки" inside the
  // service. Public — the signed token IS the proof, like the reset-password route.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('handoff')
  handoff(@Body() dto: HandoffDto) {
    return this.auth.handoffLogin(dto.token);
  }

  // Public — completes invite/forgot onboarding: the signed 7d token IS the auth,
  // so no JwtAuthGuard. Backs the delivery-web set-password page.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.newPassword);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: any) {
    return this.auth.getMe(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(req.user.userId, dto);
  }
}
