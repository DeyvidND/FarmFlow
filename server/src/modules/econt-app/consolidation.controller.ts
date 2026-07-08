import { Controller, Get, Post, Body, Param, ParseUUIDPipe, ForbiddenException, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentFarmer } from '../../common/decorators/current-farmer.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ConsolidationService } from './consolidation.service';
import { ConsolidateDto, ConsolidationToggleDto } from './dto/consolidate.dto';

/**
 * Courier shipment consolidation — admin-only, tenant-wide. A farmer token only
 * sees its own shipments and must never merge across farmers, so every handler
 * rejects when a farmer id is present on the token.
 */
@UseGuards(JwtAuthGuard)
@Controller('shipping')
export class ConsolidationController {
  constructor(private readonly consolidation: ConsolidationService) {}

  private assertAdmin(farmerId: string | undefined): void {
    if (farmerId) throw new ForbiddenException('Обединяването е достъпно само за оператора.');
  }

  @Roles('admin')
  @Get('consolidation/suggestions')
  suggestions(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined) {
    this.assertAdmin(f);
    return this.consolidation.getSuggestions(t);
  }

  @Roles('admin')
  @Get('consolidation/settings')
  getSettings(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined) {
    this.assertAdmin(f);
    return this.consolidation.getToggle(t);
  }

  @Roles('admin')
  @Post('consolidation/settings')
  setSettings(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined, @Body() dto: ConsolidationToggleDto) {
    this.assertAdmin(f);
    return this.consolidation.setToggle(t, dto.enabled);
  }

  @Roles('admin')
  @Post('consolidation')
  consolidate(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined, @Body() dto: ConsolidateDto) {
    this.assertAdmin(f);
    return this.consolidation.consolidate(t, dto);
  }

  @Roles('admin')
  @Post('consolidation/:masterId/undo')
  undo(@CurrentTenant() t: string, @CurrentFarmer() f: string | undefined, @Param('masterId', ParseUUIDPipe) masterId: string) {
    this.assertAdmin(f);
    return this.consolidation.unconsolidate(t, masterId);
  }
}
