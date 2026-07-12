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
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { Throttle } from '@nestjs/throttler';
import { PlatformService } from './platform.service';
import { PlatformInsightsService } from './insights.service';
import { ProblemsService } from './problems.service';
import { HealthBoardService } from './health-board.service';
import { ProductExtractService } from '../ai-import/product-extract.service';
import { ProducerOnboardService } from './producer-onboard.service';
import { OperatorDigestService } from './operator-digest.service';
import { CriticalAlertService } from './critical-alert.service';
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
import { SetProductFeaturedDto, SetFarmerTierDto, SetFarmerOfWeekDto } from './dto/marketplace-curation.dto';
import { OnboardProducerDto } from './dto/onboard-producer.dto';
import { ResolveProblemDto } from './dto/resolve-problem.dto';
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
    private readonly problemsSvc: ProblemsService,
    private readonly healthBoardSvc: HealthBoardService,
    private readonly productExtract: ProductExtractService,
    private readonly producerOnboard: ProducerOnboardService,
    private readonly operatorDigest: OperatorDigestService,
    private readonly criticalAlert: CriticalAlertService,
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

  /** Unified, severity-ranked cross-farm problems feed for the «Проблеми» screen:
   *  recent server errors, attention signals (empty shop/dormant/Stripe/Econt),
   *  and delivery-ops issues (stuck товарителници, COD outstanding). */
  @Get('problems')
  getProblems() {
    return this.problemsSvc.problems();
  }

  /** Marks a server-error problem group (tenantId+path) as resolved — it drops out
   *  of the «Проблеми» feed (and stops re-alerting) until a NEW error for that
   *  exact group lands after this call. */
  @Post('problems/resolve')
  @HttpCode(200)
  resolveProblem(@Body() dto: ResolveProblemDto) {
    return this.problemsSvc.resolveProblem(dto.tenantId, dto.path);
  }

  /** Live platform technical pulse for the «Здраве» screen: DB/Redis reachability,
   *  BullMQ queue depths, and the 24h error-rate summary. */
  @Get('health-board')
  getHealthBoard() {
    return this.healthBoardSvc.healthBoard();
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

  /** One farmer's super-admin detail (producer drill-down). */
  @Get('farmers/:id')
  farmerDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.platform.farmerDetail(id);
  }

  /** Cross-tenant delivery operations snapshot (status + COD + stuck drafts). */
  @Get('delivery/ops')
  deliveryOps() {
    return this.platform.deliveryOps();
  }

  /** Cross-tenant audit log (mutations by default; pass mutationsOnly=false for all).
   *  Optional tenantId / farmerId scope the feed to one farm or one producer. */
  @Get('audit')
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiQuery({ name: 'farmerId', required: false })
  listAuditLogs(
    @Query() q: PaginationQueryDto,
    @Query('mutationsOnly') mutationsOnly?: string,
    @Query('tenantId', new ParseUUIDPipe({ optional: true })) tenantId?: string,
    @Query('farmerId', new ParseUUIDPipe({ optional: true })) farmerId?: string,
  ) {
    return this.platform.listAuditLogs({
      cursor: q.cursor,
      limit: q.limit,
      mutationsOnly: mutationsOnly !== 'false',
      tenantId,
      farmerId,
    });
  }

  /** SSO into a farmer's „Доставки" AS them, for super-admin support. Audit-logged. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('impersonate/:farmerId')
  @HttpCode(200)
  impersonate(@Param('farmerId', ParseUUIDPipe) farmerId: string, @CurrentUser() user: RequestUser) {
    return this.platform.impersonate(farmerId, (user as { type: 'platform'; adminId: string }).adminId);
  }

  /** SSO into the FULL farmer panel AS the farm's owner, for super-admin support. Audit-logged. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('impersonate-panel/:tenantId')
  @HttpCode(200)
  impersonatePanel(@Param('tenantId', ParseUUIDPipe) tenantId: string, @CurrentUser() user: RequestUser) {
    return this.platform.impersonatePanel(tenantId, (user as { type: 'platform'; adminId: string }).adminId);
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

  /** AI product extraction for onboarding: messy price list (text or .txt/.csv/.xlsx
   *  file) -> structured product rows. No DB write — the operator reviews, then POSTs
   *  the (edited) rows to the import endpoint below. Throttled (each call hits OpenAI). */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('tenants/:id/products/extract')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async extractProducts(
    @Param('id', ParseUUIDPipe) _id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('text') text: string | undefined,
  ): Promise<{ products: import('../ai-import/product-extract.service').ExtractedProduct[] }> {
    const content = await this.productExtract.parseToText(file, text);
    const products = await this.productExtract.extract(content);
    return { products };
  }

  /** One-shot producer onboarding: create + AI-import price list + invite link. */
  @Post('tenants/:id/producers/onboard')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  onboardProducer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OnboardProducerDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.producerOnboard.onboard(id, dto, file);
  }

  /** Manual trigger: build + send today's operator digest now (to SUPER_ADMIN_EMAIL).
   *  Returns the same outcome the daily cron would produce. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('digest/operator-test')
  runOperatorDigest() {
    return this.operatorDigest.runDaily();
  }

  /** Manual trigger: run the critical-problem alert check now (to CRITICAL_ALERT_EMAIL). */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('critical-alert-test')
  runCriticalAlertCheck() {
    return this.criticalAlert.checkAndAlert();
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

  /** Mark/unmark a product as „Хит" (reuses products.featured). */
  @Patch('products/:id/featured')
  setProductFeatured(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetProductFeaturedDto) {
    return this.platform.setProductFeatured(id, dto.featured);
  }

  /** Assign a farmer's marketplace tier (1..3). */
  @Patch('farmers/:id/tier')
  setFarmerTier(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetFarmerTierDto) {
    return this.platform.setFarmerTier(id, dto.tier);
  }

  /** Make (or clear) this farmer as their tenant's «Фермер на седмицата». */
  @Patch('farmers/:id/farmer-of-week')
  setFarmerOfWeek(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetFarmerOfWeekDto) {
    return this.platform.setFarmerOfWeek(id, dto.enabled);
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
