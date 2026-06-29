import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
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
import { CreateDemoDto } from './dto/create-demo.dto';
import { PlatformImportDto } from './dto/platform-import.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { PlatformChangePasswordDto } from './dto/platform-change-password.dto';
import { CreateDeliveryAccountDto } from './dto/create-delivery-account.dto';
import { SetDeliveryActiveDto } from './dto/set-delivery-active.dto';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '@fermeribg/types';

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

  /** Cross-tenant farmer (producer) directory — every farmer of every tenant. */
  @Get('farmers')
  listAllFarmers(@Query() q: PaginationQueryDto) {
    return this.platform.listAllFarmers({ cursor: q.cursor, limit: q.limit });
  }

  @Post('tenants')
  @HttpCode(201)
  createTenant(@Body() dto: CreateTenantDto) {
    return this.platform.createTenant(dto);
  }

  /** One-click disposable demo account (auto creds + seeded catalog, auto-expiry). */
  @Post('tenants/demo')
  @HttpCode(201)
  createDemo(@Body() dto: CreateDemoDto) {
    return this.platform.createDemoTenant(dto.days);
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

  /** Activate/deactivate a standalone Econt account after one-time payment. */
  @Patch('econt-accounts/:tenantId/activate')
  setEcontActive(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() body: { active: boolean },
  ) {
    return this.platform.setEcontAppActive(tenantId, body.active === true);
  }

  // ── Delivery accounts (standalone Econt/Speedy service oversight) ──
  @Get('delivery/accounts')
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listDeliveryAccounts(@Query() q: PaginationQueryDto) {
    return this.platform.listDeliveryAccounts({ cursor: q.cursor, limit: q.limit });
  }

  @Get('delivery/accounts/:tenantId')
  getDeliveryAccount(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.platform.getDeliveryAccount(tenantId);
  }

  /** Full paginated shipment history for one delivery account ("load more"). */
  @Get('delivery/accounts/:tenantId/shipments')
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listDeliveryShipments(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query() q: PaginationQueryDto,
  ) {
    return this.platform.listDeliveryShipments(tenantId, { cursor: q.cursor, limit: q.limit });
  }

  @Post('delivery/accounts')
  @HttpCode(201)
  createDeliveryAccount(@Body() dto: CreateDeliveryAccountDto) {
    return this.platform.createDeliveryAccount(dto);
  }

  /** Re-mint + re-email the set-password invite for a delivery account (expired or
   *  never-received link). Returns the fresh link for the operator to copy/share. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('delivery/accounts/:tenantId/invite')
  @HttpCode(200)
  resendDeliveryInvite(@Param('tenantId', ParseUUIDPipe) id: string) {
    return this.platform.resendDeliveryInvite(id);
  }

  @Patch('delivery/accounts/:tenantId/active')
  setDeliveryActive(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() dto: SetDeliveryActiveDto,
  ) {
    return this.platform.setEcontAppActive(tenantId, dto.active);
  }

  @Patch('delivery/accounts/:tenantId/enable-delivery')
  enableDelivery(@Param('tenantId', ParseUUIDPipe) tenantId: string) {
    return this.platform.enableDeliveryOnFarm(tenantId);
  }

  /** Hard-delete a tenant + all its data. Demos delete freely; a real farm requires
   *  `?confirm=<slug>` matching its slug exactly (service-guarded). */
  @Delete('tenants/:id')
  @HttpCode(200)
  @ApiQuery({ name: 'confirm', required: false })
  deleteTenant(@Param('id', ParseUUIDPipe) id: string, @Query('confirm') confirm?: string) {
    return this.platform.deleteTenant(id, confirm);
  }

  /** Reset a farm owner's password → returns a fresh temp password (forces change
   *  on next login, revokes the owner's live sessions). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Patch('tenants/:id/reset-password')
  @HttpCode(200)
  resetPassword(@Param('id', ParseUUIDPipe) id: string) {
    return this.platform.resetOwnerPassword(id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('change-password')
  @HttpCode(200)
  platformChangePassword(@CurrentUser() user: RequestUser, @Body() dto: PlatformChangePasswordDto) {
    const adminId = (user as { type: 'platform'; adminId: string }).adminId;
    return this.platform.platformChangePassword(adminId, dto);
  }
}
