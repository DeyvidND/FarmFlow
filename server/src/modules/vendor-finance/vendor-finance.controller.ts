import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { effectiveFarmerId } from '../../common/scope/farmer-scope.util';
import type { TenantRequestUser } from '@fermeribg/types';
import { CommissionService } from './commission.service';
import { VendorSubscriptionService } from './vendor-subscription.service';
import { VendorFinanceSettingsService } from './vendor-finance-settings.service';
import {
  CommissionSummaryQueryDto,
  GenerateChargesDto,
  ListChargesQueryDto,
  UpdateChargeDto,
  UpdateVendorFinanceDto,
} from './dto/vendor-finance.dto';

/**
 * Read/bookkeeping API over the DORMANT vendor-finance ledgers. Nothing here
 * charges anyone; the endpoints only report what the (currently 0-rate)
 * commission ledger recorded and let the owner track manually-collected
 * subscription fees. Safe to expose while the feature sleeps.
 */
@ApiTags('vendor-finance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('vendor-finance')
export class VendorFinanceController {
  constructor(
    private readonly commission: CommissionService,
    private readonly subscriptions: VendorSubscriptionService,
    private readonly settings: VendorFinanceSettingsService,
  ) {}

  // ---- The switch that decides whether commission is applied at all ----
  //
  // Owner-only: these are the farm's commercial terms. A producer sub-account reads
  // the resulting rate through its own summary/stats endpoints, never this.

  @Get('settings')
  @Roles('admin')
  getSettings(@CurrentTenant() tenantId: string) {
    return this.settings.get(tenantId);
  }

  @Patch('settings')
  @Roles('admin')
  updateSettings(@CurrentTenant() tenantId: string, @Body() dto: UpdateVendorFinanceDto) {
    return this.settings.update(tenantId, dto);
  }

  // Owner sees every producer (optionally narrowed via ?farmerId); a producer
  // sub-account is forced to its own farmerId — same IDOR scope as /stats.
  @Get('commission/summary')
  @Roles('admin', 'farmer')
  @ApiQuery({ name: 'farmerId', required: false, description: 'Owner-only: scope to one producer' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  commissionSummary(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Query() q: CommissionSummaryQueryDto,
  ) {
    const scope = effectiveFarmerId(user.role, user.farmerId, q.farmerId);
    return this.commission.summary(tenantId, {
      farmerId: scope ?? undefined,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
  }

  @Get('subscriptions')
  @Roles('admin')
  @ApiQuery({ name: 'period', required: false, description: 'YYYY-MM' })
  listCharges(@CurrentTenant() tenantId: string, @Query() q: ListChargesQueryDto) {
    return this.subscriptions.list(tenantId, q.period);
  }

  // Explicit owner action (no cron): create the month's `due` rows. Refuses to
  // run while settings.vendorFinance.subscriptionEnabled is off (409).
  @Post('subscriptions/generate')
  @Roles('admin')
  generateCharges(@CurrentTenant() tenantId: string, @Body() dto: GenerateChargesDto) {
    return this.subscriptions.generateForPeriod(tenantId, dto.period);
  }

  @Patch('subscriptions/:id')
  @Roles('admin')
  updateCharge(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateChargeDto,
  ) {
    return this.subscriptions.setStatus(id, tenantId, dto.status, dto.note);
  }
}
