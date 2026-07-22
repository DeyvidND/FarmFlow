import {
  Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Patch, Post, Query, StreamableFile, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { TenantRequestUser } from '@fermeribg/types';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CourierAssignmentService } from '../routing/courier-assignment.service';
import { ConsolidatedProtocolService, type ConsolidatedProtocolView } from './consolidated-protocol.service';
import { ConsolidatedQueryDto } from './dto/consolidated-query.dto';
import { ConsolidatedEnsureDto } from './dto/consolidated-ensure.dto';
import { ConsolidatedUpdateDto } from './dto/consolidated-update.dto';
import { ConsolidatedSignDto } from './dto/consolidated-sign.dto';

/**
 * Consolidated (day/leg) handover-protocol endpoints. `scope='day'` is
 * admin-only via the global default-deny. `scope='leg'` additionally admits
 * `driver`, scoped to their OWN leg — checked HERE, per-request, from the
 * date-scoped assignment board (never the JWT's retired courierIndex), same
 * pattern as HandoverController.check(). `@Roles` only widens who can REACH a
 * route; the ownership check below is what actually enforces the boundary.
 */
@ApiTags('consolidated-protocols')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('consolidated-protocols')
export class ConsolidatedProtocolController {
  constructor(
    private readonly protocols: ConsolidatedProtocolService,
    private readonly courierAssignment: CourierAssignmentService,
  ) {}

  /** Throws 403 unless `user` may see this protocol: any admin, or the ONE
   *  driver assigned to its OWN leg on its OWN date. A `scope='day'` protocol
   *  is refused for every driver outright — the day view carries every other
   *  courier's orders too. */
  private async assertCanView(
    tenantId: string,
    user: TenantRequestUser,
    view: Pick<ConsolidatedProtocolView, 'scope' | 'legIndex' | 'date'>,
  ): Promise<void> {
    if (user.role === 'admin') return;
    if (view.scope !== 'leg') throw new ForbiddenException('Нямате достъп до дневния протокол.');
    const myLeg = await this.courierAssignment.resolveMyLeg(tenantId, user.userId, view.date);
    if (myLeg == null || myLeg !== view.legIndex) {
      throw new ForbiddenException('Нямате достъп до този протокол.');
    }
  }

  @Get()
  listForDay(@CurrentTenant() tenantId: string, @Query() q: ConsolidatedQueryDto) {
    return this.protocols.listForDay(tenantId, q.date);
  }

  @Post('ensure')
  @Roles('admin', 'driver')
  async ensure(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Body() dto: ConsolidatedEnsureDto,
  ) {
    if (user.role === 'driver') {
      if (dto.scope !== 'leg') throw new ForbiddenException('Нямате достъп до дневния протокол.');
      const myLeg = await this.courierAssignment.resolveMyLeg(tenantId, user.userId, dto.date);
      if (myLeg == null || myLeg !== dto.legIndex) throw new ForbiddenException('Можете да отваряте само своя лег.');
    }
    return this.protocols.ensureDraft(tenantId, dto.date, dto.scope, dto.legIndex);
  }

  @Get(':id')
  @Roles('admin', 'driver')
  async getOne(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const view = await this.protocols.getView(tenantId, id);
    await this.assertCanView(tenantId, user, view);
    return view;
  }

  @Get(':id/pdf')
  @Roles('admin', 'driver')
  async pdf(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const view = await this.protocols.getView(tenantId, id);
    await this.assertCanView(tenantId, user, view);
    const buf = await this.protocols.renderPdf(tenantId, view);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="consolidated-protocol.pdf"' });
  }

  /** Admin-only by the global default-deny — NO `@Roles`. A farmer-admin edits
   *  overrides/meta; a courier never does (spec §2's "редактируем от
   *  фермер-админ" names role `admin` specifically). */
  @Patch(':id')
  updateOverrides(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConsolidatedUpdateDto,
  ) {
    return this.protocols.updateDraft(tenantId, id, dto);
  }

  @Post(':id/sign')
  @Roles('admin', 'driver')
  async sign(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConsolidatedSignDto,
  ) {
    const view = await this.protocols.getView(tenantId, id);
    await this.assertCanView(tenantId, user, view);
    return this.protocols.sign(tenantId, id, dto.receiverSignaturePng, user.role as 'admin' | 'driver');
  }
}
