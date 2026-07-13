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

/**
 * Handover-protocol endpoints: draft/sign/list/print for farmer↔operator and
 * operator↔customer goods handovers. Admin-only via TenantRolesGuard's
 * default-deny (no `@Roles` decorator needed) — the brief's "operator" role
 * does not exist as a `TenantRole` (only 'admin' | 'driver' | 'customer' |
 * 'farmer' do); here "operator" names the tenant as a legal party in a
 * protocol's `kind` (see HandoverService), not an auth role. Matches how
 * every other plain admin-only route in this codebase (e.g. SubcategoriesController's
 * create/update/remove, EcontController's create/refresh/void) omits `@Roles` entirely.
 */
@ApiTags('handover')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('handover')
export class HandoverController {
  constructor(private readonly handover: HandoverService) {}

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
