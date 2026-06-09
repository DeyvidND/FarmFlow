import { Controller, Post, Get, Patch, Body, UseGuards, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateNavDto } from './dto/update-nav.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUserId } from '../../common/decorators/current-user-id.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Brute-force guard: 10 login attempts / minute / IP.
  @ApiOperation({ summary: 'Login and receive JWT' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @ApiOperation({ summary: 'Change password; returns a fresh JWT' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('change-password')
  changePassword(@CurrentUserId() userId: string, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(userId, dto);
  }

  // Tight cap — each call may send an email; limits reset-spam / enumeration probing.
  @ApiOperation({ summary: 'Email a password-reset link (always 200, no enumeration)' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(200)
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.requestPasswordReset(dto.email);
  }

  // Limits brute-forcing the reset token.
  @ApiOperation({ summary: 'Set a new password using a reset token' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reset-password')
  @HttpCode(200)
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.newPassword);
  }

  @ApiOperation({ summary: 'Return the current authenticated user profile' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  @HttpCode(200)
  getMe(@CurrentUserId() userId: string) {
    return this.authService.getMe(userId);
  }

  @ApiOperation({ summary: 'Save the current user’s hidden side-nav keys' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch('me/nav')
  @HttpCode(200)
  updateNav(@CurrentUserId() userId: string, @Body() dto: UpdateNavDto) {
    return this.authService.updateHiddenNav(userId, dto.hidden);
  }
}
