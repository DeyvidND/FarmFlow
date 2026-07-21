import {
  Controller, Get, Post, Patch,
  Param, Body, Query, UseGuards,
  ParseUUIDPipe, StreamableFile, HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { HandoverService } from './handover.service';
import { DraftQueryDto } from './dto/draft-query.dto';
import { CreateProtocolDto } from './dto/create-protocol.dto';
import { BatchDto } from './dto/batch.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoutingService } from '../routing/routing.service';
import { CourierAssignmentService } from '../routing/courier-assignment.service';
import { bgToday } from '../../common/time/bg-time';
import type { TenantRequestUser } from '@fermeribg/types';

/**
 * Handover-protocol endpoints: draft/sign/list/print for farmer↔operator and
 * operator↔customer goods handovers. Admin-only via TenantRolesGuard's
 * default-deny (no `@Roles` decorator needed) — the brief's "operator" role
 * does not exist as a `TenantRole` (only 'admin' | 'driver' | 'customer' |
 * 'farmer' do); here "operator" names the tenant as a legal party in a
 * protocol's `kind` (see HandoverService), not an auth role. Matches how
 * every other plain admin-only route in this codebase (e.g. SubcategoriesController's
 * create/update/remove, EcontController's create/refresh/void) omits `@Roles` entirely.
 *
 * ONE exception: `GET /handover/check` also admits `driver`, scoped to that
 * courier's own route leg — see the comment on that handler for why.
 */
@ApiTags('handover')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('handover')
export class HandoverController {
  constructor(
    private readonly handover: HandoverService,
    private readonly routing: RoutingService,
    private readonly courierAssignment: CourierAssignmentService,
  ) {}

  @Get('draft')
  draft(@CurrentTenant() tenantId: string, @Query() q: DraftQueryDto) {
    return this.handover.buildDraft(tenantId, q);
  }

  @Post()
  create(@CurrentTenant() tenantId: string, @Body() dto: CreateProtocolDto) {
    return this.handover.createSigned(tenantId, dto);
  }

  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @Query('slotId') slotId?: string,
    @Query('date') date?: string,
    @Query('kind') kind?: string,
  ) {
    return this.handover.list(tenantId, { slotId, date, kind });
  }

  /** The day's LIVE protocol view — every handover-ready target for the slot/date
   *  merged with any persisted rows (virtual targets come back with id=null), so
   *  the screen is populated without «Печат за деня» first. */
  @Get('day')
  listForDay(
    @CurrentTenant() tenantId: string,
    @Query('slotId') slotId?: string,
    @Query('date') date?: string,
  ) {
    return this.handover.listForDay(tenantId, { slotId, date });
  }

  /**
   * The day's SIGNED protocols with decrypted signatures — feeds the fullscreen
   * „Проверка" offline check view (Task 12), not the PDF pipeline. `check` is a
   * static single-segment path; it cannot be swallowed by `:id/pdf` or
   * `:id/mark-signed`, which both require a second path segment.
   *
   * The ONE handover route open to `driver`, because the courier being stopped by
   * police is the entire reason this view exists — every other route here stays
   * admin-only by default-deny. A driver is scoped to their OWN leg: a protocol
   * names the counterparty and their address, so an unscoped list would hand each
   * courier the customer PII of deliveries they are not making. Leg ownership is
   * resolved per-request from the date-scoped assignment board — the same
   * `resolveMyLeg` path `OrdersController.prepForDriver` uses, never the JWT's
   * retired courierIndex. No assignment for the day ⇒ empty list, not everything.
   */
  @Get('check')
  @Roles('admin', 'driver')
  async check(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: TenantRequestUser,
    @Query('date') date?: string,
    @Query('slotId') slotId?: string,
  ) {
    if (user.role !== 'driver') return this.handover.listForCheck(tenantId, { date, slotId });

    const day = date ?? bgToday();
    const myLeg = await this.courierAssignment.resolveMyLeg(tenantId, user.userId, day);
    if (myLeg == null) return [];
    // 'all' — the protocols cover the leg's whole load, so the scope must not
    // shrink as the courier delivers. A stop already marked delivered is still
    // goods they are carrying paperwork for.
    const route = await this.routing.getRoute(tenantId, day, undefined, undefined, undefined, 'all');
    const mine = new Set(
      route.routes.filter((r) => r.courierIndex === myLeg).flatMap((r) => r.stops.map((s) => s.id)),
    );
    if (mine.size === 0) return [];
    return this.handover.listForCheck(tenantId, { date: day, slotId }, mine);
  }

  @Post('batch')
  createBatch(@CurrentTenant() tenantId: string, @Body() dto: BatchDto) {
    return this.handover.createBatch(tenantId, dto);
  }

  @Get('batch.pdf')
  async batchPdf(@CurrentTenant() tenantId: string, @Query() dto: BatchDto): Promise<StreamableFile> {
    const buf = await this.handover.renderBatchPdf(tenantId, dto);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="protocols.pdf"' });
  }

  /** On-the-fly PDF for a single not-yet-created target (virtual row) — renders
   *  without persisting, so no protocol number is burned just to preview/print. */
  @Get('preview.pdf')
  async previewPdf(@CurrentTenant() tenantId: string, @Query() q: DraftQueryDto): Promise<StreamableFile> {
    const buf = await this.handover.renderPreviewPdf(tenantId, q);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="protocol-preview.pdf"' });
  }

  @Get(':id/pdf')
  async pdf(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const buf = await this.handover.renderPdf(tenantId, id);
    return new StreamableFile(buf, { type: 'application/pdf', disposition: 'inline; filename="protocol.pdf"' });
  }

  @Patch(':id/mark-signed')
  @HttpCode(204)
  markSigned(@CurrentTenant() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.handover.markSigned(tenantId, id);
  }

  /** Paper-sign a single target (creating + numbering the protocol if it's still
   *  a virtual day-view row). */
  /** Materialize a single virtual target into a numbered draft (returns its id) —
   *  so opening its PDF prints a numbered protocol. */
  @Post('ensure')
  ensure(@CurrentTenant() tenantId: string, @Body() dto: DraftQueryDto) {
    return this.handover.ensureDraftTarget(tenantId, dto);
  }

  @Post('sign-paper')
  signPaper(@CurrentTenant() tenantId: string, @Body() dto: DraftQueryDto) {
    return this.handover.signPaperTarget(tenantId, dto);
  }

  /** Paper-sign every target for the day at once («Отбележи всички подписани»),
   *  optionally narrowed to one leg by `kind`. */
  @Post('sign-all')
  signAll(@CurrentTenant() tenantId: string, @Body() dto: BatchDto) {
    return this.handover.signAllForDay(tenantId, dto);
  }
}
