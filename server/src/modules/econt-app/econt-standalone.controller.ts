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
import { ActivationGuard } from './activation.guard';

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
  @Get('account')
  async account(@CurrentTenant() t: string) {
    const [row] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, t))
      .limit(1);
    return { active: isEcontAccountActive(row?.settings) };
  }
  @Post('credentials')
  saveCredentials(@CurrentTenant() t: string, @Body() dto: EcontCredentialsDto) {
    return this.econt.saveCredentials(t, dto);
  }
  @Delete('credentials')
  disconnect(@CurrentTenant() t: string) {
    return this.econt.disconnect(t);
  }
  @Get('config')
  config(@CurrentTenant() t: string) {
    return this.econt.getConfig(t);
  }
  // Save the sender/package/COD profile (credentials stay on /credentials).
  @Post('profile')
  saveProfile(@CurrentTenant() t: string, @Body() dto: EcontProfileDto) {
    return this.econt.saveProfile(t, dto);
  }
  @Post('senders')
  saveSenders(@CurrentTenant() t: string, @Body() dto: EcontSaveSendersDto) {
    return this.econt.saveSenders(t, dto as never);
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
