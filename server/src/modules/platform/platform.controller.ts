import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { Throttle } from '@nestjs/throttler';
import { PlatformService } from './platform.service';
import { PlatformInsightsService } from './insights.service';
import { PlatformLoginDto } from './dto/platform-login.dto';
import { UpdateTenantStatusDto } from './dto/update-tenant-status.dto';
import { SetPremiumDto } from './dto/set-premium.dto';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { PlatformImportDto } from './dto/platform-import.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { ChangePasswordDto } from '../auth/dto/change-password.dto';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '@farmflow/types';

// Public — platform admin login (no guard).
@ApiTags('platform')
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly platform: PlatformService) {}

  // Brute-force guard on the most privileged login in the system.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
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
  constructor(
    private readonly platform: PlatformService,
    private readonly insights: PlatformInsightsService,
  ) {}

  /** Current super-admin identity — backs the panel's server-side auth gate. */
  @Get('me')
  me(@CurrentUser() user: RequestUser) {
    return this.platform.me((user as { type: 'platform'; adminId: string }).adminId);
  }

  /** Farm-health snapshot for the «Анализ» screen: who needs attention + why,
   *  feature adoption across all farms, and the farm list for the chart scope. */
  @Get('insights')
  getInsights() {
    return this.insights.insights();
  }

  /** Orders/revenue time series for the trend chart (Sofia-local buckets). */
  @Get('insights/timeseries')
  @ApiQuery({ name: 'range', required: false })
  @ApiQuery({ name: 'tenantId', required: false })
  getTimeseries(@Query('range') range = '30d', @Query('tenantId') tenantId?: string) {
    return this.insights.timeseries(range, tenantId);
  }

  @Get('tenants')
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  list(@Query() q: PaginationQueryDto) {
    return this.platform.listTenants({ cursor: q.cursor, limit: q.limit });
  }

  /** Per-farm email-push usage + amount owed (manual collection). */
  @Get('email-billing')
  emailBilling() {
    return this.platform.emailBilling();
  }

  /** Per-farm Stripe Connect status for the oversight table. */
  @Get('stripe/accounts')
  stripeAccounts() {
    return this.platform.stripeAccounts();
  }

  /** Full snapshot of one farm for the detail view. */
  @Get('tenants/:id')
  tenantDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.platform.tenantDetail(id);
  }

  @Post('tenants')
  @HttpCode(201)
  createTenant(@Body() dto: CreateTenantDto) {
    return this.platform.createTenant(dto);
  }

  /** Super-admin onboarding seed — bulk-create catalog (products/farmers/categories)
   *  + contact + favicon for a tenant. Bypasses the tenant's mustChangePassword lock. */
  @Post('tenants/:id/import')
  importTenant(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PlatformImportDto) {
    return this.platform.importTenant(id, dto);
  }

  /** Edit a farm's core profile + feature flags. */
  @Patch('tenants/:id')
  updateTenant(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTenantDto) {
    return this.platform.updateTenant(id, dto);
  }

  @Patch('tenants/:id/status')
  setStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTenantStatusDto) {
    return this.platform.setStatus(id, dto.status);
  }

  /** Toggle a farm's premium (free) billing plan. */
  @Patch('tenants/:id/premium')
  setPremium(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPremiumDto) {
    return this.platform.setPremium(id, dto.premium);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('change-password')
  @HttpCode(200)
  platformChangePassword(@CurrentUser() user: RequestUser, @Body() dto: ChangePasswordDto) {
    const adminId = (user as { type: 'platform'; adminId: string }).adminId;
    return this.platform.platformChangePassword(adminId, dto);
  }
}
