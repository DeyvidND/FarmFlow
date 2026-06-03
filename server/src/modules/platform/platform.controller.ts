import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PlatformService } from './platform.service';
import { PlatformLoginDto } from './dto/platform-login.dto';
import { UpdateTenantStatusDto } from './dto/update-tenant-status.dto';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { ChangePasswordDto } from '../auth/dto/change-password.dto';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '@farmflow/types';

// Public — platform admin login (no guard).
@ApiTags('platform')
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly platform: PlatformService) {}

  @Post('login')
  login(@Body() dto: PlatformLoginDto) {
    return this.platform.login(dto.email, dto.password);
  }
}

// Everything else requires a platform token.
@ApiTags('platform')
@ApiBearerAuth()
@UseGuards(PlatformAdminGuard)
@Controller('platform')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('tenants')
  list() {
    return this.platform.listTenants();
  }

  @Post('tenants')
  @HttpCode(201)
  createTenant(@Body() dto: CreateTenantDto) {
    return this.platform.createTenant(dto);
  }

  @Patch('tenants/:id/status')
  setStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTenantStatusDto) {
    return this.platform.setStatus(id, dto.status);
  }

  @Post('change-password')
  @HttpCode(204)
  platformChangePassword(@CurrentUser() user: RequestUser, @Body() dto: ChangePasswordDto) {
    const adminId = (user as { type: 'platform'; adminId: string }).adminId;
    return this.platform.platformChangePassword(adminId, dto);
  }
}
