import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { StatsService } from './stats.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('stats')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get()
  @ApiQuery({ name: 'range', required: false, enum: ['7d', '30d', '90d', '1y'] })
  @ApiQuery({ name: 'from', required: false, description: 'Custom range start (BG date YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, description: 'Custom range end (BG date YYYY-MM-DD)' })
  stats(
    @CurrentTenant() tenantId: string,
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.statsService.stats(tenantId, { range, from, to });
  }
}
