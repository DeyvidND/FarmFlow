import {
  Controller, Get, Post, Delete, Body, Param, Query, UseGuards, ParseUUIDPipe, StreamableFile,
} from '@nestjs/common';
import { SpeedyService } from '../speedy/speedy.service';
import { SpeedyCredentialsDto } from '../speedy/dto/speedy-credentials.dto';
import { SpeedyProfileDto } from '../speedy/dto/speedy-profile.dto';
import { SpeedySaveSendersDto } from '../speedy/dto/speedy-senders.dto';
import { SpeedyManualShipmentDto } from '../speedy/dto/speedy-manual-shipment.dto';
import { SpeedyValidateAddressDto } from '../speedy/dto/speedy-validate-address.dto';
import { SpeedyCourierRequestDto } from '../speedy/dto/speedy-courier-request.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentFarmer } from '../../common/decorators/current-farmer.decorator';
import { ActivationGuard } from '../econt-app/activation.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@UseGuards(JwtAuthGuard)
@Controller('speedy')
export class SpeedyStandaloneController {
  constructor(private readonly speedy: SpeedyService) {}

  // --- account / setup ---
  @Roles('admin', 'farmer')
  @Post('credentials')
  saveCredentials(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Body() dto: SpeedyCredentialsDto,
  ) {
    return this.speedy.saveCredentials(t, dto, f);
  }

  @Roles('admin', 'farmer')
  @Delete('credentials')
  disconnect(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined) {
    return this.speedy.disconnect(t, f);
  }

  @Roles('admin', 'farmer')
  @Get('config')
  config(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined) {
    return this.speedy.getConfig(t, f);
  }

  // Save the sender/package/COD profile (credentials stay on /credentials).
  @Roles('admin', 'farmer')
  @Post('profile')
  saveProfile(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Body() dto: SpeedyProfileDto,
  ) {
    return this.speedy.saveProfile(t, dto, f);
  }

  @Roles('admin', 'farmer')
  @Post('senders')
  saveSenders(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Body() dto: SpeedySaveSendersDto,
  ) {
    return this.speedy.saveSenders(t, dto as never, f);
  }

  @Roles('admin', 'farmer')
  @Get('profiles')
  profiles(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined) {
    return this.speedy.getClientProfiles(t, f);
  }

  // --- location pickers ---
  @Roles('admin', 'farmer')
  @Get('sites')
  sites(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Query('q') q?: string,
  ) {
    // searchSites(tenantId, q?, cache?, farmerId?)
    return this.speedy.searchSites(t, q, undefined, f);
  }

  @Roles('admin', 'farmer')
  @Get('offices')
  offices(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Query('siteId') siteId?: string,
  ) {
    // getOffices(tenantId, siteId, cache?, farmerId?)
    return this.speedy.getOffices(t, siteId ? Number(siteId) : 0, undefined, f);
  }

  @Roles('admin', 'farmer')
  @Get('streets')
  streets(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Query('siteId') siteId?: string,
    @Query('q') q?: string,
  ) {
    // getStreets(tenantId, siteId, q?, cache?, farmerId?)
    return this.speedy.getStreets(t, siteId ? Number(siteId) : 0, q, undefined, f);
  }

  @Roles('admin', 'farmer')
  @Post('validate-address')
  validateAddress(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Body() dto: SpeedyValidateAddressDto,
  ) {
    return this.speedy.validateAddress(t, dto, f);
  }

  // --- shipments ---
  @Roles('admin', 'farmer')
  @Get('shipments')
  list(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined) {
    // Phase 3 single-source decision: Speedy is the NON-authoritative carrier for a
    // farmer's carrier-neutral courier drafts → returns [] when `f` is set (Econt owns
    // the farmer's courier queue; avoids double-listing per carrier tab). Admin path
    // (no `f`) is unchanged — tenant-wide Speedy shipments.
    return this.speedy.listShipments(t, f);
  }

  @Roles('admin', 'farmer')
  @Get('cod-reconciliation')
  cod(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined) {
    // Phase 3: Speedy intentionally returns [] for a farmer (Econt reconciles the
    // carrier-neutral courier COD); tenant-wide admin reconciliation otherwise.
    return this.speedy.codReconciliation(t, f);
  }

  // Creating a real waybill is the paid action → activation-gated.
  @Roles('admin', 'farmer')
  @UseGuards(ActivationGuard)
  @Post('shipments')
  create(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Body() dto: SpeedyManualShipmentDto,
  ) {
    return this.speedy.createManualShipment(t, dto, f);
  }

  /** Create the Speedy waybill (label) for a storefront order. */
  @Roles('admin', 'farmer')
  @UseGuards(ActivationGuard)
  @Post('orders/:orderId/label')
  createForOrder(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.speedy.createLabelForOrder(t, orderId, f);
  }

  @Roles('admin', 'farmer')
  @Post('shipments/:id/refresh')
  refresh(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.speedy.refreshStatus(t, id, f);
  }

  @Roles('admin', 'farmer')
  @Delete('shipments/:id')
  void(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.speedy.voidShipment(t, id, f);
  }

  // --- courier pickup (paid action) ---
  @Roles('admin', 'farmer')
  @UseGuards(ActivationGuard)
  @Post('courier')
  courier(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Body() dto: SpeedyCourierRequestDto,
  ) {
    return this.speedy.requestCourier(t, dto, f);
  }

  // --- print ---
  @Roles('admin', 'farmer')
  @Get('labels.pdf')
  async labels(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Query('ids') ids: string,
  ): Promise<StreamableFile> {
    const list = (ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const buf = await this.speedy.getLabelsPdf(t, list, f);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="labels.pdf"' });
  }

  @Roles('admin', 'farmer')
  @Get('shipments/:id/label.pdf')
  async label(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const buf = await this.speedy.getLabelPdf(t, id, f);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="label.pdf"' });
  }
}
