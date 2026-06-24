import {
  Controller, Get, Post, Delete, Body, Param, Query, UseGuards, ParseUUIDPipe, StreamableFile,
} from '@nestjs/common';
import { SpeedyService } from '../speedy/speedy.service';
import { SpeedyCredentialsDto } from '../speedy/dto/speedy-credentials.dto';
import { SpeedyManualShipmentDto } from '../speedy/dto/speedy-manual-shipment.dto';
import { SpeedyValidateAddressDto } from '../speedy/dto/speedy-validate-address.dto';
import { SpeedyCourierRequestDto } from '../speedy/dto/speedy-courier-request.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { ActivationGuard } from '../econt-app/activation.guard';

@UseGuards(JwtAuthGuard)
@Controller('speedy')
export class SpeedyStandaloneController {
  constructor(private readonly speedy: SpeedyService) {}

  // --- account / setup ---
  @Post('credentials')
  saveCredentials(@CurrentTenant() t: string, @Body() dto: SpeedyCredentialsDto) {
    return this.speedy.saveCredentials(t, dto);
  }
  @Get('config')
  config(@CurrentTenant() t: string) {
    return this.speedy.getConfig(t);
  }
  @Get('profiles')
  profiles(@CurrentTenant() t: string) {
    return this.speedy.getClientProfiles(t);
  }

  // --- location pickers ---
  @Get('sites')
  sites(@CurrentTenant() t: string, @Query('q') q?: string) {
    return this.speedy.searchSites(t, q);
  }
  @Get('offices')
  offices(@CurrentTenant() t: string, @Query('siteId') siteId?: string) {
    return this.speedy.getOffices(t, siteId ? Number(siteId) : 0);
  }
  @Get('streets')
  streets(@CurrentTenant() t: string, @Query('siteId') siteId?: string, @Query('q') q?: string) {
    return this.speedy.getStreets(t, siteId ? Number(siteId) : 0, q);
  }
  @Post('validate-address')
  validateAddress(@CurrentTenant() t: string, @Body() dto: SpeedyValidateAddressDto) {
    return this.speedy.validateAddress(t, dto);
  }

  // --- shipments ---
  @Get('shipments')
  list(@CurrentTenant() t: string) {
    return this.speedy.listShipments(t);
  }
  @Get('cod-reconciliation')
  cod(@CurrentTenant() t: string) {
    return this.speedy.codReconciliation(t);
  }

  // Creating a real waybill is the paid action → activation-gated.
  @UseGuards(ActivationGuard)
  @Post('shipments')
  create(@CurrentTenant() t: string, @Body() dto: SpeedyManualShipmentDto) {
    return this.speedy.createManualShipment(t, dto);
  }

  @Post('shipments/:id/refresh')
  refresh(@CurrentTenant() t: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.speedy.refreshStatus(t, id);
  }
  @Delete('shipments/:id')
  void(@CurrentTenant() t: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.speedy.voidShipment(t, id);
  }

  // --- courier pickup (paid action) ---
  @UseGuards(ActivationGuard)
  @Post('courier')
  courier(@CurrentTenant() t: string, @Body() dto: SpeedyCourierRequestDto) {
    return this.speedy.requestCourier(t, dto);
  }

  // --- print ---
  @Get('labels.pdf')
  async labels(@CurrentTenant() t: string, @Query('ids') ids: string): Promise<StreamableFile> {
    const list = (ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const buf = await this.speedy.getLabelsPdf(t, list);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="labels.pdf"' });
  }
  @Get('shipments/:id/label.pdf')
  async label(@CurrentTenant() t: string, @Param('id', ParseUUIDPipe) id: string): Promise<StreamableFile> {
    const buf = await this.speedy.getLabelPdf(t, id);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="label.pdf"' });
  }
}
