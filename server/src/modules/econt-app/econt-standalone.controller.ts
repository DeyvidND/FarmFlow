import {
  Controller, Get, Post, Delete, Body, Param, Query, UseGuards, ParseUUIDPipe, StreamableFile, Inject,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { eq } from 'drizzle-orm';
import { type Database, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EcontService } from '../econt/econt.service';
import { CodRiskService } from '../cod-risk/cod-risk.service';
import { BulkCheckPhonesDto } from '../cod-risk/dto/bulk-check-phones.dto';
import { isEcontAccountActive } from './econt-app.helpers';
import { EcontCredentialsDto } from '../econt/dto/econt-credentials.dto';
import { EcontProfileDto } from '../econt/dto/econt-profile.dto';
import { EcontSaveSendersDto } from '../econt/dto/econt-senders.dto';
import { ManualShipmentDto } from '../econt/dto/manual-shipment.dto';
import { ValidateAddressDto } from '../econt/dto/validate-address.dto';
import { CourierRequestDto } from '../econt/dto/courier-request.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentFarmer } from '../../common/decorators/current-farmer.decorator';
import { ActivationGuard } from './activation.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@UseGuards(JwtAuthGuard)
@Controller('shipping')
export class EcontStandaloneController {
  constructor(
    private readonly econt: EcontService,
    private readonly risk: CodRiskService,
    @Inject(DB_TOKEN) private readonly db: Database,
  ) {}

  // --- account / setup ---
  // Activation is super-admin-controlled; the panel reads it (read-only) to show
  // the account's Активен/Неактивен status on the settings screen.
  @Roles('admin', 'farmer')
  @Get('account')
  async account(@CurrentTenant() t: string) {
    const [row] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, t))
      .limit(1);
    return { active: isEcontAccountActive(row?.settings) };
  }

  @Roles('admin', 'farmer')
  @Post('credentials')
  saveCredentials(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Body() dto: EcontCredentialsDto,
  ) {
    return this.econt.saveCredentials(t, dto, f);
  }

  @Roles('admin', 'farmer')
  @Delete('credentials')
  disconnect(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined) {
    return this.econt.disconnect(t, f);
  }

  @Roles('admin', 'farmer')
  @Get('config')
  config(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined) {
    return this.econt.getConfig(t, f);
  }

  // Save the sender/package/COD profile (credentials stay on /credentials).
  @Roles('admin', 'farmer')
  @Post('profile')
  saveProfile(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Body() dto: EcontProfileDto,
  ) {
    return this.econt.saveProfile(t, dto, f);
  }

  @Roles('admin', 'farmer')
  @Post('senders')
  saveSenders(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Body() dto: EcontSaveSendersDto,
  ) {
    return this.econt.saveSenders(t, dto as never, f);
  }

  @Roles('admin', 'farmer')
  @Get('profiles')
  profiles(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined) {
    return this.econt.getClientProfiles(t, f);
  }

  @Roles('admin', 'farmer')
  @Post('nomenclature/sync')
  sync(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined) {
    return this.econt.syncNomenclature(t, f);
  }

  @Roles('admin', 'farmer')
  @Get('cities')
  cities(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Query('q') q?: string,
  ) {
    // searchCities(tenantId, q?, cache?, farmerId?)
    return this.econt.searchCities(t, q, undefined, f);
  }

  @Roles('admin', 'farmer')
  @Get('offices')
  offices(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Query('cityId') cityId?: string,
  ) {
    // getOfficesForCity(tenantId, cityId, cache?, farmerId?)
    return this.econt.getOfficesForCity(t, cityId ? Number(cityId) : 0, undefined, f);
  }

  @Roles('admin', 'farmer')
  @Post('validate-address')
  validateAddress(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Body() dto: ValidateAddressDto,
  ) {
    return this.econt.validateAddress(t, dto, f);
  }

  // --- shipments ---
  @Roles('admin', 'farmer')
  @Get('shipments')
  list(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined) {
    // Phase 3: Econt is the single source of the farmer's carrier-neutral courier queue —
    // listShipments returns the farmer's own courier orders + drafts when `f` is set,
    // and the tenant-wide admin list otherwise.
    return this.econt.listShipments(t, f);
  }

  @Roles('admin', 'farmer')
  @Get('cod-reconciliation')
  cod(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined) {
    // Phase 3: scoped on shipments.farmerId for a farmer (their own courier COD);
    // tenant-wide for the admin (no `f`).
    return this.econt.codReconciliation(t, f);
  }

  // Creating a real waybill is the paid action → activation-gated.
  @Roles('admin', 'farmer')
  @UseGuards(ActivationGuard)
  @Post('shipments')
  create(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Body() dto: ManualShipmentDto,
  ) {
    return this.econt.createManualShipment(t, dto, f);
  }

  @Roles('admin', 'farmer')
  @Post('shipments/:id/refresh')
  refresh(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.econt.refreshStatus(t, id, f);
  }

  @Roles('admin', 'farmer')
  @Delete('shipments/:id')
  void(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.econt.voidShipment(t, id, f);
  }

  // --- courier pickup (paid action) ---
  @Roles('admin', 'farmer')
  @UseGuards(ActivationGuard)
  @Post('courier')
  courier(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Body() dto: CourierRequestDto,
  ) {
    return this.econt.requestCourier(t, dto, f);
  }

  @Roles('admin', 'farmer')
  @Get('courier/:requestId')
  courierStatus(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Param('requestId') requestId: string,
  ) {
    return this.econt.getRequestCourierStatus(t, requestId, f);
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
    const buf = await this.econt.getLabelsPdf(t, list, f);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="labels.pdf"' });
  }

  @Roles('admin', 'farmer')
  @Get('shipments/:id/label.pdf')
  async label(
    @CurrentTenant() t: string,
    @CurrentFarmer() f: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const buf = await this.econt.getLabelPdf(t, id, f);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="label.pdf"' });
  }

  // --- COD risk ---
  // A phone lookup hits the cross-tenant registry (+ nekorekten quota) → gate behind
  // activation (paid feature) and throttle hard to curb phone enumeration.
  @UseGuards(ActivationGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('risk/check')
  riskCheck(@Query('phone') phone: string, @Query('refresh') refresh?: string) {
    return this.risk.check(phone, { forceRefresh: refresh === '1' || refresh === 'true' });
  }
  // Bulk phone check for the import flow — one call per unique unknown phone (adaptive TTL).
  @UseGuards(ActivationGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('risk/check-bulk')
  riskCheckBulk(@CurrentTenant() t: string, @Body() dto: BulkCheckPhonesDto) {
    return this.risk.checkBulk(t, dto.phones);
  }
  @Get('risk/candidates')
  riskCandidates(@CurrentTenant() t: string) {
    return this.risk.listCandidates(t);
  }
  // Reporting consumes our platform nekorekten account → activation-gated.
  @UseGuards(ActivationGuard)
  @Post('risk/reports/:shipmentId')
  riskConfirm(@CurrentTenant() t: string, @Param('shipmentId', ParseUUIDPipe) shipmentId: string) {
    return this.risk.confirmReport(t, shipmentId);
  }
}
