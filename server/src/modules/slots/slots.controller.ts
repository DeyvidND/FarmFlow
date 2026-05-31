import {
  Controller, Get, Post, Patch, Delete,
  Param, Query, Body, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { SlotsService } from './slots.service';
import { CreateSlotDto } from './dto/create-slot.dto';
import { UpdateSlotDto } from './dto/update-slot.dto';
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
  findPublic(@Param('slug') slug: string, @Query('date') date?: string) {
    return this.slotsService.findPublicBySlug(slug, date);
  }
}
