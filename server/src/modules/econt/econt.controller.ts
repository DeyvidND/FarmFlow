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
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { EcontService } from './econt.service';
import { EcontCredentialsDto } from './dto/econt-credentials.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

/** Admin (tenant-scoped) Econt setup + shipment management. */
@ApiTags('econt')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('econt')
export class EcontController {
  constructor(private readonly econt: EcontService) {}

  /** Validate + store the farm's Econt API credentials (password encrypted). */
  @Post('credentials')
  saveCredentials(@CurrentTenant() tenantId: string, @Body() dto: EcontCredentialsDto) {
    return this.econt.saveCredentials(tenantId, dto);
  }

  /** Current Econt config (no secrets). */
  @Get('config')
  config(@CurrentTenant() tenantId: string) {
    return this.econt.getConfig(tenantId);
  }

  /** Pull the office nomenclature from Econt into the storefront cache. */
  @Post('nomenclature/sync')
  sync(@CurrentTenant() tenantId: string) {
    return this.econt.syncNomenclature(tenantId);
  }

  @Get('shipments')
  list(@CurrentTenant() tenantId: string) {
    return this.econt.listShipments(tenantId);
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
}

/** Public storefront office picker. */
@ApiTags('public')
@Controller('public/:slug/econt')
export class PublicEcontController {
  constructor(private readonly econt: EcontService) {}

  @Get('offices')
  offices(@Param('slug') slug: string, @Query('city') city?: string) {
    return this.econt.getPublicOffices(slug, city);
  }
}
