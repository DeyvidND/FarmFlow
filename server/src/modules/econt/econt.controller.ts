import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  ParseUUIDPipe,
  StreamableFile,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { EcontService } from './econt.service';
import { EcontCredentialsDto } from './dto/econt-credentials.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentFarmer } from '../../common/decorators/current-farmer.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PublicCacheService, publicCacheKeys } from '../../common/cache/public-cache.service';

/** Admin (tenant-scoped) Econt setup + shipment management. */
@ApiTags('econt')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('econt')
export class EcontController {
  constructor(
    private readonly econt: EcontService,
    private readonly publicCache: PublicCacheService,
  ) {}

  /** Validate + store the farm's Econt API credentials (password encrypted).
   *  Farmers can store their own creds in the per-farmer sub-namespace. */
  @Roles('admin', 'farmer')
  @Post('credentials')
  async saveCredentials(
    @CurrentTenant() tenantId: string,
    @CurrentFarmer() f: string | undefined,
    @Body() dto: EcontCredentialsDto,
  ) {
    const res = await this.econt.saveCredentials(tenantId, dto, f);
    if (f) await this.publicCache.del(publicCacheKeys.farmers(tenantId));
    return res;
  }

  /** Remove Econt credentials (disconnect). Farmer-scoped when farmerId present. */
  @Roles('admin', 'farmer')
  @Delete('credentials')
  async disconnect(
    @CurrentTenant() tenantId: string,
    @CurrentFarmer() f: string | undefined,
  ) {
    const res = await this.econt.disconnect(tenantId, f);
    if (f) await this.publicCache.del(publicCacheKeys.farmers(tenantId));
    return res;
  }

  /** Current Econt config (no secrets). Farmer-scoped when farmerId present. */
  @Roles('admin', 'farmer')
  @Get('config')
  config(
    @CurrentTenant() tenantId: string,
    @CurrentFarmer() f: string | undefined,
  ) {
    return this.econt.getConfig(tenantId, f);
  }

  /** Pull the office nomenclature from Econt into the storefront cache. */
  @Post('nomenclature/sync')
  sync(@CurrentTenant() tenantId: string) {
    return this.econt.syncNomenclature(tenantId);
  }

  /** City autocomplete for the sender / office-picker setup. */
  @Get('cities')
  cities(@CurrentTenant() tenantId: string, @Query('q') q?: string) {
    return this.econt.searchCities(tenantId, q);
  }

  /** Offices (with coordinates) for one city — sender picker + office map. */
  @Get('offices')
  offices(@CurrentTenant() tenantId: string, @Query('cityId') cityId?: string) {
    return this.econt.getOfficesForCity(tenantId, cityId ? Number(cityId) : 0);
  }

  @Get('shipments')
  list(@CurrentTenant() tenantId: string) {
    return this.econt.listShipments(tenantId);
  }

  @Get('cod-reconciliation')
  codReconciliation(@CurrentTenant() tenantId: string) {
    return this.econt.codReconciliation(tenantId);
  }

  /** Create the Econt waybill (label) for an order. */
  @Post('shipments/:orderId')
  create(@CurrentTenant() tenantId: string, @Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.econt.createLabel(tenantId, orderId);
  }

  @Post('shipments/:id/refresh')
  refresh(@CurrentTenant() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.econt.refreshStatus(tenantId, id);
  }

  @Delete('shipments/:id')
  void(@CurrentTenant() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.econt.voidShipment(tenantId, id);
  }

  /** Merged label PDF for several shipments (bulk print). */
  @Get('labels.pdf')
  async labels(
    @CurrentTenant() tenantId: string,
    @Query('ids') ids: string,
  ): Promise<StreamableFile> {
    const list = (ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const buf = await this.econt.getLabelsPdf(tenantId, list);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="labels.pdf"' });
  }

  /** Single shipment label PDF (print). */
  @Get('shipments/:id/label.pdf')
  async label(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const buf = await this.econt.getLabelPdf(tenantId, id);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="label.pdf"' });
  }
}

/** Public storefront office picker. */
@ApiTags('public')
@Controller('public/:slug/econt')
export class PublicEcontController {
  constructor(private readonly econt: EcontService) {}

  // Each call may hit the live Econt API — cap anonymous lookups. 30/min/IP.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('offices')
  offices(@Param('slug') slug: string, @Query('city') city?: string) {
    return this.econt.getPublicOffices(slug, city);
  }
}
