import {
  Controller, Get, Post, Put, Patch, Delete,
  Param, Query, Body, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { SlotsService } from './slots.service';
import { CreateSlotDto } from './dto/create-slot.dto';
import { UpdateSlotDto } from './dto/update-slot.dto';
import { SaveSlotRuleDto } from './dto/slot-rule.dto';
import { SlotDayActionDto } from './dto/slot-day-action.dto';
import { PublicSlotsQueryDto } from './dto/public-slots-query.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ActiveSubscriptionGuard } from '../../common/guards/active-subscription.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('slots')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('slots')
export class SlotsController {
  constructor(private readonly slotsService: SlotsService) {}

  @Get()
  @ApiQuery({ name: 'from', required: false, example: '2026-05-25' })
  @ApiQuery({ name: 'to', required: false, example: '2026-05-31' })
  findAll(
    @CurrentTenant() tenantId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.slotsService.findAll(tenantId, from, to);
  }

  @Post()
  @UseGuards(ActiveSubscriptionGuard)
  create(@CurrentTenant() tenantId: string, @Body() dto: CreateSlotDto) {
    return this.slotsService.create(tenantId, dto);
  }

  // Declared before the ':id' routes so 'rule' is never parsed as a slot id.
  @Get('rule')
  getRule(@CurrentTenant() tenantId: string) {
    return this.slotsService.getRule(tenantId);
  }

  @Put('rule')
  @UseGuards(ActiveSubscriptionGuard)
  saveRule(@CurrentTenant() tenantId: string, @Body() dto: SaveSlotRuleDto) {
    return this.slotsService.saveRule(tenantId, dto);
  }

  /** Close one day: delete its unbooked slots + skip it in the recurring rule. */
  @Post('close-day')
  @UseGuards(ActiveSubscriptionGuard)
  closeDay(@CurrentTenant() tenantId: string, @Body() dto: SlotDayActionDto) {
    return this.slotsService.closeDay(tenantId, dto.date);
  }

  /** Reopen a closed day: un-skip it and let the rule refill it immediately. */
  @Post('open-day')
  @UseGuards(ActiveSubscriptionGuard)
  openDay(@CurrentTenant() tenantId: string, @Body() dto: SlotDayActionDto) {
    return this.slotsService.openDay(tenantId, dto.date);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentTenant() tenantId: string,
    @Body() dto: UpdateSlotDto,
  ) {
    return this.slotsService.update(id, tenantId, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.slotsService.remove(id, tenantId);
  }
}

@ApiTags('public')
@Controller('public/:slug/slots')
export class PublicSlotsController {
  constructor(private readonly slotsService: SlotsService) {}

  @Get()
  @ApiQuery({ name: 'date', required: false, example: '2026-05-30' })
  @ApiQuery({ name: 'from', required: false, example: '2026-05-25' })
  @ApiQuery({ name: 'to', required: false, example: '2026-05-31' })
  findPublic(@Param('slug') slug: string, @Query() q: PublicSlotsQueryDto) {
    // `date` = legacy single-day; `from`/`to` = one ranged request for the whole
    // picker window (replaces the storefront's one-fetch-per-day fan-out). The DTO
    // enforces YYYY-MM-DD before these reach the deliverySlots.date column.
    return this.slotsService.findPublicBySlug(slug, { date: q.date, from: q.from, to: q.to });
  }
}
