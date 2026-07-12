import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { CommissionService } from '../vendor-finance/commission.service';
import { VendorSubscriptionService } from '../vendor-finance/vendor-subscription.service';
import {
  CommissionSummaryQueryDto,
  GenerateChargesDto,
  ListChargesQueryDto,
  UpdateChargeDto,
} from '../vendor-finance/dto/vendor-finance.dto';
import { PlatformMarketplaceFinanceService } from './marketplace-finance.service';

/**
 * Super-admin view over the marketplace's (dormant) vendor-finance ledgers. Same
 * read/bookkeeping surface as the tenant-scoped vendor-finance controller, but
 * platform-authenticated and addressed by an explicit brand `tenantId` — so the
 * operator manages marketplace finance from the platform console instead of the
 * farmer panel. Charges nothing; only reports what the 0-rate ledger recorded.
 */
@ApiTags('platform')
@ApiBearerAuth()
@UseGuards(PlatformAdminGuard)
@Controller('platform/marketplace')
export class PlatformMarketplaceFinanceController {
  constructor(
    private readonly brands: PlatformMarketplaceFinanceService,
    private readonly commission: CommissionService,
    private readonly subscriptions: VendorSubscriptionService,
  ) {}

  /** All marketplace brands (multi-producer tenants) with commission totals. */
  @Get('brands')
  listBrands() {
    return this.brands.listBrands();
  }

  @Get('brands/:id/commission')
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  commissionSummary(@Param('id', ParseUUIDPipe) id: string, @Query() q: CommissionSummaryQueryDto) {
    return this.commission.summary(id, {
      farmerId: q.farmerId,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
  }

  @Get('brands/:id/subscriptions')
  @ApiQuery({ name: 'period', required: false, description: 'YYYY-MM' })
  listCharges(@Param('id', ParseUUIDPipe) id: string, @Query() q: ListChargesQueryDto) {
    return this.subscriptions.list(id, q.period);
  }

  /** Create the month's `due` rows for a brand (refuses while its subscription
   *  billing switch is off — same 409 as the tenant-scoped endpoint). */
  @Post('brands/:id/subscriptions/generate')
  generateCharges(@Param('id', ParseUUIDPipe) id: string, @Body() dto: GenerateChargesDto) {
    return this.subscriptions.generateForPeriod(id, dto.period);
  }

  @Patch('brands/:id/subscriptions/:chargeId')
  updateCharge(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('chargeId', ParseUUIDPipe) chargeId: string,
    @Body() dto: UpdateChargeDto,
  ) {
    return this.subscriptions.setStatus(chargeId, id, dto.status, dto.note);
  }
}
