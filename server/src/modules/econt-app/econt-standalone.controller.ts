import {
  Controller, Get, Post, Delete, Body, Param, Query, UseGuards, ParseUUIDPipe, StreamableFile,
} from '@nestjs/common';
import { EcontService } from '../econt/econt.service';
import { CodRiskService } from '../cod-risk/cod-risk.service';
import { EcontCredentialsDto } from '../econt/dto/econt-credentials.dto';
import { ManualShipmentDto } from '../econt/dto/manual-shipment.dto';
import { ValidateAddressDto } from '../econt/dto/validate-address.dto';
import { CourierRequestDto } from '../econt/dto/courier-request.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { ActivationGuard } from './activation.guard';

@UseGuards(JwtAuthGuard)
@Controller('shipping')
export class EcontStandaloneController {
  constructor(
    private readonly econt: EcontService,
    private readonly risk: CodRiskService,
  ) {}

  // --- account / setup ---
  @Post('credentials')
  saveCredentials(@CurrentTenant() t: string, @Body() dto: EcontCredentialsDto) {
    return this.econt.saveCredentials(t, dto);
  }
  @Get('config')
  config(@CurrentTenant() t: string) {
    return this.econt.getConfig(t);
  }
  @Get('profiles')
  profiles(@CurrentTenant() t: string) {
    return this.econt.getClientProfiles(t);
  }
  @Post('nomenclature/sync')
  sync(@CurrentTenant() t: string) {
    return this.econt.syncNomenclature(t);
  }
  @Get('cities')
  cities(@CurrentTenant() t: string, @Query('q') q?: string) {
    return this.econt.searchCities(t, q);
  }
  @Get('offices')
  offices(@CurrentTenant() t: string, @Query('cityId') cityId?: string) {
    return this.econt.getOfficesForCity(t, cityId ? Number(cityId) : 0);
  }
  @Post('validate-address')
  validateAddress(@CurrentTenant() t: string, @Body() dto: ValidateAddressDto) {
    return this.econt.validateAddress(t, dto);
  }

  // --- shipments ---
  @Get('shipments')
  list(@CurrentTenant() t: string) {
    return this.econt.listShipments(t);
  }
  @Get('cod-reconciliation')
  cod(@CurrentTenant() t: string) {
    return this.econt.codReconciliation(t);
  }

  // Creating a real waybill is the paid action → activation-gated.
  @UseGuards(ActivationGuard)
  @Post('shipments')
  create(@CurrentTenant() t: string, @Body() dto: ManualShipmentDto) {
    return this.econt.createManualShipment(t, dto);
  }

  @Post('shipments/:id/refresh')
  refresh(@CurrentTenant() t: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.econt.refreshStatus(t, id);
  }
  @Delete('shipments/:id')
  void(@CurrentTenant() t: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.econt.voidShipment(t, id);
  }

  // --- courier pickup (paid action) ---
  @UseGuards(ActivationGuard)
  @Post('courier')
  courier(@CurrentTenant() t: string, @Body() dto: CourierRequestDto) {
    return this.econt.requestCourier(t, dto);
  }
  @Get('courier/:requestId')
  courierStatus(@CurrentTenant() t: string, @Param('requestId') requestId: string) {
    return this.econt.getRequestCourierStatus(t, requestId);
  }

  // --- print ---
  @Get('labels.pdf')
  async labels(@CurrentTenant() t: string, @Query('ids') ids: string): Promise<StreamableFile> {
    const list = (ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const buf = await this.econt.getLabelsPdf(t, list);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="labels.pdf"' });
  }
  @Get('shipments/:id/label.pdf')
  async label(@CurrentTenant() t: string, @Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const buf = await this.econt.getLabelPdf(t, id);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="label.pdf"' });
  }

  // --- COD risk ---
  @Get('risk/check')
  riskCheck(@Query('phone') phone: string) {
    return this.risk.check(phone);
  }
  @Get('risk/candidates')
  riskCandidates(@CurrentTenant() t: string) {
    return this.risk.listCandidates(t);
  }
  @Post('risk/reports/:shipmentId')
  riskConfirm(@CurrentTenant() t: string, @Param('shipmentId', ParseUUIDPipe) shipmentId: string) {
    return this.risk.confirmReport(t, shipmentId);
  }
}
